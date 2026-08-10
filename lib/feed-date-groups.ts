import type { FeedItem } from "./domain";

export interface FeedDateGroup {
  id: string;
  dateKey: string | null;
  label: string | null;
  items: FeedItem[];
}

const beijingDateParts = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

function getDateDetails(value: string): { key: string; label: string } | null {
  if (!Number.isFinite(Date.parse(value))) return null;

  const parts = new Map<string, string>(
    beijingDateParts
      .formatToParts(new Date(value))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value: part }): [string, string] => [type, part]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const weekday = parts.get("weekday");
  if (!year || !month || !day || !weekday) return null;

  return {
    key: `${year}-${month}-${day}`,
    label: `${month}月${day}日 · ${weekday}`,
  };
}

export function partitionFeedItemsByBeijingDate(
  items: FeedItem[],
): FeedDateGroup[] {
  return items.reduce<FeedDateGroup[]>((groups, item) => {
    const details = getDateDetails(item.publishedAt ?? item.firstSeenAt);
    const previous = groups[groups.length - 1];
    if (details && previous?.dateKey === details.key) {
      previous.items.push(item);
      return groups;
    }

    groups.push({
      id: `${details?.key ?? "undated"}-${groups.length}`,
      dateKey: details?.key ?? null,
      label: details?.label ?? null,
      items: [item],
    });
    return groups;
  }, []);
}
