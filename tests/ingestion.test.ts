import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  fetchSource: vi.fn(),
  deleteExpiredItems: vi.fn(),
  finishRun: vi.fn(),
  setSourceFailure: vi.fn(),
  setSourceSuccess: vi.fn(),
  startRun: vi.fn(),
  upsertItems: vi.fn(),
}));

vi.mock("../lib/fetch-source", () => ({ fetchSource: fakes.fetchSource }));
vi.mock("../lib/repository", () => ({
  deleteExpiredItems: fakes.deleteExpiredItems,
  finishRun: fakes.finishRun,
  setSourceFailure: fakes.setSourceFailure,
  setSourceSuccess: fakes.setSourceSuccess,
  startRun: fakes.startRun,
  upsertItems: fakes.upsertItems,
}));

import { runIngestion } from "../lib/ingestion";

describe("ingestion orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.startRun.mockResolvedValue(42);
    fakes.upsertItems.mockResolvedValue(1);
    fakes.setSourceSuccess.mockResolvedValue(undefined);
    fakes.setSourceFailure.mockResolvedValue(undefined);
    fakes.deleteExpiredItems.mockResolvedValue(0);
    fakes.finishRun.mockResolvedValue(undefined);
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
});
