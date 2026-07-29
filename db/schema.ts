import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  sourceId: text("source_id").notNull(),
  sourceName: text("source_name").notNull(),
  channelName: text("channel_name").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  url: text("url").notNull(),
  publishedAt: integer("published_at", { mode: "timestamp_ms" }),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("items_published_at_idx").on(table.publishedAt),
  index("items_source_id_idx").on(table.sourceId),
  index("items_first_seen_at_idx").on(table.firstSeenAt),
]);

export const sourceStatus = sqliteTable("source_status", {
  sourceId: text("source_id").primaryKey(),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
  status: text("status").notNull().default("idle"),
  error: text("error"),
  itemCount: integer("item_count").notNull().default(0),
});

export const ingestionRuns = sqliteTable("ingestion_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  status: text("status").notNull(),
  successCount: integer("success_count").notNull().default(0),
  failureCount: integer("failure_count").notNull().default(0),
});
