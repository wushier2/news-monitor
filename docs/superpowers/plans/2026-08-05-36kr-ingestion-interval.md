# 36Kr Differential Ingestion Interval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep automatic ingestion for three sources at five minutes while limiting automatic 36Kr macro ingestion to one attempt every fifteen minutes and preserving a manual force refresh.

**Architecture:** Keep the existing five-minute dashboard timer and refresh endpoint. Add a small source-interval policy, let `runIngestion` select due sources from `source_status.last_attempt_at`, and use an explicit `force=1` request only for the manual refresh button.

**Tech Stack:** TypeScript 5.9, React 19, Vinext/Cloudflare Workers, D1, Vitest, ESLint

---

## File Structure

- Create `lib/source-interval-policy.ts`: pure per-source due-time decision with the 15-minute 36Kr constant.
- Create `tests/source-interval-policy.test.ts`: boundary tests for first run, 5/10 minutes, exact 15 minutes, force mode, and unaffected sources.
- Modify `lib/ingestion.ts`: load source statuses for automatic runs and ingest only due sources.
- Modify `tests/ingestion.test.ts`: verify automatic source selection and manual force behavior.
- Modify `lib/refresh-policy.ts`: build the automatic or manual refresh endpoint consistently.
- Modify `tests/refresh-policy.test.ts`: verify automatic and force endpoint URLs.
- Modify `app/api/refresh/route.ts`: parse `force=1`, bypass global freshness only for manual requests, and pass force mode to ingestion.
- Modify `tests/api-contract.test.ts`: verify fresh automatic requests skip and fresh manual requests ingest.
- Modify `app/dashboard.tsx`: use the force endpoint only when `manual === true`.

### Task 1: Add the per-source interval policy

**Files:**
- Create: `lib/source-interval-policy.ts`
- Create: `tests/source-interval-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

```ts
import { describe, expect, it } from "vitest";
import {
  KR36_AUTO_INTERVAL_MS,
  shouldIngestSource,
} from "../lib/source-interval-policy";

describe("source ingestion interval policy", () => {
  const now = new Date("2026-08-05T10:00:00.000Z");

  it("always includes non-36Kr sources", () => {
    expect(shouldIngestSource(
      "cls-headline",
      new Date(now.getTime() - 60_000),
      now,
      false,
    )).toBe(true);
  });

  it("includes 36Kr initially and at the exact fifteen-minute boundary", () => {
    expect(shouldIngestSource("36kr-macro", null, now, false)).toBe(true);
    expect(KR36_AUTO_INTERVAL_MS).toBe(15 * 60_000);
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - KR36_AUTO_INTERVAL_MS),
      now,
      false,
    )).toBe(true);
  });

  it("skips 36Kr after five or ten minutes", () => {
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - 5 * 60_000),
      now,
      false,
    )).toBe(false);
    expect(shouldIngestSource(
      "36kr-macro",
      new Date(now.getTime() - 10 * 60_000),
      now,
      false,
    )).toBe(false);
  });

  it("includes 36Kr when refresh is forced", () => {
    expect(shouldIngestSource("36kr-macro", now, now, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the policy test and verify RED**

Run: `npm.cmd test -- tests/source-interval-policy.test.ts`

Expected: FAIL because `lib/source-interval-policy.ts` does not exist.

- [ ] **Step 3: Implement the minimal policy**

```ts
import type { SourceId } from "./domain";

export const KR36_AUTO_INTERVAL_MS = 15 * 60_000;

export function shouldIngestSource(
  sourceId: SourceId,
  lastAttemptAt: Date | null,
  now: Date,
  force: boolean,
): boolean {
  if (force || sourceId !== "36kr-macro" || !lastAttemptAt) return true;
  return now.getTime() - lastAttemptAt.getTime() >= KR36_AUTO_INTERVAL_MS;
}
```

- [ ] **Step 4: Run the policy test and verify GREEN**

Run: `npm.cmd test -- tests/source-interval-policy.test.ts`

Expected: 1 test file passes with 4 passing tests.

- [ ] **Step 5: Commit the policy**

```powershell
git add -- lib/source-interval-policy.ts tests/source-interval-policy.test.ts
git commit -m "feat: add source ingestion interval policy"
```

### Task 2: Filter automatic ingestion by last attempt time

**Files:**
- Modify: `lib/ingestion.ts`
- Modify: `tests/ingestion.test.ts`

- [ ] **Step 1: Extend ingestion fakes and write failing orchestration tests**

Add `getSourceStatuses: vi.fn()` to the hoisted fakes and repository mock. Import `SOURCES` from `../lib/sources`. In `beforeEach`, add:

```ts
fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
  sourceId: source.id,
  lastAttemptAt: null,
  lastSuccessAt: null,
  status: "idle",
  error: null,
  itemCount: 0,
})));
```

Add these tests:

```ts
it("skips 36Kr when its last attempt is less than fifteen minutes old", async () => {
  const now = new Date("2026-08-05T10:00:00.000Z");
  fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
    sourceId: source.id,
    lastAttemptAt: source.id === "36kr-macro"
      ? "2026-08-05T09:50:00.000Z"
      : "2026-08-05T09:55:00.000Z",
    lastSuccessAt: null,
    status: "idle",
    error: null,
    itemCount: 0,
  })));
  fakes.fetchSource.mockImplementation(async (source: { id: SourceId }) => [{
    sourceId: source.id,
    sourceName: "来源",
    channelName: "频道",
    title: `${source.id} 标题`,
    summary: "",
    url: `https://example.test/${source.id}`,
    publishedAt: null,
  }]);

  await runIngestion({} as D1Database, now);

  expect(fakes.fetchSource.mock.calls.map(([source]) => source.id))
    .toEqual(["jiemian-regulatory", "jiemian-current-affairs", "cls-headline"]);
});

it("forces all four sources regardless of the last 36Kr attempt", async () => {
  const now = new Date("2026-08-05T10:00:00.000Z");
  fakes.getSourceStatuses.mockResolvedValue(SOURCES.map((source) => ({
    sourceId: source.id,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: null,
    status: "idle",
    error: null,
    itemCount: 0,
  })));
  fakes.fetchSource.mockImplementation(async (source: { id: SourceId }) => [{
    sourceId: source.id,
    sourceName: "来源",
    channelName: "频道",
    title: `${source.id} 标题`,
    summary: "",
    url: `https://example.test/${source.id}`,
    publishedAt: null,
  }]);

  await runIngestion({} as D1Database, now, { force: true });

  expect(fakes.fetchSource).toHaveBeenCalledTimes(4);
  expect(fakes.getSourceStatuses).not.toHaveBeenCalled();
});
```

Import `SourceId` from `../lib/domain` alongside the existing normalized item type.

- [ ] **Step 2: Run ingestion tests and verify RED**

Run: `npm.cmd test -- tests/ingestion.test.ts`

Expected: FAIL because `runIngestion` does not read source status, does not accept `{ force: true }`, and still fetches all four sources.

- [ ] **Step 3: Implement source selection in `runIngestion`**

Add `getSourceStatuses` to repository imports, import `shouldIngestSource`, and use this signature:

```ts
interface IngestionOptions {
  force?: boolean;
}

export async function runIngestion(
  db: D1Database,
  now = new Date(),
  options: IngestionOptions = {},
): Promise<IngestionSummary> {
  const runId = await startRun(db, now);
  const force = options.force === true;
  const statuses = force ? [] : await getSourceStatuses(db);
  const lastAttemptBySource = new Map(statuses.map((status) => [
    status.sourceId,
    status.lastAttemptAt ? new Date(status.lastAttemptAt) : null,
  ]));
  const dueSources = SOURCES.filter((source) => shouldIngestSource(
    source.id,
    lastAttemptBySource.get(source.id) ?? null,
    now,
    force,
  ));
  const results = await Promise.allSettled(dueSources.map(async (source) => {
    const items = await fetchSource(source);
    if (!items.length) throw new Error("No valid items found");
    await upsertItems(db, items, now);
    await setSourceSuccess(db, source.id, now, items.length);
    return items.length;
  }));
```

Update the result loop to use `dueSources[index].id` when persisting failures. Keep cleanup, run status, and summary fields unchanged.

- [ ] **Step 4: Run ingestion tests and verify GREEN**

Run: `npm.cmd test -- tests/ingestion.test.ts`

Expected: ingestion test file passes; automatic fresh 36Kr is skipped and forced ingestion includes four sources.

- [ ] **Step 5: Commit ingestion orchestration**

```powershell
git add -- lib/ingestion.ts tests/ingestion.test.ts
git commit -m "feat: apply 36Kr automatic ingestion interval"
```

### Task 3: Pass manual force intent from dashboard to API

**Files:**
- Modify: `lib/refresh-policy.ts`
- Modify: `tests/refresh-policy.test.ts`
- Modify: `app/api/refresh/route.ts`
- Modify: `tests/api-contract.test.ts`
- Modify: `app/dashboard.tsx`

- [ ] **Step 1: Write failing endpoint helper tests**

Extend the refresh-policy import and add:

```ts
it("uses an explicit force flag only for manual refresh", () => {
  expect(refreshEndpoint(false)).toBe("/api/refresh");
  expect(refreshEndpoint(true)).toBe("/api/refresh?force=1");
});
```

- [ ] **Step 2: Run refresh-policy tests and verify RED**

Run: `npm.cmd test -- tests/refresh-policy.test.ts`

Expected: FAIL because `refreshEndpoint` is not exported.

- [ ] **Step 3: Implement and use the endpoint helper**

Add to `lib/refresh-policy.ts`:

```ts
export function refreshEndpoint(force: boolean): string {
  return force ? "/api/refresh?force=1" : "/api/refresh";
}
```

Import `refreshEndpoint` in `app/dashboard.tsx` and replace the fixed fetch URL with:

```ts
const response = await fetch(refreshEndpoint(manual), { method: "POST" });
```

- [ ] **Step 4: Run refresh-policy tests and verify GREEN**

Run: `npm.cmd test -- tests/refresh-policy.test.ts tests/dashboard-policy.test.ts`

Expected: both test files pass and the dashboard polling constant remains 300,000 ms.

- [ ] **Step 5: Write the failing API force-refresh test**

Add to `tests/api-contract.test.ts`:

```ts
it("forces ingestion even when data is still fresh", async () => {
  fakes.getLastSuccessfulIngestion.mockResolvedValue(new Date());
  fakes.runIngestion.mockResolvedValue({
    status: "success",
    successCount: 4,
    failureCount: 0,
    itemCount: 12,
    refreshedAt: "2026-08-05T10:00:00.000Z",
  });

  const response = await POST(new Request(
    "https://example.test/api/refresh?force=1",
    { method: "POST" },
  ));

  expect(response.status).toBe(200);
  expect(fakes.getLastSuccessfulIngestion).not.toHaveBeenCalled();
  expect(fakes.runIngestion).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Date),
    { force: true },
  );
});
```

- [ ] **Step 6: Run the API test and verify RED**

Run: `npm.cmd test -- tests/api-contract.test.ts`

Expected: FAIL because `POST` ignores the request force parameter and returns 202 skipped.

- [ ] **Step 7: Implement force parsing in the refresh route**

Change the route signature and freshness guard:

```ts
export async function POST(request?: Request) {
  try {
    const db = getD1();
    await ensureSchema(db);
    const now = new Date();
    const force = request
      ? new URL(request.url).searchParams.get("force") === "1"
      : false;
    if (isBackfillActive()) {
      return Response.json({
        status: "busy",
        refreshedAt: now.toISOString(),
      }, { status: 202 });
    }
    if (!force) {
      const lastSuccess = await getLastSuccessfulIngestion(db);
      if (lastSuccess && !shouldRefresh(lastSuccess, now)) {
        return Response.json({
          status: "skipped",
          refreshedAt: lastSuccess.toISOString(),
          retryAfterSeconds: retryAfterSeconds(lastSuccess, now),
        }, { status: 202 });
      }
    }
    const result = await runIngestion(db, now, { force });
```

Keep the existing response status mapping and catch block unchanged. Backfill activity remains higher priority than manual force.

- [ ] **Step 8: Run API and dashboard policy tests and verify GREEN**

Run: `npm.cmd test -- tests/api-contract.test.ts tests/refresh-policy.test.ts tests/dashboard-policy.test.ts`

Expected: all three test files pass; automatic fresh requests still return 202 and manual requests run ingestion.

- [ ] **Step 9: Commit the manual force path**

```powershell
git add -- lib/refresh-policy.ts tests/refresh-policy.test.ts app/api/refresh/route.ts tests/api-contract.test.ts app/dashboard.tsx
git commit -m "feat: force all sources on manual refresh"
```

### Task 4: Final verification

**Files:**
- Verify: all modified files

- [ ] **Step 1: Run all automated tests**

Run: `npm.cmd test`

Expected: all test files and tests pass with zero failures.

- [ ] **Step 2: Run TypeScript validation**

Run: `npx.cmd tsc --noEmit`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Run lint**

Run: `npm.cmd run lint`

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 4: Run the production build**

Run: `npm.cmd run build`

Expected: `Build complete` and exit code 0.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check` and `git status -sb`.

Expected: no whitespace errors and only the planned source, test, design, and plan files are present.
