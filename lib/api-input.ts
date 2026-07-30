import type { SourceId } from "./domain";
import { SOURCE_IDS } from "./sources";
import { parseBeijingRange } from "./time-range";

export interface FeedInput {
  query?: string;
  sourceId?: SourceId;
  limit: number;
  fromMs?: number;
  toExclusiveMs?: number;
}

export function parseFeedInput(url: string, now = Date.now()): FeedInput {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q")?.trim() || undefined;
  if (query && query.length > 100) throw new Error("搜索词不能超过 100 个字符");
  const source = parsed.searchParams.get("source") || undefined;
  if (source && !SOURCE_IDS.has(source as SourceId)) throw new Error("未知来源");
  const requestedLimit = Number(parsed.searchParams.get("limit") ?? 60);
  const timeRange = parseBeijingRange(
    parsed.searchParams.get("from") || undefined,
    parsed.searchParams.get("to") || undefined,
    now,
  );
  return {
    query,
    sourceId: source as SourceId | undefined,
    limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 60,
    ...timeRange,
  };
}
