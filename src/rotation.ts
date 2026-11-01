import type {
  GameConfig,
  PlayerTotals,
  Position,
  Schedule,
  SchedulePlayer,
  Shift,
} from "./types";

interface Skeleton {
  idx: number;
  half: number;
  startSec: number;
  endSec: number;
  dur: number;
}

const CADENCE_ORDER: Record<Position["cadence"], number> = {
  game: 0,
  half: 1,
  shift: 2,
};

/** Small deterministic PRNG so a given seed always yields the same shuffle. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seeded random rank per player, used to break equal-time ties. Because it is
 * a full shuffle (not a cyclic offset), each seed gives a genuinely different
 * arrangement, so pressing "Build" / "Reshuffle" varies who starts and who gets
 * the unavoidable extra shift.
 */
function shuffledRanks(
  players: SchedulePlayer[],
  seed: number,
): Record<string, number> {
  const rand = mulberry32(seed);
  const order = players.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const rank: Record<string, number> = {};
  players.forEach((p, i) => (rank[p.id] = order[i]));
  return rank;
}

/**
 * Build a fair shift-by-shift schedule with dynamic positions.
 *
 * Fairness rules, in priority order:
 *  1. Court time is split as evenly as mathematically possible: each shift the
 *     players with the least accumulated court time take the free slots.
 *  2. Each defined position is filled by an eligible player, pinned on court
 *     for the length of their tenure (shift / half / game). Positions rotate
 *     among their eligible players by least time-in-that-position, so keeping
 *     (or any fixed role) is shared fairly.
 *
 * `cfg.seed` rotates equal-time tie-breaks so "Reshuffle" varies who gets the
 * unavoidable extra shift or role stint.
 */
export function buildSchedule(
  players: SchedulePlayer[],
  positions: Position[],
  cfg: GameConfig,
): Schedule {
  const f = Math.min(cfg.fieldSize, players.length);

  const field: Record<string, number> = {};
  const lastOn: Record<string, number> = {};
  const posTime: Record<string, Record<string, number>> = {};
  players.forEach((p) => {
    field[p.id] = 0;
    lastOn[p.id] = -999;
    posTime[p.id] = {};
    positions.forEach((pos) => (posTime[p.id][pos.id] = 0));
  });

  const rank = shuffledRanks(players, cfg.seed || 0);

  // Time skeleton: shift boundaries per half.
  const skeleton: Skeleton[] = [];
  const lastIdxOfHalf: number[] = [];
  const shiftLenSec = Math.max(30, cfg.shiftLength * 60);
  let idx = 0;
  for (let h = 0; h < cfg.halves; h++) {
    const halfSec = cfg.halfLength * 60;
    const nShifts = Math.max(1, Math.round(halfSec / shiftLenSec));
    const seg = halfSec / nShifts;
    for (let s = 0; s < nShifts; s++) {
      skeleton.push({
        idx,
        half: h,
        startSec: Math.round(s * seg),
        endSec: Math.round((s + 1) * seg),
        dur: seg,
      });
      idx++;
    }
    lastIdxOfHalf[h] = idx - 1;
  }
  const lastIdx = idx - 1;

  // Longer-cadence roles claim players first so shorter ones fill around them.
  const posOrder = positions
    .map((p, i) => ({ p, i }))
    .sort((a, b) => CADENCE_ORDER[a.p.cadence] - CADENCE_ORDER[b.p.cadence] || a.i - b.i)
    .map((x) => x.p);

  const eligibleIds: Record<string, Set<string>> = {};
  positions.forEach((pos) => {
    eligibleIds[pos.id] = new Set(
      players.filter((p) => p.positionIds.includes(pos.id)).map((p) => p.id),
    );
  });

  const holders: Record<string, { playerId: string; endIdx: number }> = {};
  const shifts: Shift[] = [];
  const endIdxFor = (pos: Position, sk: Skeleton): number =>
    pos.cadence === "shift"
      ? sk.idx
      : pos.cadence === "half"
        ? lastIdxOfHalf[sk.half]
        : lastIdx;

  // Assign each position to an on-court player (persistent holders kept while
  // their tenure lasts; otherwise the eligible on-court player with least time
  // in the role). Mutates `pinned`/`assignments`/`holders`.
  const assignPositions = (
    sk: Skeleton,
    onCourt: Set<string>,
    candidatePool: string[],
    pinned: Set<string>,
    assignments: Record<string, string>,
  ): void => {
    for (const pos of posOrder) {
      if (pinned.size >= f) break; // no court room left for more roles
      let h = holders[pos.id];
      const stillValid =
        h &&
        h.endIdx >= sk.idx &&
        eligibleIds[pos.id].has(h.playerId) &&
        onCourt.has(h.playerId) &&
        !pinned.has(h.playerId);
      if (!stillValid) {
        const cands = candidatePool
          .filter((id) => eligibleIds[pos.id].has(id) && !pinned.has(id))
          .sort(
            (a, b) =>
              posTime[a][pos.id] - posTime[b][pos.id] ||
              field[a] - field[b] ||
              rank[a] - rank[b],
          );
        if (!cands.length) continue; // role goes unfilled this shift
        h = { playerId: cands[0], endIdx: endIdxFor(pos, sk) };
        holders[pos.id] = h;
      }
      assignments[pos.id] = h.playerId;
      pinned.add(h.playerId);
    }
  };

  const gameSec = cfg.halves * cfg.halfLength * 60;
  const buildTotals = (): PlayerTotals[] =>
    players.map((p) => {
      const posSec: Record<string, number> = {};
      positions.forEach((pos) => {
        const t = Math.round(posTime[p.id][pos.id]);
        if (t > 0) posSec[pos.id] = t;
      });
      const fieldSec = Math.round(field[p.id]);
      return { id: p.id, name: p.name, fieldSec, posSec, gameSec, restSec: gameSec - fieldSec };
    });

  const swapLimit = cfg.maxSwaps && cfg.maxSwaps >= 1 ? cfg.maxSwaps : 0;

  // A rolling game with only per-shift roles rotates as a clean circular
  // conveyor: a fixed (shuffled) order where each shift the window slides by the
  // swap count, so the front players roll off and new ones enter at the back as
  // keeper. This is inherently even, and the keeper (newest, at the back) is
  // never the one subbed off, so no balancing is needed.
  // Conveyor only when every player can fill every role, so the newest player
  // in the window can always take the keeper slot.
  const allEligible = positions.every((pos) =>
    players.every((p) => p.positionIds.includes(pos.id)),
  );
  const conveyor =
    swapLimit >= 1 && allEligible && positions.every((p) => p.cadence === "shift");
  if (conveyor) {
    const orderIds = [...players]
      .sort((a, b) => rank[a.id] - rank[b.id])
      .map((p) => p.id);
    const nn = orderIds.length;
    const step = Math.min(swapLimit, nn - f); // never roll more than the bench
    for (const sk of skeleton) {
      const start = step > 0 ? (sk.idx * step) % nn : 0;
      const onIds: string[] = [];
      for (let i = 0; i < f; i++) onIds.push(orderIds[(start + i) % nn]);
      const onSet = new Set(onIds);
      const assignments: Record<string, string> = {};
      // roles go to the newest players (back of the window); the keeper ends up
      // last in the display and is never the one rolled off next.
      posOrder.slice(0, f).forEach((pos, k) => {
        assignments[pos.id] = onIds[f - 1 - k];
      });
      onIds.forEach((id) => (field[id] += sk.dur));
      for (const posId in assignments) posTime[assignments[posId]][posId] += sk.dur;
      shifts.push({
        idx: sk.idx,
        half: sk.half,
        startSec: sk.startSec,
        endSec: sk.endSec,
        durSec: Math.round(sk.dur),
        onIds,
        restingIds: orderIds.filter((id) => !onSet.has(id)),
        assignments,
      });
    }
    return { shifts, totals: buildTotals(), fieldSize: f, positions };
  }

  let prevOn: Set<string> | null = null;

  for (const sk of skeleton) {
    const pinned = new Set<string>();
    const assignments: Record<string, string> = {};
    let onIds: string[];

    if (swapLimit && prevOn) {
      // ---- rolling substitutions: change at most `swapLimit` players ----
      // players locked on court by an active half/game role
      const carry = new Set<string>();
      for (const pos of posOrder) {
        const h = holders[pos.id];
        if (
          h &&
          pos.cadence !== "shift" &&
          h.endIdx >= sk.idx &&
          eligibleIds[pos.id].has(h.playerId)
        ) {
          carry.add(h.playerId);
        }
      }
      // Players holding a role last shift (e.g. the keeper) come off last, so
      // the outfield rotates around them rather than pulling them first.
      const heldPrev = new Set(
        Object.values(shifts[shifts.length - 1].assignments),
      );
      const on = new Set(prevOn);
      const comingOn = players
        .filter((p) => !on.has(p.id))
        .sort(
          (a, b) =>
            field[a.id] - field[b.id] ||
            lastOn[a.id] - lastOn[b.id] ||
            rank[a.id] - rank[b.id],
        );
      const comingOff = players
        .filter((p) => on.has(p.id) && !carry.has(p.id))
        .sort(
          (a, b) =>
            (heldPrev.has(a.id) ? 1 : 0) - (heldPrev.has(b.id) ? 1 : 0) ||
            field[b.id] - field[a.id] ||
            lastOn[a.id] - lastOn[b.id] ||
            rank[a.id] - rank[b.id],
        );
      const swaps = Math.min(swapLimit, comingOn.length, comingOff.length);
      for (let i = 0; i < swaps; i++) {
        on.delete(comingOff[i].id);
        on.add(comingOn[i].id);
      }
      // guarantee each position still has an eligible player on court
      for (const pos of posOrder) {
        if ([...on].some((id) => eligibleIds[pos.id].has(id))) continue;
        const incoming = players
          .filter((p) => eligibleIds[pos.id].has(p.id) && !on.has(p.id))
          .sort((a, b) => field[a.id] - field[b.id] || rank[a.id] - rank[b.id])[0];
        const outgoing = players
          .filter((p) => on.has(p.id) && !carry.has(p.id))
          .sort((a, b) => field[b.id] - field[a.id] || rank[a.id] - rank[b.id])[0];
        if (incoming && outgoing) {
          on.delete(outgoing.id);
          on.add(incoming.id);
        }
      }
      onIds = players.filter((p) => on.has(p.id)).map((p) => p.id);
      assignPositions(sk, on, onIds, pinned, assignments);
    } else {
      // ---- fair independent pick (default): least court time each shift ----
      for (const pos of posOrder) {
        if (pinned.size >= f) break;
        let h = holders[pos.id];
        const stillValid =
          h &&
          h.endIdx >= sk.idx &&
          eligibleIds[pos.id].has(h.playerId) &&
          !pinned.has(h.playerId);
        if (!stillValid) {
          const cands = players.filter(
            (p) => eligibleIds[pos.id].has(p.id) && !pinned.has(p.id),
          );
          if (!cands.length) continue;
          cands.sort(
            (a, b) =>
              posTime[a.id][pos.id] - posTime[b.id][pos.id] ||
              field[a.id] - field[b.id] ||
              rank[a.id] - rank[b.id],
          );
          h = { playerId: cands[0].id, endIdx: endIdxFor(pos, sk) };
          holders[pos.id] = h;
        }
        assignments[pos.id] = h.playerId;
        pinned.add(h.playerId);
      }
      const need = f - pinned.size;
      const generic = players
        .filter((p) => !pinned.has(p.id))
        .sort(
          (a, b) =>
            field[a.id] - field[b.id] ||
            lastOn[a.id] - lastOn[b.id] ||
            rank[a.id] - rank[b.id],
        )
        .slice(0, Math.max(0, need));
      onIds = [...pinned, ...generic.map((p) => p.id)];
    }

    const restingIds = players
      .filter((p) => !onIds.includes(p.id))
      .map((p) => p.id);

    onIds.forEach((id) => {
      field[id] += sk.dur;
      lastOn[id] = sk.idx;
    });
    for (const posId in assignments) {
      posTime[assignments[posId]][posId] += sk.dur;
    }

    shifts.push({
      idx: sk.idx,
      half: sk.half,
      startSec: sk.startSec,
      endSec: sk.endSec,
      durSec: Math.round(sk.dur),
      onIds,
      restingIds,
      assignments,
    });
    prevOn = new Set(onIds);
  }

  // Balance court time (non-rolling). The greedy pick plus pinning a keeper on
  // court each shift can leave one player a shift high and another low even when
  // an even split exists (e.g. 7 players, 4 on court, 56 slots = 8 each). Swap
  // an over-played outfield player off for an under-played benched one until the
  // spread is at most a single shift. Roles are never moved. (Rolling games use
  // the conveyor above, or accept a small gap when a persistent role pins one.)
  if (!swapLimit) {
    const durByIdx: Record<number, number> = {};
    skeleton.forEach((sk) => (durByIdx[sk.idx] = sk.dur));
    const slots: Record<string, number> = {};
    players.forEach((p) => (slots[p.id] = 0));
    shifts.forEach((sh) => sh.onIds.forEach((id) => slots[id]++));
    const holdsRole = (sh: Shift, id: string): boolean =>
      Object.values(sh.assignments).includes(id);

    const guard = players.length * shifts.length + 1;
    for (let iter = 0; iter < guard; iter++) {
      const ids = players.map((p) => p.id);
      const hi = Math.max(...ids.map((id) => slots[id]));
      const lo = Math.min(...ids.map((id) => slots[id]));
      if (hi - lo <= 1) break;
      let swapped = false;
      for (const over of players) {
        if (slots[over.id] !== hi) continue;
        for (const sh of shifts) {
          if (!sh.onIds.includes(over.id) || holdsRole(sh, over.id)) continue;
          const under = sh.restingIds
            .filter((id) => slots[id] < slots[over.id] - 1)
            .sort((a, b) => slots[a] - slots[b])[0];
          if (under) {
            sh.onIds = sh.onIds.filter((id) => id !== over.id).concat(under);
            sh.restingIds = sh.restingIds.filter((id) => id !== under).concat(over.id);
            slots[over.id]--;
            slots[under]++;
            swapped = true;
            break;
          }
        }
        if (swapped) break;
      }
      if (!swapped) break;
    }
    players.forEach((p) => (field[p.id] = 0));
    shifts.forEach((sh) => sh.onIds.forEach((id) => (field[id] += durByIdx[sh.idx])));
  }

  return { shifts, totals: buildTotals(), fieldSize: f, positions };
}
