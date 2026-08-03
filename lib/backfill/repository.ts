import type { SourceId } from "../domain";
import { SOURCES } from "../sources";
import type {
  BackfillRun,
  BackfillRunStatus,
  BackfillSourceProgress,
  BackfillSourceStatus,
} from "./types";

type D1Row = Record<string, unknown>;

export interface CreateBackfillRunInput {
  sourceIds: SourceId[];
  requestedSourceId: SourceId | null;
  windowStart: number;
  windowEnd: number;
  now: Date;
}

export interface BackfillSourceUpdate {
  status: BackfillSourceStatus;
  cursor: string | null;
  pagesFetched: number;
  itemsFetched: number;
  itemsInWindow: number;
  itemsInserted: number;
  itemsExisting: number;
  earliestCoveredAt: number | null;
  error: string | null;
}

export interface BackfillRecoveryState {
  cursor: string | null;
  latestError: string | null;
  latestUpdatedAt: number | null;
}

function iso(value: unknown): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function mapSource(row: D1Row): BackfillSourceProgress {
  return {
    sourceId: row.source_id as SourceId,
    status: row.status as BackfillSourceStatus,
    cursor: typeof row.cursor === "string" ? row.cursor : null,
    pagesFetched: Number(row.pages_fetched),
    itemsFetched: Number(row.items_fetched),
    itemsInWindow: Number(row.items_in_window),
    itemsInserted: Number(row.items_inserted),
    itemsExisting: Number(row.items_existing),
    earliestCoveredAt: iso(row.earliest_covered_at),
    error: typeof row.error === "string" ? row.error : null,
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString(),
  };
}

function mapRun(row: D1Row, sources: BackfillSourceProgress[]): BackfillRun {
  return {
    id: Number(row.id),
    requestedSourceId: (row.requested_source_id as SourceId | null) ?? null,
    windowStart: iso(row.window_start) ?? new Date(0).toISOString(),
    windowEnd: iso(row.window_end) ?? new Date(0).toISOString(),
    startedAt: iso(row.started_at) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finished_at),
    status: row.status as BackfillRunStatus,
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    sources,
  };
}

export async function getBackfillRun(
  db: D1Database,
  id: number,
): Promise<BackfillRun | null> {
  const row = await db.prepare(`
    SELECT id, requested_source_id, window_start, window_end, started_at,
      finished_at, status, created_at
    FROM backfill_runs
    WHERE id = ?
  `).bind(id).first<D1Row>();
  if (!row) return null;

  const result = await db.prepare(`
    SELECT source_id, status, cursor, pages_fetched, items_fetched,
      items_in_window, items_inserted, items_existing,
      earliest_covered_at, error, updated_at
    FROM backfill_source_runs
    WHERE run_id = ?
  `).bind(id).all<D1Row>();
  const order = new Map(SOURCES.map((source, index) => [source.id, index]));
  const sources = result.results
    .map(mapSource)
    .sort((left, right) => (
      (order.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER)
      - (order.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER)
    ));
  return mapRun(row, sources);
}

async function getRunFromQuery(
  db: D1Database,
  query: string,
): Promise<BackfillRun | null> {
  const row = await db.prepare(query).first<{ id: number }>();
  return row ? getBackfillRun(db, Number(row.id)) : null;
}

export function findRunningBackfill(db: D1Database): Promise<BackfillRun | null> {
  return getRunFromQuery(db, `
    SELECT id FROM backfill_runs
    WHERE status = 'running'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
}

export function getLatestBackfillRun(db: D1Database): Promise<BackfillRun | null> {
  return getRunFromQuery(db, `
    SELECT id FROM backfill_runs
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
}

export async function getBackfillRecoveryState(
  db: D1Database,
  sourceId: SourceId,
  beforeRunId: number,
): Promise<BackfillRecoveryState> {
  const cursorRow = await db.prepare(`
    SELECT cursor FROM backfill_source_runs
    WHERE source_id = ? AND run_id < ? AND cursor IS NOT NULL
    ORDER BY run_id DESC
    LIMIT 1
  `).bind(sourceId, beforeRunId).first<{ cursor: string }>();
  const latestRow = await db.prepare(`
    SELECT error, updated_at FROM backfill_source_runs
    WHERE source_id = ? AND run_id < ?
    ORDER BY run_id DESC
    LIMIT 1
  `).bind(sourceId, beforeRunId).first<{
    error: string | null;
    updated_at: number;
  }>();
  return {
    cursor: cursorRow?.cursor ?? null,
    latestError: latestRow?.error ?? null,
    latestUpdatedAt: latestRow?.updated_at ?? null,
  };
}

export async function createBackfillRun(
  db: D1Database,
  input: CreateBackfillRunInput,
): Promise<BackfillRun> {
  const timestamp = input.now.getTime();
  const result = await db.prepare(`
    INSERT INTO backfill_runs (
      requested_source_id, window_start, window_end,
      started_at, status, created_at
    ) VALUES (?, ?, ?, ?, 'running', ?)
  `).bind(
    input.requestedSourceId,
    input.windowStart,
    input.windowEnd,
    timestamp,
    timestamp,
  ).run();
  const id = Number(result.meta.last_row_id);
  await db.batch(input.sourceIds.map((sourceId) => db.prepare(`
    INSERT INTO backfill_source_runs (
      run_id, source_id, status, updated_at
    ) VALUES (?, ?, 'pending', ?)
  `).bind(id, sourceId, timestamp)));
  const run = await getBackfillRun(db, id);
  if (!run) throw new Error("Created backfill task could not be read");
  return run;
}

export async function updateBackfillSource(
  db: D1Database,
  runId: number,
  sourceId: SourceId,
  progress: BackfillSourceUpdate,
  now: Date,
): Promise<void> {
  await db.prepare(`
    UPDATE backfill_source_runs SET
      status = ?, cursor = ?, pages_fetched = ?, items_fetched = ?,
      items_in_window = ?, items_inserted = ?, items_existing = ?,
      earliest_covered_at = ?, error = ?, updated_at = ?
    WHERE run_id = ? AND source_id = ?
  `).bind(
    progress.status,
    progress.cursor,
    progress.pagesFetched,
    progress.itemsFetched,
    progress.itemsInWindow,
    progress.itemsInserted,
    progress.itemsExisting,
    progress.earliestCoveredAt,
    progress.error?.slice(0, 240) ?? null,
    now.getTime(),
    runId,
    sourceId,
  ).run();
}

export async function finishBackfillRun(
  db: D1Database,
  runId: number,
  status: Exclude<BackfillRunStatus, "running">,
  now: Date,
): Promise<void> {
  await db.prepare(`
    UPDATE backfill_runs
    SET status = ?, finished_at = ?
    WHERE id = ?
  `).bind(status, now.getTime(), runId).run();
}

export async function interruptRunningBackfills(
  db: D1Database,
  now: Date,
): Promise<number> {
  const row = await db.prepare(`
    SELECT COUNT(*) AS count FROM backfill_runs WHERE status = 'running'
  `).first<{ count: number }>();
  const count = Number(row?.count ?? 0);
  if (!count) return 0;

  await db.prepare(`
    UPDATE backfill_source_runs
    SET status = 'interrupted', error = '服务重启，补采任务已中断', updated_at = ?
    WHERE status IN ('pending', 'running')
      AND run_id IN (SELECT id FROM backfill_runs WHERE status = 'running')
  `).bind(now.getTime()).run();
  await db.prepare(`
    UPDATE backfill_runs
    SET status = 'interrupted', finished_at = ?
    WHERE status = 'running'
  `).bind(now.getTime()).run();
  return count;
}
