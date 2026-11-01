import { View } from "./base";
import { store } from "../store";
import { seedState } from "../store";
import { esc, fmtClock, fmtMin, todayStr } from "../format";
import { aggregateStats, gamesToCsv, playerNameMap, scorers } from "../stats";
import { download, openInfo, toast } from "./ui";
import type { AppState, FinishedGame } from "../types";

export class HistoryView extends View {
  render(): void {
    const games = store.state.games;

    const cards = games
      .map((game) => {
        const scored = scorers(game);
        const scorerTxt = Object.keys(scored).length
          ? Object.entries(scored)
              .map(([name, n]) => esc(name) + (n > 1 ? " ×" + n : ""))
              .join(", ")
          : "-";
        const r = game.result;
        const win = r.us > r.them ? "us" : r.us < r.them ? "them" : "";
        return `
        <div class="card" data-id="${game.id}">
          <div class="row between">
            <div>
              <b>${esc(game.teamName || "Us")}</b> vs ${esc(game.opponent || "Opponent")}
              <div><small>${esc(game.date || "")}</small></div>
            </div>
            <div style="text-align:right"><span class="pill ${win}" style="font-size:15px">${r.us} – ${r.them}</span></div>
          </div>
          <div style="margin-top:8px"><small>Scorers:</small> ${scorerTxt}</div>
          <div class="row" style="margin-top:10px">
            <button class="sm ghost" data-act="detail">Details</button>
            <button class="sm danger" data-act="del">Delete</button>
          </div>
        </div>`;
      })
      .join("");

    const stats = aggregateStats(games);
    const statRows = stats.length
      ? stats
          .map(
            (r) =>
              `<tr><td>${esc(r.name)}</td><td class="num">${r.games}</td><td class="num">${r.goals}</td><td class="num">${fmtMin(r.fieldSec)}</td><td class="num">${fmtMin(r.gkSec)}</td><td class="num">${r.conceded}</td></tr>`,
          )
          .join("")
      : `<tr><td class="resting">No games yet.</td></tr>`;

    this.innerHTML = `
    <div class="card">
      <div class="row between">
        <h2>Game history</h2>
        <div class="row">
          <button class="sm" id="btnExportJson">Export JSON</button>
          <button class="sm" id="btnExportCsv">Export CSV</button>
        </div>
      </div>
      <div class="hint">Stats are stored on this device forever. Export regularly to keep a backup.</div>
    </div>
    ${cards}
    ${games.length ? "" : `<div class="card empty">No saved games yet.</div>`}
    <div class="card">
      <h3>All-time player stats</h3>
      <div class="scroll-x"><table>
        <thead><tr><th>Player</th><th class="num">GP</th><th class="num">Goals</th><th class="num">Field min</th><th class="num">GK min</th><th class="num">Conceded</th></tr></thead>
        <tbody>${statRows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h3>Data</h3>
      <div class="row">
        <button class="sm" id="btnImport">Import JSON</button>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
        <button class="sm danger" id="btnWipe">Erase everything</button>
      </div>
    </div>`;

    this.wire(games);
  }

  private wire(games: FinishedGame[]): void {
    this.querySelectorAll<HTMLElement>(".card[data-id]").forEach((card) => {
      const id = card.dataset.id!;
      const game = games.find((g) => g.id === id)!;
      card.querySelector<HTMLButtonElement>("[data-act=detail]")!.onclick = () =>
        this.showDetail(game);
      card.querySelector<HTMLButtonElement>("[data-act=del]")!.onclick = () => {
        if (confirm("Delete this game?")) store.deleteGame(id);
      };
    });

    this.querySelector<HTMLButtonElement>("#btnExportJson")!.onclick = () => {
      download(
        "fairshift-" + todayStr() + ".json",
        JSON.stringify(store.state, null, 2),
        "application/json",
      );
      toast("Exported JSON");
    };
    this.querySelector<HTMLButtonElement>("#btnExportCsv")!.onclick = () => {
      download(
        "fairshift-goals-" + todayStr() + ".csv",
        gamesToCsv(store.state.games),
        "text/csv",
      );
      toast("Exported CSV");
    };

    const fileInput = this.querySelector<HTMLInputElement>("#importFile")!;
    this.querySelector<HTMLButtonElement>("#btnImport")!.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      if (file) this.importFile(file);
      fileInput.value = "";
    };

    this.querySelector<HTMLButtonElement>("#btnWipe")!.onclick = () => {
      if (!confirm("Erase ALL teams, games and stats on this device? Export a backup first!"))
        return;
      if (!confirm("Really erase everything? This cannot be undone.")) return;
      store.wipe();
      toast("Erased");
    };
  }

  private importFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(String(reader.result)) as Partial<AppState>;
        if (!s.teams || !Array.isArray(s.teams)) throw new Error("bad file");
        if (!confirm("Replace ALL current data with the imported file?")) return;
        const merged = seedState();
        merged.teams = s.teams;
        merged.currentTeamId = s.currentTeamId ?? s.teams[0]?.id ?? null;
        merged.plan = s.plan ?? null;
        merged.live = s.live ?? null;
        merged.games = s.games ?? [];
        store.replaceState(merged);
        toast("Imported");
      } catch {
        toast("Import failed - not a FairShift file");
      }
    };
    reader.readAsText(file);
  }

  private showDetail(game: FinishedGame): void {
    const nm = playerNameMap(game.players);
    let html = `<div class="hint">${esc(game.date)} - final ${game.result.us} – ${game.result.them}</div>`;
    if (game.schedule?.totals) {
      const positions = game.positions ?? [];
      const posHead = positions
        .map((p) => `<th class='num'>${esc(p.name)}</th>`)
        .join("");
      html +=
        `<h3 style='margin-top:12px'>Minutes</h3><div class='scroll-x'><table><thead><tr><th>Player</th><th class='num'>Field</th>${posHead}</tr></thead><tbody>`;
      [...game.schedule.totals]
        .sort((a, b) => b.fieldSec - a.fieldSec)
        .forEach((t) => {
          const posCells = positions
            .map((p) => `<td class='num'>${fmtMin(t.posSec[p.id] ?? 0)}</td>`)
            .join("");
          html += `<tr><td>${esc(t.name)}</td><td class='num'>${fmtMin(t.fieldSec)}</td>${posCells}</tr>`;
        });
      html += "</tbody></table></div>";
    }
    html += "<h3 style='margin-top:12px'>Goals</h3>";
    if (!game.events.length) html += "<div class='resting'>No goals recorded.</div>";
    else {
      html += "<div class='log'>";
      game.events.forEach((e) => {
        const label =
          e.team === "us"
            ? `<span class="pill us">US</span> ${e.scorerId ? esc(nm[e.scorerId] || "?") : "goal"}`
            : `<span class="pill them">THEM</span> goal${e.gkId ? " (GK " + esc(nm[e.gkId] || "?") + ")" : ""}`;
        html += `<div class="logitem"><span class="t">H${e.half + 1} ${fmtClock(e.clock)}</span><span style="flex:1">${label}</span></div>`;
      });
      html += "</div>";
    }
    openInfo("Game detail", html);
  }
}

customElements.define("fs-history", HistoryView);
