import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedItem } from "../lib/domain";
import { deleteExpiredItems, listFeed, upsertItems } from "../lib/repository";
import { createTestD1 } from "./helpers/d1";

const migration = readFileSync(
  new URL("../drizzle/0000_first_strong_guy.sql", import.meta.url),
  "utf8",
);

function item(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    sourceId: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    title: "政策更新",
    summary: "政策摘要",
    url: "https://36kr.com/newsflashes/1",
    publishedAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

describe("monitor repository", () => {
  let testDb: ReturnType<typeof createTestD1>;

  beforeEach(() => {
    testDb = createTestD1();
    testDb.sqlite.exec(migration);
  });

  afterEach(() => testDb.sqlite.close());

  it("deduplicates canonical URLs and advances last-seen time", async () => {
    await upsertItems(testDb.db, [item()], new Date("2026-07-29T10:01:00.000Z"));
    await upsertItems(testDb.db, [
      item({ url: "https://36kr.com/newsflashes/1?utm_source=repeat", title: "更新后的标题" }),
    ], new Date("2026-07-29T10:05:00.000Z"));

    const rows = testDb.sqlite.prepare(
      "SELECT title, first_seen_at, last_seen_at FROM items",
    ).all();
    expect(rows).toEqual([{
      title: "更新后的标题",
      first_seen_at: Date.parse("2026-07-29T10:01:00.000Z"),
      last_seen_at: Date.parse("2026-07-29T10:05:00.000Z"),
    }]);
  });

  it("keeps identical titles from different sources separate", async () => {
    await upsertItems(testDb.db, [
      item(),
      item({
        sourceId: "cls-headline",
        sourceName: "财联社",
        channelName: "头条",
        url: "https://www.cls.cn/detail/1",
      }),
    ], new Date("2026-07-29T10:01:00.000Z"));

    expect(testDb.sqlite.prepare("SELECT COUNT(*) AS count FROM items").get())
      .toEqual({ count: 2 });
  });

  it("escapes LIKE wildcards and orders matching rows newest first", async () => {
    await upsertItems(testDb.db, [
      item({ title: "GDP 增长 100%", url: "https://36kr.com/newsflashes/1" }),
      item({
        title: "GDP 增长 100x",
        url: "https://36kr.com/newsflashes/2",
        publishedAt: "2026-07-29T11:00:00.000Z",
      }),
    ], new Date("2026-07-29T11:01:00.000Z"));

    const rows = await listFeed(testDb.db, { query: "%", limit: 100 });
    expect(rows.map((row) => row.title)).toEqual(["GDP 增长 100%"]);
  });

  it("deletes only rows older than the seven-day cutoff", async () => {
    await upsertItems(testDb.db, [
      item({ url: "https://36kr.com/newsflashes/old", publishedAt: "2026-07-21T09:59:59.000Z" }),
      item({ url: "https://36kr.com/newsflashes/new", publishedAt: "2026-07-21T10:00:00.000Z" }),
    ], new Date("2026-07-29T10:00:00.000Z"));

    expect(await deleteExpiredItems(
      testDb.db,
      new Date("2026-07-21T10:00:00.000Z"),
    )).toBe(1);
    expect(testDb.sqlite.prepare("SELECT url FROM items").all())
      .toEqual([{ url: "https://36kr.com/newsflashes/new" }]);
  });
});
