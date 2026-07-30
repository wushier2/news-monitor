import { describe, expect, it } from "vitest";
import { parseFeedInput } from "../lib/api-input";

describe("feed input", () => {
  const now = Date.parse("2026-07-30T03:45:30.000Z");

  it("accepts a valid source and caps the limit", () => {
    expect(parseFeedInput("https://example.test/api/feed?source=36kr-macro&limit=999"))
      .toEqual({ query: undefined, sourceId: "36kr-macro", limit: 100 });
  });

  it("rejects unknown sources", () => {
    expect(() => parseFeedInput("https://example.test/api/feed?source=unknown"))
      .toThrow("未知来源");
  });

  it("rejects overlong search text", () => {
    expect(() => parseFeedInput(`https://example.test/api/feed?q=${"x".repeat(101)}`))
      .toThrow("100");
  });

  it("parses a valid Beijing range into database bounds", () => {
    expect(parseFeedInput(
      "https://example.test/api/feed?from=2026-07-30T09%3A30%3A00%2B08%3A00&to=2026-07-30T11%3A20%3A00%2B08%3A00",
      now,
    )).toEqual({
      query: undefined,
      sourceId: undefined,
      limit: 60,
      fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
    });
  });

  it("rejects a partial time range", () => {
    expect(() => parseFeedInput(
      "https://example.test/api/feed?from=2026-07-30T09%3A30%3A00%2B08%3A00",
      now,
    )).toThrow("同时");
  });
});
