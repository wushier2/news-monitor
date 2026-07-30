import { ensureSchema } from "../../../db/ensure";
import { getD1 } from "../../../db";
import { parseFeedInput } from "../../../lib/api-input";
import {
  countItemsInRange,
  getSourceStatuses,
  listFeedPage,
} from "../../../lib/repository";
import { getBeijingDayBounds } from "../../../lib/time-range";

export async function GET(request: Request) {
  try {
    const now = Date.now();
    const input = parseFeedInput(request.url, now);
    const db = getD1();
    await ensureSchema(db);
    const [feedPage, sources, todayCount] = await Promise.all([
      listFeedPage(db, input),
      getSourceStatuses(db),
      countItemsInRange(db, getBeijingDayBounds(now)),
    ]);
    const totalPages = Math.ceil(feedPage.totalItems / input.pageSize);
    return Response.json(
      {
        items: feedPage.items,
        sources,
        generatedAt: new Date(now).toISOString(),
        todayCount,
        pagination: {
          page: input.page,
          pageSize: input.pageSize,
          totalItems: feedPage.totalItems,
          totalPages,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取信息流";
    const status = /搜索词|未知来源|时间|最近 7 天|未来|页码|每页/.test(message)
      ? 400
      : 500;
    return Response.json({ error: message }, { status });
  }
}
