const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const LOCAL_MINUTE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const BEIJING_ISO_MINUTE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00\+08:00$/;

export interface AppliedTimeRange {
  from: string;
  to: string;
}

export interface TimeRangeBounds {
  fromMs?: number;
  toExclusiveMs?: number;
}

function assertValidParts(match: RegExpMatchArray): void {
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 || month > 12 ||
    day < 1 || day > lastDay ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59
  ) {
    throw new Error("时间格式不正确");
  }
}

export function toBeijingIsoMinute(value: string): string {
  const match = value.match(LOCAL_MINUTE);
  if (!match) throw new Error("时间格式不正确");
  assertValidParts(match);
  return `${value}:00+08:00`;
}

export function parseBeijingRange(
  from: string | undefined,
  to: string | undefined,
  now = Date.now(),
): TimeRangeBounds {
  if (!from && !to) return {};
  if (!from || !to) throw new Error("请同时选择开始和结束时间");

  const fromMatch = from.match(BEIJING_ISO_MINUTE);
  const toMatch = to.match(BEIJING_ISO_MINUTE);
  if (!fromMatch || !toMatch) {
    throw new Error("时间必须精确到分钟并使用 +08:00");
  }
  assertValidParts(fromMatch);
  assertValidParts(toMatch);

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs > toMs) throw new Error("开始时间不能晚于结束时间");

  const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const retentionMinute =
    Math.floor((now - 7 * DAY_MS) / MINUTE_MS) * MINUTE_MS;
  if (fromMs < retentionMinute || toMs < retentionMinute) {
    throw new Error("只能筛选最近 7 天的数据");
  }
  if (fromMs > currentMinute || toMs > currentMinute) {
    throw new Error("不能选择未来时间");
  }
  return { fromMs, toExclusiveMs: toMs + MINUTE_MS };
}

export function validateBeijingLocalRange(
  from: string,
  to: string,
  now = Date.now(),
): TimeRangeBounds {
  if (!from || !to) throw new Error("请同时选择开始和结束时间");
  return parseBeijingRange(
    toBeijingIsoMinute(from),
    toBeijingIsoMinute(to),
    now,
  );
}

function beijingMinuteValue(timestamp: number): string {
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
}

export function getBeijingInputBounds(now = Date.now()): {
  min: string;
  max: string;
} {
  const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  return {
    min: beijingMinuteValue(currentMinute - 7 * DAY_MS),
    max: beijingMinuteValue(currentMinute),
  };
}

export function formatTimeRangeLabel(range: AppliedTimeRange): string {
  return `${range.from.slice(5).replace("T", " ")} → ${range.to.slice(5).replace("T", " ")}`;
}
