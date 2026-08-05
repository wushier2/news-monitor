import { describe, expect, it } from "vitest";
import {
  KR36_AUTO_INTERVAL_MS,
  shouldIngestSource,
} from "../lib/source-interval-policy";

describe("source ingestion interval policy", () => {
  const now = new Date("2026-08-05T10:00:00.000Z");

  it("always includes non-36Kr sources", () => {
    expect(shouldIngestSource(
      "cls-headline",
      new Date(now.getTime() - 60_000),
      now,
      false,
    )).toBe(true);
  });

  it("includes 36Kr initially and at the exact fifteen-minute boundary", () => {
    expect(shouldIngestSource("36kr-macro", null, now, false)).toBe(true);
    expect(KR36_AUTO_INTERVAL_MS).toBe(15 * 60_000);
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - KR36_AUTO_INTERVAL_MS),
      now,
      false,
    )).toBe(true);
  });

  it("skips 36Kr after five or ten minutes", () => {
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - 5 * 60_000),
      now,
      false,
    )).toBe(false);
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - 10 * 60_000),
      now,
      false,
    )).toBe(false);
  });

  it("includes 36Kr when refresh is forced", () => {
    expect(shouldIngestSource("36kr-macro", now, now, true)).toBe(true);
  });
});
