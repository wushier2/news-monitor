import type { NormalizedItem } from "../domain";
import { articleFields } from "./common";

export interface ClsArticle {
  id?: string | number;
  article_id?: string | number;
  title?: unknown;
  name?: unknown;
  brief?: unknown;
  ctime?: unknown;
  external_link?: unknown;
}

export function parseClsCandidates(candidates: unknown): NormalizedItem[] {
  if (!Array.isArray(candidates)) return [];
  const seen = new Set<string>();
  return (candidates as ClsArticle[]).flatMap((candidate) => {
    const id = candidate.id ?? candidate.article_id;
    const fields = articleFields({
      sourceId: "cls-headline",
      title: candidate.title ?? candidate.name,
      summary: candidate.brief,
      url: candidate.external_link || (id ? `/detail/${id}` : ""),
      publishedAt: candidate.ctime,
    }, "https://www.cls.cn");
    if (!fields.title || !fields.url || seen.has(fields.url)) return [];
    seen.add(fields.url);
    return [{
      sourceId: "cls-headline",
      sourceName: "财联社",
      channelName: "头条",
      ...fields,
    }];
  });
}

export function parseCls(payload: string): NormalizedItem[] {
  let parsed: {
    data?: {
      top_article?: ClsArticle[];
      depth_list?: ClsArticle[];
    };
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  const candidates = [
    ...(Array.isArray(parsed.data?.top_article) ? parsed.data.top_article : []),
    ...(Array.isArray(parsed.data?.depth_list) ? parsed.data.depth_list : []),
  ];
  return parseClsCandidates(candidates.slice(0, 50));
}
