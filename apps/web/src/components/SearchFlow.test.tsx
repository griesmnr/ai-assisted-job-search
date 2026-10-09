// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EstimateSearchResponse, SourceOutcome } from "@app/shared";
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
// Ticket bf2dd0a: defaults to a rejection, mirroring what the REAL
// `getEstimateProgress` sees for the vast majority of test cases (no
// server, so no `estimateRequestId` was ever actually `start()`-ed) --
// SearchFlow's poll loop treats that as "nothing to show yet" and swallows
// it (see `startEstimateProgressPolling`'s own comment), so this default
// is silent/inert for every test that doesn't care about progress display.
// `vi.clearAllMocks()` (afterEach below) resets call history, not this
// implementation, so it holds for the whole file unless a test overrides it
// with its own `mockResolvedValueOnce`/`mockResolvedValue`.
const getEstimateProgress = vi.fn().mockRejectedValue(new Error("no progress tracked in test"));

vi.mock("../api/client", () => ({
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
  getEstimateProgress: (...args: unknown[]) => getEstimateProgress(...args),
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    expect(screen.getByLabelText("Cost estimate")).toBeInTheDocument();

    // Selection changes AFTER the estimate has already landed and is on
    // screen — e.g. the user toggles a source having seen the price.
    rerender(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Get estimate" })).toBeInTheDocument();
    });

    // Same hole, resumeId side: re-show an estimate, then change resumeId.
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    rerender(<SearchFlow resumeId="resume-2" sourceIds={["a"]} onSearchComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByLabelText("Cost estimate")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Get estimate" })).toBeInTheDocument();
    });
  });

  it("the race: sourceIds change WHILE the estimate request is still in flight never leaves an actionable estimate bound to the stale selection", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    // Request is now in flight (phase === "estimating"); the mocked
    // estimateSearch call captured the selection at click time, ["a", "b"].
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["a", "b"],
      undefined,
      expect.any(String),
    );
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
      expect(screen.getByRole("button", { name: "Get estimate" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["a", "b"],
      undefined,
      expect.any(String),
    );
    await screen.findByText(/Getting a cost estimate/);

    // WHILE still in flight, resumeId changes (e.g. a different resume was
    // selected/uploaded).
    rerender(<SearchFlow resumeId="resume-2" sourceIds={["a", "b"]} onSearchComplete={() => {}} />);

    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Get estimate" })).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["a", "b"],
      { titleInclude: ["backend"] },
      expect.any(String),
    );

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
      expect(screen.getByRole("button", { name: "Get estimate" })).toBeInTheDocument();
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
      failed: 0,
      sourcesSettled: false,
      sources: [],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
      failed: 0,
      sourcesSettled: false,
      sources: [],
    });

    const { rerender } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a", "b"]} onSearchComplete={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    await screen.findByRole("button", { name: "Starting..." });
    expect(startSearch).toHaveBeenCalledWith("resume-1", ["a", "b"], undefined);

    rerender(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    expect(screen.getByRole("button", { name: "Starting..." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Get estimate" })).not.toBeInTheDocument();

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
        failed: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      })
      .mockResolvedValueOnce({
        status: "pending",
        scoredSoFar: 7,
        linked: 10,
        failed: 0,
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
        failed: 0,
        linked: 10,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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

  // Ticket 4146881: Nicole, live, watching a real search: "I did just see
  // four of four of four scored so far, and then it went up to five of
  // seven." The estimate's `jobCount` was 8 the whole time — the denominator
  // only LOOKED like it shrank-then-grew because it was reading `linked`
  // (a live, partial, still-climbing count of jobs linked so far) straight
  // off `GET /searches/:id`, rather than pinning to the estimate's total
  // until the real total genuinely exceeds it. This test pins that exact
  // scenario byte for byte: `linked` climbs 4 -> 7 across two poll ticks
  // while `estimate.costEstimate.jobCount` stays 8 throughout, and the
  // denominator shown must be 8 at every tick — never 4, never 7 — proving
  // the fix (`Math.max(jobCount, linked)` at the render site).
  it("pins the reported denominator regression: linked climbing 4 -> 7 must render '8', not '4' then '7' (ticket 4146881)", async () => {
    estimateSearch.mockResolvedValue(
      makeEstimate({
        costEstimate: {
          jobCount: 8,
          estimatedInputTokens: 1000,
          estimatedCacheReadTokens: 0,
          estimatedCacheCreationTokens: 0,
          estimatedOutputTokens: 200,
          estimatedCostUsd: 0.42,
          maxCostUsd: 0.42,
          probableCostUsd: 0.3,
          basis: "bootstrap",
        },
      }),
    );
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });

    // Tick 1: one source has landed — `linked` (4) happens to equal
    // `scoredSoFar` (4), which is exactly the "N of N" shape that read as
    // "100% done" to Nicole. Tick 2: a second source lands, `linked` grows
    // to 7 — still below the estimate's 8, but the old (bare-`linked`)
    // behavior would have jumped the denominator itself from 4 to 7,
    // reading as regressing progress. Tick 3: the run completes.
    getSearchStatus
      .mockResolvedValueOnce({
        status: "pending",
        scoredSoFar: 4,
        linked: 4,
        failed: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      })
      .mockResolvedValueOnce({
        status: "pending",
        scoredSoFar: 5,
        linked: 7,
        failed: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      })
      .mockResolvedValue({
        status: "complete",
        searchId: "search-1",
        resumeId: "resume-1",
        scored: 8,
        failed: 0,
        linked: 8,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await screen.findByLabelText("Search running");
    expect(screen.getByText("0 of 8 scored so far.")).toBeInTheDocument();

    // First tick: `linked` (4) equals `scoredSoFar` (4) — the exact "N of
    // N" moment Nicole saw. Must read "4 of 8", never "4 of 4".
    await waitFor(
      () => {
        expect(screen.getByText("4 of 8 scored so far.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByText("4 of 4 scored so far.")).not.toBeInTheDocument();

    // Second tick: `linked` grows to 7. Must still read "5 of 8" — the
    // denominator must not visibly move at all, let alone jump to 7.
    await waitFor(
      () => {
        expect(screen.getByText("5 of 8 scored so far.")).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByText("5 of 7 scored so far.")).not.toBeInTheDocument();

    // Third tick completes the run.
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
      failed: number;
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
        failed: 0,
        linked: 10,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
        failed: 0,
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
        failed: 0,
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
  // same out-of-order shape, but diverges `linked` instead of `scoredSoFar`
  // to actually exercise that guard.
  //
  // Ticket d37511b removed `cappedForBudget`, which this test originally
  // diverged ALONGSIDE `linked` (same out-of-order shape, same guard) —
  // that half is gone with the field; `linked`'s own guard is still real
  // and still needs its own coverage, so the test survives under its own
  // name.
  it("an out-of-order (slower, stale) poll response never regresses linked backward (ticket 2e7ba8a review, F3)", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });

    type PendingTick = {
      status: string;
      scoredSoFar: number;
      linked: number;
      failed: number;
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
        scored: 20,
        failed: 0,
        linked: 20,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
    // FASTER response — genuinely-progressed, higher linked count.
    await act(async () => {
      tickB.resolve({
        status: "pending",
        scoredSoFar: 10,
        linked: 18,
        failed: 0,
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

    // NOW resolve the FIRST (earlier-fired) tick — the SLOWER, now-STALE
    // response, carrying a LOWER linked count than what's on screen.
    await act(async () => {
      tickA.resolve({
        status: "pending",
        scoredSoFar: 4,
        linked: 9,
        failed: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-1",
        resumeId: "resume-1",
      });
      await tickA.promise;
    });

    // Must NOT regress — `linked` stays at 18.
    await waitFor(() => {
      expect(screen.getByText("10 of 18 scored so far.")).toBeInTheDocument();
    });
    expect(screen.queryByText("10 of 9 scored so far.")).not.toBeInTheDocument();
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
      failed: number;
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
        failed: 0,
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
        failed: 0,
        sourcesSettled: false,
        sources: [],
        searchId: "search-2",
        resumeId: "resume-1",
      });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    // Search 1: estimate, confirm, running.
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
        failed: 0,
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
      failed: 0,
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
      failed: 3,
      linked: 10,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: true,
    });

    expect(screen.getByText("Search complete (with some failures)")).toBeInTheDocument();
    // Ticket d37511b, amended on adversarial review: the first draft of
    // this note dropped the count entirely, which review correctly flagged
    // as a NEW regression -- without it, "Scored: 7" / "Total jobs found:
    // 10" plus "some jobs failed" leaves the 3 missing inferable only by
    // subtraction, and is indistinguishable from a spend-guard stall.
    // `failed`/`linked` are plain fields on the real contract (not a
    // revived cap), so the count belongs back in the note. What stays
    // removed is specifically the "Permanently failed" dt/dd row's own
    // LABEL -- the exact wording Jay found confusing -- not the number.
    expect(screen.getByText(/3 of 10 jobs couldn't be scored/)).toBeInTheDocument();
    expect(screen.queryByText("Permanently failed")).not.toBeInTheDocument();
    // Never an alert/error panel — this is a finished, usable result.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Ticket d37511b: removed the "Deferred this run (over the cap)" /
  // "Permanently failed" dt/dd rows and the cappedForBudget note (Jay's
  // testing found both incomprehensible; the mechanism behind them is gone
  // too — see matching/pipeline.ts's "EVERY CANDIDATE GETS SCORED" comment).
  // This replaces the two tests that used to prove `cappedForBudget`'s note
  // appeared/didn't appear at the right threshold — there is no field left
  // to thread through either branch, so the only thing left worth pinning
  // is that none of the removed vocabulary ever renders again, regardless
  // of how the search actually went.
  it("never renders the removed cap/deferral vocabulary, on a clean search or a degraded one", async () => {
    await runToDone({
      status: "complete",
      searchId: "search-1",
      resumeId: "resume-1",
      scored: 7,
      failed: 3,
      linked: 10,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: true,
      // NOT part of `SearchStatusResponse` any more (`result` is typed
      // `Record<string, unknown>` here precisely so this compiles) —
      // included anyway so this test still means something: if the old
      // `phase.result.cappedForBudget > 0 && <p>...</p>` branch were ever
      // reintroduced into SearchFlow.tsx, a redelivered/stale server
      // response carrying this field is exactly what would make it fire,
      // and this fixture reproduces that shape. Without it, the assertions
      // below would pass vacuously merely because the field is typed away,
      // not because the UI genuinely never renders it.
      cappedForBudget: 42,
      scoreThreshold: 100,
    });

    for (const removed of [
      "Deferred this run",
      "Permanently failed",
      /matched but weren't scored/,
      /already matched but deferred/,
      /-job budget/,
    ]) {
      expect(screen.queryByText(removed)).not.toBeInTheDocument();
    }
  });

  // REMOVED (ticket d37511b): "gives cappedForBudget its own honest note"
  // and "shows no capped-for-budget note" used to live here, proving the
  // cap note's `> 0` guard was exact in both directions. `cappedForBudget`
  // is gone from the wire entirely (see @app/shared's `SearchStatusResponse`)
  // and SearchFlow.tsx no longer reads it, so there is no guard left to
  // pin — the replacement test above ("never renders the removed
  // cap/deferral vocabulary...") is what covers this surface now.

  // Opus review (ticket 2e7ba8a, F2): the headline claim -- and the whole
  // stated reason SearchSourceStatusList exists as a NEW component rather
  // than reusing SourceOutcomesList -- is that SearchSourceState can be
  // "pending" mid-flight, a state SourceOutcome can never reach (an
  // estimate call is synchronous and always finishes before returning).
  // Mutation-verified during review: deleting
  // <SearchSourceStatusList sources={phase.sources} /> from the running
  // panel entirely passed every other test in the suite -- the "Fetching"
  // badge and the "Fetched ... jobs found" detail had zero coverage
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
      failed: 0,
      sourcesSettled: false,
      sources: [
        { sourceId: "greenhouse", status: "complete", linkedJobCount: 12 },
        { sourceId: "lever", status: "pending", linkedJobCount: null },
      ],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Longer than RTL's 1s default -- see runToDone's comment above for why.
    await screen.findByText("lever", {}, { timeout: 4000 });
    expect(screen.getByText("Fetching")).toBeInTheDocument();
    expect(screen.getByText(/still fetching/)).toBeInTheDocument();
    expect(screen.getByText("greenhouse")).toBeInTheDocument();
    expect(screen.getByText("Fetched")).toBeInTheDocument();
    expect(screen.getByText(/12 jobs found/)).toBeInTheDocument();
  });

  // REMOVED (ticket d37511b): "shows cappedForBudget live while the search
  // is still running" used to live here. `Phase.running` no longer carries
  // a `cappedForBudget` field at all (SearchFlow.tsx), so there is nothing
  // left to show live.

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
      failed: 0,
      sourcesSettled: false,
      sources: [],
      stalledSince: "2026-09-20T00:00:00.000Z",
      outstandingJobIds: ["job-1", "job-2"],
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

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

describe("SearchFlow — estimate progress feedback (ticket bf2dd0a)", () => {
  it("shows incremental per-source progress once the first progress poll lands", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);
    // The estimate itself never resolves during this test -- the progress
    // side channel is what this test is exercising, not the terminal
    // "estimated" panel.
    getEstimateProgress.mockResolvedValue({
      requestId: "does-not-matter-to-the-assertion",
      total: 3,
      completed: 1,
      sources: [
        { sourceId: "usajobs", status: "done" },
        { sourceId: "greenhouse", status: "pending" },
        { sourceId: "lever", status: "pending" },
      ],
      done: false,
    });

    render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["usajobs", "greenhouse", "lever"]}
        onSearchComplete={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    // `startEstimateProgressPolling` fires its first poll synchronously
    // (not on the next 2s interval tick — see that function's own comment),
    // so this needs no `waitFor` timeout extension the way a genuine
    // interval-tick assertion would.
    await screen.findByText(/1 of 3 sources checked/);
    // Still the plain wait-time sentence underneath, not replaced by it.
    expect(screen.getByRole("status")).toHaveTextContent("this may take a minute");

    // The SAME id drives both calls -- this is the whole mechanism: the
    // frontend mints one id, hands it to the blocking POST, and polls the
    // progress side channel under that identical id.
    const requestId = (estimateSearch.mock.calls[0] as unknown[])[3] as string;
    expect(typeof requestId).toBe("string");
    expect(requestId.length).toBeGreaterThan(0);
    expect((getEstimateProgress.mock.calls[0] as unknown[])[0]).toBe(requestId);

    // Resolve so the deferred promise doesn't leak into the next test.
    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });
  });

  it("treats a progress-poll rejection (no tracked record) as 'nothing to show', not an error", async () => {
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);
    getEstimateProgress.mockRejectedValue(new Error("404: not tracked"));

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    const status = await screen.findByRole("status");
    // The plain spinner/copy is unaffected -- no "N of M" text ever
    // appears, and critically the phase never flips to "error" just
    // because this optional side channel came back empty.
    expect(status).toHaveTextContent("this may take a minute");
    expect(screen.queryByText(/sources checked/)).not.toBeInTheDocument();

    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });
    // Proves the phase reached "estimated", not "error" -- a progress-poll
    // rejection alone must never surface as a failed estimate.
    await screen.findByRole("button", { name: "Run search" });
  });
});

// Ticket 88f11d7 (Nicole: "I don't think that we should allow a change of
// resume while a search is in progress"): App.tsx needs to know when a
// REAL run (as opposed to a mere estimate) is in progress, to disable the
// collapsed bar's action button -- "Edit" exactly as much as "Change" --
// for exactly that window.
describe("SearchFlow — onRunningChange (ticket 88f11d7)", () => {
  it("reports false on mount, with no run in progress", () => {
    const onRunningChange = vi.fn();
    render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a"]}
        onSearchComplete={() => {}}
        onRunningChange={onRunningChange}
      />,
    );

    expect(onRunningChange).toHaveBeenCalledWith(false);
    expect(onRunningChange).not.toHaveBeenCalledWith(true);
  });

  it("does NOT report true while merely estimating -- only a real run counts", async () => {
    const onRunningChange = vi.fn();
    const { promise, resolve } = deferred<EstimateSearchResponse>();
    estimateSearch.mockReturnValue(promise);

    render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a"]}
        onSearchComplete={() => {}}
        onRunningChange={onRunningChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("status");

    expect(onRunningChange).not.toHaveBeenCalledWith(true);

    await act(async () => {
      resolve(makeEstimate());
      await promise;
    });
    await screen.findByRole("button", { name: "Run search" });
    // Still not true -- an "estimated" cost preview, not yet confirmed,
    // is not a run in progress either.
    expect(onRunningChange).not.toHaveBeenCalledWith(true);
  });

  it("reports true the moment 'Run search' is clicked (starting), and stays true while running", async () => {
    const onRunningChange = vi.fn();
    estimateSearch.mockResolvedValue(makeEstimate());
    const { promise: startPromise, resolve: resolveStart } = deferred<{
      searchId: string;
      status: "pending";
      skippedSources: string[];
    }>();
    startSearch.mockReturnValue(startPromise);
    getSearchStatus.mockResolvedValue({
      status: "pending",
      scoredSoFar: 0,
      linked: 1,
      sources: [],
      stalledSince: undefined,
    });

    render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a"]}
        onSearchComplete={() => {}}
        onRunningChange={onRunningChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // "starting": the POST /searches request is in flight.
    await waitFor(() => expect(onRunningChange).toHaveBeenLastCalledWith(true));

    await act(async () => {
      resolveStart({ searchId: "search-1", status: "pending", skippedSources: [] });
      await startPromise;
    });

    // "running": still true, now polling.
    await screen.findByRole("heading", { name: "Search running..." });
    expect(onRunningChange).toHaveBeenLastCalledWith(true);
  });

  it("reports false again once the search completes", async () => {
    const onRunningChange = vi.fn();
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "complete",
      scored: 1,
      failed: 0,
      linked: 1,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    render(
      <SearchFlow
        resumeId="resume-1"
        sourceIds={["a"]}
        onSearchComplete={() => {}}
        onRunningChange={onRunningChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });

    await screen.findByRole("heading", { name: "Search complete" });
    expect(onRunningChange).toHaveBeenLastCalledWith(false);
  });
});

describe("SearchFlow — SourceOutcomesList text changes (ticket bd37f8a)", () => {
  it("renders 'matched your job titles' text instead of 'found' and 'passed filtering'", async () => {
    const outcome: SourceOutcome = {
      dataSource: "greenhouse",
      status: "ok",
      jobsFound: 127,
      skippedCount: 115, // 127 - 12 matched = 115 filtered out
      skipRate: 0.906, // 115/127
      survivedFilter: 12,
      excludedForMissingWorkArrangement: 0,
      boardCoverage: [],
    };
    estimateSearch.mockResolvedValue(
      makeEstimate({
        sourceOutcomes: [outcome],
      }),
    );

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    // The new text should appear in the source outcomes list
    expect(screen.getByText(/matched your job titles/)).toBeInTheDocument();
    // The old text should not appear - check that "passed filtering" is NOT in the document
    expect(screen.queryByText(/passed filtering/)).not.toBeInTheDocument();
    // The old "found" text should also not appear
    expect(screen.queryByText(/found/)).not.toBeInTheDocument();
  });

  it("renders '0 matched your job titles' for a source with no matches", async () => {
    const outcome: SourceOutcome = {
      dataSource: "greenhouse",
      status: "ok",
      jobsFound: 300,
      skippedCount: 300, // all jobs filtered out
      skipRate: 1, // 100% skip rate
      survivedFilter: 0,
      excludedForMissingWorkArrangement: 0,
      boardCoverage: [],
    };
    estimateSearch.mockResolvedValue(
      makeEstimate({
        sourceOutcomes: [outcome],
      }),
    );

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    // The zero case should show the full text with 0
    expect(screen.getByText(/matched your job titles/)).toBeInTheDocument();
    // Should find the complete "0 matched your job titles" in the source outcomes
    const sourceOutcomeSection = screen.getByText(/greenhouse/).closest("li");
    expect(sourceOutcomeSection?.textContent).toMatch(/0 matched your job titles/);
  });
});

describe("SearchFlow — cost panel 'Already scored' visibility (ticket 83654fd)", () => {
  it("does not render the 'Already scored' row when alreadyScored is 0", async () => {
    estimateSearch.mockResolvedValue(makeEstimate({ alreadyScored: 0 }));

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    // The row with "Already scored" should not appear at all
    expect(screen.queryByText("Already scored (free, reused)")).not.toBeInTheDocument();
  });

  it("renders the 'Already scored' row when alreadyScored is greater than 0", async () => {
    estimateSearch.mockResolvedValue(makeEstimate({ alreadyScored: 5 }));

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    // The row with "Already scored" should appear with the correct value
    expect(screen.getByText("Already scored (free, reused)")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("renders no orphaned <dt> or <dd> for 'Already scored' when alreadyScored is 0", async () => {
    estimateSearch.mockResolvedValue(makeEstimate({ alreadyScored: 0 }));

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    const dlElement = screen
      .getByRole("button", { name: "Run search" })
      .closest(".cost-panel")
      ?.querySelector("dl");
    expect(dlElement).toBeTruthy(); // Must find the dl element
    if (!dlElement) return;

    // Both <dt> and <dd> must be absent when alreadyScored is 0
    const dtElements = Array.from(dlElement.querySelectorAll("dt"));
    const dtLabels = dtElements.map((dt) => dt.textContent);

    expect(dtLabels).not.toContain("Already scored (free, reused)");
    expect(screen.queryByText("Already scored (free, reused)")).not.toBeInTheDocument();
  });
});
