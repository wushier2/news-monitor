# Custom Time Range Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Beijing-time, minute-precision custom range filter that is applied by the feed API and D1 query and composes with keyword and source filters.

**Architecture:** A browser-safe `lib/time-range.ts` module owns strict UTC+08:00 parsing, validation, picker bounds, and labels. `parseFeedInput` converts validated `from`/`to` parameters into inclusive-start and exclusive-end millisecond bounds, `listFeed` binds those bounds into the existing parameterized SQL, and the dashboard keeps draft and applied ranges separate so editing does not issue requests.

**Tech Stack:** TypeScript, React 19, vinext route handlers, Cloudflare D1, SQLite, Vitest, CSS

---

## File map

- Create `lib/time-range.ts` — strict Beijing minute parsing, seven-day validation, picker bounds, and display labels.
- Create `tests/time-range.test.ts` — deterministic unit coverage for time conversion and range rules.
- Modify `lib/api-input.ts` — accept `from` and `to` and expose database-ready bounds.
- Modify `tests/api-input.test.ts` — cover valid, missing, reversed, expired, future, and invalid-zone ranges.
- Modify `lib/repository.ts` — append bound time predicates to `listFeed`.
- Modify `tests/repository.test.ts` — verify boundary minutes, fallback time, and combined filters against real SQLite.
- Modify `app/api/feed/route.ts` — classify time validation failures as `400`.
- Modify `tests/api-contract.test.ts` — verify valid bounds reach the repository and invalid ranges stop before database access.
- Modify `app/dashboard.tsx` — add draft/applied range state, request parameters, actions, and accessible controls.
- Modify `tests/dashboard-policy.test.ts` — cover picker bounds and applied-range labels.
- Modify `app/globals.css` — compact desktop and mobile time-range layout.

### Task 1: Add strict Beijing-time range utilities

**Files:**
- Create: `lib/time-range.ts`
- Create: `tests/time-range.test.ts`

- [ ] **Step 1: Write the failing time utility tests**

Create `tests/time-range.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  formatTimeRangeLabel,
  getBeijingInputBounds,
  parseBeijingRange,
  toBeijingIsoMinute,
  validateBeijingLocalRange,
} from "../lib/time-range";

describe("Beijing time range", () => {
  const now = Date.parse("2026-07-30T03:45:30.000Z");

  it("converts a datetime-local value to an explicit UTC+08:00 minute", () => {
    expect(toBeijingIsoMinute("2026-07-30T11:20"))
      .toBe("2026-07-30T11:20:00+08:00");
  });

  it("uses an inclusive start and an exclusive minute after the selected end", () => {
    expect(parseBeijingRange(
      "2026-07-30T09:30:00+08:00",
      "2026-07-30T11:20:00+08:00",
      now,
    )).toEqual({
      fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
    });
  });

  it("allows the current minute and rejects a future minute", () => {
    expect(() => validateBeijingLocalRange(
      "2026-07-30T11:20",
      "2026-07-30T11:45",
      now,
    )).not.toThrow();
    expect(() => validateBeijingLocalRange(
      "2026-07-30T11:20",
      "2026-07-30T11:46",
      now,
    )).toThrow("未来");
  });

  it.each([
    [undefined, "2026-07-30T11:20:00+08:00", "同时"],
    ["2026-07-30T11:20:00+08:00", undefined, "同时"],
    ["2026-07-30T11:20:00Z", "2026-07-30T11:21:00Z", "+08:00"],
    ["2026-07-30T11:30:00+08:00", "2026-07-30T11:20:00+08:00", "晚于"],
    ["2026-07-23T11:44:00+08:00", "2026-07-30T11:20:00+08:00", "最近 7 天"],
  ])("rejects invalid range %s to %s", (from, to, message) => {
    expect(() => parseBeijingRange(from, to, now)).toThrow(message);
  });

  it("returns no bounds when both parameters are absent", () => {
    expect(parseBeijingRange(undefined, undefined, now)).toEqual({});
  });

  it("builds fixed Beijing picker bounds and a compact label", () => {
    expect(getBeijingInputBounds(now)).toEqual({
      min: "2026-07-23T11:45",
      max: "2026-07-30T11:45",
    });
    expect(formatTimeRangeLabel({
      from: "2026-07-29T09:30",
      to: "2026-07-30T18:00",
    })).toBe("07-29 09:30 → 07-30 18:00");
  });
});
```

- [ ] **Step 2: Run the test and verify the RED state**

Run:

```powershell
npm.cmd test -- tests/time-range.test.ts
```

Expected: FAIL because `lib/time-range.ts` does not exist.

- [ ] **Step 3: Implement the complete shared time utility**

Create `lib/time-range.ts`:

```ts
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
  return parseBeijingRange(
    from ? toBeijingIsoMinute(from) : undefined,
    to ? toBeijingIsoMinute(to) : undefined,
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
```

- [ ] **Step 4: Run the time utility tests**

Run:

```powershell
npm.cmd test -- tests/time-range.test.ts
```

Expected: all parameterized and standalone time utility cases pass.

- [ ] **Step 5: Commit the utility**

```powershell
git add lib/time-range.ts tests/time-range.test.ts
git commit -m "feat: add Beijing time range validation"
```

### Task 2: Parse time bounds in feed input

**Files:**
- Modify: `lib/api-input.ts`
- Modify: `tests/api-input.test.ts`

- [ ] **Step 1: Add failing API input tests**

Append to `tests/api-input.test.ts`:

```ts
const now = Date.parse("2026-07-30T03:45:30.000Z");

it("parses a valid Beijing range into database bounds", () => {
  expect(parseFeedInput(
    "https://example.test/api/feed?from=2026-07-30T09%3A30%3A00%2B08%3A00&to=2026-07-30T11%3A20%3A00%2B08%3A00",
    now,
  )).toEqual({
    query: undefined,
    sourceId: undefined,
    limit: 60,
    fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
    toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
  });
});

it("rejects a partial time range", () => {
  expect(() => parseFeedInput(
    "https://example.test/api/feed?from=2026-07-30T09%3A30%3A00%2B08%3A00",
    now,
  )).toThrow("同时");
});
```

- [ ] **Step 2: Run the API input tests and verify failure**

Run:

```powershell
npm.cmd test -- tests/api-input.test.ts
```

Expected: FAIL because `parseFeedInput` does not accept `now` and does not return time bounds.

- [ ] **Step 3: Extend `FeedInput` and `parseFeedInput`**

Replace `lib/api-input.ts` with:

```ts
import type { SourceId } from "./domain";
import { SOURCE_IDS } from "./sources";
import { parseBeijingRange } from "./time-range";

export interface FeedInput {
  query?: string;
  sourceId?: SourceId;
  limit: number;
  fromMs?: number;
  toExclusiveMs?: number;
}

export function parseFeedInput(url: string, now = Date.now()): FeedInput {
  const parsed = new URL(url);
  const query = parsed.searchParams.get("q")?.trim() || undefined;
  if (query && query.length > 100) {
    throw new Error("搜索词不能超过 100 个字符");
  }
  const source = parsed.searchParams.get("source") || undefined;
  if (source && !SOURCE_IDS.has(source as SourceId)) {
    throw new Error("未知来源");
  }
  const requestedLimit = Number(parsed.searchParams.get("limit") ?? 60);
  const timeRange = parseBeijingRange(
    parsed.searchParams.get("from") || undefined,
    parsed.searchParams.get("to") || undefined,
    now,
  );
  return {
    query,
    sourceId: source as SourceId | undefined,
    limit: Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
      : 60,
    ...timeRange,
  };
}
```

- [ ] **Step 4: Run input and existing normalization tests**

Run:

```powershell
npm.cmd test -- tests/api-input.test.ts tests/time-range.test.ts
```

Expected: all tests pass and existing no-range objects remain unchanged because absent bounds are not spread as `undefined` keys.

- [ ] **Step 5: Commit feed input support**

```powershell
git add lib/api-input.ts tests/api-input.test.ts
git commit -m "feat: parse feed time range"
```

### Task 3: Filter D1 rows by the effective item time

**Files:**
- Modify: `lib/repository.ts`
- Modify: `tests/repository.test.ts`

- [ ] **Step 1: Add failing real-SQL boundary coverage**

Append this test to `tests/repository.test.ts`:

```ts
it("filters inclusive Beijing minutes and composes with source and query", async () => {
  await upsertItems(testDb.db, [
    item({
      title: "边界政策",
      url: "https://36kr.com/newsflashes/start",
      publishedAt: "2026-07-30T01:30:00.000Z",
    }),
    item({
      title: "边界政策",
      url: "https://36kr.com/newsflashes/end",
      publishedAt: "2026-07-30T10:00:59.999Z",
    }),
    item({
      title: "边界政策",
      url: "https://36kr.com/newsflashes/excluded",
      publishedAt: "2026-07-30T10:01:00.000Z",
    }),
    item({
      sourceId: "cls-headline",
      sourceName: "财联社",
      channelName: "头条",
      title: "边界政策",
      url: "https://www.cls.cn/detail/2",
      publishedAt: "2026-07-30T05:00:00.000Z",
    }),
  ], new Date("2026-07-30T10:02:00.000Z"));

  const rows = await listFeed(testDb.db, {
    query: "政策",
    sourceId: "36kr-macro",
    limit: 100,
    fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
    toExclusiveMs: Date.parse("2026-07-30T18:01:00+08:00"),
  });

  expect(rows.map((row) => row.url)).toEqual([
    "https://36kr.com/newsflashes/end",
    "https://36kr.com/newsflashes/start",
  ]);
});

it("uses firstSeenAt when publishedAt is missing", async () => {
  await upsertItems(testDb.db, [
    item({
      url: "https://36kr.com/newsflashes/fallback",
      publishedAt: null,
    }),
  ], new Date("2026-07-30T02:15:00.000Z"));

  const rows = await listFeed(testDb.db, {
    limit: 100,
    fromMs: Date.parse("2026-07-30T10:15:00+08:00"),
    toExclusiveMs: Date.parse("2026-07-30T10:16:00+08:00"),
  });
  expect(rows.map((row) => row.url))
    .toEqual(["https://36kr.com/newsflashes/fallback"]);
});
```

- [ ] **Step 2: Run repository tests and verify failure**

Run:

```powershell
npm.cmd test -- tests/repository.test.ts
```

Expected: FAIL because `listFeed` ignores `fromMs` and `toExclusiveMs`.

- [ ] **Step 3: Extend the repository query options and predicates**

In `lib/repository.ts`, replace the `listFeed` options type with:

```ts
options: {
  query?: string;
  sourceId?: SourceId;
  limit: number;
  fromMs?: number;
  toExclusiveMs?: number;
},
```

Add this block after the query predicate:

```ts
if (options.fromMs !== undefined && options.toExclusiveMs !== undefined) {
  where.push(`
    COALESCE(published_at, first_seen_at) >= ?
    AND COALESCE(published_at, first_seen_at) < ?
  `);
  values.push(options.fromMs, options.toExclusiveMs);
}
```

Keep the limit value as the final bound parameter.

- [ ] **Step 4: Run repository tests**

Run:

```powershell
npm.cmd test -- tests/repository.test.ts
```

Expected: all repository tests pass, including start, end-minute, next-minute, fallback, source, and query behavior.

- [ ] **Step 5: Commit D1 filtering**

```powershell
git add lib/repository.ts tests/repository.test.ts
git commit -m "feat: filter feed by time range"
```

### Task 4: Enforce the time contract at the feed route

**Files:**
- Modify: `app/api/feed/route.ts`
- Modify: `tests/api-contract.test.ts`

- [ ] **Step 1: Add failing route contract tests**

Add to `tests/api-contract.test.ts`:

```ts
it("passes valid time bounds to the repository", async () => {
  const from = encodeURIComponent("2026-07-30T09:30:00+08:00");
  const to = encodeURIComponent("2026-07-30T11:20:00+08:00");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-30T03:45:30.000Z"));
  try {
    const response = await GET(new Request(
      `https://example.test/api/feed?from=${from}&to=${to}`,
    ));
    expect(response.status).toBe(200);
    expect(fakes.listFeed).toHaveBeenCalledWith(fakes.db, {
      query: undefined,
      sourceId: undefined,
      limit: 60,
      fromMs: Date.parse("2026-07-30T09:30:00+08:00"),
      toExclusiveMs: Date.parse("2026-07-30T11:21:00+08:00"),
    });
  } finally {
    vi.useRealTimers();
  }
});

it("returns 400 and skips the repository for an invalid time range", async () => {
  const from = encodeURIComponent("2026-07-30T11:30:00+08:00");
  const to = encodeURIComponent("2026-07-30T11:20:00+08:00");
  const response = await GET(new Request(
    `https://example.test/api/feed?from=${from}&to=${to}`,
  ));
  expect(response.status).toBe(400);
  expect(fakes.listFeed).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the route tests and verify the error status failure**

Run:

```powershell
npm.cmd test -- tests/api-contract.test.ts
```

Expected: the valid case passes through; the invalid range returns `500` instead of `400`.

- [ ] **Step 3: Classify time input errors as client errors**

In `app/api/feed/route.ts`, replace the status expression with:

```ts
const status = /搜索词|未知来源|时间|最近 7 天|未来/.test(message)
  ? 400
  : 500;
```

- [ ] **Step 4: Run API input and contract tests**

Run:

```powershell
npm.cmd test -- tests/api-input.test.ts tests/api-contract.test.ts
```

Expected: all API validation and route contract tests pass.

- [ ] **Step 5: Commit the API contract**

```powershell
git add app/api/feed/route.ts tests/api-contract.test.ts
git commit -m "feat: expose feed time range API"
```

### Task 5: Add draft and applied range state to the dashboard

**Files:**
- Modify: `app/dashboard.tsx`
- Modify: `tests/dashboard-policy.test.ts`

- [ ] **Step 1: Extend dashboard helper tests**

Add to `tests/dashboard-policy.test.ts`:

```ts
import {
  formatTimeRangeLabel,
  getBeijingInputBounds,
} from "../lib/time-range";

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
```

- [ ] **Step 2: Run dashboard policy tests**

Run:

```powershell
npm.cmd test -- tests/dashboard-policy.test.ts
```

Expected: PASS because the shared utility already provides the tested policy. This is a dashboard integration characterization gate; production dashboard edits begin only after it passes.

- [ ] **Step 3: Extend the feed request**

In `app/dashboard.tsx`, import:

```ts
import {
  type AppliedTimeRange,
  formatTimeRangeLabel,
  getBeijingInputBounds,
  toBeijingIsoMinute,
  validateBeijingLocalRange,
} from "../lib/time-range";
```

Change `requestFeed` to:

```ts
async function requestFeed(
  nextQuery = "",
  nextSource: SourceId | "all" = "all",
  range: AppliedTimeRange | null = null,
): Promise<FeedResponse> {
  const params = new URLSearchParams();
  if (nextQuery.trim()) params.set("q", nextQuery.trim());
  if (nextSource !== "all") params.set("source", nextSource);
  if (range) {
    params.set("from", toBeijingIsoMinute(range.from));
    params.set("to", toBeijingIsoMinute(range.to));
  }
  const response = await fetch(`/api/feed?${params.toString()}`, {
    cache: "no-store",
  });
  const payload = await response.json() as FeedResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "无法读取信息流");
  return payload;
}
```

- [ ] **Step 4: Add draft/applied state and actions**

Inside `Dashboard`, add:

```ts
const [timeEditorOpen, setTimeEditorOpen] = useState(false);
const [draftFrom, setDraftFrom] = useState("");
const [draftTo, setDraftTo] = useState("");
const [appliedRange, setAppliedRange] =
  useState<AppliedTimeRange | null>(null);
const [timeError, setTimeError] = useState<string | null>(null);
const pickerBounds = useMemo(() => getBeijingInputBounds(), []);
```

Change the filter ref:

```ts
const filtersRef = useRef({ query, sourceId, appliedRange });

useEffect(() => {
  filtersRef.current = { query, sourceId, appliedRange };
}, [query, sourceId, appliedRange]);
```

Add the actions:

```ts
function applyTimeRange() {
  try {
    validateBeijingLocalRange(draftFrom, draftTo);
    setAppliedRange({ from: draftFrom, to: draftTo });
    setTimeError(null);
    setTimeEditorOpen(false);
  } catch (error) {
    setTimeError(error instanceof Error ? error.message : "时间范围无效");
  }
}

function clearTimeRange() {
  setDraftFrom("");
  setDraftTo("");
  setAppliedRange(null);
  setTimeError(null);
  setTimeEditorOpen(false);
}
```

In `refresh`, change the reload call to:

```ts
const nextFeed = await requestFeed(
  currentFilters.query,
  currentFilters.sourceId,
  currentFilters.appliedRange,
);
```

In the debounced filter effect, call:

```ts
void requestFeed(query, sourceId, appliedRange)
```

and add `appliedRange` to the dependency array.

- [ ] **Step 5: Add accessible controls**

Insert before the refresh button:

```tsx
<button
  className={`time-filter-button ${appliedRange ? "filter-active" : ""}`}
  aria-expanded={timeEditorOpen}
  aria-controls="time-range-editor"
  onClick={() => setTimeEditorOpen((open) => !open)}
>
  {appliedRange ? formatTimeRangeLabel(appliedRange) : "时间范围"}
</button>
```

Insert immediately after the toolbar:

```tsx
{timeEditorOpen && (
  <section id="time-range-editor" className="time-range-editor">
    <label>
      <span>开始时间</span>
      <input
        type="datetime-local"
        value={draftFrom}
        min={pickerBounds.min}
        max={pickerBounds.max}
        step={60}
        onChange={(event) => setDraftFrom(event.target.value)}
      />
    </label>
    <label>
      <span>结束时间</span>
      <input
        type="datetime-local"
        value={draftTo}
        min={pickerBounds.min}
        max={pickerBounds.max}
        step={60}
        onChange={(event) => setDraftTo(event.target.value)}
      />
    </label>
    <div className="time-range-actions">
      <button className="time-apply-button" onClick={applyTimeRange}>
        应用
      </button>
      <button className="time-clear-button" onClick={clearTimeRange}>
        清除
      </button>
    </div>
    {timeError && <p className="time-range-error" role="alert">{timeError}</p>}
  </section>
)}
```

- [ ] **Step 6: Run targeted tests and TypeScript**

Run:

```powershell
npm.cmd test -- tests/time-range.test.ts tests/dashboard-policy.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

Expected: tests and type checking pass.

- [ ] **Step 7: Commit dashboard behavior**

```powershell
git add app/dashboard.tsx tests/dashboard-policy.test.ts
git commit -m "feat: add dashboard time range controls"
```

### Task 6: Style the compact desktop and mobile editor

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Add desktop styles**

Add after `.source-filters .filter-active`:

```css
.time-filter-button {
  min-width: max-content;
  padding: 8px 11px;
  border: 1px solid #d4dbd3;
  border-radius: 7px;
  color: #56645b;
  background: #fff;
  font-size: 12px;
}
.time-filter-button.filter-active {
  color: #fff;
  background: var(--forest);
  border-color: var(--forest);
}
.time-range-editor {
  display: flex;
  align-items: end;
  gap: 12px;
  padding: 11px 18px;
  background: #f8f9f6;
  border-bottom: 1px solid var(--line);
}
.time-range-editor label {
  display: grid;
  gap: 5px;
  color: #66736b;
  font-size: 10px;
}
.time-range-editor input {
  height: 36px;
  padding: 0 10px;
  border: 1px solid #d4dbd3;
  border-radius: 7px;
  color: var(--ink);
  background: #fff;
}
.time-range-actions {
  display: flex;
  gap: 7px;
}
.time-range-actions button {
  height: 36px;
  padding: 0 13px;
  border-radius: 7px;
  font-size: 12px;
}
.time-apply-button {
  color: #fff;
  background: var(--forest);
  border: 1px solid var(--forest);
}
.time-clear-button {
  color: #56645b;
  background: #fff;
  border: 1px solid #d4dbd3;
}
.time-range-error {
  align-self: center;
  margin: 0 0 0 4px;
  color: #a3412b;
  font-size: 11px;
}
```

- [ ] **Step 2: Add mobile rules**

Inside `@media (max-width: 820px)`, add:

```css
.time-filter-button {
  order: 2;
  max-width: calc(100% - 104px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.time-range-editor {
  display: grid;
  grid-template-columns: 1fr;
  align-items: stretch;
  gap: 9px;
  padding: 11px 12px;
}
.time-range-editor input {
  width: 100%;
}
.time-range-actions {
  justify-content: flex-end;
}
.time-range-error {
  margin: 0;
}
```

- [ ] **Step 3: Verify lint and build**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
```

Expected: both commands exit with code 0.

- [ ] **Step 4: Commit responsive styles**

```powershell
git add app/globals.css
git commit -m "style: polish time range filter"
```

### Task 7: Run complete local acceptance

**Files:**
- Modify only files required by a verified failure.

- [ ] **Step 1: Run the complete automated verification**

Run:

```powershell
npm.cmd test
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run lint
npm.cmd run build
git diff --check
git status --short
```

Expected:

- all tests pass;
- TypeScript exits with code 0;
- lint exits with code 0;
- production build exits with code 0;
- no whitespace errors;
- only intentional pre-existing uncommitted branding changes remain, if they have not been separately committed.

- [ ] **Step 2: Start the local app**

Run:

```powershell
npm.cmd run dev
```

Use the port printed by vinext. Keep exactly one local dev instance running.

- [ ] **Step 3: Verify the API with an encoded Beijing range**

Derive a range from the effective timestamps in the current local feed, then
request it:

```powershell
$currentFeed = Invoke-RestMethod -Uri "http://localhost:3000/api/feed?limit=100"
$effectiveTimes = @($currentFeed.items | ForEach-Object {
  if ($_.publishedAt) {
    [DateTimeOffset]::Parse($_.publishedAt)
  } else {
    [DateTimeOffset]::Parse($_.firstSeenAt)
  }
} | Sort-Object)
$beijingOffset = [TimeSpan]::FromHours(8)
$fromIso = $effectiveTimes[0].ToOffset($beijingOffset).ToString("yyyy-MM-ddTHH:mm:00zzz")
$toIso = $effectiveTimes[-1].ToOffset($beijingOffset).ToString("yyyy-MM-ddTHH:mm:00zzz")
$fromValue = [System.Uri]::EscapeDataString($fromIso)
$toValue = [System.Uri]::EscapeDataString($toIso)
Invoke-RestMethod -Uri "http://localhost:3000/api/feed?from=$fromValue&to=$toValue"
```

Expected: HTTP 200, all returned rows fall inside the inclusive displayed minutes.

Request a range whose start is one minute after its end:

```powershell
$badFromIso = $effectiveTimes[-1].ToOffset($beijingOffset).AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:00zzz")
$badFromValue = [System.Uri]::EscapeDataString($badFromIso)
$badToValue = [System.Uri]::EscapeDataString($toIso)
Invoke-WebRequest -Uri "http://localhost:3000/api/feed?from=$badFromValue&to=$badToValue" -SkipHttpErrorCheck
```

Expected: HTTP 400 with `开始时间不能晚于结束时间`.

- [ ] **Step 4: Verify browser interaction**

Open the local dashboard and confirm:

1. “时间范围” expands the editor.
2. Applying a valid range collapses the editor and shows the compact label.
3. Keyword and source changes preserve the applied range.
4. Manual refresh preserves the applied range.
5. Clearing removes the range and restores the full available feed.
6. A reversed or partial range displays the documented Chinese error.
7. At mobile width, the editor uses one column and does not hide search, sources, or refresh.

- [ ] **Step 5: Final status**

Run:

```powershell
git log --oneline -6
git status --short --branch
```

Expected: the time-range commits are present on the active branch, and no implementation files remain unintentionally uncommitted.
