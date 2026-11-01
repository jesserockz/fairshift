import { describe, it, expect } from "vitest";
import { buildSchedule } from "./rotation";
import type { GameConfig, Position, SchedulePlayer } from "./types";

const cfg = (over: Partial<GameConfig> = {}): GameConfig => ({
  fieldSize: 4,
  halves: 2,
  halfLength: 10,
  shiftLength: 2.5,
  opponent: "",
  seed: 0,
  ...over,
});

const mkPlayers = (names: string[], eligible: Record<string, string[]> = {}): SchedulePlayer[] =>
  names.map((n) => ({ id: n.toLowerCase(), name: n, positionIds: eligible[n] ?? [] }));

const gk: Position = { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true };
const total = (t: { fieldSec: number }[]): number => t.reduce((a, x) => a + x.fieldSec, 0);

describe("buildSchedule fairness", () => {
  it("splits court time optimally with a per-shift GK", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
      Ava: ["gk"],
      Ben: ["gk"],
      Cai: ["gk"],
    });
    const s = buildSchedule(players, [gk], cfg());
    expect(s.shifts).toHaveLength(8);
    // 8 shifts * 4 slots = 32 player-slots over 6 players => two get 15, four get 12.5
    const fields = s.totals.map((t) => t.fieldSec).sort((a, b) => a - b);
    expect(fields).toEqual([750, 750, 750, 750, 900, 900]);
    expect(total(s.totals)).toBe(8 * 4 * 150);
    // GK time shared among the three eligible only
    const gkPlayers = s.totals.filter((t) => (t.posSec.gk ?? 0) > 0).map((t) => t.name);
    expect(gkPlayers.sort()).toEqual(["Ava", "Ben", "Cai"]);
    expect(s.totals.reduce((a, t) => a + (t.posSec.gk ?? 0), 0)).toBe(8 * 150);
  });

  it("keeps the sole eligible keeper on court the whole game", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], { Ava: ["gk"] });
    const s = buildSchedule(players, [gk], cfg());
    const ava = s.totals.find((t) => t.name === "Ava")!;
    expect(ava.fieldSec).toBe(1200); // all 20 min
    expect(ava.posSec.gk).toBe(1200);
  });

  it("seed rotates who gets the extra shift", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
      Ava: ["gk"],
      Ben: ["gk"],
      Cai: ["gk"],
    });
    const a = buildSchedule(players, [gk], cfg({ seed: 0 }));
    const b = buildSchedule(players, [gk], cfg({ seed: 2 }));
    const extra = (s: typeof a): string[] =>
      s.totals.filter((t) => t.fieldSec === 900).map((t) => t.name).sort();
    expect(extra(a)).not.toEqual(extra(b));
  });

  it("does pure subs when no positions are defined", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli"]);
    const s = buildSchedule(players, [], cfg());
    expect(s.shifts.every((sh) => Object.keys(sh.assignments).length === 0)).toBe(true);
    // 8*4=32 slots over 5 => three get 7 shifts, two get 6
    expect(total(s.totals)).toBe(32 * 150);
  });

  it("evens out an avoidable court-time gap the greedy leaves behind", () => {
    // 5 players, 3 on court, 1-min shifts => 20 shifts, 60 slots, 60/5 = 12 each.
    // The greedy (keeper pinning) leaves a one-shift gap here; the balancer closes it.
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli"], {
      Ava: ["gk"],
      Ben: ["gk"],
      Cai: ["gk"],
      Dan: ["gk"],
    });
    const s = buildSchedule(players, [gk], cfg({ fieldSize: 3, shiftLength: 1 }));
    const fields = s.totals.map((t) => t.fieldSec);
    expect(new Set(fields).size).toBe(1); // perfectly even after balancing
  });

  it("cannot even out time taken by an unavoidable game-long role", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai"], { Ava: ["fix"] });
    const fix: Position = { id: "fix", name: "Fix", cadence: "game", isGoalkeeper: false };
    const s = buildSchedule(players, [fix], cfg({ fieldSize: 2 }));
    const ava = s.totals.find((t) => t.name === "Ava")!;
    // Ava holds the game-long role, so she is on court every shift; the balancer
    // leaves her high (it never moves role holders) and just balances the rest
    expect(ava.fieldSec).toBe(2 * 10 * 60);
    const others = s.totals.filter((t) => t.name !== "Ava").map((t) => t.fieldSec);
    expect(Math.abs(others[0] - others[1])).toBeLessThanOrEqual(others[0] / 8 + 1);
  });

  it("balances court time with several bench players to choose from", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli"], {
      Ava: ["gk"],
      Dan: ["gk"],
    });
    const half: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(players, [half], cfg({ fieldSize: 2 }));
    // half-cadence keepers stay pinned, but every shift is still fully staffed
    expect(total(s.totals)).toBe(s.shifts.length * 2 * 150);
    expect(s.shifts.every((sh) => sh.assignments.gk !== undefined)).toBe(true);
  });

  it("everyone plays when fieldSize >= squad", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai"]);
    const s = buildSchedule(players, [], cfg({ fieldSize: 5 }));
    expect(s.fieldSize).toBe(3);
    expect(s.totals.every((t) => t.fieldSec === 1200)).toBe(true);
    expect(s.totals.every((t) => t.restSec === 0)).toBe(true);
  });
});

describe("position cadences", () => {
  it("half cadence keeps one keeper for the whole half, switching next half", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
      Ava: ["gk"],
      Ben: ["gk"],
    });
    const halfGk: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(players, [halfGk], cfg());
    const half0 = s.shifts.filter((sh) => sh.half === 0).map((sh) => sh.assignments.gk);
    const half1 = s.shifts.filter((sh) => sh.half === 1).map((sh) => sh.assignments.gk);
    expect(new Set(half0).size).toBe(1); // same keeper all first half
    expect(new Set(half1).size).toBe(1);
    expect(half0[0]).not.toBe(half1[0]); // rotates for second half
  });

  it("game cadence keeps one holder the whole game", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan"], { Ava: ["def"], Ben: ["def"] });
    const def: Position = { id: "def", name: "Def", cadence: "game", isGoalkeeper: false };
    const s = buildSchedule(players, [def], cfg());
    const holders = new Set(s.shifts.map((sh) => sh.assignments.def));
    expect(holders.size).toBe(1);
  });

  it("assigns distinct players to concurrent positions", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli"], {
      Ava: ["gk", "def"],
      Ben: ["gk", "def"],
      Cai: ["def"],
    });
    const def: Position = { id: "def", name: "Def", cadence: "shift", isGoalkeeper: false };
    const s = buildSchedule(players, [gk, def], cfg());
    for (const sh of s.shifts) {
      expect(sh.assignments.gk).not.toBe(sh.assignments.def);
    }
  });

  it("leaves a position unfilled when nobody is eligible (fair path)", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan"]);
    const s = buildSchedule(players, [gk], cfg());
    expect(s.shifts.every((sh) => sh.assignments.gk === undefined)).toBe(true);
  });

  it("stops adding roles when positions exceed court size", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai"], {
      Ava: ["p1"],
      Ben: ["p2"],
      Cai: ["p3"],
    });
    const positions: Position[] = [
      { id: "p1", name: "P1", cadence: "game", isGoalkeeper: false },
      { id: "p2", name: "P2", cadence: "game", isGoalkeeper: false },
      { id: "p3", name: "P3", cadence: "game", isGoalkeeper: false },
    ];
    const s = buildSchedule(players, positions, cfg({ fieldSize: 2 }));
    s.shifts.forEach((sh) => expect(sh.onIds).toHaveLength(2));
  });
});

describe("rolling substitutions (maxSwaps)", () => {
  const six = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
    Ava: ["gk"],
    Ben: ["gk"],
    Cai: ["gk"],
  });
  const diffs = (sch: ReturnType<typeof buildSchedule>): number[] => {
    const out: number[] = [];
    for (let i = 1; i < sch.shifts.length; i++) {
      const prev = new Set(sch.shifts[i - 1].onIds);
      out.push(sch.shifts[i].onIds.filter((id) => !prev.has(id)).length);
    }
    return out;
  };

  it("changes at most one player per shift when maxSwaps is 1", () => {
    const s = buildSchedule(six, [], cfg({ maxSwaps: 1 }));
    expect(diffs(s).every((d) => d <= 1)).toBe(true);
    // still conserves total court time and benches nobody the whole game
    expect(total(s.totals)).toBe(8 * 4 * 150);
    expect(s.totals.every((t) => t.fieldSec > 0)).toBe(true);
  });

  it("changes at most two players per shift when maxSwaps is 2", () => {
    const s = buildSchedule(six, [], cfg({ maxSwaps: 2 }));
    expect(diffs(s).every((d) => d <= 2)).toBe(true);
  });

  it("caps swaps at the number of resting players", () => {
    // 6 players, 4 on court => only 2 rest, so maxSwaps 5 still changes <= 2
    const s = buildSchedule(six, [], cfg({ maxSwaps: 5 }));
    expect(diffs(s).every((d) => d <= 2)).toBe(true);
  });

  it("evens rolling court time while keeping the subs-at-once limit", () => {
    const names = ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin", "Gus"];
    const players = mkPlayers(names, Object.fromEntries(names.map((n) => [n, ["gk"]])));
    // 7 players, 4 on court, 1.5-min shifts => 14 shifts, 56 slots, 8 each.
    const s = buildSchedule(players, [gk], cfg({ shiftLength: 1.5, maxSwaps: 2 }));
    expect(new Set(s.totals.map((t) => t.fieldSec)).size).toBe(1);
    expect(diffs(s).every((d) => d <= 2)).toBe(true);
  });

  it("rolls as a clean conveyor: front player off, keeper newest and never subbed", () => {
    const names = ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin", "Gus"];
    const players = mkPlayers(names, Object.fromEntries(names.map((n) => [n, ["gk"]])));
    const s = buildSchedule(players, [gk], cfg({ shiftLength: 1.5, maxSwaps: 1 }));
    for (let i = 1; i < s.shifts.length; i++) {
      const prev = s.shifts[i - 1];
      const cur = s.shifts[i];
      const off = prev.onIds.filter((id) => !cur.onIds.includes(id));
      expect(off).toEqual([prev.onIds[0]]); // exactly the front player rolls off
      expect(prev.assignments.gk).toBe(prev.onIds[prev.onIds.length - 1]); // keeper is newest
      expect(off).not.toContain(prev.assignments.gk); // keeper never subbed off
    }
  });

  it("makes no swaps when everyone is always on court", () => {
    const four = mkPlayers(["Ava", "Ben", "Cai", "Dan"]);
    const s = buildSchedule(four, [], cfg({ maxSwaps: 1 }));
    expect(diffs(s).every((d) => d === 0)).toBe(true);
  });

  it("keeps a per-shift keeper filled every shift under rolling subs", () => {
    const s = buildSchedule(six, [gk], cfg({ maxSwaps: 1 }));
    expect(s.shifts.every((sh) => sh.assignments.gk !== undefined)).toBe(true);
    // the keeper is always one of the on-court players
    expect(s.shifts.every((sh) => sh.onIds.includes(sh.assignments.gk))).toBe(true);
  });

  it("pulls the only eligible keeper back on when rolling would strand the role", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], { Ava: ["gk"] });
    const s = buildSchedule(players, [gk], cfg({ maxSwaps: 4 }));
    // Ava is the sole keeper; feasibility keeps her on court and in goal every shift
    expect(s.shifts.every((sh) => sh.onIds.includes("ava"))).toBe(true);
    expect(s.shifts.every((sh) => sh.assignments.gk === "ava")).toBe(true);
  });

  it("keeps the keeper on court through the first sub (they come off last)", () => {
    const s = buildSchedule(six, [gk], cfg({ maxSwaps: 1 }));
    const starterGk = s.shifts[0].assignments.gk;
    // the starting keeper is not the first player rotated off
    expect(s.shifts[1].onIds).toContain(starterGk);
    // an outfield starter is the one who comes off instead
    const cameOff = s.shifts[0].onIds.filter((id) => !s.shifts[1].onIds.includes(id));
    expect(cameOff).not.toContain(starterGk);
  });

  it("leaves a role unfilled under rolling subs when nobody is eligible", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"]);
    const s = buildSchedule(players, [gk], cfg({ maxSwaps: 1 }));
    expect(s.shifts.every((sh) => sh.assignments.gk === undefined)).toBe(true);
  });

  it("frees a court slot to re-place a stranded role under rolling subs", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan"], {
      Ava: ["def"],
      Ben: ["def"],
      Cai: ["gk"],
    });
    const positions: Position[] = [
      { id: "def", name: "Def", cadence: "game", isGoalkeeper: false },
      { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true },
    ];
    const s = buildSchedule(players, positions, cfg({ fieldSize: 2, maxSwaps: 1 }));
    // one slot is locked to the game-long Def; the keeper (only Cai) is always
    // re-placed into the other slot even after rolling would drop her
    expect(s.shifts.every((sh) => sh.assignments.gk === "cai")).toBe(true);
    expect(s.shifts.every((sh) => sh.onIds.includes("cai"))).toBe(true);
  });

  it("cannot free a court slot for a role when the court is all locked holders", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai"], { Ava: ["fix"], Ben: ["gk"] });
    const positions: Position[] = [
      { id: "fix", name: "Fix", cadence: "game", isGoalkeeper: false },
      { id: "gk", name: "GK", cadence: "shift", isGoalkeeper: true },
    ];
    const s = buildSchedule(players, positions, cfg({ fieldSize: 1, maxSwaps: 1 }));
    // only one court slot, held for the whole game by Ava; GK can never be placed
    expect(s.shifts.every((sh) => sh.assignments.fix === "ava")).toBe(true);
    expect(s.shifts.every((sh) => sh.assignments.gk === undefined)).toBe(true);
  });

  it("picks the least-played eligible keeper when re-placing a stranded role", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai"], { Ava: ["gk"], Ben: ["gk"] });
    const positions: Position[] = [
      gk,
      { id: "def", name: "Def", cadence: "game", isGoalkeeper: false },
    ];
    const s = buildSchedule(players, positions, cfg({ fieldSize: 1, maxSwaps: 1 }));
    // a single court slot: every shift still has a keeper, drawn from both eligible players
    expect(s.shifts.every((sh) => sh.assignments.gk !== undefined)).toBe(true);
    expect(new Set(s.shifts.map((sh) => sh.assignments.gk)).size).toBe(2);
  });

  it("locks a half-cadence keeper on court for the whole half despite rolling subs", () => {
    const players = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
      Ava: ["gk"],
      Ben: ["gk"],
    });
    const halfGk: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(players, [halfGk], cfg({ maxSwaps: 1 }));
    const half0 = s.shifts.filter((sh) => sh.half === 0);
    const keeper = half0[0].assignments.gk;
    expect(half0.every((sh) => sh.onIds.includes(keeper))).toBe(true);
    expect(half0.every((sh) => sh.assignments.gk === keeper)).toBe(true);
  });
});
