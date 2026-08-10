import { fetch36KrScfPage } from "../../kr36-scf-client";
import type { BackfillAdapter, BackfillPageResult } from "../types";

export interface Kr36AdapterDependencies {
  fetchPage?: (cursor: string | null) => Promise<BackfillPageResult>;
}

export function create36KrBackfillAdapter(
  dependencies: Kr36AdapterDependencies = {},
): BackfillAdapter {
  const fetchPage = dependencies.fetchPage ?? fetch36KrScfPage;
  return {
    sourceId: "36kr-macro",
    fetchPage,
  };
}
