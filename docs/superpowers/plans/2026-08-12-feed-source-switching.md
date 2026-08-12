# 信息流平台切换优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台和时间筛选立即发起请求，连续切换时只保留最后一次结果，同时用旧列表淡化和明确状态提示消除“内容跟不上、卡住”的感受。

**Architecture:** 新增一个小型客户端请求策略模块，集中定义搜索防抖时间、请求控制器替换和中止识别；`Dashboard` 继续负责页面状态，但把搜索触发与平台/时间触发拆开。所有信息流读取共享请求协调器，利用 `AbortController` 和递增序号双重阻止旧响应覆盖新状态，并用独立的筛选加载状态控制提示、淡化和分页禁用。

**Tech Stack:** React 19、TypeScript 5.9、Vinext、原生 Fetch/AbortController、Vitest、CSS

---

## 文件结构

- Create: `lib/feed-request-policy.ts` — 搜索延迟、请求票据、控制器替换、当前请求判断和中止错误识别。
- Create: `tests/feed-request-policy.test.ts` — 对延迟策略、旧请求中止、序号失效和卸载取消做纯单元测试。
- Modify: `app/dashboard.tsx` — 接入请求协调器，拆分筛选触发，增加筛选加载/失败状态，并避免自动回读抢占用户请求。
- Modify: `app/globals.css` — 为旧消息流增加轻微淡化过渡，并确保减少动态效果偏好下无动画。

### Task 1: 建立可测试的请求策略与协调器

**Files:**
- Create: `tests/feed-request-policy.test.ts`
- Create: `lib/feed-request-policy.ts`

- [ ] **Step 1: 写入失败测试**

创建 `tests/feed-request-policy.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  FeedRequestCoordinator,
  SEARCH_FILTER_DELAY_MS,
  feedFilterDelay,
  isAbortError,
} from "../lib/feed-request-policy";

describe("feed request policy", () => {
  it("debounces search but runs source and time selections immediately", () => {
    expect(SEARCH_FILTER_DELAY_MS).toBe(250);
    expect(feedFilterDelay("search")).toBe(250);
    expect(feedFilterDelay("selection")).toBe(0);
  });

  it("aborts and invalidates the previous ticket when a new request begins", () => {
    const coordinator = new FeedRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it("aborts and invalidates the current ticket when cancelled", () => {
    const coordinator = new FeedRequestCoordinator();
    const ticket = coordinator.begin();

    coordinator.cancel();

    expect(ticket.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(ticket)).toBe(false);
  });

  it("recognizes browser-style abort errors without hiding ordinary failures", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("network failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run: `npm.cmd test -- tests/feed-request-policy.test.ts`

Expected: FAIL，错误指出无法解析 `../lib/feed-request-policy`。

- [ ] **Step 3: 写入最小实现**

创建 `lib/feed-request-policy.ts`：

```ts
export const SEARCH_FILTER_DELAY_MS = 250;

export type FeedFilterChange = "search" | "selection";

export interface FeedRequestTicket {
  id: number;
  signal: AbortSignal;
}

export function feedFilterDelay(change: FeedFilterChange): number {
  return change === "search" ? SEARCH_FILTER_DELAY_MS : 0;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

export class FeedRequestCoordinator {
  private controller: AbortController | null = null;
  private sequence = 0;

  begin(): FeedRequestTicket {
    this.controller?.abort();
    this.controller = new AbortController();
    this.sequence += 1;
    return {
      id: this.sequence,
      signal: this.controller.signal,
    };
  }

  isCurrent(ticket: FeedRequestTicket): boolean {
    return ticket.id === this.sequence && !ticket.signal.aborted;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.sequence += 1;
  }
}
```

- [ ] **Step 4: 运行聚焦测试**

Run: `npm.cmd test -- tests/feed-request-policy.test.ts`

Expected: PASS，4 个测试全部通过。

- [ ] **Step 5: 提交策略模块**

```powershell
git add -- lib/feed-request-policy.ts tests/feed-request-policy.test.ts
git commit -m "test: define feed request coordination policy"
```

### Task 2: 接入立即切换、搜索防抖和请求中止

**Files:**
- Modify: `app/dashboard.tsx:1-305`
- Test: `tests/feed-request-policy.test.ts`

- [ ] **Step 1: 扩充测试，锁定普通错误与中止错误的显示策略**

在 `tests/feed-request-policy.test.ts` 的导入中加入 `feedLoadFailureMessage`，并在同一个 `describe` 中追加：

```ts
it("suppresses abort messages and explains when stale content is retained", () => {
  expect(feedLoadFailureMessage("source", { name: "AbortError" }))
    .toBeNull();
  expect(feedLoadFailureMessage("source", new Error("Network connection lost.")))
    .toBe("切换失败：Network connection lost.；以下仍为上一次结果");
  expect(feedLoadFailureMessage("search", new Error("读取失败")))
    .toBe("筛选失败：读取失败；以下仍为上一次结果");
  expect(feedLoadFailureMessage("time", new Error("读取失败")))
    .toBe("筛选失败：读取失败；以下仍为上一次结果");
  expect(feedLoadFailureMessage("page", new Error("读取失败")))
    .toBe("分页加载失败");
});
```

- [ ] **Step 2: 运行测试并确认新用例失败**

Run: `npm.cmd test -- tests/feed-request-policy.test.ts`

Expected: FAIL，错误指出 `feedLoadFailureMessage` 尚未导出。

- [ ] **Step 3: 实现失败消息策略**

在 `lib/feed-request-policy.ts` 中加入：

```ts
export type FeedLoadReason =
  | "initial"
  | "search"
  | "source"
  | "time"
  | "page"
  | "refresh";

export function feedLoadFailureMessage(
  reason: FeedLoadReason,
  error: unknown,
): string | null {
  if (isAbortError(error)) return null;
  const detail = error instanceof Error ? error.message : "读取失败";
  if (reason === "page") return "分页加载失败";
  if (reason === "source") {
    return `切换失败：${detail}；以下仍为上一次结果`;
  }
  if (reason === "search" || reason === "time") {
    return `筛选失败：${detail}；以下仍为上一次结果`;
  }
  return detail;
}
```

- [ ] **Step 4: 运行测试并确认策略通过**

Run: `npm.cmd test -- tests/feed-request-policy.test.ts`

Expected: PASS，5 个测试全部通过。

- [ ] **Step 5: 在 Dashboard 中引入策略、状态和请求结果类型**

在 `app/dashboard.tsx` 顶部加入导入：

```ts
import {
  FeedRequestCoordinator,
  SEARCH_FILTER_DELAY_MS,
  feedLoadFailureMessage,
  isAbortError,
  type FeedLoadReason,
} from "../lib/feed-request-policy";
```

在 `requestFeed` 前加入结果类型和平台显示名函数：

```ts
type FeedLoadOutcome =
  | { status: "success"; feed: FeedResponse }
  | { status: "aborted" }
  | { status: "failed" };

function sourceFilterLabel(sourceId: SourceId | "all"): string {
  if (sourceId === "all") return "全部来源";
  const source = SOURCES.find((item) => item.id === sourceId);
  if (!source) return "所选来源";
  return source.sourceName === "界面新闻"
    ? `界面${source.channelName.slice(0, 2)}`
    : source.sourceName;
}
```

给 `requestFeed` 增加最后一个可选参数，并把信号传入 `fetch`：

```ts
async function requestFeed(
  nextQuery = "",
  nextSource: SourceId | "all" = "all",
  range: AppliedTimeRange | null = null,
  page = 1,
  signal?: AbortSignal,
): Promise<FeedResponse> {
  const params = buildFeedSearchParams({
    query: nextQuery,
    sourceId: nextSource,
    range,
    page,
    pageSize: PAGE_SIZE,
  });
  const response = await fetch(`/api/feed?${params.toString()}`, {
    cache: "no-store",
    signal,
  });
  const payload = await response.json() as FeedResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "无法读取信息流");
  return payload;
}
```

在现有状态附近加入：

```ts
const [filterLoading, setFilterLoading] = useState(false);
const [filterStatus, setFilterStatus] = useState<string | null>(null);
```

用下列引用替换 `requestSequenceRef` 和 `filterEffectReadyRef`：

```ts
const feedRequestCoordinatorRef = useRef(new FeedRequestCoordinator());
const filterRequestActiveRef = useRef(false);
const searchTimerRef = useRef<number | null>(null);
const searchEffectReadyRef = useRef(false);
const sourceEffectReadyRef = useRef(false);
const timeEffectReadyRef = useRef(false);
```

- [ ] **Step 6: 用协调器重写 `loadFeed`，保证中止不报错且失败不清空旧列表**

将现有 `loadFeed` 替换为：

```ts
const loadFeed = useCallback(async (
  nextQuery: string,
  nextSource: SourceId | "all",
  nextRange: AppliedTimeRange | null,
  targetPage: number,
  reason: FeedLoadReason,
): Promise<FeedLoadOutcome> => {
  if (reason === "refresh" && filterRequestActiveRef.current) {
    return { status: "aborted" };
  }

  const coordinator = feedRequestCoordinatorRef.current;
  const ticket = coordinator.begin();
  const isFilterRequest = reason === "search"
    || reason === "source"
    || reason === "time";
  if (isFilterRequest) {
    filterRequestActiveRef.current = true;
    setFilterLoading(true);
    setFilterStatus(
      reason === "source"
        ? `正在切换至${sourceFilterLabel(nextSource)}…`
        : "正在更新筛选结果…",
    );
  }
  setPageError(null);
  setPageLoading(reason === "page");

  try {
    const payload = await requestFeed(
      nextQuery,
      nextSource,
      nextRange,
      targetPage,
      ticket.signal,
    );
    if (!mountedRef.current || !coordinator.isCurrent(ticket)) {
      return { status: "aborted" };
    }
    setFeed(payload);
    setPage(payload.pagination.page);
    setFatalError(null);
    if (isFilterRequest) {
      setFilterStatus(null);
      setNotice("筛选结果已更新");
    }
    if (reason === "page") {
      window.requestAnimationFrame(() => {
        feedHeadingRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
    return { status: "success", feed: payload };
  } catch (error) {
    if (
      isAbortError(error)
      || !mountedRef.current
      || !coordinator.isCurrent(ticket)
    ) {
      return { status: "aborted" };
    }
    const message = feedLoadFailureMessage(reason, error);
    if (reason === "page") {
      setPageError(message);
    } else if (isFilterRequest) {
      setFilterStatus(message);
    } else {
      setFatalError(message);
    }
    return { status: "failed" };
  } finally {
    if (mountedRef.current && coordinator.isCurrent(ticket)) {
      if (isFilterRequest) {
        filterRequestActiveRef.current = false;
        setFilterLoading(false);
      }
      setPageLoading(false);
    }
  }
}, []);
```

这里不在失败分支调用 `setFeed`，因此普通失败会保留现有文章；旧请求因为票据失效，不会清除新请求的加载状态。

- [ ] **Step 7: 更新调用方以使用明确的请求结果**

初次加载回调改为：

```ts
void loadFeed("", "all", null, 1, "initial").then((result) => {
  if (!active || result.status !== "success") return;
  const lastSuccess = newestSuccess(result.feed.sources);
  if (shouldAutoRefresh(lastSuccess ? new Date(lastSuccess).toISOString() : null)) {
    void refresh(false);
  } else {
    setNotice("信息流已是最新状态");
    setLoading(false);
  }
});
```

刷新后的回读改为：

```ts
const result = await loadFeed(
  currentFilters.query,
  currentFilters.sourceId,
  currentFilters.appliedRange,
  1,
  "refresh",
);
if (result.status === "aborted") return;
if (result.status === "failed") {
  setNotice("刷新后读取第 1 页失败");
  return;
}
```

其后的 `payload.status` 分支保持原样。分页和补采完成回读不读取返回值，无需改变调用结构。

- [ ] **Step 8: 拆分搜索与平台/时间触发，并在卸载时完整清理**

在初次加载 effect 的清理函数中，用下面代码替换递增请求序号：

```ts
feedRequestCoordinatorRef.current.cancel();
if (searchTimerRef.current !== null) {
  window.clearTimeout(searchTimerRef.current);
}
```

删除原来的合并筛选 effect，加入：

```ts
useEffect(() => {
  if (!searchEffectReadyRef.current) {
    searchEffectReadyRef.current = true;
    return;
  }
  searchTimerRef.current = window.setTimeout(() => {
    searchTimerRef.current = null;
    const currentFilters = filtersRef.current;
    void loadFeed(
      currentFilters.query,
      currentFilters.sourceId,
      currentFilters.appliedRange,
      1,
      "search",
    );
  }, SEARCH_FILTER_DELAY_MS);
  return () => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  };
}, [query, loadFeed]);

useEffect(() => {
  if (!sourceEffectReadyRef.current) {
    sourceEffectReadyRef.current = true;
    return;
  }
  if (searchTimerRef.current !== null) {
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }
  const currentFilters = filtersRef.current;
  void loadFeed(
    currentFilters.query,
    currentFilters.sourceId,
    currentFilters.appliedRange,
    1,
    "source",
  );
}, [sourceId, loadFeed]);
```

再加入独立的时间筛选 effect：

```ts
useEffect(() => {
  if (!timeEffectReadyRef.current) {
    timeEffectReadyRef.current = true;
    return;
  }
  if (searchTimerRef.current !== null) {
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
  }
  const currentFilters = filtersRef.current;
  void loadFeed(
    currentFilters.query,
    currentFilters.sourceId,
    currentFilters.appliedRange,
    1,
    "time",
  );
}, [appliedRange, loadFeed]);
```

三个 effect 都通过 `filtersRef.current` 读取另外两个筛选值；平台 effect 只依赖 `sourceId`，时间 effect 只依赖 `appliedRange`，因此查询词变化不会重复触发即时请求。

- [ ] **Step 9: 运行聚焦测试、类型检查和代码检查**

Run: `npm.cmd test -- tests/feed-request-policy.test.ts tests/dashboard-policy.test.ts`

Expected: PASS，两个测试文件全部通过。

Run: `npx.cmd tsc --noEmit`

Expected: PASS，无 TypeScript 错误。

Run: `npm.cmd run lint`

Expected: PASS，无 ESLint 错误。

- [ ] **Step 10: 提交请求逻辑改动**

```powershell
git add -- app/dashboard.tsx lib/feed-request-policy.ts tests/feed-request-policy.test.ts
git commit -m "perf: make feed filters responsive"
```

### Task 3: 加入旧列表淡化、状态提示和分页保护

**Files:**
- Modify: `app/dashboard.tsx:655-733`
- Modify: `app/globals.css:296-410`

- [ ] **Step 1: 接入筛选状态显示和无障碍忙碌状态**

将标题右侧状态改为筛选状态优先：

```tsx
<p role={filterStatus?.includes("失败") ? "alert" : undefined}>
  {filterStatus ?? notice}
</p>
```

将信息流 section 开始标签改为：

```tsx
<section
  className={`feed ${filterLoading ? "feed-filter-loading" : ""}`}
  aria-live="polite"
  aria-busy={loading || refreshing || filterLoading}
>
```

在 `changePage` 的首个条件以及三个分页按钮的 `disabled` 条件中都加入 `filterLoading`。`changePage` 的开头应为：

```ts
if (
  filterLoading
  || pageLoading
  || targetPage < 1
  || targetPage > feed.pagination.totalPages
  || targetPage === page
) {
  return;
}
```

上一页、数字页和下一页分别使用：

```tsx
disabled={filterLoading || pageLoading || page <= 1}
```

```tsx
disabled={filterLoading || pageLoading}
```

```tsx
disabled={
  filterLoading
  || pageLoading
  || page >= feed.pagination.totalPages
}
```

- [ ] **Step 2: 加入轻微淡化样式**

在 `app/globals.css` 的 `.feed` 规则附近加入：

```css
.feed {
  min-height: 460px;
  opacity: 1;
  transition: opacity .14s ease;
}
.feed-filter-loading { opacity: .55; }

@media (prefers-reduced-motion: reduce) {
  .feed { transition: none; }
}
```

不要禁用 `.feed` 内链接；请求期间旧内容仍可阅读和打开，只禁用分页，来源按钮保持可连续点击。

- [ ] **Step 3: 运行完整自动化验证**

Run: `npm.cmd test`

Expected: PASS，现有测试与新增测试全部通过。

Run: `npx.cmd tsc --noEmit`

Expected: PASS，无 TypeScript 错误。

Run: `npm.cmd run lint`

Expected: PASS，无 ESLint 错误。

Run: `npm.cmd run build`

Expected: PASS，Vinext 生产构建完成。

- [ ] **Step 4: 启动新实例并进行本地浏览器验收**

Run: `npm.cmd run dev`

Expected: 本地服务启动并输出可访问地址。使用该次新启动的地址完成以下检查：

1. 依次点击 36Kr、界面监管、界面时事、财联社；按钮立即选中，标题立即显示“正在切换至××”，旧列表轻微淡化，新列表在接口返回后替换。
2. 在四个平台之间快速连续点击至少两轮；控制台无未处理 Promise，最终文章均属于最后选中的平台，不能出现旧平台结果覆盖。
3. 输入搜索词时仅在停止输入约 250ms 后请求；输入后立即点击平台时，待执行的搜索定时器被取消，不应出现第二次重复回读。
4. 应用和清除时间范围均立即请求，并显示“正在更新筛选结果…”，不误显示平台切换文案。
5. 筛选请求期间分页按钮禁用；完成后分页可用且仍滚动到信息流标题。
6. 临时让 `/api/feed` 返回普通错误时，旧列表恢复正常透明度并显示“以下仍为上一次结果”；让请求被下一次切换中止时不显示失败。
7. 记录一次平台单击至首条文章切换的时间，目标接近接口实际耗时，不再额外包含固定 250ms。

- [ ] **Step 5: 提交显示与交互改动**

```powershell
git add -- app/dashboard.tsx app/globals.css
git commit -m "feat: show responsive feed switching state"
```

### Task 4: 最终差异与回归检查

**Files:**
- Verify: `app/dashboard.tsx`
- Verify: `app/globals.css`
- Verify: `lib/feed-request-policy.ts`
- Verify: `tests/feed-request-policy.test.ts`

- [ ] **Step 1: 检查改动范围**

Run: `git diff --stat HEAD~3..HEAD`

Expected: 仅包含本计划、请求策略、Dashboard、样式和对应测试；没有 API、数据库、采集器、排序、分页条数或日期分组改动。

- [ ] **Step 2: 检查工作区与提交历史**

Run: `git status --short`

Expected: 无输出。

Run: `git log -4 --oneline`

Expected: 能看到设计提交以及本计划产生的策略、请求逻辑、显示交互提交。

- [ ] **Step 3: 复核验收边界**

确认以下各项均成立后才宣告完成：

- 平台和时间筛选延迟为 0ms，搜索延迟仍为 250ms。
- 新请求中止旧请求，旧响应不能覆盖新结果。
- 中止不显示错误；普通失败保留旧列表并明确标注。
- 筛选时旧列表淡化、来源按钮可点、分页禁用。
- 每页 50 条、日期分组、自动刷新周期和后端接口均未改变。
- 聚焦测试、全量测试、类型检查、代码检查、生产构建和本地浏览器验收全部通过。
