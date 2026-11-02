import { buildSchedule, planTimeline, shiftSeconds, type ResumeSeed, type Skeleton } from "./rotation";
import type { LiveGame, PlayerTotals, Position, Shift } from "./types";

/** The shift currently selected for display (manual override wins). */
export function currentShift(game: LiveGame): Shift {
  return (
    game.schedule.shifts.find((s) => s.idx === game.manualShift) ??
    game.schedule.shifts[0]
  );
}

export function nextShift(game: LiveGame): Shift | null {
  return (
    game.schedule.shifts.find((s) => s.idx === game.manualShift + 1) ?? null
  );
}

/** playerId -> position they hold on a shift (for role labels/highlights). */
export function roleMap(
  shift: Shift,
  positions: Position[],
): Record<string, Position> {
  const map: Record<string, Position> = {};
  positions.forEach((pos) => {
    const pid = shift.assignments[pos.id];
    if (pid) map[pid] = pos;
  });
  return map;
}

/**
 * Order a shift's on-court players for display: outfield players first, sorted
 * by who comes off soonest, and position holders (e.g. the keeper) placed last.
 * As shifts advance the leftmost player rolls off and the rest shift left, with
 * the keeper staying at the end.
 */
export function orderedCourt(
  shift: Shift,
  allShifts: Shift[],
  positions: Position[],
): string[] {
  const roles = roleMap(shift, positions);
  const later = allShifts.filter((s) => s.idx > shift.idx);
  const leavesAt = (id: string): number => {
    for (const ls of later) if (!ls.onIds.includes(id)) return ls.idx;
    return Infinity;
  };
  return [...shift.onIds].sort(
    (a, b) =>
      (roles[a] ? 1 : 0) - (roles[b] ? 1 : 0) ||
      leavesAt(a) - leavesAt(b) ||
      shift.onIds.indexOf(a) - shift.onIds.indexOf(b),
  );
}

/** The keeper on a shift (holder of the goalkeeper position), if any. */
export function keeperId(shift: Shift, positions: Position[]): string | null {
  const gk = positions.find((p) => p.isGoalkeeper);
  return gk ? (shift.assignments[gk.id] ?? null) : null;
}

/** One substitution row: player `offId` comes off for player `onId`. */
export interface SubRow {
  offId: string | null; // null when a role is newly filled with nobody leaving
  onId: string | null;
  tag: string | null; // position name when this row is a role handover
  posId: string | null; // the handed-over position's id (set with `tag`)
}

/**
 * Explicit off -> on pairing between two shifts. Role handovers (e.g. the
 * keeper changing) are paired and tagged first, so "who replaces whom" is
 * unambiguous; remaining straight swaps are paired up afterwards.
 */
export function subPlan(current: Shift, next: Shift, positions: Position[]): SubRow[] {
  let offIds = current.onIds.filter((id) => !next.onIds.includes(id));
  let onIds = next.onIds.filter((id) => !current.onIds.includes(id));
  const rows: SubRow[] = [];

  for (const pos of positions) {
    const before = current.assignments[pos.id];
    const after = next.assignments[pos.id];
    if (!after || after === before) continue;
    if (onIds.includes(after)) {
      // the new holder is subbing on; pair with the outgoing holder if they
      // left, otherwise with any player coming off (offIds is non-empty here
      // because on/off counts match: court size is constant within a half)
      const off = before && offIds.includes(before) ? before : offIds[0];
      rows.push({ offId: off, onId: after, tag: pos.name, posId: pos.id });
      offIds = offIds.filter((id) => id !== off);
      onIds = onIds.filter((id) => id !== after);
    } else {
      // a role swap between players already on court (no substitution)
      rows.push({ offId: before ?? null, onId: after, tag: pos.name, posId: pos.id });
    }
  }

  offIds.forEach((id, i) => rows.push({ offId: id, onId: onIds[i], tag: null, posId: null }));
  return rows;
}

export interface TickResult {
  shiftAdvanced: boolean; // a no-sub shift boundary passed on its own
  subDue: boolean; // a shift boundary with subs waiting on confirmation was just reached
  halfEnded: boolean;
}

/** Bank this second of court time for everyone currently on court. */
function tickPlayed(game: LiveGame): void {
  const sh = currentShift(game);
  const roles = roleMap(sh, game.positions);
  const played = (game.played ??= {});
  for (const id of sh.onIds) {
    const p = (played[id] ??= { fieldSec: 0, posSec: {} });
    p.fieldSec += 1;
    const role = roles[id];
    if (role) p.posSec[role.id] = (p.posSec[role.id] ?? 0) + 1;
  }
}

/**
 * The subs still to be made before the next shift: the difference between who
 * is actually on court now and the plan for the next shift. Empty on the last
 * shift of a half. As each sub is confirmed its row drops out of this list.
 */
export function pendingSubs(game: LiveGame): SubRow[] {
  const ns = nextShift(game);
  if (!ns || ns.half !== game.currentHalf) return [];
  return subPlan(currentShift(game), ns, game.positions);
}

/** Take a player out of whatever position they hold on a shift. */
function dropRoles(sh: Shift, pid: string): void {
  for (const k of Object.keys(sh.assignments)) {
    if (sh.assignments[k] === pid) delete sh.assignments[k];
  }
}

/** Make one sub on the current shift's actual court (and roles). */
function applySubRow(game: LiveGame, row: SubRow): void {
  const sh = currentShift(game);
  if (row.offId && row.onId && !sh.onIds.includes(row.onId)) {
    const [off, on] = [row.offId, row.onId];
    sh.onIds = sh.onIds.map((id) => (id === off ? on : id));
    sh.restingIds = sh.restingIds.map((id) => (id === on ? off : id));
    dropRoles(sh, off);
  }
  if (row.posId && row.onId) {
    dropRoles(sh, row.onId);
    sh.assignments[row.posId] = row.onId;
  }
}

function snapshotForUndo(game: LiveGame): void {
  game.undoSub = JSON.stringify({
    schedule: game.schedule,
    manualShift: game.manualShift,
    played: game.played,
    timers: game.timers,
  });
}

/** Restore the state from just before the last confirmed sub. False if none. */
export function undoLastSub(game: LiveGame): boolean {
  if (!game.undoSub) return false;
  const snap = JSON.parse(game.undoSub) as Pick<
    LiveGame,
    "schedule" | "manualShift" | "played" | "timers"
  >;
  game.schedule = snap.schedule;
  game.manualShift = snap.manualShift;
  game.played = snap.played;
  game.timers = snap.timers;
  game.undoSub = undefined;
  return true;
}

/** Seconds banked so far, plus `extra` for the shift about to be played in full. */
function bankedSeed(
  game: LiveGame,
  prev: Shift,
  extraSec: number,
  skeleton: Skeleton[],
): ResumeSeed {
  const fieldSec: Record<string, number> = {};
  const posSec: Record<string, Record<string, number>> = {};
  const roles = roleMap(prev, game.positions);
  for (const p of game.players) {
    const got = game.played?.[p.id];
    const on = prev.onIds.includes(p.id);
    fieldSec[p.id] = (got?.fieldSec ?? 0) + (on ? extraSec : 0);
    posSec[p.id] = { ...(got?.posSec ?? {}) };
    const role = roles[p.id];
    if (on && role) posSec[p.id][role.id] = (posSec[p.id][role.id] ?? 0) + extraSec;
  }
  return {
    skeleton,
    fieldSec,
    posSec,
    prev: { idx: prev.idx, half: prev.half, onIds: prev.onIds, assignments: prev.assignments },
  };
}

/**
 * All subs for the next shift are made: close the shift we were on at the
 * current clock time and start the next one now, running for the set shift
 * length (cut at the end of the half, resuming after the break). Every later
 * shift is rebuilt so total court time stays as even as possible given what
 * has really been played.
 */
function startNextShiftAndReplan(game: LiveGame): void {
  const cur = currentShift(game);
  const ns = nextShift(game) as Shift; // callers only get here with a sub pending
  const halfSec = game.cfg.halfLength * 60;
  const t = Math.min(halfSec, Math.max(cur.startSec, game.elapsedSec));
  const moreHalves = ns.half + 1 < game.cfg.halves;

  cur.endSec = t;
  cur.durSec = t - cur.startSec;

  let first: Skeleton;
  let rest: Skeleton[];
  if (t >= halfSec) {
    // the half is already over: this line-up takes the floor after the break
    const full = shiftSeconds(game.cfg);
    first = { idx: ns.idx, half: ns.half, startSec: halfSec, endSec: halfSec, dur: 0 };
    if (moreHalves) first.carryOverSec = full;
    rest = moreHalves ? planTimeline(game.cfg, ns.idx + 1, ns.half + 1, 0, full) : [];
  } else {
    [first, ...rest] = planTimeline(game.cfg, ns.idx, ns.half, t);
  }
  ns.startSec = first.startSec;
  ns.endSec = first.endSec;
  ns.durSec = first.endSec - first.startSec;
  if (first.carryOverSec) ns.carryOverSec = first.carryOverSec;
  else delete ns.carryOverSec;

  const rebuilt = buildSchedule(
    game.players,
    game.positions,
    game.cfg,
    bankedSeed(game, ns, ns.durSec, rest),
  );
  game.schedule = {
    ...rebuilt,
    shifts: [...game.schedule.shifts.filter((s) => s.idx <= ns.idx), ...rebuilt.shifts],
  };
  game.manualShift = ns.idx;
}

/** Confirm one pending sub. When it was the last one, move on to the next shift. */
export function confirmSub(game: LiveGame, row: SubRow): void {
  snapshotForUndo(game);
  applySubRow(game, row);
  if (!pendingSubs(game).length) startNextShiftAndReplan(game);
}

/** Confirm every pending sub at once ("Sub now"). */
export function confirmAllSubs(game: LiveGame): void {
  const rows = pendingSubs(game);
  if (!rows.length) return;
  snapshotForUndo(game);
  rows.forEach((row) => applySubRow(game, row));
  startNextShiftAndReplan(game);
}

/**
 * The half is over (or being ended early). Subs that never happened are dropped,
 * the shift in progress resumes in the next half, and everything after it is
 * rebuilt around the court time actually played.
 */
export function rebalanceForNextHalf(game: LiveGame): void {
  if (game.cfg.perPlayer) return carryLineupToNextHalf(game);
  const cur = currentShift(game);
  cur.endSec = Math.max(cur.endSec, game.elapsedSec);
  cur.durSec = cur.endSec - cur.startSec;
  // the shift in progress resumes after the break, with whoever is on court now
  const later = planTimeline(game.cfg, cur.idx + 1, game.currentHalf + 1, 0, cur.carryOverSec ?? 0);
  const rebuilt = buildSchedule(
    game.players,
    game.positions,
    game.cfg,
    bankedSeed(game, cur, 0, later),
  );
  game.schedule = {
    ...rebuilt,
    shifts: [...game.schedule.shifts.filter((s) => s.idx <= cur.idx), ...rebuilt.shifts],
  };
  game.undoSub = undefined;
}

// ---- timer per player ----

const stintLen = (game: LiveGame): number => shiftSeconds(game.cfg);
const canPlay = (game: LiveGame, id: string, posId: string): boolean =>
  game.players.some((p) => p.id === id && p.positionIds.includes(posId));

/** Holders of a half/game-long role stay on for that tenure, so have no stint. */
export function hasTenureRole(game: LiveGame, id: string): boolean {
  const role = roleMap(currentShift(game), game.positions)[id];
  return !!role && role.cadence !== "shift";
}

/**
 * Start everyone's timers. Players on court get staggered stints so their turns
 * come due one at a time, evenly spread: the first after the configured minimum
 * (by default a 1/n share of the stint) and the last after a full stint.
 */
export function startStints(game: LiveGame): void {
  const sh = currentShift(game);
  const roles = roleMap(sh, game.positions);
  const timers: Record<string, number> = {};
  game.players.forEach((p) => (timers[p.id] = 0));
  // role holders go last in the stagger; half/game-long ones have no stint at all
  const queue = [
    ...sh.onIds.filter((id) => !roles[id]),
    ...sh.onIds.filter((id) => roles[id]),
  ].filter((id) => !hasTenureRole(game, id));
  const full = stintLen(game);
  const first = game.cfg.firstStint
    ? Math.min(full, Math.round(game.cfg.firstStint * 60))
    : full / queue.length;
  queue.forEach((id, k) => {
    const due = queue.length > 1 ? first + ((full - first) * k) / (queue.length - 1) : full;
    timers[id] = full - Math.round(due);
  });
  game.timers = timers;
}

/** Seconds left on a player's stint (negative once overdue). */
export function stintLeft(game: LiveGame, id: string): number {
  return stintLen(game) - (game.timers?.[id] ?? 0);
}

/** On-court players whose stint is up and who have someone to be swapped for. */
export function dueIds(game: LiveGame): string[] {
  const sh = currentShift(game);
  if (!sh.restingIds.length) return [];
  return sh.onIds
    .filter((id) => !hasTenureRole(game, id) && stintLeft(game, id) <= 0)
    .sort((a, b) => stintLeft(game, a) - stintLeft(game, b));
}

/** Seconds until the next stint is up (negative if overdue); null if no sub can happen. */
export function nextDueSec(game: LiveGame): number | null {
  const sh = currentShift(game);
  if (!sh.restingIds.length) return null;
  const left = sh.onIds.filter((id) => !hasTenureRole(game, id)).map((id) => stintLeft(game, id));
  return left.length ? Math.min(...left) : null;
}

/** Bench in the order they should come on: least court time, then longest rested. */
export function benchOrder(game: LiveGame): string[] {
  const sh = currentShift(game);
  return sh.restingIds
    .map((id, i) => ({ id, i }))
    .sort(
      (a, b) =>
        (game.played?.[a.id]?.fieldSec ?? 0) - (game.played?.[b.id]?.fieldSec ?? 0) ||
        (game.timers?.[b.id] ?? 0) - (game.timers?.[a.id] ?? 0) ||
        a.i - b.i,
    )
    .map((x) => x.id);
}

/**
 * Who should replace `outId`: the fairest bench player, except that a position
 * nobody else on court can fill goes to an eligible bench player when there is
 * one. `taken` lists bench players already promised to someone else.
 */
export function suggestIncoming(game: LiveGame, outId: string, taken: string[] = []): string | null {
  const sh = currentShift(game);
  const bench = benchOrder(game).filter((id) => !taken.includes(id));
  const role = roleMap(sh, game.positions)[outId];
  if (role) {
    const covered = sh.onIds.some((id) => id !== outId && canPlay(game, id, role.id));
    const fits = bench.find((id) => canPlay(game, id, role.id));
    if (!covered && fits) return fits;
  }
  return bench[0] ?? null;
}

/** One "off -> on" row per player whose stint is up, each with a different bench player. */
export function dueRows(game: LiveGame): SubRow[] {
  const roles = roleMap(currentShift(game), game.positions);
  const taken: string[] = [];
  const rows: SubRow[] = [];
  for (const offId of dueIds(game)) {
    const onId = suggestIncoming(game, offId, taken);
    if (!onId) break;
    taken.push(onId);
    const role = roles[offId];
    rows.push({ offId, onId, tag: role?.name ?? null, posId: role?.id ?? null });
  }
  return rows;
}

/**
 * When a position holder comes off and the incoming player cannot fill it:
 * the position and the on-court players who could take it instead. Null when
 * there is no handover to decide (no role, or the incoming player is eligible).
 */
export function roleHandover(
  game: LiveGame,
  outId: string,
  inId: string,
): { posId: string; candidates: string[] } | null {
  const sh = currentShift(game);
  const role = roleMap(sh, game.positions)[outId];
  if (!role || canPlay(game, inId, role.id)) return null;
  return {
    posId: role.id,
    candidates: sh.onIds.filter((id) => id !== outId && canPlay(game, id, role.id)),
  };
}

/**
 * Swap an on-court player for one from the bench, now. The outgoing player's
 * position goes to the incoming player when they can fill it; otherwise to
 * `roleTo` (an on-court player, or null to leave it vacant). Both timers restart.
 * Returns false if the two are not on court / on the bench respectively.
 */
export function swapPlayers(
  game: LiveGame,
  outId: string,
  inId: string,
  roleTo?: string | null,
): boolean {
  const sh = currentShift(game);
  if (!sh.onIds.includes(outId) || !sh.restingIds.includes(inId)) return false;
  snapshotForUndo(game);
  const role = roleMap(sh, game.positions)[outId];
  sh.onIds = sh.onIds.map((id) => (id === outId ? inId : id));
  sh.restingIds = sh.restingIds.map((id) => (id === inId ? outId : id));
  dropRoles(sh, outId);
  if (role) {
    const target = roleTo === undefined ? (canPlay(game, inId, role.id) ? inId : null) : roleTo;
    if (target && sh.onIds.includes(target)) {
      dropRoles(sh, target);
      sh.assignments[role.id] = target;
    }
  }
  const timers = (game.timers ??= {});
  timers[outId] = 0;
  timers[inId] = 0;
  return true;
}

/**
 * Half time with a timer per player: the same players carry on, so the next
 * half's line-up is the court as it stands. A half-long position changes hands
 * to whoever on court has held it least.
 */
function carryLineupToNextHalf(game: LiveGame): void {
  const cur = currentShift(game);
  const next = game.schedule.shifts.find((s) => s.half === game.currentHalf + 1) as Shift;
  next.onIds = [...cur.onIds];
  next.restingIds = [...cur.restingIds];
  next.assignments = { ...cur.assignments };
  next.carry = true;
  for (const pos of game.positions.filter((p) => p.cadence === "half")) {
    const holder = next.assignments[pos.id];
    const best = next.onIds
      .filter((id) => canPlay(game, id, pos.id))
      .filter((id) => id === holder || !Object.values(next.assignments).includes(id))
      .sort((a, b) => (game.played?.[a]?.posSec[pos.id] ?? 0) - (game.played?.[b]?.posSec[pos.id] ?? 0))[0];
    if (best && best !== holder) {
      dropRoles(next, best);
      next.assignments[pos.id] = best;
    }
  }
  game.undoSub = undefined;
}

/** Per-player totals from the time actually played (planned totals if none yet). */
export function playedTotals(game: LiveGame): PlayerTotals[] {
  const gameSec = game.cfg.halves * game.cfg.halfLength * 60;
  const any = game.players.some((p) => (game.played?.[p.id]?.fieldSec ?? 0) > 0);
  if (!any) return game.schedule.totals;
  return game.players.map((p) => {
    const got = game.played?.[p.id];
    const fieldSec = got?.fieldSec ?? 0;
    const posSec: Record<string, number> = {};
    for (const [k, v] of Object.entries(got?.posSec ?? {})) if (v > 0) posSec[k] = v;
    return { id: p.id, name: p.name, fieldSec, posSec, gameSec, restSec: Math.max(0, gameSec - fieldSec) };
  });
}

/** Shift mode: move on by themselves through shifts that need no subs. */
function advanceShifts(game: LiveGame): { shiftAdvanced: boolean; subDue: boolean } {
  let shiftAdvanced = false;
  for (;;) {
    const cur = currentShift(game);
    const ns = nextShift(game);
    if (game.elapsedSec < cur.endSec || !ns || ns.half !== game.currentHalf) break;
    if (pendingSubs(game).length) return { shiftAdvanced, subDue: game.elapsedSec === cur.endSec };
    game.manualShift = ns.idx;
    shiftAdvanced = true;
  }
  return { shiftAdvanced, subDue: false };
}

/**
 * Advance the game clock by one second, mutating `game`. Court time is banked
 * for whoever is on court. The shift only moves on by itself when the next
 * shift needs no subs; otherwise the line-up stays exactly as it is until the
 * subs are confirmed, however late they are. With a timer per player there are
 * no shifts: each player's own timer runs and `subDue` fires when one is up.
 * The caller is responsible for only calling this while the clock runs.
 */
export function advanceOneSecond(game: LiveGame): TickResult {
  const halfSec = game.cfg.halfLength * 60;
  game.elapsedSec += 1;
  tickPlayed(game);
  let shiftAdvanced = false;
  let subDue = false;

  if (game.cfg.perPlayer) {
    const timers = (game.timers ??= {});
    game.players.forEach((p) => (timers[p.id] = (timers[p.id] ?? 0) + 1));
    subDue = dueIds(game).some((id) => stintLeft(game, id) === 0);
  } else {
    ({ shiftAdvanced, subDue } = advanceShifts(game));
  }

  let halfEnded = false;
  if (game.elapsedSec >= halfSec) {
    game.elapsedSec = halfSec;
    game.running = false;
    halfEnded = true;
  }
  return { shiftAdvanced, subDue, halfEnded };
}
