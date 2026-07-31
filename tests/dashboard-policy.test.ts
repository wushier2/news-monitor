import { describe, expect, it } from "vitest";
import { getPageTokens } from "../lib/pagination";
import { REFRESH_INTERVAL_MS, shouldAutoRefresh } from "../lib/refresh-policy";
import {
  formatTimeRangeLabel,
  getBeijingInputBounds,
} from "../lib/time-range";
import {
  BACKFILL_STATUS_LABELS,
  backfillStatusLabel,
  backfillSummary,
} from "../lib/backfill/presentation";
import type { BackfillRun } from "../lib/backfill/types";

describe("dashboard refresh policy", () => {
  const now = Date.parse("2026-07-29T10:00:00.000Z");

  it("uses one five-minute polling interval", () => {
    expect(REFRESH_INTERVAL_MS).toBe(300_000);
  });

  it("refreshes missing and stale dashboard data but skips fresh data", () => {
    expect(shouldAutoRefresh(null, now)).toBe(true);
    expect(shouldAutoRefresh("2026-07-29T09:55:00.000Z", now)).toBe(true);
    expect(shouldAutoRefresh("2026-07-29T09:59:00.000Z", now)).toBe(false);
  });

  it("shows compact applied range text", () => {
    expect(formatTimeRangeLabel({
      from: "2026-07-29T09:30",
      to: "2026-07-30T18:00",
    })).toBe("07-29 09:30 → 07-30 18:00");
  });

  it("limits picker inputs to the latest seven Beijing days", () => {
    expect(getBeijingInputBounds(
      Date.parse("2026-07-30T03:45:30.000Z"),
    )).toEqual({
      min: "2026-07-23T11:45",
      max: "2026-07-30T11:45",
    });
  });

  it("keeps at most five numeric page buttons", () => {
    const tokens = getPageTokens(50, 100);
    expect(tokens.filter((token) => typeof token === "number")).toHaveLength(5);
    expect(tokens).toEqual([
      1,
      "ellipsis-left",
      49,
      50,
      51,
      "ellipsis-right",
      100,
    ]);
  });

  it("provides a Chinese label for every backfill source status", () => {
    expect(Object.keys(BACKFILL_STATUS_LABELS)).toEqual([
      "pending",
      "running",
      "complete",
      "partial",
      "failed",
      "interrupted",
    ]);
    expect(backfillStatusLabel("complete")).toBe("完整");
    expect(backfillStatusLabel("partial")).toBe("部分完成");
  });

  it("summarizes inserted totals across all sources", () => {
    const run = {
      status: "complete",
      sources: [
        { itemsInserted: 12 },
        { itemsInserted: 8 },
      ],
    } as BackfillRun;
    expect(backfillSummary(run)).toBe("补采结束，共新增 20 条");
    expect(backfillSummary({ ...run, status: "running" }))
      .toBe("补采进行中，已新增 20 条");
  });
});
