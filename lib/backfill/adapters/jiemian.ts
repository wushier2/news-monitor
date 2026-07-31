import { load } from "cheerio";
import {
  parseJiemian,
  parseJiemianCandidates,
  type JiemianCandidate,
  type JiemianSourceId,
} from "../../parsers/jiemian";
import { fetchWithRetry, type Fetcher } from "../http";
import type { BackfillAdapter } from "../types";

const API_URL = "https://papi.jiemian.com/page/api/kuaixun/getlistmore";
const USER_AGENT = "Mozilla/5.0 (compatible; PublicOpinionMonitor/1.0; +https://openai.com)";

const CHANNELS = {
  "jiemian-regulatory": {
    cid: "1330kb",
    tagid: "1330",
    channelName: "监管通报",
  },
  "jiemian-current-affairs": {
    cid: "1325kb",
    tagid: "1325",
    channelName: "时事追踪",
  },
} as const;

interface JiemianCursor {
  startTime: number;
  page: number;
}

function readCursor(cursor: string): JiemianCursor {
  const value = JSON.parse(cursor) as Partial<JiemianCursor>;
  if (!Number.isFinite(value.startTime) || !Number.isInteger(value.page)) {
    throw new Error("Invalid Jiemian backfill cursor");
  }
  return { startTime: Number(value.startTime), page: Number(value.page) };
}

function lastPublishTime(candidates: JiemianCandidate[]): number | null {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const value = Number(candidates[index]?.publishtime);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function createJiemianBackfillAdapter(
  sourceId: JiemianSourceId,
  dependencies: { fetcher?: Fetcher } = {},
): BackfillAdapter {
  const channel = CHANNELS[sourceId];
  const firstPageUrl = `https://www.jiemian.com/lists/${channel.cid}.html`;
  return {
    sourceId,
    async fetchPage(cursor) {
      if (cursor === null) {
        const response = await fetchWithRetry(firstPageUrl, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": USER_AGENT,
          },
        }, { fetcher: dependencies.fetcher });
        const html = await response.text();
        const $ = load(html);
        const button = $("#load-list").first();
        const lastTime = Number(
          button.attr("data-time")
          ?? $(".columns-right-center__newsflash-item").last().attr("data-time"),
        );
        const page = Number(button.attr("page") ?? 2);
        const hasNext = button.length > 0
          && Number.isFinite(lastTime)
          && Number.isInteger(page);
        return {
          items: parseJiemian(html, sourceId, channel.channelName),
          nextCursor: hasNext
            ? JSON.stringify({ startTime: lastTime, page })
            : null,
          exhausted: button.length === 0,
        };
      }

      const current = readCursor(cursor);
      const url = `${API_URL}?cid=${channel.cid}`
        + `&start_time=${current.startTime}&page=${current.page}`
        + `&tagid=${channel.tagid}`;
      const response = await fetchWithRetry(url, {
        headers: {
          accept: "application/json",
          referer: firstPageUrl,
          "user-agent": USER_AGENT,
        },
      }, { fetcher: dependencies.fetcher });
      const payload = await response.json() as {
        code?: string | number;
        result?: { hideBtn?: boolean; list?: JiemianCandidate[] };
      };
      if (String(payload.code) !== "0") {
        throw new Error(`Jiemian API error: ${String(payload.code)}`);
      }
      const candidates = Array.isArray(payload.result?.list)
        ? payload.result.list
        : [];
      const startTime = lastPublishTime(candidates);
      const exhausted = payload.result?.hideBtn === true;
      return {
        items: parseJiemianCandidates(
          candidates,
          sourceId,
          channel.channelName,
        ),
        nextCursor: !exhausted && startTime !== null
          ? JSON.stringify({ startTime, page: current.page + 1 })
          : null,
        exhausted,
      };
    },
  };
}
