// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EstimateSearchResponse } from "@app/shared";
import { SearchFlow } from "./SearchFlow";

// Same reasoning as SourceToggles.test.tsx / ResultsList.test.tsx: this
// repo's root vitest.config.ts doesn't enable `test.globals`, so RTL's
// auto-cleanup (which needs a GLOBAL `afterEach`) never fires on its own.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();

vi.mock("../api/client", () => ({
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

/**
 * A promise this test controls the resolution timing of, so "the estimate
 * request is still in flight" (phase === "estimating") is a real state we
 * can hold open and inspect/mutate around, not just something inferred from
 * timing. Same technique the round-3 reviewer used in their own throwaway
 * probe for this race (git-bug 484889d).
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeEstimate(overrides: Partial<EstimateSearchResponse> = {}): EstimateSearchResponse {
  return {
    resumeId: "resume-1",
    costEstimate: {
      jobCount: 10,
      estimatedInputTokens: 1000,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 200,
      estimatedCostUsd: 0.42,
      basis: "bootstrap",
    },
    costEstimateDescription: "Would score 10 jobs.",
    candidatesNeedingScore: 10,
    scoreThreshold: 100,
    cappedCount: 0,
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
    ...overrides,
  };
}

describe("SearchFlow — F1 money-safety (git-bug 484889d, review round 3)", () => {
  it("baseline: changing sourceIds/resumeId while an estimate is already SHOWING (not in flight) resets to idle", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    expect(screen.getByLabelText("Cost estimate")).toBeInTheDocument();

    // Selection changes AFTER the estimate has already landed and is on
    // screen — e.g. the user toggles a source having seen the price.
    rerender(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    });

    // Same hole, resumeId side: re-show an estimate, then change resumeId.
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });

    rerender(<SearchFlow resumeId="resume-2" sourceIds={["a"]} onSearchComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    });
  });

  it("the race: sourceIds change WHILE the estimate request is still in flight never leaves an actionable estimate bound to the stale selection", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    // Request is now in flight (phase === "estimating"); the mocked
    // estimateSearch call captured the selection at click time, ["a", "b"].
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["a", "b"]);
    await screen.findByText("Getting a cost estimate...");

    // WHILE still in flight, the user toggles "b" off — sourceIds prop
    // changes out from under the pending request.
    rerender(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    // The in-flight request now resolves, computed for the STALE ["a", "b"]
    // selection.
    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });

    // Whatever phase this settles into, it must not be an "estimated" state
    // whose captured snapshot (["a", "b"]) diverges from the live props
    // (["a"]) while still being confirmable via "Run search" — that would
    // let the user fire startSearch against a selection they never saw a
    // price for. The fix resets straight back to idle.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Run search" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();

    // And confirm startSearch is never reachable/called against the stale
    // snapshot — no button exists to fire it, and it must not have been
    // called as a side effect of the resolution either.
    expect(startSearch).not.toHaveBeenCalled();
  });

  it("the race, resumeId side: resumeId changes WHILE the estimate request is still in flight is caught the same way", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["a", "b"]);
    await screen.findByText("Getting a cost estimate...");

    // WHILE still in flight, resumeId changes (e.g. a different resume was
    // selected/uploaded).
    rerender(<SearchFlow resumeId="resume-2" sourceIds={["a", "b"]} onSearchComplete={() => {}} />);

    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Run search" })).not.toBeInTheDocument();
    expect(startSearch).not.toHaveBeenCalled();
  });

  it("happy path: nothing races — confirming Run search fires startSearch with exactly the estimated (captured) selection", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({ status: "pending" });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });

    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await waitFor(() => {
      expect(startSearch).toHaveBeenCalledWith("resume-1", ["a", "b"]);
    });
    expect(startSearch).toHaveBeenCalledOnce();
  });
});
