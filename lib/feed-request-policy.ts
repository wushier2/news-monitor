export const SEARCH_FILTER_DELAY_MS = 250;

export type FeedFilterChange = "search" | "selection";

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
