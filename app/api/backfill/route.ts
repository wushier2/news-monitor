import { ensureSchema } from "../../../db/ensure";
import { getD1 } from "../../../db";
import { getLatestBackfillRun } from "../../../lib/backfill/repository";
import {
  reconcileBackfillState,
  startBackfill,
} from "../../../lib/backfill/runner";
import { SOURCE_IDS } from "../../../lib/sources";
import type { SourceId } from "../../../lib/domain";

function parseInput(text: string): { sourceId?: SourceId } {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("请求内容不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求内容格式不正确");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "sourceId")) {
    throw new Error("请求包含不支持的字段");
  }
  if (record.sourceId === undefined) return {};
  if (typeof record.sourceId !== "string"
    || !SOURCE_IDS.has(record.sourceId as SourceId)) {
    throw new Error("未知来源");
  }
  return { sourceId: record.sourceId as SourceId };
}

export async function POST(request: Request) {
  try {
    const db = getD1();
    await ensureSchema(db);
    const input = parseInput(await request.text());
    const result = await startBackfill(db, input);
    return Response.json(result, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法启动补采";
    const status = /请求|未知来源|字段/.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

export async function GET() {
  try {
    const db = getD1();
    await ensureSchema(db);
    await reconcileBackfillState(db);
    return Response.json({ run: await getLatestBackfillRun(db) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取补采任务";
    return Response.json({ error: message }, { status: 500 });
  }
}
