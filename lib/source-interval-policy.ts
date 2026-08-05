import type { SourceId } from "./domain";

export const KR36_AUTO_INTERVAL_MS = 15 * 60_000;

export function shouldIngestSource(
  sourceId: SourceId,
  lastAttemptAt: Date | null,
  now: Date,
  force: boolean,
): boolean {
  if (force || sourceId !== "36kr-macro" || !lastAttemptAt) return true;
  return now.getTime() - lastAttemptAt.getTime() >= KR36_AUTO_INTERVAL_MS;
}
