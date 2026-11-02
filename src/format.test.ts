import { describe, it, expect } from "vitest";
import { uid, clampNum, fmtClock, fmtMin, fmtMinSec, parseMinutes, todayStr, esc } from "./format";

describe("format helpers", () => {
  it("uid produces unique-ish strings", () => {
    expect(uid()).not.toBe(uid());
    expect(typeof uid()).toBe("string");
  });

  it("clampNum clamps and handles NaN", () => {
    expect(clampNum("5", 1, 10, 0)).toBe(5);
    expect(clampNum("50", 1, 10, 0)).toBe(10);
    expect(clampNum("-3", 1, 10, 0)).toBe(1);
    expect(clampNum("abc", 1, 10, 7)).toBe(7);
  });

  it("fmtClock formats seconds as mm:ss and floors negatives", () => {
    expect(fmtClock(0)).toBe("00:00");
    expect(fmtClock(65)).toBe("01:05");
    expect(fmtClock(-10)).toBe("00:00");
    expect(fmtClock(600)).toBe("10:00");
  });

  it("fmtMin renders one decimal minute", () => {
    expect(fmtMin(150)).toBe("2.5");
    expect(fmtMin(0)).toBe("0.0");
  });

  it("todayStr is zero-padded ISO date", () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("esc escapes HTML-significant characters", () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
    expect(esc(42)).toBe("42");
  });

  it("parseMinutes reads m:ss and decimal minutes", () => {
    expect(parseMinutes("2:30")).toBe(2.5);
    expect(parseMinutes(" 10:00 ")).toBe(10);
    expect(parseMinutes("0:45")).toBe(0.75);
    expect(parseMinutes("2.5")).toBe(2.5);
    expect(parseMinutes("12")).toBe(12);
  });

  it("parseMinutes rejects anything else", () => {
    for (const bad of ["", "abc", "2:75", "2:", ":30", "-1", "1:2:3", "2,5"]) {
      expect(parseMinutes(bad)).toBeNull();
    }
  });

  it("fmtMinSec shows minutes and padded seconds", () => {
    expect(fmtMinSec(2.5)).toBe("2:30");
    expect(fmtMinSec(10)).toBe("10:00");
    expect(fmtMinSec(0.5)).toBe("0:30");
    expect(fmtMinSec(200 / 60)).toBe("3:20");
  });
});
