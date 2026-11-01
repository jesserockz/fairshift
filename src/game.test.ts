import { describe, it, expect } from "vitest";
import {
  advanceOneSecond,
  currentShift,
  nextShift,
  shiftIndexForElapsed,
  roleMap,
  keeperId,
  orderedCourt,
  subPlan,
} from "./game";
import type { Shift } from "./types";
import { buildSchedule } from "./rotation";
import type { GameConfig, LiveGame, Position, SchedulePlayer } from "./types";

const gk: Position = { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true };
const cfg: GameConfig = {
  fieldSize: 4,
  halves: 2,
  halfLength: 10,
  shiftLength: 2.5,
  opponent: "",
  seed: 0,
};
const players: SchedulePlayer[] = ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"].map((n) => ({
  id: n.toLowerCase(),
  name: n,
  positionIds: ["ava", "ben", "cai"].includes(n.toLowerCase()) ? ["gk"] : [],
}));

function makeGame(over: Partial<LiveGame> = {}): LiveGame {
  const schedule = buildSchedule(players, [gk], cfg);
  return {
    id: "g1",
    teamId: "t",
    teamName: "Us",
    opponent: "Them",
    date: "2026-08-03",
    startedAt: "",
    cfg,
    players,
    positions: [gk],
    schedule,
    currentHalf: 0,
    elapsedSec: 0,
    running: true,
    manualShift: 0,
    events: [],
    ...over,
  };
}

describe("game clock helpers", () => {
  it("currentShift and nextShift track manualShift", () => {
    const g = makeGame({ manualShift: 0 });
    expect(currentShift(g).idx).toBe(0);
    expect(nextShift(g)!.idx).toBe(1);
  });

  it("currentShift falls back to first shift, nextShift to null at the end", () => {
    const g = makeGame({ manualShift: 999 });
    expect(currentShift(g).idx).toBe(0);
    const last = makeGame({ manualShift: g.schedule.shifts.length - 1 });
    expect(nextShift(last)).toBeNull();
  });

  it("shiftIndexForElapsed maps elapsed to the covering shift", () => {
    const g = makeGame({ elapsedSec: 0 });
    expect(shiftIndexForElapsed(g)).toBe(0);
    g.elapsedSec = 200; // into second shift (150-300s)
    expect(shiftIndexForElapsed(g)).toBe(1);
    g.elapsedSec = 10_000; // past the end clamps to last shift of half
    expect(shiftIndexForElapsed(g)).toBe(3);
  });

  it("returns null when the current half has no shifts", () => {
    const g = makeGame({ currentHalf: 9 });
    expect(shiftIndexForElapsed(g)).toBeNull();
  });

  it("advanceOneSecond crosses a shift boundary", () => {
    const g = makeGame({ elapsedSec: 149, manualShift: 0 });
    const r = advanceOneSecond(g);
    expect(g.elapsedSec).toBe(150);
    expect(r.shiftAdvanced).toBe(true);
    expect(g.manualShift).toBe(1);
    expect(r.halfEnded).toBe(false);
  });

  it("advanceOneSecond ends the half and stops the clock", () => {
    const g = makeGame({ elapsedSec: 599, manualShift: 3 });
    const r = advanceOneSecond(g);
    expect(g.elapsedSec).toBe(600);
    expect(g.running).toBe(false);
    expect(r.halfEnded).toBe(true);
  });

  it("advanceOneSecond mid-shift changes nothing structural", () => {
    const g = makeGame({ elapsedSec: 10, manualShift: 0 });
    const r = advanceOneSecond(g);
    expect(r).toEqual({ shiftAdvanced: false, halfEnded: false });
  });
});

describe("roles and subs", () => {
  it("roleMap and keeperId expose the on-shift keeper", () => {
    const g = makeGame();
    const sh = currentShift(g);
    const roles = roleMap(sh, g.positions);
    const kid = keeperId(sh, g.positions);
    expect(kid).not.toBeNull();
    expect(roles[kid as string].name).toBe("GK");
  });

  it("roleMap skips positions nobody holds on the shift", () => {
    const g = makeGame();
    const sh = { ...currentShift(g), assignments: {} };
    expect(roleMap(sh, g.positions)).toEqual({});
  });

  it("keeperId is null without a goalkeeper position", () => {
    const g = makeGame();
    expect(keeperId(currentShift(g), [])).toBeNull();
  });

  it("keeperId is null when the goalkeeper role is unfilled", () => {
    const g = makeGame();
    const empty = { ...currentShift(g), assignments: {} };
    expect(keeperId(empty, g.positions)).toBeNull();
  });

  it("subInfo-style plan tags a keeper handover in the real schedule", () => {
    const g = makeGame();
    const rows = subPlan(g.schedule.shifts[0], g.schedule.shifts[1], g.positions);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.tag === "GK")).toBe(true);
  });
});

describe("orderedCourt", () => {
  const gkPos: Position = { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true };
  const mk = (idx: number, onIds: string[], assignments: Record<string, string> = {}): Shift => ({
    idx,
    half: 0,
    startSec: 0,
    endSec: 150,
    durSec: 150,
    onIds,
    restingIds: [],
    assignments,
  });

  it("puts the keeper last and orders the rest by who leaves soonest", () => {
    const s0 = mk(0, ["a", "b", "c", "g"], { gk: "g" });
    const s1 = mk(1, ["b", "c", "d", "g"], { gk: "g" }); // a leaves next
    const s2 = mk(2, ["c", "d", "e", "g"], { gk: "g" }); // then b leaves
    expect(orderedCourt(s0, [s0, s1, s2], [gkPos])).toEqual(["a", "b", "c", "g"]);
  });

  it("keeps on-court order when there are no roles or later shifts", () => {
    const s0 = mk(0, ["a", "b", "c", "d"]);
    expect(orderedCourt(s0, [s0], [])).toEqual(["a", "b", "c", "d"]);
  });

  it("moves a keeper listed first to the end", () => {
    const s0 = mk(0, ["g", "a", "b", "c"], { gk: "g" });
    expect(orderedCourt(s0, [s0], [gkPos])).toEqual(["a", "b", "c", "g"]);
  });
});

describe("subPlan pairing", () => {
  const shift = (onIds: string[], assignments: Record<string, string>): Shift => ({
    idx: 0,
    half: 0,
    startSec: 0,
    endSec: 150,
    durSec: 150,
    onIds,
    restingIds: [],
    assignments,
  });

  it("pairs a keeper who subs off with the keeper coming on", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["b", "c", "d", "e"], { gk: "e" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "a", onId: "e", tag: "GK" }]);
  });

  it("shows a pure role swap between players already on court", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "c", "d"], { gk: "b" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "a", onId: "b", tag: "GK" }]);
  });

  it("pairs plain substitutions by order when there are no positions", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["a", "b", "e", "f"], {}),
      [],
    );
    expect(rows).toEqual([
      { offId: "c", onId: "e", tag: null },
      { offId: "d", onId: "f", tag: null },
    ]);
  });

  it("tags a newly filled role even when nobody held it before", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["b", "c", "d", "e"], { gk: "e" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "a", onId: "e", tag: "GK" }]);
  });

  it("ignores an unfilled or unchanged role", () => {
    const unchanged = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "c", "d"], { gk: "a" }),
      [gk],
    );
    expect(unchanged).toEqual([]);
    const unfilledNext = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "c", "d"], {}),
      [gk],
    );
    expect(unfilledNext).toEqual([]);
  });

  it("tags the role when it moves to an incoming player and the old holder stays", () => {
    // GK a stays on court; d comes off, e comes on and takes GK
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "c", "e"], { gk: "e" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "d", onId: "e", tag: "GK" }]);
  });

  it("shows a role first assigned to a player already on court", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["a", "b", "c", "d"], { gk: "a" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: null, onId: "a", tag: "GK" }]);
  });

  it("keeps a role swap plus a separate straight sub distinct", () => {
    // GK swaps from a to b (both stay on); c comes off for e
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "d", "e"], { gk: "b" }),
      [gk],
    );
    expect(rows).toContainEqual({ offId: "a", onId: "b", tag: "GK" });
    expect(rows).toContainEqual({ offId: "c", onId: "e", tag: null });
    expect(rows).toHaveLength(2);
  });
});
