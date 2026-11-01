import type { FinishedGame, GameEvent, SchedulePlayer } from "./types";
import { fmtClock } from "./format";

/** id -> name lookup for a game's roster snapshot. */
export function playerNameMap(
  players: SchedulePlayer[],
): Record<string, string> {
  const m: Record<string, string> = {};
  players.forEach((p) => (m[p.id] = p.name));
  return m;
}

export function countGoals(
  events: GameEvent[],
  team: "us" | "them",
): number {
  return events.filter((e) => e.kind === "goal" && e.team === team).length;
}

/** Our scorers for a game as `name -> count`. */
export function scorers(game: FinishedGame): Record<string, number> {
  const nm = playerNameMap(game.players);
  const out: Record<string, number> = {};
  game.events
    .filter((e) => e.team === "us" && e.scorerId)
    .forEach((e) => {
      const name = nm[e.scorerId as string] || "?";
      out[name] = (out[name] || 0) + 1;
    });
  return out;
}

export interface StatRow {
  name: string;
  games: number;
  goals: number;
  fieldSec: number;
  gkSec: number;
  conceded: number;
}

/** Aggregate per-player stats across every finished game (keyed by name). */
export function aggregateStats(games: FinishedGame[]): StatRow[] {
  const agg: Record<string, StatRow> = {};
  const ensure = (name: string): StatRow =>
    (agg[name] ??= {
      name,
      games: 0,
      goals: 0,
      fieldSec: 0,
      gkSec: 0,
      conceded: 0,
    });

  games.forEach((game) => {
    const nm = playerNameMap(game.players);
    const gkPosIds = new Set(
      game.positions.filter((p) => p.isGoalkeeper).map((p) => p.id),
    );
    game.schedule.totals.forEach((t) => {
      const row = ensure(t.name);
      row.games += 1;
      row.fieldSec += t.fieldSec;
      for (const posId in t.posSec) {
        if (gkPosIds.has(posId)) row.gkSec += t.posSec[posId];
      }
    });
    game.events.forEach((e) => {
      if (e.team === "us" && e.scorerId && nm[e.scorerId]) {
        ensure(nm[e.scorerId]).goals += 1;
      }
      if (e.team === "them" && e.gkId && nm[e.gkId]) {
        ensure(nm[e.gkId]).conceded += 1;
      }
    });
  });

  return Object.values(agg).sort(
    (a, b) => b.goals - a.goals || b.fieldSec - a.fieldSec,
  );
}

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One row per goal (plus a bare row for goalless games) for spreadsheets. */
export function gamesToCsv(games: FinishedGame[]): string {
  const header = [
    "type",
    "date",
    "team_name",
    "opponent",
    "result_us",
    "result_them",
    "half",
    "clock_mmss",
    "event_team",
    "scorer",
    "gk",
  ];
  const lines = [header.map(csvCell).join(",")];

  games.forEach((game) => {
    const nm = playerNameMap(game.players);
    const r = game.result;
    if (!game.events.length) {
      lines.push(
        ["game", game.date, game.teamName, game.opponent, r.us, r.them, "", "", "", "", ""]
          .map(csvCell)
          .join(","),
      );
    }
    game.events.forEach((e) => {
      lines.push(
        [
          "goal",
          game.date,
          game.teamName,
          game.opponent,
          r.us,
          r.them,
          e.half + 1,
          fmtClock(e.clock),
          e.team,
          e.scorerId ? nm[e.scorerId] || "" : "",
          e.gkId ? nm[e.gkId] || "" : "",
        ]
          .map(csvCell)
          .join(","),
      );
    });
  });

  return lines.join("\n");
}
