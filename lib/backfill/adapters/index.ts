import type { SourceId } from "../../domain";
import { getBackfillRecoveryState } from "../repository";
import type { BackfillAdapter } from "../types";
import { createClsBackfillAdapter } from "./cls";
import { createJiemianBackfillAdapter } from "./jiemian";
import {
  create36KrBackfillAdapter,
  type Kr36AdapterDependencies,
  type Kr36RecoveryState,
} from "./kr36";

const RISK_COOLDOWN_MS = 15 * 60_000;

interface BackfillAdapterDependencies {
  db?: D1Database;
  beforeRunId?: number;
  kr36?: Omit<Kr36AdapterDependencies, "loadRecoveryState">;
}

function readCachedNonce(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(cursor) as { nonce?: unknown };
    return typeof value.nonce === "string" && value.nonce
      ? value.nonce
      : null;
  } catch {
    return null;
  }
}

export function createBackfillAdapter(
  sourceId: SourceId,
  dependencies: BackfillAdapterDependencies = {},
): BackfillAdapter {
  if (sourceId === "36kr-macro") {
    let loadRecoveryState: (() => Promise<Kr36RecoveryState>) | undefined;
    if (dependencies.db && dependencies.beforeRunId !== undefined) {
      loadRecoveryState = async () => {
        const state = await getBackfillRecoveryState(
          dependencies.db!,
          sourceId,
          dependencies.beforeRunId!,
        );
        const riskCooldownUntil = state.latestError?.startsWith(
          "36Kr 风控拦截",
        ) && state.latestUpdatedAt !== null
          ? state.latestUpdatedAt + RISK_COOLDOWN_MS
          : null;
        return {
          nonce: readCachedNonce(state.cursor),
          riskCooldownUntil,
        };
      };
    }
    return create36KrBackfillAdapter({
      ...dependencies.kr36,
      loadRecoveryState,
    });
  }
  if (sourceId === "cls-headline") return createClsBackfillAdapter();
  return createJiemianBackfillAdapter(sourceId);
}
