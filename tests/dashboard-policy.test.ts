import { describe, expect, it } from "vitest";
import { REFRESH_INTERVAL_MS, shouldAutoRefresh } from "../lib/refresh-policy";
import {
  formatTimeRangeLabel,
  getBeijingInputBounds,
} from "../lib/time-range";

describe("dashboard refresh policy", () => {
  const now = Date.parse("2026-07-29T10:00:00.000Z");

  it("uses one five-minute polling interval", () => {
    expect(REFRESH_INTERVAL_MS).toBe(300_000);
  });

  it("refreshes missing and stale dashboard data but skips fresh data", () => {
    expect(shouldAutoRefresh(null, now)).toBe(true);
    expect(shouldAutoRefresh("2026-07-29T09:55:00.000Z", now)).toBe(true);
    expect(shouldAutoRefresh("2026-07-29T09:59:00.000Z", now)).toBe(false);
  });

  it("shows compact applied range text", () => {
    expect(formatTimeRangeLabel({
      from: "2026-07-29T09:30",
      to: "2026-07-30T18:00",
    })).toBe("07-29 09:30 → 07-30 18:00");
  });

  it("limits picker inputs to the latest seven Beijing days", () => {
    expect(getBeijingInputBounds(
      Date.parse("2026-07-30T03:45:30.000Z"),
    )).toEqual({
      min: "2026-07-23T11:45",
      max: "2026-07-30T11:45",
    });
  });
});
