import { buildSchedule } from "./rotation";
import type { SchedulePlayer } from "./types";

/**
 * Suggest the fairest sub interval for a given squad.
 *
 * Court time is fairest when the total number of player-slots (players on court
 * summed over every shift) divides evenly among the present players. We try
 * every sub interval on a 10-second grid (30 seconds up), build the real rotation for each
 * (shifts run for exactly the interval, with a shorter one wherever a half or
 * the game ends) and read off the resulting court-time spread, then pick the
 * interval that is as fair as possible while keeping the cadence comfortable
 * (near ~2.5 min) rather than chasing tiny, chaotic shifts.
 */
export interface ShiftSuggestion {
  shiftLength: number; // minutes, on the 10s grid, to drop into the config
  shiftsPerHalf: number;
  perfectlyFair: boolean;
  minCourtSec: number;
  maxCourtSec: number;
  fairShareSec: number;
  noSubsNeeded: boolean; // present <= court size: everyone plays the whole game
}

const GRID_SEC = 10;
const TARGET_MIN = 2.5; // comfortable sub cadence
const TOLERANCE_SEC = 60; // treat intervals within a minute of the fairest as tied

interface Candidate {
  s: number;
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
  const squad: SchedulePlayer[] = Array.from({ length: n }, (_, i) => ({
    id: "p" + i,
    name: "P" + i,
    positionIds: [],
  }));

  const cands: Candidate[] = [];
  for (let sec = 30; sec <= halves * L * 60 + 1e-9; sec += GRID_SEC) {
    const s = sec / 60; // candidate interval on the 10s grid (never under 30s)
    const sch = buildSchedule(squad, [], {
      fieldSize: f,
      halves,
      halfLength: L,
      shiftLength: s,
      opponent: "",
      seed: 0,
    });
    const fields = sch.totals.map((t) => t.fieldSec);
    const minSec = Math.min(...fields);
    const maxSec = Math.max(...fields);
    cands.push({
      s,
      spread: maxSec - minSec,
      minSec,
      maxSec,
      perfect: maxSec - minSec <= 1,
    });
  }

  const minSpread = Math.min(...cands.map((c) => c.spread));
  const best = cands
    .filter((c) => c.spread <= minSpread + TOLERANCE_SEC)
    .sort(
      (a, b) =>
        Number(!a.perfect) - Number(!b.perfect) || // a perfectly even split wins a tie
        Math.round(Math.abs(a.s - TARGET_MIN) * 60) - Math.round(Math.abs(b.s - TARGET_MIN) * 60) ||
        b.s - a.s, // prefer fewer subs on a tie
    )[0];

  return {
    shiftLength: best.s,
    shiftsPerHalf: Math.ceil((L * 60) / (best.s * 60)),
    perfectlyFair: best.perfect,
    minCourtSec: best.minSec,
    maxCourtSec: best.maxSec,
    fairShareSec,
    noSubsNeeded: f >= n,
  };
}
