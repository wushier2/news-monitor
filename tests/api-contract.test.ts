import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  db: {} as D1Database,
  ensureSchema: vi.fn(),
  getLastSuccessfulIngestion: vi.fn(),
  getSourceStatuses: vi.fn(),
  listFeed: vi.fn(),
  runIngestion: vi.fn(),
}));

vi.mock("../db", () => ({ getD1: () => fakes.db }));
vi.mock("../db/ensure", () => ({ ensureSchema: fakes.ensureSchema }));
vi.mock("../lib/repository", () => ({
  getLastSuccessfulIngestion: fakes.getLastSuccessfulIngestion,
  getSourceStatuses: fakes.getSourceStatuses,
  listFeed: fakes.listFeed,
}));
vi.mock("../lib/ingestion", () => ({ runIngestion: fakes.runIngestion }));

import { GET } from "../app/api/feed/route";
import { POST } from "../app/api/refresh/route";

describe("feed and refresh API contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.ensureSchema.mockResolvedValue(undefined);
    fakes.listFeed.mockResolvedValue([]);
    fakes.getSourceStatuses.mockResolvedValue([]);
  });

  it("returns 400 for an unknown feed source", async () => {
    const response = await GET(new Request("https://example.test/api/feed?source=unknown"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "未知来源" });
  });

  it("returns 400 for search text over 100 characters", async () => {
    const response = await GET(new Request(
      `https://example.test/api/feed?q=${"x".repeat(101)}`,
    ));
    expect(response.status).toBe(400);
  });

  it("caps the feed limit at 100 and disables response caching", async () => {
    const response = await GET(new Request("https://example.test/api/feed?limit=999"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fakes.listFeed).toHaveBeenCalledWith(fakes.db, {
      query: undefined,
      sourceId: undefined,
      limit: 100,
    });
  });

  it("passes valid time bounds to the repository", async () => {
    const from = encodeURIComponent("2026-07-30T09:30:00+08:00");
    const to = encodeURIComponent("2026-07-30T11:20:00+08:00");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T03:45:30.000Z"));
    try {
      const response = await GET(new Request(
        `https://example.test/api/feed?from=${from}&to=${to}`,
      ));
      expect(response.status).toBe(200);
      expect(fakes.listFeed).toHaveBeenCalledWith(fakes.db, {
        query: undefined,
        sourceId: undefined,
        limit: 60,
        fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
        toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 and skips the repository for an invalid time range", async () => {
    const from = encodeURIComponent("2026-07-30T11:30:00+08:00");
    const to = encodeURIComponent("2026-07-30T11:20:00+08:00");
    const response = await GET(new Request(
      `https://example.test/api/feed?from=${from}&to=${to}`,
    ));
    expect(response.status).toBe(400);
    expect(fakes.listFeed).not.toHaveBeenCalled();
  });

  it("returns 202 without ingestion when data is still fresh", async () => {
    fakes.getLastSuccessfulIngestion.mockResolvedValue(new Date());

    const response = await POST();
    const body = await response.json() as { status: string };

    expect(response.status).toBe(202);
    expect(body.status).toBe("skipped");
    expect(fakes.runIngestion).not.toHaveBeenCalled();
  });

  it("returns 207 for a partial ingestion", async () => {
    fakes.getLastSuccessfulIngestion.mockResolvedValue(null);
    fakes.runIngestion.mockResolvedValue({
      status: "partial",
      successCount: 3,
      failureCount: 1,
      itemCount: 12,
      refreshedAt: "2026-07-29T10:00:00.000Z",
    });

    const response = await POST();
    expect(response.status).toBe(207);
    expect((await response.json() as { status: string }).status).toBe("partial");
  });
});
