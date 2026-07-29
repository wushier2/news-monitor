import type { SourceDefinition, SourceId } from "./domain";

export const SOURCES: SourceDefinition[] = [
  {
    id: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    url: "https://36kr.com/newsflashes/catalog/4",
  },
  {
    id: "jiemian-regulatory",
    sourceName: "界面新闻",
    channelName: "监管通报",
    url: "https://www.jiemian.com/lists/1330kb.html",
  },
  {
    id: "jiemian-current-affairs",
    sourceName: "界面新闻",
    channelName: "时事追踪",
    url: "https://www.jiemian.com/lists/1325kb.html",
  },
  {
    id: "cls-headline",
    sourceName: "财联社",
    channelName: "头条",
    url: "https://www.cls.cn/depth?id=1000",
  },
];

export const SOURCE_IDS = new Set<SourceId>(SOURCES.map((source) => source.id));

export function getSource(id: SourceId): SourceDefinition {
  const source = SOURCES.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`Unknown source: ${id}`);
  return source;
}
