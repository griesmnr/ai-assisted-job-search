import { useEffect, useRef, useState } from "react";
import type { EstimateSearchResponse, SearchStatusResponse } from "@app/shared";
import { estimateSearch, getSearchStatus, startSearch } from "../api/client";
import { SourceOutcomesList } from "./SourceOutcomesList";

const POLL_INTERVAL_MS = 2000;

type Phase =
  | { kind: "idle" }
  | { kind: "estimating" }
  | { kind: "estimated"; estimate: EstimateSearchResponse }
  | { kind: "starting"; estimate: EstimateSearchResponse }
  | { kind: "running"; estimate: EstimateSearchResponse; searchId: string; startedAt: number }
  | { kind: "done"; estimate: EstimateSearchResponse; result: SearchStatusResponse }
  | { kind: "error"; message: string };

/**
 * The explicit, cost-previewed search action (decisions #4/#4-revised,
 * git-bug 484889d comments 2026-08-29/09-02/09-03). Two REST calls this
 * drives directly:
 *
 *  - `POST /searches/estimate` — spends nothing, returns `CostEstimate` +
 *    per-source outcomes for what a real run WOULD do right now.
 *  - `POST /searches` — the one endpoint in the whole API allowed to spend
 *    money (apps/api/src/routes/searches.ts's own header comment), fired
 *    only from the explicit "Run search" confirm button below, never
 *    automatically.
 *
 * LIVE SPEND DURING A RUN — HONEST LIMITATION, not silently faked: Nicole
 * asked (2026-09-02 comment) for "what we've spent so far" WHILE a run is
 * in progress, updating as jobs are scored. Audited before building this:
 * `runDemoMatch` (apps/api/src/demo-match.ts) fires every scoring call
 * concurrently after a single cache-warming call and writes ALL results to
 * the database in one batch once the whole batch settles (see the
 * `Promise.allSettled` block and the `db.insert(jobMatches)` right after
 * it) — there is no per-job event, partial DB write, or progress counter
 * exposed anywhere while a run is in flight, and `GET /searches/:id` only
 * ever reports `"pending"` or a final `"complete"`/`"failed"`, never a
 * partial count. Building real incremental live spend would mean
 * restructuring that scoring loop (streaming progress out of
 * `runDemoMatch`, or writing `job_matches` rows one at a time instead of in
 * a batch) — which is apps/api's scoring/matching pipeline, explicitly OUT
 * OF SCOPE for this ticket ("changing anything in apps/api's
 * scoring/matching logic").
 *
 * So: what this component actually shows during `"running"` is an elapsed
 * timer plus the PRE-RUN estimate, clearly labeled as an estimate rather
 * than a live actual total — never presented as if it were incrementing
 * real spend. This is flagged in the ticket report as a real, unfilled gap
 * (not a stub pretending to be the real thing) — a genuine "live spend"
 * feature needs a follow-up ticket against demo-match.ts's scoring loop.
 */
export function SearchFlow({
  resumeId,
  sourceIds,
  onSearchComplete,
}: {
  resumeId: string;
  sourceIds: string[];
  onSearchComplete: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    };
  }, []);

  async function handleEstimate() {
    setPhase({ kind: "estimating" });
    try {
      const estimate = await estimateSearch(resumeId, sourceIds);
      setPhase({ kind: "estimated", estimate });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleConfirmRun(estimate: EstimateSearchResponse) {
    setPhase({ kind: "starting", estimate });
    try {
      const started = await startSearch(resumeId, sourceIds);
      setPhase({ kind: "running", estimate, searchId: started.searchId, startedAt: Date.now() });
      pollRef.current = window.setInterval(
        () => void poll(started.searchId, estimate),
        POLL_INTERVAL_MS,
      );
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function poll(searchId: string, estimate: EstimateSearchResponse) {
    try {
      const result = await getSearchStatus(searchId);
      if (result.status === "pending") return;
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      setPhase({ kind: "done", estimate, result });
      if (result.status === "complete") onSearchComplete();
    } catch (err) {
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="search-flow">
      {phase.kind === "idle" && (
        <button
          type="button"
          onClick={() => void handleEstimate()}
          disabled={sourceIds.length === 0}
        >
          Estimate search cost
        </button>
      )}
      {phase.kind === "estimating" && <p>Getting a cost estimate...</p>}

      {(phase.kind === "estimated" || phase.kind === "starting") && (
        <div className="cost-panel" aria-label="Cost estimate">
          <h3>Before you spend anything</h3>
          <p>{phase.estimate.costEstimateDescription}</p>
          <dl>
            <dt>Jobs that would be scored</dt>
            <dd>{phase.estimate.costEstimate.jobCount}</dd>
            <dt>Estimated cost</dt>
            <dd>${phase.estimate.costEstimate.estimatedCostUsd.toFixed(2)}</dd>
            <dt>Already scored (free, reused)</dt>
            <dd>{phase.estimate.alreadyScored}</dd>
            {phase.estimate.cappedCount > 0 && (
              <>
                <dt>Deferred this run (over the cap)</dt>
                <dd>{phase.estimate.cappedCount}</dd>
              </>
            )}
          </dl>
          <SourceOutcomesList
            sourceOutcomes={phase.estimate.sourceOutcomes}
            skippedSources={phase.estimate.skippedSources}
          />
          <button
            type="button"
            onClick={() => void handleConfirmRun(phase.estimate)}
            disabled={phase.kind === "starting"}
          >
            {phase.kind === "starting" ? "Starting..." : "Run search"}
          </button>
        </div>
      )}

      {phase.kind === "running" && (
        <div className="cost-panel running" aria-label="Search running">
          <h3>Search running...</h3>
          <ElapsedTimer startedAt={phase.startedAt} />
          <p className="cost-caveat">
            Estimated cost for this run: ${phase.estimate.costEstimate.estimatedCostUsd.toFixed(2)}{" "}
            (pre-run estimate — a live running total isn't available yet; see this ticket's notes).
          </p>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="cost-panel done" aria-label="Search finished">
          {phase.result.status === "complete" ? (
            <>
              <h3>Search complete</h3>
              <dl>
                <dt>Newly scored</dt>
                <dd>{phase.result.newlyScored}</dd>
                <dt>Failed (will retry next run)</dt>
                <dd>{phase.result.failed}</dd>
                <dt>Skipped (already scored)</dt>
                <dd>{phase.result.skipped}</dd>
                <dt>This run's estimated cost</dt>
                <dd>${phase.result.costEstimate.estimatedCostUsd.toFixed(2)}</dd>
              </dl>
              <SourceOutcomesList
                sourceOutcomes={phase.result.sourceOutcomes}
                skippedSources={[]}
              />
            </>
          ) : (
            <>
              <h3>Search {phase.result.status}</h3>
              <p>{describeNonCompleteResult(phase.result)}</p>
            </>
          )}
          <button type="button" onClick={() => setPhase({ kind: "idle" })}>
            Done
          </button>
        </div>
      )}

      {phase.kind === "error" && (
        <div role="alert">
          <p>Could not run the search: {phase.message}</p>
          <button type="button" onClick={() => setPhase({ kind: "idle" })}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Renders the non-"complete" branches of `SearchStatusResponse` (see that
 * type's own doc comment in @app/shared for what each status literal
 * means). Written as an exhaustive switch, not a structural `"error" in
 * result` check: `"pending"` genuinely has neither `error` nor `note`, so a
 * structural check type-checks as "else -> .note" and then fails to
 * compile against `"pending"` specifically (caught live by `tsc -b` during
 * this ticket's own verification) — a switch on the literal makes every
 * branch's available fields exact, and TypeScript flags a truly missing
 * case at compile time via the `never` fallthrough rather than at runtime.
 */
function describeNonCompleteResult(
  result: Exclude<SearchStatusResponse, { status: "complete" }>,
): string {
  switch (result.status) {
    case "pending":
      return "Still running.";
    case "failed":
      return result.error ?? "Failed with no further detail.";
    case "complete-details-unavailable":
    case "incomplete":
      return result.note;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const seconds = Math.floor((now - startedAt) / 1000);
  return <p>Elapsed: {seconds}s</p>;
}
