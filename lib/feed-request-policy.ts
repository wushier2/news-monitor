export const SEARCH_FILTER_DELAY_MS = 250;

export type FeedFilterChange = "search" | "selection";

export type FeedLoadReason =
  | "initial"
  | "search"
  | "source"
  | "time"
  | "page"
  | "refresh";

export interface FeedRequestTicket {
  id: number;
  signal: AbortSignal;
}

export function feedFilterDelay(change: FeedFilterChange): number {
  return change === "search" ? SEARCH_FILTER_DELAY_MS : 0;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

export function feedLoadFailureMessage(
  reason: FeedLoadReason,
  error: unknown,
): string | null {
  if (isAbortError(error)) return null;
  const detail = error instanceof Error ? error.message : "读取失败";
  if (reason === "page") return "分页加载失败";
  if (reason === "source") {
    return `切换失败：${detail}；以下仍为上一次结果`;
  }
  if (reason === "search" || reason === "time") {
    return `筛选失败：${detail}；以下仍为上一次结果`;
  }
  return detail;
}

export class FeedRequestCoordinator {
  private controller: AbortController | null = null;
  private sequence = 0;

  begin(): FeedRequestTicket {
    this.controller?.abort();
    this.controller = new AbortController();
    this.sequence += 1;
    return {
      id: this.sequence,
      signal: this.controller.signal,
    };
  }

  isCurrent(ticket: FeedRequestTicket): boolean {
    return ticket.id === this.sequence && !ticket.signal.aborted;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.sequence += 1;
  }
}
