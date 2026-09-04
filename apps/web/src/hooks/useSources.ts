import { useEffect, useState } from "react";
import type { SourceHealth } from "@app/shared";
import { getSources } from "../api/client";

export type SourcesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; sources: SourceHealth[] };

/**
 * `GET /sources` — static, config-only health (no network calls; see
 * apps/api/src/sources/registry.ts's `checkSourceHealth`), returned here
 * exactly as the API sends it (every seeded source, `configured` and
 * `error` included). SourceToggles is what narrows this down to
 * `configured: true` entries before rendering (ticket d480357) — this hook
 * stays a plain, unfiltered passthrough so a future admin/debug view can
 * still use the full list. Distinct from a per-RUN outcome
 * (SourceOutcome/SkippedSource), which only exists once a search has
 * actually been estimated or run — see CostPanel/SearchFlow.
 */
export function useSources(): SourcesState {
  const [state, setState] = useState<SourcesState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    getSources()
      .then((res) => {
        if (!cancelled) setState({ status: "ready", sources: res.sources });
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
  }, []);

  return state;
}
