import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { request36KrScfPage } from "../lib/kr36-scf-client";

const item = {
  sourceId: "36kr-macro",
  sourceName: "36Kr",
  channelName: "宏观",
  title: "宏观快讯",
  summary: "摘要",
  url: "https://36kr.com/newsflashes/123",
  publishedAt: "2026-08-10T00:00:00.000Z",
};
const payload = {
  items: [item],
  nextCursor: "cursor-1",
  exhausted: false,
};

describe("36Kr SCF client", () => {
  it("sends the authenticated page request and validates the result", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    const page = await request36KrScfPage(null, {
      url: "https://example.ap-guangzhou.tencentscf.com",
      token: "secret",
      fetcher,
      sleep: vi.fn(),
    });
    expect(page).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.ap-guangzhou.tencentscf.com",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ operation: "fetchPage", cursor: null }),
      }),
    );
  });

  it("retries one server failure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { error: "UPSTREAM" },
        { status: 503 },
      ))
      .mockResolvedValueOnce(Response.json(payload));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep,
    })).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("does not retry authentication failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "wrong",
      fetcher,
      sleep: vi.fn(),
    })).rejects.toThrow("status=401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a source identity mismatch", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      ...payload,
      items: [{ ...item, sourceId: "cls-headline" }],
    }));
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep: vi.fn(),
    })).rejects.toThrow("36Kr SCF 返回格式无效");
  });

  it("retries one timeout without leaking response data", async () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetcher = vi.fn().mockRejectedValue(timeout);
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow("aborted due to timeout");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
