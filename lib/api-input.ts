import type { SourceId } from "./domain";
import { SOURCE_IDS } from "./sources";
import { parseBeijingRange } from "./time-range";

export interface FeedInput {
  query?: string;
  sourceId?: SourceId;
  limit: number;
  page: number;
  pageSize: number;
  fromMs?: number;
  toExclusiveMs?: number;
}

function positiveInteger(
  value: string | null,
  fallback: number,
  label: string,
  maximum?: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || (
    maximum !== undefined && parsed > maximum
  )) {
    throw new Error(`${label}必须是 1${maximum ? ` 至 ${maximum}` : " 以上"}的整数`);
  }
  return parsed;
}

export function parseFeedInput(url: string, now = Date.now()): FeedInput {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q")?.trim() || undefined;
  if (query && query.length > 100) {
    throw new Error("搜索词不能超过 100 个字符");
  }
  const source = parsed.searchParams.get("source") || undefined;
  if (source && !SOURCE_IDS.has(source as SourceId)) {
    throw new Error("未知来源");
  }
  const page = positiveInteger(parsed.searchParams.get("page"), 1, "页码");
  const pageSize = positiveInteger(
    parsed.searchParams.get("pageSize"),
    50,
    "每页条数",
    100,
  );
  const timeRange = parseBeijingRange(
    parsed.searchParams.get("from") || undefined,
    parsed.searchParams.get("to") || undefined,
    now,
  );
  return {
    query,
    sourceId: source as SourceId | undefined,
    limit: pageSize,
    page,
    pageSize,
    ...timeRange,
  };
}
