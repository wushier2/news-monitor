# 过去 24 小时补充采集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个手动触发、后台运行、逐来源报告覆盖度的过去 24 小时补充采集功能，并预留单来源补采接口。

**Architecture:** 四个来源通过统一的 `BackfillAdapter` 分页契约接入，`BackfillService` 负责固定时间窗口、停止条件、去重入库和逐来源汇总，`BackfillRunner` 负责单任务后台执行和持久化状态。页面通过启动接口创建任务、每秒轮询状态，并在完成后重新加载当前筛选条件的第 1 页。

**Tech Stack:** TypeScript、React 19、vinext/Next App Router、Cloudflare D1/SQLite、Vitest、Cheerio、js-md5。

---

## 文件结构

- `lib/backfill/types.ts`：补采游标、适配器、任务状态和 API 类型。
- `lib/backfill/http.ts`：带 429/5xx 重试、`Retry-After` 和 500ms 节流的只读请求工具。
- `lib/backfill/adapters/kr36.ts`：36Kr 首页状态、临时 nonce、网关签名和 `pageCallback` 翻页。
- `lib/backfill/adapters/jiemian.ts`：界面新闻 HTML 首页和 `getlistmore` 时间游标翻页，供两个频道复用。
- `lib/backfill/adapters/cls.ts`：财联社 assembled 首页、`last_time` 翻页和完整参数签名。
- `lib/backfill/adapters/index.ts`：按 `SourceId` 获取适配器。
- `lib/backfill/repository.ts`：补采任务、逐来源进度、精确入库统计和运行锁查询。
- `lib/backfill/service.ts`：单来源循环、停止判定、最多两来源并发和总状态汇总。
- `lib/backfill/runner.ts`：本地后台任务注册表、重复启动复用和重启中断协调。
- `app/api/backfill/route.ts`：启动任务和读取最近一次任务。
- `app/api/backfill/[runId]/route.ts`：按编号读取任务进度。
- `app/dashboard.tsx`：确认、启动、轮询、进度面板和完成后刷新。

### Task 1: Add backfill domain types and persistent tables

**Files:**
- Modify: `db/schema.ts`
- Modify: `db/ensure.ts`
- Create: `drizzle/0001_backfill_runs.sql`
- Create: `lib/backfill/types.ts`
- Create: `tests/backfill-schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `tests/backfill-schema.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestD1 } from "./helpers/d1";

const base = readFileSync(new URL(
  "../drizzle/0000_first_strong_guy.sql",
  import.meta.url,
), "utf8");
const backfill = readFileSync(new URL(
  "../drizzle/0001_backfill_runs.sql",
  import.meta.url,
), "utf8");

describe("backfill schema", () => {
  it("stores one task and one row per source", () => {
    const testDb = createTestD1();
    testDb.sqlite.exec(base);
    testDb.sqlite.exec(backfill);
    testDb.sqlite.prepare(`
      INSERT INTO backfill_runs (
        requested_source_id, window_start, window_end,
        started_at, status, created_at
      ) VALUES (NULL, 1, 2, 1, 'running', 1)
    `).run();
    testDb.sqlite.prepare(`
      INSERT INTO backfill_source_runs (
        run_id, source_id, status, updated_at
      ) VALUES (1, '36kr-macro', 'running', 1)
    `).run();
    expect(testDb.sqlite.prepare(
      "SELECT run_id, source_id FROM backfill_source_runs",
    ).all()).toEqual([{ run_id: 1, source_id: "36kr-macro" }]);
    testDb.sqlite.close();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm.cmd test -- tests/backfill-schema.test.ts`

Expected: FAIL because `drizzle/0001_backfill_runs.sql` does not exist.

- [ ] **Step 3: Add shared types**

Create `lib/backfill/types.ts`:

```ts
import type { NormalizedItem, SourceId } from "../domain";

export type BackfillSourceStatus =
  | "pending" | "running" | "complete" | "partial"
  | "failed" | "interrupted";
export type BackfillRunStatus =
  | "running" | "complete" | "partial" | "failed" | "interrupted";

export interface BackfillPageResult {
  items: NormalizedItem[];
  nextCursor: string | null;
  exhausted: boolean;
}

export interface BackfillAdapter {
  sourceId: SourceId;
  fetchPage(cursor: string | null): Promise<BackfillPageResult>;
}

export interface BackfillSourceProgress {
  sourceId: SourceId;
  status: BackfillSourceStatus;
  cursor: string | null;
  pagesFetched: number;
  itemsFetched: number;
  itemsInWindow: number;
  itemsInserted: number;
  itemsExisting: number;
  earliestCoveredAt: string | null;
  error: string | null;
  updatedAt: string;
}

export interface BackfillRun {
  id: number;
  requestedSourceId: SourceId | null;
  windowStart: string;
  windowEnd: string;
  startedAt: string;
  finishedAt: string | null;
  status: BackfillRunStatus;
  createdAt: string;
  sources: BackfillSourceProgress[];
}

export interface StartBackfillResponse {
  run: BackfillRun;
  reused: boolean;
}
```

Dashboard, routes, runner, and presentation code import these types directly from
`lib/backfill/types.ts`. Do not re-export them from `lib/domain.ts`; that would
create an avoidable domain ↔ backfill module cycle.

- [ ] **Step 4: Add migration and runtime schema**

Create `drizzle/0001_backfill_runs.sql`:

```sql
CREATE TABLE `backfill_runs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `requested_source_id` text,
  `window_start` integer NOT NULL,
  `window_end` integer NOT NULL,
  `started_at` integer NOT NULL,
  `finished_at` integer,
  `status` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `backfill_runs_status_idx`
  ON `backfill_runs` (`status`);
--> statement-breakpoint
CREATE TABLE `backfill_source_runs` (
  `run_id` integer NOT NULL,
  `source_id` text NOT NULL,
  `status` text NOT NULL,
  `cursor` text,
  `pages_fetched` integer DEFAULT 0 NOT NULL,
  `items_fetched` integer DEFAULT 0 NOT NULL,
  `items_in_window` integer DEFAULT 0 NOT NULL,
  `items_inserted` integer DEFAULT 0 NOT NULL,
  `items_existing` integer DEFAULT 0 NOT NULL,
  `earliest_covered_at` integer,
  `error` text,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`run_id`, `source_id`),
  FOREIGN KEY (`run_id`) REFERENCES `backfill_runs` (`id`)
);
```

Add matching Drizzle tables to `db/schema.ts`, and append equivalent `CREATE TABLE IF NOT EXISTS` plus index statements to `db/ensure.ts`. Use integer millisecond timestamps, text statuses, zero defaults for counters, and the composite primary key shown above.

- [ ] **Step 5: Run schema and baseline tests**

Run: `npm.cmd test -- tests/backfill-schema.test.ts tests/repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add lib/backfill/types.ts db/schema.ts db/ensure.ts drizzle/0001_backfill_runs.sql tests/backfill-schema.test.ts
git commit -m "feat: add backfill task schema"
```

### Task 2: Add exact upsert statistics and backfill persistence

**Files:**
- Modify: `lib/repository.ts`
- Create: `lib/backfill/repository.ts`
- Create: `tests/backfill-repository.test.ts`

- [ ] **Step 1: Write failing repository tests**

Create `tests/backfill-repository.test.ts` with an in-memory migrated D1 and these assertions:

```ts
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NormalizedItem } from "../lib/domain";
import {
  createBackfillRun,
  getBackfillRun,
  interruptRunningBackfills,
  updateBackfillSource,
} from "../lib/backfill/repository";
import { upsertItemsWithStats } from "../lib/repository";
import { createTestD1 } from "./helpers/d1";

const migrations = [
  "../drizzle/0000_first_strong_guy.sql",
  "../drizzle/0001_backfill_runs.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
const now = new Date("2026-07-31T10:00:00.000Z");
const later = new Date("2026-07-31T10:05:00.000Z");
const item = (id: string): NormalizedItem => ({
  sourceId: "36kr-macro",
  sourceName: "36Kr",
  channelName: "宏观",
  title: `示例 ${id}`,
  summary: "",
  url: `https://example.test/${id}`,
  publishedAt: "2026-07-31T09:00:00.000Z",
});

let db: D1Database;
let sqlite: ReturnType<typeof createTestD1>["sqlite"];

beforeEach(() => {
  const testDb = createTestD1();
  db = testDb.db;
  sqlite = testDb.sqlite;
  migrations.forEach((migration) => sqlite.exec(migration));
});
afterEach(() => sqlite.close());

it("counts inserted and existing unique items exactly", async () => {
  const first = await upsertItemsWithStats(db, [item("1"), item("2")], now);
  const second = await upsertItemsWithStats(
    db,
    [item("2"), item("3"), item("3")],
    later,
  );
  expect(first).toEqual({ inserted: 2, existing: 0 });
  expect(second).toEqual({ inserted: 1, existing: 1 });
  expect(sqlite.prepare("SELECT COUNT(*) count FROM items").get())
    .toEqual({ count: 3 });
});

it("creates, updates, reads, and interrupts a run", async () => {
  const run = await createBackfillRun(db, {
    sourceIds: ["36kr-macro", "cls-headline"],
    requestedSourceId: null,
    windowStart: now.getTime() - 86_400_000,
    windowEnd: now.getTime(),
    now,
  });
  await updateBackfillSource(db, run.id, "36kr-macro", {
    status: "complete",
    cursor: null,
    pagesFetched: 3,
    itemsFetched: 40,
    itemsInWindow: 32,
    itemsInserted: 20,
    itemsExisting: 12,
    earliestCoveredAt: now.getTime() - 86_400_000,
    error: null,
  }, now);
  expect((await getBackfillRun(db, run.id))?.sources[0])
    .toMatchObject({ status: "complete", pagesFetched: 3 });
  expect(await interruptRunningBackfills(db, new Date(now.getTime() + 1)))
    .toBe(1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-repository.test.ts`

Expected: FAIL because the repository functions do not exist.

- [ ] **Step 3: Implement exact upsert statistics**

In `lib/repository.ts`, add:

```ts
export interface UpsertStats {
  inserted: number;
  existing: number;
}

export async function upsertItemsWithStats(
  db: D1Database,
  incoming: NormalizedItem[],
  now: Date,
): Promise<UpsertStats> {
  const unique = [...new Map(incoming.map((entry) => [
    buildDedupeKey(entry), entry,
  ])).entries()];
  if (!unique.length) return { inserted: 0, existing: 0 };
  const inserts = await db.batch(unique.map(([key, entry]) => db.prepare(`
    INSERT INTO items (
      dedupe_key, source_id, source_name, channel_name, title, summary,
      url, published_at, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO NOTHING
  `).bind(
    key, entry.sourceId, entry.sourceName, entry.channelName,
    entry.title, entry.summary, entry.url,
    entry.publishedAt ? Date.parse(entry.publishedAt) : null,
    now.getTime(), now.getTime(),
  )));
  const inserted = inserts.reduce(
    (sum, result) => sum + Number(result.meta.changes ?? 0),
    0,
  );
  await db.batch(unique.map(([key, entry]) => db.prepare(`
    UPDATE items SET
      title = ?, summary = ?, url = ?,
      published_at = COALESCE(?, published_at), last_seen_at = ?
    WHERE dedupe_key = ?
  `).bind(
    entry.title, entry.summary, entry.url,
    entry.publishedAt ? Date.parse(entry.publishedAt) : null,
    now.getTime(), key,
  )));
  return { inserted, existing: unique.length - inserted };
}
```

Change existing `upsertItems` to call `upsertItemsWithStats` but continue to
return `incoming.length`, preserving its current public contract even when the
input contains duplicates. Only the new statistics API reports unique rows.

- [ ] **Step 4: Implement task persistence**

Create `lib/backfill/repository.ts` with focused functions:

```ts
export interface CreateBackfillRunInput {
  sourceIds: SourceId[];
  requestedSourceId: SourceId | null;
  windowStart: number;
  windowEnd: number;
  now: Date;
}

export type BackfillSourceUpdate = Omit<
  BackfillSourceProgress,
  "sourceId" | "updatedAt"
>;

export async function createBackfillRun(
  db: D1Database,
  input: CreateBackfillRunInput,
): Promise<BackfillRun>;
export async function findRunningBackfill(
  db: D1Database,
): Promise<BackfillRun | null>;
export async function getLatestBackfillRun(
  db: D1Database,
): Promise<BackfillRun | null>;
export async function getBackfillRun(
  db: D1Database,
  id: number,
): Promise<BackfillRun | null>;
export async function updateBackfillSource(
  db: D1Database,
  runId: number,
  sourceId: SourceId,
  progress: BackfillSourceUpdate,
  now: Date,
): Promise<void>;
export async function finishBackfillRun(
  db: D1Database,
  runId: number,
  status: Exclude<BackfillRunStatus, "running">,
  now: Date,
): Promise<void>;
export async function interruptRunningBackfills(
  db: D1Database,
  now: Date,
): Promise<number>;
```

Implement each function with bound D1 SQL. `getBackfillRun` must query the run and all source rows, convert integer timestamps to ISO strings, sort sources in `SOURCES` order, and return `null` for an unknown id. `updateBackfillSource` must truncate `error` to 240 characters.

- [ ] **Step 5: Run tests and TypeScript**

Run:

```powershell
npm.cmd test -- tests/backfill-repository.test.ts tests/repository.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

Expected: PASS and exit code 0.

- [ ] **Step 6: Commit**

```powershell
git add lib/repository.ts lib/backfill/repository.ts tests/backfill-repository.test.ts
git commit -m "feat: persist backfill progress"
```

### Task 3: Add bounded retry and adapter contract utilities

**Files:**
- Create: `lib/backfill/http.ts`
- Create: `tests/backfill-http.test.ts`

- [ ] **Step 1: Write failing retry tests**

```ts
it("retries 429 using Retry-After and then succeeds", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response("busy", {
      status: 429,
      headers: { "retry-after": "1" },
    }))
    .mockResolvedValueOnce(new Response("ok"));
  const sleep = vi.fn().mockResolvedValue(undefined);
  expect(await fetchWithRetry("https://example.test", {}, { fetcher, sleep }))
    .toMatchObject({ status: 200 });
  expect(sleep).toHaveBeenCalledWith(1_000);
});

it("does not retry a permanent 404", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("missing", {
    status: 404,
  }));
  await expect(fetchWithRetry("https://example.test", {}, { fetcher }))
    .rejects.toThrow("HTTP 404");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-http.test.ts`

Expected: FAIL because `fetchWithRetry` is missing.

- [ ] **Step 3: Implement bounded retry**

Create `lib/backfill/http.ts`:

```ts
type Fetcher = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleep = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  dependencies: { fetcher?: Fetcher; sleep?: Sleep } = {},
): Promise<Response> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? defaultSleep;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return response;
    lastStatus = response.status;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : 2 ** attempt * 1_000);
  }
  throw new Error(`HTTP ${lastStatus}`);
}

export const waitBetweenPages = () => defaultSleep(500);
```

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- tests/backfill-http.test.ts`

Expected: PASS.

```powershell
git add lib/backfill/http.ts tests/backfill-http.test.ts
git commit -m "feat: add backfill request retry policy"
```

### Task 4: Implement the 36Kr page-callback adapter

**Files:**
- Modify: `lib/parsers/kr36.ts`
- Create: `lib/backfill/adapters/kr36.ts`
- Create: `tests/fixtures/36kr-backfill-first.html`
- Create: `tests/fixtures/36kr-backfill-next.json`
- Create: `tests/backfill-kr36.test.ts`

- [ ] **Step 1: Capture a sanitized fixture and write failing tests**

The HTML fixture must contain `window.__GATEWAY_SIGN__ = "fixture-nonce"`
and an `initialState.newsflashCatalogData.data.newsflashList.data` object with two
fake rows, `pageCallback: "fixture-callback"`, and `hasNextPage: 1`. The JSON
fixture must contain two fake rows, `pageCallback: "next-token"`, and
`hasNextPage: 1`. Use fixed 2026 timestamps and example titles/URLs, not live
article text. At the top of the test, load both fixtures explicitly:

```ts
const firstHtml = readFileSync(new URL(
  "./fixtures/36kr-backfill-first.html",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/36kr-backfill-next.json",
  import.meta.url,
), "utf8");
```

```ts
it("reads first-page nonce and callback from HTML", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(firstHtml));
  const adapter = create36KrBackfillAdapter({ fetcher });
  const page = await adapter.fetchPage(null);
  expect(page.items).toHaveLength(2);
  expect(JSON.parse(page.nextCursor!)).toEqual({
    nonce: "fixture-nonce",
    pageCallback: "fixture-callback",
  });
  expect(page.exhausted).toBe(false);
});

it("signs and advances a gateway page", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(nextJson));
  const adapter = create36KrBackfillAdapter({
    fetcher,
    now: () => 1_785_500_000_000,
  });
  const page = await adapter.fetchPage(JSON.stringify({
    nonce: "fixture-nonce",
    pageCallback: "fixture-callback",
  }));
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toContain("/api/mis/nav/newsflash/list?sign=");
  expect(JSON.parse(String(init.body))).toMatchObject({
    nonce: "fixture-nonce",
    partner_id: "web",
    param: { pageSize: 20, pageEvent: 1, type: 4 },
  });
  expect(JSON.parse(page.nextCursor!).pageCallback).toBe("next-token");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-kr36.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the adapter**

Refactor `lib/parsers/kr36.ts` to export a `parse36KrCandidates(candidates)` helper and keep `parse36Kr(html)` as its current HTML wrapper.

In `lib/backfill/adapters/kr36.ts`:

- First page: GET `https://36kr.com/newsflashes/catalog/4`, extract `window.__GATEWAY_SIGN__`, `window.initialState`, items, `pageCallback`, and `hasNextPage`.
- Later pages: POST JSON to `https://gateway.36kr.com/api/mis/nav/newsflash/list` with ordered body `{ nonce, partner_id: "web", timestamp, param }`.
- `param` is `{ pageSize: 20, pageEvent: 1, pageCallback, siteId: 1, type: 4, platformId: 2 }`.
- Compute `sign = md5(JSON.stringify(body) + nonce)` and append it as a query parameter.
- Preserve the original nonce while replacing `pageCallback` from each response.
- Set `exhausted` when `hasNextPage` is falsy or no callback is returned.
- Send the existing monitor user-agent, JSON content type, origin, and referer.

Return a complete `BackfillAdapter`; inject `fetcher` and `now` for deterministic tests.

- [ ] **Step 4: Run parser, adapter, and signing tests**

Run:

```powershell
npm.cmd test -- tests/backfill-kr36.test.ts tests/parsers.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add lib/parsers/kr36.ts lib/backfill/adapters/kr36.ts tests/fixtures/36kr-backfill-first.html tests/fixtures/36kr-backfill-next.json tests/backfill-kr36.test.ts
git commit -m "feat: paginate 36Kr backfill"
```

### Task 5: Implement the reusable Jiemian time-cursor adapter

**Files:**
- Modify: `lib/parsers/jiemian.ts`
- Create: `lib/backfill/adapters/jiemian.ts`
- Create: `tests/fixtures/jiemian-backfill-next.json`
- Create: `tests/backfill-jiemian.test.ts`

- [ ] **Step 1: Write failing tests for both channels**

Create a sanitized JSON fixture with `code: "0"`, two fake result rows, a last
`publishtime` of `1785480000`, and `hideBtn: false`. Load it in the test:

```ts
const nextJson = readFileSync(new URL(
  "./fixtures/jiemian-backfill-next.json",
  import.meta.url,
), "utf8");
```

```ts
it.each([
  ["jiemian-regulatory", "1330kb", "1330"],
  ["jiemian-current-affairs", "1325kb", "1325"],
])("uses the correct channel parameters for %s", async (
  sourceId, cid, tagid,
) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(nextJson));
  const adapter = createJiemianBackfillAdapter(sourceId, { fetcher });
  const result = await adapter.fetchPage(JSON.stringify({
    startTime: 1_785_484_724,
    page: 2,
  }));
  expect(String(fetcher.mock.calls[0][0])).toContain(
    `cid=${cid}&start_time=1785484724&page=2&tagid=${tagid}`,
  );
  expect(result.items[0].url).toBe("https://www.jiemian.com/article/1001.html");
  expect(JSON.parse(result.nextCursor!)).toEqual({
    startTime: 1_785_480_000,
    page: 3,
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-jiemian.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement HTML and JSON page parsing**

Export a `parseJiemianRows(rows, sourceId, channelName)` helper from `lib/parsers/jiemian.ts`. The existing HTML parser continues to call it.

The adapter must:

- GET the existing source URL for cursor `null`.
- Use the last valid `data-time` as `startTime` and set the next page to 2.
- For later pages call `https://papi.jiemian.com/page/api/kuaixun/getlistmore` with `cid`, `start_time`, `page`, and `tagid`.
- Parse `result.list`, mapping `id` to `https://www.jiemian.com/article/{id}.html`, `publishtime` seconds to ISO, and title/summary through `articleFields`.
- Set `exhausted` when `hideBtn` is true or the returned list is empty.
- Advance `startTime` from the last valid result and increment `page`.

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- tests/backfill-jiemian.test.ts tests/parsers.test.ts`

Expected: PASS.

```powershell
git add lib/parsers/jiemian.ts lib/backfill/adapters/jiemian.ts tests/fixtures/jiemian-backfill-next.json tests/backfill-jiemian.test.ts
git commit -m "feat: paginate Jiemian backfill"
```

### Task 6: Implement the CLS last-time adapter

**Files:**
- Modify: `lib/fetch-source.ts`
- Modify: `lib/parsers/cls.ts`
- Create: `lib/backfill/adapters/cls.ts`
- Create: `tests/fixtures/cls-backfill-first.json`
- Create: `tests/fixtures/cls-backfill-next.json`
- Create: `tests/backfill-cls.test.ts`

- [ ] **Step 1: Write failing signature and pagination tests**

Create sanitized first and next fixtures with two fake entries each. The first
uses `data.depth_list`; the next uses `data` as an array and ends with
`ctime: 1785470000`. Load them explicitly:

```ts
const firstJson = readFileSync(new URL(
  "./fixtures/cls-backfill-first.json",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/cls-backfill-next.json",
  import.meta.url,
), "utf8");
```

```ts
it("signs every sorted query parameter", async () => {
  expect(await buildClsSignedUrl("/v3/depth/list/1000", {
    last_time: "1785472939",
    rn: "20",
    id: "1000",
  })).toContain(
    "app=CailianpressWeb&id=1000&last_time=1785472939&os=web&rn=20&sv=8.7.9&sign=",
  );
});

it("uses depth_list first and advances with last_time", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(firstJson))
    .mockResolvedValueOnce(new Response(nextJson));
  const adapter = createClsBackfillAdapter({ fetcher });
  const first = await adapter.fetchPage(null);
  expect(first.items).toHaveLength(2);
  const next = await adapter.fetchPage(first.nextCursor);
  expect(String(fetcher.mock.calls[1][0])).toContain("/v3/depth/list/1000");
  expect(JSON.parse(next.nextCursor!)).toEqual({ lastTime: 1_785_470_000 });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-cls.test.ts`

Expected: FAIL because the signing helper and adapter are missing.

- [ ] **Step 3: Generalize CLS signing and parsing**

Replace the fixed URL builder in `lib/fetch-source.ts` with:

```ts
export function buildClsSignedUrl(
  path: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const params = {
    app: "CailianpressWeb",
    os: "web",
    sv: "8.7.9",
    ...extra,
  };
  const canonical = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return sha1Hex(canonical).then((sha1) => {
    const query = Object.entries(params)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, value]) => (
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
      ))
      .join("&");
    return `https://www.cls.cn${path}?${query}&sign=${md5(sha1)}`;
  });
}
```

Keep `buildClsUrl()` as a compatibility wrapper calling `buildClsSignedUrl("/v3/depth/home/assembled/1000")`.

Export candidate-to-item helpers from `lib/parsers/cls.ts` so both assembled `data.depth_list` and paged `data[]` use the same normalization.

- [ ] **Step 4: Implement the adapter**

The CLS adapter must:

- Fetch `/v3/depth/home/assembled/1000` for cursor `null` and use only `data.depth_list` for the pageable sequence.
- Fetch `/v3/depth/list/1000` later with signed `last_time`, `rn=20`, and `id=1000` parameters.
- Store cursor as `{ "lastTime": number }` using the last valid `ctime`.
- Set `exhausted` only when the paged endpoint returns an empty array; do not infer exhaustion from fewer than 20 entries.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd test -- tests/backfill-cls.test.ts tests/cls-sign.test.ts tests/parsers.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

Expected: PASS.

```powershell
git add lib/fetch-source.ts lib/parsers/cls.ts lib/backfill/adapters/cls.ts tests/fixtures/cls-backfill-first.json tests/fixtures/cls-backfill-next.json tests/backfill-cls.test.ts tests/cls-sign.test.ts
git commit -m "feat: paginate CLS backfill"
```

### Task 7: Orchestrate cutoff, safety stops, and two-source concurrency

**Files:**
- Create: `lib/backfill/adapters/index.ts`
- Create: `lib/backfill/service.ts`
- Create: `tests/backfill-service.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Cover these concrete cases with fake adapters and fake repository functions:

```ts
const itemAt = (publishedAt: string, suffix: string): NormalizedItem => ({
  sourceId: "36kr-macro",
  sourceName: "36Kr",
  channelName: "宏观",
  title: `示例 ${suffix}`,
  summary: "",
  url: `https://example.test/${suffix}`,
  publishedAt,
});

const fakeAdapter = (
  pages: Array<BackfillPageResult | Error>,
): BackfillAdapter => ({
  sourceId: "36kr-macro",
  async fetchPage(cursor) {
    const index = cursor === null ? 0 : Number(cursor);
    const result = pages[index];
    if (result instanceof Error) throw result;
    return result;
  },
});

const page = (
  items: NormalizedItem[],
  nextCursor: string | null,
  exhausted = false,
): BackfillPageResult => ({ items, nextCursor, exhausted });

it("stops complete after reaching the fixed 24-hour cutoff", async () => {
  const adapter = fakeAdapter([
    page([itemAt("2026-07-31T10:00:00Z", "new")], "1"),
    page([itemAt("2026-07-30T09:59:59Z", "old")], "2"),
  ]);
  const result = await runSourceBackfill(makeTestContext({ adapter }));
  expect(result).toMatchObject({ status: "complete", pagesFetched: 2 });
});

it.each<[
  string,
  Array<BackfillPageResult | Error>,
  "partial" | "failed",
]>([
  ["repeated cursor", [page([], "0")], "partial"],
  ["two empty unique pages", [page([], "1"), page([], "2")], "partial"],
  ["first request failure", [new Error("offline")], "failed"],
  [
    "later request failure",
    [page([itemAt("2026-07-31T09:00:00Z", "one")], "1"), new Error("offline")],
    "partial",
  ],
])("classifies %s", async (_name, pages, status) => {
  const adapter = fakeAdapter(pages);
  expect((await runSourceBackfill(makeTestContext({ adapter }))).status)
    .toBe(status);
});

it("runs at most two sources concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const adapters = SOURCE_IDS.map((sourceId) => ({
    sourceId,
    async fetchPage() {
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return page([], null, true);
    },
  }));
  await runBackfillSources(makeRunContext({ adapters }));
  expect(maximum).toBe(2);
});
```

In the same test file, `makeTestContext` and `makeRunContext` create a migrated
in-memory D1, insert run/source rows through `createBackfillRun`, inject a no-op
`waitBetweenPages`, and close the SQLite handle in `afterEach`. Their returned
objects must use the exact `SourceBackfillContext` and `BackfillRunContext`
interfaces introduced in Step 4, so no production global is required by tests.

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-service.test.ts`

Expected: FAIL because service functions are missing.

- [ ] **Step 3: Implement adapters registry**

Create `lib/backfill/adapters/index.ts` exporting:

```ts
export function createBackfillAdapter(sourceId: SourceId): BackfillAdapter {
  if (sourceId === "36kr-macro") return create36KrBackfillAdapter();
  if (sourceId === "cls-headline") return createClsBackfillAdapter();
  return createJiemianBackfillAdapter(sourceId);
}
```

- [ ] **Step 4: Implement single-source loop**

In `lib/backfill/service.ts`, define constants `MAX_PAGES = 100`, `MAX_EMPTY_UNIQUE_PAGES = 2`, and `SOURCE_CONCURRENCY = 2`.

`runSourceBackfill` must maintain a `Set` of visited cursors and page-local dedupe keys, save progress after every page, filter timestamps to the fixed inclusive window, and use `upsertItemsWithStats`. Mark complete only on cutoff or explicit exhaustion. Missing/invalid timestamps contribute to fetched count but force partial unless another page proves the cutoff.

Define and export explicit dependency-bearing `SourceBackfillContext` and
`BackfillRunContext` interfaces containing the database, run/window values,
adapter(s), clock, and `waitBetweenPages` callback. Call that callback only when
another page will be requested. This makes the 500ms production delay replaceable
with a no-op in tests.

`runBackfillSources` must use a two-worker index queue, not `Promise.all` over all four sources. After workers finish, derive total status: all complete → complete; all failed → failed; otherwise partial.

- [ ] **Step 5: Run service tests and full unit suite**

Run: `npm.cmd test -- tests/backfill-service.test.ts tests/backfill-repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add lib/backfill/adapters/index.ts lib/backfill/service.ts tests/backfill-service.test.ts
git commit -m "feat: orchestrate 24-hour backfill"
```

### Task 8: Add background runner and API contracts

**Files:**
- Create: `lib/backfill/runner.ts`
- Create: `app/api/backfill/route.ts`
- Create: `app/api/backfill/[runId]/route.ts`
- Create: `tests/backfill-api.test.ts`
- Create: `tests/backfill-runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

```ts
it("reuses the current running task", async () => {
  repository.findRunningBackfill.mockResolvedValue(existingRun);
  expect(await startBackfill(db, {}, now)).toEqual({
    run: existingRun,
    reused: true,
  });
  expect(repository.createBackfillRun).not.toHaveBeenCalled();
});

it("marks database-only running tasks interrupted after restart", async () => {
  repository.findRunningBackfill.mockResolvedValue(existingRun);
  expect(await reconcileBackfillState(db, now)).toBe(1);
  expect(repository.interruptRunningBackfills).toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing API tests**

Test:

- `POST /api/backfill` returns 202 with `{ run, reused }`.
- `{ sourceId: "36kr-macro" }` is accepted.
- unknown source and malformed JSON return 400.
- `GET /api/backfill` returns the latest task or `{ run: null }`.
- `GET /api/backfill/42` returns a task; unknown id returns 404.

- [ ] **Step 3: Run and verify RED**

Run: `npm.cmd test -- tests/backfill-runner.test.ts tests/backfill-api.test.ts`

Expected: FAIL because runner and routes are missing.

- [ ] **Step 4: Implement runner**

Create a module-level `Map<number, Promise<void>>` for active tasks and a serialized `startLock` promise. `startBackfill` must:

1. Validate optional `sourceId` against `SOURCE_IDS`.
2. Reuse a database running task only when its id is present in the active map.
3. Mark a database-only running task interrupted.
4. Create a fixed `[now - 86_400_000, now]` run and source rows.
5. Start `runBackfillSources` without awaiting it.
6. Catch every background rejection, persist failed status, and remove the id from the active map in `finally`.

Export `isBackfillActive()` for the regular refresh route and `reconcileBackfillState()` for GET routes.

- [ ] **Step 5: Implement routes**

Both routes call `getD1()` and `ensureSchema()` first. Parse route ids as positive integers. `POST` reads at most optional JSON `{ sourceId }`; an empty body means all sources. `GET /api/backfill` reconciles stale state before returning the latest task.

- [ ] **Step 6: Run tests, TypeScript, and commit**

Run:

```powershell
npm.cmd test -- tests/backfill-runner.test.ts tests/backfill-api.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
```

Expected: PASS.

```powershell
git add lib/backfill/runner.ts app/api/backfill/route.ts app/api/backfill/[runId]/route.ts tests/backfill-runner.test.ts tests/backfill-api.test.ts
git commit -m "feat: expose background backfill API"
```

### Task 9: Prevent ordinary ingestion from overlapping backfill

**Files:**
- Modify: `lib/domain.ts`
- Modify: `app/api/refresh/route.ts`
- Modify: `app/dashboard.tsx`
- Modify: `tests/api-contract.test.ts`

- [ ] **Step 1: Add failing busy-contract test**

Mock `isBackfillActive` and assert:

```ts
it("skips ordinary ingestion while backfill is active", async () => {
  fakes.isBackfillActive.mockReturnValue(true);
  const response = await POST();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ status: "busy" });
  expect(fakes.runIngestion).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm.cmd test -- tests/api-contract.test.ts`

Expected: FAIL because refresh does not know about backfill.

- [ ] **Step 3: Implement busy response**

Extend `RefreshResponse.status` with `"busy"`. At the start of refresh POST, after schema initialization, return:

```ts
if (isBackfillActive()) {
  return Response.json({
    status: "busy",
    refreshedAt: new Date().toISOString(),
  }, { status: 202 });
}
```

In Dashboard refresh notices, display `补采进行中，本轮普通采集已跳过` for `busy`; do not treat it as an error.

- [ ] **Step 4: Run tests and commit**

Run: `npm.cmd test -- tests/api-contract.test.ts`

Expected: PASS.

```powershell
git add lib/domain.ts app/api/refresh/route.ts app/dashboard.tsx tests/api-contract.test.ts
git commit -m "feat: isolate routine and backfill ingestion"
```

### Task 10: Add the dashboard confirmation and progress panel

**Files:**
- Create: `lib/backfill/presentation.ts`
- Modify: `app/dashboard.tsx`
- Modify: `app/globals.css`
- Modify: `tests/dashboard-policy.test.ts`

- [ ] **Step 1: Add a pure status-label helper and failing tests**

Create and test in `lib/backfill/presentation.ts`:

```ts
import type { BackfillRun, BackfillSourceStatus } from "./types";

export const BACKFILL_STATUS_LABELS = {
  pending: "等待中",
  running: "采集中",
  complete: "完整",
  partial: "部分完成",
  failed: "失败",
  interrupted: "已中断",
} as const;

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
```

Assert every source status has a Chinese label and totals are summed correctly.

- [ ] **Step 2: Implement dashboard state and API helpers**

Add state for `backfillRun`, `backfillStarting`, `backfillError`, and confirmation visibility. On mount, GET `/api/backfill`; while a task is running, poll `/api/backfill/{id}` every 1,000ms. Clear the timer on unmount.

Starting flow:

1. Open the native lightweight confirmation panel in the page, not `window.confirm`.
2. POST `{}` to `/api/backfill`.
3. Store the returned run and begin polling.
4. When status leaves `running`, stop polling and call `loadFeed` with current filters, page 1, reason `refresh`.

Use a ref for the previously observed status so completion refresh runs exactly once.

- [ ] **Step 3: Render accessible controls**

Add:

- Toolbar button `补采过去24小时`, disabled while starting or running.
- Confirmation region with `确认补采` and `取消` buttons.
- `section.backfill-panel` with `aria-live="polite"`.
- One row per source showing source/channel, status label, pages, inserted count, and formatted earliest coverage.
- Error text only for failed/partial/interrupted sources.
- No single-source button in this version; the API support is retained for the later feature.

- [ ] **Step 4: Add responsive styles**

Use the existing forest/amber palette. Desktop source rows use a grid; under 820px they stack without horizontal overflow. Add distinct but non-alarming colors for complete, partial, failed, and running states. Keep the current toolbar order and make the two action buttons wrap together on mobile.

- [ ] **Step 5: Run dashboard tests, lint, and TypeScript**

Run:

```powershell
npm.cmd test -- tests/dashboard-policy.test.ts tests/backfill-api.test.ts
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run lint
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add lib/backfill/presentation.ts app/dashboard.tsx app/globals.css tests/dashboard-policy.test.ts
git commit -m "feat: show 24-hour backfill progress"
```

### Task 11: Complete automated and live acceptance

**Files:**
- Modify only implementation or tests if verification exposes a directly related defect.

- [ ] **Step 1: Run the complete automated gate**

```powershell
npm.cmd test
.\node_modules\.bin\tsc.cmd --noEmit
npm.cmd run lint
npm.cmd run build
git diff --check
git status --short
```

Expected: all tests pass, TypeScript/lint/build exit 0, no whitespace errors, and the worktree is clean.

- [ ] **Step 2: Start exactly one local server**

Check port 3000 before starting. If absent, run `npm.cmd run dev` from the feature worktree. Do not leave both master and feature servers running.

- [ ] **Step 3: Exercise API contracts locally**

```powershell
$start = Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/api/backfill' `
  -ContentType 'application/json' -Body '{}'
$runId = $start.run.id
do {
  Start-Sleep -Seconds 1
  $status = Invoke-RestMethod -Uri "http://localhost:3000/api/backfill/$runId"
} while ($status.run.status -eq 'running')
$status.run | ConvertTo-Json -Depth 6
```

Expected: HTTP 202 on start; every source ends in complete/partial/failed with pages and coverage evidence; at least one successfully reachable source inserts or recognizes records.

- [ ] **Step 4: Verify data invariants**

Query local D1 and confirm:

- no duplicate `dedupe_key`;
- stored backfill items lie within the fixed window;
- reported inserted totals equal actual new unique rows;
- no `running` task remains after completion;
- a second identical task produces existing counts rather than duplicates.

- [ ] **Step 5: Verify browser behavior**

At desktop and 375px width, confirm:

1. Confirmation can be canceled without a request.
2. Starting disables the button and opens progress.
3. Search, source filters, time filters, pagination, and article links remain usable.
4. Each source updates independently.
5. Completion reloads page 1 once.
6. Refreshing the browser restores the latest task panel.
7. No horizontal overflow or console errors occur.

- [ ] **Step 6: Final status and handoff**

Run:

```powershell
git log --oneline -12
git status --short --branch
```

Expected: all task commits are present and the feature worktree is clean. Then use `finishing-a-development-branch` to apply the user's chosen local merge/no-push workflow.
