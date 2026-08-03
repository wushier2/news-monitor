export type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export type Sleep = (milliseconds: number) => Promise<void>;
export type ResponseReader<T> = (response: Response) => Promise<T>;

interface FetchWithRetryDependencies {
  fetcher?: Fetcher;
  sleep?: Sleep;
  shouldRetryError?: (error: unknown) => boolean;
}

const defaultSleep: Sleep = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

export function fetchWithRetry(
  url: string,
  init: RequestInit,
  dependencies?: { fetcher?: Fetcher; sleep?: Sleep },
): Promise<Response>;
export function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  dependencies: FetchWithRetryDependencies,
  read: ResponseReader<T>,
): Promise<T>;
export async function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  dependencies: FetchWithRetryDependencies = {},
  read?: ResponseReader<T>,
): Promise<Response | T> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  let lastStatus = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...init,
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        return read ? await read(response) : response;
      }
    } catch (error) {
      if (dependencies.shouldRetryError?.(error) === false || attempt === 2) {
        throw error;
      }
      await sleep(2 ** attempt * 1_000);
      continue;
    }

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
