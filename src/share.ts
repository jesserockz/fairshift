/**
 * Share a team as a link (pure; no DOM). The team is packed into the URL
 * fragment, so it never reaches a server:
 *
 *   <origin+path>#team=<base64url(deflate-raw(JSON))>
 *
 * JSON payload (short keys, `v` = format version):
 *   { v: 1, n: teamName,
 *     p: [[positionName, "s"|"h"|"g", 0|1 isGoalkeeper], ...],
 *     q: [[playerName, [positionIndex, ...]], ...] }
 *
 * Decoding is untrusted input (anyone can craft a link), so everything is
 * validated strictly and rejected with a `ShareError` carrying a friendly message.
 */
import { renderSVG } from "uqr";
import type { PositionCadence, SharedTeam, Team } from "./types";

export const SHARE_VERSION = 1;
export const MAX_NAME_LEN = 60;
export const MAX_PLAYERS = 60;
export const MAX_POSITIONS = 20;
/** Cap on the decompressed JSON, enforced while streaming (decompression bombs). */
export const MAX_JSON_BYTES = 64 * 1024;
/** Cap on the encoded payload text before we even try to decode it. */
export const MAX_PAYLOAD_CHARS = 16 * 1024;

const HASH_PREFIX = "#team=";
const MSG_BAD = "That team link is damaged or is not a FairShift team.";
const MSG_BIG = "That team link is too large to open.";
const MSG_VERSION = "That team link comes from a different version of FairShift.";

const CADENCE_TO_CODE: Record<PositionCadence, string> = {
  shift: "s",
  half: "h",
  game: "g",
};
const CODE_TO_CADENCE = new Map<unknown, PositionCadence>([
  ["s", "shift"],
  ["h", "half"],
  ["g", "game"],
]);

/** Thrown for any payload we refuse; `message` is safe to show the user. */
export class ShareError extends Error {}

// ---- base64url ----
function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Strict base64url (no padding) decode. Throws ShareError on bad input. */
function fromBase64Url(text: string): Uint8Array {
  if (text.length > MAX_PAYLOAD_CHARS) throw new ShareError(MSG_BIG);
  // A length of 1 mod 4 can never be valid base64.
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw new ShareError(MSG_BAD);
  }
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---- compression ----
async function deflate(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate, aborting as soon as the output passes MAX_JSON_BYTES. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  // Fire and forget: failures surface on the readable side (and a cancel
  // rejects the pending write), so these results are deliberately ignored.
  void Promise.allSettled([writer.write(bytes as BufferSource), writer.close()]);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooBig = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_JSON_BYTES) {
        tooBig = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    throw new ShareError(MSG_BAD);
  }
  if (tooBig) throw new ShareError(MSG_BIG);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// ---- validation ----
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A trimmed, non-empty name within the length cap. */
function checkName(v: unknown): string {
  if (typeof v !== "string") throw new ShareError(MSG_BAD);
  const name = v.trim();
  if (!name || name.length > MAX_NAME_LEN) throw new ShareError(MSG_BAD);
  return name;
}

/** A list with at most `max` entries. */
function checkList(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new ShareError(MSG_BAD);
  return v;
}

/** Validate an untrusted decoded value into a SharedTeam. */
export function validateSharedTeam(raw: unknown): SharedTeam {
  if (!isRecord(raw) || raw.v !== SHARE_VERSION) {
    throw new ShareError(isRecord(raw) ? MSG_VERSION : MSG_BAD);
  }
  const name = checkName(raw.n);

  const positions = checkList(raw.p, MAX_POSITIONS).map((entry) => {
    const [pName, code, gk] = checkList(entry, 3);
    const cadence = CODE_TO_CADENCE.get(code);
    if (!cadence || (gk !== 0 && gk !== 1)) throw new ShareError(MSG_BAD);
    return { name: checkName(pName), cadence, isGoalkeeper: gk === 1 };
  });
  if (positions.filter((p) => p.isGoalkeeper).length > 1) throw new ShareError(MSG_BAD);

  const players = checkList(raw.q, MAX_PLAYERS).map((entry) => {
    const [pName, idxs] = checkList(entry, 2);
    const list = checkList(idxs, MAX_POSITIONS * 2);
    const seen = new Set<number>();
    for (const i of list) {
      if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= positions.length) {
        throw new ShareError(MSG_BAD);
      }
      seen.add(i as number);
    }
    return { name: checkName(pName), positions: [...seen] };
  });

  return { name, positions, players };
}

// ---- public API ----
const clip = (s: string, fallback: string): string =>
  s.trim().slice(0, MAX_NAME_LEN).trim() || fallback;

/** Pack a team into its base64url payload. Throws ShareError if it is too big. */
export async function encodeTeam(team: Team): Promise<string> {
  if (team.players.length > MAX_PLAYERS || team.positions.length > MAX_POSITIONS) {
    throw new ShareError(
      `Too big to share (max ${MAX_PLAYERS} players and ${MAX_POSITIONS} positions).`,
    );
  }
  const ids = team.positions.map((p) => p.id);
  const json = JSON.stringify({
    v: SHARE_VERSION,
    n: clip(team.name, "Team"),
    p: team.positions.map((p) => [
      clip(p.name, "Position"),
      CADENCE_TO_CODE[p.cadence],
      p.isGoalkeeper ? 1 : 0,
    ]),
    q: team.players.map((pl) => [
      clip(pl.name, "Player"),
      pl.positionIds.map((id) => ids.indexOf(id)).filter((i) => i >= 0),
    ]),
  });
  return toBase64Url(await deflate(json));
}

/** Unpack and validate a payload from `encodeTeam`. Throws ShareError. */
export async function decodeTeam(payload: string): Promise<SharedTeam> {
  const bytes = await inflate(fromBase64Url(payload));
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ShareError(MSG_BAD);
  }
  return validateSharedTeam(raw);
}

/** The share link for a team, given the page URL without query or hash. */
export async function buildShareLink(team: Team, base: string): Promise<string> {
  return base + HASH_PREFIX + (await encodeTeam(team));
}

/** The payload in a `#team=...` location hash, or null if it is not one. */
export function teamPayloadFromHash(hash: string): string | null {
  return hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : null;
}

/** An offline SVG QR code for the link, or null if it is too long for a QR code. */
export function qrSvg(link: string): string | null {
  try {
    return renderSVG(link, { ecc: "L", border: 2 });
  } catch {
    return null;
  }
}
