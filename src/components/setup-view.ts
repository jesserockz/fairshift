import { View } from "./base";
import { store } from "../store";
import { clampNum, esc, fmtClock, fmtMin } from "../format";
import { toast } from "./ui";
import { suggestShift } from "../suggest";
import type { GameConfig, Position, PositionCadence } from "../types";

const CADENCE_LABELS: Record<PositionCadence, string> = {
  shift: "Per shift",
  half: "Per half",
  game: "Whole game",
};

export class SetupView extends View {
  private cfg: GameConfig = store.state.plan?.cfg ?? {
    fieldSize: 4,
    halves: 2,
    halfLength: 10,
    shiftLength: 2.5,
    opponent: "",
    seed: 0,
    maxSwaps: 0,
  };

  render(): void {
    const team = store.currentTeam();
    const players = team?.players ?? [];
    const positions = team?.positions ?? [];

    const teamOptions = store.state.teams
      .map(
        (t) =>
          `<option value="${t.id}"${t.id === store.state.currentTeamId ? " selected" : ""}>${esc(t.name || "(unnamed)")}</option>`,
      )
      .join("");

    const posRows = positions
      .map(
        (pos) => `
      <div class="prow" data-pos="${pos.id}">
        <span class="pname">${esc(pos.name)}</span>
        <select class="posCadence" data-pos="${pos.id}" style="width:auto">
          ${(Object.keys(CADENCE_LABELS) as PositionCadence[])
            .map(
              (c) =>
                `<option value="${c}"${pos.cadence === c ? " selected" : ""}>${CADENCE_LABELS[c]}</option>`,
            )
            .join("")}
        </select>
        <span class="toggle ${pos.isGoalkeeper ? "on" : ""}" data-act="gk" title="Goals against are credited to this role">Goalie</span>
        <button class="sm ghost" data-act="rename">&#9998;</button>
        <button class="sm danger" data-act="del">&times;</button>
      </div>`,
      )
      .join("");

    const posChips = (eligible: string[]): string =>
      positions.length
        ? positions
            .map(
              (pos) =>
                `<span class="toggle ${eligible.includes(pos.id) ? "on" : ""}" data-act="pos" data-pos="${pos.id}">${esc(pos.name)}</span>`,
            )
            .join("")
        : `<span class="resting" style="font-size:12px">plays anywhere</span>`;

    const rows = players
      .map(
        (p) => `
      <div class="prow${p.present ? "" : " absent"}" data-id="${p.id}">
        <span class="pname">${esc(p.name)}</span>
        <span class="toggle present ${p.present ? "on" : ""}" data-act="present">${p.present ? "Here" : "Away"}</span>
        ${posChips(p.positionIds)}
        <button class="sm ghost" data-act="rename">&#9998;</button>
        <button class="sm danger" data-act="del">&times;</button>
      </div>`,
      )
      .join("");

    this.innerHTML = `
    <div class="card">
      <div class="row between">
        <h2>Team</h2>
        <div class="row">
          <select id="teamSelect" style="width:auto">${teamOptions}</select>
          <button class="sm" id="btnNewTeam">New</button>
          <button class="sm danger" id="btnDelTeam">Delete</button>
        </div>
      </div>
      <label class="field" style="margin-top:8px">
        <span>Team name</span>
        <input type="text" id="teamName" placeholder="e.g. Floorball Foxes" value="${esc(team?.name ?? "")}" />
      </label>
    </div>

    <div class="card">
      <div class="row between"><h2>Positions</h2><small>${positions.length} defined</small></div>
      <div class="hint" style="margin-bottom:8px">Optional. A position pins its holder on court for its cadence. Leave empty for plain subs. Mark one <b>Goalie</b> to track goals conceded.</div>
      <div class="plist" id="posList">${posRows}</div>
      <div class="row" style="margin-top:10px">
        <input type="text" id="newPos" placeholder="Add position (e.g. GK)" style="flex:1" />
        <button class="primary" id="btnAddPos">Add</button>
      </div>
    </div>

    <div class="card">
      <div class="row between"><h2>Players</h2><small id="rosterCount"></small></div>
      <div class="row" style="margin-bottom:10px">
        <input type="text" id="newPlayer" placeholder="Add player name" style="flex:1" />
        <button class="primary" id="btnAddPlayer">Add</button>
      </div>
      <div class="hint" style="margin-bottom:8px">Toggle <b>Here</b> for who is present today, and tap a position to mark a player eligible for it.</div>
      <div class="plist" id="playerList">${rows}</div>
      ${players.length ? "" : `<div class="empty">No players yet. Add your squad above.</div>`}
    </div>

    <div class="card">
      <h2>Game settings</h2>
      <div class="grid2">
        <label class="field"><span>On court (incl. positions)</span><input type="number" id="cfgField" min="1" max="15" value="${this.cfg.fieldSize}" /></label>
        <label class="field"><span>Number of halves</span><input type="number" id="cfgHalves" min="1" max="4" value="${this.cfg.halves}" /></label>
        <label class="field"><span>Half length (min)</span><input type="number" id="cfgHalfLen" min="1" max="60" value="${this.cfg.halfLength}" /></label>
        <label class="field"><span>Sub every (min)</span><input type="number" id="cfgShift" min="0.5" max="30" step="0.5" value="${this.cfg.shiftLength}" /></label>
        <label class="field"><span>Subs at once (0 = auto)</span><input type="number" id="cfgSwaps" min="0" max="15" step="1" value="${this.cfg.maxSwaps ?? 0}" /></label>
      </div>
      <div class="row" style="margin:-2px 0 10px">
        <button class="sm" id="btnSuggest">Suggest fairest sub timer</button>
        <div class="hint" id="suggestHint" style="margin:0;flex:1"></div>
      </div>
      <label class="field"><span>Opponent (optional)</span><input type="text" id="cfgOpponent" placeholder="e.g. River Rats" value="${esc(this.cfg.opponent)}" /></label>
      <button class="primary block" id="btnGenerate">Build fair rotation</button>
      <div class="hint" id="setupSummary"></div>
    </div>`;

    this.wire();
    this.updateSummary();
  }

  private readInputs(): void {
    this.cfg = {
      fieldSize: clampNum(this.q("cfgField").value, 1, 15, 4),
      halves: clampNum(this.q("cfgHalves").value, 1, 4, 2),
      halfLength: clampNum(this.q("cfgHalfLen").value, 0.5, 60, 10),
      shiftLength: clampNum(this.q("cfgShift").value, 0.5, 30, 2.5),
      maxSwaps: clampNum(this.q("cfgSwaps").value, 0, 15, 0),
      opponent: this.q("cfgOpponent").value.trim(),
      seed: 0,
    };
  }

  private q(id: string): HTMLInputElement {
    return this.querySelector("#" + id) as HTMLInputElement;
  }

  private suggest(): void {
    this.readInputs();
    const team = store.currentTeam();
    const present = team ? team.players.filter((p) => p.present).length : 0;
    const hint = this.querySelector("#suggestHint");
    const s = suggestShift(present, this.cfg.fieldSize, this.cfg.halves, this.cfg.halfLength);
    if (!s) {
      if (hint) hint.textContent = "Add players first to suggest a timer.";
      return;
    }
    this.q("cfgShift").value = String(s.shiftLength);
    this.readInputs();
    this.updateSummary();

    const every = fmtClock(s.shiftLength * 60);
    let msg: string;
    if (s.noSubsNeeded) {
      msg = `Everyone plays the full ${this.cfg.halves * this.cfg.halfLength} min - no subs needed with ${present} here.`;
    } else if (s.perfectlyFair) {
      msg = `Every ${every} · ${s.shiftsPerHalf} shifts/half · all play ${fmtMin(s.minCourtSec)} min (perfectly equal).`;
    } else {
      msg = `Every ${every} · ${s.shiftsPerHalf} shifts/half · ${fmtMin(s.minCourtSec)}-${fmtMin(s.maxCourtSec)} min each (fairest at 30s steps).`;
    }
    if (hint) hint.textContent = msg;
    toast("Set sub timer to " + every);
  }

  private updateSummary(): void {
    const team = store.currentTeam();
    if (!team) return;
    const present = team.players.filter((p) => p.present).length;
    const total = this.cfg.halves * this.cfg.halfLength;
    let msg = `${present} present, ${this.cfg.fieldSize} on court, ${total} min total. `;
    if (present < this.cfg.fieldSize) msg += `Need at least ${this.cfg.fieldSize} present.`;
    else msg += `Target ~${((this.cfg.fieldSize * total) / present).toFixed(1)} min each on court.`;
    // Actual shift length: the half is split into a whole number of equal shifts.
    const halfSec = this.cfg.halfLength * 60;
    const nShifts = Math.max(1, Math.round(halfSec / Math.max(30, this.cfg.shiftLength * 60)));
    const actualSec = Math.round(halfSec / nShifts);
    msg += ` Subs every ${fmtClock(actualSec)} (${nShifts} shifts/half).`;
    const el = this.querySelector("#setupSummary");
    if (el) el.textContent = msg;
    const rc = this.querySelector("#rosterCount");
    if (rc)
      rc.textContent = team.players.length
        ? `${present} here / ${team.players.length} total`
        : "";
  }

  private wire(): void {
    this.querySelector<HTMLSelectElement>("#teamSelect")!.onchange = (e) =>
      store.setCurrentTeam((e.target as HTMLSelectElement).value);
    this.q("teamName").oninput = (e) =>
      store.renameTeam((e.target as HTMLInputElement).value);
    this.querySelector<HTMLButtonElement>("#btnNewTeam")!.onclick = () => {
      const name = prompt("New team name", "New Team");
      if (name !== null) store.newTeam(name);
    };
    this.querySelector<HTMLButtonElement>("#btnDelTeam")!.onclick = () => {
      const t = store.currentTeam();
      if (!t) return;
      if (!confirm("Delete team " + t.name + "?")) return;
      if (!store.deleteTeam()) toast("Keep at least one team");
    };

    this.wirePositions();
    this.wirePlayers();

    ["cfgField", "cfgHalves", "cfgHalfLen", "cfgShift", "cfgSwaps", "cfgOpponent"].forEach((id) => {
      this.q(id).oninput = () => {
        this.readInputs();
        this.updateSummary();
      };
    });

    this.querySelector<HTMLButtonElement>("#btnSuggest")!.onclick = () => this.suggest();

    this.querySelector<HTMLButtonElement>("#btnGenerate")!.onclick = () => {
      this.readInputs();
      const seed = Math.floor(Math.random() * 0x7fffffff);
      if (store.generatePlan({ ...this.cfg, seed })) {
        toast("Rotation ready");
        this.navigate("plan");
      } else {
        toast("Not enough present players");
      }
    };
  }

  private wirePositions(): void {
    const addPos = (): void => {
      const inp = this.q("newPos");
      if (inp.value.trim()) store.addPosition(inp.value);
    };
    this.querySelector<HTMLButtonElement>("#btnAddPos")!.onclick = addPos;
    this.q("newPos").onkeydown = (e) => {
      if ((e as KeyboardEvent).key === "Enter") addPos();
    };

    this.querySelectorAll<HTMLSelectElement>(".posCadence").forEach((sel) => {
      sel.onchange = () =>
        store.setPositionCadence(sel.dataset.pos!, sel.value as PositionCadence);
    });

    this.querySelector("#posList")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!el) return;
      const id = (el.closest("[data-pos]") as HTMLElement).dataset.pos!;
      const act = el.dataset.act;
      if (act === "gk") store.setGoalkeeperPosition(id);
      else if (act === "del") {
        const pos = store.currentTeam()?.positions.find((x: Position) => x.id === id);
        if (pos && confirm("Remove position " + pos.name + "?")) store.removePosition(id);
      } else if (act === "rename") {
        const pos = store.currentTeam()?.positions.find((x: Position) => x.id === id);
        const name = prompt("Rename position", pos?.name ?? "");
        if (name) store.renamePosition(id, name);
      }
    });
  }

  private wirePlayers(): void {
    const add = (): void => {
      const inp = this.q("newPlayer");
      if (inp.value.trim()) store.addPlayer(inp.value);
    };
    this.querySelector<HTMLButtonElement>("#btnAddPlayer")!.onclick = add;
    this.q("newPlayer").onkeydown = (e) => {
      if ((e as KeyboardEvent).key === "Enter") add();
    };

    this.querySelector("#playerList")!.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
      if (!el) return;
      const id = (el.closest(".prow") as HTMLElement).dataset.id!;
      const act = el.dataset.act;
      if (act === "present") store.togglePresent(id);
      else if (act === "pos") store.togglePlayerPosition(id, el.dataset.pos!);
      else if (act === "del") {
        const p = store.currentTeam()?.players.find((x) => x.id === id);
        if (p && confirm("Remove " + p.name + "?")) store.removePlayer(id);
      } else if (act === "rename") {
        const p = store.currentTeam()?.players.find((x) => x.id === id);
        const name = prompt("Rename player", p?.name ?? "");
        if (name) store.renamePlayer(id, name);
      }
    });
  }
}

customElements.define("fs-setup", SetupView);
