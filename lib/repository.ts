import type { FeedItem, NormalizedItem, SourceHealth, SourceId } from "./domain";
import { buildDedupeKey } from "./normalize";
import { SOURCES } from "./sources";

type D1Row = Record<string, unknown>;

function iso(value: unknown): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

export async function upsertItems(db: D1Database, incoming: NormalizedItem[], now: Date): Promise<number> {
  if (!incoming.length) return 0;
  const statements = incoming.map((item) => {
    const dedupeKey = buildDedupeKey(item);
    return db.prepare(`
      INSERT INTO items (
        dedupe_key, source_id, source_name, channel_name, title, summary, url,
        published_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        title = excluded.title,
        summary = excluded.summary,
        url = excluded.url,
        published_at = COALESCE(excluded.published_at, items.published_at),
        last_seen_at = excluded.last_seen_at
    `).bind(
      dedupeKey,
      item.sourceId,
      item.sourceName,
      item.channelName,
      item.title,
      item.summary,
      item.url,
      item.publishedAt ? Date.parse(item.publishedAt) : null,
      now.getTime(),
      now.getTime(),
    );
  });
  await db.batch(statements);
  return incoming.length;
}

export async function setSourceSuccess(
  db: D1Database,
  sourceId: SourceId,
  now: Date,
  itemCount: number,
): Promise<void> {
  await db.prepare(`
    INSERT INTO source_status (source_id, last_attempt_at, last_success_at, status, error, item_count)
    VALUES (?, ?, ?, 'ok', NULL, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = excluded.last_success_at,
      status = 'ok',
      error = NULL,
      item_count = excluded.item_count
  `).bind(sourceId, now.getTime(), now.getTime(), itemCount).run();
}

export async function setSourceFailure(
  db: D1Database,
  sourceId: SourceId,
  now: Date,
  error: string,
): Promise<void> {
  await db.prepare(`
    INSERT INTO source_status (source_id, last_attempt_at, status, error, item_count)
    VALUES (?, ?, 'error', ?, 0)
    ON CONFLICT(source_id) DO UPDATE SET
      last_attempt_at = excluded.last_attempt_at,
      status = 'error',
      error = excluded.error
  `).bind(sourceId, now.getTime(), error.slice(0, 240)).run();
}

export async function listFeed(
  db: D1Database,
  options: {
    query?: string;
    sourceId?: SourceId;
    limit: number;
    fromMs?: number;
    toExclusiveMs?: number;
  },
): Promise<FeedItem[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (options.sourceId) {
    where.push("source_id = ?");
    values.push(options.sourceId);
  }
  if (options.query) {
    where.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    const escaped = options.query.replace(/[\\%_]/g, "\\$&");
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (options.fromMs !== undefined && options.toExclusiveMs !== undefined) {
    where.push(`
      COALESCE(published_at, first_seen_at) >= ?
      AND COALESCE(published_at, first_seen_at) < ?
    `);
    values.push(options.fromMs, options.toExclusiveMs);
  }
  values.push(Math.min(Math.max(options.limit, 1), 100));
  const result = await db.prepare(`
    SELECT id, source_id, source_name, channel_name, title, summary, url,
      published_at, first_seen_at, last_seen_at
    FROM items
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY COALESCE(published_at, first_seen_at) DESC
    LIMIT ?
  `).bind(...values).all<D1Row>();
  return result.results.map((row) => ({
    id: Number(row.id),
    sourceId: row.source_id as SourceId,
    sourceName: String(row.source_name),
    channelName: String(row.channel_name),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    url: String(row.url),
    publishedAt: iso(row.published_at),
    firstSeenAt: iso(row.first_seen_at) ?? new Date(0).toISOString(),
    lastSeenAt: iso(row.last_seen_at) ?? new Date(0).toISOString(),
  }));
}

export async function getSourceStatuses(db: D1Database): Promise<SourceHealth[]> {
  const result = await db.prepare(`
    SELECT source_id, last_attempt_at, last_success_at, status, error, item_count
    FROM source_status
  `).all<D1Row>();
  const byId = new Map(result.results.map((row) => [String(row.source_id), row]));
  return SOURCES.map((source) => {
    const row = byId.get(source.id);
    return {
      sourceId: source.id,
      lastAttemptAt: iso(row?.last_attempt_at),
      lastSuccessAt: iso(row?.last_success_at),
      status: (row?.status as SourceHealth["status"]) ?? "idle",
      error: row?.error ? String(row.error) : null,
      itemCount: Number(row?.item_count ?? 0),
    };
  });
}

export async function deleteExpiredItems(db: D1Database, cutoff: Date): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM items WHERE COALESCE(published_at, first_seen_at) < ?
  `).bind(cutoff.getTime()).run();
  return result.meta.changes ?? 0;
}

export async function getLastSuccessfulIngestion(db: D1Database): Promise<Date | null> {
  const row = await db.prepare(`
    SELECT MAX(last_success_at) AS last_success_at FROM source_status
  `).first<{ last_success_at: number | null }>();
  return row?.last_success_at ? new Date(row.last_success_at) : null;
}

export async function startRun(db: D1Database, now: Date): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO ingestion_runs (started_at, status) VALUES (?, 'running')
  `).bind(now.getTime()).run();
  return Number(result.meta.last_row_id);
}

export async function finishRun(
  db: D1Database,
  runId: number,
  now: Date,
  status: "success" | "partial" | "error",
  successCount: number,
  failureCount: number,
): Promise<void> {
  await db.prepare(`
    UPDATE ingestion_runs
    SET finished_at = ?, status = ?, success_count = ?, failure_count = ?
    WHERE id = ?
  `).bind(now.getTime(), status, successCount, failureCount, runId).run();
}
