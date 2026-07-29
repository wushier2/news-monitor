export type SourceId =
  | "36kr-macro"
  | "jiemian-regulatory"
  | "jiemian-current-affairs"
  | "cls-headline";

export interface NormalizedItem {
  sourceId: SourceId;
  sourceName: string;
  channelName: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string | null;
}

export interface FeedItem extends NormalizedItem {
  id: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SourceHealth {
  sourceId: SourceId;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  status: "idle" | "ok" | "error";
  error: string | null;
  itemCount: number;
}

export interface SourceDefinition {
  id: SourceId;
  sourceName: string;
  channelName: string;
  url: string;
}

export interface SourceResult {
  sourceId: SourceId;
  items: NormalizedItem[];
  fetchedAt: string;
}

export interface FeedResponse {
  items: FeedItem[];
  sources: SourceHealth[];
  generatedAt: string;
}

export interface RefreshResponse {
  status: "success" | "partial" | "skipped";
  refreshedAt: string;
  retryAfterSeconds?: number;
}
