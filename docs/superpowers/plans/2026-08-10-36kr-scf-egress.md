# 36Kr Tencent SCF Egress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both routine and 24-hour 36Kr macro collection through an authenticated Tencent SCF function while retaining Cloudflare scheduling, D1 persistence, and backfill state.

**Architecture:** A dependency-free Node.js SCF event function fetches and signs 36Kr pages from Tencent's Guangzhou egress and exposes one authenticated `fetchPage` operation. Cloudflare calls that function synchronously through a small validated client; routine ingestion consumes the first page, while the existing backfill service advances the returned opaque cursor.

**Tech Stack:** Node.js ES modules, Tencent SCF event functions and Function URL, TypeScript, vinext/Next App Router, Cloudflare Workers and D1, Vitest, `node:crypto`.

---

## File map

- Create `scf/kr36/index.mjs`: deployable SCF handler, 36Kr request/signing logic, strict input validation, normalization, safe diagnostics.
- Create `scf/kr36/index.d.mts`: TypeScript declarations for the test-imported SCF module.
- Create `tests/scf-kr36.test.ts`: unit tests for SCF authentication, first/next page behavior, and safe failures.
- Create `lib/kr36-scf-client.ts`: Cloudflare-to-SCF authenticated client and response validation.
- Create `tests/kr36-scf-client.test.ts`: request contract, retry, timeout, and malformed-response tests.
- Modify `lib/fetch-source.ts`: use the SCF client for routine 36Kr ingestion only.
- Modify `lib/backfill/adapters/kr36.ts`: replace Cloudflare direct fetching with a thin SCF-backed adapter.
- Modify `lib/backfill/adapters/index.ts`: remove nonce recovery/cooldown wiring that is no longer used in production.
- Modify `lib/backfill/runner.ts`: stop passing D1 recovery state into the 36Kr adapter.
- Modify `tests/backfill-kr36.test.ts`: replace direct-36Kr transport tests with adapter delegation tests.
- Modify `tests/backfill-runner.test.ts`: remove the obsolete cached-nonce production-path assertion and assert SCF delegation instead.
- Modify `worker/index.ts`: type the two secret bindings used by application code.
- Create `docs/36kr-scf-setup.md`: exact Tencent Function URL and Cloudflare secret configuration and verification steps.

## Task 1: Build the deployable SCF function

**Files:**
- Create: `scf/kr36/index.mjs`
- Create: `scf/kr36/index.d.mts`
- Create: `tests/scf-kr36.test.ts`
- Read fixtures: `tests/fixtures/36kr-backfill-first.html`, `tests/fixtures/36kr-backfill-next.json`

- [ ] **Step 1: Write failing SCF contract tests**

Create `tests/scf-kr36.test.ts` with tests that invoke the wished-for handler and injected upstream fetcher:

```ts
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHandler,
  fetch36KrPage,
} from "../scf/kr36/index.mjs";

const firstHtml = readFileSync(new URL(
  "./fixtures/36kr-backfill-first.html",
  import.meta.url,
), "utf8");
const nextJson = readFileSync(new URL(
  "./fixtures/36kr-backfill-next.json",
  import.meta.url,
), "utf8");
const gatewayJson = JSON.stringify({ code: 0, ...JSON.parse(nextJson) });

function event(body: unknown, token = "test-token") {
  return {
    httpMethod: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

describe("36Kr SCF function", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects an invalid bearer token before fetching upstream", async () => {
    const fetcher = vi.fn();
    const handler = createHandler({ token: "test-token", fetcher });
    const response = await handler(event({ operation: "fetchPage", cursor: null }, "wrong"));
    expect(response.statusCode).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads and normalizes the first macro page", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(firstHtml))
      .mockResolvedValueOnce(new Response(gatewayJson, {
        headers: { "content-type": "application/json" },
      }));
    const page = await fetch36KrPage(null, {
      fetcher,
      now: () => 1_785_500_000_000,
    });
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      sourceId: "36kr-macro",
      sourceName: "36Kr",
      channelName: "宏观",
    });
    expect(JSON.parse(page.nextCursor)).toEqual({
      nonce: "fixture-nonce",
      pageCallback: "next-token",
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://www.36kr.com/newsflashes/catalog/4",
    );
  });

  it("advances an opaque cursor without fetching HTML again", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(gatewayJson));
    await fetch36KrPage(JSON.stringify({
      nonce: "fixture-nonce",
      pageCallback: "fixture-callback",
    }), { fetcher, now: () => 1_785_500_000_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      nonce: "fixture-nonce",
      param: { pageEvent: 1, pageCallback: "fixture-callback", type: 4 },
    });
  });

  it("returns safe diagnostics for a risk page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      "<html><body>captcha</body></html>",
      { headers: { "content-type": "text/html" } },
    ));
    await expect(fetch36KrPage(null, { fetcher }))
      .rejects.toThrow("KR36_RISK_PAGE(status=200,type=text/html,bytes=33)");
  });

  it("rejects extra request fields", async () => {
    const handler = createHandler({ token: "test-token", fetcher: vi.fn() });
    const response = await handler(event({
      operation: "fetchPage",
      cursor: null,
      extra: true,
    }));
    expect(response.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the SCF tests and verify RED**

Run:

```powershell
npm.cmd test -- tests/scf-kr36.test.ts
```

Expected: FAIL because `scf/kr36/index.mjs` does not exist.

- [ ] **Step 3: Implement the minimal dependency-free SCF function**

Create `scf/kr36/index.mjs`. The implementation must export `fetch36KrPage`, `createHandler`, and the SCF entry point `main_handler`:

```js
import { createHash, timingSafeEqual } from "node:crypto";

const FIRST_PAGE_URL = "https://www.36kr.com/newsflashes/catalog/4";
const GATEWAY_URL = "https://gateway.36kr.com/api/mis/nav/newsflash/list";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readCursor(cursor) {
  if (cursor === null) return null;
  if (typeof cursor !== "string" || cursor.length > 2048) {
    throw new Error("KR36_INVALID_CURSOR");
  }
  let value;
  try { value = JSON.parse(cursor); } catch { throw new Error("KR36_INVALID_CURSOR"); }
  if (!value || typeof value.nonce !== "string"
    || typeof value.pageCallback !== "string"
    || !value.nonce || !value.pageCallback) {
    throw new Error("KR36_INVALID_CURSOR");
  }
  return { nonce: value.nonce, pageCallback: value.pageCallback };
}

function nonceFromHtml(html) {
  return html.match(/window\.__GATEWAY_SIGN__\s*=\s*["']([^"']+)["']/)?.[1] ?? "";
}

function riskPage(html) {
  return /captcha|访问过于频繁|安全验证|人机验证|cf-chl-|verifycenter/i.test(html);
}

function normalize(candidate) {
  const material = candidate?.templateMaterial;
  const published = Number(material?.publishTime);
  const itemId = candidate?.itemId;
  if (!itemId || typeof material?.widgetTitle !== "string") return null;
  return {
    sourceId: "36kr-macro",
    sourceName: "36Kr",
    channelName: "宏观",
    title: material.widgetTitle.trim(),
    summary: typeof material.widgetContent === "string"
      ? material.widgetContent.trim()
      : "",
    url: `https://36kr.com/newsflashes/${itemId}`,
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
  };
}

async function responseText(response) {
  const text = await response.text();
  if (!response.ok) throw new Error(`KR36_HTTP_${response.status}`);
  return text;
}

export async function fetch36KrPage(cursor, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const current = readCursor(cursor);
  let nonce = current?.nonce ?? "";
  if (!current) {
    const response = await fetcher(FIRST_PAGE_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        referer: "https://www.36kr.com/",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(10_000),
    });
    const html = await responseText(response);
    const bytes = Buffer.byteLength(html);
    const type = response.headers.get("content-type")?.split(";", 1)[0] ?? "unknown";
    if (riskPage(html)) {
      throw new Error(`KR36_RISK_PAGE(status=${response.status},type=${type},bytes=${bytes})`);
    }
    nonce = nonceFromHtml(html);
    if (!nonce) {
      throw new Error(`KR36_NO_SIGN(status=${response.status},type=${type},bytes=${bytes})`);
    }
  }

  const param = current
    ? { pageSize: 20, pageEvent: 1, pageCallback: current.pageCallback, siteId: 1, type: 4, platformId: 2 }
    : { pageSize: 20, pageEvent: 0, siteId: 1, type: 4, platformId: 2 };
  const body = { nonce, partner_id: "web", timestamp: now(), param };
  const json = JSON.stringify(body);
  const sign = createHash("md5").update(json + nonce).digest("hex");
  const gateway = await fetcher(`${GATEWAY_URL}?sign=${sign}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.36kr.com",
      referer: FIRST_PAGE_URL,
      "user-agent": USER_AGENT,
    },
    body: json,
    signal: AbortSignal.timeout(10_000),
  });
  const gatewayText = await responseText(gateway);
  let payload;
  try { payload = JSON.parse(gatewayText); } catch { throw new Error("KR36_INVALID_JSON"); }
  if (payload?.code !== 0 || !Array.isArray(payload?.data?.itemList)) {
    throw new Error("KR36_INVALID_LIST");
  }
  const items = payload.data.itemList.map(normalize).filter(Boolean);
  const pageCallback = typeof payload.data.pageCallback === "string"
    ? payload.data.pageCallback
    : "";
  const exhausted = !payload.data.hasNextPage;
  return {
    items,
    nextCursor: !exhausted && pageCallback
      ? JSON.stringify({ nonce, pageCallback })
      : null,
    exhausted,
  };
}

function json(statusCode, value) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(value),
  };
}

export function createHandler(dependencies = {}) {
  const token = dependencies.token ?? process.env.KR36_SCF_TOKEN ?? "";
  const fetcher = dependencies.fetcher ?? fetch;
  return async function handler(event = {}) {
    if (event.httpMethod !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
    const authorization = event.headers?.authorization ?? event.headers?.Authorization ?? "";
    if (!token || !safeEqual(authorization, `Bearer ${token}`)) {
      return json(401, { error: "UNAUTHORIZED" });
    }
    let input;
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : event.body ?? "";
      input = JSON.parse(body);
    } catch { return json(400, { error: "INVALID_JSON" }); }
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["operation", "cursor"].includes(key))
      || input.operation !== "fetchPage"
      || !(input.cursor === null || typeof input.cursor === "string")) {
      return json(400, { error: "INVALID_REQUEST" });
    }
    try {
      return json(200, await fetch36KrPage(input.cursor, { fetcher }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "KR36_UNKNOWN";
      const status = /timeout/i.test(message) ? 504 : /INVALID_CURSOR/.test(message) ? 400 : 502;
      return json(status, { error: message.slice(0, 200) });
    }
  };
}

export const main_handler = createHandler();
```

Create `scf/kr36/index.d.mts` so `npx.cmd tsc --noEmit` can type-check the Vitest import without shipping TypeScript to SCF:

```ts
import type { NormalizedItem } from "../../lib/domain";

export interface ScfPageResult {
  items: NormalizedItem[];
  nextCursor: string | null;
  exhausted: boolean;
}

export interface ScfResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export function fetch36KrPage(
  cursor: string | null,
  dependencies?: {
    fetcher?: typeof fetch;
    now?: () => number;
  },
): Promise<ScfPageResult>;

export function createHandler(dependencies?: {
  token?: string;
  fetcher?: typeof fetch;
}): (event?: Record<string, unknown>) => Promise<ScfResponse>;

export const main_handler: ReturnType<typeof createHandler>;
```

- [ ] **Step 4: Run SCF tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/scf-kr36.test.ts
```

Expected: all tests in `tests/scf-kr36.test.ts` PASS.

- [ ] **Step 5: Commit the SCF unit**

```powershell
git add -- scf/kr36/index.mjs scf/kr36/index.d.mts tests/scf-kr36.test.ts
git commit -m "feat: add authenticated 36Kr SCF gateway"
```

## Task 2: Add the Cloudflare-to-SCF client

**Files:**
- Create: `lib/kr36-scf-client.ts`
- Create: `tests/kr36-scf-client.test.ts`

- [ ] **Step 1: Write failing client tests**

Create `tests/kr36-scf-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { request36KrScfPage } from "../lib/kr36-scf-client";

const item = {
  sourceId: "36kr-macro",
  sourceName: "36Kr",
  channelName: "宏观",
  title: "宏观快讯",
  summary: "摘要",
  url: "https://36kr.com/newsflashes/123",
  publishedAt: "2026-08-10T00:00:00.000Z",
};
const payload = { items: [item], nextCursor: "cursor-1", exhausted: false };

describe("36Kr SCF client", () => {
  it("sends the authenticated page request and validates the result", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(payload));
    const page = await request36KrScfPage(null, {
      url: "https://example.ap-guangzhou.tencentscf.com",
      token: "secret",
      fetcher,
      sleep: vi.fn(),
    });
    expect(page).toEqual(payload);
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.ap-guangzhou.tencentscf.com",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ operation: "fetchPage", cursor: null }),
      }),
    );
  });

  it("retries one server failure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "UPSTREAM" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(payload));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep,
    })).resolves.toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("does not retry authentication failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({ error: "UNAUTHORIZED" }, { status: 401 }),
    );
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "wrong",
      fetcher,
      sleep: vi.fn(),
    })).rejects.toThrow("status=401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a source identity mismatch", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      ...payload,
      items: [{ ...item, sourceId: "cls-headline" }],
    }));
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep: vi.fn(),
    })).rejects.toThrow("36Kr SCF 返回格式无效");
  });

  it("retries one timeout without leaking response data", async () => {
    const timeout = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    const fetcher = vi.fn().mockRejectedValue(timeout);
    await expect(request36KrScfPage(null, {
      url: "https://example.test",
      token: "secret",
      fetcher,
      sleep: vi.fn().mockResolvedValue(undefined),
    })).rejects.toThrow("aborted due to timeout");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run client tests and verify RED**

```powershell
npm.cmd test -- tests/kr36-scf-client.test.ts
```

Expected: FAIL because `lib/kr36-scf-client.ts` does not exist.

- [ ] **Step 3: Implement the validated client**

Implement these exports in `lib/kr36-scf-client.ts`:

```ts
import { env } from "cloudflare:workers";
import type { NormalizedItem } from "./domain";
import type { BackfillPageResult } from "./backfill/types";

interface ClientDependencies {
  url: string;
  token: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function validItem(value: unknown): value is NormalizedItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.sourceId === "36kr-macro"
    && item.sourceName === "36Kr"
    && item.channelName === "宏观"
    && typeof item.title === "string" && item.title.length > 0
    && typeof item.summary === "string"
    && typeof item.url === "string" && item.url.startsWith("https://36kr.com/newsflashes/")
    && (item.publishedAt === null || (typeof item.publishedAt === "string"
      && Number.isFinite(Date.parse(item.publishedAt))));
}

function validatePayload(value: unknown): BackfillPageResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("36Kr SCF 返回格式无效");
  }
  const payload = value as Record<string, unknown>;
  if (!Array.isArray(payload.items) || !payload.items.every(validItem)
    || !(payload.nextCursor === null || typeof payload.nextCursor === "string")
    || typeof payload.exhausted !== "boolean") {
    throw new Error("36Kr SCF 返回格式无效");
  }
  return payload as unknown as BackfillPageResult;
}

export async function request36KrScfPage(
  cursor: string | null,
  dependencies: ClientDependencies,
): Promise<BackfillPageResult> {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(dependencies.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${dependencies.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operation: "fetchPage", cursor }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        let code = "UNKNOWN";
        try { code = String((JSON.parse(text) as { error?: unknown }).error ?? code); } catch {}
        const error = new Error(`36Kr SCF 请求失败(status=${response.status},code=${code.slice(0, 80)})`);
        if (response.status < 500 || attempt === 1) throw error;
        lastError = error;
      } else {
        return validatePayload(JSON.parse(text));
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 1 || /status=4/.test(lastError.message)) throw lastError;
    }
    await sleep(500);
  }
  throw lastError ?? new Error("36Kr SCF 请求失败");
}

export function fetch36KrScfPage(cursor: string | null): Promise<BackfillPageResult> {
  const bindings = env as typeof env & {
    KR36_SCF_URL?: string;
    KR36_SCF_TOKEN?: string;
  };
  if (!bindings.KR36_SCF_URL || !bindings.KR36_SCF_TOKEN) {
    throw new Error("36Kr SCF 配置缺失");
  }
  return request36KrScfPage(cursor, {
    url: bindings.KR36_SCF_URL,
    token: bindings.KR36_SCF_TOKEN,
  });
}
```

- [ ] **Step 4: Run client tests and verify GREEN**

```powershell
npm.cmd test -- tests/kr36-scf-client.test.ts
```

Expected: all client tests PASS.

- [ ] **Step 5: Commit the client**

```powershell
git add -- lib/kr36-scf-client.ts tests/kr36-scf-client.test.ts
git commit -m "feat: add validated 36Kr SCF client"
```

## Task 3: Route routine 36Kr ingestion through SCF

**Files:**
- Modify: `lib/fetch-source.ts`
- Create: `tests/fetch-source.test.ts`
- Modify: `tests/ingestion.test.ts`

- [ ] **Step 1: Write a failing routine-source test**

Create `tests/fetch-source.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({ fetch36KrScfPage: vi.fn() }));
vi.mock("../lib/kr36-scf-client", () => ({
  fetch36KrScfPage: fakes.fetch36KrScfPage,
}));

import { fetchSource } from "../lib/fetch-source";
import { SOURCES } from "../lib/sources";

describe("source fetching", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes routine 36Kr collection through SCF", async () => {
    const items = [{
      sourceId: "36kr-macro" as const,
      sourceName: "36Kr",
      channelName: "宏观",
      title: "宏观快讯",
      summary: "摘要",
      url: "https://36kr.com/newsflashes/123",
      publishedAt: "2026-08-10T00:00:00.000Z",
    }];
    fakes.fetch36KrScfPage.mockResolvedValue({
      items,
      nextCursor: "cursor-1",
      exhausted: false,
    });
    const directFetch = vi.spyOn(globalThis, "fetch");
    await expect(fetchSource(SOURCES[0]!)).resolves.toEqual(items);
    expect(fakes.fetch36KrScfPage).toHaveBeenCalledWith(null);
    expect(directFetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm.cmd test -- tests/fetch-source.test.ts
```

Expected: FAIL because `fetchSource` still requests the 36Kr HTML URL directly.

- [ ] **Step 3: Make the minimal routing change**

In `lib/fetch-source.ts`, import the client and move the 36Kr branch before `fetchText`:

```ts
import { fetch36KrScfPage } from "./kr36-scf-client";

export async function fetchSource(source: SourceDefinition): Promise<NormalizedItem[]> {
  if (source.id === "cls-headline") {
    return parseCls(await fetchText(await buildClsUrl()));
  }
  if (source.id === "36kr-macro") {
    return (await fetch36KrScfPage(null)).items;
  }
  const html = await fetchText(source.url);
  if (source.id === "jiemian-regulatory") {
    return parseJiemian(html, source.id, "监管通报");
  }
  return parseJiemian(html, "jiemian-current-affairs", "时事追踪");
}
```

Remove the now-unused `parse36Kr` import. Do not change the 15-minute policy or manual-force behavior.

- [ ] **Step 4: Run routine ingestion tests**

```powershell
npm.cmd test -- tests/fetch-source.test.ts tests/ingestion.test.ts tests/source-interval-policy.test.ts
```

Expected: all focused tests PASS; the existing force test still attempts all four logical sources.

- [ ] **Step 5: Commit routine integration**

```powershell
git add -- lib/fetch-source.ts tests/fetch-source.test.ts tests/ingestion.test.ts
git commit -m "feat: route routine 36Kr collection through SCF"
```

## Task 4: Route 24-hour 36Kr backfill through SCF

**Files:**
- Replace: `lib/backfill/adapters/kr36.ts`
- Modify: `lib/backfill/adapters/index.ts`
- Modify: `lib/backfill/runner.ts`
- Replace: `tests/backfill-kr36.test.ts`
- Modify: `tests/backfill-runner.test.ts`

- [ ] **Step 1: Replace old transport expectations with failing delegation tests**

The new `tests/backfill-kr36.test.ts` must assert:

```ts
import { describe, expect, it, vi } from "vitest";
import { create36KrBackfillAdapter } from "../lib/backfill/adapters/kr36";

describe("36Kr SCF backfill adapter", () => {
  it("delegates first and subsequent pages to SCF", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "cursor-1", exhausted: false })
      .mockResolvedValueOnce({ items: [], nextCursor: null, exhausted: true });
    const adapter = create36KrBackfillAdapter({ fetchPage });
    await adapter.fetchPage(null);
    await adapter.fetchPage("cursor-1");
    expect(fetchPage.mock.calls).toEqual([[null], ["cursor-1"]]);
  });

  it("does not hide SCF errors", async () => {
    const adapter = create36KrBackfillAdapter({
      fetchPage: vi.fn().mockRejectedValue(new Error("36Kr SCF 请求失败")),
    });
    await expect(adapter.fetchPage(null)).rejects.toThrow("36Kr SCF 请求失败");
  });
});
```

Update the runner test to inject a 36Kr adapter/page fetcher and prove the existing `runSourceBackfill` receives the SCF result. Remove the obsolete assertion that production first tries a cached nonce in D1.

- [ ] **Step 2: Run backfill tests and verify RED**

```powershell
npm.cmd test -- tests/backfill-kr36.test.ts tests/backfill-runner.test.ts tests/backfill-service.test.ts
```

Expected: FAIL because the adapter still directly requests 36Kr.

- [ ] **Step 3: Replace the adapter with a thin SCF boundary**

Replace `lib/backfill/adapters/kr36.ts` with:

```ts
import { fetch36KrScfPage } from "../../kr36-scf-client";
import type { BackfillAdapter, BackfillPageResult } from "../types";

export interface Kr36AdapterDependencies {
  fetchPage?: (cursor: string | null) => Promise<BackfillPageResult>;
}

export function create36KrBackfillAdapter(
  dependencies: Kr36AdapterDependencies = {},
): BackfillAdapter {
  const fetchPage = dependencies.fetchPage ?? fetch36KrScfPage;
  return {
    sourceId: "36kr-macro",
    fetchPage,
  };
}
```

In `lib/backfill/adapters/index.ts`, remove recovery-state imports, constants, cursor parsing, and D1/before-run dependency fields. Keep only an optional `kr36` dependency and return `create36KrBackfillAdapter(dependencies.kr36)`.

In `lib/backfill/runner.ts`, create default adapters with `createBackfillAdapter(sourceId)`; no recovery state is required because the SCF cursor is already persisted by the existing backfill service after every page.

- [ ] **Step 4: Run all backfill tests and verify GREEN**

```powershell
npm.cmd test -- tests/backfill-kr36.test.ts tests/backfill-runner.test.ts tests/backfill-service.test.ts tests/backfill-repository.test.ts tests/backfill-api.test.ts
```

Expected: all focused backfill tests PASS, including fixed-window and progress-state tests.

- [ ] **Step 5: Prove there is no production direct 36Kr fallback**

Run:

```powershell
rg -n "FIRST_PAGE_URL|gateway\.36kr\.com|www\.36kr\.com/newsflashes" lib app worker
```

Expected: no matches under `lib`, `app`, or `worker`; upstream URLs exist only in `scf/kr36/index.mjs` and fixtures/docs.

- [ ] **Step 6: Commit backfill integration**

```powershell
git add -- lib/backfill/adapters/kr36.ts lib/backfill/adapters/index.ts lib/backfill/runner.ts tests/backfill-kr36.test.ts tests/backfill-runner.test.ts
git commit -m "feat: route 36Kr backfill through SCF"
```

## Task 5: Add secret typing and deployment instructions

**Files:**
- Modify: `worker/index.ts`
- Create: `docs/36kr-scf-setup.md`

- [ ] **Step 1: Type the Worker secrets**

Add these fields to `Env` in `worker/index.ts` without adding their values to `wrangler.jsonc`:

```ts
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KR36_SCF_URL: string;
  KR36_SCF_TOKEN: string;
  // existing IMAGES binding remains unchanged
}
```

- [ ] **Step 2: Write exact setup documentation**

Create `docs/36kr-scf-setup.md` containing:

1. Upload/copy `scf/kr36/index.mjs` as Tencent function `index.mjs`.
2. Keep execution method `index.main_handler`, Node.js latest runtime, 128 MB, 20-second timeout, public egress enabled, no timer.
3. Generate one 32-byte secret locally with:

   ```powershell
   $bytes = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
   [Convert]::ToBase64String($bytes)
   ```

4. Store it as SCF environment variable `KR36_SCF_TOKEN`.
5. Create a public HTTPS Function URL; CORS is unnecessary because only Cloudflare calls it.
6. Store the URL and the same token as Cloudflare secrets `KR36_SCF_URL` and `KR36_SCF_TOKEN` through the Cloudflare dashboard used by the GitHub deployment.
7. Test the Function URL with an authenticated `fetchPage` request and confirm HTTP 200 without printing the token in screenshots or logs.
8. State that neither value belongs in Git, `wrangler.jsonc`, `.env`, issue comments, or chat messages.

- [ ] **Step 3: Run static checks for accidental secret values**

```powershell
rg -n "KR36_SCF_(URL|TOKEN)\s*[:=]\s*['\"][^'\"]+" . --glob '!docs/36kr-scf-setup.md' --glob '!docs/superpowers/**'
```

Expected: declarations and environment lookups only; no literal URL or token value.

- [ ] **Step 4: Commit configuration documentation**

```powershell
git add -- worker/index.ts docs/36kr-scf-setup.md
git commit -m "docs: add 36Kr SCF deployment setup"
```

## Task 6: Full verification and production handoff

**Files:**
- Verify all files changed by Tasks 1-5

- [ ] **Step 1: Run the complete automated test suite**

```powershell
npm.cmd test
```

Expected: exit code 0 and zero failed tests.

- [ ] **Step 2: Run TypeScript checking**

```powershell
npx.cmd tsc --noEmit
```

Expected: exit code 0 and no diagnostics.

- [ ] **Step 3: Run ESLint**

```powershell
npm.cmd run lint
```

Expected: exit code 0 and no lint errors.

- [ ] **Step 4: Run the production build**

```powershell
npm.cmd run build
```

Expected: exit code 0 and a successful vinext/Cloudflare production build.

- [ ] **Step 5: Inspect the final diff and repository state**

```powershell
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: no whitespace errors; only intentional commits/files are ahead of `origin/main`.

- [ ] **Step 6: Perform staged production verification**

After the user configures the two secrets and deploys the SCF function:

1. Call the SCF Function URL once with `fetchPage` and confirm 20 or fewer valid `36kr-macro` items.
2. Deploy the Cloudflare application.
3. Click “立即刷新” and confirm the 36Kr source status becomes healthy and new items appear.
4. Run “过去24小时补充采集” and confirm the 36Kr row advances through pages and reports evidence-based coverage.
5. Confirm the other three source intervals and statuses are unchanged.
6. Confirm production logs and UI errors contain no token, nonce, cursor, signature, or upstream response body.

- [ ] **Step 7: Commit any verification-only corrections, then stop before push**

If verification required code corrections, repeat the relevant RED/GREEN cycle and commit only those corrections. Do not push until the user explicitly requests it.
