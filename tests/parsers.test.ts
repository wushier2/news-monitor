import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse36Kr } from "../lib/parsers/kr36";
import { parseCls } from "../lib/parsers/cls";
import { parseJiemian } from "../lib/parsers/jiemian";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("source parsers", () => {
  it("parses 36Kr macro items", () => {
    const items = parse36Kr(fixture("36kr-macro.html"));
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.sourceId === "36kr-macro" && item.url.startsWith("http"))).toBe(true);
  });

  it.each([
    ["jiemian-regulatory.html", "jiemian-regulatory", "监管通报"],
    ["jiemian-current-affairs.html", "jiemian-current-affairs", "时事追踪"],
  ] as const)("parses %s", (name, sourceId, channelName) => {
    const items = parseJiemian(fixture(name), sourceId, channelName);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.sourceId === sourceId && item.channelName === channelName)).toBe(true);
  });

  it("parses CLS headline items", () => {
    const items = parseCls(fixture("cls-headline.html"));
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.sourceId === "cls-headline" && item.url.startsWith("http"))).toBe(true);
  });

  it("never invents data for malformed pages", () => {
    expect(parse36Kr("<html></html>")).toEqual([]);
    expect(parseJiemian("<html></html>", "jiemian-regulatory", "监管通报")).toEqual([]);
    expect(parseCls("{}")).toEqual([]);
  });
});
