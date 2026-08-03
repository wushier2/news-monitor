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
  it("loads the first page from the gateway when HTML only contains a nonce", async () => {
    const shellHtml = [
      "<html><script>",
      'window.__GATEWAY_SIGN__="fixture-nonce";',
      "window.initialState={};",
      "</script></html>",
    ].join("");
    const fetcher = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      void init;
      return String(input).includes("gateway.36kr.com")
        ? new Response(nextJson)
        : new Response(shellHtml);
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({
      fetcher,
      sleep,
      now: () => 1_785_500_000_000,
    });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      referer: "https://36kr.com",
    });
    const [gatewayUrl, gatewayInit] = fetcher.mock.calls[1]!;
    expect(gatewayInit).toBeDefined();
    const body = JSON.parse(String(gatewayInit!.body));
    expect(body).toEqual({
      nonce: "fixture-nonce",
      partner_id: "web",
      timestamp: 1_785_500_000_000,
      param: {
        pageSize: 20,
        pageEvent: 0,
        siteId: 1,
        type: 4,
        platformId: 2,
      },
    });
    expect(gatewayUrl).toBe(
      `https://gateway.36kr.com/api/mis/nav/newsflash/list?sign=${
        md5(JSON.stringify(body) + "fixture-nonce")
      }`,
    );
  });

  it("reads the nonce from HTML and callback from the first gateway page", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(firstHtml))
      .mockResolvedValueOnce(new Response(nextJson));
    const adapter = create36KrBackfillAdapter({ fetcher });
    const page = await adapter.fetchPage(null);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://36kr.com/newsflashes/catalog/4",
    );
    expect(fetcher.mock.calls[1]?.[0]).toMatch(
      /^https:\/\/gateway\.36kr\.com\/api\/mis\/nav\/newsflash\/list\?sign=/,
    );
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(page.nextCursor!)).toEqual({
      nonce: "fixture-nonce",
      pageCallback: "next-token",
    });
    expect(page.exhausted).toBe(false);
  });

  it("rejects a first page without a gateway nonce", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(
      new Response("<html><script>window.initialState={};</script></html>"),
    ));
    const adapter = create36KrBackfillAdapter({
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      "无法读取 36Kr 首屏签名",
    );
  });

  it("reports safe diagnostics for every first-page host without a nonce", async () => {
    const html = '<html><script>window.initialState={"isSpider":true};</script></html>';
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ));
    const adapter = create36KrBackfillAdapter({
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    const bytes = new TextEncoder().encode(html).byteLength;

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      `无法读取 36Kr 首屏签名：36kr.com(status=200,type=text/html,bytes=${bytes},sig=0,sp=1,risk=0); `
      + `www.36kr.com(status=200,type=text/html,bytes=${bytes},sig=0,sp=1,risk=0); `
      + `m.36kr.com(status=200,type=text/html,bytes=${bytes},sig=0,sp=1,risk=0)`,
    );
  });

  it("stops immediately when the first-page response is a risk-control page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "<html><body>captcha</body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    ));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      "36Kr 风控拦截：36kr.com(status=200,type=text/html,bytes=33,sig=0,sp=0,risk=1)",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses a cached nonce before requesting first-page HTML", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(nextJson));
    const loadRecoveryState = vi.fn().mockResolvedValue({
      nonce: "fixture-nonce",
      riskCooldownUntil: null,
    });
    const adapter = create36KrBackfillAdapter({
      fetcher,
      loadRecoveryState,
      now: () => 1_785_500_000_000,
    });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(loadRecoveryState).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/gateway\.36kr\.com\//,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      nonce: "fixture-nonce",
      param: { pageEvent: 0 },
    });
  });

  it("refreshes first-page HTML when the cached nonce is rejected", async () => {
    let gatewayCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (!String(input).includes("gateway.36kr.com")) {
        return new Response(firstHtml);
      }
      gatewayCalls += 1;
      return new Response(gatewayCalls === 1
        ? JSON.stringify({ code: 401, message: "invalid sign" })
        : nextJson);
    });
    const adapter = create36KrBackfillAdapter({
      fetcher,
      loadRecoveryState: async () => ({
        nonce: "stale-nonce",
        riskCooldownUntil: null,
      }),
    });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://36kr.com/newsflashes/catalog/4",
    );
  });

  it("does not request first-page HTML during a risk-control cooldown", async () => {
    const now = 1_785_500_000_000;
    const fetcher = vi.fn();
    const adapter = create36KrBackfillAdapter({
      fetcher,
      now: () => now,
      loadRecoveryState: async () => ({
        nonce: null,
        riskCooldownUntil: now + 15 * 60_000,
      }),
    });

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      "36Kr 风控冷却中（剩余约 15 分钟）",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries a temporarily invalid first-page response", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        "<html><script>window.initialState={};</script></html>",
      ))
      .mockResolvedValueOnce(new Response(firstHtml))
      .mockResolvedValueOnce(new Response(nextJson));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("falls back to the www host after repeated invalid first-page responses", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("gateway.36kr.com")) {
        return new Response(nextJson);
      }
      if (String(input).startsWith("https://www.36kr.com/")) {
        return new Response(firstHtml);
      }
      return new Response(
        "<html><script>window.initialState={};</script></html>",
      );
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.slice(0, 3).every(
      ([url]) => String(url) === "https://36kr.com/newsflashes/catalog/4",
    )).toBe(true);
    expect(fetcher.mock.calls[3]?.[0]).toBe(
      "https://www.36kr.com/newsflashes/catalog/4",
    );
    expect(String(fetcher.mock.calls[4]?.[0])).toMatch(
      /^https:\/\/gateway\.36kr\.com\//,
    );
  });

  it("falls back to the mobile page when desktop pages have no nonce", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("gateway.36kr.com")) return new Response(nextJson);
      if (url === "https://m.36kr.com/newsflashes") {
        return new Response(firstHtml);
      }
      return new Response(
        "<html><script>window.initialState={};</script></html>",
      );
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = create36KrBackfillAdapter({ fetcher, sleep });

    const page = await adapter.fetchPage(null);

    expect(page.items).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(fetcher.mock.calls[6]?.[0]).toBe(
      "https://m.36kr.com/newsflashes",
    );
    expect(String(fetcher.mock.calls[7]?.[0])).toMatch(
      /^https:\/\/gateway\.36kr\.com\//,
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
