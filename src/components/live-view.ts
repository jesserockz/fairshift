import { View } from "./base";
import { store } from "../store";
import { esc, fmtClock } from "../format";
import { playerNameMap, countGoals } from "../stats";
import {
  advanceOneSecond,
  currentShift,
  nextShift,
  orderedCourt,
  roleMap,
  subPlan,
} from "../game";
import { beep, openPicker, toast } from "./ui";

export class LiveView extends View {
  private timer?: number;
  private sinceSave = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
  }

  private tick(): void {
    const g = store.live;
    if (!g || !g.running) return;
    const { shiftAdvanced, halfEnded } = advanceOneSecond(g);
    this.updateClock();
    if (shiftAdvanced || halfEnded) {
      beep();
      store.save();
      this.sinceSave = 0;
      this.render();
      if (halfEnded) toast("Half " + (g.currentHalf + 1) + " over");
    } else if (++this.sinceSave >= 5) {
      store.save();
      this.sinceSave = 0;
    }
  }

  private updateClock(): void {
    const g = store.live;
    if (!g) return;
    const sh = currentShift(g);
    const remain = Math.max(0, sh.endSec - g.elapsedSec);
    const imminent = remain <= 15;

    const half = this.querySelector("#halfClock");
    if (half) half.textContent = fmtClock(g.elapsedSec);
    const big = this.querySelector("#nextBig");
    if (big) big.textContent = fmtClock(remain);

    const span = Math.max(1, sh.endSec - sh.startSec);
    const frac = Math.min(1, Math.max(0, (g.elapsedSec - sh.startSec) / span));
    const bar = this.querySelector<HTMLElement>("#shiftBar");
    if (bar) {
      bar.style.width = (frac * 100).toFixed(1) + "%";
      bar.classList.toggle("imminent", imminent);
    }
    this.querySelector("#nextHero")?.classList.toggle("imminent", imminent);
  }

  render(): void {
    const g = store.live;
    if (!g) {
      this.innerHTML = `<div class="card empty">No game running. Build a rotation and tap <b>Start game</b>.</div>`;
      return;
    }
    const nm = playerNameMap(g.players);
    const sh = currentShift(g);
    const ns = nextShift(g);
    const next = ns && ns.half === g.currentHalf ? ns : null; // subs only within this half
    const us = countGoals(g.events, "us");
    const them = countGoals(g.events, "them");
    const halfSec = g.cfg.halfLength * 60;
    const remain = Math.max(0, sh.endSec - g.elapsedSec);

    const rows = next ? subPlan(sh, next, g.positions) : [];
    const incoming = next ? next.onIds.filter((id) => !sh.onIds.includes(id)) : [];

    const heroLabel = !next
      ? "HALF ENDS IN"
      : rows.length
        ? "NEXT SUB IN"
        : "NEXT SHIFT IN";

    const subsHtml = rows.length
      ? rows
          .map((r) => {
            const off = r.offId ? esc(nm[r.offId]) : "(bench)";
            const on = r.onId ? esc(nm[r.onId]) : "(bench)";
            const tag = r.tag ? `<span class="tag">${esc(r.tag)}</span>` : "";
            return `<div class="subrow${r.tag ? " role" : ""}">${tag}<span class="in">${on}</span><span class="arrow">➡️</span><span class="out">${off}</span></div>`;
          })
          .join("")
      : next
        ? `<div class="resting" style="text-align:center;padding:6px">No subs &ndash; same players stay on.</div>`
        : `<div class="resting" style="text-align:center;padding:6px">Half ends, then a fresh line-up next half.</div>`;

    const roles = roleMap(sh, g.positions);
    const tappable = g.positions.length > 0;
    const laterShifts = g.schedule.shifts.filter((s) => s.idx > sh.idx);
    const chips = orderedCourt(sh, g.schedule.shifts, g.positions)
      .map((id) => {
        const role = roles[id];
        const leaving = next && !next.onIds.includes(id);
        return `<div class="chip${role ? " gk" : ""}${leaving ? " leaving" : ""}${tappable ? " tappable" : ""}" data-id="${id}"><span>${esc(nm[id] || "?")}</span><span class="role">${role ? esc(role.name.toUpperCase()) : "COURT"}</span></div>`;
      })
      .join("");
    // Order the bench by who comes on soonest (the next shift they appear).
    const comesOnAt = (id: string): number => {
      for (const ls of laterShifts) if (ls.onIds.includes(id)) return ls.idx;
      return Infinity;
    };
    const orderedResting = [...sh.restingIds].sort(
      (a, b) => comesOnAt(a) - comesOnAt(b) || sh.restingIds.indexOf(a) - sh.restingIds.indexOf(b),
    );
    const restingHtml = orderedResting.length
      ? "<b>Resting:</b> " +
        orderedResting
          .map((id) =>
            incoming.includes(id)
              ? `<span style="color:var(--us);font-weight:700">${esc(nm[id])} &uarr;</span>`
              : esc(nm[id]),
          )
          .join(", ")
      : "<b>Everyone on court.</b>";

    const logRows = [...g.events]
      .reverse()
      .map((e) => {
        const label =
          e.team === "us"
            ? `<span class="pill us">US</span> Goal${e.scorerId ? " by <b>" + esc(nm[e.scorerId] || "?") + "</b>" : ""}`
            : `<span class="pill them">THEM</span> Goal${e.gkId ? ` (GK <b>${esc(nm[e.gkId] || "?")}</b>)` : ""}`;
        return `<div class="logitem"><span class="t">H${e.half + 1} ${fmtClock(e.clock)}</span><span style="flex:1">${label}</span></div>`;
      })
      .join("");

    this.innerHTML = `
    <div class="card sub-hero">
      <div class="row between" style="align-items:center">
        <div class="subclock">Half ${g.currentHalf + 1} of ${g.cfg.halves} · <span id="halfClock">${fmtClock(g.elapsedSec)}</span> / ${fmtClock(halfSec)}</div>
        <button class="${g.running ? "" : "accent"}" id="btnStartPause">${g.running ? "Pause" : "Start"}</button>
      </div>
      <div class="nexthero" id="nextHero">
        <div class="label">${heroLabel}</div>
        <div class="bigclock clock" id="nextBig">${fmtClock(remain)}</div>
      </div>
      <div class="progress"><div class="bar" id="shiftBar"></div></div>
      <div class="subs">${subsHtml}</div>
      <div class="row between" style="margin-top:12px">
        <button class="sm" id="btnPrevShift">Back</button>
        <button class="sm ghost" id="btnEndHalf">End half</button>
        <button class="sm accent" id="btnNextShift">Sub now</button>
      </div>
    </div>

    <div class="card">
      <div class="score">
        <div class="box us">
          <div class="role" style="color:var(--us);font-size:12px;font-weight:700">${esc((g.teamName || "US").toUpperCase())}</div>
          <div class="n">${us}</div>
          <button class="accent block sm" id="btnGoalUs" style="margin-top:6px">+ Our goal</button>
        </div>
        <div class="box them">
          <div class="role" style="color:var(--them);font-size:12px;font-weight:700">${esc((g.opponent || "THEM").toUpperCase())}</div>
          <div class="n">${them}</div>
          <button class="block sm danger" id="btnGoalThem" style="margin-top:6px">+ Their goal</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="row between"><h3>On court now</h3><span class="resting">Shift ${sh.idx + 1} · ${fmtClock(sh.startSec)}&ndash;${fmtClock(sh.endSec)}</span></div>
      <div class="onfield">${chips}</div>
      <div class="resting" style="margin-top:10px">${restingHtml}</div>
      ${tappable ? `<div class="hint">Tap a player to set their position (e.g. put the player coming on into goal).</div>` : ""}
    </div>

    <div class="card">
      <div class="row between"><h3>Game log</h3><button class="sm ghost" id="btnUndo">Undo last</button></div>
      <div class="log">${logRows}</div>
      ${g.events.length ? "" : `<div class="empty">No events yet.</div>`}
    </div>

    <div class="card">
      <button class="primary block" id="btnFinishGame">Finish &amp; save game</button>
      <button class="ghost block danger" id="btnDiscardGame" style="margin-top:8px">Discard game</button>
    </div>`;

    this.wire();
    this.updateClock();
  }

  private btn(id: string): HTMLButtonElement {
    return this.querySelector("#" + id) as HTMLButtonElement;
  }

  private wire(): void {
    this.querySelector(".onfield")?.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip[data-id]");
      if (chip) this.assignPosition(chip.dataset.id!);
    });
    this.btn("btnStartPause").onclick = () => store.setRunning(!store.live!.running);
    this.btn("btnPrevShift").onclick = () => store.shiftBy(-1);
    this.btn("btnNextShift").onclick = () => store.shiftBy(1);
    this.btn("btnEndHalf").onclick = () => this.endHalf();
    this.btn("btnGoalUs").onclick = () => this.goalUs();
    this.btn("btnGoalThem").onclick = () => {
      store.addGoal("them", null);
      toast("Goal against");
    };
    this.btn("btnUndo").onclick = () => {
      if (store.live!.events.length) store.undoLastEvent();
      else toast("Nothing to undo");
    };
    this.btn("btnFinishGame").onclick = () => {
      if (confirm("Finish and save this game?")) this.finish();
    };
    this.btn("btnDiscardGame").onclick = () => {
      if (confirm("Discard the current game? This cannot be undone.")) {
        store.discardGame();
        toast("Game discarded");
      }
    };
  }

  private async assignPosition(playerId: string): Promise<void> {
    const g = store.live!;
    if (!g.positions.length) return;
    const nm = playerNameMap(g.players);
    const current = roleMap(currentShift(g), g.positions)[playerId];
    const options = g.positions.map((p) => ({
      label: p.name + (p.isGoalkeeper ? " (goalie)" : ""),
      sub: p.id === current?.id ? "current" : undefined,
      value: p.id as string | null,
    }));
    options.push({ label: "No position", sub: current ? undefined : "current", value: null });
    const res = await openPicker(`Put ${nm[playerId]} at…`, options);
    if (res.cancelled) return;
    store.setLivePosition(playerId, res.value);
    const pos = res.value ? g.positions.find((p) => p.id === res.value) : null;
    toast(pos ? `${nm[playerId]} → ${pos.name}` : `${nm[playerId]} has no position`);
  }

  private async goalUs(): Promise<void> {
    const g = store.live!;
    const sh = currentShift(g);
    const nm = playerNameMap(g.players);
    const roles = roleMap(sh, g.positions);
    const onCourt = sh.onIds.map((id) => ({
      label: nm[id],
      sub: roles[id] ? roles[id].name + " on court" : "on court",
      value: id as string | null,
    }));
    const bench = g.players
      .filter((p) => !sh.onIds.includes(p.id))
      .map((p) => ({ label: p.name, sub: "bench", value: p.id as string | null }));
    const res = await openPicker("Who scored?", [
      ...onCourt,
      ...bench,
      { label: "Unknown / own goal", sub: "no scorer recorded", value: null },
    ]);
    if (res.cancelled) return;
    store.addGoal("us", res.value);
    toast("Goal for us!");
  }

  private endHalf(): void {
    const g = store.live!;
    if (g.currentHalf + 1 >= g.cfg.halves) {
      if (confirm("This is the last half. Finish and save the game?")) this.finish();
      return;
    }
    store.nextHalf();
    toast("Half " + (store.live!.currentHalf + 1) + " ready");
  }

  private finish(): void {
    const g = store.live!;
    const us = countGoals(g.events, "us");
    const them = countGoals(g.events, "them");
    store.finishGame();
    toast(`Game saved (${us}–${them})`);
    this.navigate("history");
  }
}

customElements.define("fs-live", LiveView);
