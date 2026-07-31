import type { SourceId } from "../../domain";
import type { BackfillAdapter } from "../types";
import { createClsBackfillAdapter } from "./cls";
import { createJiemianBackfillAdapter } from "./jiemian";
import { create36KrBackfillAdapter } from "./kr36";

export function createBackfillAdapter(sourceId: SourceId): BackfillAdapter {
  if (sourceId === "36kr-macro") return create36KrBackfillAdapter();
  if (sourceId === "cls-headline") return createClsBackfillAdapter();
  return createJiemianBackfillAdapter(sourceId);
}
