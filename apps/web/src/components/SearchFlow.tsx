import { useEffect, useRef, useState } from "react";
import type { EstimateSearchResponse, SearchStatusResponse } from "@app/shared";
import { estimateSearch, getSearchStatus, startSearch } from "../api/client";
import { SourceOutcomesList } from "./SourceOutcomesList";

const POLL_INTERVAL_MS = 2000;

type Phase =
  | { kind: "idle" }
  | { kind: "estimating" }
  | {
      kind: "estimated";
      estimate: EstimateSearchResponse;
      // Snapshot of what the estimate was actually computed for (review
      // round, F1, git-bug 484889d): `resumeId`/`sourceIds` are captured
      // HERE, at the moment the estimate response lands, rather than read
      // live from props when "Run search" is later clicked. `SourceToggles`
      // and `ResumeInput` stay interactive while this panel is showing, so
      // props can legitimately change between "estimate computed" and
      // "user clicks confirm" — e.g. toggling on two more sources after
      // seeing a one-source estimate. Firing `startSearch` from live props
      // would spend money on a selection the user never saw a price for,
      // which is exactly the failure this whole cost-preview feature exists
      // to prevent. `handleConfirmRun` uses this snapshot, never the
      // `resumeId`/`sourceIds` props, for that call.
      resumeId: string;
      sourceIds: string[];
    }
  | {
      kind: "starting";
      estimate: EstimateSearchResponse;
      resumeId: string;
      sourceIds: string[];
    }
  | {
      kind: "running";
      estimate: EstimateSearchResponse;
      searchId: string;
      startedAt: number;
      // Ticket 1998875: `GET /searches/:id`'s live "pending" count of jobs
      // successfully scored so far this run. Starts at 0 the moment
      // `"running"` is entered and is updated on every poll tick — see
      // `poll()` below.
      scoredSoFar: number;
    }
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
 * LIVE PROGRESS DURING A RUN (ticket 1998875, split from this ticket's own
 * F5 gap): Nicole asked (2026-09-02 comment on 484889d) for "what we've
 * spent so far" WHILE a run is in progress, updating as jobs are scored.
 * The audit done for 484889d found nothing in the API to show — `GET
 * /searches/:id` only ever reported `"pending"` or a final
 * `"complete"`/`"failed"`, never a partial count, because `runDemoMatch`
 * (apps/api/src/demo-match.ts) had no per-job event at all. Ticket 1998875
 * closed PART of that gap: `runDemoMatch` now takes an `onJobScored`
 * callback fired once per successfully-scored job (still inside the same
 * concurrent `Promise.allSettled` loop — the scoring/batching structure
 * itself is unchanged), routes/searches.ts wires it into a per-run counter,
 * and `GET /searches/:id`'s `"pending"` member now carries `scoredSoFar`.
 * That's what the "N of M scored so far" line below reflects, and it is a
 * REAL live count, not a stub.
 *
 * What's still NOT live: per-run COST. `job_matches` rows are still written
 * in one batch after the whole run settles (decision: results come from the
 * database, never from in-memory state — per-job scores are deliberately
 * never exposed incrementally, only the count), and nothing measures
 * real-time token spend mid-run. The cost figure shown below is still the
 * PRE-RUN estimate, clearly labeled as such — never presented as if it were
 * incrementing real spend. A genuine live-spend figure remains a real,
 * unfilled gap (not a stub pretending to be the real thing); a follow-up
 * ticket could derive an approximate one from `scoredSoFar` and this
 * estimate's per-job average, but that's an explicit choice not made here.
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
      // Snapshot props AT THE MOMENT the estimate landed (F1) — not a
      // reference to the live `resumeId`/`sourceIds` closed over above,
      // which is exactly the same value right now but will silently diverge
      // if props change before confirm.
      setPhase({ kind: "estimated", estimate, resumeId, sourceIds: [...sourceIds] });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleConfirmRun(snapshot: {
    estimate: EstimateSearchResponse;
    resumeId: string;
    sourceIds: string[];
  }) {
    const { estimate, resumeId: snapshotResumeId, sourceIds: snapshotSourceIds } = snapshot;
    setPhase({
      kind: "starting",
      estimate,
      resumeId: snapshotResumeId,
      sourceIds: snapshotSourceIds,
    });
    try {
      // Fired against the SNAPSHOT captured when the estimate was computed
      // (F1), never the live `resumeId`/`sourceIds` props — see the `Phase`
      // type's "estimated" doc comment for the failure this avoids.
      const started = await startSearch(snapshotResumeId, snapshotSourceIds);
      setPhase({
        kind: "running",
        estimate,
        searchId: started.searchId,
        startedAt: Date.now(),
        scoredSoFar: 0,
      });
      pollRef.current = window.setInterval(
        () => void poll(started.searchId, estimate),
        POLL_INTERVAL_MS,
      );
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // F1: an estimate becomes stale the instant what it was computed for
  // changes. `SourceToggles`/`ResumeInput` stay live and interactive while
  // the "estimated" panel is showing (by design — nothing blocks further
  // toggling before confirming), so this effect is what keeps a changed
  // selection from ever reaching `handleConfirmRun` with a mismatched
  // estimate still on screen: it discards the stale estimate back to
  // "idle" the moment `resumeId`/`sourceIds` diverge from the snapshot,
  // forcing a fresh "Estimate search cost" click (and a fresh, honest
  // price) before anything can spend money. Deliberately scoped to ONLY
  // the "estimated" phase — once the user has clicked "Run search"
  // ("starting"/"running"), the request is already in flight against its
  // own snapshot and must not be interrupted by a prop change.
  useEffect(() => {
    if (phase.kind !== "estimated") return;
    const sameResume = phase.resumeId === resumeId;
    const sameSources =
      phase.sourceIds.length === sourceIds.length &&
      phase.sourceIds.every((id, i) => id === sourceIds[i]);
    if (!sameResume || !sameSources) {
      setPhase({ kind: "idle" });
    }
    // `phase` IS in this dependency array (review round 3, git-bug 484889d):
    // without it, a prop change that lands WHILE the estimate request is
    // still in flight (phase === "estimating") is missed entirely. The
    // effect no-ops during "estimating" (the guard above returns early for
    // any phase.kind !== "estimated"), so it "observes and discards" that
    // prop change instead of queueing a re-check. When the request then
    // resolves, `handleEstimate` sets phase to "estimated" with a snapshot
    // captured for the OLD selection — but that `setPhase` call doesn't
    // change this component's own `resumeId`/`sourceIds` props, so without
    // `phase` in the deps this effect would never re-run to notice the
    // divergence, and the UI would show the new (live) selection checked
    // while `handleConfirmRun` would still fire against the stale snapshot.
    // Including `phase` re-fires this effect on every phase transition,
    // which DOES include the "estimated" -> "idle" transition this effect
    // itself causes — but that re-fire is idempotent, not a loop: on that
    // second run phase.kind is "idle", the guard above returns immediately,
    // and nothing further happens. Verified (see SearchFlow.test.tsx) with
    // a controllable/deferred estimateSearch promise: toggle a source while
    // the request is in flight, let it resolve, and assert the landing
    // phase is never an actionable "estimated" state bound to the stale
    // selection. This repo has no react-hooks lint plugin configured
    // (eslint.config.js is @eslint/js + typescript-eslint only), so there
    // is no exhaustive-deps rule enforcing this either way — the deps array
    // is maintained by hand.
  }, [resumeId, sourceIds, phase]);

  async function poll(searchId: string, estimate: EstimateSearchResponse) {
    try {
      const result = await getSearchStatus(searchId);
      if (result.status === "pending") {
        // Ticket 1998875: this is the only state update a "still pending"
        // poll tick makes — everything else about the "running" phase
        // (estimate/searchId/startedAt) stays put. Written as a functional
        // update, not `setPhase({ ...phase, scoredSoFar: ... })`, because
        // `phase` here is `poll`'s closed-over value from whenever THIS
        // interval tick's closure was created, not necessarily the phase
        // React last rendered; reading `prev` from the updater guarantees
        // this always merges onto the actual current state.
        //
        // TWO guards, not one (review round, F2+F3 — the single
        // `prev.kind === "running"` check this used to have was not
        // enough):
        //
        //  - `prev.kind === "running"`: the phase can only legitimately be
        //    "running" (or already moved on) by the time a poll tick's
        //    response comes back.
        //  - `prev.searchId === searchId`: WHICH run `prev` is currently
        //    "running" for. Without this, a stale response from a PREVIOUS
        //    search can land after the user has already started a NEW one:
        //    search 1's poll A is in flight when search 1's poll B returns
        //    "complete" (phase -> "done"); the user immediately starts
        //    search 2 (phase -> "running" again); poll A then finally
        //    resolves and — since `prev.kind === "running"` is true again,
        //    just for the WRONG run — would overwrite search 2's
        //    `scoredSoFar` with search 1's stale count (F3, cross-run
        //    leakage).
        //
        // `Math.max`, not a bare overwrite, on the surviving branch: the
        // interval fires unconditionally every `POLL_INTERVAL_MS` and each
        // `poll()` call awaits its own independent `getSearchStatus` round
        // trip, so two ticks for the SAME run can resolve out of order — a
        // slow tick A (fired at t=0) can still be in flight when a faster
        // tick B (fired at t=2s) resolves first with a higher count. If A
        // then resolves later with its OLDER (lower) count, a bare
        // overwrite would render progress running backwards (F2). The
        // server-side counter (`onJobScored`, routes/searches.ts) only ever
        // increments within one run, so the higher of "what's on screen"
        // and "what this response reports" is always the more current
        // truth for that run.
        setPhase((prev) =>
          prev.kind === "running" && prev.searchId === searchId
            ? { ...prev, scoredSoFar: Math.max(prev.scoredSoFar, result.scoredSoFar) }
            : prev,
        );
        return;
      }
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
      {phase.kind === "estimating" && (
        <p className="estimating" role="status">
          <span className="spinner" aria-hidden="true" />
          Getting a cost estimate... this may take a minute.
        </p>
      )}

      {(phase.kind === "estimated" || phase.kind === "starting") && (
        <div className="cost-panel" aria-label="Cost estimate">
          <h3>Before you spend anything</h3>
          <dl>
            <dt>Jobs that would be scored</dt>
            <dd>{phase.estimate.costEstimate.jobCount}</dd>
            <dt>Max cost</dt>
            <dd>${phase.estimate.costEstimate.maxCostUsd.toFixed(2)}</dd>
            <dt>Probable cost</dt>
            <dd>${phase.estimate.costEstimate.probableCostUsd.toFixed(2)}</dd>
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
            onClick={() =>
              void handleConfirmRun({
                estimate: phase.estimate,
                resumeId: phase.resumeId,
                sourceIds: phase.sourceIds,
              })
            }
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
          {/* F4 (review round, ticket 1998875): `jobCount` (the "of M") is
              fixed at ESTIMATE time, but the real run re-fetches sources —
              more or fewer postings can appear before confirm, so this can
              legitimately read e.g. "12 of 10" or stall below M. Low
              frequency, no money at risk. Deliberately NOT clamped: clamping
              `scoredSoFar` to `jobCount` would hide that real divergence
              instead of just displaying it. */}
          <p>
            {phase.scoredSoFar} of {phase.estimate.costEstimate.jobCount} scored so far.
          </p>
          <p className="cost-caveat">
            Probable cost for this run: ${phase.estimate.costEstimate.probableCostUsd.toFixed(2)}{" "}
            (max ${phase.estimate.costEstimate.maxCostUsd.toFixed(2)}) — pre-run estimate, the job
            count above updates live but per-run cost is still only available as this pre-run
            figure; see this component's top-of-file notes.
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
                <dt>This run's probable cost</dt>
                <dd>${phase.result.costEstimate.probableCostUsd.toFixed(2)}</dd>
                <dt>This run's max cost</dt>
                <dd>${phase.result.costEstimate.maxCostUsd.toFixed(2)}</dd>
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
