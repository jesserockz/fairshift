import { describe, it, expect, beforeEach, vi } from "vitest";
import { Store, seedState, defaultState, uniqueTeamName, LS_KEY } from "./store";
import { pendingSubs } from "./game";
import type { GameConfig } from "./types";

const cfg: GameConfig = {
  fieldSize: 4,
  halves: 2,
  halfLength: 10,
  shiftLength: 2.5,
  opponent: "Rats",
  seed: 0,
};

function populated(): { store: Store; gkPosId: string; ids: string[] } {
  const store = new Store();
  const gkPosId = store.currentTeam()!.positions[0].id;
  ["Ava", "Ben", "Cai", "Dan", "Eli", "Fin"].forEach((n) => store.addPlayer(n));
  const ids = store.currentTeam()!.players.map((p) => p.id);
  ids.slice(0, 3).forEach((id) => store.togglePlayerPosition(id, gkPosId));
  return { store, gkPosId, ids };
}

beforeEach(() => localStorage.clear());

describe("state seeding & persistence", () => {
  it("defaultState is empty; seedState has one team with a default GK", () => {
    expect(defaultState().teams).toHaveLength(0);
    const s = seedState();
    expect(s.teams).toHaveLength(1);
    expect(s.teams[0].positions[0]).toMatchObject({ name: "GK", isGoalkeeper: true });
  });

  it("save persists and notifies; load restores", () => {
    const store = new Store();
    let saved = 0;
    store.onSaved(() => saved++);
    store.addPlayer("Zoe");
    expect(saved).toBeGreaterThan(0);
    const reloaded = new Store();
    expect(reloaded.currentTeam()!.players.map((p) => p.name)).toContain("Zoe");
  });

  it("onSaved returns an unsubscribe function", () => {
    const store = new Store();
    let saved = 0;
    const off = store.onSaved(() => saved++);
    off();
    store.addPlayer("Zoe");
    expect(saved).toBe(0);
  });

  it("save returns false when storage throws", () => {
    const store = new Store();
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(store.save()).toBe(false);
    spy.mockRestore();
  });

  it("load falls back to seed on bad or missing data", () => {
    localStorage.setItem(LS_KEY, "not json");
    expect(new Store().currentTeam()).not.toBeNull();
    localStorage.setItem(LS_KEY, JSON.stringify({ nope: 1 }));
    expect(new Store().currentTeam()).not.toBeNull();
  });

  it("load normalizes teams missing positions/positionIds", () => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({ teams: [{ id: "t", name: "T", players: [{ id: "p", name: "P" }] }] }),
    );
    const store = new Store();
    expect(store.currentTeam()!.positions).toEqual([]);
    expect(store.currentTeam()!.players[0].positionIds).toEqual([]);
  });

  it("load handles a team with no players array and an empty team list", () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ teams: [{ id: "t", name: "T" }] }));
    expect(new Store().currentTeam()!.players).toEqual([]);
    localStorage.setItem(LS_KEY, JSON.stringify({ teams: [] }));
    expect(new Store().state.currentTeamId).toBeNull();
  });

  it("resets a running live game on load", () => {
    const base = seedState();
    base.live = { running: true } as never;
    localStorage.setItem(LS_KEY, JSON.stringify(base));
    expect(new Store().state.live!.running).toBe(false);
  });

  it("subscribe fires on change and can unsubscribe", () => {
    const store = new Store();
    let n = 0;
    const off = store.subscribe(() => n++);
    store.addPlayer("A");
    off();
    store.addPlayer("B");
    expect(n).toBe(1);
  });
});

describe("teams & players", () => {
  it("new/rename/select/delete teams with a last-team guard", () => {
    const store = new Store();
    expect(store.deleteTeam()).toBe(false); // last team
    store.newTeam("B");
    expect(store.currentTeam()!.name).toBe("B");
    store.renameTeam("Bravo");
    expect(store.currentTeam()!.name).toBe("Bravo");
    const first = store.state.teams[0].id;
    store.setCurrentTeam(first);
    expect(store.state.currentTeamId).toBe(first);
    expect(store.deleteTeam()).toBe(true);
  });

  it("newTeam falls back to a default name", () => {
    const store = new Store();
    store.newTeam("   ");
    expect(store.currentTeam()!.name).toBe("New Team");
  });

  it("add/rename/remove players and toggle present & positions", () => {
    const store = new Store();
    const posId = store.currentTeam()!.positions[0].id;
    store.addPlayer("  ");
    expect(store.currentTeam()!.players).toHaveLength(0); // blank ignored
    store.addPlayer("Ava");
    const id = store.currentTeam()!.players[0].id;
    store.renamePlayer(id, "  "); // ignored
    expect(store.currentTeam()!.players[0].name).toBe("Ava");
    store.renamePlayer(id, "Ava B");
    expect(store.currentTeam()!.players[0].name).toBe("Ava B");
    store.togglePresent(id);
    expect(store.currentTeam()!.players[0].present).toBe(false);
    store.togglePlayerPosition(id, posId);
    expect(store.currentTeam()!.players[0].positionIds).toEqual([posId]);
    store.togglePlayerPosition(id, posId);
    expect(store.currentTeam()!.players[0].positionIds).toEqual([]);
    store.removePlayer(id);
    expect(store.currentTeam()!.players).toHaveLength(0);
  });

  it("ignores edits for unknown players, and removing one with no team", () => {
    const store = new Store();
    store.addPlayer("Ava");
    store.togglePresent("nope");
    expect(store.currentTeam()!.players[0].present).toBe(true);
    store.setCurrentTeam("bogus");
    store.removePlayer("nope");
    expect(store.currentTeam()).toBeNull();
  });

  it("no-ops safely when there is no current team", () => {
    const store = new Store();
    store.setCurrentTeam("bogus");
    expect(store.currentTeam()).toBeNull();
    // none of these should throw with no current team
    store.addPlayer("Ghost");
    store.renameTeam("x");
    store.addPosition("GK");
    store.renamePosition("p", "x");
    store.setPositionCadence("p", "half");
    store.setGoalkeeperPosition("p");
    store.removePosition("p");
    expect(store.generatePlan(cfg)).toBe(false);
    expect(store.currentTeam()).toBeNull();
  });
});

describe("positions", () => {
  it("adds positions, auto-flagging the first keeper-named role", () => {
    const store = new Store();
    store.newTeam("Empty"); // no positions
    store.addPosition("  "); // ignored
    store.addPosition("Goalie");
    expect(store.currentTeam()!.positions[0].isGoalkeeper).toBe(true);
    store.addPosition("Wing");
    expect(store.currentTeam()!.positions[1].isGoalkeeper).toBe(false);
  });

  it("renames, sets cadence, toggles goalkeeper exclusively, and removes", () => {
    const store = new Store();
    const gk = store.currentTeam()!.positions[0].id;
    store.addPosition("Def");
    const def = store.currentTeam()!.positions[1].id;
    store.renamePosition(def, "Defender");
    expect(store.currentTeam()!.positions[1].name).toBe("Defender");
    store.setPositionCadence(def, "half");
    expect(store.currentTeam()!.positions[1].cadence).toBe("half");
    store.setGoalkeeperPosition(def); // moves keeper flag to Def
    expect(store.currentTeam()!.positions.find((p) => p.id === gk)!.isGoalkeeper).toBe(false);
    expect(store.currentTeam()!.positions.find((p) => p.id === def)!.isGoalkeeper).toBe(true);
    store.setGoalkeeperPosition(def); // toggle off
    expect(store.currentTeam()!.positions.find((p) => p.id === def)!.isGoalkeeper).toBe(false);
    store.renamePosition(def, "  "); // blank ignored
    expect(store.currentTeam()!.positions[1].name).toBe("Defender");
    store.setGoalkeeperPosition("nope"); // no-op branch
    // removing a position clears it from player eligibility
    const pid = (store.addPlayer("Ava"), store.currentTeam()!.players[0].id);
    store.togglePlayerPosition(pid, def);
    store.removePosition(def);
    expect(store.currentTeam()!.positions.some((p) => p.id === def)).toBe(false);
    expect(store.currentTeam()!.players[0].positionIds).toEqual([]);
  });
});

describe("planning & live game", () => {
  it("generatePlan needs enough present players", () => {
    const store = new Store();
    expect(store.generatePlan(cfg)).toBe(false); // no players
    const { store: s2 } = (() => ({ store: populated().store }))();
    expect(s2.generatePlan(cfg)).toBe(true);
    expect(s2.state.plan!.positions).toHaveLength(1);
    s2.clearPlan();
    expect(s2.state.plan).toBeNull();
  });

  it("runs a full game: start, clock, goals, halves, finish", () => {
    const { store } = populated();
    expect(store.startGame()).toBe(false); // no plan yet
    store.generatePlan(cfg);
    expect(store.startGame()).toBe(true);
    store.setRunning(true);
    expect(store.live!.running).toBe(true);

    // our goal by a named scorer
    const scorer = store.live!.players[0].id;
    store.addGoal("us", scorer);
    // their goal tags the keeper on court
    store.addGoal("them", null);
    const conceded = store.live!.events.find((e) => e.team === "them")!;
    expect(conceded.gkId).not.toBeNull();
    expect(store.live!.events).toHaveLength(2);
    store.undoLastEvent();
    expect(store.live!.events).toHaveLength(1);

    expect(store.nextHalf()).toBe(true);
    expect(store.live!.currentHalf).toBe(1);
    expect(store.nextHalf()).toBe(false); // last half

    store.finishGame();
    expect(store.live).toBeNull();
    expect(store.state.games).toHaveLength(1);
    expect(store.state.games[0].result.us).toBe(1);
  });

  it("uses fallback labels when opponent is blank", () => {
    const { store } = populated();
    store.generatePlan({ ...cfg, opponent: "" });
    store.startGame();
    expect(store.live!.opponent).toBe("");
  });

  it("lets you drop an on-court player into a position live", () => {
    const { store } = populated();
    store.generatePlan(cfg);
    store.startGame();
    const sh = () => store.live!.schedule.shifts.find((x) => x.idx === store.live!.manualShift)!;
    const gkPosId = store.live!.positions[0].id;
    const onCourt = sh().onIds;
    const target = onCourt.find((id) => sh().assignments[gkPosId] !== id)!;

    store.setLivePosition(target, gkPosId);
    expect(sh().assignments[gkPosId]).toBe(target); // took over the keeper role

    // assigning a second position to the same player moves them (one role each)
    store.setLivePosition(target, null);
    expect(sh().assignments[gkPosId]).toBeUndefined();

    // a player already holding a role gets it cleared when reassigned elsewhere
    store.setLivePosition(target, gkPosId);
    const other = onCourt.find((id) => id !== target)!;
    store.setLivePosition(other, gkPosId);
    expect(sh().assignments[gkPosId]).toBe(other);
  });

  it("ignores live position changes for off-court, unknown, or missing games", () => {
    const store = new Store();
    store.setLivePosition("x", "y"); // no live game
    const { store: s2 } = populated();
    s2.generatePlan(cfg);
    s2.startGame();
    const gkPosId = s2.live!.positions[0].id;
    const sh = () => s2.live!.schedule.shifts.find((x) => x.idx === s2.live!.manualShift)!;
    const before = { ...sh().assignments };
    s2.setLivePosition("not-on-court", gkPosId); // player not on court
    s2.setLivePosition(sh().onIds[0], "bogus-position"); // unknown position id
    expect(sh().assignments[gkPosId]).toBe(before[gkPosId]);
    expect(sh().assignments["bogus-position"]).toBeUndefined();
  });

  it("nextHalf resumes the running shift with the same players", () => {
    const { store } = populated();
    store.generatePlan({ ...cfg, shiftLength: 3 }); // 10:00 halves: a 1:00 shift is cut at half time
    store.startGame();
    const g = store.live!;
    const last = g.schedule.shifts.filter((sh) => sh.half === 0).at(-1)!;
    g.manualShift = last.idx;
    expect(last.carryOverSec).toBe(120);
    expect(store.nextHalf()).toBe(true);
    const resumed = store.live!.schedule.shifts[store.live!.manualShift];
    expect(resumed).toMatchObject({ half: 1, carry: true, startSec: 0, endSec: 120 });
    expect(resumed.onIds).toEqual(last.onIds);
  });

  it("confirms subs one at a time, rebalances, and can undo", () => {
    const { store } = populated();
    store.generatePlan({ ...cfg, maxSwaps: 2 });
    store.startGame();
    store.setRunning(true);
    expect(store.undoSub()).toBe(false); // nothing confirmed yet
    store.confirmAllSubs();
    expect(store.live!.manualShift).toBe(1);
    expect(store.undoSub()).toBe(true);
    expect(store.live!.manualShift).toBe(0);

    const g = store.live!;
    const first = g.schedule.shifts[1].onIds.find((id) => !g.schedule.shifts[0].onIds.includes(id))!;
    store.confirmSub("nobody", first); // not a pending sub: ignored
    expect(g.undoSub).toBeUndefined();
    const sh0 = g.schedule.shifts[0];
    const rows = pendingSubs(g);
    expect(rows).toHaveLength(2);
    store.confirmSub(rows[0].offId, rows[0].onId);
    expect(store.live!.manualShift).toBe(0);
    expect(sh0.onIds).toContain(rows[0].onId);
    store.confirmSub(rows[1].offId, rows[1].onId);
    expect(store.live!.manualShift).toBe(1);
    store.confirmAllSubs(); // nothing pending on a fresh shift is fine too
  });

  it("does nothing on confirmAllSubs when no sub is pending", () => {
    const { store } = populated();
    store.generatePlan(cfg);
    store.startGame();
    store.live!.manualShift = store.live!.schedule.shifts.filter((s) => s.half === 0).length - 1;
    const before = JSON.stringify(store.live);
    store.confirmAllSubs();
    expect(JSON.stringify(store.live)).toBe(before);
  });

  it("saves the time actually played when the game finishes", () => {
    const { store } = populated();
    store.generatePlan(cfg);
    store.startGame();
    store.live!.played = {};
    store.live!.players.forEach((p) => (store.live!.played![p.id] = { fieldSec: 100, posSec: {} }));
    store.finishGame();
    const saved = store.state.games[0];
    expect(saved.schedule.totals.every((t) => t.fieldSec === 100)).toBe(true);
    expect(saved.undoSub).toBeUndefined();
  });

  it("plans and starts a timer-per-player game", () => {
    const { store } = populated();
    expect(store.generatePlan({ ...cfg, shiftLength: 3, perPlayer: true })).toBe(true);
    expect(store.state.plan!.schedule.shifts).toHaveLength(2); // one line-up per half
    expect(store.state.plan!.schedule.totals.every((t) => t.fieldSec === 800)).toBe(true);
    store.startGame();
    const g = store.live!;
    expect(Object.keys(g.timers!)).toHaveLength(6);
    const sh = g.schedule.shifts[0];
    const [out, inn] = [sh.onIds[0], sh.restingIds[0]];
    store.swapPlayers(out, inn);
    expect(store.live!.schedule.shifts[0].onIds).toContain(inn);
    expect(store.undoSub()).toBe(true);
    expect(store.live!.schedule.shifts[0].onIds).toContain(out);
    // half time carries the court over
    const court = [...store.live!.schedule.shifts[0].onIds];
    expect(store.nextHalf()).toBe(true);
    expect(store.live!.schedule.shifts[store.live!.manualShift].onIds).toEqual(court);
  });

  it("guards live actions when no game is running", () => {
    const store = new Store();
    store.swapPlayers("a", "b");
    store.setRunning(true); // no-op
    store.confirmSub("a", "b");
    store.confirmAllSubs();
    expect(store.undoSub()).toBe(false);
    store.addGoal("us", null);
    store.undoLastEvent();
    expect(store.nextHalf()).toBe(false);
    store.finishGame();
    expect(store.live).toBeNull();
  });

  it("discards, deletes and wipes", () => {
    const { store } = populated();
    store.generatePlan(cfg);
    store.startGame();
    store.discardGame();
    expect(store.live).toBeNull();

    store.generatePlan(cfg);
    store.startGame();
    store.finishGame();
    const id = store.state.games[0].id;
    store.deleteGame(id);
    expect(store.state.games).toHaveLength(0);

    store.replaceState(seedState());
    store.wipe();
    expect(store.currentTeam()!.players).toHaveLength(0);
  });
});

describe("addSharedTeam", () => {
  const shared = {
    name: "Foxes",
    positions: [
      { name: "GK", cadence: "shift" as const, isGoalkeeper: true },
      { name: "Def", cadence: "half" as const, isGoalkeeper: false },
    ],
    players: [
      { name: "Ava", positions: [1, 0] },
      { name: "Ben", positions: [] },
    ],
  };

  it("adds a NEW team with fresh ids, all present, and selects it", () => {
    const store = new Store();
    const before = store.state.teams.length;
    const mine = store.state.teams[0];
    const t = store.addSharedTeam(shared);
    expect(store.state.teams).toHaveLength(before + 1);
    expect(store.state.teams[0]).toBe(mine);
    expect(store.state.currentTeamId).toBe(t.id);
    expect(t.players.every((p) => p.present)).toBe(true);
    const [gk, def] = t.positions;
    expect(gk).toMatchObject({ name: "GK", cadence: "shift", isGoalkeeper: true });
    expect(t.players[0].positionIds).toEqual([def.id, gk.id]);
    const ids = [t.id, ...t.positions.map((p) => p.id), ...t.players.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Store().state.teams.map((x) => x.name)).toContain("Foxes"); // persisted
  });

  it("suffixes duplicate team names", () => {
    const store = new Store();
    expect(store.addSharedTeam(shared).name).toBe("Foxes");
    expect(store.addSharedTeam(shared).name).toBe("Foxes (2)");
    expect(store.addSharedTeam(shared).name).toBe("Foxes (3)");
  });
});

describe("uniqueTeamName", () => {
  it("returns the name unchanged when free, else the first free suffix", () => {
    expect(uniqueTeamName("A", [])).toBe("A");
    expect(uniqueTeamName("A", ["a "])).toBe("A (2)");
    expect(uniqueTeamName("A", ["A", "A (2)", "A (4)"])).toBe("A (3)");
  });
});
