import { buildClsSignedUrl } from "../../fetch-source";
import { parseClsCandidates, type ClsArticle } from "../../parsers/cls";
import { fetchWithRetry, type Fetcher } from "../http";
import type { BackfillAdapter } from "../types";

const USER_AGENT = "Mozilla/5.0 (compatible; PublicOpinionMonitor/1.0; +https://openai.com)";

interface ClsCursor {
  lastTime: number;
}

function readCursor(cursor: string): ClsCursor {
  const value = JSON.parse(cursor) as Partial<ClsCursor>;
  if (!Number.isFinite(value.lastTime)) {
    throw new Error("Invalid CLS backfill cursor");
  }
  return { lastTime: Number(value.lastTime) };
}

function lastTime(candidates: ClsArticle[]): number | null {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const value = Number(candidates[index]?.ctime);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function createClsBackfillAdapter(
  dependencies: { fetcher?: Fetcher } = {},
): BackfillAdapter {
  return {
    sourceId: "cls-headline",
    async fetchPage(cursor) {
      const firstPage = cursor === null;
      const url = firstPage
        ? await buildClsSignedUrl("/v3/depth/home/assembled/1000")
        : await buildClsSignedUrl("/v3/depth/list/1000", {
          last_time: String(readCursor(cursor).lastTime),
          rn: "20",
          id: "1000",
        });
      const response = await fetchWithRetry(url, {
        headers: {
          accept: "application/json",
          referer: "https://www.cls.cn/depth?id=1000",
          "user-agent": USER_AGENT,
        },
      }, { fetcher: dependencies.fetcher });
      const payload = await response.json() as {
        errno?: number;
        data?: { depth_list?: ClsArticle[] } | ClsArticle[];
      };
      if (payload.errno !== 0) {
        throw new Error(`CLS API error: ${String(payload.errno)}`);
      }
      const candidates = firstPage
        ? (Array.isArray(payload.data)
          ? []
          : payload.data?.depth_list ?? [])
        : (Array.isArray(payload.data) ? payload.data : []);
      const nextLastTime = lastTime(candidates);
      const exhausted = !firstPage && candidates.length === 0;
      return {
        items: parseClsCandidates(candidates),
        nextCursor: !exhausted && nextLastTime !== null
          ? JSON.stringify({ lastTime: nextLastTime })
          : null,
        exhausted,
      };
    },
  };
}
