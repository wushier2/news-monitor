import { buildDedupeKey } from "../normalize";
import { upsertItemsWithStats } from "../repository";
import {
  finishBackfillRun,
  updateBackfillSource,
  type BackfillSourceUpdate,
} from "./repository";
import type {
  BackfillAdapter,
  BackfillRunStatus,
} from "./types";

export const MAX_PAGES = 100;
export const MAX_EMPTY_UNIQUE_PAGES = 2;
export const SOURCE_CONCURRENCY = 2;

export interface SourceBackfillContext {
  db: D1Database;
  runId: number;
  adapter: BackfillAdapter;
  windowStart: number;
  windowEnd: number;
  now: () => Date;
  waitBetweenPages: () => Promise<void>;
}

export interface BackfillRunContext {
  db: D1Database;
  runId: number;
  adapters: BackfillAdapter[];
  windowStart: number;
  windowEnd: number;
  now: () => Date;
  waitBetweenPages: () => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialProgress(): BackfillSourceUpdate {
  return {
    status: "running",
    cursor: null,
    pagesFetched: 0,
    itemsFetched: 0,
    itemsInWindow: 0,
    itemsInserted: 0,
    itemsExisting: 0,
    earliestCoveredAt: null,
    error: null,
  };
}

export async function runSourceBackfill(
  context: SourceBackfillContext,
): Promise<BackfillSourceUpdate> {
  const progress = initialProgress();
  const seenCursors = new Set<string>();
  const seenItems = new Set<string>();
  let cursor: string | null = null;
  let noNewUniquePages = 0;
  let missingTimestamp = false;

  const persist = async (
    status: BackfillSourceUpdate["status"],
    error: string | null = null,
  ) => {
    progress.status = status;
    progress.error = error;
    await updateBackfillSource(
      context.db,
      context.runId,
      context.adapter.sourceId,
      progress,
      context.now(),
    );
  };

  await persist("running");

  while (progress.pagesFetched < MAX_PAGES) {
    if (cursor !== null) seenCursors.add(cursor);

    let page;
    try {
      page = await context.adapter.fetchPage(cursor);
    } catch (error) {
      const status = progress.pagesFetched === 0 ? "failed" : "partial";
      await persist(status, errorMessage(error));
      return progress;
    }

    progress.pagesFetched += 1;
    progress.itemsFetched += page.items.length;

    let newUniqueItems = 0;
    for (const item of page.items) {
      const key = buildDedupeKey(item);
      if (!seenItems.has(key)) {
        seenItems.add(key);
        newUniqueItems += 1;
      }
    }
    noNewUniquePages = newUniqueItems === 0 ? noNewUniquePages + 1 : 0;

    let cutoffReached = false;
    const inWindow = page.items.filter((item) => {
      const timestamp = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
      if (!Number.isFinite(timestamp)) {
        missingTimestamp = true;
        return false;
      }
      progress.earliestCoveredAt = progress.earliestCoveredAt === null
        ? timestamp
        : Math.min(progress.earliestCoveredAt, timestamp);
      if (timestamp <= context.windowStart) cutoffReached = true;
      return timestamp >= context.windowStart && timestamp <= context.windowEnd;
    });
    progress.itemsInWindow += inWindow.length;
    const stats = await upsertItemsWithStats(context.db, inWindow, context.now());
    progress.itemsInserted += stats.inserted;
    progress.itemsExisting += stats.existing;
    progress.cursor = page.nextCursor;

    if (cutoffReached) {
      await persist("complete");
      return progress;
    }
    if (page.exhausted) {
      await persist(
        missingTimestamp ? "partial" : "complete",
        missingTimestamp ? "部分信息缺少有效发布时间" : null,
      );
      return progress;
    }
    if (page.nextCursor === null) {
      await persist("partial", "来源未提供下一页游标");
      return progress;
    }
    if (seenCursors.has(page.nextCursor)) {
      await persist("partial", "来源返回了重复分页游标");
      return progress;
    }
    if (noNewUniquePages >= MAX_EMPTY_UNIQUE_PAGES) {
      await persist("partial", "连续两页没有发现新的唯一信息");
      return progress;
    }
    if (progress.pagesFetched >= MAX_PAGES) {
      await persist("partial", `已达到每个来源最多 ${MAX_PAGES} 页的限制`);
      return progress;
    }

    await persist("running");
    cursor = page.nextCursor;
    await context.waitBetweenPages();
  }

  await persist("partial", `已达到每个来源最多 ${MAX_PAGES} 页的限制`);
  return progress;
}

export async function runBackfillSources(
  context: BackfillRunContext,
): Promise<Exclude<BackfillRunStatus, "running">> {
  const results = new Array<BackfillSourceUpdate>(context.adapters.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const adapter = context.adapters[index];
      if (!adapter) return;
      results[index] = await runSourceBackfill({
        db: context.db,
        runId: context.runId,
        adapter,
        windowStart: context.windowStart,
        windowEnd: context.windowEnd,
        now: context.now,
        waitBetweenPages: context.waitBetweenPages,
      });
    }
  };

  const workerCount = Math.min(SOURCE_CONCURRENCY, context.adapters.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const status: Exclude<BackfillRunStatus, "running"> = results.every(
    (result) => result.status === "complete",
  )
    ? "complete"
    : results.every((result) => result.status === "failed")
      ? "failed"
      : "partial";
  await finishBackfillRun(context.db, context.runId, status, context.now());
  return status;
}
