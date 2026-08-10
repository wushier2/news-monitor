import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBackfillRun,
  getBackfillRun,
} from "../lib/backfill/repository";
import {
  isBackfillActive,
  reconcileBackfillState,
  startBackfill,
} from "../lib/backfill/runner";
import type { BackfillAdapter } from "../lib/backfill/types";
import { createTestD1 } from "./helpers/d1";

const migrations = [
  "../drizzle/0000_first_strong_guy.sql",
  "../drizzle/0001_backfill_runs.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const now = new Date("2026-07-31T10:00:00.000Z");

describe("backfill runner", () => {
  let testDb: ReturnType<typeof createTestD1>;

  beforeEach(() => {
    testDb = createTestD1();
    migrations.forEach((migration) => testDb.sqlite.exec(migration));
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    testDb.sqlite.close();
  });

  it("creates a fixed 24-hour task and reuses it while active", async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runSources = vi.fn().mockReturnValue(running);
    const createAdapter = (sourceId: BackfillAdapter["sourceId"]): BackfillAdapter => ({
      sourceId,
      async fetchPage() {
        return { items: [], nextCursor: null, exhausted: true };
      },
    });
    const dependencies = {
      createAdapter,
      runSources,
      waitBetweenPages: async () => undefined,
    };

    const first = await startBackfill(testDb.db, {}, now, dependencies);
    const second = await startBackfill(testDb.db, {}, now, dependencies);
    expect(first.reused).toBe(false);
    expect(first.run.sources).toHaveLength(4);
    expect(Date.parse(first.run.windowEnd) - Date.parse(first.run.windowStart))
      .toBe(86_400_000);
    expect(first.completion).toBeInstanceOf(Promise);
    expect(second).toMatchObject({ run: first.run, reused: true });
    expect(second.completion).toBe(first.completion);
    expect(runSources).toHaveBeenCalledTimes(1);
    expect(isBackfillActive()).toBe(true);

    release();
  });

  it("supports a single source request and rejects an unknown source", async () => {
    const runSources = vi.fn().mockResolvedValue("complete");
    const result = await startBackfill(testDb.db, {
      sourceId: "cls-headline",
    }, now, {
      createAdapter: (sourceId) => ({
        sourceId,
        async fetchPage() {
          return { items: [], nextCursor: null, exhausted: true };
        },
      }),
      runSources,
      waitBetweenPages: async () => undefined,
    });
    expect(result.run.requestedSourceId).toBe("cls-headline");
    expect(result.run.sources.map((source) => source.sourceId))
      .toEqual(["cls-headline"]);
    await expect(startBackfill(
      testDb.db,
      { sourceId: "unknown" },
      now,
    )).rejects.toThrow("未知来源");
  });

  it("runs a 36Kr task through the injected SCF-backed adapter", async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
      exhausted: true,
    });
    const runSources = vi.fn(async ({ adapters }: {
      adapters: BackfillAdapter[];
    }) => {
      await adapters[0]!.fetchPage(null);
      return "complete" as const;
    });

    const result = await startBackfill(testDb.db, {
      sourceId: "36kr-macro",
    }, new Date(now.getTime() + 1), {
      createAdapter: (sourceId) => ({ sourceId, fetchPage }),
      runSources,
      waitBetweenPages: async () => undefined,
    });
    await result.completion;

    expect(fetchPage).toHaveBeenCalledWith(null);
  });

  it("marks a database-only running task interrupted after restart", async () => {
    const run = await createBackfillRun(testDb.db, {
      sourceIds: ["36kr-macro"],
      requestedSourceId: "36kr-macro",
      windowStart: now.getTime() - 86_400_000,
      windowEnd: now.getTime(),
      now,
    });
    expect(await reconcileBackfillState(testDb.db, now)).toBe(1);
    expect((await getBackfillRun(testDb.db, run.id))?.status)
      .toBe("interrupted");
  });
});
