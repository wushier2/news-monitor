import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  countItemsInRange: vi.fn(),
  db: {} as D1Database,
  ensureSchema: vi.fn(),
  getLastSuccessfulIngestion: vi.fn(),
  getSourceStatuses: vi.fn(),
  isBackfillActive: vi.fn(),
  listFeedPage: vi.fn(),
  runIngestion: vi.fn(),
}));

vi.mock("../db", () => ({ getD1: () => fakes.db }));
vi.mock("../db/ensure", () => ({ ensureSchema: fakes.ensureSchema }));
vi.mock("../lib/repository", () => ({
  countItemsInRange: fakes.countItemsInRange,
  getLastSuccessfulIngestion: fakes.getLastSuccessfulIngestion,
  getSourceStatuses: fakes.getSourceStatuses,
  listFeedPage: fakes.listFeedPage,
}));
vi.mock("../lib/ingestion", () => ({ runIngestion: fakes.runIngestion }));
vi.mock("../lib/backfill/runner", () => ({
  isBackfillActive: fakes.isBackfillActive,
}));

import { GET } from "../app/api/feed/route";
import { POST } from "../app/api/refresh/route";

describe("feed and refresh API contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.ensureSchema.mockResolvedValue(undefined);
    fakes.listFeedPage.mockResolvedValue({ items: [], totalItems: 0 });
    fakes.countItemsInRange.mockResolvedValue(0);
    fakes.getSourceStatuses.mockResolvedValue([]);
    fakes.isBackfillActive.mockReturnValue(false);
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

  it("uses the default page size and disables response caching", async () => {
    const response = await GET(new Request("https://example.test/api/feed?limit=999"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fakes.listFeedPage).toHaveBeenCalledWith(fakes.db, {
      query: undefined,
      sourceId: undefined,
      limit: 50,
      page: 1,
      pageSize: 50,
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
      expect(fakes.listFeedPage).toHaveBeenCalledWith(fakes.db, {
        query: undefined,
        sourceId: undefined,
        limit: 50,
        page: 1,
        pageSize: 50,
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
    expect(fakes.listFeedPage).not.toHaveBeenCalled();
  });

  it("returns pagination metadata and an independent Beijing today count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T11:45:30.123Z"));
    fakes.listFeedPage.mockResolvedValue({
      items: [{ id: 101 }],
      totalItems: 105,
    });
    fakes.countItemsInRange.mockResolvedValue(23);
    try {
      const response = await GET(new Request(
        "https://example.test/api/feed?page=3&pageSize=50&q=政策",
      ));
      expect(response.status).toBe(200);
      expect(fakes.countItemsInRange).toHaveBeenCalledWith(fakes.db, {
        fromMs: Date.parse("2026-07-30T00:00:00+08:00"),
        toMs: Date.parse("2026-07-30T11:45:30.123Z"),
      });
      expect(await response.json()).toEqual({
        items: [{ id: 101 }],
        sources: [],
        generatedAt: "2026-07-30T11:45:30.123Z",
        todayCount: 23,
        pagination: {
          page: 3,
          pageSize: 50,
          totalItems: 105,
          totalPages: 3,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 400 for invalid pagination values", async () => {
    const response = await GET(new Request("https://example.test/api/feed?page=0"));
    expect(response.status).toBe(400);
    expect(fakes.listFeedPage).not.toHaveBeenCalled();
  });

  it("returns 202 without ingestion when data is still fresh", async () => {
    fakes.getLastSuccessfulIngestion.mockResolvedValue(new Date());

    const response = await POST();
    const body = await response.json() as { status: string };

    expect(response.status).toBe(202);
    expect(body.status).toBe("skipped");
    expect(fakes.runIngestion).not.toHaveBeenCalled();
  });

  it("skips ordinary ingestion while backfill is active", async () => {
    fakes.isBackfillActive.mockReturnValue(true);
    const response = await POST();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "busy" });
    expect(fakes.getLastSuccessfulIngestion).not.toHaveBeenCalled();
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
