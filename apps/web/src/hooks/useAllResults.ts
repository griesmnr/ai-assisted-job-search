import { useCallback, useEffect, useState } from "react";
import type { GetAllResultsResponse } from "@app/shared";
import { getAllResults } from "../api/client";

export type AllResultsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: GetAllResultsResponse };

/**
 * Ticket 3f0883f: the cross-resume counterpart to `useResults.ts` --
 * "Already Scored Jobs" needs every job ever scored, for every resume, not
 * just the one active this session. See that hook's own doc comment for
 * the reasoning this one shares (stale-while-revalidate on refresh, so a
 * status write or floor change updates the list in place rather than
 * unmounting it and losing scroll position; `includeDismissed: true` so a
 * dismissed job still comes back, visibly marked, rather than silently
 * missing).
 *
 * Deliberately NOT gated on a `resumeId` the way `useResults` is --
 * that's the entire point of this hook existing separately. It fetches
 * unconditionally, once, on mount (and again on `minScore`/`refresh`),
 * regardless of whether a resume is currently active in this browser tab.
 * An app with nothing ever scored gets back an empty `results` array,
 * which the caller already renders as "No jobs scored yet." -- not an
 * error, not a state this hook needs to special-case.
 */
export function useAllResults(minScore: number): {
  state: AllResultsState;
  refresh: () => void;
} {
  const [state, setState] = useState<AllResultsState>({ status: "idle" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    getAllResults({ minScore, includeDismissed: true })
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
  }, [minScore, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { state, refresh };
}
