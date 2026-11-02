import { describe, it, expect } from "vitest";
import {
  advanceOneSecond,
  currentShift,
  nextShift,
  roleMap,
  keeperId,
  orderedCourt,
  subPlan,
  pendingSubs,
  confirmSub,
  confirmAllSubs,
  undoLastSub,
  rebalanceForNextHalf,
  playedTotals,
  startStints,
  stintLeft,
  dueIds,
  dueRows,
  nextDueSec,
  benchOrder,
  suggestIncoming,
  roleHandover,
  swapPlayers,
  hasTenureRole,
} from "./game";
import type { Shift } from "./types";
import { buildSchedule, buildStintPlan } from "./rotation";
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

  it("advanceOneSecond holds the line-up when a shift with subs comes due", () => {
    const g = makeGame({ elapsedSec: 149, manualShift: 0 });
    const before = [...currentShift(g).onIds];
    const r = advanceOneSecond(g);
    expect(g.elapsedSec).toBe(150);
    expect(r).toEqual({ shiftAdvanced: false, subDue: true, halfEnded: false });
    expect(g.manualShift).toBe(0);
    expect(currentShift(g).onIds).toEqual(before);
    // still held (and no repeat "due" cue) while the sub is overdue
    const late = advanceOneSecond(g);
    expect(late).toEqual({ shiftAdvanced: false, subDue: false, halfEnded: false });
    expect(g.manualShift).toBe(0);
  });

  it("advanceOneSecond moves on by itself when the next shift needs no subs", () => {
    const g = makeGame({ elapsedSec: 149, manualShift: 0 });
    const [s0, s1] = g.schedule.shifts;
    s1.onIds = [...s0.onIds];
    s1.assignments = { ...s0.assignments };
    const r = advanceOneSecond(g);
    expect(r).toEqual({ shiftAdvanced: true, subDue: false, halfEnded: false });
    expect(g.manualShift).toBe(1);
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
    expect(r).toEqual({ shiftAdvanced: false, subDue: false, halfEnded: false });
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
    expect(rows).toEqual([{ offId: "a", onId: "e", tag: "GK", posId: "gk" }]);
  });

  it("shows a pure role swap between players already on court", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "c", "d"], { gk: "b" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "a", onId: "b", tag: "GK", posId: "gk" }]);
  });

  it("pairs plain substitutions by order when there are no positions", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["a", "b", "e", "f"], {}),
      [],
    );
    expect(rows).toEqual([
      { offId: "c", onId: "e", tag: null, posId: null },
      { offId: "d", onId: "f", tag: null, posId: null },
    ]);
  });

  it("tags a newly filled role even when nobody held it before", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["b", "c", "d", "e"], { gk: "e" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: "a", onId: "e", tag: "GK", posId: "gk" }]);
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
    expect(rows).toEqual([{ offId: "d", onId: "e", tag: "GK", posId: "gk" }]);
  });

  it("shows a role first assigned to a player already on court", () => {
    const rows = subPlan(
      shift(["a", "b", "c", "d"], {}),
      shift(["a", "b", "c", "d"], { gk: "a" }),
      [gk],
    );
    expect(rows).toEqual([{ offId: null, onId: "a", tag: "GK", posId: "gk" }]);
  });

  it("keeps a role swap plus a separate straight sub distinct", () => {
    // GK swaps from a to b (both stay on); c comes off for e
    const rows = subPlan(
      shift(["a", "b", "c", "d"], { gk: "a" }),
      shift(["a", "b", "d", "e"], { gk: "b" }),
      [gk],
    );
    expect(rows).toContainEqual({ offId: "a", onId: "b", tag: "GK", posId: "gk" });
    expect(rows).toContainEqual({ offId: "c", onId: "e", tag: null, posId: null });
    expect(rows).toHaveLength(2);
  });
});

/** A game whose clock has run to the first sub (due at 150s) and then some. */
function overdueGame(late = 40): LiveGame {
  const g = makeGame({ manualShift: 0, elapsedSec: 150 + late });
  return g;
}

describe("playing time is banked live", () => {
  it("ticks court and position seconds for whoever is on court", () => {
    const g = makeGame({ elapsedSec: 0 });
    const sh = currentShift(g);
    advanceOneSecond(g);
    advanceOneSecond(g);
    const keeper = keeperId(sh, g.positions) as string;
    expect(g.played![keeper]).toEqual({ fieldSec: 2, posSec: { gk: 2 } });
    const bench = sh.restingIds[0];
    expect(g.played![bench]).toBeUndefined();
    const outfield = sh.onIds.find((id) => id !== keeper) as string;
    expect(g.played![outfield]).toEqual({ fieldSec: 2, posSec: {} });
  });
});

describe("confirming subs", () => {
  it("pendingSubs is empty on the last shift of a half", () => {
    const g = makeGame({ manualShift: 3 });
    expect(pendingSubs(g)).toEqual([]);
  });

  it("confirming the only sub starts the next shift now, for the full set length", () => {
    const g = overdueGame(40); // sub made 40s late, at 190s
    const rows = pendingSubs(g);
    const next = nextShift(g)!;
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => confirmSub(g, r));
    expect(g.manualShift).toBe(next.idx);
    const [s0, s1, s2, s3] = g.schedule.shifts;
    expect(s0.endSec).toBe(190);
    expect(s0.durSec).toBe(190);
    // the new line-up gets its full 2:30, and the half's last shift is the short one
    expect([s1.startSec, s1.endSec]).toEqual([190, 340]);
    expect([s2.startSec, s2.endSec]).toEqual([340, 490]);
    expect([s3.startSec, s3.endSec]).toEqual([490, 600]);
    expect(s3.carryOverSec).toBe(40);
    // ...which resumes after the break with the same players
    const resumed = g.schedule.shifts.find((s) => s.half === 1)!;
    expect(resumed).toMatchObject({ carry: true, startSec: 0, endSec: 40 });
    expect(resumed.onIds.sort()).toEqual([...s3.onIds].sort());
    expect(g.schedule.shifts.filter((s) => s.half === 0)).toHaveLength(4);
  });

  it("applies one sub at a time, keeping the rest pending and the shift open", () => {
    const players4 = Array.from({ length: 6 }, (_, i) => ({
      id: "p" + i,
      name: "P" + i,
      positionIds: [] as string[],
    }));
    const c: GameConfig = { ...cfg, maxSwaps: 2 };
    const schedule = buildSchedule(players4, [], c);
    const g = makeGame({ players: players4, positions: [], cfg: c, schedule, elapsedSec: 160 });
    const rows = pendingSubs(g);
    expect(rows).toHaveLength(2);
    const startOn = [...currentShift(g).onIds];

    confirmSub(g, rows[0]);
    expect(g.manualShift).toBe(0); // second sub still outstanding
    const sh = currentShift(g);
    expect(sh.onIds).toContain(rows[0].onId);
    expect(sh.onIds).not.toContain(rows[0].offId);
    expect(sh.restingIds).toContain(rows[0].offId);
    expect(sh.restingIds).not.toContain(rows[0].onId);
    expect(sh.onIds).toHaveLength(startOn.length);
    const remaining = pendingSubs(g);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].onId).toBe(rows[1].onId);

    confirmSub(g, remaining[0]);
    expect(g.manualShift).toBe(1);
  });

  it("hands the keeper role over with the sub and drops the outgoing keeper's role", () => {
    const g = overdueGame();
    const sh = currentShift(g);
    const oldKeeper = keeperId(sh, g.positions) as string;
    const newKeeper = keeperId(nextShift(g)!, g.positions) as string;
    const row = pendingSubs(g).find((r) => r.tag === "GK")!;
    expect(row.onId).toBe(newKeeper);
    confirmSub(g, row);
    const done = g.schedule.shifts[0];
    expect(done.assignments.gk).toBe(newKeeper);
    expect(Object.values(done.assignments)).not.toContain(oldKeeper);
  });

  it("confirmAllSubs does every pending sub and moves on", () => {
    const g = overdueGame();
    const next = nextShift(g)!;
    confirmAllSubs(g);
    expect(g.manualShift).toBe(next.idx);
    expect(g.schedule.shifts[0].onIds.length).toBe(4);
  });

  it("confirmAllSubs does nothing when no subs are pending", () => {
    const g = makeGame({ manualShift: 3 });
    const before = JSON.stringify(g);
    confirmAllSubs(g);
    expect(JSON.stringify(g)).toBe(before);
  });

  it("a role swap between players already on court is applied without moving anyone", () => {
    const g = makeGame();
    const [s0, s1] = g.schedule.shifts;
    const [a, b] = s0.onIds;
    s0.assignments = { gk: a };
    s1.onIds = [...s0.onIds];
    s1.assignments = { gk: b };
    const [row] = pendingSubs(g);
    expect(row).toMatchObject({ offId: a, onId: b, tag: "GK" });
    const on = [...s0.onIds];
    confirmSub(g, row);
    expect(g.schedule.shifts[0].onIds).toEqual(on);
    expect(g.schedule.shifts[0].assignments.gk).toBe(b);
  });

  it("squeezes a very late sub into a single final shift", () => {
    const g = overdueGame();
    g.elapsedSec = 590; // only 10s left in the half
    confirmAllSubs(g);
    const half0 = g.schedule.shifts.filter((s) => s.half === 0);
    expect(half0).toHaveLength(2);
    expect(half0[1].startSec).toBe(590);
    expect(half0[1].endSec).toBe(600);
    expect(half0[1].carryOverSec).toBe(140);
    expect(g.manualShift).toBe(half0[1].idx);
  });

  it("clamps the clock into the half when confirming at the very end", () => {
    const g = overdueGame();
    g.elapsedSec = 9999;
    confirmAllSubs(g);
    // the half is over, so the new line-up starts the next half for a full shift
    expect(currentShift(g)).toMatchObject({ startSec: 600, endSec: 600, carryOverSec: 150 });
    expect(g.schedule.shifts.find((s) => s.half === 1)).toMatchObject({
      carry: true,
      startSec: 0,
      endSec: 150,
    });
  });

  it("confirming after the end of the last half leaves nothing to resume", () => {
    const g = overdueGame();
    g.currentHalf = 1;
    g.manualShift = 4;
    g.schedule = buildSchedule(players, [gk], cfg);
    g.elapsedSec = 9999;
    confirmAllSubs(g);
    expect(currentShift(g).carryOverSec).toBeUndefined();
    expect(g.schedule.shifts.at(-1)!.idx).toBe(g.manualShift);
  });

  it("does not let a sub start before its own shift did", () => {
    const g = makeGame({ manualShift: 1, elapsedSec: 100 }); // clock behind shift 1 (150s)
    confirmAllSubs(g);
    expect(currentShift(g).startSec).toBe(150);
  });

  it("keeps court time within a shift or so across a whole game of late subs", () => {
    const g = makeGame({ elapsedSec: 0 });
    for (let half = 0; half < g.cfg.halves; half++) {
      while (g.elapsedSec < g.cfg.halfLength * 60) {
        advanceOneSecond(g);
        // every sub is made 45s after it was due
        if (pendingSubs(g).length && g.elapsedSec >= currentShift(g).endSec + 45) confirmAllSubs(g);
      }
      if (half + 1 < g.cfg.halves) {
        rebalanceForNextHalf(g);
        g.currentHalf += 1;
        g.elapsedSec = 0;
        g.manualShift = g.schedule.shifts.find((s) => s.half === g.currentHalf)!.idx;
      }
    }
    const secs = playedTotals(g).map((t) => t.fieldSec);
    expect(secs.reduce((a, b) => a + b, 0)).toBe(4 * 2 * 600);
    const longest = Math.max(...g.schedule.shifts.map((s) => s.endSec - s.startSec));
    expect(Math.max(...secs) - Math.min(...secs)).toBeLessThanOrEqual(longest);
  });
});

describe("undoing a sub", () => {
  it("restores the court, schedule and played time from before the sub", () => {
    const g = overdueGame();
    const before = JSON.stringify({
      schedule: g.schedule,
      manualShift: g.manualShift,
      played: g.played,
    });
    confirmAllSubs(g);
    expect(g.manualShift).toBe(1);
    expect(undoLastSub(g)).toBe(true);
    expect(JSON.stringify({ schedule: g.schedule, manualShift: g.manualShift, played: g.played })).toBe(
      before,
    );
    expect(g.undoSub).toBeUndefined();
  });

  it("does nothing when there is no sub to undo", () => {
    expect(undoLastSub(makeGame())).toBe(false);
  });
});

describe("ending a half with subs outstanding", () => {
  it("drops the unplayed shifts and rebuilds the next half from time actually played", () => {
    const g = overdueGame(0);
    // the first sub never got made; the half ends with shift 0 still on court
    g.elapsedSec = 600;
    g.played = {};
    currentShift(g).onIds.forEach((id) => (g.played![id] = { fieldSec: 600, posSec: {} }));
    rebalanceForNextHalf(g);
    const half0 = g.schedule.shifts.filter((s) => s.half === 0);
    expect(half0).toHaveLength(1);
    expect(half0[0].endSec).toBe(600);
    const half1 = g.schedule.shifts.filter((s) => s.half === 1);
    expect(half1).toHaveLength(4);
    expect(half1[0].idx).toBe(1);
    // the players who sat out the whole first half start the second half on
    const sat = currentShift(g).restingIds;
    expect(half1[0].onIds).toEqual(expect.arrayContaining(sat));
    expect(g.undoSub).toBeUndefined();
  });

  it("keeps the planned end of the last shift when the half is ended early", () => {
    const g = makeGame({ manualShift: 3, elapsedSec: 400 });
    rebalanceForNextHalf(g);
    expect(currentShift(g).endSec).toBe(600);
  });
});

describe("playedTotals", () => {
  it("falls back to the plan when nothing has been played", () => {
    const g = makeGame();
    expect(playedTotals(g)).toBe(g.schedule.totals);
  });

  it("reports actual seconds, with positions only when held", () => {
    const g = makeGame();
    g.played = { ava: { fieldSec: 300, posSec: { gk: 120, none: 0 } }, ben: { fieldSec: 90, posSec: {} } };
    const t = playedTotals(g);
    const ava = t.find((x) => x.id === "ava")!;
    expect(ava).toMatchObject({ fieldSec: 300, posSec: { gk: 120 }, gameSec: 1200, restSec: 900 });
    expect(t.find((x) => x.id === "ben")!.posSec).toEqual({});
    expect(t.find((x) => x.id === "fin")!.fieldSec).toBe(0);
  });

  it("never reports negative rest", () => {
    const g = makeGame();
    g.played = { ava: { fieldSec: 5000, posSec: {} } };
    expect(playedTotals(g).find((x) => x.id === "ava")!.restSec).toBe(0);
  });
});

describe("timer per player", () => {
  const stintCfg: GameConfig = { ...cfg, shiftLength: 3, perPlayer: true };
  function stintGame(over: Partial<LiveGame> = {}, positions: Position[] = [gk]): LiveGame {
    const schedule = buildStintPlan(players, positions, stintCfg);
    const g = makeGame({ cfg: stintCfg, positions, schedule, running: true, ...over });
    startStints(g);
    return g;
  }
  const bench = (g: LiveGame): string[] => currentShift(g).restingIds;
  const court = (g: LiveGame): string[] => currentShift(g).onIds;

  it("plans the starting line-up with one shift per half and an even estimate", () => {
    const sch = buildStintPlan(players, [gk], stintCfg);
    expect(sch.shifts).toHaveLength(2);
    expect(sch.shifts.map((x) => x.half)).toEqual([0, 1]);
    expect(sch.totals.every((t) => t.fieldSec === 800 && t.restSec === 400 && t.gameSec === 1200)).toBe(true);
  });

  it("staggers the stints so subs come one at a time, keeper last", () => {
    const g = stintGame();
    const kid = keeperId(currentShift(g), g.positions) as string;
    const left = court(g)
      .map((id) => stintLeft(g, id))
      .sort((a, b) => a - b);
    expect(left).toEqual([45, 90, 135, 180]);
    expect(stintLeft(g, kid)).toBe(180);
    expect(g.timers![bench(g)[0]]).toBe(0);
  });

  it("holds off the first sub for the configured minimum, spreading the rest to a full stint", () => {
    const g = stintGame({ cfg: { ...stintCfg, firstStint: 2 } }); // 2:00 of a 3:00 stint
    const left = court(g)
      .map((id) => stintLeft(g, id))
      .sort((a, b) => a - b);
    expect(left).toEqual([120, 140, 160, 180]);
    expect(nextDueSec(g)).toBe(120);
  });

  it("never starts the first sub later than a full stint", () => {
    const g = stintGame({ cfg: { ...stintCfg, firstStint: 10 } });
    expect(court(g).map((id) => stintLeft(g, id))).toEqual([180, 180, 180, 180]);
  });

  it("starts a lone on-court player on a full stint", () => {
    const g = stintGame({ cfg: { ...stintCfg, fieldSize: 1 } });
    const sh = currentShift(g);
    sh.restingIds = [...sh.onIds.slice(1), ...sh.restingIds];
    sh.onIds = sh.onIds.slice(0, 1);
    sh.assignments = {};
    startStints(g);
    expect(stintLeft(g, sh.onIds[0])).toBe(180);
  });

  it("gives half- and game-long role holders no stint", () => {
    const gameGk: Position = { ...gk, cadence: "game" };
    const g = stintGame({}, [gameGk]);
    const kid = keeperId(currentShift(g), g.positions) as string;
    expect(hasTenureRole(g, kid)).toBe(true);
    expect(hasTenureRole(g, court(g).find((id) => id !== kid) as string)).toBe(false);
    const left = court(g)
      .filter((id) => id !== kid)
      .map((id) => stintLeft(g, id))
      .sort((a, b) => a - b);
    expect(left).toEqual([60, 120, 180]);
    g.timers![kid] = 9999;
    expect(dueIds(g)).toEqual([]);
  });

  it("ticks every timer and flags the second a stint runs out", () => {
    const g = stintGame();
    g.elapsedSec = 0;
    let due = false;
    let ticks = 0;
    while (!due && ticks < 100) {
      due = advanceOneSecond(g).subDue;
      ticks++;
    }
    expect(ticks).toBe(45);
    expect(g.manualShift).toBe(0); // no shifts in this mode
    expect(dueIds(g)).toHaveLength(1);
    expect(nextDueSec(g)).toBe(0);
    expect(advanceOneSecond(g).subDue).toBe(false); // overdue, but only cued once
    expect(nextDueSec(g)).toBe(-1);
    expect(g.timers![bench(g)[0]]).toBe(46);
    expect(g.played![court(g)[0]].fieldSec).toBe(46);
  });

  it("ends the half as usual", () => {
    const g = stintGame({ elapsedSec: 599 });
    const r = advanceOneSecond(g);
    expect(r).toEqual({ shiftAdvanced: false, subDue: false, halfEnded: true });
    expect(g.running).toBe(false);
  });

  it("ticks timers for a game saved without them", () => {
    const g = stintGame();
    delete g.timers;
    advanceOneSecond(g);
    expect(g.timers![court(g)[0]]).toBe(1);
    expect(stintLeft(makeGame({ cfg: stintCfg }), "ava")).toBe(180);
  });

  it("suggests the bench player with the least court time, then the longest rested", () => {
    const g = stintGame();
    const [b1, b2] = bench(g);
    g.played = { [b1]: { fieldSec: 120, posSec: {} }, [b2]: { fieldSec: 60, posSec: {} } };
    expect(benchOrder(g)).toEqual([b2, b1]);
    expect(suggestIncoming(g, court(g)[0])).toBe(b2);
    expect(suggestIncoming(g, court(g)[0], [b2])).toBe(b1);
    g.played = {};
    g.timers![b2] = 50;
    expect(benchOrder(g)).toEqual([b2, b1]); // rested longest
    g.timers![b2] = 0;
    expect(benchOrder(g)).toEqual([b1, b2]); // otherwise bench order
  });

  it("orders the bench before anyone has played or any timers exist", () => {
    const g = stintGame();
    delete g.played;
    delete g.timers;
    expect(benchOrder(g)).toEqual(bench(g));
    g.played = {};
    expect(benchOrder(g)).toEqual(bench(g));
  });

  it("brings an eligible keeper on when nobody else on court can take over", () => {
    const g = stintGame();
    const sh = currentShift(g);
    sh.onIds = ["ava", "ben", "cai", "dan"];
    sh.restingIds = ["eli", "fin"];
    sh.assignments = { gk: "ava" };
    // only Ava (on court) and Fin (benched) can keep goal; Fin has played the most
    g.players = g.players.map((p) => ({ ...p, positionIds: p.id === "ava" || p.id === "fin" ? ["gk"] : [] }));
    g.played = { fin: { fieldSec: 900, posSec: {} } };
    expect(benchOrder(g)).toEqual(["eli", "fin"]);
    expect(suggestIncoming(g, "ava")).toBe("fin");
    // an eligible player already on court covers the role: fairest bench player instead
    g.players = g.players.map((p) => (p.id === "ben" ? { ...p, positionIds: ["gk"] } : p));
    expect(suggestIncoming(g, "ava")).toBe("eli");
    // no eligible bench player to bring on: fairest bench player as well
    g.players = g.players.map((p) => ({ ...p, positionIds: p.id === "ava" ? ["gk"] : [] }));
    expect(suggestIncoming(g, "ava")).toBe("eli");
  });

  it("pairs each due player with a different bench player and tags role handovers", () => {
    const g = stintGame();
    const sh = currentShift(g);
    const kid = keeperId(sh, g.positions) as string;
    court(g).forEach((id) => (g.timers![id] = 9999));
    const rows = dueRows(g);
    expect(rows).toHaveLength(2); // only two on the bench
    expect(new Set(rows.map((r) => r.onId)).size).toBe(2);
    expect(rows.every((r) => bench(g).includes(r.onId as string))).toBe(true);
    const kRow = rows.find((r) => r.offId === kid);
    if (kRow) expect(kRow).toMatchObject({ tag: "GK", posId: "gk" });
    expect(rows.some((r) => r.tag === null) || rows.every((r) => r.tag !== null)).toBe(true);
  });

  it("has nothing due without a bench, and no countdown", () => {
    const g = stintGame();
    const sh = currentShift(g);
    sh.onIds = [...sh.onIds, ...sh.restingIds];
    sh.restingIds = [];
    court(g).forEach((id) => (g.timers![id] = 9999));
    expect(dueIds(g)).toEqual([]);
    expect(nextDueSec(g)).toBeNull();
    // a bench but only role holders on court: also nothing to count down
    const gameGk: Position = { ...gk, cadence: "game" };
    const h = stintGame({}, [gameGk]);
    const hs = currentShift(h);
    const kid = keeperId(hs, h.positions) as string;
    hs.restingIds = [...hs.onIds.filter((id) => id !== kid), ...hs.restingIds];
    hs.onIds = [kid];
    expect(nextDueSec(h)).toBeNull();
  });

  it("stops pairing when the bench runs out", () => {
    const g = stintGame();
    court(g).forEach((id) => (g.timers![id] = 9999));
    const sh = currentShift(g);
    expect(dueRows(g).length).toBeLessThanOrEqual(sh.restingIds.length);
    const spy = { ...g };
    spy.schedule = JSON.parse(JSON.stringify(g.schedule));
    // no one left to suggest: bench empties between due players
    expect(suggestIncoming(spy, court(spy)[0], bench(spy))).toBeNull();
  });

  it("swaps two players, restarts their timers and gives the role to an eligible incoming player", () => {
    const g = stintGame();
    const sh = currentShift(g);
    const kid = keeperId(sh, g.positions) as string;
    const incomingKeeper = bench(g).find((id) => g.players.find((p) => p.id === id)!.positionIds.includes("gk"));
    const inId = incomingKeeper ?? bench(g)[0];
    expect(swapPlayers(g, kid, inId)).toBe(true);
    expect(court(g)).toContain(inId);
    expect(court(g)).not.toContain(kid);
    expect(bench(g)).toContain(kid);
    expect(stintLeft(g, inId)).toBe(180);
    expect(g.timers![kid]).toBe(0);
    if (incomingKeeper) expect(sh.assignments.gk).toBe(inId);
    expect(g.undoSub).toBeDefined();
    expect(undoLastSub(g)).toBe(true);
    expect(court(g)).toContain(kid);
    expect(currentShift(g).assignments.gk).toBe(kid);
  });

  it("leaves a role vacant, or hands it to an on-court player, when the incoming player cannot play it", () => {
    const g = stintGame();
    const sh = currentShift(g);
    const kid = keeperId(sh, g.positions) as string;
    g.players = g.players.map((p) => ({ ...p, positionIds: ["gk"] }));
    const noGk = bench(g)[0];
    g.players = g.players.map((p) => (p.id === noGk ? { ...p, positionIds: [] } : p));
    expect(roleHandover(g, kid, noGk)).toMatchObject({ posId: "gk" });
    expect(roleHandover(g, kid, noGk)!.candidates.sort()).toEqual(court(g).filter((id) => id !== kid).sort());
    const vacant = JSON.parse(JSON.stringify(g)) as LiveGame;
    expect(swapPlayers(vacant, kid, noGk)).toBe(true);
    expect(currentShift(vacant).assignments.gk).toBeUndefined();
    const other = court(g).find((id) => id !== kid) as string;
    expect(swapPlayers(g, kid, noGk, other)).toBe(true);
    expect(sh.assignments.gk).toBe(other);
    // an explicit "nobody", and a target who is not on court, both leave it empty
    const none = JSON.parse(JSON.stringify(vacant)) as LiveGame;
    undoLastSub(none);
    expect(swapPlayers(none, kid, noGk, null)).toBe(true);
    expect(currentShift(none).assignments.gk).toBeUndefined();
    const off = JSON.parse(JSON.stringify(vacant)) as LiveGame;
    undoLastSub(off);
    expect(swapPlayers(off, kid, noGk, bench(off)[1])).toBe(true);
    expect(currentShift(off).assignments.gk).toBeUndefined();
  });

  it("plain swaps need no role decision, and bad swaps are refused", () => {
    const g = stintGame();
    const sh = currentShift(g);
    const kid = keeperId(sh, g.positions) as string;
    const plain = court(g).find((id) => id !== kid) as string;
    expect(roleHandover(g, plain, bench(g)[0])).toBeNull();
    expect(swapPlayers(g, plain, bench(g)[0])).toBe(true);
    const before = JSON.stringify(g);
    expect(swapPlayers(g, bench(g)[0], bench(g)[1])).toBe(false); // out is not on court
    expect(swapPlayers(g, court(g)[0], court(g)[1])).toBe(false); // in is not on the bench
    expect(JSON.stringify(g)).toBe(before);
    // eligible incoming player: nothing to ask either
    const k2 = stintGame();
    const eligible = bench(k2).find((id) => k2.players.find((p) => p.id === id)!.positionIds.includes("gk"));
    if (eligible) expect(roleHandover(k2, keeperId(currentShift(k2), k2.positions) as string, eligible)).toBeNull();
  });

  it("swaps with no timers recorded yet", () => {
    const g = stintGame();
    delete g.timers;
    expect(swapPlayers(g, court(g)[0], bench(g)[0])).toBe(true);
    expect(g.timers![bench(g)[0]]).toBe(0);
  });

  it("carries the court into the next half and passes a half-long role on", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const g = stintGame({}, [halfGk]);
    const cur = currentShift(g);
    const kid = keeperId(cur, g.positions) as string;
    g.played = { [kid]: { fieldSec: 600, posSec: { gk: 600 } } };
    // make every court player eligible so someone else can take over
    g.players = g.players.map((p) => ({ ...p, positionIds: ["gk"] }));
    rebalanceForNextHalf(g);
    const next = g.schedule.shifts.find((s) => s.half === 1)!;
    expect(next.carry).toBe(true);
    expect(next.onIds).toEqual(cur.onIds);
    expect(next.restingIds).toEqual(cur.restingIds);
    expect(next.assignments.gk).toBeDefined();
    expect(next.assignments.gk).not.toBe(kid);
    expect(g.undoSub).toBeUndefined();
  });

  it("keeps a half-long keeper when nobody else on court can take over", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const g = stintGame({}, [halfGk]);
    const cur = currentShift(g);
    const kid = keeperId(cur, g.positions) as string;
    g.players = g.players.map((p) => ({ ...p, positionIds: p.id === kid ? ["gk"] : [] }));
    rebalanceForNextHalf(g);
    expect(g.schedule.shifts.find((s) => s.half === 1)!.assignments.gk).toBe(kid);
  });

  it("leaves a vacant half-long role alone when nobody on court can fill it", () => {
    const halfGk: Position = { ...gk, cadence: "half" };
    const g = stintGame({}, [halfGk]);
    g.players = g.players.map((p) => ({ ...p, positionIds: [] }));
    currentShift(g).assignments = {};
    rebalanceForNextHalf(g);
    expect(g.schedule.shifts.find((s) => s.half === 1)!.assignments.gk).toBeUndefined();
  });
});
