import { describe, expect, it } from "vitest";
import {
  FeedRequestCoordinator,
  SEARCH_FILTER_DELAY_MS,
  feedFilterDelay,
  isAbortError,
} from "../lib/feed-request-policy";

describe("feed request policy", () => {
  it("debounces search but runs source and time selections immediately", () => {
    expect(SEARCH_FILTER_DELAY_MS).toBe(250);
    expect(feedFilterDelay("search")).toBe(250);
    expect(feedFilterDelay("selection")).toBe(0);
  });

  it("aborts and invalidates the previous ticket when a new request begins", () => {
    const coordinator = new FeedRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(coordinator.isCurrent(first)).toBe(false);
    expect(coordinator.isCurrent(second)).toBe(true);
  });

  it("aborts and invalidates the current ticket when cancelled", () => {
    const coordinator = new FeedRequestCoordinator();
    const ticket = coordinator.begin();

    coordinator.cancel();

    expect(ticket.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(ticket)).toBe(false);
  });

  it("recognizes browser-style abort errors without hiding ordinary failures", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError(new Error("network failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
