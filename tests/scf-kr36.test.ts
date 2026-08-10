import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandler,
  fetch36KrPage,
} from "../scf/kr36/index.mjs";

const firstHtml = readFileSync(new URL(
  "./fixtures/36kr-backfill-first.html",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/36kr-backfill-next.json",
  import.meta.url,
), "utf8");
const gatewayJson = JSON.stringify({ code: 0, ...JSON.parse(nextJson) });

function event(body: unknown, token = "test-token") {
  return {
    httpMethod: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("36Kr SCF function", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects an invalid bearer token before fetching upstream", async () => {
    const fetcher = vi.fn();
    const handler = createHandler({ token: "test-token", fetcher });
    const response = await handler(event(
      { operation: "fetchPage", cursor: null },
      "wrong",
    ));
    expect(response.statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads and normalizes the first macro page", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(firstHtml))
      .mockResolvedValueOnce(new Response(gatewayJson, {
        headers: { "content-type": "application/json" },
      }));
    const page = await fetch36KrPage(null, {
      fetcher,
      now: () => 1_785_500_000_000,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      sourceId: "36kr-macro",
      sourceName: "36Kr",
      channelName: "宏观",
    });
    expect(JSON.parse(page.nextCursor!)).toEqual({
      nonce: "fixture-nonce",
      pageCallback: "next-token",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://www.36kr.com/newsflashes/catalog/4",
    );
  });

  it("advances an opaque cursor without fetching HTML again", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(gatewayJson));
    await fetch36KrPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }), { fetcher, now: () => 1_785_500_000_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      nonce: "fixture-nonce",
      param: {
        pageEvent: 1,
        pageCallback: "fixture-callback",
        type: 4,
      },
    });
  });

  it("returns safe diagnostics for a risk page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "<html><body>captcha</body></html>",
      { headers: { "content-type": "text/html" } },
    ));
    await expect(fetch36KrPage(null, { fetcher }))
      .rejects.toThrow(
        "KR36_RISK_PAGE(status=200,type=text/html,bytes=33)",
      );
  });

  it("rejects extra request fields", async () => {
    const handler = createHandler({ token: "test-token", fetcher: vi.fn() });
    const response = await handler(event({
      operation: "fetchPage",
      cursor: null,
      extra: true,
    }));
    expect(response.statusCode).toBe(400);
  });
});
