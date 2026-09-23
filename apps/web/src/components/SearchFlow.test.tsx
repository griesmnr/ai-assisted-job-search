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
  // Ticket 3f05144: this app now persists an in-progress resume/search to
  // `sessionStorage`, which — unlike React state — is NOT torn down by
  // `cleanup()`. Without this, one test's submitted resume or in-flight
  // searchId would be restored by the next test's first render.
  sessionStorage.clear();
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
 * timing.
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
      maxCostUsd: 0.42,
      probableCostUsd: 0.3,
      basis: "bootstrap",
    },
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
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], undefined);
    await screen.findByText(/Getting a cost estimate/);

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
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], undefined);
    await screen.findByText(/Getting a cost estimate/);

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

  it("ticket 957bc22: changing criteria while an estimate is already showing resets to idle, same as sourceIds/resumeId", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());

    const { rerender } = render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a", "b"]}
        criteria={{ titleInclude: ["backend"] }}
        onSearchComplete={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], {
      titleInclude: ["backend"],
    });

    // Criteria changes AFTER the estimate landed and is on screen -- e.g.
    // the user edits the title-include field having already seen a price.
    // Same failure this whole snapshot mechanism exists to prevent as the
    // sourceIds/resumeId cases above: a stale estimate must never remain
    // confirmable once what it priced has changed.
    rerender(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a", "b"]}
        criteria={{ titleInclude: ["backend", "platform"] }}
        onSearchComplete={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    });
    expect(startSearch).not.toHaveBeenCalled();
  });

  it("happy path: nothing races — confirming Run search fires startSearch with exactly the estimated (captured) selection", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      scoredSoFar: 0,
      linked: 0,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      sourcesSettled: false,
      sources: [],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });

    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await waitFor(() => {
      expect(startSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], undefined);
    });
    expect(startSearch).toHaveBeenCalledOnce();
  });

  it("prop change during an in-flight run must not reset 'starting'/'running'", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    const { promise, resolve } = deferred<{ searchId: string }>();
    startSearch.mockReturnValue(promise);
    getSearchStatus.mockResolvedValue({
      status: "pending",
      scoredSoFar: 0,
      linked: 0,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      sourcesSettled: false,
      sources: [],
    });

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    await screen.findByRole("button", { name: "Starting..." });
    expect(startSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], undefined);

    rerender(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    expect(screen.getByRole("button", { name: "Starting..." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Estimate search cost" })).not.toBeInTheDocument();

    await act(async () => {
      resolve({ searchId: "s1" });
      await promise;
    });
    await screen.findByLabelText("Search running");
    rerender(<SearchFlow resumeId="resume-1" sourceIds={["z"]} onSearchComplete={() => {}} />);
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();
  });

  // Ticket 1998875 acceptance criterion: "A test proving the count
  // increases mid-run, not just jumps straight to the final total." Uses
  // the same deferred/controllable-mock technique as the tests above —
  // here applied to `getSearchStatus` via chained `mockResolvedValueOnce`
  // calls, one per poll tick — so each of the running search's real
  // `setInterval` ticks (POLL_INTERVAL_MS = 2000ms in SearchFlow.tsx) can
  // be observed landing a DIFFERENT, still-climbing `scoredSoFar` value
  // before the run completes, rather than asserting only the final
  // "done" state.
  it("shows scoredSoFar climbing across multiple poll ticks before the run completes, proving intermediate progress is genuinely observable (ticket 1998875)", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });

    // Tick 1: 3 of 10. Tick 2: 7 of 10 — a DIFFERENT, higher value, not
    // the same number repeated and not the final total (10) — proves
    // this is a genuinely progressing count, not a single flip from 0 to
    // done. Tick 3: the run completes.
    getSearchStatus
      .mockResolvedValueOnce({
        status: "pending",
        scoredSoFar: 3,
        // Same as the estimate's jobCount (10) on purpose: this test is
        // about scoredSoFar climbing, not the denominator, so keeping it
        // stable at what the estimate already showed avoids conflating the
        // two. See SearchFlow.persistence.test.tsx for tests specifically
        // proving `linked` (not the estimate) drives the denominator.
        linked: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      })
      .mockResolvedValueOnce({
        status: "pending",
        scoredSoFar: 7,
        linked: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      })
      .mockResolvedValue({
        status: "complete",
        searchId: "search-1",
        resumeId: "resume-1",
        scored: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        linked: 10,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await screen.findByLabelText("Search running");
    // Before any poll response has landed, the count starts at 0 — this
    // is what proves the LATER assertions are observing genuine
    // progress, not just a display that was already showing a nonzero
    // number from the start.
    expect(screen.getByText("0 of 10 scored so far.")).toBeInTheDocument();

    // First poll tick lands ~2000ms of real time after "running" started
    // (POLL_INTERVAL_MS) — the explicit timeout below is longer than
    // testing-library's default 1000ms `waitFor` timeout specifically to
    // give that real interval tick room to fire.
    await waitFor(
      () => {
        expect(screen.getByText("3 of 10 scored so far.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    // Still running, not "done" — one pending tick must not end the poll.
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();

    // Second poll tick: a higher, still-intermediate value.
    await waitFor(
      () => {
        expect(screen.getByText("7 of 10 scored so far.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();

    // Third tick finally completes the run.
    await waitFor(
      () => {
        expect(screen.getByLabelText("Search finished")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  }, 15000);

  // Review round, F2: `setInterval` fires unconditionally every
  // POLL_INTERVAL_MS, and each tick's `poll()` awaits its OWN independent
  // `getSearchStatus` round trip — so two ticks for the same run can settle
  // OUT OF ORDER. A slow early tick can still be in flight when a faster
  // later tick already resolved with a HIGHER count; if the slow tick then
  // resolves with its OLDER (lower) count, a bare overwrite would make the
  // displayed count run backwards. Uses per-call deferred promises (same
  // `deferred()` helper the F1 tests above use for `estimateSearch`/
  // `startSearch`, applied here to individual `getSearchStatus` calls) so
  // this test controls RESOLUTION order independently of INVOCATION order —
  // the only way to reproduce "later-fired, faster" vs. "earlier-fired,
  // slower" deterministically rather than by timing luck.
  it("an out-of-order (slower, stale) poll response never regresses scoredSoFar backward (ticket 1998875 review, F2)", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });

    type PendingTick = {
      status: string;
      scoredSoFar: number;
      linked: number;
      permanentlyFailed: number;
      cappedForBudget: number;
      sourcesSettled: boolean;
      sources: never[];
      searchId: string;
      resumeId: string;
    };
    const tickA = deferred<PendingTick>();
    const tickB = deferred<PendingTick>();
    getSearchStatus
      .mockReturnValueOnce(tickA.promise)
      .mockReturnValueOnce(tickB.promise)
      .mockResolvedValue({
        status: "complete",
        searchId: "search-1",
        resumeId: "resume-1",
        scored: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        linked: 10,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await screen.findByLabelText("Search running");
    expect(screen.getByText("0 of 10 scored so far.")).toBeInTheDocument();

    // Wait for BOTH the first tick (fires ~2000ms after "running" started)
    // and the second tick (~2000ms after that) to have actually been
    // invoked — both `getSearchStatus` calls are now in flight,
    // deliberately left unresolved so far.
    await waitFor(
      () => {
        expect(getSearchStatus).toHaveBeenCalledTimes(2);
      },
      { timeout: 5000 },
    );

    // Resolve the SECOND (later-fired) tick FIRST, simulating it being the
    // FASTER response — a higher, genuinely-progressed count.
    await act(async () => {
      tickB.resolve({
        status: "pending",
        scoredSoFar: 7,
        // Same as the estimate's jobCount (10), deliberately -- this test
        // is about scoredSoFar's out-of-order protection, not the
        // denominator (see the `linked`-specific tests in
        // SearchFlow.persistence.test.tsx).
        linked: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await tickB.promise;
    });
    await waitFor(() => {
      expect(screen.getByText("7 of 10 scored so far.")).toBeInTheDocument();
    });

    // NOW resolve the FIRST (earlier-fired) tick — the SLOWER, now-STALE
    // response, carrying a LOWER count than what's already on screen.
    await act(async () => {
      tickA.resolve({
        status: "pending",
        scoredSoFar: 3,
        linked: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await tickA.promise;
    });

    // Must NOT regress to the stale, lower value — the display stays at the
    // higher count `Math.max` preserved. Given one tick to process (a
    // `waitFor` poll), the DOM must never show "3 of 10" at all.
    await waitFor(() => {
      expect(screen.getByText("7 of 10 scored so far.")).toBeInTheDocument();
    });
    expect(screen.queryByText("3 of 10 scored so far.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();
  }, 15000);

  // Opus review (ticket 2e7ba8a, F3): the test above deliberately holds
  // `linked` constant at 10 across both ticks, to isolate `scoredSoFar`'s
  // out-of-order guard from the denominator. That leaves `linked`'s own
  // `Math.max` guard (mirroring `scoredSoFar`'s) completely unproven —
  // mutation-verified during review: replacing it with a bare
  // `result.linked` passed every other test in the suite. This test is the
  // same out-of-order shape, but diverges `linked`/`cappedForBudget`
  // instead of `scoredSoFar` to actually exercise that guard.
  it("an out-of-order (slower, stale) poll response never regresses linked/cappedForBudget backward (ticket 2e7ba8a review, F3)", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });

    type PendingTick = {
      status: string;
      scoredSoFar: number;
      linked: number;
      permanentlyFailed: number;
      cappedForBudget: number;
      sourcesSettled: boolean;
      sources: never[];
      searchId: string;
      resumeId: string;
    };
    const tickA = deferred<PendingTick>();
    const tickB = deferred<PendingTick>();
    getSearchStatus
      .mockReturnValueOnce(tickA.promise)
      .mockReturnValueOnce(tickB.promise)
      .mockResolvedValue({
        status: "complete",
        searchId: "search-1",
        resumeId: "resume-1",
        scored: 15,
        permanentlyFailed: 0,
        cappedForBudget: 5,
        linked: 20,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await screen.findByLabelText("Search running");

    await waitFor(
      () => {
        expect(getSearchStatus).toHaveBeenCalledTimes(2);
      },
      { timeout: 5000 },
    );

    // Resolve the SECOND (later-fired) tick FIRST, simulating it being the
    // FASTER response — genuinely-progressed, higher linked/capped counts.
    await act(async () => {
      tickB.resolve({
        status: "pending",
        scoredSoFar: 10,
        linked: 18,
        permanentlyFailed: 0,
        cappedForBudget: 5,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await tickB.promise;
    });
    await waitFor(() => {
      expect(screen.getByText("10 of 18 scored so far.")).toBeInTheDocument();
    });
    expect(screen.getByText(/5 jobs already matched but deferred/)).toBeInTheDocument();

    // NOW resolve the FIRST (earlier-fired) tick — the SLOWER, now-STALE
    // response, carrying LOWER linked/capped counts than what's on screen.
    await act(async () => {
      tickA.resolve({
        status: "pending",
        scoredSoFar: 4,
        linked: 9,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await tickA.promise;
    });

    // Must NOT regress — `linked` stays at 18, `cappedForBudget` stays at 5.
    await waitFor(() => {
      expect(screen.getByText("10 of 18 scored so far.")).toBeInTheDocument();
    });
    expect(screen.queryByText("10 of 9 scored so far.")).not.toBeInTheDocument();
    expect(screen.getByText(/5 jobs already matched but deferred/)).toBeInTheDocument();
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();
  }, 15000);

  // Review round 2 (F3): the F2 fix (Math.max) alone is not sufficient — a
  // poll from a PREVIOUS, already-finished search can still resolve late and
  // leak its count onto a NEW search's phase, since `prev.kind === "running"`
  // is true again once a new search starts. Only comparing `searchId` too
  // closes this. Reproduces the mechanism directly: `setInterval` fires every
  // POLL_INTERVAL_MS regardless of whether the previous tick resolved, so
  // search-1 genuinely has TWO polls in flight — tick A (held open) and tick
  // B (resolves "complete" first, since it's a fresh promise with no delay).
  // Tick B completing the search does NOT cancel tick A's already-fired
  // promise; it only stops the interval from firing again. Search 2 starts;
  // THEN tick A's stale response finally resolves.
  it("a stale poll from a completed PREVIOUS search never leaks its count onto a NEW search (ticket 1998875 review, F3)", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch
      .mockResolvedValueOnce({ searchId: "search-1", status: "pending", skippedSources: [] })
      .mockResolvedValueOnce({ searchId: "search-2", status: "pending", skippedSources: [] });

    const search1TickA = deferred<{
      status: string;
      scoredSoFar: number;
      linked: number;
      permanentlyFailed: number;
      cappedForBudget: number;
      sourcesSettled: boolean;
      sources: never[];
      searchId: string;
      resumeId: string;
    }>();
    getSearchStatus
      // search-1, tick A (fires first, ~2000ms in): held open deliberately.
      .mockReturnValueOnce(search1TickA.promise)
      // search-1, tick B (fires second, ~4000ms in): resolves "complete"
      // immediately — genuinely faster than tick A, which is still pending.
      .mockResolvedValueOnce({
        status: "complete",
        searchId: "search-1",
        resumeId: "resume-1",
        scored: 1,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        linked: 1,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      })
      // search-2's own poll: resolves normally, scored nothing yet. `linked`
      // matches the estimate's jobCount (10) so this test's "0 of 10"
      // assertions stay about the leak-prevention it exists to prove, not
      // the denominator (see SearchFlow.persistence.test.tsx for that).
      .mockResolvedValue({
        status: "pending",
        scoredSoFar: 0,
        linked: 10,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-2",
        resumeId: "resume-1",
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    // Search 1: estimate, confirm, running.
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    await screen.findByLabelText("Search running");

    // Wait for tick B to land and finish search 1 — tick A is still
    // in-flight underneath it the whole time.
    await waitFor(
      () => {
        expect(screen.getByLabelText("Search finished")).toBeInTheDocument();
      },
      { timeout: 6000 },
    );

    // Start search 2.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    await screen.findByLabelText("Search running");
    expect(screen.getByText("0 of 10 scored so far.")).toBeInTheDocument();

    // Search 2's own poll lands normally: still 0, still running.
    await waitFor(
      () => {
        expect(getSearchStatus).toHaveBeenCalledTimes(3);
      },
      { timeout: 4000 },
    );

    // NOW search-1's stale tick A finally resolves, carrying a HIGH count
    // under search-1's searchId — while the component is displaying
    // search-2, which has scored nothing.
    await act(async () => {
      search1TickA.resolve({
        status: "pending",
        scoredSoFar: 8,
        linked: 8,
        permanentlyFailed: 0,
        cappedForBudget: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await search1TickA.promise;
    });

    // Must NOT leak: search-2's display stays at 0, never jumps to 8.
    expect(screen.getByText("0 of 10 scored so far.")).toBeInTheDocument();
    expect(screen.queryByText("8 of 10 scored so far.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();
  }, 15000);
});

describe("SearchFlow — real polish on the response shape (ticket 2e7ba8a)", () => {
  async function runToDone(result: Record<string, unknown>) {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue(result);

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    // Longer than RTL's 1s default: the first poll tick doesn't fire until
    // POLL_INTERVAL_MS (2000ms) after "running" is entered, same reasoning
    // as the other `{ timeout: 4000 }` waits elsewhere in this file.
    await screen.findByLabelText("Search finished", {}, { timeout: 4000 });
  }

  // Acceptance criterion: a source dead-lettering must be visible, not
  // silently dropped — CLAUDE.md's stated DLQ product behavior, finally
  // reachable end to end through GET /searches/:id's sources[].
  it("shows a failed source visibly, with its error kind, instead of dropping it silently", async () => {
    await runToDone({
      status: "complete",
      searchId: "search-1",
      resumeId: "resume-1",
      scored: 2,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      linked: 2,
      sources: [
        { sourceId: "greenhouse", status: "complete", linkedJobCount: 2 },
        {
          sourceId: "lever",
          status: "failed",
          linkedJobCount: null,
          errorKind: "rate-limited",
          errorMessage: "429 from lever",
        },
      ],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    expect(screen.getByText("lever")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText(/rate-limited/)).toBeInTheDocument();
    expect(screen.getByText(/429 from lever/)).toBeInTheDocument();
    // The healthy source is still shown too — one failure must not swallow
    // the rest of the list.
    expect(screen.getByText("greenhouse")).toBeInTheDocument();
    // Opus review (ticket 2e7ba8a, F4): this comment previously claimed the
    // "greenhouse" source's own status badge also reads "Done" -- it
    // doesn't; a complete source's badge reads "Fetched"
    // (SearchSourceStatusList.tsx's own describeStatus doc comment
    // explains why "Done" was deliberately avoided there). There is no
    // actual "Done" collision in this tree. Checking by role instead of
    // text is still the better practice regardless (it's the real action
    // button, not incidentally-matching text), so the assertion itself is
    // kept -- only the stated reason was wrong.
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  // Acceptance criterion: `degraded: true` must read as a normal completed
  // result with an honest note, never as an error state.
  it("a degraded-but-complete search reads as a normal completion, not an error state", async () => {
    await runToDone({
      status: "complete",
      searchId: "search-1",
      resumeId: "resume-1",
      scored: 7,
      permanentlyFailed: 3,
      cappedForBudget: 0,
      linked: 10,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: true,
    });

    expect(screen.getByText("Search complete (with some failures)")).toBeInTheDocument();
    expect(screen.getByText(/3 jobs failed to score/)).toBeInTheDocument();
    // Never an alert/error panel — this is a finished, usable result.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Acceptance criterion: `cappedForBudget` gets its own honest, distinct
  // treatment, never lumped into the degraded/failure messaging — a run
  // that only hit its budget is fully successful.
  it("gives cappedForBudget its own honest note on a complete search, not the degraded/failure one", async () => {
    await runToDone({
      status: "complete",
      searchId: "search-1",
      resumeId: "resume-1",
      scored: 100,
      permanentlyFailed: 0,
      cappedForBudget: 42,
      linked: 142,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    expect(screen.getByText(/42 more jobs matched but weren't scored/)).toBeInTheDocument();
    // makeEstimate()'s scoreThreshold, above — the honest "why".
    expect(screen.getByText(/100-job budget/)).toBeInTheDocument();
    expect(screen.queryByText("Search complete (with some failures)")).not.toBeInTheDocument();
  });

  // Opus review (ticket 2e7ba8a, F1): the positive test above only proves
  // the note APPEARS when cappedForBudget > 0 -- it never proved the guard
  // is `> 0` and not `>= 0`. Mutation-verified during review: flipping the
  // done-panel guard to `>= 0` passed every other test in the suite, which
  // would have shipped "0 more jobs matched but weren't scored -- this
  // search hit its 100-job budget" on every ordinary successful search --
  // precisely the "don't train the user to read this as a problem"
  // regression this field's own doc comment exists to prevent.
  it("shows no capped-for-budget note on an ordinary successful search (cappedForBudget: 0)", async () => {
    await runToDone({
      status: "complete",
      searchId: "search-1",
      resumeId: "resume-1",
      scored: 10,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      linked: 10,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    expect(screen.queryByText(/matched but weren't scored/)).not.toBeInTheDocument();
  });

  // Opus review (ticket 2e7ba8a, F2): the headline claim -- and the whole
  // stated reason SearchSourceStatusList exists as a NEW component rather
  // than reusing SourceOutcomesList -- is that SearchSourceState can be
  // "pending" mid-flight, a state SourceOutcome can never reach (an
  // estimate call is synchronous and always finishes before returning).
  // Mutation-verified during review: deleting
  // <SearchSourceStatusList sources={phase.sources} /> from the running
  // panel entirely passed every other test in the suite -- the "Fetching"
  // badge and the "Fetched ... jobs linked" detail had zero coverage
  // anywhere. This test exercises exactly the branch that justifies the
  // component's existence.
  it("shows per-source status live in the running panel, including a still-fetching source", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      searchId: "search-1",
      resumeId: "resume-1",
      scoredSoFar: 4,
      linked: 12,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      sourcesSettled: false,
      sources: [
        { sourceId: "greenhouse", status: "complete", linkedJobCount: 12 },
        { sourceId: "lever", status: "pending", linkedJobCount: null },
      ],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Longer than RTL's 1s default -- see runToDone's comment above for why.
    await screen.findByText("lever", {}, { timeout: 4000 });
    expect(screen.getByText("Fetching")).toBeInTheDocument();
    expect(screen.getByText(/still fetching/)).toBeInTheDocument();
    expect(screen.getByText("greenhouse")).toBeInTheDocument();
    expect(screen.getByText("Fetched")).toBeInTheDocument();
    expect(screen.getByText(/12 jobs linked/)).toBeInTheDocument();
  });

  // Same field, mid-flight: the "running" panel must show cappedForBudget
  // live as it climbs, not only once the search finishes.
  it("shows cappedForBudget live while the search is still running", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      searchId: "search-1",
      resumeId: "resume-1",
      scoredSoFar: 4,
      linked: 12,
      permanentlyFailed: 0,
      cappedForBudget: 6,
      sourcesSettled: false,
      sources: [],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Longer than RTL's 1s default -- see runToDone's comment above for why.
    expect(
      await screen.findByText(/6 jobs already matched but deferred/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
  });

  // Optional addition (ticket 2e7ba8a's judgment call): `stalledSince` has
  // no UI treatment anywhere yet, and without one a stuck search looks
  // identical to an ordinary in-progress one forever.
  it("surfaces a stalled notice once GET /searches/:id reports stalledSince", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      searchId: "search-1",
      resumeId: "resume-1",
      scoredSoFar: 4,
      linked: 4,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      sourcesSettled: false,
      sources: [],
      stalledSince: "2026-09-20T00:00:00.000Z",
      outstandingJobIds: ["job-1", "job-2"],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Longer than RTL's 1s default -- see runToDone's comment above for why.
    expect(await screen.findByText(/stuck since/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText(/won't resolve on its own/)).toBeInTheDocument();
  });
});

describe("SearchFlow — estimating phase feedback (ticket 541b55b)", () => {
  it("shows a spinner and wait-time copy while the estimate request is in flight", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("this may take a minute");
    expect(status.querySelector(".spinner")).not.toBeNull();

    // Resolve so the deferred promise doesn't leak into the next test.
    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });
  });
});
