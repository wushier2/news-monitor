import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClsBackfillAdapter } from "../lib/backfill/adapters/cls";
import { buildClsSignedUrl } from "../lib/fetch-source";

const firstJson = readFileSync(new URL(
  "./fixtures/cls-backfill-first.json",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/cls-backfill-next.json",
  import.meta.url,
), "utf8");

describe("CLS backfill adapter", () => {
  it("signs every sorted query parameter", async () => {
    expect(await buildClsSignedUrl("/v3/depth/list/1000", {
      last_time: "1785472939",
      rn: "20",
      id: "1000",
    })).toBe(
      "https://www.cls.cn/v3/depth/list/1000?"
      + "app=CailianpressWeb&id=1000&last_time=1785472939&os=web&rn=20&sv=8.7.9"
      + "&sign=87c0cda95249170b5c3d166c09a3fdb7",
    );
  });

  it("uses depth_list first and advances with last_time", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(firstJson))
      .mockResolvedValueOnce(new Response(nextJson));
    const adapter = createClsBackfillAdapter({ fetcher });
    const first = await adapter.fetchPage(null);
    expect(first.items).toHaveLength(2);
    expect(JSON.parse(first.nextCursor!)).toEqual({
      lastTime: 1_785_472_939,
    });
    const next = await adapter.fetchPage(first.nextCursor);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain(
      "/v3/depth/list/1000?app=CailianpressWeb&id=1000&last_time=1785472939",
    );
    expect(next.items).toHaveLength(2);
    expect(JSON.parse(next.nextCursor!)).toEqual({
      lastTime: 1_785_470_000,
    });
  });

  it("treats only an empty paged response as exhaustion", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ errno: 0, data: [] }),
    ));
    const adapter = createClsBackfillAdapter({ fetcher });
    const result = await adapter.fetchPage(JSON.stringify({
      lastTime: 1_785_472_939,
    }));
    expect(result).toMatchObject({ nextCursor: null, exhausted: true });
  });
});
