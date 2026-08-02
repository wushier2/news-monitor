"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FeedResponse,
  PaginationMeta,
  RefreshResponse,
  SourceHealth,
  SourceId,
} from "../lib/domain";
import {
  buildFeedSearchParams,
  getPageTokens,
} from "../lib/pagination";
import { REFRESH_INTERVAL_MS, shouldAutoRefresh } from "../lib/refresh-policy";
import { SOURCES } from "../lib/sources";
import {
  type AppliedTimeRange,
  formatTimeRangeLabel,
  getBeijingInputBounds,
  validateBeijingLocalRange,
} from "../lib/time-range";
import type {
  BackfillRun,
  StartBackfillResponse,
} from "../lib/backfill/types";
import {
  backfillStatusLabel,
  backfillSummary,
  backfillToggleLabel,
  shouldAutoExpandBackfill,
} from "../lib/backfill/presentation";

const PAGE_SIZE = 50;
const EMPTY_PAGINATION: PaginationMeta = {
  page: 1,
  pageSize: PAGE_SIZE,
  totalItems: 0,
  totalPages: 0,
};

const EMPTY_FEED: FeedResponse = {
  items: [],
  sources: SOURCES.map((source) => ({
    sourceId: source.id,
    lastAttemptAt: null,
    lastSuccessAt: null,
    status: "idle",
    error: null,
    itemCount: 0,
  })),
  generatedAt: new Date(0).toISOString(),
  todayCount: 0,
  pagination: EMPTY_PAGINATION,
};

function formatTime(value: string | null): string {
  if (!value) return "尚未采集";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function newestSuccess(sources: SourceHealth[]): number {
  return Math.max(0, ...sources.map((source) => source.lastSuccessAt ? Date.parse(source.lastSuccessAt) : 0));
}

async function requestFeed(
  nextQuery = "",
  nextSource: SourceId | "all" = "all",
  range: AppliedTimeRange | null = null,
  page = 1,
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
  });
  const payload = await response.json() as FeedResponse & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "无法读取信息流");
  return payload;
}

export default function Dashboard() {
  const [feed, setFeed] = useState<FeedResponse>(EMPTY_FEED);
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState<SourceId | "all">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState("正在连接四个公开来源…");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [timeEditorOpen, setTimeEditorOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [appliedRange, setAppliedRange] =
    useState<AppliedTimeRange | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [backfillRun, setBackfillRun] = useState<BackfillRun | null>(null);
  const [backfillStarting, setBackfillStarting] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillExpanded, setBackfillExpanded] = useState(false);
  const [backfillConfirmOpen, setBackfillConfirmOpen] = useState(false);
  const pickerBounds = useMemo(() => getBeijingInputBounds(), []);
  const refreshingRef = useRef(false);
  const filtersRef = useRef({ query, sourceId, appliedRange });
  const requestSequenceRef = useRef(0);
  const filterEffectReadyRef = useRef(false);
  const mountedRef = useRef(true);
  const feedHeadingRef = useRef<HTMLElement | null>(null);
  const observedRunningBackfillsRef = useRef(new Set<number>());
  const runningBackfillId = backfillRun?.status === "running"
    ? backfillRun.id
    : null;

  useEffect(() => {
    filtersRef.current = { query, sourceId, appliedRange };
  }, [query, sourceId, appliedRange]);

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

  const loadFeed = useCallback(async (
    nextQuery: string,
    nextSource: SourceId | "all",
    nextRange: AppliedTimeRange | null,
    targetPage: number,
    reason: "initial" | "filter" | "page" | "refresh",
  ): Promise<FeedResponse | null> => {
    const requestId = ++requestSequenceRef.current;
    setPageError(null);
    setPageLoading(reason === "page");
    try {
      const payload = await requestFeed(
        nextQuery,
        nextSource,
        nextRange,
        targetPage,
      );
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current
      ) {
        return null;
      }
      setFeed(payload);
      setPage(payload.pagination.page);
      setFatalError(null);
      if (reason === "page") {
        window.requestAnimationFrame(() => {
          feedHeadingRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        });
      }
      return payload;
    } catch (error) {
      if (
        !mountedRef.current ||
        requestId !== requestSequenceRef.current
      ) {
        return null;
      }
      const message = error instanceof Error ? error.message : "读取失败";
      if (reason === "page") {
        setPageError("分页加载失败");
      } else {
        setFatalError(message);
      }
      return null;
    } finally {
      if (
        mountedRef.current &&
        requestId === requestSequenceRef.current
      ) {
        setPageLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async (manual = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setNotice(manual ? "正在立即刷新…" : "正在同步最新信息…");
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      const payload = await response.json() as RefreshResponse & { error?: string };
      if (!response.ok && response.status !== 207) throw new Error(payload.error ?? "刷新失败");
      const currentFilters = filtersRef.current;
      const nextFeed = await loadFeed(
        currentFilters.query,
        currentFilters.sourceId,
        currentFilters.appliedRange,
        1,
        "refresh",
      );
      if (!nextFeed) {
        setNotice("刷新后读取第 1 页失败");
        return;
      }
      if (payload.status === "busy") {
        setNotice("补采进行中，本轮普通采集已跳过");
      } else if (payload.status === "skipped") {
        setNotice(`数据仍是最新状态，${payload.retryAfterSeconds ?? 1} 秒后可再次刷新`);
      } else if (payload.status === "partial") {
        setNotice("刷新完成，部分来源暂时失败");
      } else {
        setNotice("刷新成功");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新失败";
      setNotice(message);
      setFatalError(message);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, [loadFeed]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    const initialTimer = window.setTimeout(() => {
      void loadFeed("", "all", null, 1, "initial").then((payload) => {
        if (!active || !payload) return;
        const lastSuccess = newestSuccess(payload.sources);
        if (shouldAutoRefresh(lastSuccess ? new Date(lastSuccess).toISOString() : null)) {
          void refresh(false);
        } else {
          setNotice("信息流已是最新状态");
          setLoading(false);
        }
      });
    }, 0);
    const timer = window.setInterval(() => void refresh(false), REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      mountedRef.current = false;
      requestSequenceRef.current += 1;
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadFeed, refresh]);

  useEffect(() => {
    if (!filterEffectReadyRef.current) {
      filterEffectReadyRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadFeed(
        query,
        sourceId,
        appliedRange,
        1,
        "filter",
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, sourceId, appliedRange, loadFeed]);

  useEffect(() => {
    let active = true;
    void fetch("/api/backfill", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as {
          run: BackfillRun | null;
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "无法读取补采任务");
        if (!active) return;
        if (payload.run?.status === "running") {
          observedRunningBackfillsRef.current.add(payload.run.id);
        }
        if (shouldAutoExpandBackfill(payload.run?.status ?? null, false)) {
          setBackfillExpanded(true);
        }
        setBackfillRun(payload.run);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBackfillExpanded(true);
        setBackfillError(
          error instanceof Error ? error.message : "无法读取补采任务",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (runningBackfillId === null) return;
    observedRunningBackfillsRef.current.add(runningBackfillId);
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/backfill/${runningBackfillId}`, {
          cache: "no-store",
        });
        const payload = await response.json() as {
          run?: BackfillRun;
          error?: string;
        };
        if (!response.ok || !payload.run) {
          throw new Error(payload.error ?? "无法读取补采进度");
        }
        if (!active) return;
        setBackfillRun(payload.run);
        setBackfillError(null);
      } catch (error) {
        if (!active) return;
        setBackfillExpanded(true);
        setBackfillError(
          error instanceof Error ? error.message : "无法读取补采进度",
        );
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [runningBackfillId]);

  useEffect(() => {
    if (!backfillRun || backfillRun.status === "running") return;
    if (!observedRunningBackfillsRef.current.delete(backfillRun.id)) return;
    const currentFilters = filtersRef.current;
    void loadFeed(
      currentFilters.query,
      currentFilters.sourceId,
      currentFilters.appliedRange,
      1,
      "refresh",
    );
  }, [backfillRun, loadFeed]);

  const unhealthy = feed.sources.filter((source) => source.status === "error");
  const healthyCount = feed.sources.filter((source) => source.status === "ok").length;
  const latestTime = useMemo(() => {
    const value = newestSuccess(feed.sources);
    return value ? new Date(value).toISOString() : null;
  }, [feed.sources]);
  const pageTokens = useMemo(
    () => getPageTokens(page, feed.pagination.totalPages),
    [page, feed.pagination.totalPages],
  );

  function changePage(targetPage: number) {
    if (
      pageLoading ||
      targetPage < 1 ||
      targetPage > feed.pagination.totalPages ||
      targetPage === page
    ) {
      return;
    }
    void loadFeed(
      query,
      sourceId,
      appliedRange,
      targetPage,
      "page",
    );
  }

  async function startBackfill() {
    setBackfillConfirmOpen(false);
    setBackfillStarting(true);
    setBackfillError(null);
    try {
      const response = await fetch("/api/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json() as StartBackfillResponse & {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "无法启动补采");
      if (payload.run.status === "running") {
        observedRunningBackfillsRef.current.add(payload.run.id);
      }
      if (shouldAutoExpandBackfill(payload.run.status, false)) {
        setBackfillExpanded(true);
      }
      setBackfillRun(payload.run);
      setNotice(payload.reused ? "已恢复正在进行的补采任务" : "补采任务已启动");
    } catch (error) {
      setBackfillExpanded(true);
      setBackfillError(error instanceof Error ? error.message : "无法启动补采");
    } finally {
      setBackfillStarting(false);
    }
  }

  return (
    <main className="dashboard-shell">
      <header className="masthead">
        <div className="brand-block">
          <span className="eyebrow">PUBLIC SIGNAL DESK</span>
          <h1>G端资讯监控</h1>
        </div>
        <div className="health-line" aria-label="采集状态">
          <span className={`pulse ${unhealthy.length ? "pulse-warn" : ""}`} />
          <span>{healthyCount}/4 来源正常</span>
          <span className="header-divider" />
          <span><strong>{feed.todayCount}</strong> 今日新增</span>
          <span className="header-divider" />
          <span>更新于 <strong>{formatTime(latestTime)}</strong></span>
        </div>
      </header>

      <section className="toolbar" aria-label="信息流筛选">
        <label className="search-wrap">
          <span className="sr-only">搜索标题或摘要</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题或正文摘要…"
            maxLength={100}
          />
        </label>
        <div className="source-filters" aria-label="来源">
          <button className={sourceId === "all" ? "filter-active" : ""} onClick={() => setSourceId("all")}>全部</button>
          {SOURCES.map((source) => (
            <button
              key={source.id}
              className={sourceId === source.id ? "filter-active" : ""}
              onClick={() => setSourceId(source.id)}
            >
              {source.sourceName === "界面新闻" ? `界面${source.channelName.slice(0, 2)}` : source.sourceName}
            </button>
          ))}
        </div>
        <button
          className={`time-filter-button ${appliedRange ? "filter-active" : ""}`}
          aria-expanded={timeEditorOpen}
          aria-controls="time-range-editor"
          onClick={() => setTimeEditorOpen((open) => !open)}
        >
          {appliedRange ? formatTimeRangeLabel(appliedRange) : "时间范围"}
        </button>
        <div className="toolbar-actions">
          <button
            className="backfill-button"
            disabled={backfillStarting || backfillRun?.status === "running"}
            onClick={() => setBackfillConfirmOpen(true)}
          >
            {backfillStarting
              ? "启动中…"
              : backfillRun?.status === "running"
                ? "补采进行中…"
                : "补采过去24小时"}
          </button>
          <button className="refresh-button" disabled={refreshing} onClick={() => void refresh(true)}>
            {refreshing ? "刷新中…" : "立即刷新"}
          </button>
        </div>
      </section>

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

      {backfillConfirmOpen && (
        <section className="backfill-confirm" aria-labelledby="backfill-confirm-title">
          <div>
            <strong id="backfill-confirm-title">确认补采过去 24 小时的信息？</strong>
            <p>将依次翻页采集四个来源，并在后台持续更新进度。单个来源失败不会中断其他来源。</p>
          </div>
          <div className="backfill-confirm-actions">
            <button className="backfill-confirm-button" onClick={() => void startBackfill()}>
              确认补采
            </button>
            <button className="backfill-cancel-button" onClick={() => setBackfillConfirmOpen(false)}>
              取消
            </button>
          </div>
        </section>
      )}

      {unhealthy.length > 0 && (
        <aside className="source-alert" role="status">
          <strong>{unhealthy.map((source) => SOURCES.find((item) => item.id === source.sourceId)?.channelName).join("、")}</strong>
          <span>暂时采集失败，现有记录仍可浏览；下一轮会自动重试。</span>
        </aside>
      )}

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

      <section ref={feedHeadingRef} className="feed-heading">
        <div>
          <span className="section-kicker">LATEST INTELLIGENCE</span>
          <h2>{sourceId === "all" ? "最新信息流" : SOURCES.find((source) => source.id === sourceId)?.channelName}</h2>
        </div>
        <p>{notice}</p>
      </section>

      <section className="feed" aria-live="polite" aria-busy={loading || refreshing}>
        {feed.items.length > 0 ? feed.items.map((item) => (
          <article className="feed-item" key={`${item.sourceId}-${item.id}`}>
            <div className="item-source">
              <span>{item.sourceName}</span>
              <small>{item.channelName}</small>
            </div>
            <a href={item.url} target="_blank" rel="noreferrer" className="item-content">
              <h3>{item.title}</h3>
              {item.summary && <p>{item.summary}</p>}
            </a>
            <time dateTime={item.publishedAt ?? item.firstSeenAt}>
              {formatTime(item.publishedAt ?? item.firstSeenAt)}
            </time>
          </article>
        )) : (
          <div className="empty-state">
            <span>{loading ? "同步中" : fatalError ? "采集暂时不可用" : "暂无记录"}</span>
            <h3>{loading ? "正在建立第一轮信息流" : fatalError ?? "当前筛选条件下没有内容"}</h3>
            <p>网站打开期间每 5 分钟自动采集，也可使用右上角立即刷新。</p>
          </div>
        )}
      </section>

      <nav className="pagination" aria-label="信息流分页">
        <span className="pagination-total">
          共 {feed.pagination.totalItems} 条
        </span>
        {feed.pagination.totalPages > 1 && (
          <div className="pagination-controls">
            <button
              disabled={pageLoading || page <= 1}
              onClick={() => changePage(page - 1)}
            >
              上一页
            </button>
            {pageTokens.map((token) => typeof token === "number" ? (
              <button
                key={token}
                className={token === page ? "page-active" : ""}
                aria-current={token === page ? "page" : undefined}
                disabled={pageLoading}
                onClick={() => changePage(token)}
              >
                {token}
              </button>
            ) : (
              <span className="pagination-ellipsis" key={token}>…</span>
            ))}
            <button
              disabled={
                pageLoading ||
                page >= feed.pagination.totalPages
              }
              onClick={() => changePage(page + 1)}
            >
              下一页
            </button>
          </div>
        )}
        {pageError && (
          <span className="pagination-error" role="alert">{pageError}</span>
        )}
      </nav>

      <footer>
        <span>保留最近 7 天</span>
        <span>页面打开期间每 5 分钟采集</span>
        <span>点击标题核验原始报道</span>
      </footer>
    </main>
  );
}
