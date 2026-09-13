import { useCallback, useEffect, useState } from "react";
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
 */
export function useResults(
  resumeId: string | undefined,
  minScore: number,
): {
  state: ResultsState;
  refresh: () => void;
} {
  const [state, setState] = useState<ResultsState>({ status: "idle" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (resumeId === undefined) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    getResults(resumeId, { minScore, includeDismissed: true })
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
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
  }, [resumeId, minScore, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { state, refresh };
}
