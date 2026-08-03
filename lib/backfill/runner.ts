import type { SourceId } from "../domain";
import { SOURCES, SOURCE_IDS } from "../sources";
import { createBackfillAdapter } from "./adapters";
import { waitBetweenPages } from "./http";
import {
  createBackfillRun,
  findRunningBackfill,
  finishBackfillRun,
  interruptRunningBackfills,
  updateBackfillSource,
} from "./repository";
import { runBackfillSources } from "./service";
import type { BackfillAdapter, StartBackfillResponse } from "./types";

const DAY_MS = 86_400_000;
const activeTasks = new Map<number, Promise<void>>();
let startLock: Promise<void> = Promise.resolve();

export interface StartBackfillInput {
  sourceId?: string;
}

export interface BackfillRunnerDependencies {
  createAdapter?: (sourceId: SourceId) => BackfillAdapter;
  runSources?: typeof runBackfillSources;
  waitBetweenPages?: () => Promise<void>;
  clock?: () => Date;
}

export interface StartedBackfillResponse extends StartBackfillResponse {
  completion: Promise<void>;
}

function withStartLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = startLock.then(operation, operation);
  startLock = result.then(() => undefined, () => undefined);
  return result;
}

function validateSourceId(sourceId: string | undefined): SourceId | null {
  if (sourceId === undefined) return null;
  if (!SOURCE_IDS.has(sourceId as SourceId)) throw new Error("未知来源");
  return sourceId as SourceId;
}

export function isBackfillActive(): boolean {
  return activeTasks.size > 0;
}

export async function reconcileBackfillState(
  db: D1Database,
  now: Date = new Date(),
): Promise<number> {
  const running = await findRunningBackfill(db);
  if (!running || activeTasks.has(running.id)) return 0;
  return interruptRunningBackfills(db, now);
}

export function startBackfill(
  db: D1Database,
  input: StartBackfillInput = {},
  requestedAt: Date = new Date(),
  dependencies: BackfillRunnerDependencies = {},
): Promise<StartedBackfillResponse> {
  return withStartLock(async () => {
    const requestedSourceId = validateSourceId(input.sourceId);
    const running = await findRunningBackfill(db);
    if (running && activeTasks.has(running.id)) {
      return {
        run: running,
        reused: true,
        completion: activeTasks.get(running.id)!,
      };
    }
    if (running) await interruptRunningBackfills(db, requestedAt);

    const sourceIds = requestedSourceId
      ? [requestedSourceId]
      : SOURCES.map((source) => source.id);
    const run = await createBackfillRun(db, {
      sourceIds,
      requestedSourceId,
      windowStart: requestedAt.getTime() - DAY_MS,
      windowEnd: requestedAt.getTime(),
      now: requestedAt,
    });
    const adapters = sourceIds.map((sourceId) => dependencies.createAdapter
      ? dependencies.createAdapter(sourceId)
      : createBackfillAdapter(sourceId, { db, beforeRunId: run.id }));
    const clock = dependencies.clock ?? (() => new Date());
    const runSources = dependencies.runSources ?? runBackfillSources;
    const pageWait = dependencies.waitBetweenPages ?? waitBetweenPages;

    const task = Promise.resolve()
      .then(async () => {
        await runSources({
          db,
          runId: run.id,
          adapters,
          windowStart: requestedAt.getTime() - DAY_MS,
          windowEnd: requestedAt.getTime(),
          now: clock,
          waitBetweenPages: pageWait,
        });
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await Promise.all(run.sources.map((source) => updateBackfillSource(
          db,
          run.id,
          source.sourceId,
          {
            status: "failed",
            cursor: source.cursor,
            pagesFetched: source.pagesFetched,
            itemsFetched: source.itemsFetched,
            itemsInWindow: source.itemsInWindow,
            itemsInserted: source.itemsInserted,
            itemsExisting: source.itemsExisting,
            earliestCoveredAt: source.earliestCoveredAt
              ? Date.parse(source.earliestCoveredAt)
              : null,
            error: message,
          },
          clock(),
        )));
        await finishBackfillRun(db, run.id, "failed", clock());
      })
      .finally(() => {
        activeTasks.delete(run.id);
      });
    activeTasks.set(run.id, task);

    return { run, reused: false, completion: task };
  });
}
