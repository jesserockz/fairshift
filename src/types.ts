/** Domain types for FairShift. */

export type PositionCadence = "shift" | "half" | "game";

/**
 * A named on-court role (e.g. "GK", "Defender"). The holder is pinned on court
 * for the length of their tenure:
 *  - "shift": rolls with the subs (a new eligible holder every shift)
 *  - "half":  one holder stays in the role for the whole half
 *  - "game":  one holder stays in the role for the whole game
 * `isGoalkeeper` marks the role used for "goals conceded" attribution.
 */
export interface Position {
  id: string;
  name: string;
  cadence: PositionCadence;
  isGoalkeeper: boolean;
}

/** A player on a saved team roster. `present` is the "here today" flag. */
export interface Player {
  id: string;
  name: string;
  present: boolean;
  positionIds: string[]; // positions this player is eligible to fill
}

export interface Team {
  id: string;
  name: string;
  players: Player[];
  positions: Position[];
}

export interface GameConfig {
  fieldSize: number;
  halves: number;
  halfLength: number; // minutes
  shiftLength: number; // minutes between subs
  opponent: string;
  seed: number; // rotates equal-time tie-breaks so Reshuffle varies the plan
  // Max players swapped on/off court at each shift change. 0 = auto (change
  // whoever fairness dictates); >=1 = rolling subs of at most that many at once.
  maxSwaps?: number;
  // Timer per player: no synchronized shifts. `shiftLength` becomes each
  // player's stint on court, and subs are made one player at a time.
  perPlayer?: boolean;
  // Timer-per-player: minutes before the first sub can come due. 0 / unset =
  // automatic (1/n of the stint, so subs come one at a time from the start).
  firstStint?: number;
}

/** A player as captured into a plan/game (roster snapshot). */
export interface SchedulePlayer {
  id: string;
  name: string;
  positionIds: string[];
}

export interface Shift {
  idx: number;
  half: number;
  startSec: number;
  endSec: number;
  durSec: number;
  onIds: string[];
  restingIds: string[];
  assignments: Record<string, string>; // positionId -> playerId on this shift
  carry?: boolean; // resumes the previous shift's line-up after the half break
  carryOverSec?: number; // time of this shift still owed after the half break
}

export interface PlayerTotals {
  id: string;
  name: string;
  fieldSec: number;
  posSec: Record<string, number>; // positionId -> seconds held (only if > 0)
  gameSec: number;
  restSec: number;
}

export interface Schedule {
  shifts: Shift[];
  totals: PlayerTotals[];
  fieldSize: number;
  positions: Position[];
}

/** An unsaved, generated rotation plan awaiting kick-off. */
export interface Plan {
  teamId: string;
  teamName: string;
  cfg: GameConfig;
  players: SchedulePlayer[];
  positions: Position[];
  schedule: Schedule;
  createdAt: string;
}

export type GoalTeam = "us" | "them";

export interface GameEvent {
  id: string;
  kind: "goal";
  team: GoalTeam;
  scorerId: string | null; // our scorer (null for their goals / unknown)
  gkId: string | null; // keeper on court when the goal happened
  half: number;
  clock: number; // seconds into the half
  at: string; // ISO timestamp
}

/** Court time a player has actually banked in a live game. */
export interface PlayedTime {
  fieldSec: number;
  posSec: Record<string, number>; // positionId -> seconds held
}

/** A game in progress. Persisted so a refresh never loses data. */
export interface LiveGame {
  id: string;
  teamId: string;
  teamName: string;
  opponent: string;
  date: string;
  startedAt: string;
  cfg: GameConfig;
  players: SchedulePlayer[];
  positions: Position[];
  schedule: Schedule;
  currentHalf: number;
  elapsedSec: number;
  running: boolean;
  manualShift: number;
  events: GameEvent[];
  // Court time actually played, per player (ticked live). Absent on games saved
  // before it existed; treated as zero.
  played?: Record<string, PlayedTime>;
  // Per-player mode: seconds each player has spent in their current state
  // (on court, or on the bench) since their last sub.
  timers?: Record<string, number>;
  // JSON snapshot taken just before the last confirmed sub, for "Undo sub".
  undoSub?: string;
}

export interface FinishedGame extends LiveGame {
  finishedAt: string;
  result: { us: number; them: number };
}

export interface AppState {
  teams: Team[];
  currentTeamId: string | null;
  plan: Plan | null;
  live: LiveGame | null;
  games: FinishedGame[];
}

/**
 * A team as carried in a share link: no ids, no `present` flag, no history.
 * Players reference positions by index into `positions`.
 */
export interface SharedTeam {
  name: string;
  positions: { name: string; cadence: PositionCadence; isGoalkeeper: boolean }[];
  players: { name: string; positions: number[] }[];
}
