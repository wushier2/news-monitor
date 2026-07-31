import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, waitBetweenPages } from "../lib/backfill/http";

describe("backfill HTTP policy", () => {
  it("retries 429 using Retry-After and then succeeds", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("busy", {
        status: 429,
        headers: { "retry-after": "1" },
      }))
      .mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await fetchWithRetry(
      "https://example.test",
      {},
      { fetcher, sleep },
    )).toMatchObject({ status: 200 });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses bounded fallback delays for server failures", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("error", {
      status: 503,
    }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(fetchWithRetry(
      "https://example.test",
      {},
      { fetcher, sleep },
    )).rejects.toThrow("HTTP 503");
    expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry a permanent 404", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("missing", {
      status: 404,
    }));
    await expect(fetchWithRetry(
      "https://example.test",
      {},
      { fetcher },
    )).rejects.toThrow("HTTP 404");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("waits 500ms between pages", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitBetweenPages(sleep);
    expect(sleep).toHaveBeenCalledWith(500);
  });
});
