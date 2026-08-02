import type { BackfillRun, BackfillSourceStatus } from "./types";

export const BACKFILL_STATUS_LABELS = {
  pending: "等待中",
  running: "采集中",
  complete: "完整",
  partial: "部分完成",
  failed: "失败",
  interrupted: "已中断",
} as const satisfies Record<BackfillSourceStatus, string>;

export function backfillStatusLabel(status: BackfillSourceStatus): string {
  return BACKFILL_STATUS_LABELS[status];
}

export function backfillSummary(run: BackfillRun): string {
  const inserted = run.sources.reduce(
    (sum, source) => sum + source.itemsInserted,
    0,
  );
  return run.status === "running"
    ? `补采进行中，已新增 ${inserted} 条`
    : `补采结束，共新增 ${inserted} 条`;
}

export function shouldAutoExpandBackfill(
  status: BackfillRun["status"] | null,
  hasError: boolean,
): boolean {
  return hasError || status === "running";
}

export function backfillToggleLabel(expanded: boolean): string {
  return expanded ? "收起明细" : "查看明细";
}
