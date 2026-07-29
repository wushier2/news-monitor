import { load } from "cheerio";
import type { NormalizedItem, SourceId } from "../domain";
import { articleFields } from "./common";

export function parseJiemian(
  html: string,
  sourceId: Extract<SourceId, "jiemian-regulatory" | "jiemian-current-affairs">,
  channelName: "监管通报" | "时事追踪",
): NormalizedItem[] {
  const $ = load(html);
  return $(".columns-right-center__newsflash-item").slice(0, 50).toArray().flatMap((element) => {
    const row = $(element);
    const link = row.find(".columns-right-center__newsflash-content h4 a").first();
    const fields = articleFields({
      sourceId,
      title: link.text(),
      summary: row.find(".columns-right-center__newsflash-content__summary").first().text(),
      url: link.attr("href"),
      publishedAt: row.attr("data-time"),
    }, "https://www.jiemian.com");
    if (!fields.title || !fields.url) return [];
    return [{
      sourceId,
      sourceName: "界面新闻",
      channelName,
      ...fields,
    }];
  });
}
