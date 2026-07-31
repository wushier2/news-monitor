import { md5 } from "js-md5";
import type { NormalizedItem, SourceDefinition } from "./domain";
import { parse36Kr } from "./parsers/kr36";
import { parseCls } from "./parsers/cls";
import { parseJiemian } from "./parsers/jiemian";

const USER_AGENT = "Mozilla/5.0 (compatible; PublicOpinionMonitor/1.0; +https://openai.com)";

async function fetchText(url: string, timeoutMs = 8_000): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/json",
          referer: new URL(url).origin,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        if (response.status !== 429 && response.status < 500) throw error;
        lastError = error;
      } else {
        return response.text();
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^HTTP 4(?!29)/.test(error.message)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Source request failed");
}

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function buildClsSignedUrl(
  path: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const params = {
    app: "CailianpressWeb",
    os: "web",
    sv: "8.7.9",
    ...extra,
  };
  const sorted = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
  const canonical = sorted.map(([key, value]) => `${key}=${value}`).join("&");
  const sign = md5(await sha1Hex(canonical));
  const query = sorted.map(([key, value]) => (
    `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
  )).join("&");
  return `https://www.cls.cn${path}?${query}&sign=${sign}`;
}

export function buildClsUrl(): Promise<string> {
  return buildClsSignedUrl("/v3/depth/home/assembled/1000");
}

export async function fetchSource(source: SourceDefinition): Promise<NormalizedItem[]> {
  if (source.id === "cls-headline") {
    return parseCls(await fetchText(await buildClsUrl()));
  }
  const html = await fetchText(source.url);
  if (source.id === "36kr-macro") return parse36Kr(html);
  if (source.id === "jiemian-regulatory") {
    return parseJiemian(html, source.id, "监管通报");
  }
  return parseJiemian(html, "jiemian-current-affairs", "时事追踪");
}
