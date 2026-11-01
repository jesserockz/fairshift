import { describe, it, expect } from "vitest";
import {
  playerNameMap,
  countGoals,
  scorers,
  aggregateStats,
  gamesToCsv,
} from "./stats";
import type { FinishedGame, GameEvent, Position, SchedulePlayer } from "./types";

const gk: Position = { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true };
const players: SchedulePlayer[] = [
  { id: "a", name: "Ava", positionIds: ["gk"] },
  { id: "b", name: "Ben", positionIds: [] },
];

const goal = (over: Partial<GameEvent>): GameEvent => ({
  id: Math.random().toString(36),
  kind: "goal",
  team: "us",
  scorerId: null,
  gkId: null,
  half: 0,
  clock: 100,
  at: "",
  ...over,
});

function game(events: GameEvent[], over: Partial<FinishedGame> = {}): FinishedGame {
  return {
    id: "g" + Math.random(),
    teamId: "t",
    teamName: "Foxes",
    opponent: "Rats",
    date: "2026-08-03",
    startedAt: "",
    finishedAt: "",
    cfg: { fieldSize: 4, halves: 2, halfLength: 10, shiftLength: 2.5, opponent: "Rats", seed: 0 },
    players,
    positions: [gk],
    schedule: {
      fieldSize: 4,
      positions: [gk],
      shifts: [],
      totals: [
        { id: "a", name: "Ava", fieldSec: 1200, posSec: { gk: 600 }, gameSec: 1200, restSec: 0 },
        { id: "b", name: "Ben", fieldSec: 900, posSec: {}, gameSec: 1200, restSec: 300 },
      ],
    },
    currentHalf: 1,
    elapsedSec: 0,
    running: false,
    manualShift: 0,
    events,
    result: { us: countGoals(events, "us"), them: countGoals(events, "them") },
    ...over,
  };
}

describe("stats", () => {
  it("playerNameMap maps ids to names", () => {
    expect(playerNameMap(players)).toEqual({ a: "Ava", b: "Ben" });
  });

  it("countGoals counts per team", () => {
    const evs = [goal({ team: "us" }), goal({ team: "us" }), goal({ team: "them" })];
    expect(countGoals(evs, "us")).toBe(2);
    expect(countGoals(evs, "them")).toBe(1);
  });

  it("scorers tallies our scorers by name, unknown ids as '?'", () => {
    const g = game([
      goal({ team: "us", scorerId: "b" }),
      goal({ team: "us", scorerId: "b" }),
      goal({ team: "us", scorerId: null }),
      goal({ team: "us", scorerId: "ghost" }),
      goal({ team: "them", gkId: "a" }),
    ]);
    expect(scorers(g)).toEqual({ Ben: 2, "?": 1 });
  });

  it("aggregateStats sums minutes, goals, GK time and conceded", () => {
    const g = game([
      goal({ team: "us", scorerId: "b" }),
      goal({ team: "them", gkId: "a" }),
      goal({ team: "them", gkId: "a" }),
    ]);
    const rows = aggregateStats([g, g]);
    const ava = rows.find((r) => r.name === "Ava")!;
    const ben = rows.find((r) => r.name === "Ben")!;
    expect(ava.games).toBe(2);
    expect(ava.gkSec).toBe(1200); // 600 per game * 2
    expect(ava.conceded).toBe(4); // 2 per game * 2
    expect(ben.goals).toBe(2);
    expect(ben.fieldSec).toBe(1800);
    // sorted by goals desc: Ben first
    expect(rows[0].name).toBe("Ben");
  });

  it("aggregateStats counts only goalkeeper positions toward gkSec", () => {
    const def: Position = { id: "def", name: "Def", cadence: "shift", isGoalkeeper: false };
    const g = game([], {
      positions: [gk, def],
      schedule: {
        shifts: [],
        fieldSize: 4,
        positions: [gk, def],
        totals: [
          { id: "a", name: "Ava", fieldSec: 900, posSec: { gk: 300, def: 600 }, gameSec: 1200, restSec: 300 },
        ],
      },
    });
    const ava = aggregateStats([g]).find((r) => r.name === "Ava")!;
    expect(ava.gkSec).toBe(300);
  });

  it("aggregateStats returns empty for no games", () => {
    expect(aggregateStats([])).toEqual([]);
  });

  it("aggregateStats keeps both rows when players are fully equal", () => {
    const g = game([], {
      schedule: {
        fieldSize: 4,
        positions: [gk],
        shifts: [],
        totals: [
          { id: "a", name: "Ava", fieldSec: 600, posSec: {}, gameSec: 1200, restSec: 600 },
          { id: "b", name: "Ben", fieldSec: 600, posSec: {}, gameSec: 1200, restSec: 600 },
        ],
      },
    });
    expect(aggregateStats([g])).toHaveLength(2);
  });

  it("aggregateStats breaks equal-goal ties by field time", () => {
    // both score once; Ava has more field minutes so sorts first
    const g = game([goal({ team: "us", scorerId: "a" }), goal({ team: "us", scorerId: "b" })]);
    const rows = aggregateStats([g]);
    expect(rows.map((r) => r.name)).toEqual(["Ava", "Ben"]);
  });

  it("gamesToCsv emits a header, a goal row, and a bare row for goalless games", () => {
    const withGoals = game([goal({ team: "us", scorerId: "b" }), goal({ team: "them", gkId: "a" })]);
    const goalless = game([]);
    const csv = gamesToCsv([withGoals, goalless]);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("type,date,team_name");
    expect(lines.some((l) => l.startsWith("goal,") && l.includes("Ben"))).toBe(true);
    expect(lines.some((l) => l.startsWith("goal,") && l.includes(",them,,Ava"))).toBe(true);
    expect(lines.some((l) => l.startsWith("game,"))).toBe(true);
  });

  it("gamesToCsv quotes cells containing commas", () => {
    const g = game([], { teamName: "Foxes, Jr" });
    expect(gamesToCsv([g])).toContain('"Foxes, Jr"');
  });

  it("gamesToCsv leaves scorer/keeper blank for null or unknown ids", () => {
    const g = game([
      goal({ team: "us", scorerId: null }),
      goal({ team: "us", scorerId: "ghost" }),
      goal({ team: "them", gkId: null }),
      goal({ team: "them", gkId: "ghost" }),
    ]);
    const rows = gamesToCsv([g]).split("\n").slice(1);
    expect(rows).toHaveLength(4);
    // null scorer/keeper -> trailing empty cells
    expect(rows[0].endsWith(",us,,")).toBe(true);
    expect(rows[2].endsWith(",them,,")).toBe(true);
    // unknown ids also resolve to empty names
    expect(rows[1].endsWith(",us,,")).toBe(true);
    expect(rows[3].endsWith(",them,,")).toBe(true);
  });
});
