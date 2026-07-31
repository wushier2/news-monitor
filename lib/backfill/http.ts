export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  dependencies: { fetcher?: Fetcher; sleep?: Sleep } = {},
): Promise<Response> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return response;

    lastStatus = response.status;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) break;

    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : 2 ** attempt * 1_000);
  }

  throw new Error(`HTTP ${lastStatus}`);
}

export function waitBetweenPages(sleep: Sleep = defaultSleep): Promise<void> {
  return sleep(500);
}
