"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeedResponse, RefreshResponse, SourceHealth, SourceId } from "../lib/domain";
import { REFRESH_INTERVAL_MS, shouldAutoRefresh } from "../lib/refresh-policy";
import { SOURCES } from "../lib/sources";
import {
  type AppliedTimeRange,
  formatTimeRangeLabel,
  getBeijingInputBounds,
  toBeijingIsoMinute,
  validateBeijingLocalRange,
} from "../lib/time-range";

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
): Promise<FeedResponse> {
  const params = new URLSearchParams();
  if (nextQuery.trim()) params.set("q", nextQuery.trim());
  if (nextSource !== "all") params.set("source", nextSource);
  if (range) {
    params.set("from", toBeijingIsoMinute(range.from));
    params.set("to", toBeijingIsoMinute(range.to));
  }
  const response = await fetch(`/api/feed?${params.toString()}`, { cache: "no-store" });
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
  const pickerBounds = useMemo(() => getBeijingInputBounds(), []);
  const refreshingRef = useRef(false);
  const filtersRef = useRef({ query, sourceId, appliedRange });

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

  const refresh = useCallback(async (manual = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setNotice(manual ? "正在立即刷新…" : "正在同步最新信息…");
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      const payload = await response.json() as RefreshResponse & { error?: string };
      if (!response.ok && response.status !== 207) throw new Error(payload.error ?? "刷新失败");
      if (payload.status === "skipped") {
        setNotice(`数据仍是最新状态，${payload.retryAfterSeconds ?? 1} 秒后可再次刷新`);
      } else if (payload.status === "partial") {
        setNotice("刷新完成，部分来源暂时失败");
      } else {
        setNotice("刷新成功");
      }
      const currentFilters = filtersRef.current;
      const nextFeed = await requestFeed(
        currentFilters.query,
        currentFilters.sourceId,
        currentFilters.appliedRange,
      );
      setFeed(nextFeed);
      setFatalError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "刷新失败";
      setNotice(message);
      setFatalError(message);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    requestFeed().then((payload) => {
      if (!active) return;
      setFeed(payload);
      setFatalError(null);
      const lastSuccess = newestSuccess(payload.sources);
      if (shouldAutoRefresh(lastSuccess ? new Date(lastSuccess).toISOString() : null)) {
        void refresh(false);
      } else {
        setNotice("信息流已是最新状态");
        setLoading(false);
      }
    }).catch((error) => {
      if (!active) return;
      setFatalError(error instanceof Error ? error.message : "无法读取信息流");
      void refresh(false);
    });
    const timer = window.setInterval(() => void refresh(false), REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void requestFeed(query, sourceId, appliedRange)
        .then((payload) => {
          setFeed(payload);
          setFatalError(null);
        })
        .catch((error) => {
          setFatalError(error instanceof Error ? error.message : "筛选失败");
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, sourceId, appliedRange]);

  const unhealthy = feed.sources.filter((source) => source.status === "error");
  const healthyCount = feed.sources.filter((source) => source.status === "ok").length;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = feed.items.filter((item) =>
    Date.parse(item.publishedAt ?? item.firstSeenAt) >= todayStart.getTime()).length;
  const latestTime = useMemo(() => {
    const value = newestSuccess(feed.sources);
    return value ? new Date(value).toISOString() : null;
  }, [feed.sources]);

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
          <span><strong>{todayCount}</strong> 今日新增</span>
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
        <button className="refresh-button" disabled={refreshing} onClick={() => void refresh(true)}>
          {refreshing ? "刷新中…" : "立即刷新"}
        </button>
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

      {unhealthy.length > 0 && (
        <aside className="source-alert" role="status">
          <strong>{unhealthy.map((source) => SOURCES.find((item) => item.id === source.sourceId)?.channelName).join("、")}</strong>
          <span>暂时采集失败，现有记录仍可浏览；下一轮会自动重试。</span>
        </aside>
      )}

      <section className="feed-heading">
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

      <footer>
        <span>保留最近 7 天</span>
        <span>页面打开期间每 5 分钟采集</span>
        <span>点击标题核验原始报道</span>
      </footer>
    </main>
  );
}
