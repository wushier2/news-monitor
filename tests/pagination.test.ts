import { describe, expect, it } from "vitest";
import {
  buildFeedSearchParams,
  getPageTokens,
} from "../lib/pagination";

describe("pagination helpers", () => {
  it.each([
    [1, 0, []],
    [1, 1, [1]],
    [3, 5, [1, 2, 3, 4, 5]],
    [1, 10, [1, 2, 3, 4, "ellipsis-right", 10]],
    [5, 10, [1, "ellipsis-left", 4, 5, 6, "ellipsis-right", 10]],
    [10, 10, [1, "ellipsis-left", 7, 8, 9, 10]],
  ])("builds page %i of %i", (page, totalPages, expected) => {
    expect(getPageTokens(page, totalPages)).toEqual(expected);
  });

  it("composes pagination with all feed filters", () => {
    expect(buildFeedSearchParams({
      query: "政策",
      sourceId: "36kr-macro",
      range: {
        from: "2026-07-30T09:30",
        to: "2026-07-30T18:00",
      },
      page: 3,
      pageSize: 50,
    }).toString()).toBe(
      "q=%E6%94%BF%E7%AD%96&source=36kr-macro&from=2026-07-30T09%3A30%3A00%2B08%3A00&to=2026-07-30T18%3A00%3A00%2B08%3A00&page=3&pageSize=50",
    );
  });
});
