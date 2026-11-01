import { describe, it, expect } from "vitest";
import {
  MAX_JSON_BYTES,
  MAX_PAYLOAD_CHARS,
  ShareError,
  buildShareLink,
  decodeTeam,
  encodeTeam,
  qrSvg,
  teamPayloadFromHash,
  validateSharedTeam,
} from "./share";
import type { Team } from "./types";

/** Craft a payload from raw bytes using the real CompressionStream. */
async function packBytes(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return btoa(String.fromCharCode(...out))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
const pack = (v: unknown): Promise<string> =>
  packBytes(new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v)));

const base = { v: 1, n: "Foxes", p: [["GK", "s", 1]], q: [["Ava", [0]]] };
const withBase = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...base,
  ...patch,
});

async function rejects(payload: string, msg?: RegExp): Promise<void> {
  const err = await decodeTeam(payload).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ShareError);
  if (msg) expect((err as ShareError).message).toMatch(msg);
}

function team(): Team {
  return {
    id: "t1",
    name: "  Foxes ",
    positions: [
      { id: "a", name: "GK", cadence: "shift", isGoalkeeper: true },
      { id: "b", name: "Def", cadence: "half", isGoalkeeper: false },
      { id: "c", name: "Cap", cadence: "game", isGoalkeeper: false },
    ],
    players: [
      { id: "p1", name: "Ava", present: false, positionIds: ["a", "c", "gone"] },
      { id: "p2", name: "Ben", present: true, positionIds: [] },
    ],
  };
}

describe("encode / decode round trip", () => {
  it("round-trips a team through the real compression path", async () => {
    const payload = await encodeTeam(team());
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeTeam(payload)).toEqual({
      name: "Foxes",
      positions: [
        { name: "GK", cadence: "shift", isGoalkeeper: true },
        { name: "Def", cadence: "half", isGoalkeeper: false },
        { name: "Cap", cadence: "game", isGoalkeeper: false },
      ],
      players: [
        { name: "Ava", positions: [0, 2] }, // stale id dropped
        { name: "Ben", positions: [] },
      ],
    });
  });

  it("does not leak ids or the present flag into the payload", async () => {
    const payload = await encodeTeam(team());
    const bytes = new Uint8Array(
      Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
    );
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    const json = await new Response(stream).text();
    expect(json).not.toMatch(/present|"id"|p1|t1/);
    expect(JSON.parse(json).v).toBe(1);
  });

  it("clips overlong names and falls back for blank ones", async () => {
    const t = team();
    t.name = "   ";
    t.positions[0].name = "x".repeat(100);
    t.players[0].name = "";
    const d = await decodeTeam(await encodeTeam(t));
    expect(d.name).toBe("Team");
    expect(d.positions[0].name).toBe("x".repeat(60));
    expect(d.players[0].name).toBe("Player");
    t.positions[1].name = " ";
    expect((await decodeTeam(await encodeTeam(t))).positions[1].name).toBe("Position");
  });

  it("refuses to encode too many players or positions", async () => {
    const t = team();
    t.players = Array.from({ length: 61 }, (_, i) => ({
      id: "p" + i,
      name: "P" + i,
      present: true,
      positionIds: [],
    }));
    await expect(encodeTeam(t)).rejects.toBeInstanceOf(ShareError);
    const t2 = team();
    t2.positions = Array.from({ length: 21 }, (_, i) => ({
      id: "x" + i,
      name: "X" + i,
      cadence: "shift" as const,
      isGoalkeeper: false,
    }));
    await expect(encodeTeam(t2)).rejects.toThrow(/Too big/);
  });

  it("accepts the maximum sizes", async () => {
    const t = team();
    t.positions = Array.from({ length: 20 }, (_, i) => ({
      id: "x" + i,
      name: "X" + i,
      cadence: "shift" as const,
      isGoalkeeper: i === 0,
    }));
    t.players = Array.from({ length: 60 }, (_, i) => ({
      id: "p" + i,
      name: "Player " + i,
      present: true,
      positionIds: t.positions.map((p) => p.id),
    }));
    const d = await decodeTeam(await encodeTeam(t));
    expect(d.players).toHaveLength(60);
    expect(d.positions).toHaveLength(20);
  });

  it("builds a link with the payload in the fragment only", async () => {
    const link = await buildShareLink(team(), "https://x.test/app/");
    expect(link.startsWith("https://x.test/app/#team=")).toBe(true);
    expect(link).not.toContain("?");
    expect(await decodeTeam(link.split("#team=")[1])).toMatchObject({ name: "Foxes" });
  });
});

describe("decode rejects untrusted input", () => {
  it("rejects malformed base64url", async () => {
    await rejects("");
    await rejects("abc$");
    await rejects("ab==");
    await rejects("a+b/");
    await rejects("abcde"); // length 1 mod 4
  });

  it("rejects an oversized payload string before decoding", async () => {
    await rejects("A".repeat(MAX_PAYLOAD_CHARS + 1), /too large/);
  });

  it("rejects data that is not deflate-raw", async () => {
    await rejects("AAAAAAAA");
  });

  it("rejects a truncated stream", async () => {
    const good = await pack(base);
    await rejects(good.slice(0, Math.max(4, good.length - 8)));
  });

  it("caps decompressed size while streaming (decompression bomb)", async () => {
    const bomb = await packBytes(new Uint8Array(MAX_JSON_BYTES * 20).fill(97));
    expect(bomb.length).toBeLessThan(MAX_PAYLOAD_CHARS);
    await rejects(bomb, /too large/);
  });

  it("accepts exactly the cap size boundary as size-ok (then fails on JSON)", async () => {
    await rejects(await packBytes(new Uint8Array(MAX_JSON_BYTES).fill(97)), /damaged/);
  });

  it("rejects invalid UTF-8 and non-JSON", async () => {
    await rejects(await packBytes(new Uint8Array([0xff, 0xfe, 0xfd])));
    await rejects(await pack("not json {"));
  });

  it("rejects non-objects and bad versions", async () => {
    await rejects(await pack("null"), /damaged/);
    await rejects(await pack("[1]"), /damaged/);
    await rejects(await pack("5"), /damaged/);
    await rejects(await pack(withBase({ v: undefined })), /different version/);
    await rejects(await pack(withBase({ v: 2 })), /different version/);
    await rejects(await pack(withBase({ v: "1" })), /different version/);
  });

  it("rejects bad names", () => {
    for (const n of [undefined, 5, "", "   ", "x".repeat(61)]) {
      expect(() => validateSharedTeam(withBase({ n }))).toThrow(ShareError);
    }
    expect(() => validateSharedTeam(withBase({ p: [[" ", "s", 0]] }))).toThrow(ShareError);
    expect(() => validateSharedTeam(withBase({ q: [[7, []]] }))).toThrow(ShareError);
    expect(validateSharedTeam(withBase({ n: "  Ok  " })).name).toBe("Ok");
    expect(validateSharedTeam(withBase({ n: "x".repeat(60) })).name).toHaveLength(60);
  });

  it("rejects bad positions", () => {
    const bad: unknown[] = [
      "x",
      { length: 1 },
      [["GK", "s", 1, "extra"]],
      ["GK"],
      [["GK", "z", 0]],
      [["GK", "constructor", 0]],
      [["GK", "s", 2]],
      [["GK", "s", true]],
      [["GK", "s"]],
      [["A", "s", 1], ["B", "h", 1]], // two goalkeepers
      Array.from({ length: 21 }, () => ["X", "s", 0]),
    ];
    for (const p of bad) {
      expect(() => validateSharedTeam(withBase({ p, q: [] }))).toThrow(ShareError);
    }
    const ok = validateSharedTeam(withBase({ p: [["A", "g", 1], ["B", "h", 0]], q: [] }));
    expect(ok.positions).toEqual([
      { name: "A", cadence: "game", isGoalkeeper: true },
      { name: "B", cadence: "half", isGoalkeeper: false },
    ]);
    expect(validateSharedTeam(withBase({ p: [], q: [] }))).toMatchObject({ positions: [] });
  });

  it("rejects bad players", () => {
    const bad: unknown[] = [
      "x",
      ["Ava"],
      [["Ava", [0], "extra"]],
      [["Ava", "0"]],
      [["Ava", [1]]], // out of range
      [["Ava", [-1]]],
      [["Ava", [0.5]]],
      [["Ava", ["0"]]],
      [["Ava", Array.from({ length: 41 }, () => 0)]],
      Array.from({ length: 61 }, () => ["P", []]),
    ];
    for (const q of bad) {
      expect(() => validateSharedTeam(withBase({ q }))).toThrow(ShareError);
    }
  });

  it("drops duplicate position indexes", () => {
    const t = validateSharedTeam(
      withBase({ p: [["A", "s", 0], ["B", "s", 0]], q: [["Ava", [1, 0, 1, 0]]] }),
    );
    expect(t.players[0].positions).toEqual([1, 0]);
  });
});

describe("helpers", () => {
  it("teamPayloadFromHash only matches #team=", () => {
    expect(teamPayloadFromHash("#team=abc")).toBe("abc");
    expect(teamPayloadFromHash("#team=")).toBe("");
    expect(teamPayloadFromHash("#other=abc")).toBeNull();
    expect(teamPayloadFromHash("")).toBeNull();
  });

  it("qrSvg renders an SVG, or null when the link is too long", () => {
    expect(qrSvg("https://x.test/#team=abc")).toMatch(/^<svg/);
    expect(qrSvg("x".repeat(4000))).toBeNull();
  });
});
