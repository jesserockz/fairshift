import { View } from "./base";
import { store } from "../store";
import { esc, fmtClock, fmtMin } from "../format";
import { playerNameMap } from "../stats";
import { orderedCourt, roleMap } from "../game";
import { shiftSeconds } from "../rotation";
import { toast } from "./ui";

export class ScheduleView extends View {
  render(): void {
    const plan = store.state.plan;
    if (!plan) {
      this.innerHTML = `<div class="card empty">No schedule yet. Set up your squad and tap <b>Build fair rotation</b>.</div>`;
      return;
    }

    const nm = playerNameMap(plan.players);
    const c = plan.cfg;
    const sch = plan.schedule;
    const positions = sch.positions;
    const posLabel = positions.length
      ? " incl. " + positions.map((p) => esc(p.name)).join(", ")
      : "";
    const meta =
      `${esc(plan.teamName)} - ${c.halves} × ${c.halfLength} min, ${sch.fieldSize} on court` +
      posLabel +
      (c.perPlayer ? `, timer per player` : "") +
      (c.maxSwaps && !c.perPlayer ? `, ${c.maxSwaps} sub${c.maxSwaps > 1 ? "s" : ""} at a time` : "") +
      (c.opponent ? ` vs ${esc(c.opponent)}` : "");

    const posHead = positions
      .map((p) => `<th class="num">${esc(p.name)}</th>`)
      .join("");
    const fair = [...sch.totals]
      .sort((a, b) => b.fieldSec - a.fieldSec)
      .map((t) => {
        const posCells = positions
          .map((p) => `<td class="num">${fmtMin(t.posSec[p.id] ?? 0)}</td>`)
          .join("");
        return `<tr><td>${esc(t.name)}</td><td class="num">${fmtMin(t.fieldSec)}</td>${posCells}<td class="num">${fmtMin(t.restSec)}</td></tr>`;
      })
      .join("");

    const first = sch.shifts[0];
    const firstRoles = roleMap(first, positions);
    const startingHtml = c.perPlayer
      ? `<div class="card">
      <h3>Starting line-up</h3>
      <div class="onfield">${orderedCourt(first, sch.shifts, positions)
        .map(
          (id) =>
            `<div class="chip${firstRoles[id] ? " gk" : ""}"><span>${esc(nm[id])}</span><span class="role">${firstRoles[id] ? esc(firstRoles[id].name.toUpperCase()) : "COURT"}</span></div>`,
        )
        .join("")}</div>
      <div class="resting" style="margin-top:10px"><b>Bench:</b> ${first.restingIds.map((id) => esc(nm[id])).join(", ") || "nobody"}</div>
      <div class="hint">Each player has their own ${fmtClock(shiftSeconds(c))} stint timer, staggered so subs come one at a time. When one runs out, the bench player with the least court time is suggested to take over. Times above are an even-split estimate.</div>
      <div class="row" style="margin-top:10px"><button class="sm" id="btnRegen">Reshuffle</button></div>
    </div>`
      : "";

    const shifts = sch.shifts
      .map((s) => {
        const roles = roleMap(s, positions);
        const on = orderedCourt(s, sch.shifts, positions)
          .map((id) =>
            roles[id]
              ? `<b style="color:var(--gk)">${esc(nm[id])} (${esc(roles[id].name)})</b>`
              : esc(nm[id]),
          )
          .join(", ");
        return `<tr><td>${s.half + 1}</td><td>${fmtClock(s.startSec)}&ndash;${fmtClock(s.endSec)}${s.carry ? ` <span class="resting">(resumes)</span>` : ""}</td><td>${on}</td><td class="resting">${s.restingIds.map((id) => esc(nm[id])).join(", ") || "-"}</td></tr>`;
      })
      .join("");

    this.innerHTML = `
    <div class="card">
      <div class="row between"><h2>Rotation plan</h2><button class="accent sm" id="btnStartGame">Start game</button></div>
      <div class="hint">${meta}</div>
    </div>
    <div class="card">
      <h3>Fair-share check</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Player</th><th class="num">Field</th>${posHead}<th class="num">Rest</th></tr></thead>
        <tbody>${fair}</tbody>
      </table></div>
      <div class="hint">Field = total minutes on court. Rest = minutes benched. Position columns are minutes spent in that role.</div>
    </div>
    ${startingHtml}
    ${c.perPlayer ? "" : `<div class="card">
      <h3>Shift by shift</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Half</th><th>Time</th><th>On court</th><th>Off</th></tr></thead>
        <tbody>${shifts}</tbody>
      </table></div>
      <div class="row" style="margin-top:10px">
        <button class="sm" id="btnRegen">Reshuffle</button>
        <button class="sm ghost" id="btnPrint">Print</button>
      </div>
    </div>`}`;

    this.querySelector<HTMLButtonElement>("#btnStartGame")!.onclick = () => {
      if (store.startGame()) {
        toast("Game started");
        this.navigate("live");
      }
    };
    this.querySelector<HTMLButtonElement>("#btnRegen")!.onclick = () => {
      store.generatePlan({ ...plan.cfg, seed: Math.floor(Math.random() * 0x7fffffff) });
      toast("Reshuffled");
    };
    const print = this.querySelector<HTMLButtonElement>("#btnPrint");
    if (print) print.onclick = () => window.print();
  }
}

customElements.define("fs-schedule", ScheduleView);
