import { ensureSchema } from "../../../db/ensure";
import { getD1 } from "../../../db";
import { parseFeedInput } from "../../../lib/api-input";
import { getSourceStatuses, listFeed } from "../../../lib/repository";

export async function GET(request: Request) {
  try {
    const input = parseFeedInput(request.url);
    const db = getD1();
    await ensureSchema(db);
    const [items, sources] = await Promise.all([
      listFeed(db, input),
      getSourceStatuses(db),
    ]);
    return Response.json(
      { items, sources, generatedAt: new Date().toISOString() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取信息流";
    const status = /搜索词|未知来源/.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}
