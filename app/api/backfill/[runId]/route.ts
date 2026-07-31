import { ensureSchema } from "../../../../db/ensure";
import { getD1 } from "../../../../db";
import { getBackfillRun } from "../../../../lib/backfill/repository";
import { reconcileBackfillState } from "../../../../lib/backfill/runner";

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const db = getD1();
    await ensureSchema(db);
    const { runId } = await context.params;
    const id = Number(runId);
    if (!Number.isInteger(id) || id <= 0) {
      return Response.json({ error: "补采任务编号无效" }, { status: 400 });
    }
    await reconcileBackfillState(db);
    const run = await getBackfillRun(db, id);
    if (!run) {
      return Response.json({ error: "未找到补采任务" }, { status: 404 });
    }
    return Response.json({ run }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取补采任务";
    return Response.json({ error: message }, { status: 500 });
  }
}
