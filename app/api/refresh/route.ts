import { ensureSchema } from "../../../db/ensure";
import { getD1 } from "../../../db";
import { runIngestion } from "../../../lib/ingestion";
import { getLastSuccessfulIngestion } from "../../../lib/repository";
import { retryAfterSeconds, shouldRefresh } from "../../../lib/refresh-policy";
import { isBackfillActive } from "../../../lib/backfill/runner";

export async function POST() {
  try {
    const db = getD1();
    await ensureSchema(db);
    const now = new Date();
    if (isBackfillActive()) {
      return Response.json({
        status: "busy",
        refreshedAt: now.toISOString(),
      }, { status: 202 });
    }
    const lastSuccess = await getLastSuccessfulIngestion(db);
    if (lastSuccess && !shouldRefresh(lastSuccess, now)) {
      return Response.json({
        status: "skipped",
        refreshedAt: lastSuccess.toISOString(),
        retryAfterSeconds: retryAfterSeconds(lastSuccess, now),
      }, { status: 202 });
    }

    const result = await runIngestion(db, now);
    return Response.json(result, {
      status: result.status === "partial" ? 207 : result.status === "error" ? 502 : 200,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "刷新失败";
    return Response.json({ error: message }, { status: 500 });
  }
}
