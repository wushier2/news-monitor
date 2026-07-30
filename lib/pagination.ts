import type { SourceId } from "./domain";
import {
  type AppliedTimeRange,
  toBeijingIsoMinute,
} from "./time-range";

export type PageToken =
  | number
  | "ellipsis-left"
  | "ellipsis-right";

export function getPageTokens(
  page: number,
  totalPages: number,
): PageToken[] {
  if (totalPages < 1) return [];
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (page <= 3) {
    return [1, 2, 3, 4, "ellipsis-right", totalPages];
  }
  if (page >= totalPages - 2) {
    return [
      1,
      "ellipsis-left",
      totalPages - 3,
      totalPages - 2,
      totalPages - 1,
      totalPages,
    ];
  }
  return [
    1,
    "ellipsis-left",
    page - 1,
    page,
    page + 1,
    "ellipsis-right",
    totalPages,
  ];
}

export function buildFeedSearchParams(options: {
  query: string;
  sourceId: SourceId | "all";
  range: AppliedTimeRange | null;
  page: number;
  pageSize: number;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (options.query.trim()) params.set("q", options.query.trim());
  if (options.sourceId !== "all") {
    params.set("source", options.sourceId);
  }
  if (options.range) {
    params.set("from", toBeijingIsoMinute(options.range.from));
    params.set("to", toBeijingIsoMinute(options.range.to));
  }
  params.set("page", String(options.page));
  params.set("pageSize", String(options.pageSize));
  return params;
}
