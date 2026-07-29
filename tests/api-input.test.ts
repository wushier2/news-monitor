import { describe, expect, it } from "vitest";
import { parseFeedInput } from "../lib/api-input";

describe("feed input", () => {
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
});
