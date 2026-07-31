import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createJiemianBackfillAdapter } from "../lib/backfill/adapters/jiemian";

const firstHtml = readFileSync(new URL(
  "./fixtures/jiemian-backfill-first.html",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/jiemian-backfill-next.json",
  import.meta.url,
), "utf8");

describe("Jiemian backfill adapter", () => {
  it("derives the first time cursor from HTML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(firstHtml));
    const adapter = createJiemianBackfillAdapter("jiemian-regulatory", {
      fetcher,
    });
    const result = await adapter.fetchPage(null);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://www.jiemian.com/lists/1330kb.html",
    );
    expect(result.items).toHaveLength(2);
    expect(JSON.parse(result.nextCursor!)).toEqual({
      startTime: 1_785_483_600,
      page: 2,
    });
    expect(result.exhausted).toBe(false);
  });

  it.each([
    ["jiemian-regulatory", "1330kb", "1330"],
    ["jiemian-current-affairs", "1325kb", "1325"],
  ] as const)("uses the correct channel parameters for %s", async (
    sourceId,
    cid,
    tagid,
  ) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(nextJson));
    const adapter = createJiemianBackfillAdapter(sourceId, { fetcher });
    const result = await adapter.fetchPage(JSON.stringify({
      startTime: 1_785_484_724,
      page: 2,
    }));
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://papi.jiemian.com/page/api/kuaixun/getlistmore?cid=${cid}`
      + `&start_time=1785484724&page=2&tagid=${tagid}`,
    );
    expect(result.items[0]?.url).toBe(
      "https://www.jiemian.com/article/1002.html",
    );
    expect(JSON.parse(result.nextCursor!)).toEqual({
      startTime: 1_785_480_000,
      page: 3,
    });
  });

  it("uses hideBtn as explicit exhaustion", async () => {
    const terminal = JSON.stringify({
      code: "0",
      result: { hideBtn: true, list: [] },
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(terminal));
    const adapter = createJiemianBackfillAdapter("jiemian-regulatory", {
      fetcher,
    });
    const result = await adapter.fetchPage(JSON.stringify({
      startTime: 1_785_484_724,
      page: 2,
    }));
    expect(result).toMatchObject({ nextCursor: null, exhausted: true });
  });
});
