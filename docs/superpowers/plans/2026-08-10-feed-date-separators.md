# 信息流日期分隔线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在综合与单平台信息流中，按北京时间为当前页资讯显示横向日期分隔线。

**Architecture:** 将相邻资讯按北京时间日期划分为前端渲染组，日期变化时才产生一条带文本标签的分隔线。分组完全发生在浏览器已加载的当前页数据上，不改动接口、数据库或排序；`publishedAt` 缺失时继续使用 `firstSeenAt`。

**Tech Stack:** React 19、TypeScript、Next/Vinext、Vitest、CSS。

---

## 文件结构

- 新建 `lib/feed-date-groups.ts`：以北京时间计算日期键与显示标签，并将相邻 `FeedItem` 划分为可渲染日期组。
- 新建 `tests/feed-date-groups.test.ts`：固定时区和日期边界的单元测试。
- 修改 `app/dashboard.tsx`：使用日期组渲染分隔线和原有资讯条目。
- 修改 `app/globals.css`：添加桌面与移动端的横向日期分隔线样式。

### Task 1: 北京时间分组辅助函数

**Files:**
- Create: `tests/feed-date-groups.test.ts`
- Create: `lib/feed-date-groups.ts`

- [ ] **Step 1: 写入失败测试**

创建 `tests/feed-date-groups.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../lib/domain";
import { partitionFeedItemsByBeijingDate } from "../lib/feed-date-groups";

function item(id: number, publishedAt: string | null, firstSeenAt = "2026-08-10T00:00:00.000Z"): FeedItem {
  return {
    id, publishedAt, firstSeenAt, lastSeenAt: firstSeenAt,
    sourceId: "36kr-macro", sourceName: "36Kr", channelName: "宏观",
    title: `资讯 ${id}`, summary: "", url: `https://example.test/${id}`,
  };
}

describe("feed date groups", () => {
  it("keeps adjacent items on one Beijing day under one divider", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "2026-08-10T15:59:00.000Z"),
      item(2, "2026-08-10T00:01:00.000Z"),
    ])).toEqual([{
      id: "2026-08-10-0", dateKey: "2026-08-10", label: "08月10日 · 周一", items: [
        item(1, "2026-08-10T15:59:00.000Z"),
        item(2, "2026-08-10T00:01:00.000Z"),
      ],
    }]);
  });

  it("starts a new divider when adjacent items cross a Beijing date", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "2026-08-10T15:59:00.000Z"),
      item(2, "2026-08-10T16:00:00.000Z"),
    ]).map(({ dateKey, label, items }) => ({ dateKey, label, ids: items.map(({ id }) => id) })))
      .toEqual([
        { dateKey: "2026-08-10", label: "08月10日 · 周一", ids: [1] },
        { dateKey: "2026-08-11", label: "08月11日 · 周二", ids: [2] },
      ]);
  });

  it("uses first seen time when published time is missing", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, null, "2026-08-09T16:30:00.000Z"),
    ])[0]).toMatchObject({ dateKey: "2026-08-10", label: "08月10日 · 周一" });
  });

  it("leaves an invalid timestamp without a date divider", () => {
    expect(partitionFeedItemsByBeijingDate([
      item(1, "not-a-date", "also-not-a-date"),
    ])[0]).toMatchObject({ dateKey: null, label: null, items: [item(1, "not-a-date", "also-not-a-date")] });
  });
});
```

- [ ] **Step 2: 确认测试按预期失败**

运行：`npm.cmd test -- tests/feed-date-groups.test.ts`

预期：失败，提示无法找到 `../lib/feed-date-groups`；不得因测试拼写或工具配置失败。

- [ ] **Step 3: 实现最小分组模块**

创建 `lib/feed-date-groups.ts`：

```ts
import type { FeedItem } from "./domain";

export interface FeedDateGroup {
  id: string;
  dateKey: string | null;
  label: string | null;
  items: FeedItem[];
}

const beijingDateParts = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  day: "2-digit", weekday: "short",
});

function getDateDetails(value: string): { key: string; label: string } | null {
  if (!Number.isFinite(Date.parse(value))) return null;
  const parts = new Map(beijingDateParts.formatToParts(new Date(value))
    .filter(({ type }) => type !== "literal")
    .map(({ type, value: part }) => [type, part]));
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const weekday = parts.get("weekday");
  if (!year || !month || !day || !weekday) return null;
  return {
    key: `${year}-${month}-${day}`,
    label: `${month}月${day}日 · ${weekday}`,
  };
}

export function partitionFeedItemsByBeijingDate(items: FeedItem[]): FeedDateGroup[] {
  return items.reduce<FeedDateGroup[]>((groups, item) => {
    const details = getDateDetails(item.publishedAt ?? item.firstSeenAt);
    const previous = groups[groups.length - 1];
    if (details && previous?.dateKey === details.key) {
      previous.items.push(item);
      return groups;
    }
    groups.push({
      id: `${details?.key ?? "undated"}-${groups.length}`,
      dateKey: details?.key ?? null,
      label: details?.label ?? null,
      items: [item],
    });
    return groups;
  }, []);
}
```

- [ ] **Step 4: 确认测试通过**

运行：`npm.cmd test -- tests/feed-date-groups.test.ts`

预期：4 个测试全部通过。

- [ ] **Step 5: 提交分组行为**

```bash
git add tests/feed-date-groups.test.ts lib/feed-date-groups.ts
git commit -m "feat: group feed items by Beijing date"
```

### Task 2: 在信息流中渲染横向日期分隔线

**Files:**
- Modify: `app/dashboard.tsx`
- Modify: `app/globals.css`
- Test: `tests/feed-date-groups.test.ts`

- [ ] **Step 1: 使用已通过的分组辅助函数替换平铺渲染**

在 `app/dashboard.tsx` 的 import 区加入：

```ts
import { partitionFeedItemsByBeijingDate } from "../lib/feed-date-groups";
```

在 `Dashboard` 组件内、返回 JSX 前加入：

```ts
const feedDateGroups = useMemo(
  () => partitionFeedItemsByBeijingDate(feed.items),
  [feed.items],
);
```

将现有 `feed.items.map` 替换为按组渲染。日期有效时先输出分隔线，然后保持原 `article.feed-item` 内容、链接属性与时间文本不变：

```tsx
{feedDateGroups.map((group) => (
  <div className="feed-date-group" key={group.id}>
    {group.label && (
      <div className="feed-date-divider" role="separator" aria-label={group.label}>
        <span>{group.label}</span>
      </div>
    )}
    {group.items.map((item) => (
      <article className="feed-item" key={`${item.sourceId}-${item.id}`}>
        {/* 保留现有来源、内容链接和 time 三列 JSX */}
      </article>
    ))}
  </div>
))}
```

无效时间会得到 `label: null`，因此正常显示资讯而不渲染空分隔线。

- [ ] **Step 2: 添加与既有视觉系统一致的样式**

在 `app/globals.css` 的 `.feed` 附近加入：

```css
.feed-date-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 26px 3px;
  color: var(--forest);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .04em;
}
.feed-date-divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: #cfd8d1;
}
```

在现有 `@media (max-width: 820px)` 内加入：

```css
.feed-date-divider { padding: 13px 16px 2px; }
```

- [ ] **Step 3: 运行聚焦测试与静态验证**

运行：

```bash
npm.cmd test -- tests/feed-date-groups.test.ts
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build
```

预期：日期分组测试全绿，类型检查、检查和构建均以退出码 0 完成。

- [ ] **Step 4: 本地验收综合、单平台与分页视图**

运行 `npm.cmd run dev`，在 `http://localhost:3000/` 完成：

1. 综合信息流中，同一北京日期仅有一条分隔线，跨日出现下一条分隔线。
2. 选择任一单平台后，分隔线仍正确显示。
3. 切换至第 2 页后，页面只按第 2 页的资讯分组，分页按钮与时间筛选仍可使用。
4. 缩窄至 820px 以下时，分隔线与资讯内容左边缘对齐，页面无水平滚动。

- [ ] **Step 5: 提交界面功能**

```bash
git add app/dashboard.tsx app/globals.css lib/feed-date-groups.ts tests/feed-date-groups.test.ts
git commit -m "feat: add feed date dividers"
```
