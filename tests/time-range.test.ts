import { describe, expect, it } from "vitest";
import {
  formatTimeRangeLabel,
  getBeijingInputBounds,
  parseBeijingRange,
  toBeijingIsoMinute,
  validateBeijingLocalRange,
} from "../lib/time-range";

describe("Beijing time range", () => {
  const now = Date.parse("2026-07-30T03:45:30.000Z");

  it("converts a datetime-local value to an explicit UTC+08:00 minute", () => {
    expect(toBeijingIsoMinute("2026-07-30T11:20"))
      .toBe("2026-07-30T11:20:00+08:00");
  });

  it("uses an inclusive start and an exclusive minute after the selected end", () => {
    expect(parseBeijingRange(
      "2026-07-30T09:30:00+08:00",
      "2026-07-30T11:20:00+08:00",
      now,
    )).toEqual({
      fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
    });
  });

  it("allows the current minute and rejects a future minute", () => {
    expect(() => validateBeijingLocalRange(
      "2026-07-30T11:20",
      "2026-07-30T11:45",
      now,
    )).not.toThrow();
    expect(() => validateBeijingLocalRange(
      "2026-07-30T11:20",
      "2026-07-30T11:46",
      now,
    )).toThrow("未来");
  });

  it("requires both local picker values before applying a dashboard range", () => {
    expect(() => validateBeijingLocalRange("", "", now)).toThrow("同时");
  });

  it.each([
    [undefined, "2026-07-30T11:20:00+08:00", "同时"],
    ["2026-07-30T11:20:00+08:00", undefined, "同时"],
    ["2026-07-30T11:20:00Z", "2026-07-30T11:21:00Z", "+08:00"],
    ["2026-07-30T11:30:00+08:00", "2026-07-30T11:20:00+08:00", "晚于"],
    ["2026-07-23T11:44:00+08:00", "2026-07-30T11:20:00+08:00", "最近 7 天"],
  ])("rejects invalid range %s to %s", (from, to, message) => {
    expect(() => parseBeijingRange(from, to, now)).toThrow(message);
  });

  it("returns no bounds when both parameters are absent", () => {
    expect(parseBeijingRange(undefined, undefined, now)).toEqual({});
  });

  it("builds fixed Beijing picker bounds and a compact label", () => {
    expect(getBeijingInputBounds(now)).toEqual({
      min: "2026-07-23T11:45",
      max: "2026-07-30T11:45",
    });
    expect(formatTimeRangeLabel({
      from: "2026-07-29T09:30",
      to: "2026-07-30T18:00",
    })).toBe("07-29 09:30 → 07-30 18:00");
  });
});
