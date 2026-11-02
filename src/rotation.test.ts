import { describe, it, expect } from "vitest";
import { buildSchedule, planTimeline, shiftSeconds, type ResumeSeed, type Skeleton } from "./rotation";
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
    // 7 players, 4 on court, 1.5-min shifts in 10:30 halves => 14 shifts, 56 slots, 8 each.
    const s = buildSchedule(players, [gk], cfg({ halfLength: 10.5, shiftLength: 1.5, maxSwaps: 2 }));
    expect(new Set(s.totals.map((t) => t.fieldSec)).size).toBe(1);
    expect(diffs(s).every((d) => d <= 2)).toBe(true);
  });

  it("rolls as a clean conveyor: front player off, keeper newest and never subbed", () => {
    const names = ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin", "Gus"];
    const players = mkPlayers(names, Object.fromEntries(names.map((n) => [n, ["gk"]])));
    const s = buildSchedule(players, [gk], cfg({ halfLength: 10.5, shiftLength: 1.5, maxSwaps: 1 }));
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

describe("buildSchedule resuming mid-game", () => {
  const names = ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"];
  const players = mkPlayers(names);
  const sk = (idx: number, half: number, startSec: number, endSec: number): Skeleton => ({
    idx,
    half,
    startSec,
    endSec,
    dur: endSec - startSec,
  });
  const seed = (over: Partial<ResumeSeed> = {}): ResumeSeed => ({
    skeleton: [sk(1, 0, 150, 300), sk(2, 0, 300, 450), sk(3, 0, 450, 600)],
    fieldSec: {},
    posSec: {},
    prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: {} },
    ...over,
  });

  it("plans only the remaining shifts, numbered as given", () => {
    const s = buildSchedule(players, [], cfg(), seed());
    expect(s.shifts.map((x) => x.idx)).toEqual([1, 2, 3]);
    expect(s.shifts.every((x) => x.onIds.length === 4)).toBe(true);
  });

  it("sits out whoever has banked the most court time", () => {
    const s = buildSchedule(
      players,
      [],
      cfg(),
      seed({ fieldSec: { ava: 900, ben: 900, cai: 0, dan: 0, eli: 0, fin: 0 } }),
    );
    // Cai..Fin are far behind, so they fill the court while Ava and Ben rest
    expect(s.shifts[0].onIds.sort()).toEqual(["cai", "dan", "eli", "fin"]);
    // totals include the banked time: Ava and Ben rest on, the rest catch up
    const f = Object.fromEntries(s.totals.map((t) => [t.id, t.fieldSec]));
    expect(f).toEqual({ ava: 900, ben: 900, cai: 450, dan: 450, eli: 450, fin: 450 });
  });

  it("balances by seconds across unequal shift lengths", () => {
    const s = buildSchedule(
      players,
      [],
      cfg(),
      seed({
        skeleton: [sk(1, 0, 100, 180), sk(2, 0, 180, 400), sk(3, 0, 400, 600)],
        fieldSec: { ava: 400, ben: 0, cai: 0, dan: 0, eli: 0, fin: 0 },
      }),
    );
    const f = s.totals.map((t) => t.fieldSec);
    expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(220);
  });

  it("keeps a game-long keeper in goal through the rest of the game", () => {
    const gameGk: Position = { ...gk, cadence: "game" };
    const s = buildSchedule(mkPlayers(names, { Ava: ["gk"], Ben: ["gk"] }), [gameGk], cfg(), seed({
      prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: { gk: "ben" } },
    }));
    expect(s.shifts.map((x) => x.assignments.gk)).toEqual(["ben", "ben", "ben"]);
  });

  it("keeps a half-long keeper to the end of the half, then hands the role on", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(
      mkPlayers(names, { Ava: ["gk"], Ben: ["gk"] }),
      [halfGk],
      cfg(),
      seed({
        skeleton: [sk(1, 0, 150, 300), sk(2, 1, 0, 300)],
        prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: { gk: "ava" } },
      }),
    );
    expect(s.shifts[0].assignments.gk).toBe("ava");
    expect(s.shifts[1].assignments.gk).toBe("ben"); // Ben has the least keeper time
  });

  it("lets a half-long role lapse when the current half has no shifts left", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(
      mkPlayers(names, { Ava: ["gk"], Ben: ["gk"] }),
      [halfGk],
      cfg(),
      seed({
        skeleton: [sk(1, 1, 0, 300)],
        prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: { gk: "ava" } },
        posSec: { ava: { gk: 600 } },
      }),
    );
    expect(s.shifts[0].assignments.gk).toBe("ben");
  });

  it("ignores per-shift and vacant roles when seeding holders, and counts banked role time", () => {
    const halfGk: Position = { ...gk, id: "hgk", cadence: "half" };
    const s = buildSchedule(
      mkPlayers(names, { Ava: ["gk", "hgk"], Ben: ["gk", "hgk"] }),
      [gk, halfGk],
      cfg(),
      seed({
        // the per-shift keeper carries nothing over; the half role is vacant
        prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: { gk: "ava" } },
        posSec: { ava: { gk: 150 } },
      }),
    );
    expect(s.shifts[0].assignments.hgk).toBeDefined();
    const total = s.totals.find((t) => t.id === "ava")!;
    expect(total.posSec.gk).toBeGreaterThanOrEqual(150);
  });

  it("rolls from the current court rather than the fixed conveyor", () => {
    const s = buildSchedule(players, [gk], cfg({ maxSwaps: 1 }), seed({
      prev: { idx: 0, half: 0, onIds: ["ava", "ben", "cai", "dan"], assignments: { gk: "dan" } },
      fieldSec: { ava: 300, ben: 0, cai: 150, dan: 150, eli: 0, fin: 0 },
    }));
    const before = new Set(["ava", "ben", "cai", "dan"]);
    // at most one change per shift, and the keeper is the last to be rotated off
    expect(s.shifts[0].onIds.filter((id) => !before.has(id))).toHaveLength(1);
    expect(s.shifts[0].onIds).toContain("dan");
    expect(s.shifts[0].onIds).not.toContain("ava"); // most court time goes first
    s.shifts.forEach((x, i) => {
      const prev = new Set(i ? s.shifts[i - 1].onIds : before);
      expect(x.onIds.filter((id) => !prev.has(id)).length).toBeLessThanOrEqual(1);
    });
  });

  it("returns no shifts but full totals when nothing is left to play", () => {
    const s = buildSchedule(players, [], cfg(), seed({ skeleton: [], fieldSec: { ava: 600 } }));
    expect(s.shifts).toEqual([]);
    expect(s.totals.find((t) => t.id === "ava")!.fieldSec).toBe(600);
  });
});

describe("shift timeline", () => {
  const c = (over: Partial<GameConfig> = {}): GameConfig => cfg(over);
  const span = (t: Skeleton[]): string[] => t.map((x) => `${x.half}:${x.startSec}-${x.endSec}${x.carry ? "c" : ""}`);

  it("uses the set shift length exactly, with a shorter shift at the end", () => {
    expect(shiftSeconds(c({ shiftLength: 3 }))).toBe(180);
    const t = planTimeline(c({ halves: 1, shiftLength: 3 }), 0, 0, 0);
    expect(span(t)).toEqual(["0:0-180", "0:180-360", "0:360-540", "0:540-600"]);
  });

  it("never plans a shift under 30 seconds", () => {
    expect(shiftSeconds(c({ shiftLength: 0.1 }))).toBe(30);
  });

  it("resumes a shift cut by half time at the start of the next half", () => {
    const t = planTimeline(c({ shiftLength: 3 }), 0, 0, 0);
    expect(span(t)).toEqual([
      "0:0-180", "0:180-360", "0:360-540", "0:540-600",
      "1:0-120c", "1:120-300", "1:300-480", "1:480-600",
    ]);
    expect(t[3].carryOverSec).toBe(120);
    expect(t[4].carryOverSec).toBeUndefined();
    expect(t.map((x) => x.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("does not carry when a shift ends exactly on the half, nor after the last half", () => {
    const t = planTimeline(c({ shiftLength: 2.5 }), 0, 0, 0);
    expect(t).toHaveLength(8);
    expect(t.some((x) => x.carry || x.carryOverSec)).toBe(false);
    const last = planTimeline(c({ halves: 1, shiftLength: 4 }), 0, 0, 0);
    expect(span(last)).toEqual(["0:0-240", "0:240-480", "0:480-600"]);
    expect(last[2].carryOverSec).toBeUndefined();
  });

  it("starts mid-half and with a carried shift owed", () => {
    expect(span(planTimeline(c({ halves: 2, shiftLength: 3 }), 5, 0, 500))).toEqual([
      "0:500-600", "1:0-80c", "1:80-260", "1:260-440", "1:440-600",
    ]);
    const owed = planTimeline(c({ shiftLength: 3 }), 4, 1, 0, 120);
    expect(span(owed)[0]).toBe("1:0-120c");
    expect(owed[0].idx).toBe(4);
  });

  it("lets a shift longer than the half span the break", () => {
    const t = planTimeline(c({ shiftLength: 12 }), 0, 0, 0);
    expect(span(t)).toEqual(["0:0-600", "1:0-120c", "1:120-600"]);
    expect(t[0].carryOverSec).toBe(120);
  });

  it("returns nothing when asked to start past the last half", () => {
    expect(planTimeline(c(), 9, 2, 0)).toEqual([]);
  });
});

describe("buildSchedule with a shift resumed after half time", () => {
  const six = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"], {
    Ava: ["gk"],
    Ben: ["gk"],
    Cai: ["gk"],
  });
  const c3 = cfg({ shiftLength: 3 });

  it("keeps the same players (and per-shift keeper) across the break", () => {
    const s = buildSchedule(six, [gk], c3);
    const cut = s.shifts[3];
    const resumed = s.shifts[4];
    expect(cut.carryOverSec).toBe(120);
    expect(resumed.carry).toBe(true);
    expect(resumed.onIds.sort()).toEqual([...cut.onIds].sort());
    expect(resumed.restingIds.sort()).toEqual([...cut.restingIds].sort());
    expect(resumed.assignments).toEqual(cut.assignments);
    // the keeper then changes for the next real shift
    expect(s.shifts[5].carry).toBeUndefined();
  });

  it("splits court time to within one shift despite the short shifts", () => {
    const s = buildSchedule(six, [gk], c3);
    const f = s.totals.map((t) => t.fieldSec);
    expect(total(s.totals)).toBe(4 * 1200);
    expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(180);
  });

  it("changes a per-half keeper in place at the break", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const s = buildSchedule(six, [halfGk], c3);
    const cut = s.shifts[3];
    const resumed = s.shifts[4];
    expect(resumed.onIds.sort()).toEqual([...cut.onIds].sort());
    expect(resumed.assignments.gk).not.toBe(cut.assignments.gk);
    expect(resumed.onIds).toContain(resumed.assignments.gk);
  });

  it("keeps a game-long keeper through the break", () => {
    const gameGk: Position = { ...gk, cadence: "game" };
    const s = buildSchedule(six, [gameGk], c3);
    expect(new Set(s.shifts.map((x) => x.assignments.gk)).size).toBe(1);
  });

  it("keeps the conveyor window still through the break", () => {
    const all = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin", "Gus"], {
      Ava: ["gk"], Ben: ["gk"], Cai: ["gk"], Dan: ["gk"], Eli: ["gk"], Fin: ["gk"], Gus: ["gk"],
    });
    const s = buildSchedule(all, [gk], cfg({ shiftLength: 3, maxSwaps: 1 }));
    expect(s.shifts[4].carry).toBe(true);
    expect(s.shifts[4].onIds).toEqual(s.shifts[3].onIds);
    expect(s.shifts[4].assignments).toEqual(s.shifts[3].assignments);
    expect(s.shifts[5].onIds).not.toEqual(s.shifts[4].onIds);
  });

  it("holds the rolling line-up through the break too", () => {
    const s = buildSchedule(six, [gk], cfg({ shiftLength: 3, maxSwaps: 1 }));
    const cut = s.shifts.find((x) => x.carryOverSec)!;
    const resumed = s.shifts[cut.idx + 1];
    expect(resumed.onIds.sort()).toEqual([...cut.onIds].sort());
  });

  it("rebalances a resumed shift together with the one it continues", () => {
    // 7 players, shifts that leave a short remainder: the two halves of a cut
    // shift must always have identical line-ups after balancing
    const seven = mkPlayers(["Ava", "Ben", "Cai", "Dan", "Eli", "Fin", "Gus"]);
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const s = buildSchedule(seven, [], cfg({ shiftLength: 3, seed }));
      s.shifts.forEach((x, i) => {
        if (x.carry) expect(x.onIds.sort()).toEqual([...s.shifts[i - 1].onIds].sort());
      });
      const f = s.totals.map((t) => t.fieldSec);
      expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(180);
    }
  });
});
