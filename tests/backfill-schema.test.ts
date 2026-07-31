import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTestD1 } from "./helpers/d1";

const base = readFileSync(
  new URL("../drizzle/0000_first_strong_guy.sql", import.meta.url),
  "utf8",
);
const backfill = readFileSync(
  new URL("../drizzle/0001_backfill_runs.sql", import.meta.url),
  "utf8",
);

describe("backfill schema", () => {
  it("stores one task and one row per source", () => {
    const testDb = createTestD1();
    testDb.sqlite.exec(base);
    testDb.sqlite.exec(backfill);
    testDb.sqlite.prepare(`
      INSERT INTO backfill_runs (
        requested_source_id, window_start, window_end,
        started_at, status, created_at
      ) VALUES (NULL, 1, 2, 1, 'running', 1)
    `).run();
    testDb.sqlite.prepare(`
      INSERT INTO backfill_source_runs (
        run_id, source_id, status, updated_at
      ) VALUES (1, '36kr-macro', 'running', 1)
    `).run();
    expect(testDb.sqlite.prepare(
      "SELECT run_id, source_id FROM backfill_source_runs",
    ).all()).toEqual([{ run_id: 1, source_id: "36kr-macro" }]);
    testDb.sqlite.close();
  });
});
