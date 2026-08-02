# Collapsible Backfill Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the approved compact collapsed state to the 24-hour backfill panel while automatically expanding active and erroneous tasks.

**Architecture:** Keep disclosure state local to `Dashboard`; derive automatic expansion from a small pure policy helper in the existing backfill presentation module. Render a compact summary bar when collapsed and the existing detailed panel when expanded, without changing APIs, persistence, or ingestion behavior.

**Tech Stack:** React 19, TypeScript, Vitest, CSS, Vinext/Vite

---

## File Structure

- Modify `lib/backfill/presentation.ts`: own the pure auto-expansion and toggle-label policies alongside existing backfill labels and summaries.
- Modify `tests/dashboard-policy.test.ts`: test the policy functions before UI implementation.
- Modify `app/dashboard.tsx`: hold disclosure state, react to running/error signals, and render compact versus detailed content.
- Modify `app/globals.css`: style the compact status bar, toggle button, and narrow-screen wrapping.

Preserve the existing uncommitted 36Kr files and stage only files named by each task.

### Task 1: Backfill Disclosure Policy

**Files:**
- Modify: `tests/dashboard-policy.test.ts`
- Modify: `lib/backfill/presentation.ts`

- [ ] **Step 1: Write the failing policy tests**

Extend the presentation imports in `tests/dashboard-policy.test.ts`:

```ts
import {
  BACKFILL_STATUS_LABELS,
  backfillStatusLabel,
  backfillSummary,
  backfillToggleLabel,
  shouldAutoExpandBackfill,
} from "../lib/backfill/presentation";
```

Add these tests inside `describe("dashboard refresh policy", ...)`:

```ts
it("auto-expands running and erroneous backfill panels", () => {
  expect(shouldAutoExpandBackfill("running", false)).toBe(true);
  expect(shouldAutoExpandBackfill("complete", false)).toBe(false);
  expect(shouldAutoExpandBackfill(null, false)).toBe(false);
  expect(shouldAutoExpandBackfill("complete", true)).toBe(true);
  expect(shouldAutoExpandBackfill(null, true)).toBe(true);
});

it("labels the backfill disclosure action", () => {
  expect(backfillToggleLabel(false)).toBe("查看明细");
  expect(backfillToggleLabel(true)).toBe("收起明细");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```powershell
npm.cmd test -- tests/dashboard-policy.test.ts
```

Expected: FAIL because `shouldAutoExpandBackfill` and `backfillToggleLabel` are not exported.

- [ ] **Step 3: Implement the minimal policies**

Add to `lib/backfill/presentation.ts`:

```ts
export function shouldAutoExpandBackfill(
  status: BackfillRun["status"] | null,
  hasError: boolean,
): boolean {
  return hasError || status === "running";
}

export function backfillToggleLabel(expanded: boolean): string {
  return expanded ? "收起明细" : "查看明细";
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run:

```powershell
npm.cmd test -- tests/dashboard-policy.test.ts
```

Expected: the dashboard policy test file passes with no failed tests.

- [ ] **Step 5: Commit the policy change**

```powershell
git add -- lib/backfill/presentation.ts tests/dashboard-policy.test.ts
git commit -m "test: define backfill disclosure policy"
```

### Task 2: Dashboard Disclosure Interaction

**Files:**
- Modify: `app/dashboard.tsx:22-30,102-115,300-414,541-590`

- [ ] **Step 1: Import the policy helpers**

Update the existing presentation import:

```ts
import {
  backfillStatusLabel,
  backfillSummary,
  backfillToggleLabel,
  shouldAutoExpandBackfill,
} from "../lib/backfill/presentation";
```

- [ ] **Step 2: Add disclosure state and automatic expansion**

Add beside the existing backfill state declarations:

```ts
const [backfillExpanded, setBackfillExpanded] = useState(false);
```

Add after the `runningBackfillId` calculation:

```ts
useEffect(() => {
  if (shouldAutoExpandBackfill(
    backfillRun?.status ?? null,
    Boolean(backfillError),
  )) {
    setBackfillExpanded(true);
  }
}, [backfillRun?.status, backfillError]);
```

This leaves completed tasks collapsed on initial load, expands a running task or error, and does not collapse a task when it changes from `running` to a terminal status.

- [ ] **Step 3: Render the compact bar and controlled details**

Replace the current `backfill-panel` block with this structure, retaining the existing source-row mapping inside the marked details area:

```tsx
{(backfillRun || backfillError) && (
  <section
    className={`backfill-panel ${backfillExpanded ? "" : "backfill-panel-collapsed"}`}
    aria-live="polite"
  >
    {!backfillExpanded && (
      <div className="backfill-compact-bar">
        <strong>过去 24 小时补采</strong>
        <span>
          {backfillRun ? backfillSummary(backfillRun) : "补采状态异常"}
        </span>
        {backfillRun?.finishedAt && (
          <time dateTime={backfillRun.finishedAt}>
            {formatTime(backfillRun.finishedAt)}
          </time>
        )}
        <button
          className="backfill-toggle"
          aria-expanded={false}
          aria-controls="backfill-details"
          onClick={() => setBackfillExpanded(true)}
        >
          {backfillToggleLabel(false)} <span aria-hidden="true">⌄</span>
        </button>
      </div>
    )}

    <div id="backfill-details" hidden={!backfillExpanded}>
      {backfillExpanded && (
        <>
          <div className="backfill-panel-heading">
            <div>
              <span className="section-kicker">HISTORICAL COVERAGE</span>
              <h2>过去 24 小时补充采集</h2>
            </div>
            <div className="backfill-heading-actions">
              {backfillRun && (
                <div className="backfill-overview">
                  <strong>{backfillSummary(backfillRun)}</strong>
                  <span>
                    {formatTime(backfillRun.windowStart)} 至 {formatTime(backfillRun.windowEnd)}
                  </span>
                </div>
              )}
              <button
                className="backfill-toggle"
                aria-expanded={true}
                aria-controls="backfill-details"
                onClick={() => setBackfillExpanded(false)}
              >
                {backfillToggleLabel(true)} <span aria-hidden="true">⌃</span>
              </button>
            </div>
          </div>
          {backfillError && <p className="backfill-error" role="alert">{backfillError}</p>}
          {backfillRun && (
            <div className="backfill-source-list">
              {backfillRun.sources.map((source) => {
                const definition = SOURCES.find((item) => item.id === source.sourceId);
                const showError = ["partial", "failed", "interrupted"].includes(source.status)
                  && source.error;
                return (
                  <article className="backfill-source-row" key={source.sourceId}>
                    <div className="backfill-source-name">
                      <strong>{definition?.sourceName ?? source.sourceId}</strong>
                      <span>{definition?.channelName}</span>
                    </div>
                    <span className={`backfill-status backfill-status-${source.status}`}>
                      {backfillStatusLabel(source.status)}
                    </span>
                    <div className="backfill-metrics">
                      <span>{source.pagesFetched} 页</span>
                      <span>抓取 {source.itemsFetched} 条</span>
                      <strong>新增 {source.itemsInserted} 条</strong>
                    </div>
                    <div className="backfill-coverage">
                      {source.earliestCoveredAt
                        ? `已覆盖至 ${formatTime(source.earliestCoveredAt)}`
                        : "尚无有效时间覆盖"}
                      {showError && <small>{source.error}</small>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  </section>
)}
```

- [ ] **Step 4: Run focused and type checks**

Run:

```powershell
npm.cmd test -- tests/dashboard-policy.test.ts
npx.cmd tsc --noEmit
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the interaction**

```powershell
git add -- app/dashboard.tsx
git commit -m "feat: add backfill panel disclosure"
```

### Task 3: Compact and Responsive Styling

**Files:**
- Modify: `app/globals.css:210-229,368-413`

- [ ] **Step 1: Add the compact desktop styles**

Add after `.backfill-panel`:

```css
.backfill-panel-collapsed { padding: 0; }
.backfill-compact-bar {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 42px;
  padding: 7px 24px;
}
.backfill-compact-bar > strong { color: var(--forest); font-size: 12px; }
.backfill-compact-bar > span { color: var(--muted); font-size: 10px; }
.backfill-compact-bar time { color: #8a948e; font-size: 10px; }
.backfill-heading-actions {
  display: flex;
  align-items: flex-end;
  gap: 14px;
}
.backfill-toggle {
  flex: 0 0 auto;
  padding: 6px 9px;
  border: 1px solid #cfd8d1;
  border-radius: 6px;
  color: var(--forest);
  background: #fff;
  font-size: 10px;
  font-weight: 750;
}
.backfill-compact-bar .backfill-toggle { margin-left: auto; }
```

- [ ] **Step 2: Add narrow-screen wrapping**

Inside `@media (max-width: 820px)`, add:

```css
.backfill-panel-collapsed { padding: 0; }
.backfill-compact-bar {
  flex-wrap: wrap;
  gap: 5px 10px;
  padding: 8px 12px;
}
.backfill-compact-bar > strong { width: 100%; }
.backfill-compact-bar .backfill-toggle { margin-left: auto; }
.backfill-heading-actions {
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
}
```

- [ ] **Step 3: Run lint and build**

Run:

```powershell
npm.cmd run lint
npm.cmd run build
```

Expected: both commands exit 0; build lists `/`, `/api/feed`, `/api/refresh`, and backfill routes.

- [ ] **Step 4: Commit the styling**

```powershell
git add -- app/globals.css
git commit -m "style: compact collapsed backfill status"
```

### Task 4: Full Verification and Browser QA

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run all automated verification**

Run:

```powershell
npm.cmd test
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
git diff --check
```

Expected: all commands exit 0; Vitest reports no failed files or tests; `git diff --check` reports no whitespace errors.

- [ ] **Step 2: Start the real local service**

Run:

```powershell
npm.cmd run dev
```

Open `http://localhost:3000/` after the listener is ready.

- [ ] **Step 3: Verify desktop behavior**

At a desktop viewport:

1. Confirm an existing completed backfill appears as a single compact bar.
2. Confirm the source list is absent and the latest-feed heading moves directly below the bar.
3. Click “查看明细”; confirm the current full heading, summary, errors, and source rows appear.
4. Confirm the button changes to “收起明细” and `aria-expanded="true"`.
5. Click “收起明细”; confirm the details disappear without residual vertical space.
6. Start a backfill; confirm the panel opens automatically and stays open after completion.

- [ ] **Step 4: Verify narrow-screen behavior**

At a viewport no wider than 820px:

1. Confirm the compact bar wraps without horizontal scrolling.
2. Confirm the disclosure button remains visible and clickable.
3. Expand the details and confirm existing source rows retain their responsive two-column layout.

- [ ] **Step 5: Inspect the final diff and status**

Run:

```powershell
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: feature commits contain only `lib/backfill/presentation.ts`, `tests/dashboard-policy.test.ts`, `app/dashboard.tsx`, and `app/globals.css`. Pre-existing 36Kr working-tree modifications remain unstaged unless separately requested.
