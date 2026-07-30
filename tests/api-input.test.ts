import { describe, expect, it } from "vitest";
import { parseFeedInput } from "../lib/api-input";

describe("feed input", () => {
  const now = Date.parse("2026-07-30T03:45:30.000Z");

  it("keeps legacy limit from changing the fixed default page size", () => {
    expect(parseFeedInput("https://example.test/api/feed?source=36kr-macro&limit=999"))
      .toEqual({
        query: undefined,
        sourceId: "36kr-macro",
        limit: 50,
        page: 1,
        pageSize: 50,
      });
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
      limit: 50,
      page: 1,
      pageSize: 50,
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

  it("uses the default page and page size", () => {
    expect(parseFeedInput("https://example.test/api/feed")).toEqual({
      query: undefined,
      sourceId: undefined,
      limit: 50,
      page: 1,
      pageSize: 50,
    });
  });

  it("accepts positive integer pagination values", () => {
    expect(parseFeedInput(
      "https://example.test/api/feed?page=3&pageSize=25",
    )).toEqual({
      query: undefined,
      sourceId: undefined,
      limit: 25,
      page: 3,
      pageSize: 25,
    });
  });

  it.each([
    ["page=0", "页码"],
    ["page=-1", "页码"],
    ["page=1.5", "页码"],
    ["page=abc", "页码"],
    ["pageSize=0", "每页"],
    ["pageSize=-1", "每页"],
    ["pageSize=1.5", "每页"],
    ["pageSize=abc", "每页"],
    ["pageSize=101", "每页"],
  ])("rejects invalid pagination %s", (query, message) => {
    expect(() => parseFeedInput(
      `https://example.test/api/feed?${query}`,
    )).toThrow(message);
  });
});
