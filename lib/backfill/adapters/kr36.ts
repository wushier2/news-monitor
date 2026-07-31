import { md5 } from "js-md5";
import { extractAssignedJson } from "../../parsers/common";
import { parse36KrCandidates, type Kr36Candidate } from "../../parsers/kr36";
import { fetchWithRetry, type Fetcher, type Sleep } from "../http";
import type { BackfillAdapter, BackfillPageResult } from "../types";

const FIRST_PAGE_URL = "https://36kr.com/newsflashes/catalog/4";
const GATEWAY_URL = "https://gateway.36kr.com/api/mis/nav/newsflash/list";
const GATEWAY_FALLBACK_URL = "http://gateway.36kr.com/api/mis/nav/newsflash/list";
const USER_AGENT = "Mozilla/5.0 (compatible; PublicOpinionMonitor/1.0; +https://openai.com)";

interface PageData {
  itemList?: Kr36Candidate[];
  pageCallback?: unknown;
  hasNextPage?: unknown;
}

interface InitialState {
  newsflashCatalogData?: {
    data?: {
      newsflashList?: {
        data?: PageData;
      };
    };
  };
}

interface Kr36Cursor {
  nonce: string;
  pageCallback: string;
}

function pageResult(data: PageData | undefined, nonce: string): BackfillPageResult {
  const callback = typeof data?.pageCallback === "string"
    ? data.pageCallback
    : "";
  const hasNextPage = Boolean(data?.hasNextPage);
  return {
    items: parse36KrCandidates(data?.itemList),
    nextCursor: hasNextPage && nonce && callback
      ? JSON.stringify({ nonce, pageCallback: callback })
      : null,
    exhausted: !hasNextPage,
  };
}

function readNonce(html: string): string {
  return html.match(
    /window\.__GATEWAY_SIGN__\s*=\s*["']([^"']+)["']/,
  )?.[1] ?? "";
}

function readCursor(cursor: string): Kr36Cursor {
  const value = JSON.parse(cursor) as Partial<Kr36Cursor>;
  if (typeof value.nonce !== "string" || typeof value.pageCallback !== "string") {
    throw new Error("Invalid 36Kr backfill cursor");
  }
  return { nonce: value.nonce, pageCallback: value.pageCallback };
}

function isConnectionLost(error: unknown): boolean {
  return error instanceof Error
    && /network connection lost/i.test(error.message);
}

export function create36KrBackfillAdapter(
  dependencies: { fetcher?: Fetcher; now?: () => number; sleep?: Sleep } = {},
): BackfillAdapter {
  const now = dependencies.now ?? Date.now;
  return {
    sourceId: "36kr-macro",
    async fetchPage(cursor) {
      if (cursor === null) {
        const html = await fetchWithRetry(FIRST_PAGE_URL, {
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": USER_AGENT,
          },
        }, {
          fetcher: dependencies.fetcher,
          sleep: dependencies.sleep,
        }, (response) => response.text());
        const state = extractAssignedJson(
          html,
          "window.initialState",
        ) as InitialState | null;
        return pageResult(
          state?.newsflashCatalogData?.data?.newsflashList?.data,
          readNonce(html),
        );
      }

      const current = readCursor(cursor);
      const body = {
        nonce: current.nonce,
        partner_id: "web",
        timestamp: now(),
        param: {
          pageSize: 20,
          pageEvent: 1,
          pageCallback: current.pageCallback,
          siteId: 1,
          type: 4,
          platformId: 2,
        },
      };
      const sign = md5(JSON.stringify(body) + current.nonce);
      const fetchGateway = (gatewayUrl: string) => fetchWithRetry(
        `${gatewayUrl}?sign=${sign}`,
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            origin: "https://36kr.com",
            referer: FIRST_PAGE_URL,
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify(body),
        },
        {
          fetcher: dependencies.fetcher,
          sleep: dependencies.sleep,
        },
        (response) => response.json() as Promise<{ data?: PageData }>,
      );
      let payload: { data?: PageData };
      try {
        payload = await fetchGateway(GATEWAY_URL);
      } catch (error) {
        if (!isConnectionLost(error)) throw error;
        payload = await fetchGateway(GATEWAY_FALLBACK_URL);
      }
      return pageResult(payload.data, current.nonce);
    },
  };
}
