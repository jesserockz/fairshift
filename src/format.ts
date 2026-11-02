/** Small pure formatting/helper utilities. */

export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const clampNum = (
  v: unknown,
  lo: number,
  hi: number,
  def: number,
): number => {
  const n = Number(v);
  return Number.isNaN(n) ? def : Math.min(hi, Math.max(lo, n));
};

/** Seconds to mm:ss. */
export const fmtClock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return (
    String(Math.floor(s / 60)).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0")
  );
};

/**
 * Parse a duration typed as "m:ss" (e.g. "2:30") or plain decimal minutes
 * ("2.5", "10") into minutes. Returns null if it is not a usable duration.
 */
export const parseMinutes = (text: string): number | null => {
  const t = text.trim();
  const clock = /^(\d+):([0-5]?\d)$/.exec(t);
  if (clock) return Number(clock[1]) + Number(clock[2]) / 60;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
};

/** Minutes to an "m:ss" string for the settings boxes ("2:30", "10:00"). */
export const fmtMinSec = (min: number): string => {
  const sec = Math.round(min * 60);
  return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
};

/** Seconds to a "12.5" style minute string. */
export const fmtMin = (sec: number): string => (sec / 60).toFixed(1);

export const todayStr = (): string => {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
};

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for safe interpolation into innerHTML. */
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
