export const REFRESH_INTERVAL_MS = 300_000;

export function refreshEndpoint(force: boolean): string {
  return force ? "/api/refresh?force=1" : "/api/refresh";
}

export function shouldAutoRefresh(lastSuccessAt: string | null, now = Date.now()): boolean {
  if (!lastSuccessAt) return true;
  const lastSuccess = Date.parse(lastSuccessAt);
  return Number.isNaN(lastSuccess) || now - lastSuccess >= REFRESH_INTERVAL_MS;
}

export function shouldRefresh(lastSuccess: Date | null, now = new Date()): boolean {
  return !lastSuccess || now.getTime() - lastSuccess.getTime() >= REFRESH_INTERVAL_MS;
}

export function retryAfterSeconds(lastSuccess: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((REFRESH_INTERVAL_MS - (now.getTime() - lastSuccess.getTime())) / 1000));
}
