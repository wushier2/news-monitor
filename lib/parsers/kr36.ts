import type { NormalizedItem } from "../domain";
import { articleFields, extractAssignedJson } from "./common";

interface Kr36State {
  newsflashCatalogData?: {
    data?: {
      newsflashList?: {
        data?: {
          itemList?: Array<{
            itemId?: string | number;
            templateMaterial?: {
              widgetTitle?: unknown;
              widgetContent?: unknown;
              publishTime?: unknown;
            };
          }>;
        };
      };
    };
  };
}

export function parse36Kr(html: string): NormalizedItem[] {
  const state = extractAssignedJson(html, "window.initialState") as Kr36State | null;
  const candidates = state?.newsflashCatalogData?.data?.newsflashList?.data?.itemList;
  if (!Array.isArray(candidates)) return [];

  return candidates.slice(0, 50).flatMap((candidate) => {
    const material = candidate.templateMaterial;
    const fields = articleFields({
      sourceId: "36kr-macro",
      title: material?.widgetTitle,
      summary: material?.widgetContent,
      url: candidate.itemId ? `/newsflashes/${candidate.itemId}` : "",
      publishedAt: material?.publishTime,
    }, "https://36kr.com");
    if (!fields.title || !fields.url) return [];
    return [{
      sourceId: "36kr-macro",
      sourceName: "36Kr",
      channelName: "宏观",
      ...fields,
    }];
  });
}
