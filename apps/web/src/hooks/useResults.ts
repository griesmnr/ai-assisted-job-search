import { useCallback, useEffect, useState } from "react";
import { type GetResumeResultsResponse, MATCH_SCORE_FLOOR } from "@app/shared";
import { getResults } from "../api/client";

export type ResultsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GetResumeResultsResponse };

/**
 * Fetches the curated results view for a resume — always at
 * `MATCH_SCORE_FLOOR` (git-bug 484889d, review round F4: imported directly
 * from `@app/shared` rather than a local `apps/web` constant now that
 * `main` exports it — see that ticket's own git-bug comments for why a
 * client-side floor, not a server default, is the right layer) — and
 * exposes a `refresh` callback so callers can re-pull after a status write
 * (ticket 484889d decision #2: a dismissed job must leave the visible
 * list) or a search run completes.
 *
 * Source filtering is deliberately NOT a parameter here: decision #3
 * (2026-08-29) is that toggles filter an already-fetched corpus instantly,
 * client-side — this hook fetches the full (floor-applied) result set once
 * per resumeId/refresh and callers narrow by source in memory, never by
 * re-fetching per toggle.
 */
export function useResults(resumeId: string | undefined): {
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
    setState({ status: "loading" });
    getResults(resumeId, { minScore: MATCH_SCORE_FLOOR })
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
  }, [resumeId, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { state, refresh };
}
