import type { SourceId } from "./domain";
import { SOURCE_IDS } from "./sources";

export interface FeedInput {
  query?: string;
  sourceId?: SourceId;
  limit: number;
}

export function parseFeedInput(url: string): FeedInput {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q")?.trim() || undefined;
  if (query && query.length > 100) throw new Error("搜索词不能超过 100 个字符");
  const source = parsed.searchParams.get("source") || undefined;
  if (source && !SOURCE_IDS.has(source as SourceId)) throw new Error("未知来源");
  const requestedLimit = Number(parsed.searchParams.get("limit") ?? 60);
  return {
    query,
    sourceId: source as SourceId | undefined,
    limit: Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 60,
  };
}
