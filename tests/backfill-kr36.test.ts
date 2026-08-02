import { readFileSync } from "node:fs";
import { md5 } from "js-md5";
import { describe, expect, it, vi } from "vitest";
import { create36KrBackfillAdapter } from "../lib/backfill/adapters/kr36";

const firstHtml = readFileSync(new URL(
  "./fixtures/36kr-backfill-first.html",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/36kr-backfill-next.json",
  import.meta.url,
), "utf8");

describe("36Kr backfill adapter", () => {
  it("reads first-page nonce and callback from HTML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(firstHtml));
    const adapter = create36KrBackfillAdapter({ fetcher });
    const page = await adapter.fetchPage(null);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://36kr.com/newsflashes/catalog/4",
    );
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(page.nextCursor!)).toEqual({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    });
    expect(page.exhausted).toBe(false);
  });

  it("rejects a first page without parseable newsflash data", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "<html><script>window.initialState={};</script></html>",
    ));
    const adapter = create36KrBackfillAdapter({ fetcher });

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      "无法解析 36Kr 首屏数据",
    );
  });

  it("signs and advances a gateway page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(nextJson));
    const adapter = create36KrBackfillAdapter({
      fetcher,
      now: () => 1_785_500_000_000,
    });
    const page = await adapter.fetchPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }));
    const [url, init] = fetcher.mock.calls[0]!;
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      nonce: "fixture-nonce",
      partner_id: "web",
      timestamp: 1_785_500_000_000,
      param: {
        pageSize: 20,
        pageEvent: 1,
        pageCallback: "fixture-callback",
        siteId: 1,
        type: 4,
        platformId: 2,
      },
    });
    expect(url).toBe(
      `https://gateway.36kr.com/api/mis/nav/newsflash/list?sign=${
        md5(JSON.stringify(body) + "fixture-nonce")
      }`,
    );
    expect(init).toMatchObject({ method: "POST" });
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(page.nextCursor!)).toEqual({
      nonce: "fixture-nonce",
      pageCallback: "next-token",
    });
  });

  it("retries when reading a gateway response body loses connection", async () => {
    const brokenResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("Network connection lost.")),
    } as unknown as Response;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(brokenResponse)
      .mockResolvedValueOnce(new Response(nextJson));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    const page = await adapter.fetchPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }));

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("falls back to HTTP after repeated HTTPS connection loss", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith("https://")) {
        return {
          ok: true,
          status: 200,
          json: vi.fn().mockRejectedValue(new Error("Network connection lost.")),
        } as unknown as Response;
      }
      return new Response(nextJson);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    const page = await adapter.fetchPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }));

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.slice(0, 3).every(
      ([url]) => String(url).startsWith("https://gateway.36kr.com/"),
    )).toBe(true);
    expect(String(fetcher.mock.calls[3]?.[0])).toMatch(
      /^http:\/\/gateway\.36kr\.com\//,
    );
  });

  it("does not downgrade a permanent HTTPS error", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("forbidden", {
      status: 403,
    }));
    const adapter = create36KrBackfillAdapter({ fetcher });

    await expect(adapter.fetchPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }))).rejects.toThrow("HTTP 403");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/gateway\.36kr\.com\//,
    );
  });

  it("reports exhaustion when no next callback is available", async () => {
    const terminal = JSON.stringify({
      data: { itemList: [], pageCallback: null, hasNextPage: 0 },
    });
    const fetcher = vi.fn().mockResolvedValue(new Response(terminal));
    const adapter = create36KrBackfillAdapter({ fetcher });
    const page = await adapter.fetchPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }));
    expect(page).toMatchObject({ nextCursor: null, exhausted: true });
  });
});
