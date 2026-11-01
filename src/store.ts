import type {
  AppState,
  FinishedGame,
  GameConfig,
  GoalTeam,
  LiveGame,
  Player,
  Position,
  PositionCadence,
  SharedTeam,
  Team,
} from "./types";
import { uid, todayStr } from "./format";
import { buildSchedule } from "./rotation";
import { countGoals } from "./stats";
import { currentShift, keeperId } from "./game";

export const LS_KEY = "fairshift.v1";

export function defaultState(): AppState {
  return { teams: [], currentTeamId: null, plan: null, live: null, games: [] };
}

/** A fresh state seeded with one team that has a default per-shift GK. */
export function seedState(): AppState {
  const s = defaultState();
  const gk: Position = {
    id: uid(),
    name: "GK",
    cadence: "shift",
    isGoalkeeper: true,
  };
  const t: Team = { id: uid(), name: "My Team", players: [], positions: [gk] };
  s.teams.push(t);
  s.currentTeamId = t.id;
  return s;
}

/** `name`, or `name (2)`, `name (3)`... - the first not already used (case-insensitive). */
export function uniqueTeamName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
  return candidate;
}

type Listener = () => void;

/**
 * Single source of truth. Owns all domain mutations so components stay thin.
 * Structural changes persist and notify subscribers; per-second clock ticks
 * mutate without persisting (see `tickLive` / `save`).
 */
export class Store {
  state: AppState;
  private listeners = new Set<Listener>();
  private savedListeners = new Set<Listener>();

  constructor() {
    this.state = this.load();
    if (this.state.live) this.state.live.running = false; // never auto-run on load
  }

  load(): AppState {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return seedState();
      const s = JSON.parse(raw) as Partial<AppState>;
      if (!s.teams || !Array.isArray(s.teams)) return seedState();
      const teams = s.teams.map((t) => ({
        ...t,
        positions: Array.isArray(t.positions) ? t.positions : [],
        players: (t.players ?? []).map((p) => ({
          ...p,
          positionIds: Array.isArray(p.positionIds) ? p.positionIds : [],
        })),
      }));
      return {
        teams,
        currentTeamId: s.currentTeamId ?? teams[0]?.id ?? null,
        plan: s.plan ?? null,
        live: s.live ?? null,
        games: s.games ?? [],
      };
    } catch {
      return seedState();
    }
  }

  /** Persist to localStorage and notify "saved" listeners. */
  save(): boolean {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.state));
      this.savedListeners.forEach((fn) => fn());
      return true;
    } catch {
      return false;
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onSaved(fn: Listener): () => void {
    this.savedListeners.add(fn);
    return () => this.savedListeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** Mutate, persist, then re-render subscribers. */
  update(mut: (s: AppState) => void): void {
    mut(this.state);
    this.save();
    this.notify();
  }

  replaceState(s: AppState): void {
    this.state = s;
    this.save();
    this.notify();
  }

  // ---- teams & players ----
  currentTeam(): Team | null {
    return this.state.teams.find((t) => t.id === this.state.currentTeamId) ?? null;
  }

  setCurrentTeam(id: string): void {
    this.update((s) => {
      s.currentTeamId = id;
    });
  }

  newTeam(name: string): void {
    this.update((s) => {
      const t: Team = {
        id: uid(),
        name: name.trim() || "New Team",
        players: [],
        positions: [],
      };
      s.teams.push(t);
      s.currentTeamId = t.id;
    });
  }

  /** Add a team received via a share link as a NEW team and select it. */
  addSharedTeam(shared: SharedTeam): Team {
    const positions: Position[] = shared.positions.map((p) => ({ id: uid(), ...p }));
    const t: Team = {
      id: uid(),
      name: uniqueTeamName(
        shared.name,
        this.state.teams.map((x) => x.name),
      ),
      positions,
      players: shared.players.map((p) => ({
        id: uid(),
        name: p.name,
        present: true,
        positionIds: p.positions.map((i) => positions[i].id),
      })),
    };
    this.update((s) => {
      s.teams.push(t);
      s.currentTeamId = t.id;
    });
    return t;
  }

  renameTeam(name: string): void {
    this.update(() => {
      const t = this.currentTeam();
      if (t) t.name = name;
    });
  }

  /** Delete the current team. Returns false if it is the last one. */
  deleteTeam(): boolean {
    if (this.state.teams.length <= 1) return false;
    this.update((s) => {
      s.teams = s.teams.filter((t) => t.id !== s.currentTeamId);
      s.currentTeamId = s.teams[0].id;
    });
    return true;
  }

  addPlayer(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.update(() => {
      const t = this.currentTeam();
      if (t)
        t.players.push({ id: uid(), name: trimmed, present: true, positionIds: [] });
    });
  }

  private mutatePlayer(id: string, fn: (p: Player) => void): void {
    this.update(() => {
      const p = this.currentTeam()?.players.find((x) => x.id === id);
      if (p) fn(p);
    });
  }

  renamePlayer(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.mutatePlayer(id, (p) => (p.name = trimmed));
  }

  togglePresent(id: string): void {
    this.mutatePlayer(id, (p) => (p.present = !p.present));
  }

  /** Toggle whether a player is eligible for a position. */
  togglePlayerPosition(playerId: string, positionId: string): void {
    this.mutatePlayer(playerId, (p) => {
      p.positionIds = p.positionIds.includes(positionId)
        ? p.positionIds.filter((x) => x !== positionId)
        : [...p.positionIds, positionId];
    });
  }

  removePlayer(id: string): void {
    this.update(() => {
      const t = this.currentTeam();
      if (t) t.players = t.players.filter((p) => p.id !== id);
    });
  }

  // ---- positions ----
  addPosition(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.update(() => {
      const t = this.currentTeam();
      if (!t) return;
      const isFirstGk = !t.positions.some((p) => p.isGoalkeeper);
      t.positions.push({
        id: uid(),
        name: trimmed,
        cadence: "shift",
        isGoalkeeper: isFirstGk && /goal|keeper|gk/i.test(trimmed),
      });
    });
  }

  private mutatePosition(id: string, fn: (p: Position) => void): void {
    this.update(() => {
      const p = this.currentTeam()?.positions.find((x) => x.id === id);
      if (p) fn(p);
    });
  }

  renamePosition(id: string, name: string): void {
    const trimmed = name.trim();
    if (trimmed) this.mutatePosition(id, (p) => (p.name = trimmed));
  }

  setPositionCadence(id: string, cadence: PositionCadence): void {
    this.mutatePosition(id, (p) => (p.cadence = cadence));
  }

  /** Mark a position as the goalkeeper (for conceded stats); clears others. */
  setGoalkeeperPosition(id: string): void {
    this.update(() => {
      const t = this.currentTeam();
      if (!t) return;
      const target = t.positions.find((p) => p.id === id);
      if (!target) return;
      const next = !target.isGoalkeeper;
      t.positions.forEach((p) => (p.isGoalkeeper = false));
      target.isGoalkeeper = next;
    });
  }

  removePosition(id: string): void {
    this.update(() => {
      const t = this.currentTeam();
      if (!t) return;
      t.positions = t.positions.filter((p) => p.id !== id);
      t.players.forEach((p) => {
        p.positionIds = p.positionIds.filter((x) => x !== id);
      });
    });
  }

  // ---- planning ----
  /** Build a rotation for the present squad. Returns false if too few present. */
  generatePlan(cfg: GameConfig): boolean {
    const t = this.currentTeam();
    if (!t) return false;
    const present = t.players.filter((p) => p.present);
    if (present.length < cfg.fieldSize) return false;
    const players = present.map((p) => ({
      id: p.id,
      name: p.name,
      positionIds: [...p.positionIds],
    }));
    const positions = t.positions.map((p) => ({ ...p }));
    const schedule = buildSchedule(players, positions, cfg);
    this.update((s) => {
      s.plan = {
        teamId: t.id,
        teamName: t.name,
        cfg,
        players,
        positions,
        schedule,
        createdAt: new Date().toISOString(),
      };
    });
    return true;
  }

  clearPlan(): void {
    this.update((s) => {
      s.plan = null;
    });
  }

  // ---- live game ----
  /** Start a game from the current plan. Returns false if no plan. */
  startGame(): boolean {
    const plan = this.state.plan;
    if (!plan) return false;
    this.update((s) => {
      s.live = {
        id: uid(),
        teamId: plan.teamId,
        teamName: plan.teamName,
        opponent: plan.cfg.opponent || "",
        date: todayStr(),
        startedAt: new Date().toISOString(),
        cfg: plan.cfg,
        players: plan.players,
        positions: plan.positions,
        schedule: plan.schedule,
        currentHalf: 0,
        elapsedSec: 0,
        running: false,
        manualShift: plan.schedule.shifts[0].idx, // >= 1 shift always exists
        events: [],
      };
    });
    return true;
  }

  setRunning(running: boolean): void {
    this.update((s) => {
      if (s.live) s.live.running = running;
    });
  }

  shiftBy(delta: number): void {
    this.update((s) => {
      const g = s.live;
      if (!g) return;
      const max = g.schedule.shifts.length - 1;
      g.manualShift = Math.min(max, Math.max(0, g.manualShift + delta));
    });
  }

  /** Move to the next half. Returns false if already on the last half. */
  nextHalf(): boolean {
    const g = this.state.live;
    if (!g || g.currentHalf + 1 >= g.cfg.halves) return false;
    this.update((s) => {
      const live = s.live as LiveGame;
      live.currentHalf += 1;
      live.elapsedSec = 0;
      live.running = false;
      const first = live.schedule.shifts.find((sh) => sh.half === live.currentHalf);
      if (first) live.manualShift = first.idx;
    });
    return true;
  }

  /**
   * Live override: put an on-court player straight into a position (e.g. drop a
   * subbed-in player into goal), or clear their position, for the current shift.
   * A player holds at most one position and a position at most one player.
   */
  setLivePosition(playerId: string, positionId: string | null): void {
    this.update((s) => {
      const g = s.live;
      if (!g) return;
      const sh = g.schedule.shifts.find((x) => x.idx === g.manualShift);
      if (!sh || !sh.onIds.includes(playerId)) return;
      const valid = positionId !== null && g.positions.some((p) => p.id === positionId);
      if (positionId !== null && !valid) return; // unknown position: no-op
      for (const pid of Object.keys(sh.assignments)) {
        if (sh.assignments[pid] === playerId) delete sh.assignments[pid];
      }
      if (valid) sh.assignments[positionId as string] = playerId;
    });
  }

  addGoal(team: GoalTeam, scorerId: string | null): void {
    this.update((s) => {
      const g = s.live;
      if (!g) return;
      const gkId = keeperId(currentShift(g), g.positions);
      g.events.push({
        id: uid(),
        kind: "goal",
        team,
        scorerId: team === "us" ? scorerId : null,
        gkId,
        half: g.currentHalf,
        clock: g.elapsedSec,
        at: new Date().toISOString(),
      });
    });
  }

  undoLastEvent(): void {
    this.update((s) => {
      s.live?.events.pop();
    });
  }

  /** Mutate the live clock by one second without persisting (see game.advanceOneSecond). */
  get live(): LiveGame | null {
    return this.state.live;
  }

  finishGame(): void {
    const g = this.state.live;
    if (!g) return;
    const finished: FinishedGame = {
      ...g,
      running: false,
      finishedAt: new Date().toISOString(),
      result: { us: countGoals(g.events, "us"), them: countGoals(g.events, "them") },
    };
    this.update((s) => {
      s.games.unshift(finished);
      s.live = null;
    });
  }

  discardGame(): void {
    this.update((s) => {
      s.live = null;
    });
  }

  deleteGame(id: string): void {
    this.update((s) => {
      s.games = s.games.filter((game) => game.id !== id);
    });
  }

  wipe(): void {
    this.replaceState(seedState());
  }
}

export const store = new Store();
