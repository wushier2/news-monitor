import type { FeedItem, NormalizedItem, SourceHealth, SourceId } from "./domain";
import { buildDedupeKey } from "./normalize";
import { SOURCES } from "./sources";

type D1Row = Record<string, unknown>;

export interface FeedQueryOptions {
  query?: string;
  sourceId?: SourceId;
  limit: number;
  page: number;
  pageSize: number;
  fromMs?: number;
  toExclusiveMs?: number;
}

export interface FeedPage {
  items: FeedItem[];
  totalItems: number;
}

export interface UpsertStats {
  inserted: number;
  existing: number;
}

function iso(value: unknown): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function feedFilter(options: FeedQueryOptions): {
  clause: string;
  values: unknown[];
} {
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
  return {
    clause: where.length ? `WHERE ${where.join(" AND ")}` : "",
    values,
  };
}

function feedItem(row: D1Row): FeedItem {
  return {
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
  };
}

export async function upsertItemsWithStats(
  db: D1Database,
  incoming: NormalizedItem[],
  now: Date,
): Promise<UpsertStats> {
  const unique = [...new Map(incoming.map((item) => [
    buildDedupeKey(item),
    item,
  ])).entries()];
  if (!unique.length) return { inserted: 0, existing: 0 };

  const insertResults = await db.batch(unique.map(([dedupeKey, item]) => (
    db.prepare(`
      INSERT INTO items (
        dedupe_key, source_id, source_name, channel_name, title, summary, url,
        published_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
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
    )
  )));
  const inserted = insertResults.reduce(
    (sum, result) => sum + Number(result.meta.changes ?? 0),
    0,
  );

  await db.batch(unique.map(([dedupeKey, item]) => db.prepare(`
    UPDATE items SET
      title = ?,
      summary = ?,
      url = ?,
      published_at = COALESCE(?, published_at),
      last_seen_at = ?
    WHERE dedupe_key = ?
  `).bind(
    item.title,
    item.summary,
    item.url,
    item.publishedAt ? Date.parse(item.publishedAt) : null,
    now.getTime(),
    dedupeKey,
  )));

  return { inserted, existing: unique.length - inserted };
}

export async function upsertItems(
  db: D1Database,
  incoming: NormalizedItem[],
  now: Date,
): Promise<number> {
  await upsertItemsWithStats(db, incoming, now);
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
  options: Omit<FeedQueryOptions, "page" | "pageSize">,
): Promise<FeedItem[]> {
  const page = await listFeedPage(db, {
    ...options,
    page: 1,
    pageSize: options.limit,
  });
  return page.items;
}

export async function listFeedPage(
  db: D1Database,
  options: FeedQueryOptions,
): Promise<FeedPage> {
  const filter = feedFilter(options);
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM items
    ${filter.clause}
  `).bind(...filter.values).first<{ count: number }>();
  const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
  const page = Math.max(options.page, 1);
  const values = [...filter.values, pageSize, (page - 1) * pageSize];
  const result = await db.prepare(`
    SELECT id, source_id, source_name, channel_name, title, summary, url,
      published_at, first_seen_at, last_seen_at
    FROM items
    ${filter.clause}
    ORDER BY COALESCE(published_at, first_seen_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `).bind(...values).all<D1Row>();
  return {
    items: result.results.map(feedItem),
    totalItems: Number(countRow?.count ?? 0),
  };
}

export async function countItemsInRange(
  db: D1Database,
  range: { fromMs: number; toMs: number },
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM items
    WHERE COALESCE(published_at, first_seen_at) >= ?
      AND COALESCE(published_at, first_seen_at) <= ?
  `).bind(range.fromMs, range.toMs).first<{ count: number }>();
  return Number(row?.count ?? 0);
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
