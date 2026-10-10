import { useCallback, useEffect, useRef, useState } from "react";
import type { GetResumeResultsResponse } from "@app/shared";
import { getResults } from "../api/client";

export type ResultsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GetResumeResultsResponse };

/**
 * Fetches the curated results view for a resume, at the caller-supplied
 * `minScore` floor — and exposes a `refresh` callback so callers can
 * re-pull after a status write (ticket 484889d decision #2: a dismissed job
 * must leave the visible list) or a search run completes.
 *
 * `minScore` used to be hardcoded to `MATCH_SCORE_FLOOR` (git-bug 484889d,
 * review round F4). Ticket ffbf9fb made it a real parameter, driven by
 * App.tsx's user-adjustable `scoreFloor` state (default `MATCH_SCORE_FLOOR`,
 * unchanged behavior until the user actually moves the slider) — it's
 * included in this effect's dependency array, so moving the slider
 * re-fetches with the new floor exactly like a `resumeId` change or an
 * explicit `refresh()` does. `GET /resumes/:id/results`'s `?minScore=` was
 * already this flexible server-side (apps/api/src/routes/resumes.ts) — this
 * hook (and the UI control that drives it) were the only missing piece.
 *
 * Source filtering is deliberately NOT a parameter here: decision #3
 * (2026-08-29) is that toggles filter an already-fetched corpus instantly,
 * client-side — this hook fetches the full (floor-applied) result set once
 * per resumeId/minScore/refresh and callers narrow by source in memory,
 * never by re-fetching per toggle. The score floor is different in kind
 * (ticket ffbf9fb's own scope note): re-fetching at a new floor can surface
 * jobs the server never sent at the old floor at all, which a client-side
 * filter cannot do.
 *
 * `includeDismissed: true` (ticket bec2f98): this single fetch feeds BOTH
 * "Results from this search" and "Already Scored Jobs" (App.tsx), and both
 * need a dismissed job back with its real status rather than silently
 * missing — Nicole: "I think that should always happen, even ones that
 * have already been dismissed. They should show up in the search results,
 * but they can say that they've already been dismissed."
 *
 * A REFRESH (after a status write, or a `minScore` change) does NOT reset
 * `state` to "loading" if data is already showing — real bug Nicole hit
 * dogfooding: every `refresh()` used to force `status: "loading"`
 * unconditionally, which made every caller's `status === "ready"` render
 * check briefly go false, unmounting the whole results list until the
 * refetch resolved — "it flashes... the page behaves a little weirdly", and
 * on the "Already Scored Jobs" tab specifically, that unmount/remount reset
 * the page's scroll position back to the top on every single status click
 * (Dismiss, Save, ...). Staying on the OLD "ready" data until the NEW data
 * actually arrives (a stale-while-revalidate read, not a fresh loading
 * state) means the DOM subtree never unmounts for a refresh — only the very
 * first fetch for a given `resumeId` (starting from "idle") shows "loading".
 * This carries over cleanly to a `minScore` change (ticket ffbf9fb): moving
 * the slider updates the list in place rather than flashing it away.
 *
 * `searchId` (ticket 9e5fcf3): in the dependency array for the same reason
 * `minScore` is -- App.tsx sets it the moment a search completes
 * (`handleSearchComplete`), scoping "Results from this search" to that one
 * search's own links rather than every search this resume has ever run.
 * `undefined` means "no search scope" (every match for this resume, the
 * pre-9e5fcf3 behavior) -- the state before any search has completed THIS
 * session (App.tsx's `lastSearchId` starts `undefined` and is never
 * persisted; see its own comment for why not).
 *
 * CORRECTED (ticket 9e5fcf3 review round, finding C1): an earlier version of
 * this paragraph argued that `searchId` is "always defined" by the time
 * App.tsx actually renders this hook's data for "Results from this search",
 * because `hasFreshSearchResults` never flips true without a real `searchId`
 * in hand. That is true of the PROP `handleSearchComplete` passes in, but it
 * is a claim about the prop, not about which `searchId` the DATA in `state`
 * was actually fetched for -- and that gap is exactly what let a real bug
 * through. `handleSearchComplete` batches `setLastSearchId(new)`,
 * `refresh()`, and `setHasFreshSearchResults(true)` into one render. Without
 * the `fetchedForRef` guard below, the stale-while-revalidate design two
 * paragraphs up -- entirely correct for `minScore`/`refresh()`, where the
 * OLD "ready" data is still a valid answer to the SAME question -- also
 * applied to a `searchId` CHANGE, where the old data is a valid answer to a
 * DIFFERENT question (the previous search, or no search at all). The
 * results section would flip visible already showing the last `getResults`
 * payload -- every job this resume has ever accumulated, if the previous
 * fetch was unscoped -- for one real round trip, then silently correct
 * itself once the newly-scoped fetch landed. That window is exactly John's
 * reported bug, reproduced at the worst possible moment: the instant the new
 * completion signal (ticket 9e5fcf3 part (a)) pulls his attention to the
 * panel.
 *
 * `fetchedForRef` fixes this by tracking which `searchId` the CURRENT
 * "ready" state actually answers, so a `searchId` CHANGE (unlike a
 * `minScore` change or a plain `refresh()`) is treated as a genuine scope
 * change -- "loading" is shown until the newly-scoped data arrives, instead
 * of rendering the old scope's data and correcting it a moment later.
 * `freshResultsCount` (App.tsx) already treats this "ready but not for the
 * right search" window as "nothing to report yet" -- it derives straight
 * from `resultsState.status === "ready"`, so a `status: "loading"` window
 * here makes the "View N results" button withhold itself exactly as its own
 * doc comment already says it does while data hasn't resolved, no change
 * needed there.
 *
 * WHERE THE MISMATCH CHECK RUNS IS LOAD-BEARING, and the record of how we
 * got here is worth more than the conclusion, because two different wrong
 * explanations were written down before the right one.
 *
 * C1's review comment prescribed putting the comparison INSIDE the effect
 * below: `setState((prev) => prev.status === "ready" &&
 * fetchedForRef.current === searchId ? prev : {status:"loading"})`, with the
 * ref write immediately after. That snippet does not merely lag -- IT NEVER
 * CLEARS THE STALE DATA AT ALL. `setState` with an updater function defers
 * the updater to render time, while the ref write beside it runs eagerly, so
 * by the time the updater executes `fetchedForRef.current` already equals the
 * new `searchId`, the guard returns `prev`, and the old payload is kept
 * forever. Verified both ways: the prescribed snippet fails this file's C1
 * regression test, the version below passes it, and neutralising the
 * derivation fails it again. (The reviewer identified this itself on
 * re-review and corrected its own prescription.)
 *
 * An earlier version of THIS comment then claimed the regression test had
 * caught a one-commit lag. It had not, and no jsdom test can: `act()` and
 * `findBy*` flush passive effects before any assertion runs, so an
 * effect-based guard with the ref write moved into the success callback
 * actually PASSES that test. What the test proves is narrower -- that the
 * shipped code never shows the previous search's results -- and that is
 * enough for the acceptance criterion.
 *
 * The real argument for render-time placement is about the BROWSER, not the
 * test: passive effects are allowed to run after paint, so an effect-based
 * correction can let a real user see one stale frame that jsdom cannot
 * observe. `handleSearchComplete` batches `setLastSearchId(new)` +
 * `refresh()` + `setHasFreshSearchResults(true)` into one commit, which is
 * the same commit that reveals the "Search complete" heading -- exactly the
 * instant John's report is about, when the new signal pulls attention to the
 * panel. Computing the mismatch during render means there is no such frame
 * to see, rather than one that corrects itself.
 *
 * The fix actually implemented below computes the mismatch SYNCHRONOUSLY
 * AT RENDER TIME instead -- comparing the prop (`searchId`, already fresh
 * this render) against a plain ref (`fetchedForRef`, deliberately read
 * here and only EVER written inside the fetch's success callback, so it
 * always lags one real network round trip behind, never a hook-internal
 * render/effect cycle). Because this comparison is a pure computation over
 * values already available during render -- no `setState` call, no waiting
 * for an effect -- the SAME commit that shows the new `searchId` prop also
 * computes and returns the corrected `{status:"loading"}`, with no second
 * commit needed to fix it. The regression test above was re-run against
 * this version and passes with no timing dependency.
 */
export function useResults(
  resumeId: string | undefined,
  minScore: number,
  searchId: string | undefined,
): {
  state: ResultsState;
  refresh: () => void;
} {
  const [state, setState] = useState<ResultsState>({ status: "idle" });
  const [refreshToken, setRefreshToken] = useState(0);
  // Ticket 9e5fcf3 review round, finding C1: which `searchId` the CURRENT
  // "ready" `state.data` actually answers -- see this function's own doc
  // comment above for the bug this closes and for why the comparison that
  // reads this must happen at RENDER time (below, in `effectiveState`), not
  // inside the effect. Written ONLY in the fetch's success callback -- not
  // at the top of the effect, and not on every effect run -- specifically
  // so it keeps naming the PREVIOUS successful fetch's scope for the entire
  // window a new one is in flight, which is exactly the signal
  // `effectiveState` needs to detect "the data on screen is for a
  // different search than the one now being asked about."
  // INVARIANT, and the real reason reading this during render is safe:
  // NEVER write this ref anywhere but alongside the `setState` in the fetch
  // success path below. A ref mutation can only be read by a committed render
  // the renderer never knew to redo if it happens UNPAIRED with a state
  // update; pairing every write with `setState({status:"ready", data})`
  // guarantees a re-render that re-reads it. That holds even under concurrent
  // rendering, so this is not merely "safe until someone adds transitions"
  // (there are none in apps/web/src today -- no useTransition,
  // startTransition, useDeferredValue, Suspense or lazy, checked).
  //
  // Two StrictMode corollaries, both load-bearing: the double RENDER is
  // harmless because the read is pure (nothing writes during render, so both
  // passes compute the same `effectiveState`), and the double EFFECT on mount
  // is harmless because the write sits inside `if (!cancelled)`, so the
  // discarded first run cannot write the ref.
  const fetchedForRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (resumeId === undefined) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    getResults(resumeId, { minScore, includeDismissed: true, searchId })
      .then((data) => {
        if (!cancelled) {
          setState({ status: "ready", data });
          fetchedForRef.current = searchId;
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resumeId, minScore, searchId, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  // Ticket 9e5fcf3 review round, finding C1: the actual fix, computed fresh
  // every render rather than inside the effect above -- see the doc comment
  // on this function for why that placement is load-bearing. `state` here
  // is whatever the LAST commit left it at (unchanged by this render, since
  // reading it doesn't write it); `searchId` is THIS render's live prop.
  // When they disagree -- the common case being the one render that just
  // adopted a new `searchId` before its own effect has had a chance to
  // fetch anything for it -- the stale "ready" data must not be returned as
  // if it still answered the current question. `minScore`/`resumeId`
  // mismatches are deliberately NOT checked here: moving the score floor
  // keeps the existing stale-while-revalidate behavior (ticket ffbf9fb,
  // still correct -- the old data is a valid, if outdated, answer to the
  // SAME search), and a `resumeId` mismatch was already masked in practice
  // by `hasFreshSearchResults` resetting on every resume change (App.tsx) --
  // widening this check to cover it is a real option but out of this
  // ticket's scope, since nothing it fixes is currently reachable.
  const effectiveState: ResultsState =
    state.status === "ready" && fetchedForRef.current !== searchId ? { status: "loading" } : state;

  return { state: effectiveState, refresh };
}
