import { describe, expect, it, vi } from "vitest";
import { create36KrBackfillAdapter } from "../lib/backfill/adapters/kr36";

describe("36Kr SCF backfill adapter", () => {
  it("delegates first and subsequent pages to SCF", async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({
        items: [],
        nextCursor: "cursor-1",
        exhausted: false,
      })
      .mockResolvedValueOnce({
        items: [],
        nextCursor: null,
        exhausted: true,
      });
    const adapter = create36KrBackfillAdapter({ fetchPage });

    await adapter.fetchPage(null);
    await adapter.fetchPage("cursor-1");

    expect(fetchPage.mock.calls).toEqual([[null], ["cursor-1"]]);
  });

  it("does not hide SCF errors", async () => {
    const adapter = create36KrBackfillAdapter({
      fetchPage: vi.fn().mockRejectedValue(
        new Error("36Kr SCF 请求失败"),
      ),
    });

    await expect(adapter.fetchPage(null)).rejects.toThrow(
      "36Kr SCF 请求失败",
    );
  });
});
