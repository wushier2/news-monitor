import type { NormalizedItem } from "../../lib/domain";

export interface ScfPageResult {
  items: NormalizedItem[];
  nextCursor: string | null;
  exhausted: boolean;
}

export interface ScfResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function fetch36KrPage(
  cursor: string | null,
  dependencies?: {
    fetcher?: typeof fetch;
    now?: () => number;
  },
): Promise<ScfPageResult>;

export function createHandler(dependencies?: {
  token?: string;
  fetcher?: typeof fetch;
}): (event?: Record<string, unknown>) => Promise<ScfResponse>;

export const main_handler: ReturnType<typeof createHandler>;
