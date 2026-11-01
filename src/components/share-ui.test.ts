import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./setup-view";
import "./app-shell";
import { store } from "../store";
import { seedState, defaultState } from "../store";
import { encodeTeam } from "../share";
import type { Team } from "../types";

const modal = (): HTMLElement => document.getElementById("fs-modal") as HTMLElement;
const toastText = (): string => document.getElementById("fs-toast")?.textContent ?? "";
const click = (el: Element | null): void => (el as HTMLElement).click();
const buttonByText = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>("#fs-modal-body button")].find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement;

function sampleTeam(name = "Foxes"): Team {
  return {
    id: "t",
    name,
    positions: [{ id: "g", name: "GK", cadence: "shift", isGoalkeeper: true }],
    players: [
      { id: "1", name: "Ava <b>", present: true, positionIds: ["g"] },
      { id: "2", name: "Ben", present: true, positionIds: [] },
    ],
  };
}

async function hashFor(team: Team): Promise<string> {
  return "#team=" + (await encodeTeam(team));
}

let shell: HTMLElement | null = null;
function mount(): HTMLElement {
  shell = document.createElement("fair-shift-app");
  document.body.appendChild(shell);
  return shell;
}

beforeEach(() => {
  localStorage.clear();
  store.replaceState(seedState());
  history.replaceState(null, "", "/");
  modal()?.classList.remove("open");
});

afterEach(() => {
  shell?.remove();
  shell = null;
  vi.unstubAllGlobals();
});

describe("Share team button", () => {
  async function openShare(): Promise<void> {
    mount();
    click(document.getElementById("btnShareTeam"));
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
  }

  it("opens the modal with an SVG QR, the link and the privacy note", async () => {
    store.addPlayer("Zed");
    await openShare();
    const body = document.getElementById("fs-modal-body")!;
    expect(body.querySelector(".qr svg")).not.toBeNull();
    const link = (document.getElementById("shareLink") as HTMLInputElement).value;
    expect(link.startsWith(location.origin + location.pathname + "#team=")).toBe(true);
    expect(body.textContent).toContain("only share it with people you trust");
    expect(buttonByText("Share...")).toBeUndefined(); // no navigator.share in happy-dom
  });

  it("copies the link and toasts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await openShare();
    click(buttonByText("Copy link"));
    await vi.waitFor(() => expect(toastText()).toBe("Link copied"));
    expect(writeText).toHaveBeenCalledWith(
      (document.getElementById("shareLink") as HTMLInputElement).value,
    );
  });

  it("falls back to selecting the link when the clipboard fails", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await openShare();
    const box = document.getElementById("shareLink") as HTMLInputElement;
    const select = vi.spyOn(box, "select");
    click(buttonByText("Copy link"));
    await vi.waitFor(() => expect(toastText()).toBe("Copy the selected link"));
    expect(select).toHaveBeenCalled();
  });

  it("offers a native Share... button only when navigator.share exists", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, share });
    await openShare();
    click(buttonByText("Share..."));
    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(share.mock.calls[0][0].url).toContain("#team=");
  });

  it("ignores a dismissed share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new Error("AbortError"));
    vi.stubGlobal("navigator", { ...navigator, share });
    await openShare();
    click(buttonByText("Share..."));
    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(modal().classList.contains("open")).toBe(true);
  });

  it("explains when the team is too big to share", async () => {
    store.update((s) => {
      s.teams[0].players = Array.from({ length: 61 }, (_, i) => ({
        id: "p" + i,
        name: "P" + i,
        present: true,
        positionIds: [],
      }));
    });
    mount();
    click(document.getElementById("btnShareTeam"));
    await vi.waitFor(() => expect(toastText()).toMatch(/Too big/));
    expect(modal().classList.contains("open")).toBe(false);
  });

  it("falls back to the link alone when it is too long for a QR code", async () => {
    // 60 players with long, incompressible names overflow even a version 40 QR.
    let n = 1;
    const rnd = (): string =>
      Array.from({ length: 58 }, () => {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        return String.fromCharCode(33 + (n % 90));
      }).join("");
    store.update((s) => {
      s.teams[0].players = Array.from({ length: 60 }, (_, i) => ({
        id: "p" + i,
        name: rnd(),
        present: true,
        positionIds: [],
      }));
    });
    await openShare();
    const body = document.getElementById("fs-modal-body")!;
    expect(body.querySelector("svg")).toBeNull();
    expect(body.textContent).toContain("Too long for a QR code");
    expect(document.getElementById("shareLink")).not.toBeNull();
  });

  it("does nothing without a current team", () => {
    mount();
    store.replaceState(defaultState());
    click(document.getElementById("btnShareTeam"));
    expect(modal().classList.contains("open")).toBe(false);
  });
});

describe("importing a team from the URL fragment", () => {
  it("prompts on load; Add creates a NEW team, selects it and clears the hash", async () => {
    const mine = store.currentTeam()!.id;
    history.replaceState(null, "", "/" + (await hashFor(sampleTeam("Foxes"))));
    mount();
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
    expect(location.hash).toBe("");
    expect(document.getElementById("fs-modal-title")!.textContent).toBe(
      "Add team Foxes? 2 players, 1 position",
    );
    click(buttonByText("Add"));
    await vi.waitFor(() => expect(toastText()).toBe("Added team Foxes"));
    expect(store.state.teams).toHaveLength(2);
    expect(store.state.teams.some((t) => t.id === mine)).toBe(true);
    const added = store.currentTeam()!;
    expect(added.id).not.toBe(mine);
    expect(added.players.map((p) => p.name)).toEqual(["Ava <b>", "Ben"]);
    expect(added.players.every((p) => p.present)).toBe(true);
    // Rendered through esc: the setup list shows the name as text, not markup.
    expect(shell!.querySelector("#playerList b")).toBeNull();
    expect(shell!.querySelector("#playerList")!.textContent).toContain("Ava <b>");
  });

  it("Cancel adds nothing and clears the hash", async () => {
    history.replaceState(null, "", "/" + (await hashFor(sampleTeam())));
    mount();
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
    click(buttonByText("Cancel"));
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(false));
    expect(store.state.teams).toHaveLength(1);
    expect(location.hash).toBe("");
  });

  it("closing the modal also counts as cancel", async () => {
    history.replaceState(null, "", "/" + (await hashFor(sampleTeam())));
    mount();
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
    click(document.getElementById("fs-modal-close"));
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(false));
    expect(store.state.teams).toHaveLength(1);
  });

  it("suffixes a team name that already exists", async () => {
    const name = store.currentTeam()!.name;
    history.replaceState(null, "", "/" + (await hashFor(sampleTeam(name))));
    mount();
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
    click(buttonByText("Add"));
    await vi.waitFor(() => expect(toastText()).toBe(`Added team ${name} (2)`));
  });

  it("toasts an error for a bad payload and still clears the hash", async () => {
    history.replaceState(null, "", "/#team=AAAA");
    mount();
    await vi.waitFor(() => expect(toastText()).toMatch(/damaged/));
    expect(location.hash).toBe("");
    expect(modal().classList.contains("open")).toBe(false);
    expect(store.state.teams).toHaveLength(1);
  });

  it("reacts to hashchange while open", async () => {
    mount();
    location.hash = await hashFor(sampleTeam("Late")).then((h) => h.slice(1));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(() => expect(modal().classList.contains("open")).toBe(true));
    click(buttonByText("Add"));
    await vi.waitFor(() => expect(toastText()).toBe("Added team Late"));
  });

  it("ignores other hashes and stops listening once removed", async () => {
    history.replaceState(null, "", "/#other");
    mount();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(location.hash).toBe("#other");
    expect(modal().classList.contains("open")).toBe(false);
    shell!.remove();
    history.replaceState(null, "", "/" + (await hashFor(sampleTeam())));
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(location.hash).not.toBe("");
  });
});
