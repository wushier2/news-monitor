export const REFRESH_INTERVAL_MS = 300_000;

export function shouldRefresh(lastSuccess: Date | null, now = new Date()): boolean {
  return !lastSuccess || now.getTime() - lastSuccess.getTime() >= REFRESH_INTERVAL_MS;
}

export function retryAfterSeconds(lastSuccess: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((REFRESH_INTERVAL_MS - (now.getTime() - lastSuccess.getTime())) / 1000));
}
