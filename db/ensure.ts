const statements = [
  `CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    source_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    published_at INTEGER,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS items_published_at_idx ON items (published_at)`,
  `CREATE INDEX IF NOT EXISTS items_source_id_idx ON items (source_id)`,
  `CREATE INDEX IF NOT EXISTS items_first_seen_at_idx ON items (first_seen_at)`,
  `CREATE TABLE IF NOT EXISTS source_status (
    source_id TEXT PRIMARY KEY NOT NULL,
    last_attempt_at INTEGER,
    last_success_at INTEGER,
    status TEXT NOT NULL DEFAULT 'idle',
    error TEXT,
    item_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ingestion_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS backfill_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_source_id TEXT,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS backfill_runs_status_idx ON backfill_runs (status)`,
  `CREATE TABLE IF NOT EXISTS backfill_source_runs (
    run_id INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL,
    cursor TEXT,
    pages_fetched INTEGER NOT NULL DEFAULT 0,
    items_fetched INTEGER NOT NULL DEFAULT 0,
    items_in_window INTEGER NOT NULL DEFAULT 0,
    items_inserted INTEGER NOT NULL DEFAULT 0,
    items_existing INTEGER NOT NULL DEFAULT 0,
    earliest_covered_at INTEGER,
    error TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, source_id),
    FOREIGN KEY (run_id) REFERENCES backfill_runs (id)
  )`,
];

let initialized = false;

export async function ensureSchema(db: D1Database): Promise<void> {
  if (initialized) return;
  await db.batch(statements.map((statement) => db.prepare(statement)));
  initialized = true;
}
