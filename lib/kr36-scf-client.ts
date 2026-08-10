import type { BackfillPageResult } from "./backfill/types";
import type { NormalizedItem } from "./domain";

interface ClientDependencies {
  url: string;
  token: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function validItem(value: unknown): value is NormalizedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.sourceId === "36kr-macro"
    && item.sourceName === "36Kr"
    && item.channelName === "宏观"
    && typeof item.title === "string"
    && item.title.length > 0
    && typeof item.summary === "string"
    && typeof item.url === "string"
    && item.url.startsWith("https://36kr.com/newsflashes/")
    && (item.publishedAt === null
      || (typeof item.publishedAt === "string"
        && Number.isFinite(Date.parse(item.publishedAt))));
}

function validatePayload(value: unknown): BackfillPageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("36Kr SCF 返回格式无效");
  }
  const payload = value as Record<string, unknown>;
  const cursorValid = payload.nextCursor === null
    || (typeof payload.nextCursor === "string"
      && payload.nextCursor.length > 0
      && payload.nextCursor.length <= 2048);
  if (!Array.isArray(payload.items)
    || payload.items.length > 50
    || !payload.items.every(validItem)
    || !cursorValid
    || typeof payload.exhausted !== "boolean"
    || (payload.exhausted && payload.nextCursor !== null)
    || (!payload.exhausted && typeof payload.nextCursor !== "string")) {
    throw new Error("36Kr SCF 返回格式无效");
  }
  return payload as unknown as BackfillPageResult;
}

function responseError(status: number, text: string): Error {
  let code = "UNKNOWN";
  try {
    code = String((JSON.parse(text) as { error?: unknown }).error ?? code);
  } catch {
    // The upstream body is intentionally not exposed.
  }
  return new Error(
    `36Kr SCF 请求失败(status=${status},code=${code.slice(0, 80)})`,
  );
}

export async function request36KrScfPage(
  cursor: string | null,
  dependencies: ClientDependencies,
): Promise<BackfillPageResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep
    ?? ((milliseconds) => new Promise(
      (resolve) => setTimeout(resolve, milliseconds),
    ));
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(dependencies.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${dependencies.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: "fetchPage", cursor }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 1) throw lastError;
      await sleep(500);
      continue;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 1) throw lastError;
      await sleep(500);
      continue;
    }
    if (!response.ok) {
      const error = responseError(response.status, text);
      if (response.status < 500 || attempt === 1) throw error;
      lastError = error;
      await sleep(500);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("36Kr SCF 返回格式无效");
    }
    return validatePayload(payload);
  }

  throw lastError ?? new Error("36Kr SCF 请求失败");
}

export async function fetch36KrScfPage(
  cursor: string | null,
): Promise<BackfillPageResult> {
  const { env } = await import("cloudflare:workers");
  const bindings = env as typeof env & {
    KR36_SCF_URL?: string;
    KR36_SCF_TOKEN?: string;
  };
  if (!bindings.KR36_SCF_URL || !bindings.KR36_SCF_TOKEN) {
    throw new Error("36Kr SCF 配置缺失");
  }
  return request36KrScfPage(cursor, {
    url: bindings.KR36_SCF_URL,
    token: bindings.KR36_SCF_TOKEN,
  });
}
