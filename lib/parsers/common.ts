import { normalizeText, normalizeUrl, toIsoDate } from "../normalize";

export function extractAssignedJson(html: string, variable: string): unknown | null {
  const marker = `${variable}=`;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const jsonStart = html.indexOf("{", start + marker.length);
  if (jsonStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(jsonStart, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function articleFields(input: {
  sourceId: Parameters<typeof normalizeUrl>[0];
  title: unknown;
  summary: unknown;
  url: unknown;
  publishedAt: unknown;
}, baseUrl: string) {
  return {
    title: normalizeText(input.title),
    summary: normalizeText(input.summary).slice(0, 500),
    url: normalizeUrl(input.url, baseUrl),
    publishedAt: toIsoDate(input.publishedAt),
  };
}
