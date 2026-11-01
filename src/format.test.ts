import { describe, it, expect } from "vitest";
import { uid, clampNum, fmtClock, fmtMin, todayStr, esc } from "./format";

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
});
