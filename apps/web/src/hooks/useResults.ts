import { useCallback, useEffect, useState } from "react";
import type { GetResumeResultsResponse } from "@app/shared";
import { getResults } from "../api/client";
import { SCORE_FLOOR } from "../constants";

export type ResultsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GetResumeResultsResponse };

/**
 * Fetches the curated results view for a resume — always at `SCORE_FLOOR`
 * (see constants.ts for why this is a client-side constant, not a server
 * default) — and exposes a `refresh` callback so callers can re-pull after
 * a status write (ticket 484889d decision #2: a dismissed job must leave
 * the visible list) or a search run completes.
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
    getResults(resumeId, { minScore: SCORE_FLOOR })
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
