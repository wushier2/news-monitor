import type { SourceId } from "./domain";
import { fetchSource } from "./fetch-source";
import {
  deleteExpiredItems,
  finishRun,
  getSourceStatuses,
  setSourceFailure,
  setSourceSuccess,
  startRun,
  upsertItems,
} from "./repository";
import { shouldIngestSource } from "./source-interval-policy";
import { SOURCES } from "./sources";

export interface IngestionSummary {
  status: "success" | "partial" | "error";
  successCount: number;
  failureCount: number;
  itemCount: number;
  refreshedAt: string;
}

interface IngestionOptions {
  force?: boolean;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown source error";
  return message.replace(/\s+/g, " ").slice(0, 240);
}

export async function runIngestion(
  db: D1Database,
  now = new Date(),
  options: IngestionOptions = {},
): Promise<IngestionSummary> {
  const runId = await startRun(db, now);
  const force = options.force === true;
  const statuses = force ? [] : await getSourceStatuses(db);
  const lastAttemptBySource = new Map(statuses.map((status) => [
    status.sourceId,
    status.lastAttemptAt ? new Date(status.lastAttemptAt) : null,
  ]));
  const dueSources = SOURCES.filter((source) => shouldIngestSource(
    source.id,
    lastAttemptBySource.get(source.id) ?? null,
    now,
    force,
  ));
  const results = await Promise.allSettled(dueSources.map(async (source) => {
    const items = await fetchSource(source);
    if (!items.length) throw new Error("No valid items found");
    await upsertItems(db, items, now);
    await setSourceSuccess(db, source.id, now, items.length);
    return items.length;
  }));

  let successCount = 0;
  let failureCount = 0;
  let itemCount = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") {
      successCount += 1;
      itemCount += result.value;
    } else {
      failureCount += 1;
      await setSourceFailure(
        db,
        dueSources[index].id as SourceId,
        now,
        safeError(result.reason),
      );
    }
  }

  await deleteExpiredItems(db, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  const status = failureCount === 0 ? "success" : successCount > 0 ? "partial" : "error";
  await finishRun(db, runId, new Date(), status, successCount, failureCount);
  return {
    status,
    successCount,
    failureCount,
    itemCount,
    refreshedAt: now.toISOString(),
  };
}
