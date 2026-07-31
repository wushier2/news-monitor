import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedItem } from "../lib/domain";
import {
  createBackfillRun,
  findRunningBackfill,
  finishBackfillRun,
  getBackfillRun,
  getLatestBackfillRun,
  interruptRunningBackfills,
  updateBackfillSource,
} from "../lib/backfill/repository";
import { upsertItems, upsertItemsWithStats } from "../lib/repository";
import { createTestD1 } from "./helpers/d1";

const migrations = [
  "../drizzle/0000_first_strong_guy.sql",
  "../drizzle/0001_backfill_runs.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const now = new Date("2026-07-31T10:00:00.000Z");
const later = new Date("2026-07-31T10:05:00.000Z");

function item(id: string): NormalizedItem {
  return {
    sourceId: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    title: `示例 ${id}`,
    summary: "",
    url: `https://example.test/${id}`,
    publishedAt: "2026-07-31T09:00:00.000Z",
  };
}

describe("backfill repository", () => {
  let testDb: ReturnType<typeof createTestD1>;

  beforeEach(() => {
    testDb = createTestD1();
    migrations.forEach((migration) => testDb.sqlite.exec(migration));
  });

  afterEach(() => testDb.sqlite.close());

  it("counts inserted and existing unique items exactly", async () => {
    const first = await upsertItemsWithStats(
      testDb.db,
      [item("1"), item("2")],
      now,
    );
    const second = await upsertItemsWithStats(
      testDb.db,
      [item("2"), item("3"), item("3")],
      later,
    );
    expect(first).toEqual({ inserted: 2, existing: 0 });
    expect(second).toEqual({ inserted: 1, existing: 1 });
    expect(testDb.sqlite.prepare("SELECT COUNT(*) count FROM items").get())
      .toEqual({ count: 3 });
  });

  it("keeps the legacy upsert return value based on input length", async () => {
    expect(await upsertItems(
      testDb.db,
      [item("1"), item("1")],
      now,
    )).toBe(2);
  });

  it("creates, updates, reads, and finishes a run", async () => {
    const run = await createBackfillRun(testDb.db, {
      sourceIds: ["cls-headline", "36kr-macro"],
      requestedSourceId: null,
      windowStart: now.getTime() - 86_400_000,
      windowEnd: now.getTime(),
      now,
    });
    await updateBackfillSource(testDb.db, run.id, "36kr-macro", {
      status: "complete",
      cursor: null,
      pagesFetched: 3,
      itemsFetched: 40,
      itemsInWindow: 32,
      itemsInserted: 20,
      itemsExisting: 12,
      earliestCoveredAt: now.getTime() - 86_400_000,
      error: null,
    }, later);

    expect((await getBackfillRun(testDb.db, run.id))?.sources)
      .toMatchObject([
        { sourceId: "36kr-macro", status: "complete", pagesFetched: 3 },
        { sourceId: "cls-headline", status: "pending" },
      ]);
    expect((await findRunningBackfill(testDb.db))?.id).toBe(run.id);
    expect((await getLatestBackfillRun(testDb.db))?.id).toBe(run.id);

    await finishBackfillRun(testDb.db, run.id, "partial", later);
    expect(await findRunningBackfill(testDb.db)).toBeNull();
    expect(await getBackfillRun(testDb.db, 999)).toBeNull();
  });

  it("interrupts running tasks without overwriting completed sources", async () => {
    const run = await createBackfillRun(testDb.db, {
      sourceIds: ["36kr-macro", "cls-headline"],
      requestedSourceId: null,
      windowStart: now.getTime() - 86_400_000,
      windowEnd: now.getTime(),
      now,
    });
    await updateBackfillSource(testDb.db, run.id, "36kr-macro", {
      status: "complete",
      cursor: null,
      pagesFetched: 1,
      itemsFetched: 2,
      itemsInWindow: 2,
      itemsInserted: 2,
      itemsExisting: 0,
      earliestCoveredAt: now.getTime() - 86_400_000,
      error: null,
    }, now);

    expect(await interruptRunningBackfills(testDb.db, later)).toBe(1);
    const interrupted = await getBackfillRun(testDb.db, run.id);
    expect(interrupted?.status).toBe("interrupted");
    expect(interrupted?.sources.map((source) => source.status))
      .toEqual(["complete", "interrupted"]);
  });

  it("truncates persisted source errors", async () => {
    const run = await createBackfillRun(testDb.db, {
      sourceIds: ["36kr-macro"],
      requestedSourceId: "36kr-macro",
      windowStart: now.getTime() - 86_400_000,
      windowEnd: now.getTime(),
      now,
    });
    await updateBackfillSource(testDb.db, run.id, "36kr-macro", {
      status: "failed",
      cursor: null,
      pagesFetched: 0,
      itemsFetched: 0,
      itemsInWindow: 0,
      itemsInserted: 0,
      itemsExisting: 0,
      earliestCoveredAt: null,
      error: "x".repeat(300),
    }, later);
    expect((await getBackfillRun(testDb.db, run.id))?.sources[0]?.error)
      .toHaveLength(240);
  });
});
