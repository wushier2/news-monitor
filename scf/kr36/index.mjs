import { createHash, timingSafeEqual } from "node:crypto";

const FIRST_PAGE_URL = "https://www.36kr.com/newsflashes/catalog/4";
const GATEWAY_URL = "https://gateway.36kr.com/api/mis/nav/newsflash/list";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function readCursor(cursor) {
  if (cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 2048) {
    throw new Error("KR36_INVALID_CURSOR");
  }
  let value;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new Error("KR36_INVALID_CURSOR");
  }
  if (!value || typeof value.nonce !== "string"
    || typeof value.pageCallback !== "string"
    || !value.nonce || !value.pageCallback) {
    throw new Error("KR36_INVALID_CURSOR");
  }
  return { nonce: value.nonce, pageCallback: value.pageCallback };
}

function nonceFromHtml(html) {
  return html.match(
    /window\.__GATEWAY_SIGN__\s*=\s*["']([^"']+)["']/,
  )?.[1] ?? "";
}

function isRiskPage(html) {
  return /captcha|访问过于频繁|安全验证|人机验证|cf-chl-|verifycenter/i
    .test(html);
}

function normalize(candidate) {
  const material = candidate?.templateMaterial;
  const title = typeof material?.widgetTitle === "string"
    ? material.widgetTitle.trim()
    : "";
  const itemId = candidate?.itemId;
  if (!itemId || !title) return null;
  const published = Number(material?.publishTime);
  return {
    sourceId: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    title,
    summary: typeof material.widgetContent === "string"
      ? material.widgetContent.trim()
      : "",
    url: `https://36kr.com/newsflashes/${itemId}`,
    publishedAt: Number.isFinite(published)
      ? new Date(published).toISOString()
      : null,
  };
}

async function readSuccessfulText(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`KR36_HTTP_${response.status}`);
  return text;
}

export async function fetch36KrPage(cursor, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const current = readCursor(cursor);
  let nonce = current?.nonce ?? "";

  if (!current) {
    const response = await fetcher(FIRST_PAGE_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        referer: "https://www.36kr.com/",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await readSuccessfulText(response);
    const bytes = Buffer.byteLength(html);
    const type = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim() || "unknown";
    if (isRiskPage(html)) {
      throw new Error(
        `KR36_RISK_PAGE(status=${response.status},type=${type},bytes=${bytes})`,
      );
    }
    nonce = nonceFromHtml(html);
    if (!nonce) {
      throw new Error(
        `KR36_NO_SIGN(status=${response.status},type=${type},bytes=${bytes})`,
      );
    }
  }

  const param = current
    ? {
        pageSize: 20,
        pageEvent: 1,
        pageCallback: current.pageCallback,
        siteId: 1,
        type: 4,
        platformId: 2,
      }
    : {
        pageSize: 20,
        pageEvent: 0,
        siteId: 1,
        type: 4,
        platformId: 2,
      };
  const body = {
    nonce,
    partner_id: "web",
    timestamp: now(),
    param,
  };
  const bodyText = JSON.stringify(body);
  const sign = createHash("md5").update(bodyText + nonce).digest("hex");
  const response = await fetcher(`${GATEWAY_URL}?sign=${sign}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.36kr.com",
      referer: FIRST_PAGE_URL,
      "user-agent": USER_AGENT,
    },
    body: bodyText,
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await readSuccessfulText(response);
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("KR36_INVALID_JSON");
  }
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.itemList)) {
    throw new Error("KR36_INVALID_LIST");
  }

  const items = payload.data.itemList.map(normalize).filter(Boolean);
  const pageCallback = typeof payload.data.pageCallback === "string"
    ? payload.data.pageCallback
    : "";
  const exhausted = !payload.data.hasNextPage;
  return {
    items,
    nextCursor: !exhausted && pageCallback
      ? JSON.stringify({ nonce, pageCallback })
      : null,
    exhausted,
  };
}

function json(statusCode, value) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  };
}

export function createHandler(dependencies = {}) {
  const token = dependencies.token ?? process.env.KR36_SCF_TOKEN ?? "";
  const fetcher = dependencies.fetcher ?? fetch;
  return async function handler(event = {}) {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "METHOD_NOT_ALLOWED" });
    }
    const authorization = event.headers?.authorization
      ?? event.headers?.Authorization
      ?? "";
    if (!token || !safeEqual(authorization, `Bearer ${token}`)) {
      return json(401, { error: "UNAUTHORIZED" });
    }

    let input;
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : event.body ?? "";
      input = JSON.parse(body);
    } catch {
      return json(400, { error: "INVALID_JSON" });
    }
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(
        (key) => !["operation", "cursor"].includes(key),
      )
      || input.operation !== "fetchPage"
      || !(input.cursor === null || typeof input.cursor === "string")) {
      return json(400, { error: "INVALID_REQUEST" });
    }

    try {
      return json(200, await fetch36KrPage(input.cursor, { fetcher }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "KR36_UNKNOWN";
      const status = /timeout/i.test(message)
        ? 504
        : /INVALID_CURSOR/.test(message)
          ? 400
          : 502;
      return json(status, { error: message.slice(0, 200) });
    }
  };
}

export const main_handler = createHandler();
