import type { SourceId } from "../../domain";
import type { BackfillAdapter } from "../types";
import { createClsBackfillAdapter } from "./cls";
import { createJiemianBackfillAdapter } from "./jiemian";
import {
  create36KrBackfillAdapter,
  type Kr36AdapterDependencies,
} from "./kr36";

interface BackfillAdapterDependencies {
  kr36?: Kr36AdapterDependencies;
}

export function createBackfillAdapter(
  sourceId: SourceId,
  dependencies: BackfillAdapterDependencies = {},
): BackfillAdapter {
  if (sourceId === "36kr-macro") {
    return create36KrBackfillAdapter(dependencies.kr36);
  }
  if (sourceId === "cls-headline") return createClsBackfillAdapter();
  return createJiemianBackfillAdapter(sourceId);
}
