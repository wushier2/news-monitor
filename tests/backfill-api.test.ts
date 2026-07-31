import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeRun = {
  id: 42,
  requestedSourceId: null,
  windowStart: "2026-07-30T10:00:00.000Z",
  windowEnd: "2026-07-31T10:00:00.000Z",
  startedAt: "2026-07-31T10:00:00.000Z",
  finishedAt: null,
  status: "running",
  createdAt: "2026-07-31T10:00:00.000Z",
  sources: [],
} as const;

const fakes = vi.hoisted(() => ({
  db: {} as D1Database,
  ensureSchema: vi.fn(),
  getBackfillRun: vi.fn(),
  getLatestBackfillRun: vi.fn(),
  reconcileBackfillState: vi.fn(),
  startBackfill: vi.fn(),
}));

vi.mock("../db", () => ({ getD1: () => fakes.db }));
vi.mock("../db/ensure", () => ({ ensureSchema: fakes.ensureSchema }));
vi.mock("../lib/backfill/repository", () => ({
  getBackfillRun: fakes.getBackfillRun,
  getLatestBackfillRun: fakes.getLatestBackfillRun,
}));
vi.mock("../lib/backfill/runner", () => ({
  reconcileBackfillState: fakes.reconcileBackfillState,
  startBackfill: fakes.startBackfill,
}));

import { GET as getLatest, POST } from "../app/api/backfill/route";
import { GET as getById } from "../app/api/backfill/[runId]/route";

describe("backfill API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.ensureSchema.mockResolvedValue(undefined);
    fakes.reconcileBackfillState.mockResolvedValue(0);
    fakes.startBackfill.mockResolvedValue({ run: fakeRun, reused: false });
    fakes.getLatestBackfillRun.mockResolvedValue(fakeRun);
    fakes.getBackfillRun.mockResolvedValue(fakeRun);
  });

  it("starts all sources with an empty body", async () => {
    const response = await POST(new Request("https://example.test/api/backfill", {
      method: "POST",
    }));
    expect(response.status).toBe(202);
    expect(fakes.startBackfill).toHaveBeenCalledWith(fakes.db, {});
    expect(await response.json()).toEqual({ run: fakeRun, reused: false });
  });

  it("accepts a supported single source", async () => {
    const response = await POST(new Request("https://example.test/api/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "36kr-macro" }),
    }));
    expect(response.status).toBe(202);
    expect(fakes.startBackfill).toHaveBeenCalledWith(fakes.db, {
      sourceId: "36kr-macro",
    });
  });

  it.each([
    ["{", "application/json"],
    [JSON.stringify({ sourceId: "unknown" }), "application/json"],
    [JSON.stringify({ extra: true }), "application/json"],
  ])("returns 400 for invalid input %#", async (body, contentType) => {
    const response = await POST(new Request("https://example.test/api/backfill", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }));
    expect(response.status).toBe(400);
    expect(fakes.startBackfill).not.toHaveBeenCalled();
  });

  it("returns the latest task after reconciling stale state", async () => {
    const response = await getLatest();
    expect(response.status).toBe(200);
    expect(fakes.reconcileBackfillState).toHaveBeenCalledWith(fakes.db);
    expect(await response.json()).toEqual({ run: fakeRun });
  });

  it("returns a task by positive id and 404 for an unknown id", async () => {
    const response = await getById(
      new Request("https://example.test/api/backfill/42"),
      { params: Promise.resolve({ runId: "42" }) },
    );
    expect(response.status).toBe(200);
    expect(fakes.getBackfillRun).toHaveBeenCalledWith(fakes.db, 42);

    fakes.getBackfillRun.mockResolvedValueOnce(null);
    const missing = await getById(
      new Request("https://example.test/api/backfill/99"),
      { params: Promise.resolve({ runId: "99" }) },
    );
    expect(missing.status).toBe(404);
  });

  it("returns 400 for a non-positive task id", async () => {
    const response = await getById(
      new Request("https://example.test/api/backfill/nope"),
      { params: Promise.resolve({ runId: "nope" }) },
    );
    expect(response.status).toBe(400);
    expect(fakes.getBackfillRun).not.toHaveBeenCalled();
  });
});
