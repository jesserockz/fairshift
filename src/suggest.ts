/**
 * Suggest the fairest sub interval for a given squad.
 *
 * Court time is fairest when the total number of player-slots (players on court
 * summed over every shift) divides evenly among the present players. We search
 * every sub interval on a 30-second grid, compute the resulting court-time
 * spread, and pick the interval that is as fair as possible while keeping the
 * cadence comfortable (near ~2.5 min) rather than chasing tiny, chaotic shifts.
 *
 * Only intervals reachable on the 30s grid are considered, and the engine's own
 * rounding (`round(halfLength / interval)` shifts per half) is modelled exactly,
 * so the reported fairness is what the schedule will actually produce.
 */
export interface ShiftSuggestion {
  shiftLength: number; // minutes, on the 0.5 grid, to drop into the config
  shiftsPerHalf: number;
  perfectlyFair: boolean;
  minCourtSec: number;
  maxCourtSec: number;
  fairShareSec: number;
  noSubsNeeded: boolean; // present <= court size: everyone plays the whole game
}

const TARGET_MIN = 2.5; // comfortable sub cadence
const TOLERANCE_SEC = 60; // treat intervals within a minute of the fairest as tied

interface Candidate {
  s: number;
  k: number;
  shiftMin: number;
  spread: number;
  minSec: number;
  maxSec: number;
  perfect: boolean;
}

export function suggestShift(
  present: number,
  fieldSize: number,
  halves: number,
  halfLength: number,
): ShiftSuggestion | null {
  const n = Math.floor(present);
  const f = Math.min(Math.floor(fieldSize), n);
  const L = halfLength;
  if (n <= 0 || f <= 0 || halves <= 0 || L < 0.5) return null;

  const gameSec = halves * L * 60;
  const fairShareSec = (f * gameSec) / n;

  const cands: Candidate[] = [];
  for (let i = 1; i * 0.5 <= L + 1e-9; i++) {
    const s = i * 0.5; // candidate interval on the 30s grid
    const k = Math.max(1, Math.round(L / s)); // shifts per half the engine will use
    const shiftMin = L / k;
    const slots = f * halves * k;
    const base = Math.floor(slots / n);
    const rem = slots % n;
    const minSec = Math.round(base * shiftMin * 60);
    const maxSec = Math.round((rem > 0 ? base + 1 : base) * shiftMin * 60);
    cands.push({ s, k, shiftMin, spread: maxSec - minSec, minSec, maxSec, perfect: rem === 0 });
  }

  const minSpread = Math.min(...cands.map((c) => c.spread));
  const best = cands
    .filter((c) => c.spread <= minSpread + TOLERANCE_SEC)
    .sort(
      (a, b) =>
        Math.abs(a.shiftMin - TARGET_MIN) - Math.abs(b.shiftMin - TARGET_MIN) ||
        Math.abs(a.s - a.shiftMin) - Math.abs(b.s - b.shiftMin) || // honest display value
        b.shiftMin - a.shiftMin, // prefer fewer subs on a tie
    )[0];

  return {
    shiftLength: best.s,
    shiftsPerHalf: best.k,
    perfectlyFair: best.perfect,
    minCourtSec: best.minSec,
    maxCourtSec: best.maxSec,
    fairShareSec,
    noSubsNeeded: f >= n,
  };
}
