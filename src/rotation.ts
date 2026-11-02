import type {
  GameConfig,
  PlayerTotals,
  Position,
  Schedule,
  SchedulePlayer,
  Shift,
} from "./types";

export interface Skeleton {
  idx: number;
  half: number;
  startSec: number;
  endSec: number;
  dur: number;
  carry?: boolean; // continues the previous shift's line-up after the half break
  carryOverSec?: number; // time of this shift still to play after the half break
}

/** Seconds per shift, as set (never less than 30). */
export function shiftSeconds(cfg: GameConfig): number {
  return Math.max(30, Math.round(cfg.shiftLength * 60));
}

/**
 * Lay out shifts of exactly the set length, back to back, from `atSec` into
 * `half` to the end of the game. Nothing is stretched to fit: a shift that
 * would run past the end of a half is cut there and its remainder resumes at
 * the start of the next half (same line-up), and the final shift of the game
 * is simply whatever is left. `carrySec` is how much of an already running
 * shift is still owed at the start of the next half.
 */
export function planTimeline(
  cfg: GameConfig,
  firstIdx: number,
  half: number,
  atSec: number,
  carrySec = 0,
): Skeleton[] {
  const halfSec = cfg.halfLength * 60;
  const full = shiftSeconds(cfg);
  const out: Skeleton[] = [];
  let idx = firstIdx;
  let t = atSec;
  let owed = carrySec > 0 ? carrySec : full; // time left in the running shift
  let carry = carrySec > 0;
  for (let h = half; h < cfg.halves; h++) {
    while (t < halfSec - 1e-6) {
      const dur = Math.min(owed, halfSec - t);
      const sk: Skeleton = {
        idx: idx++,
        half: h,
        startSec: Math.round(t),
        endSec: Math.round(t + dur),
        dur,
      };
      if (carry) sk.carry = true;
      owed -= dur;
      t += dur;
      if (owed > 1e-6) {
        if (h + 1 < cfg.halves) sk.carryOverSec = owed; // resumes after the break
        carry = true;
      } else {
        owed = full;
        carry = false;
      }
      out.push(sk);
    }
    t = 0;
  }
  return out;
}

/**
 * Plan for a game with a timer per player: no shift grid, just the starting
 * line-up (one shift per half, only the first of which is used live) and an
 * even fair-share estimate, since who comes on next is decided as the game goes.
 */
export function buildStintPlan(
  players: SchedulePlayer[],
  positions: Position[],
  cfg: GameConfig,
): Schedule {
  const base = buildSchedule(players, positions, {
    ...cfg,
    shiftLength: cfg.halfLength,
    maxSwaps: 0,
  });
  const gameSec = cfg.halves * cfg.halfLength * 60;
  const fieldSec = Math.round((base.fieldSize * gameSec) / players.length);
  const totals = players.map((p) => ({
    id: p.id,
    name: p.name,
    fieldSec,
    posSec: {},
    gameSec,
    restSec: gameSec - fieldSec,
  }));
  return { ...base, totals };
}

/**
 * Mid-game state to carry into a rebuild: the shifts still to be planned, what
 * has actually been played so far, and the shift they follow on from.
 */
export interface ResumeSeed {
  skeleton: Skeleton[]; // the remaining shifts to plan (replaces the default grid)
  fieldSec: Record<string, number>; // court seconds already banked (or committed)
  posSec: Record<string, Record<string, number>>; // per-position seconds, likewise
  prev: { idx: number; half: number; onIds: string[]; assignments: Record<string, string> };
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
 *
 * With `resume`, only the remaining shifts are planned, starting from the given
 * court and counting the time already played, so a live game can be re-balanced
 * after subs ran late. Resumed plans always use the time-aware rolling pick
 * (never the fixed conveyor), since actual time no longer follows a fixed order.
 */
export function buildSchedule(
  players: SchedulePlayer[],
  positions: Position[],
  cfg: GameConfig,
  resume?: ResumeSeed,
): Schedule {
  const f = Math.min(cfg.fieldSize, players.length);

  const field: Record<string, number> = {};
  const lastOn: Record<string, number> = {};
  const posTime: Record<string, Record<string, number>> = {};
  players.forEach((p) => {
    field[p.id] = resume?.fieldSec[p.id] ?? 0;
    lastOn[p.id] = resume?.prev.onIds.includes(p.id) ? resume.prev.idx : -999;
    posTime[p.id] = {};
    positions.forEach((pos) => (posTime[p.id][pos.id] = resume?.posSec[p.id]?.[pos.id] ?? 0));
  });
  const startField: Record<string, number> = { ...field };

  const rank = shuffledRanks(players, cfg.seed || 0);

  // Time skeleton: shift boundaries per half.
  const skeleton: Skeleton[] = [];
  const lastIdxOfHalf: number[] = [];
  if (resume) {
    skeleton.push(...resume.skeleton);
    resume.skeleton.forEach((sk) => (lastIdxOfHalf[sk.half] = sk.idx));
  } else {
    skeleton.push(...planTimeline(cfg, 0, 0, 0));
    skeleton.forEach((sk) => (lastIdxOfHalf[sk.half] = sk.idx));
  }
  const lastIdx = resume
    ? Math.max(resume.prev.idx, ...resume.skeleton.map((sk) => sk.idx))
    : skeleton.length - 1;

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

  const carryFields = (sk: Skeleton): Pick<Shift, "carry" | "carryOverSec"> => ({
    ...(sk.carry ? { carry: true } : {}),
    ...(sk.carryOverSec ? { carryOverSec: sk.carryOverSec } : {}),
  });

  const holders: Record<string, { playerId: string; endIdx: number }> = {};
  const shifts: Shift[] = [];
  const endIdxFor = (pos: Position, sk: Skeleton): number =>
    pos.cadence === "shift"
      ? sk.idx
      : pos.cadence === "half"
        ? lastIdxOfHalf[sk.half]
        : lastIdx;

  // Resuming: whoever holds a half/game role now keeps it for the rest of its tenure.
  if (resume) {
    for (const pos of positions) {
      const pid = resume.prev.assignments[pos.id];
      if (!pid || pos.cadence === "shift") continue;
      holders[pos.id] = {
        playerId: pid,
        endIdx:
          pos.cadence === "game"
            ? lastIdx
            : (lastIdxOfHalf[resume.prev.half] ?? resume.prev.idx),
      };
    }
  }

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

  const skeletonDur: Record<number, number> = {};
  skeleton.forEach((sk) => (skeletonDur[sk.idx] = sk.dur));

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
    !resume && swapLimit >= 1 && allEligible && positions.every((p) => p.cadence === "shift");
  if (conveyor) {
    const orderIds = [...players]
      .sort((a, b) => rank[a.id] - rank[b.id])
      .map((p) => p.id);
    const nn = orderIds.length;
    const step = Math.min(swapLimit, nn - f); // never roll more than the bench
    let slot = -1; // a resumed (carry) shift keeps the window where it was
    for (const sk of skeleton) {
      if (!sk.carry) slot++;
      const start = step > 0 ? (slot * step) % nn : 0;
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
        ...carryFields(sk),
      });
    }
    return { shifts, totals: buildTotals(), fieldSize: f, positions };
  }

  let prevOn: Set<string> | null = resume ? new Set(resume.prev.onIds) : null;
  let prevAssignments: Record<string, string> = resume ? resume.prev.assignments : {};

  for (const sk of skeleton) {
    const pinned = new Set<string>();
    const assignments: Record<string, string> = {};
    let onIds: string[];

    if (sk.carry && prevOn) {
      // ---- resuming a shift after the half break: same players stay on ----
      onIds = [...prevOn];
      for (const pos of posOrder) {
        const h = holders[pos.id];
        // a per-shift (or game-long) role stays with its holder for the whole shift
        if (h && pos.cadence !== "half" && prevOn.has(h.playerId)) {
          h.endIdx = Math.max(h.endIdx, sk.idx);
        }
      }
      assignPositions(sk, prevOn, onIds, pinned, assignments);
    } else if (swapLimit && prevOn) {
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
      const heldPrev = new Set(Object.values(prevAssignments));
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
      ...carryFields(sk),
    });
    prevOn = new Set(onIds);
    prevAssignments = assignments;
  }

  // Balance court time (non-rolling). The greedy pick plus pinning a keeper on
  // court each shift can leave one player a shift high and another low even when
  // an even split exists (e.g. 7 players, 4 on court, 56 slots = 8 each). Swap
  // an over-played outfield player off for an under-played benched one until the
  // spread is at most a single shift. Roles are never moved. (Rolling games use
  // the conveyor above, or accept a small gap when a persistent role pins one.)
  if (!swapLimit) {
    // A shift resumed after the half break is the same line-up as the one before
    // it, so the two are balanced as a single block.
    const groups: Shift[][] = [];
    shifts.forEach((sh) => {
      if (sh.carry && groups.length) groups[groups.length - 1].push(sh);
      else groups.push([sh]);
    });
    const durOf = (g: Shift[]): number =>
      g.reduce((a, sh) => a + skeletonDur[sh.idx], 0);
    // Court seconds per player, starting from any time already banked. Compared
    // with a small tolerance so float shift lengths behave like whole slots.
    const eps = 1e-6;
    const secs: Record<string, number> = { ...startField };
    groups.forEach((g) => g[0].onIds.forEach((id) => (secs[id] += durOf(g))));
    const maxDur = Math.max(0, ...groups.map(durOf));
    const holdsRole = (g: Shift[], id: string): boolean =>
      g.some((sh) => Object.values(sh.assignments).includes(id));

    const guard = players.length * shifts.length + 1;
    for (let iter = 0; iter < guard; iter++) {
      const ids = players.map((p) => p.id);
      const hi = Math.max(...ids.map((id) => secs[id]));
      const lo = Math.min(...ids.map((id) => secs[id]));
      if (hi - lo <= maxDur + eps) break;
      let swapped = false;
      for (const over of players) {
        if (Math.abs(secs[over.id] - hi) > eps) continue;
        for (const g of groups) {
          if (!g[0].onIds.includes(over.id) || holdsRole(g, over.id)) continue;
          const d = durOf(g);
          const under = g[0].restingIds
            .filter((id) => secs[over.id] - secs[id] > d + eps)
            .sort((a, b) => secs[a] - secs[b])[0];
          if (under) {
            g.forEach((sh) => {
              sh.onIds = sh.onIds.filter((id) => id !== over.id).concat(under);
              sh.restingIds = sh.restingIds.filter((id) => id !== under).concat(over.id);
            });
            secs[over.id] -= d;
            secs[under] += d;
            swapped = true;
            break;
          }
        }
        if (swapped) break;
      }
      if (!swapped) break;
    }
    players.forEach((p) => (field[p.id] = secs[p.id]));
  }

  return { shifts, totals: buildTotals(), fieldSize: f, positions };
}
