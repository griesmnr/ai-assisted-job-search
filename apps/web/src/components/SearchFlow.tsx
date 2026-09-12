import { useEffect, useRef, useState } from "react";
import type { EstimateSearchResponse, SearchCriteria, SearchStatusResponse } from "@app/shared";
import { estimateSearch, getSearchStatus, startSearch } from "../api/client";
import { clearActiveSearchFor, readActiveSearch, writeActiveSearch } from "../session";
import { SourceOutcomesList } from "./SourceOutcomesList";

/** `criteria` is a small plain object of primitives/string arrays (see
 * @app/shared's `SearchCriteria`) -- JSON.stringify is a correct,
 * sufficient equality check for it (no functions/dates/cycles possible in
 * this shape), and simpler than hand-writing a field-by-field comparator
 * for a value this small. Order-sensitive within an array (["a","b"] !==
 * ["b","a"]) -- acceptable here since App.tsx always derives the arrays
 * from splitting one text field in a stable left-to-right order, so the
 * same user input always produces the same array order. */
function sameCriteria(a: SearchCriteria | undefined, b: SearchCriteria | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
      criteria: SearchCriteria | undefined;
    }
  | {
      kind: "starting";
      estimate: EstimateSearchResponse;
      resumeId: string;
      sourceIds: string[];
      criteria: SearchCriteria | undefined;
    }
  | {
      kind: "running";
      estimate: EstimateSearchResponse;
      searchId: string;
      /** Which resume this run belongs to (ticket 3f05144). Carried on the
       * phase rather than read from the live `resumeId` prop for the same
       * reason `"estimated"` snapshots its inputs: the props can change
       * under a run that is already in flight (the user pastes a new
       * resume mid-search), and the persisted in-flight record must stay
       * tied to the resume the run was actually STARTED for — that is what
       * `clearActiveSearchFor` scopes against. */
      resumeId: string;
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
  criteria,
  disableEstimate,
  onEstimateStart,
  onInvalidEstimateAttempt,
  onSearchComplete,
}: {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
  /** Ticket b9e6251: App.tsx sets this when the location criteria has no
   * real signal (no commute locations, remote not checked, "Any location"
   * not checked). Ticket 371713d changed HOW this blocks the estimate --
   * see the "Estimate search cost" button below: it used to be the native
   * `disabled` attribute, which is why the gate still keeps
   * `sourceIds.length === 0` as a REAL `disabled` (no reason to scroll
   * anywhere for that one -- "select a source" isn't a location problem).
   * `disableEstimate` on its own is now checked inside the click handler
   * instead, because a real `disabled` button never fires `onClick` at
   * all, and Nicole explicitly wants an attempted click while invalid to
   * scroll the location section into view (`onInvalidEstimateAttempt`
   * below) -- something a `disabled` button structurally cannot do.
   * Optional, defaulting to `false` (never blocks), so every other
   * existing caller/test keeps working unchanged. */
  disableEstimate?: boolean;
  /** Ticket f4a7f07: fired at the START of every estimate request (before
   * the network call), so App.tsx can clear its "current search results"
   * gate the same moment a new estimate is requested — Nicole: "cleared
   * every time a new search is estimated." Optional so every other
   * existing caller/test keeps working unchanged. */
  onEstimateStart?: () => void;
  /** Ticket 371713d: fired when "Estimate search cost" is clicked while
   * `disableEstimate` is true -- i.e. an attempt that this component
   * blocks from ever reaching `handleEstimate`. App.tsx is the one place
   * that also holds the ref into SIBLING component `SearchCriteriaForm`'s
   * location section (see that component's `locationSectionRef` prop), so
   * this callback is how a click here becomes a scroll over there --
   * SearchFlow itself doesn't know or need to know what's on the other
   * side of the callback. Optional so every other existing caller/test
   * (none of which care about scrolling) keeps working unchanged. */
  onInvalidEstimateAttempt?: () => void;
  onSearchComplete: () => void;
}) {
  // Ticket 3f05144: the first thing this component does on EVERY mount is
  // ask `sessionStorage` whether a real, already-paid-for run is still in
  // flight for this resume. A reload (tab discard, Vite HMR reconnect,
  // stray Cmd-R, laptop sleep) is indistinguishable from a first mount
  // from in here, which is exactly why the answer has to come from
  // storage rather than from React state that the reload just erased.
  //
  // Restored as `scoredSoFar: 0` on purpose — see PersistedActiveSearch's
  // doc comment; the mount effect below polls immediately, so the real
  // count replaces the 0 within one round trip.
  const [phase, setPhase] = useState<Phase>(() => {
    const record = readActiveSearch();
    if (record === undefined || record.resumeId !== resumeId) return { kind: "idle" };
    return {
      kind: "running",
      estimate: record.estimate,
      searchId: record.searchId,
      resumeId: record.resumeId,
      startedAt: record.startedAt,
      scoredSoFar: 0,
    };
  });
  const pollRef = useRef<number | undefined>(undefined);
  // Captured once, from the FIRST render's phase — `useRef`'s initial value
  // is evaluated on every render but only the first one is kept, so this
  // stays the restored run (or undefined) for the life of the mount even
  // after `phase` moves on.
  const restoredRunRef = useRef(phase.kind === "running" ? phase : undefined);

  useEffect(() => {
    return () => {
      if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    };
  }, []);

  // Reconnect to a restored run: poll ONCE immediately (a run can easily
  // have finished during the reload, and waiting a full POLL_INTERVAL_MS to
  // find that out would show a stale "Search running..." panel), then keep
  // polling on the normal interval.
  //
  // This effect owns its own interval id and clears it in its own cleanup
  // rather than relying on the unmount effect above, because React's
  // StrictMode deliberately runs mount effects twice in development
  // (effect -> cleanup -> effect). Without a real cleanup here the first
  // run's interval would be orphaned and the tab would poll twice as often.
  // `pollRef` is still updated so the rest of the component (poll's own
  // stop-on-terminal-status path, handleConfirmRun) can cancel it the same
  // way it cancels an interval it started itself.
  useEffect(() => {
    const restored = restoredRunRef.current;
    if (restored === undefined) return;
    void poll(restored.searchId, restored.estimate, true);
    const intervalId = window.setInterval(
      () => void poll(restored.searchId, restored.estimate, true),
      POLL_INTERVAL_MS,
    );
    pollRef.current = intervalId;
    return () => {
      window.clearInterval(intervalId);
      if (pollRef.current === intervalId) pollRef.current = undefined;
    };
    // Mount-only by design, with an empty dep array kept deliberately
    // empty: `poll` is recreated every render but only ever touches
    // `pollRef`/`setPhase`, both stable, and re-running this effect would
    // start a duplicate interval for a run already being polled. (This repo
    // has no react-hooks lint plugin — see the F1 effect's note below — so
    // no exhaustive-deps rule disagrees with that choice.)
  }, []);

  // The single writer of the in-flight-search record. Keeping it in one
  // effect keyed on `phase` — rather than sprinkling write/clear calls
  // through every transition — means "storage says a run is in flight"
  // and "this component is in the running phase" cannot drift apart.
  //
  // Cost of re-writing on every poll tick (the phase object changes when
  // `scoredSoFar` does, ~every 2s): one JSON.stringify of a few KB. That is
  // cheaper than the class of bug the alternative invites.
  //
  // "starting" is excluded from BOTH branches: the `POST /searches` request
  // is in flight, so there is no searchId to write yet — but the previous
  // record (if any) must not be dropped either, since the response may
  // still turn out to be a 409 naming a run that really is still going.
  useEffect(() => {
    if (phase.kind === "running") {
      writeActiveSearch({
        searchId: phase.searchId,
        resumeId: phase.resumeId,
        startedAt: phase.startedAt,
        estimate: phase.estimate,
      });
      return;
    }
    if (phase.kind === "starting") return;
    // Scoped by the run's OWN resume where we know it. A finished run
    // reports its `resumeId` on every `SearchStatusResponse` member, and
    // that is the record to drop — the live `resumeId` prop may have moved
    // on (the user pasted a new resume while the run was still going), and
    // `clearActiveSearchFor` deliberately refuses to delete a record it
    // isn't sure it owns. Without this the finished run's record would
    // linger, inert, until the tab closes.
    clearActiveSearchFor(phase.kind === "done" ? phase.result.resumeId : resumeId);
  }, [phase, resumeId]);

  async function handleEstimate() {
    onEstimateStart?.();
    setPhase({ kind: "estimating" });
    try {
      const estimate = await estimateSearch(resumeId, sourceIds, criteria);
      // Snapshot props AT THE MOMENT the estimate landed (F1) — not a
      // reference to the live `resumeId`/`sourceIds`/`criteria` closed over
      // above, which are exactly the same values right now but will
      // silently diverge if props change before confirm.
      setPhase({ kind: "estimated", estimate, resumeId, sourceIds: [...sourceIds], criteria });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleConfirmRun(snapshot: {
    estimate: EstimateSearchResponse;
    resumeId: string;
    sourceIds: string[];
    criteria: SearchCriteria | undefined;
  }) {
    const {
      estimate,
      resumeId: snapshotResumeId,
      sourceIds: snapshotSourceIds,
      criteria: snapshotCriteria,
    } = snapshot;
    setPhase({
      kind: "starting",
      estimate,
      resumeId: snapshotResumeId,
      sourceIds: snapshotSourceIds,
      criteria: snapshotCriteria,
    });
    try {
      // Fired against the SNAPSHOT captured when the estimate was computed
      // (F1), never the live `resumeId`/`sourceIds`/`criteria` props — see
      // the `Phase` type's "estimated" doc comment for the failure this
      // avoids.
      const started = await startSearch(snapshotResumeId, snapshotSourceIds, snapshotCriteria);
      enterRunning(started.searchId, snapshotResumeId, estimate);
    } catch (err) {
      // Ticket 3f05144: `POST /searches` answers an overlapping run for the
      // same resume with `409 { error, searchId }` (routes/searches.ts's
      // `inFlightByResume` guard). That guard is what actually prevents the
      // duplicate SPEND, and it already worked — but the frontend used to
      // render the 409 as a flat error, which is the wrong story to tell:
      // the run named in that body is alive, already paid for, and scoring
      // right now. This is also the one hole persistence alone cannot
      // close, because it covers the window between the request leaving the
      // browser and the response arriving — reload in that window and there
      // was never a searchId to persist. Adopting the id turns that window
      // into "you're already running one, here it is."
      const inFlightId = inFlightSearchIdFromError(err);
      if (inFlightId !== undefined) {
        enterRunning(inFlightId, snapshotResumeId, estimate);
        return;
      }
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The one place a run is adopted into the "running" phase and its poll
   * loop started — shared by the normal `POST /searches` success path and
   * the 409-adoption path above, so they can never drift. */
  function enterRunning(
    searchId: string,
    runResumeId: string,
    estimate: EstimateSearchResponse,
  ): void {
    setPhase({
      kind: "running",
      estimate,
      searchId,
      resumeId: runResumeId,
      // "now" is exact on the normal path and a lower bound on the
      // 409-adoption path (that run started before this click, and the API
      // does not report its start time) — so the elapsed timer can
      // under-report there. Displaying a slightly short elapsed time is a
      // much smaller problem than not showing the run at all, and there is
      // nothing more accurate available without a new API field.
      startedAt: Date.now(),
      scoredSoFar: 0,
    });
    if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => void poll(searchId, estimate), POLL_INTERVAL_MS);
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
    // Ticket 957bc22: criteria (title include/exclude, locations,
    // remote-ok) joins resumeId/sourceIds as a third thing that can change
    // between "estimate computed" and "user clicks confirm" -- the
    // criteria-editing form (App.tsx) stays interactive while this panel
    // shows, same as SourceToggles/ResumeInput already did. Without this,
    // tweaking a title filter after seeing an estimate could fire
    // startSearch priced for the OLD criteria against the NEW, possibly
    // much larger or smaller, real candidate set.
    const sameCriteriaValue = sameCriteria(phase.criteria, criteria);
    // Ticket b9e6251 fable/opus review F1 (blocking): `disableEstimate`
    // (App.tsx's `!hasLocationSignal`) is NOT part of `criteria` --
    // `anyLocationOk` is a pure frontend gate that never reaches the
    // payload, so `sameCriteriaValue` alone can't see it change. Without
    // this, un-checking "Any location" AFTER estimating left a stale,
    // still-confirmable "Run search" button on screen for the exact
    // unrestricted search the warning above it says is disabled -- the
    // screen contradicted itself, and clicking through actually spent
    // money on a criteria the UI was simultaneously calling invalid.
    if (!sameResume || !sameSources || !sameCriteriaValue || disableEstimate) {
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
  }, [resumeId, sourceIds, criteria, disableEstimate, phase]);

  /**
   * `fromStorage` marks a run this mount adopted from `sessionStorage`
   * rather than started itself (ticket 3f05144). It changes exactly one
   * thing: how a 404 is reported. For a run started in this tab, a 404 is a
   * genuine anomaly and belongs on screen as an error. For a run restored
   * from storage, a 404 means the record is stale — the API process was
   * restarted, or this dev database was reset out from under it — and the
   * honest UI is a clean idle state the user can search from, not a
   * "Could not run the search: No search with id ..." alert about a search
   * they never asked this page to run.
   */
  async function poll(searchId: string, estimate: EstimateSearchResponse, fromStorage = false) {
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
      if (fromStorage && apiErrorStatus(err) === 404) {
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="search-flow">
      {phase.kind === "idle" && (
        <>
          <button
            type="button"
            onClick={() => {
              // Ticket 371713d: `disableEstimate` is checked HERE, inside
              // the handler, rather than folded into the `disabled`
              // attribute below -- a real `disabled` button never fires
              // `onClick`, so that would make it impossible for an
              // attempted click to trigger the scroll-back-to-location
              // behavior Nicole asked for. `sourceIds.length === 0` stays
              // on the real `disabled` attribute instead (see below): that
              // gate has no associated field to scroll to, so there's
              // nothing lost by leaving it as a plain native disable.
              if (disableEstimate) {
                onInvalidEstimateAttempt?.();
                return;
              }
              void handleEstimate();
            }}
            disabled={sourceIds.length === 0}
            // Opus review F5: `aria-disabled` must reflect EVERY reason this
            // click is blocked, not just the location one -- otherwise zero
            // sources selected + a valid location produced a real
            // `disabled={true}` (from the sources check) alongside a
            // self-contradictory `aria-disabled="false"` on the same
            // button.
            aria-disabled={sourceIds.length === 0 || disableEstimate}
          >
            Estimate search cost
          </button>
          {/* Ticket b9e6251, opus review F2: SearchCriteriaForm's own
              location warning only explains ONE of the two things that can
              disable this button. Checking "Any location" while zero
              sources are selected used to make that warning disappear
              while leaving the button disabled with no explanation
              anywhere on screen -- a dead end after doing exactly what the
              only visible instruction said to do. This message covers
              BOTH real disable reasons, so at least one always explains
              why, whichever is still unmet. */}
          {(sourceIds.length === 0 || disableEstimate) && (
            <p className="estimate-disabled-reason" role="alert">
              {sourceIds.length === 0 && "Select at least one source above. "}
              {disableEstimate && 'Set a location above, or check "Any location".'}
            </p>
          )}
        </>
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
                criteria: phase.criteria,
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
            Estimated before this run started: $
            {phase.estimate.costEstimate.probableCostUsd.toFixed(2)} probable, $
            {phase.estimate.costEstimate.maxCostUsd.toFixed(2)} max. The job count above updates
            live; this cost figure doesn't.
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
 * Reads the HTTP status off whatever `../api/client` threw.
 *
 * Structural rather than `err instanceof ApiError` on purpose: this
 * component's own tests, and App's, replace `../api/client` wholesale with
 * `vi.mock`, so the `ApiError` class identity visible here is not
 * necessarily the one a rejected mock built its error from — an
 * `instanceof` check would silently answer "no" in exactly the tests that
 * exist to prove this branch works. `ApiError` is the only thing that
 * module ever throws, and `status` is a plain own property on it, so
 * reading it structurally is both stronger and simpler here.
 */
function apiErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The `searchId` of an already-running search, if `err` is the `409` that
 * `POST /searches`'s per-resume in-flight guard answers with. `undefined`
 * for every other error — including a 409 whose body somehow lacks the id,
 * which stays a plain error rather than being guessed at.
 */
function inFlightSearchIdFromError(err: unknown): string | undefined {
  if (apiErrorStatus(err) !== 409) return undefined;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return undefined;
  const searchId = (body as { searchId?: unknown }).searchId;
  return typeof searchId === "string" && searchId.length > 0 ? searchId : undefined;
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
