import { useCallback, useEffect, useState } from "react";
import type { ListResumesResponse } from "@app/shared";
import { listResumes } from "../api/client";

export type ResumesListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ListResumesResponse };

/**
 * Ticket 303cff0 ("My Resumes" tab). Mirrors `useAllResults.ts`'s shape:
 * stale-while-revalidate on `refresh()` (keeps showing the last-known list
 * while a new one loads, rather than flashing back to a loading state),
 * fetched unconditionally on mount regardless of whether a resume is
 * active this session.
 */
export function useResumesList(): {
  state: ResumesListState;
  refresh: () => void;
} {
  const [state, setState] = useState<ResumesListState>({ status: "idle" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    listResumes()
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
  }, [refreshToken]);

  const refresh = useCallback(() => setRefreshToken((t) => t + 1), []);

  return { state, refresh };
}
