import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  fetchSource: vi.fn(),
  deleteExpiredItems: vi.fn(),
  finishRun: vi.fn(),
  getSourceStatuses: vi.fn(),
  setSourceFailure: vi.fn(),
  setSourceSuccess: vi.fn(),
  startRun: vi.fn(),
  upsertItems: vi.fn(),
}));

vi.mock("../lib/fetch-source", () => ({ fetchSource: fakes.fetchSource }));
vi.mock("../lib/repository", () => ({
  deleteExpiredItems: fakes.deleteExpiredItems,
  finishRun: fakes.finishRun,
  getSourceStatuses: fakes.getSourceStatuses,
  setSourceFailure: fakes.setSourceFailure,
  setSourceSuccess: fakes.setSourceSuccess,
  startRun: fakes.startRun,
  upsertItems: fakes.upsertItems,
}));

import { runIngestion } from "../lib/ingestion";
import type { SourceId } from "../lib/domain";
import { SOURCES } from "../lib/sources";

describe("ingestion orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.startRun.mockResolvedValue(42);
    fakes.upsertItems.mockResolvedValue(1);
    fakes.setSourceSuccess.mockResolvedValue(undefined);
    fakes.setSourceFailure.mockResolvedValue(undefined);
    fakes.deleteExpiredItems.mockResolvedValue(0);
    fakes.finishRun.mockResolvedValue(undefined);
    fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
      sourceId: source.id,
      lastAttemptAt: null,
      lastSuccessAt: null,
      status: "idle",
      error: null,
      itemCount: 0,
    })));
  });

  it("persists healthy sources and isolates one failed source", async () => {
    fakes.fetchSource.mockImplementation(async (source: { id: string }) => {
      if (source.id === "cls-headline") {
        throw new Error(`blocked ${"response-body ".repeat(30)}`);
      }
      return [{
        sourceId: source.id,
        sourceName: "来源",
        channelName: "频道",
        title: `${source.id} 标题`,
        summary: "",
        url: `https://example.test/${source.id}`,
        publishedAt: null,
      }];
    });
    const now = new Date("2026-07-29T10:00:00.000Z");

    const result = await runIngestion({} as D1Database, now);

    expect(result).toMatchObject({
      status: "partial",
      successCount: 3,
      failureCount: 1,
      itemCount: 3,
      refreshedAt: now.toISOString(),
    });
    expect(fakes.upsertItems).toHaveBeenCalledTimes(3);
    expect(fakes.setSourceSuccess).toHaveBeenCalledTimes(3);
    expect(fakes.setSourceFailure).toHaveBeenCalledWith(
      {},
      "cls-headline",
      now,
      expect.any(String),
    );
    expect(fakes.setSourceFailure.mock.calls[0][3]).toHaveLength(240);
    expect(fakes.deleteExpiredItems).toHaveBeenCalledWith(
      {},
      new Date("2026-07-22T10:00:00.000Z"),
    );
    expect(fakes.finishRun).toHaveBeenCalledWith(
      {},
      42,
      expect.any(Date),
      "partial",
      3,
      1,
    );
  });

  it("skips 36Kr when its last attempt is less than fifteen minutes old", async () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
      sourceId: source.id,
      lastAttemptAt: source.id === "36kr-macro"
        ? "2026-08-05T09:50:00.000Z"
        : "2026-08-05T09:55:00.000Z",
      lastSuccessAt: null,
      status: "idle",
      error: null,
      itemCount: 0,
    })));
    fakes.fetchSource.mockImplementation(async (source: { id: SourceId }) => [{
      sourceId: source.id,
      sourceName: "来源",
      channelName: "频道",
      title: `${source.id} 标题`,
      summary: "",
      url: `https://example.test/${source.id}`,
      publishedAt: null,
    }]);

    await runIngestion({} as D1Database, now);

    expect(fakes.fetchSource.mock.calls.map(([source]) => source.id))
      .toEqual([
        "jiemian-regulatory",
        "jiemian-current-affairs",
        "cls-headline",
      ]);
  });

  it("forces all four sources regardless of the last 36Kr attempt", async () => {
    const now = new Date("2026-08-05T10:00:00.000Z");
    fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
      sourceId: source.id,
      lastAttemptAt: now.toISOString(),
      lastSuccessAt: null,
      status: "idle",
      error: null,
      itemCount: 0,
    })));
    fakes.fetchSource.mockImplementation(async (source: { id: SourceId }) => [{
      sourceId: source.id,
      sourceName: "来源",
      channelName: "频道",
      title: `${source.id} 标题`,
      summary: "",
      url: `https://example.test/${source.id}`,
      publishedAt: null,
    }]);

    await runIngestion({} as D1Database, now, { force: true });

    expect(fakes.fetchSource).toHaveBeenCalledTimes(4);
    expect(fakes.getSourceStatuses).not.toHaveBeenCalled();
  });
});
