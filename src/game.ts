import type { LiveGame, Position, Shift } from "./types";

/** Shifts belonging to the game's current half. */
function currentHalfShifts(game: LiveGame): Shift[] {
  return game.schedule.shifts.filter((s) => s.half === game.currentHalf);
}

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

/** Which shift index the clock is inside, given the current half + elapsed. */
export function shiftIndexForElapsed(game: LiveGame): number | null {
  const shifts = currentHalfShifts(game);
  if (!shifts.length) return null;
  for (const s of shifts) {
    if (game.elapsedSec < s.endSec) return s.idx;
  }
  return shifts[shifts.length - 1].idx;
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
      rows.push({ offId: off, onId: after, tag: pos.name });
      offIds = offIds.filter((id) => id !== off);
      onIds = onIds.filter((id) => id !== after);
    } else {
      // a role swap between players already on court (no substitution)
      rows.push({ offId: before ?? null, onId: after, tag: pos.name });
    }
  }

  offIds.forEach((id, i) => rows.push({ offId: id, onId: onIds[i], tag: null }));
  return rows;
}

export interface TickResult {
  shiftAdvanced: boolean;
  halfEnded: boolean;
}

/**
 * Advance the game clock by one second, mutating `game`. Returns whether a
 * shift boundary was crossed and/or the half ended (for buzzer/UI cues).
 * The caller is responsible for only calling this while the clock runs.
 */
export function advanceOneSecond(game: LiveGame): TickResult {
  const halfSec = game.cfg.halfLength * 60;
  game.elapsedSec += 1;
  let shiftAdvanced = false;
  let halfEnded = false;

  const gi = shiftIndexForElapsed(game);
  if (gi !== null && gi !== game.manualShift) {
    game.manualShift = gi;
    shiftAdvanced = true;
  }
  if (game.elapsedSec >= halfSec) {
    game.elapsedSec = halfSec;
    game.running = false;
    halfEnded = true;
  }
  return { shiftAdvanced, halfEnded };
}
