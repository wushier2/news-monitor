import type { NormalizedItem, SourceId } from "../domain";

export type BackfillSourceStatus =
  | "pending"
  | "running"
  | "complete"
  | "partial"
  | "failed"
  | "interrupted";

export type BackfillRunStatus =
  | "running"
  | "complete"
  | "partial"
  | "failed"
  | "interrupted";

export interface BackfillPageResult {
  items: NormalizedItem[];
  nextCursor: string | null;
  exhausted: boolean;
}

export interface BackfillAdapter {
  sourceId: SourceId;
  fetchPage(cursor: string | null): Promise<BackfillPageResult>;
}

export interface BackfillSourceProgress {
  sourceId: SourceId;
  status: BackfillSourceStatus;
  cursor: string | null;
  pagesFetched: number;
  itemsFetched: number;
  itemsInWindow: number;
  itemsInserted: number;
  itemsExisting: number;
  earliestCoveredAt: string | null;
  error: string | null;
  updatedAt: string;
}

export interface BackfillRun {
  id: number;
  requestedSourceId: SourceId | null;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BackfillRunStatus;
  createdAt: string;
  sources: BackfillSourceProgress[];
}

export interface StartBackfillResponse {
  run: BackfillRun;
  reused: boolean;
}
