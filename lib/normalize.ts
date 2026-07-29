import type { NormalizedItem, SourceId } from "./domain";

const ENTITY_MAP: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/&(?:nbsp|amp|quot|#39|lt|gt);/gi, (entity) => ENTITY_MAP[entity.toLowerCase()] ?? entity)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(value: unknown, baseUrl?: string): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value.trim(), baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|share_)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\?$/, "").replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function toIsoDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" || /^\d{10,13}$/.test(String(value))
    ? Number(value)
    : null;
  const milliseconds = numeric === null ? null : numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds ?? String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function buildDedupeKey(input: {
  sourceId: SourceId;
  url: string;
  title: string;
  publishedAt: string | null;
}): string {
  const url = normalizeUrl(input.url);
  if (url) return `${input.sourceId}:${url}`;
  return `${input.sourceId}:${normalizeText(input.title).toLowerCase()}:${input.publishedAt ?? "unknown"}`;
}

export function validateItem(item: NormalizedItem): NormalizedItem | null {
  const title = normalizeText(item.title);
  const url = normalizeUrl(item.url);
  if (!title || !url) return null;
  return {
    ...item,
    title,
    summary: normalizeText(item.summary).slice(0, 500),
    url,
    publishedAt: toIsoDate(item.publishedAt),
  };
}
