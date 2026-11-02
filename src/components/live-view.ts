import { View } from "./base";
import { store } from "../store";
import { esc, fmtClock } from "../format";
import type { LiveGame } from "../types";
import { playerNameMap, countGoals } from "../stats";
import {
  advanceOneSecond,
  benchOrder,
  currentShift,
  dueRows,
  hasTenureRole,
  nextDueSec,
  roleHandover,
  stintLeft,
  suggestIncoming,
  nextShift,
  orderedCourt,
  pendingSubs,
  roleMap,
} from "../game";
import { shiftSeconds } from "../rotation";
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
    const { shiftAdvanced, subDue, halfEnded } = advanceOneSecond(g);
    this.updateClock();
    if (shiftAdvanced || subDue || halfEnded) {
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

  /** Timer-per-player clocks: the hero countdown and every player's own timer. */
  private updateStints(g: LiveGame): void {
    const left = nextDueSec(g);
    const big = this.querySelector("#nextBig");
    if (big) big.textContent = left === null ? "--:--" : left < 0 ? "+" + fmtClock(-left) : fmtClock(left);
    const hero = this.querySelector("#nextHero");
    hero?.classList.toggle("overdue", left !== null && left < 0);
    hero?.classList.toggle("imminent", left !== null && left >= 0 && left <= 15);
    const stint = Math.max(1, shiftSeconds(g.cfg));
    const bar = this.querySelector<HTMLElement>("#shiftBar");
    if (bar) {
      const frac = left === null ? 0 : Math.min(1, Math.max(0, 1 - left / stint));
      bar.style.width = (frac * 100).toFixed(1) + "%";
      bar.classList.toggle("imminent", left !== null && left <= 15);
    }
    this.querySelectorAll<HTMLElement>("[data-stint]").forEach((el) => {
      const l = stintLeft(g, el.dataset.stint as string);
      el.textContent = l < 0 ? "+" + fmtClock(-l) : fmtClock(l);
      el.parentElement?.classList.toggle("due", l <= 0);
    });
    this.querySelectorAll<HTMLElement>("[data-rest]").forEach((el) => {
      el.textContent = fmtClock(g.timers?.[el.dataset.rest as string] ?? 0);
    });
  }

  private updateClock(): void {
    const g = store.live;
    if (!g) return;
    const half = this.querySelector("#halfClock");
    if (half) half.textContent = fmtClock(g.elapsedSec);
    if (g.cfg.perPlayer) {
      this.updateStints(g);
      return;
    }
    const sh = currentShift(g);
    const remain = Math.max(0, sh.endSec - g.elapsedSec);
    const overdueSec = Math.max(0, g.elapsedSec - sh.endSec);
    const imminent = remain <= 15;

    const big = this.querySelector("#nextBig");
    if (big) big.textContent = overdueSec ? "+" + fmtClock(overdueSec) : fmtClock(remain);
    this.querySelector("#nextHero")?.classList.toggle("overdue", overdueSec > 0);

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
    if (g.cfg.perPlayer) {
      this.renderStints(g);
      return;
    }
    const nm = playerNameMap(g.players);
    const sh = currentShift(g);
    const ns = nextShift(g);
    const next = ns && ns.half === g.currentHalf ? ns : null; // subs only within this half
    const halfSec = g.cfg.halfLength * 60;
    const remain = Math.max(0, sh.endSec - g.elapsedSec);

    const rows = pendingSubs(g);
    const overdue = rows.length > 0 && g.elapsedSec >= sh.endSec;
    const incoming = next ? next.onIds.filter((id) => !sh.onIds.includes(id)) : [];

    const heroLabel = !next
      ? "HALF ENDS IN"
      : overdue
        ? "SUBS DUE - OVERDUE BY"
        : rows.length
          ? "NEXT SUB IN"
          : "NEXT SHIFT IN";

    const subsHtml = rows.length
      ? rows
          .map((r) => {
            const off = r.offId ? esc(nm[r.offId]) : "(bench)";
            const on = r.onId ? esc(nm[r.onId]) : "(bench)";
            const tag = r.tag ? `<span class="tag">${esc(r.tag)}</span>` : "";
            return `<div class="subrow tappable${r.tag ? " role" : ""}" data-off="${esc(r.offId ?? "")}" data-on="${esc(r.onId ?? "")}">${tag}<span class="in">${on}</span><span class="arrow">➡️</span><span class="out">${off}</span><span class="done">Done</span></div>`;
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
      ${rows.length ? `<div class="hint" style="text-align:center">Players stay on until you tap a sub once it is made - the rest of the game re-balances.</div>` : ""}
      <div class="row between" style="margin-top:12px">
        <button class="sm" id="btnUndoSub"${g.undoSub ? "" : " disabled"}>Undo sub</button>
        <button class="sm ghost" id="btnEndHalf">End half</button>
        <button class="sm accent" id="btnNextShift"${rows.length ? "" : " disabled"}>Sub all now</button>
      </div>
    </div>

    ${this.scoreCard(g)}

    <div class="card">
      <div class="row between"><h3>On court now</h3><span class="resting">Shift ${sh.idx + 1}${sh.carry ? " (resumed)" : ""} · ${fmtClock(sh.startSec)}&ndash;${fmtClock(sh.endSec)}</span></div>
      <div class="onfield">${chips}</div>
      <div class="resting" style="margin-top:10px">${restingHtml}</div>
      ${tappable ? `<div class="hint">Tap a player to set their position (e.g. put the player coming on into goal).</div>` : ""}
    </div>

    ${this.logCard(g, nm)}

    ${this.finishCard()}`;

    this.wire();
    this.updateClock();
  }

  private scoreCard(g: LiveGame): string {
    const us = countGoals(g.events, "us");
    const them = countGoals(g.events, "them");
    return `<div class="card">
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
    </div>`;
  }

  private logCard(g: LiveGame, nm: Record<string, string>): string {
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
    return `<div class="card">
      <div class="row between"><h3>Game log</h3><button class="sm ghost" id="btnUndo">Undo last</button></div>
      <div class="log">${logRows}</div>
      ${g.events.length ? "" : `<div class="empty">No events yet.</div>`}
    </div>`;
  }

  private finishCard(): string {
    return `<div class="card">
      <button class="primary block" id="btnFinishGame">Finish &amp; save game</button>
      <button class="ghost block danger" id="btnDiscardGame" style="margin-top:8px">Discard game</button>
    </div>`;
  }

  /** Live screen for a game with a timer per player (no shared shift clock). */
  private renderStints(g: LiveGame): void {
    const nm = playerNameMap(g.players);
    const sh = currentShift(g);
    const roles = roleMap(sh, g.positions);
    const rows = dueRows(g);
    const left = nextDueSec(g);
    const heroLabel =
      left === null ? "NO SUBS NEEDED" : left <= 0 ? "SUB DUE - OVERDUE BY" : "NEXT SUB IN";

    const subsHtml = rows.length
      ? rows
          .map((r) => {
            const tag = r.tag ? `<span class="tag">${esc(r.tag)}</span>` : "";
            return `<div class="subrow tappable${r.tag ? " role" : ""}" data-off="${esc(r.offId as string)}" data-on="${esc(r.onId as string)}">${tag}<span class="in">${esc(nm[r.onId as string])}</span><span class="arrow">➡️</span><span class="out">${esc(nm[r.offId as string])}</span><span class="done">Done</span></div>`;
          })
          .join("")
      : `<div class="resting" style="text-align:center;padding:6px">${left === null ? "Everyone stays on." : "Nobody is due yet."}</div>`;

    const court = [...sh.onIds].sort(
      (a, b) =>
        (hasTenureRole(g, a) ? 1 : 0) - (hasTenureRole(g, b) ? 1 : 0) ||
        stintLeft(g, a) - stintLeft(g, b),
    );
    const chips = court
      .map((id) => {
        const role = roles[id];
        const timer = hasTenureRole(g, id)
          ? `<span class="stint">holds</span>`
          : `<span class="stint" data-stint="${id}"></span>`;
        return `<div class="chip tappable${role ? " gk" : ""}" data-id="${id}"><span>${esc(nm[id] || "?")}</span><span class="role">${role ? esc(role.name.toUpperCase()) : "COURT"}</span>${timer}</div>`;
      })
      .join("");
    const bench = benchOrder(g)
      .map((id) => {
        const played = fmtClock(g.played?.[id]?.fieldSec ?? 0);
        return `<div class="chip bench tappable" data-bench="${id}"><span>${esc(nm[id] || "?")}</span><span class="role">played ${played}</span><span class="stint" data-rest="${id}"></span></div>`;
      })
      .join("");

    this.innerHTML = `
    <div class="card sub-hero">
      <div class="row between" style="align-items:center">
        <div class="subclock">Half ${g.currentHalf + 1} of ${g.cfg.halves} · <span id="halfClock">${fmtClock(g.elapsedSec)}</span> / ${fmtClock(g.cfg.halfLength * 60)}</div>
        <button class="${g.running ? "" : "accent"}" id="btnStartPause">${g.running ? "Pause" : "Start"}</button>
      </div>
      <div class="nexthero" id="nextHero">
        <div class="label">${heroLabel}</div>
        <div class="bigclock clock" id="nextBig"></div>
      </div>
      <div class="progress"><div class="bar" id="shiftBar"></div></div>
      <div class="subs">${subsHtml}</div>
      ${rows.length ? `<div class="hint" style="text-align:center">Tap a row once that sub is made. Tap a player to choose someone else.</div>` : ""}
      <div class="row between" style="margin-top:12px">
        <button class="sm" id="btnUndoSub"${g.undoSub ? "" : " disabled"}>Undo sub</button>
        <button class="sm ghost" id="btnEndHalf">End half</button>
      </div>
    </div>

    ${this.scoreCard(g)}

    <div class="card">
      <div class="row between"><h3>On court now</h3><span class="resting">${fmtClock(shiftSeconds(g.cfg))} stints</span></div>
      <div class="onfield">${chips}</div>
      <div class="hint">Time left on each stint. Tap a player to sub them off or change their position.</div>
    </div>

    <div class="card">
      <h3>Bench</h3>
      ${bench ? `<div class="onfield">${bench}</div><div class="hint">In the order they should come on. Time shown is how long they have rested. Tap one to put them on now.</div>` : `<div class="resting">Everyone is on court.</div>`}
    </div>

    ${this.logCard(g, nm)}

    ${this.finishCard()}`;

    this.wire();
    this.updateClock();
  }

  /** Make a swap, asking who takes the outgoing player's position if the incoming one cannot. */
  private async makeSwap(outId: string, inId: string): Promise<void> {
    const g = store.live!;
    const nm = playerNameMap(g.players);
    let roleTo: string | null | undefined;
    const handover = roleHandover(g, outId, inId);
    if (handover && handover.candidates.length) {
      const pos = g.positions.find((p) => p.id === handover.posId)!;
      const res = await openPicker(`${nm[inId]} cannot play ${pos.name}. Who takes it?`, [
        ...handover.candidates.map((id) => ({ label: nm[id], sub: "on court", value: id as string | null })),
        { label: "Nobody", sub: "leave it empty", value: null },
      ]);
      if (res.cancelled) return;
      roleTo = res.value;
    }
    store.swapPlayers(outId, inId, roleTo);
    toast(`${nm[inId]} on for ${nm[outId]}`);
  }

  /** Tap an on-court player in timer mode: sub them off, or change their position. */
  private async courtMenu(outId: string): Promise<void> {
    const g = store.live!;
    const nm = playerNameMap(g.players);
    const suggested = suggestIncoming(g, outId);
    const bench = benchOrder(g);
    const options = [...bench]
      .sort((a, b) => Number(b === suggested) - Number(a === suggested))
      .map((id) => ({
        label: nm[id],
        sub:
          `rested ${fmtClock(g.timers?.[id] ?? 0)} · played ${fmtClock(g.played?.[id]?.fieldSec ?? 0)}` +
          (id === suggested ? " · suggested" : ""),
        value: id as string | null,
      }));
    if (g.positions.length) options.push({ label: "Change position…", sub: "keep them on court", value: null });
    const res = await openPicker(`Take ${nm[outId]} off for…`, options);
    if (res.cancelled) return;
    if (res.value === null) await this.assignPosition(outId);
    else await this.makeSwap(outId, res.value);
  }

  /** Tap a bench player in timer mode: put them on for someone now. */
  private async benchMenu(inId: string): Promise<void> {
    const g = store.live!;
    const nm = playerNameMap(g.players);
    const res = await openPicker(
      `Put ${nm[inId]} on for…`,
      [...currentShift(g).onIds]
        .sort((a, b) => stintLeft(g, a) - stintLeft(g, b))
        .map((id) => ({
          label: nm[id],
          sub: `on ${fmtClock(g.timers?.[id] ?? 0)}`,
          value: id as string,
        })),
    );
    if (!res.cancelled) await this.makeSwap(res.value, inId);
  }

  private btn(id: string): HTMLButtonElement {
    return this.querySelector("#" + id) as HTMLButtonElement;
  }

  private wire(): void {
    const perPlayer = !!store.live!.cfg.perPlayer;
    this.querySelectorAll(".onfield").forEach((field) =>
      field.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const bench = target.closest<HTMLElement>(".chip[data-bench]");
        if (bench) return void this.benchMenu(bench.dataset.bench!);
        const chip = target.closest<HTMLElement>(".chip[data-id]");
        if (!chip) return;
        if (perPlayer) void this.courtMenu(chip.dataset.id!);
        else void this.assignPosition(chip.dataset.id!);
      }),
    );
    this.btn("btnStartPause").onclick = () => store.setRunning(!store.live!.running);
    this.querySelector(".subs")?.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".subrow[data-on]");
      if (!row) return;
      if (perPlayer) void this.makeSwap(row.dataset.off!, row.dataset.on!);
      else store.confirmSub(row.dataset.off || null, row.dataset.on || null);
    });
    this.btn("btnUndoSub").onclick = () => {
      if (store.undoSub()) toast("Sub undone");
    };
    const subAll = this.querySelector<HTMLButtonElement>("#btnNextShift");
    if (subAll) subAll.onclick = () => store.confirmAllSubs();
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
