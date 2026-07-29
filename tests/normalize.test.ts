import { describe, expect, it } from "vitest";
import { buildDedupeKey, normalizeText, normalizeUrl, toIsoDate } from "../lib/normalize";

describe("normalization", () => {
  it("collapses whitespace and decodes visible text", () => {
    expect(normalizeText("  货币&nbsp; 政策\n更新  ")).toBe("货币 政策 更新");
  });

  it("removes tracking parameters and fragments", () => {
    expect(normalizeUrl("https://www.cls.cn/detail/123?utm_source=x#top"))
      .toBe("https://www.cls.cn/detail/123");
  });

  it("prefers a canonical URL in the dedupe key", () => {
    expect(buildDedupeKey({
      sourceId: "cls-headline",
      url: "https://www.cls.cn/detail/123?utm_source=x",
      title: "标题",
      publishedAt: "2026-07-29T10:00:00.000Z",
    })).toBe("cls-headline:https://www.cls.cn/detail/123");
  });

  it("normalizes second timestamps", () => {
    expect(toIsoDate(1_785_300_000)).toBe("2026-07-29T04:40:00.000Z");
  });
});
