import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ fetch36KrScfPage: vi.fn() }));
vi.mock("../lib/kr36-scf-client", () => ({
  fetch36KrScfPage: fakes.fetch36KrScfPage,
}));

import { fetchSource } from "../lib/fetch-source";
import { SOURCES } from "../lib/sources";

describe("source fetching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes routine 36Kr collection through SCF", async () => {
    const items = [{
      sourceId: "36kr-macro" as const,
      sourceName: "36Kr",
      channelName: "宏观",
      title: "宏观快讯",
      summary: "摘要",
      url: "https://36kr.com/newsflashes/123",
      publishedAt: "2026-08-10T00:00:00.000Z",
    }];
    fakes.fetch36KrScfPage.mockResolvedValue({
      items,
      nextCursor: "cursor-1",
      exhausted: false,
    });
    const directFetch = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("direct 36Kr fetch is disabled"));

    await expect(fetchSource(SOURCES[0]!)).resolves.toEqual(items);

    expect(fakes.fetch36KrScfPage).toHaveBeenCalledWith(null);
    expect(directFetch).not.toHaveBeenCalled();
  });
});
