import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedItem, SourceId } from "../lib/domain";
import {
  createBackfillRun,
  getBackfillRun,
  updateBackfillSource,
} from "../lib/backfill/repository";
import {
  runBackfillSources,
  runSourceBackfill,
} from "../lib/backfill/service";
import { createBackfillAdapter } from "../lib/backfill/adapters";
import type {
  BackfillAdapter,
  BackfillPageResult,
} from "../lib/backfill/types";
import { getSource } from "../lib/sources";
import { createTestD1 } from "./helpers/d1";

const migrations = [
  "../drizzle/0000_first_strong_guy.sql",
  "../drizzle/0001_backfill_runs.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const windowEnd = Date.parse("2026-07-31T10:00:00.000Z");
const windowStart = windowEnd - 86_400_000;
const now = new Date(windowEnd);
const kr36Page = readFileSync(new URL(
  "./fixtures/36kr-backfill-next.json",
  import.meta.url,
), "utf8");

function itemAt(
  publishedAt: string | null,
  suffix: string,
  sourceId: SourceId = "36kr-macro",
): NormalizedItem {
  const source = getSource(sourceId);
  return {
    sourceId,
    sourceName: source.sourceName,
    channelName: source.channelName,
    title: `示例 ${suffix}`,
    summary: "",
    url: `https://example.test/${sourceId}/${suffix}`,
    publishedAt,
  };
}

function page(
  items: NormalizedItem[],
  nextCursor: string | null,
  exhausted = false,
): BackfillPageResult {
  return { items, nextCursor, exhausted };
}

function fakeAdapter(
  steps: Array<BackfillPageResult | Error>,
  sourceId: SourceId = "36kr-macro",
): BackfillAdapter {
  let index = 0;
  return {
    sourceId,
    async fetchPage() {
      const step = steps[index++] ?? new Error("unexpected page request");
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

describe("backfill service", () => {
  let testDb: ReturnType<typeof createTestD1>;

  beforeEach(() => {
    testDb = createTestD1();
    migrations.forEach((migration) => testDb.sqlite.exec(migration));
  });

  afterEach(() => testDb.sqlite.close());

  async function sourceContext(adapter: BackfillAdapter) {
    const run = await createBackfillRun(testDb.db, {
      sourceIds: [adapter.sourceId],
      requestedSourceId: adapter.sourceId,
      windowStart,
      windowEnd,
      now,
    });
    return {
      db: testDb.db,
      runId: run.id,
      adapter,
      windowStart,
      windowEnd,
      now: () => now,
      waitBetweenPages: async () => undefined,
    };
  }

  it("creates the matching adapter for every source", () => {
    const sourceIds: SourceId[] = [
      "36kr-macro",
      "jiemian-regulatory",
      "jiemian-current-affairs",
      "cls-headline",
    ];
    expect(sourceIds.map((sourceId) => createBackfillAdapter(sourceId).sourceId))
      .toEqual(sourceIds);
  });

  it("hydrates the 36Kr adapter from a prior persisted cursor", async () => {
    const previous = await createBackfillRun(testDb.db, {
      sourceIds: ["36kr-macro"],
      requestedSourceId: "36kr-macro",
      windowStart,
      windowEnd,
      now,
    });
    await updateBackfillSource(testDb.db, previous.id, "36kr-macro", {
      status: "complete",
      cursor: JSON.stringify({
        nonce: "persisted-nonce",
        pageCallback: "persisted-callback",
      }),
      pagesFetched: 2,
      itemsFetched: 40,
      itemsInWindow: 20,
      itemsInserted: 20,
      itemsExisting: 0,
      earliestCoveredAt: windowStart,
      error: null,
    }, now);
    const current = await createBackfillRun(testDb.db, {
      sourceIds: ["36kr-macro"],
      requestedSourceId: "36kr-macro",
      windowStart,
      windowEnd,
      now: new Date(now.getTime() + 1),
    });
    const fetcher = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(kr36Page)),
    );
    vi.stubGlobal("fetch", fetcher);

    try {
      const adapter = createBackfillAdapter("36kr-macro", {
        db: testDb.db,
        beforeRunId: current.id,
        kr36: { fetcher, now: () => now.getTime() },
      });
      const result = await adapter.fetchPage(null);

      expect(result.items).toHaveLength(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)))
        .toMatchObject({ nonce: "persisted-nonce" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops complete after reaching the fixed 24-hour cutoff", async () => {
    const adapter = fakeAdapter([
      page([itemAt("2026-07-31T09:00:00Z", "new")], "1"),
      page([itemAt("2026-07-30T09:59:59Z", "old")], "2"),
    ]);
    const result = await runSourceBackfill(await sourceContext(adapter));
    expect(result).toMatchObject({
      status: "complete",
      pagesFetched: 2,
      itemsFetched: 2,
      itemsInWindow: 1,
      itemsInserted: 1,
    });
  });

  it("classifies explicit exhaustion as complete", async () => {
    const adapter = fakeAdapter([
      page([itemAt("2026-07-31T09:00:00Z", "one")], null, true),
    ]);
    expect((await runSourceBackfill(await sourceContext(adapter))).status)
      .toBe("complete");
  });

  it("classifies a repeated cursor as partial", async () => {
    const adapter = fakeAdapter([
      page([itemAt("2026-07-31T09:00:00Z", "one")], "same"),
      page([itemAt("2026-07-31T08:00:00Z", "two")], "same"),
    ]);
    const result = await runSourceBackfill(await sourceContext(adapter));
    expect(result).toMatchObject({ status: "partial", pagesFetched: 2 });
    expect(result.error).toContain("游标");
  });

  it("stops partial after two pages without new unique items", async () => {
    const duplicate = itemAt("2026-07-31T09:00:00Z", "same");
    const adapter = fakeAdapter([
      page([duplicate], "1"),
      page([duplicate], "2"),
      page([duplicate], "3"),
    ]);
    const result = await runSourceBackfill(await sourceContext(adapter));
    expect(result).toMatchObject({ status: "partial", pagesFetched: 3 });
    expect(result.error).toContain("连续两页");
  });

  it("marks first failure failed and later failure partial", async () => {
    const first = fakeAdapter([new Error("offline")]);
    expect((await runSourceBackfill(await sourceContext(first))).status)
      .toBe("failed");

    const later = fakeAdapter([
      page([itemAt("2026-07-31T09:00:00Z", "one")], "1"),
      new Error("offline"),
    ]);
    expect((await runSourceBackfill(await sourceContext(later))).status)
      .toBe("partial");
  });

  it("keeps missing timestamps partial without cutoff evidence", async () => {
    const adapter = fakeAdapter([
      page([itemAt(null, "unknown")], null, true),
    ]);
    const result = await runSourceBackfill(await sourceContext(adapter));
    expect(result.status).toBe("partial");
    expect(result.error).toContain("时间");
  });

  it("runs at most two sources concurrently and finishes the run", async () => {
    let active = 0;
    let maximum = 0;
    const sourceIds: SourceId[] = [
      "36kr-macro",
      "jiemian-regulatory",
      "jiemian-current-affairs",
      "cls-headline",
    ];
    const adapters: BackfillAdapter[] = sourceIds.map((sourceId) => ({
      sourceId,
      async fetchPage() {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return page([], null, true);
      },
    }));
    const run = await createBackfillRun(testDb.db, {
      sourceIds,
      requestedSourceId: null,
      windowStart,
      windowEnd,
      now,
    });
    const status = await runBackfillSources({
      db: testDb.db,
      runId: run.id,
      adapters,
      windowStart,
      windowEnd,
      now: () => now,
      waitBetweenPages: async () => undefined,
    });
    expect(maximum).toBe(2);
    expect(status).toBe("complete");
    expect((await getBackfillRun(testDb.db, run.id))?.status).toBe("complete");
  });
});
