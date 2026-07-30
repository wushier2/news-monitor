import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedItem } from "../lib/domain";
import {
  countItemsInRange,
  deleteExpiredItems,
  listFeedPage,
  upsertItems,
} from "../lib/repository";
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

    const page = await listFeedPage(testDb.db, {
      query: "%",
      limit: 50,
      page: 1,
      pageSize: 50,
    });
    expect(page.items.map((row) => row.title)).toEqual(["GDP 增长 100%"]);
    expect(page.totalItems).toBe(1);
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

  it("filters inclusive Beijing minutes and composes with source and query", async () => {
    await upsertItems(testDb.db, [
      item({
        title: "边界政策",
        url: "https://36kr.com/newsflashes/start",
        publishedAt: "2026-07-30T01:30:00.000Z",
      }),
      item({
        title: "边界政策",
        url: "https://36kr.com/newsflashes/end",
        publishedAt: "2026-07-30T10:00:59.999Z",
      }),
      item({
        title: "边界政策",
        url: "https://36kr.com/newsflashes/excluded",
        publishedAt: "2026-07-30T10:01:00.000Z",
      }),
      item({
        sourceId: "cls-headline",
        sourceName: "财联社",
        channelName: "头条",
        title: "边界政策",
        url: "https://www.cls.cn/detail/2",
        publishedAt: "2026-07-30T05:00:00.000Z",
      }),
    ], new Date("2026-07-30T10:02:00.000Z"));

    const page = await listFeedPage(testDb.db, {
      query: "政策",
      sourceId: "36kr-macro",
      limit: 50,
      page: 1,
      pageSize: 50,
      fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T18:01:00+08:00"),
    });

    expect(page.items.map((row) => row.url)).toEqual([
      "https://36kr.com/newsflashes/end",
      "https://36kr.com/newsflashes/start",
    ]);
    expect(page.totalItems).toBe(2);
  });

  it("uses firstSeenAt when publishedAt is missing", async () => {
    await upsertItems(testDb.db, [
      item({
        url: "https://36kr.com/newsflashes/fallback",
        publishedAt: null,
      }),
    ], new Date("2026-07-30T02:15:00.000Z"));

    const page = await listFeedPage(testDb.db, {
      limit: 50,
      page: 1,
      pageSize: 50,
      fromMs: Date.parse("2026-07-30T10:15:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T10:16:00+08:00"),
    });
    expect(page.items.map((row) => row.url))
      .toEqual(["https://36kr.com/newsflashes/fallback"]);
  });

  it("returns numbered pages and the total matching item count", async () => {
    const base = Date.parse("2026-07-29T00:00:00.000Z");
    await upsertItems(
      testDb.db,
      Array.from({ length: 105 }, (_, index) => item({
        title: `分页信息 ${index + 1}`,
        url: `https://36kr.com/newsflashes/page-${index + 1}`,
        publishedAt: new Date(base + index * 60_000).toISOString(),
      })),
      new Date("2026-07-30T00:00:00.000Z"),
    );

    const first = await listFeedPage(testDb.db, {
      limit: 50,
      page: 1,
      pageSize: 50,
    });
    const second = await listFeedPage(testDb.db, {
      limit: 50,
      page: 2,
      pageSize: 50,
    });
    const third = await listFeedPage(testDb.db, {
      limit: 50,
      page: 3,
      pageSize: 50,
    });
    const overflow = await listFeedPage(testDb.db, {
      limit: 50,
      page: 4,
      pageSize: 50,
    });

    expect(first.totalItems).toBe(105);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.title).toBe("分页信息 105");
    expect(second.items).toHaveLength(50);
    expect(second.items[0]?.title).toBe("分页信息 55");
    expect(third.items).toHaveLength(5);
    expect(third.items[0]?.title).toBe("分页信息 5");
    expect(overflow.items).toEqual([]);
  });

  it("uses descending id as a stable tie-breaker", async () => {
    await upsertItems(testDb.db, [
      item({ title: "同刻信息 1", url: "https://36kr.com/newsflashes/tie-1" }),
      item({ title: "同刻信息 2", url: "https://36kr.com/newsflashes/tie-2" }),
      item({ title: "同刻信息 3", url: "https://36kr.com/newsflashes/tie-3" }),
    ], new Date("2026-07-29T10:01:00.000Z"));

    const page = await listFeedPage(testDb.db, {
      limit: 50,
      page: 1,
      pageSize: 50,
    });
    expect(page.items.map((row) => row.title)).toEqual([
      "同刻信息 3",
      "同刻信息 2",
      "同刻信息 1",
    ]);
  });

  it("counts items in an exact time range independently from feed filters", async () => {
    await upsertItems(testDb.db, [
      item({
        url: "https://36kr.com/newsflashes/yesterday",
        publishedAt: "2026-07-29T15:59:59.999Z",
      }),
      item({
        url: "https://36kr.com/newsflashes/today-start",
        publishedAt: "2026-07-29T16:00:00.000Z",
      }),
      item({
        url: "https://36kr.com/newsflashes/today-now",
        publishedAt: "2026-07-30T11:45:30.123Z",
      }),
      item({
        url: "https://36kr.com/newsflashes/future",
        publishedAt: "2026-07-30T11:45:30.124Z",
      }),
    ], new Date("2026-07-30T11:46:00.000Z"));

    expect(await countItemsInRange(testDb.db, {
      fromMs: Date.parse("2026-07-30T00:00:00+08:00"),
      toMs: Date.parse("2026-07-30T11:45:30.123Z"),
    })).toBe(2);
  });
});
