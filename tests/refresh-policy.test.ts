import { describe, expect, it } from "vitest";
import { retryAfterSeconds, shouldRefresh } from "../lib/refresh-policy";

describe("refresh policy", () => {
  const now = new Date("2026-07-29T10:00:00.000Z");

  it("refreshes when no successful run exists", () => {
    expect(shouldRefresh(null, now)).toBe(true);
  });

  it("refreshes at five minutes and skips fresh data", () => {
    expect(shouldRefresh(new Date(now.getTime() - 300_000), now)).toBe(true);
    expect(shouldRefresh(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it("reports the remaining cooldown", () => {
    expect(retryAfterSeconds(new Date(now.getTime() - 60_000), now)).toBe(240);
  });
});
