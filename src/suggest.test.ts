import { describe, it, expect } from "vitest";
import { suggestShift } from "./suggest";
import { buildSchedule } from "./rotation";
import type { GameConfig, SchedulePlayer } from "./types";

// Cross-check a suggestion against what the real engine produces.
function engineSpread(present: number, fieldSize: number, halves: number, halfLength: number, shiftLength: number): { min: number; max: number } {
  const players: SchedulePlayer[] = Array.from({ length: present }, (_, i) => ({
    id: "p" + i,
    name: "P" + i,
    positionIds: [],
  }));
  const cfg: GameConfig = { fieldSize, halves, halfLength, shiftLength, opponent: "", seed: 0 };
  const sch = buildSchedule(players, [], cfg);
  const fields = sch.totals.map((t) => t.fieldSec);
  return { min: Math.min(...fields), max: Math.max(...fields) };
}

describe("suggestShift", () => {
  it("finds a perfectly fair interval for 5 players, 4 on court", () => {
    const s = suggestShift(5, 4, 2, 10)!;
    expect(s.perfectlyFair).toBe(true);
    expect(s.shiftLength).toBe(2); // every 2:00 -> 5 shifts/half
    expect(s.shiftsPerHalf).toBe(5);
    expect(s.minCourtSec).toBe(s.maxCourtSec);
    // engine agrees: everyone plays exactly the same
    const e = engineSpread(5, 4, 2, 10, s.shiftLength);
    expect(e.min).toBe(e.max);
    expect(e.min).toBe(s.minCourtSec);
  });

  it("suggests a comfortable perfectly-fair interval for 8 players", () => {
    const s = suggestShift(8, 4, 2, 10)!;
    expect(s.perfectlyFair).toBe(true);
    expect(s.shiftLength).toBe(2.5); // nearest the 2.5-min target, not a whole half
    expect(s.shiftsPerHalf).toBe(4);
    const e = engineSpread(8, 4, 2, 10, s.shiftLength);
    expect(e.min).toBe(e.max);
  });

  it("finds an exact-length perfectly fair interval for 6 players", () => {
    const s = suggestShift(6, 4, 2, 10)!;
    expect(s.perfectlyFair).toBe(true);
    expect(Math.round(s.shiftLength * 60)).toBe(200); // 3:20, three exact shifts per half
    expect(s.shiftsPerHalf).toBe(3);
    const e = engineSpread(6, 4, 2, 10, s.shiftLength);
    expect(e.min).toBe(e.max);
    expect(e.min).toBe(s.minCourtSec);
  });

  it("balances fairness and cadence when no interval is perfect (7 players)", () => {
    const s = suggestShift(7, 4, 2, 10)!;
    expect(s.perfectlyFair).toBe(false);
    expect(s.shiftLength).toBeGreaterThanOrEqual(1.5); // not the chaotic 0:30
    const e = engineSpread(7, 4, 2, 10, s.shiftLength);
    expect([e.min, e.max]).toEqual([s.minCourtSec, s.maxCourtSec]);
    expect(e.max - e.min).toBeLessThanOrEqual(60);
  });

  it("flags when everyone plays the whole game (present <= court size)", () => {
    const s = suggestShift(4, 4, 2, 10)!;
    expect(s.noSubsNeeded).toBe(true);
    expect(s.perfectlyFair).toBe(true);
  });

  it("computes the fair share of court time", () => {
    const s = suggestShift(6, 4, 2, 10)!;
    expect(s.fairShareSec).toBeCloseTo((4 * 20 * 60) / 6, 5);
  });

  it("returns null for invalid inputs", () => {
    expect(suggestShift(0, 4, 2, 10)).toBeNull();
    expect(suggestShift(6, 0, 2, 10)).toBeNull();
    expect(suggestShift(6, 4, 0, 10)).toBeNull();
    expect(suggestShift(6, 4, 2, 0.25)).toBeNull();
  });

  it("never suggests an interval below 30 seconds", () => {
    for (let n = 4; n <= 14; n++) {
      const s = suggestShift(n, 4, 2, 10)!;
      expect(s.shiftLength).toBeGreaterThanOrEqual(0.5);
    }
  });
});
