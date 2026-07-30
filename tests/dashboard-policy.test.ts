import { describe, expect, it } from "vitest";
import { REFRESH_INTERVAL_MS, shouldAutoRefresh } from "../lib/refresh-policy";

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
});
