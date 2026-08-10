import { describe, expect, it } from "vitest";
import type { FeedItem } from "../lib/domain";
import { partitionFeedItemsByBeijingDate } from "../lib/feed-date-groups";

function item(
  id: number,
  publishedAt: string | null,
  firstSeenAt = "2026-08-10T00:00:00.000Z",
): FeedItem {
  return {
    id,
    publishedAt,
    firstSeenAt,
    lastSeenAt: firstSeenAt,
    sourceId: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    title: `资讯 ${id}`,
    summary: "",
    url: `https://example.test/${id}`,
  };
}

describe("feed date groups", () => {
  it("keeps adjacent items on one Beijing day under one divider", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "2026-08-10T15:59:00.000Z"),
      item(2, "2026-08-10T00:01:00.000Z"),
    ])).toEqual([{
      id: "2026-08-10-0",
      dateKey: "2026-08-10",
      label: "08月10日 · 周一",
      items: [
        item(1, "2026-08-10T15:59:00.000Z"),
        item(2, "2026-08-10T00:01:00.000Z"),
      ],
    }]);
  });

  it("starts a new divider when adjacent items cross a Beijing date", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "2026-08-10T15:59:00.000Z"),
      item(2, "2026-08-10T16:00:00.000Z"),
    ]).map(({ dateKey, label, items }) => ({
      dateKey,
      label,
      ids: items.map(({ id }) => id),
    }))).toEqual([
      { dateKey: "2026-08-10", label: "08月10日 · 周一", ids: [1] },
      { dateKey: "2026-08-11", label: "08月11日 · 周二", ids: [2] },
    ]);
  });

  it("uses first seen time when published time is missing", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, null, "2026-08-09T16:30:00.000Z"),
    ])[0]).toMatchObject({
      dateKey: "2026-08-10",
      label: "08月10日 · 周一",
    });
  });

  it("leaves an invalid timestamp without a date divider", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "not-a-date", "also-not-a-date"),
    ])[0]).toMatchObject({
      dateKey: null,
      label: null,
      items: [item(1, "not-a-date", "also-not-a-date")],
    });
  });
});
