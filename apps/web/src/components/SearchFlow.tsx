import { useEffect, useRef, useState } from "react";
import type {
  EstimateProgressResponse,
  EstimateSearchResponse,
  SearchCriteria,
  SearchSourceState,
  SearchStatusResponse,
} from "@app/shared";
import { estimateSearch, getEstimateProgress, getSearchStatus, startSearch } from "../api/client";
import {
  clearActiveSearchFor,
  readActiveSearch,
  writeActiveSearch,
  type CriteriaFormState,
} from "../session";
import { SourceOutcomesList } from "./SourceOutcomesList";
import { SearchSourceStatusList } from "./SearchSourceStatusList";

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

/**
 * Ticket 4cafff3: every field the user can SEE change in the criteria form
 * -- `CriteriaFormState` (session.ts) plus `titleChips`, which lives
 * outside that type in App.tsx but is just as visible. This is deliberately
 * the raw form, not the derived `SearchCriteria` payload: `buildSearchCriteria`
 * (App.tsx) drops some of these fields from the request on purpose (e.g.
 * `expandMetroAreas` with no city typed -- 410e1a2's conditional, which this
 * ticket does not touch), so a `SearchCriteria`-only comparison is blind to
 * a visible change that happens to leave the payload byte-identical. Using
 * the form itself as the comparison basis can't have that gap: every field
 * a user can toggle is a member of this type by construction.
 */
type VisibleSearchForm = CriteriaFormState & { titleChips: string[] };

/** Same reasoning as `sameCriteria` above -- a small plain object of
 * primitives/string arrays, so a structural `JSON.stringify` compare is
 * correct and simpler than a field-by-field comparator. Order-sensitive
 * within `titleChips`/`commitmentIn`, same acceptable reasoning as
 * `sameCriteria`: App.tsx always builds these in a stable order for the
 * same sequence of user actions. */
function sameVisibleForm(
  a: VisibleSearchForm | undefined,
  b: VisibleSearchForm | undefined,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const POLL_INTERVAL_MS = 2000;

type Phase =
  | { kind: "idle" }
  | {
      kind: "estimating";
      /**
       * Ticket bf2dd0a: the most recent `GET /searches/estimate/:id/progress`
       * snapshot for this in-flight estimate, or `undefined` before the
       * first poll response lands (or if progress polling never gets a
       * usable answer — see `pollEstimateProgress` below, which treats a 404
       * as "nothing to show" rather than an error). Purely additive: the
       * estimate itself runs identically whether or not this ever becomes
       * defined.
       */
      progress: EstimateProgressResponse | undefined;
    }
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
      /** Ticket 4cafff3: the raw form snapshot, captured alongside
       * `criteria` at the same moment and for the same reason (F1 above) --
       * see `VisibleSearchForm`'s doc comment for why this is a SEPARATE
       * field from `criteria` rather than a replacement for it: the two can
       * legitimately disagree (a visible form change that leaves the
       * derived payload unchanged), and the invalidation effect below checks
       * both so neither kind of change goes unnoticed. Not threaded into
       * `"starting"`/`"running"` -- nothing downstream of "estimated" ever
       * reads it; it exists purely for the one comparison below. */
      formState: VisibleSearchForm | undefined;
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
      /** Ticket 2e7ba8a: the durable "of M" denominator, sourced from
       * `GET /searches/:id`'s `linked` field rather than the pre-run
       * estimate's `costEstimate.jobCount` (see the removed F4 comment,
       * now on the render site below, and session.ts's updated doc comment
       * for why this — unlike `scoredSoFar` — now SURVIVES a reload:
       * `linked` is a DB-backed count, re-derivable on every poll, not a
       * value that only ever lived in this component's memory).
       * `undefined` until the first poll response lands — a freshly
       * started run has no poll data yet (the poll interval's first tick
       * doesn't fire for POLL_INTERVAL_MS), while a restored run polls
       * immediately on mount and fills this within one round trip either
       * way. The render below takes `Math.max` of this and the estimate's
       * `jobCount` (ticket 4146881) rather than switching to this value
       * outright the moment it's defined — see that ticket's comment on
       * the render site for why: `linked` is a partial, still-climbing
       * count for most of a run, not a total, and rendering it bare made
       * the shown denominator visibly grow over the course of a search. */
      linked: number | undefined;
      /** Ticket 2e7ba8a: per-source status, live. Lets the running panel
       * show a source going `"failed"` (dead-lettered) WHILE the search is
       * still going, not just after it finishes. */
      sources: SearchSourceState[];
      /** Ticket 2e7ba8a: set only once `GET /searches/:id` reports the
       * search has been stuck past the staleness window (see
       * `SearchStatusResponse.pending.stalledSince`'s doc comment) — an
       * operator-replay situation this component cannot fix on its own,
       * surfaced so the run doesn't just look like an ordinary spinner
       * forever with no indication anything is wrong. */
      stalledSince: string | undefined;
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
  formState,
  disableEstimate,
  onEstimateStart,
  onEstimateReady,
  onInvalidEstimateAttempt,
  onSearchComplete,
  onRunningChange,
  onRealSearchStarted,
  freshResultsCount,
  onViewResults,
}: {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
  /** Ticket 4cafff3: the live, raw criteria form -- everything the user can
   * SEE on screen (`CriteriaFormState` plus `titleChips`), not the
   * `SearchCriteria` App.tsx derives from it for the wire. The derived
   * `criteria` prop above is what actually changes the request, but
   * `buildSearchCriteria` deliberately omits some of these fields from the
   * payload in some states (410e1a2: `expandMetroAreas` with no city typed
   * "cannot change a single result", so it's left off) -- and in those
   * states `criteria` can stay byte-identical across a visible toggle that
   * the user clearly saw happen. Nicole's resolution on this ticket: "making
   * it look like something happened is a good solution" -- i.e. invalidate
   * on what the user can see change, not only on what the request ends up
   * carrying. Optional, like `criteria`, so every existing caller/test that
   * doesn't exercise this keeps working unchanged; the invalidation effect
   * below treats two `undefined`s as equal, same as `sameCriteria` already
   * does for the `criteria` prop. */
  formState?: VisibleSearchForm;
  /** Ticket b9e6251: App.tsx sets this when the location criteria has no
   * real signal (no commute locations, remote not checked, "Any location"
   * not checked). Ticket 371713d changed HOW this blocks the estimate --
   * see the "Get estimate" button below: it used to be the native
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
  /** Ticket e5e1aa1 review round 2 (D8/Required 4): fired the moment a real
   * estimate response lands, with that response in hand -- App.tsx is the
   * one place that also owns `SearchCriteriaForm` (a SIBLING component, same
   * reasoning as `onInvalidEstimateAttempt` below), so this is how
   * `EstimateSearchResponse.locationWarnings` gets from here to the
   * checkbox that produced it. Optional so every other existing
   * caller/test keeps working unchanged. */
  onEstimateReady?: (estimate: EstimateSearchResponse) => void;
  /** Ticket 371713d: fired when "Get estimate" is clicked while
   * `disableEstimate` is true -- i.e. an attempt that this component
   * blocks from ever reaching `handleEstimate`. App.tsx is the one place
   * that also holds the ref into SIBLING component `SearchCriteriaForm`'s
   * location section (see that component's `locationSectionRef` prop), so
   * this callback is how a click here becomes a scroll over there --
   * SearchFlow itself doesn't know or need to know what's on the other
   * side of the callback. Optional so every other existing caller/test
   * (none of which care about scrolling) keeps working unchanged. */
  onInvalidEstimateAttempt?: () => void;
  /** Ticket 9e5fcf3: now carries the completed run's OWN `searchId` --
   * App.tsx needs it to scope "Results from this search" to that one
   * search's links (`useResults`'s new `searchId` parameter), not every
   * search this resume has ever run (ticket 3f0883f's bug: "he was
   * expecting to see results from only this search"). The one call site
   * (`poll` below) already has it on hand -- `result.searchId`, part of
   * every `SearchStatusResponse` member -- so this is free to thread
   * through. */
  onSearchComplete: (searchId: string) => void;
  /** Ticket 88f11d7 (Nicole: "I don't think that we should allow a change
   * of resume while a search is in progress"): fired whenever this
   * component's own real-search phase (`"starting"` -- the `POST
   * /searches` request is in flight -- or `"running"` -- it's adopted a
   * searchId and is polling) starts or stops, so App.tsx can disable the
   * collapsed bar's action button for exactly that window -- "Edit"
   * exactly as much as "Change" (review fix F1: an earlier version gated
   * only "Change" on this, which left a real window where "Edit" could
   * still reopen the paste form mid-search). Deliberately keyed on the
   * SAME two phases the persisted-run effect above already treats as "a
   * real run genuinely exists" (see that effect's own "starting is
   * excluded from BOTH branches" comment) -- `"estimating"`/`"estimated"`
   * are NOT included: Nicole's own resolution was explicit that
   * re-estimating, unlike a real run, should stay unrestricted. Optional
   * so every existing caller/test that doesn't care keeps working
   * unchanged. */
  onRunningChange?: (running: boolean) => void;
  /** Ticket 88f11d7 review fix (F1): fired synchronously from
   * `enterRunning` -- the ONE place a real run's `searchId` is actually
   * adopted (a fresh `POST /searches` success or a 409-adoption of an
   * already-running search; see that function's own doc comment) -- so
   * App.tsx can flip its `resumeLocked` state true THIS SESSION, the
   * moment a real search row is confirmed to exist, rather than only
   * learning about it on a later reload's hydration fetch. Deliberately
   * NOT derived from `onRunningChange`/`phase.kind` in an effect: this
   * needs to fire exactly once per confirmed run, synchronously with the
   * state transition, not on a later render pass keyed on a phase whose
   * `"starting"` value already overlaps `onRunningChange`'s own `true`
   * (which — unlike this — intentionally also covers the brief window
   * before a searchId exists at all, see that callback's own doc
   * comment). Optional so every existing caller/test keeps working
   * unchanged. */
  onRealSearchStarted?: () => void;
  /**
   * Ticket 9e5fcf3 (part (a)): the count the "done"/"complete" panel's
   * "View N results" button reports -- `undefined` while App.tsx's own
   * `resultsState` hasn't resolved yet (a real possibility: this panel can
   * render before the post-completion `getResults` refetch lands), in
   * which case the button is withheld rather than guessing or showing a
   * stale number. Also withheld at `0` -- "View 0 results" has nothing to
   * view, and the plain "No jobs matched this search." text already below
   * (once the user does look) says that more honestly than a button would.
   *
   * THIS COMPONENT DOES NOT COMPUTE THIS ITSELF: SearchFlow has never known
   * the results list exists at all -- it is a sibling in App.tsx, not a
   * child -- and ticket 9e5fcf3's own notes are explicit that this is
   * expected, not a gap to fix by reaching into SearchFlow for it. App.tsx
   * derives it from the SAME `resultsState` the results section itself
   * renders, so the two can't disagree about what "N" means.
   */
  freshResultsCount?: number;
  /**
   * Ticket 9e5fcf3 (part (a)): fired by the "View N results" button's
   * click -- App.tsx owns a ref to the results section below this
   * component (a plain DOM scroll target, same "sibling coordination
   * through App.tsx" shape `locationSectionRef`/
   * `onInvalidEstimateAttempt` already use) and scrolls to it.
   *
   * NO GUARD NEEDED HERE, unlike `activeTabRef`'s "only act if nothing
   * changed since the click" pattern (ticket 11ead86) that this ticket's
   * own notes point at as prior art. That pattern exists to protect an
   * ASYNC action (resolving well after the click, during which the user
   * can navigate away) from acting on stale intent. A click handler that
   * synchronously calls `scrollIntoView` has no such gap -- there is
   * nothing for the user to do between the click and the scroll for this
   * to race against. The actual auto-scroll hazard that pattern would have
   * guarded against (completion itself, which fires from a background
   * poll with no click at all) is the exact scenario this design rejects
   * auto-scroll for -- see the "View N results" button's own JSX comment,
   * near its render site below, for the full argument.
   */
  onViewResults?: () => void;
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
      // Ticket 2e7ba8a: none of these ride along in `record` (unlike
      // `scoredSoFar`, `linked`/`sources` are durable server state, not
      // something worth re-serializing to storage on every poll tick —
      // see `PersistedActiveSearch`'s doc comment) — the mount effect
      // below polls immediately, so the real values replace these within
      // one round trip, same as `scoredSoFar`.
      linked: undefined,
      sources: [],
      stalledSince: undefined,
    };
  });
  const pollRef = useRef<number | undefined>(undefined);
  // Ticket bf2dd0a: a SEPARATE interval from `pollRef` above -- that one
  // polls `GET /searches/:id` for a real, already-started (async) search;
  // this one polls `GET /searches/estimate/:id/progress` for a still-
  // in-flight (synchronous) estimate. The two phases never overlap
  // (`"estimating"` vs `"running"`), but keeping separate refs means
  // starting one can never accidentally clobber the other's interval id.
  const estimateProgressPollRef = useRef<number | undefined>(undefined);
  // Captured once, from the FIRST render's phase — `useRef`'s initial value
  // is evaluated on every render but only the first one is kept, so this
  // stays the restored run (or undefined) for the life of the mount even
  // after `phase` moves on.
  const restoredRunRef = useRef(phase.kind === "running" ? phase : undefined);

  useEffect(() => {
    return () => {
      if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
      if (estimateProgressPollRef.current !== undefined) {
        window.clearInterval(estimateProgressPollRef.current);
      }
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

  // Ticket 88f11d7: reports "a real run is in progress" on every phase
  // transition -- see `onRunningChange`'s own doc comment above for why
  // `"starting"`/`"running"` specifically, and not `"estimating"`/
  // `"estimated"`.
  useEffect(() => {
    onRunningChange?.(phase.kind === "starting" || phase.kind === "running");
  }, [phase.kind, onRunningChange]);

  /**
   * Ticket bf2dd0a: starts polling `GET /searches/estimate/:id/progress` on
   * `POLL_INTERVAL_MS`, the same cadence the real-search poll loop below
   * uses. A 404 (no tracked record yet, or the id has aged out) is treated
   * as "nothing to show" — `getEstimateProgress`'s own doc comment says why
   * this is the expected shape of "no progress data", not an error — so it
   * is silently ignored rather than bumping the phase to `"error"`; the
   * plain spinner text stays visible underneath either way. Only updates
   * `phase` while still `"estimating"` (a tick that resolves after the
   * estimate itself has already finished, or been superseded, is a stale
   * write and must no-op rather than resurrect a phase the component has
   * already moved on from).
   */
  function startEstimateProgressPolling(estimateRequestId: string): void {
    function tick(): void {
      void getEstimateProgress(estimateRequestId)
        .then((progress) => {
          setPhase((current) =>
            current.kind === "estimating" ? { ...current, progress } : current,
          );
        })
        .catch(() => {
          // 404 ("nothing tracked yet/anymore") or a transient network blip
          // -- either way, just skip this tick. The estimate's OWN request
          // (handleEstimate's `estimateSearch` call) is what actually
          // reports real errors; this side channel never should.
        });
    }
    tick();
    estimateProgressPollRef.current = window.setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopEstimateProgressPolling(): void {
    if (estimateProgressPollRef.current !== undefined) {
      window.clearInterval(estimateProgressPollRef.current);
      estimateProgressPollRef.current = undefined;
    }
  }

  async function handleEstimate() {
    onEstimateStart?.();
    setPhase({ kind: "estimating", progress: undefined });
    try {
      // Minted by the CALLER (ticket bf2dd0a) -- the server has no way to
      // hand back an id before the blocking response it's attached to, so
      // the frontend generates one before firing the request and starts
      // polling immediately after, well before `estimateSearch` below can
      // resolve. Inside this try (opus review round 1): `randomUUID` is not
      // reachable in an insecure context, which this app's docker-compose
      // loopback-only setup never is, but if it -- or the poll-start call --
      // ever threw, leaving it outside the try would strand the UI on the
      // "estimating" spinner forever with no error, exactly the opaque-wait
      // failure mode this ticket exists to eliminate.
      const estimateRequestId = crypto.randomUUID();
      startEstimateProgressPolling(estimateRequestId);
      const estimate = await estimateSearch(resumeId, sourceIds, criteria, estimateRequestId);
      stopEstimateProgressPolling();
      onEstimateReady?.(estimate);
      // Snapshot props AT THE MOMENT the estimate landed (F1) — not a
      // reference to the live `resumeId`/`sourceIds`/`criteria` closed over
      // above, which are exactly the same values right now but will
      // silently diverge if props change before confirm.
      setPhase({
        kind: "estimated",
        estimate,
        resumeId,
        sourceIds: [...sourceIds],
        criteria,
        // Ticket 4cafff3: snapshotted for the same reason `criteria` is on
        // the line above -- see the "estimated" phase's `formState` doc
        // comment.
        formState,
      });
    } catch (err) {
      stopEstimateProgressPolling();
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
      linked: undefined,
      sources: [],
      stalledSince: undefined,
    });
    if (pollRef.current !== undefined) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => void poll(searchId, estimate), POLL_INTERVAL_MS);
    // Ticket 88f11d7 review fix (F1): see `onRealSearchStarted`'s own doc
    // comment -- this is the one call site.
    onRealSearchStarted?.();
  }

  // F1: an estimate becomes stale the instant what it was computed for
  // changes. `SourceToggles`/`ResumeInput` stay live and interactive while
  // the "estimated" panel is showing (by design — nothing blocks further
  // toggling before confirming), so this effect is what keeps a changed
  // selection from ever reaching `handleConfirmRun` with a mismatched
  // estimate still on screen: it discards the stale estimate back to
  // "idle" the moment `resumeId`/`sourceIds` diverge from the snapshot,
  // forcing a fresh "Get estimate" click (and a fresh, honest
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
    // Ticket 4cafff3: `sameCriteriaValue` alone is blind to a visible form
    // change that leaves the DERIVED request unchanged -- e.g. toggling
    // "include nearby cities" with no city typed, which `buildSearchCriteria`
    // (410e1a2) deliberately omits from `criteria` either way, since it
    // "cannot change a single result" with nothing to expand. John's
    // testing hit exactly this: he toggled a checkbox, nothing on screen
    // responded, and the app looked broken even though the (unchanged)
    // estimate was still correct. Nicole's resolution: "making it look like
    // something happened is a good solution" -- so this checks the FORM
    // itself, not just what the form happens to produce on the wire. Kept
    // ALONGSIDE `sameCriteriaValue`, not instead of it: SearchFlow's own
    // tests (ticket 957bc22) exercise `criteria` changing with no
    // `formState` prop supplied at all, and that must keep invalidating on
    // its own -- every real caller (App.tsx) passes both, always derived
    // from the same underlying state, so in production the two can never
    // disagree about WHETHER something changed, only about whether the
    // wire payload happened to change too.
    const sameFormStateValue = sameVisibleForm(phase.formState, formState);
    // Ticket b9e6251 fable/opus review F1 (blocking): `disableEstimate`
    // (App.tsx's `!hasLocationSignal`) is NOT part of `criteria` --
    // `anyLocationOk` is a pure frontend gate that never reaches the
    // payload, so `sameCriteriaValue` alone can't see it change. Without
    // this, un-checking "Any location" AFTER estimating left a stale,
    // still-confirmable "Run search" button on screen for the exact
    // unrestricted search the warning above it says is disabled -- the
    // screen contradicted itself, and clicking through actually spent
    // money on a criteria the UI was simultaneously calling invalid.
    if (
      !sameResume ||
      !sameSources ||
      !sameCriteriaValue ||
      !sameFormStateValue ||
      disableEstimate
    ) {
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
  }, [resumeId, sourceIds, criteria, formState, disableEstimate, phase]);

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
            ? {
                ...prev,
                scoredSoFar: Math.max(prev.scoredSoFar, result.scoredSoFar),
                // Ticket 2e7ba8a: same out-of-order-poll protection as
                // `scoredSoFar` above — `linked` only ever grows within one
                // run (fetch workers link jobs, never unlink them), so a
                // late-resolving, now-stale tick must not regress it either.
                // `?? 0` on the LEFT side only, for the brief pre-first-poll
                // window where `prev.linked` is still `undefined`.
                linked: Math.max(prev.linked ?? 0, result.linked),
                sources: result.sources,
                stalledSince: result.stalledSince,
              }
            : prev,
        );
        return;
      }
      if (pollRef.current !== undefined) {
        window.clearInterval(pollRef.current);
        pollRef.current = undefined;
      }
      setPhase({ kind: "done", estimate, result });
      if (result.status === "complete") onSearchComplete(result.searchId);
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
      {/* Ticket 9e5fcf3 review round, finding C2: a PERSISTENT live region,
          unconditionally rendered on every single render of this component
          regardless of `phase.kind` -- unlike the `<h3>` below (which only
          exists while `phase.kind === "done"`), this exact DOM node is
          already sitting in the tree, empty, well before the transition to
          "done" ever happens. That is load-bearing, not incidental: opus
          review N7 on this codebase (MagicLinkForm.tsx's own comment, cited
          verbatim) already found and fixed the same mistake once --
          "A region inserted together with its own content is not announced
          by most screen readers." An earlier version of this fix put
          `aria-live="polite"` directly on the `<h3>` inside the `"done"`
          branch, which is exactly that mistake: the region and its content
          both enter the DOM in the SAME mutation (the `<h3>` doesn't exist
          a moment before phase flips to `"done"`), so there is nothing for
          a screen reader to have been "already watching" -- most
          implementations announce a LIVE REGION'S CHANGE, not its initial
          appearance with content already inside it. Rendering unconditionally
          with an empty string (never `null`, never omitting the element) is
          what keeps this the SAME node across every phase transition, so
          React reconciles its text content in place rather than mounting a
          fresh node each time -- a real content CHANGE on an
          already-present node, which is what actually gets announced.
          Visually hidden (`.visually-hidden`, index.css) since sighted users
          already get the signal from `.search-complete-heading` below --
          this exists purely for the screen-reader half of "noticeable".

          DISCLOSED LIMIT (review F4): this region sits inside App.tsx's
          `<div hidden={activeTab !== "search"}>`, so a completion that lands
          while the user is on another tab is never announced -- and switching
          back reveals it already populated, which is the same
          non-announcement. Accepted, not overlooked: it is exactly what a
          SIGHTED user on another tab gets too, and it matches the stance the
          "View N results" button's own comment already takes about hidden
          tabs. The button documented that; this region did not, which is the
          only thing being fixed here. */}
      <p className="search-flow-live visually-hidden" aria-live="polite">
        {phase.kind === "done" && phase.result.status === "complete"
          ? `Search complete${phase.result.degraded ? " with some failures" : ""}.`
          : ""}
      </p>
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
            Get estimate
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
          {/* Ticket bf2dd0a: "N of M sources checked" once the first
              progress poll lands, instead of leaving the wait a bare
              spinner the whole time — this is the literal complaint
              ("I don't know if I sent you on any of this") this ticket
              exists to fix. `total > 0` guards the brief window where a
              progress record exists but hasn't resolved a source count yet;
              `phase.progress` itself stays `undefined` until the first poll
              response lands at all. */}
          {phase.progress !== undefined && phase.progress.total > 0 && (
            <span className="estimating-progress">
              {" "}
              ({phase.progress.completed} of {phase.progress.total} source
              {phase.progress.total === 1 ? "" : "s"} checked)
            </span>
          )}
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
            {phase.estimate.alreadyScored > 0 && (
              <>
                <dt>Already scored (free, reused)</dt>
                <dd>{phase.estimate.alreadyScored}</dd>
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
          {/* Ticket 2e7ba8a: the "of M" denominator started reading the
              live, durable `linked` count from GET /searches/:id instead
              of always showing the pre-run estimate's `jobCount` (see the
              `Phase` type's `linked` doc comment above) — previously this
              read `phase.estimate.costEstimate.jobCount` for the whole run,
              which F4 (review round, ticket 1998875) already noted could
              read e.g. "12 of 10" once the real run re-fetched sources and
              found more or fewer postings than the estimate had.

              Ticket 4146881: switching straight to the live `linked` count
              the moment it's defined was itself a bug, not just a display
              choice — `linked` isn't a total, it's a partial count that
              climbs from 0 toward the eventual total as EACH selected
              source's fetch/ingest lands, one at a time. Nicole, watching a
              live run: "I did just see four of four of four scored so
              far, and then it went up to five of seven" — one source
              landing made it read "4 of 4" (looks finished), then a second
              source landing made it "5 of 7" (looks like it regressed),
              even though nothing was wrong. `Math.max` against the
              estimate's `jobCount` fixes exactly that: the shown
              denominator stays pinned at the estimate's number for the
              entire normal case (`linked` grows toward it, never past it,
              until every source has reported), and only grows past it if
              the real run genuinely finds MORE postings than the estimate
              predicted — F4's original divergence still shows, just once
              it's a real, final divergence rather than an artifact of
              `linked` still being partially populated. This only changes
              what's DISPLAYED: `phase.linked` itself, and the
              out-of-order-poll `Math.max` guard that protects it in
              `poll()` above, are untouched. */}
          <p>
            {phase.scoredSoFar} of{" "}
            {Math.max(phase.estimate.costEstimate.jobCount, phase.linked ?? 0)} scored so far.
          </p>
          {phase.stalledSince && (
            <p className="search-stalled-note" role="alert">
              This search has been stuck since {new Date(phase.stalledSince).toLocaleString()} and
              won't resolve on its own — it needs to be replayed from the dead-letter queue.
            </p>
          )}
          <SearchSourceStatusList sources={phase.sources} />
        </div>
      )}

      {phase.kind === "done" && (
        <div className="cost-panel done" aria-label="Search finished">
          {phase.result.status === "complete" ? (
            <>
              {/* Ticket 2e7ba8a: real polish on top of ticket 4f88339's
                  minimal compile-fix (commit b39550a) -- that fix got the
                  panel back to reading the real queue-driven fields
                  (scored/failed/linked/sources) with a plain inline
                  listing; this replaces it with per-source status badges
                  (SearchSourceStatusList, below) and an honest `degraded`
                  note instead of just a heading suffix.
                  Ticket d37511b removed the "Permanently failed" dt/dd row
                  and the "Deferred this run (over the cap)" row this used
                  to also render -- Jay's testing session found both
                  incomprehensible, and the scoring cap `cappedForBudget`
                  used to report on is gone outright (see
                  matching/pipeline.ts's "EVERY CANDIDATE GETS SCORED"
                  comment).
                  RESTORED A COUNT (adversarial review, same ticket): the
                  first draft of this note dropped the number entirely,
                  on the reasoning that "permanently failed" bookkeeping
                  was exactly what Jay found confusing. Review correctly
                  called that out as a real regression in a different
                  direction -- without ANY number, a search that scored
                  320 of 800 reads as "Scored: 320" / "Total jobs found:
                  800" with "some jobs failed" and nothing to say how many
                  of the missing 480 that accounts for (the rest could be
                  still-pending, if this were mid-flight, except it isn't
                  -- the ambiguity is the problem). That distinction
                  matters more now than it did before this ticket: a
                  `scoreJobWorker` spend-guard stall can now plausibly
                  produce a large `failed` count on its own (see that
                  file's own doc comment on why), and it must read as
                  distinguishable from "a handful of jobs individually
                  failed," not folded into one vague sentence. `failed`
                  is already a plain field on `SearchStatusResponse` --
                  showing it is not the forbidden replacement guard (it
                  adds no limit and defers nothing); it restores the
                  diagnosability the ticket asked to KEEP ("remove the
                  surface, not the ability to diagnose"), same as the
                  per-source `errorKind`/`errorMessage` detail already
                  shown below for a dead-lettered source. */}
              {/* Ticket 9e5fcf3 (part (a)). Nicole, relaying John's testing:
                  "he was often just waiting there and didn't realize it was
                  complete... I had to keep telling John to scroll down."
                  Two separate problems, two separate fixes on this one
                  line and the button right after it:

                  NOTICEABLE, for a SIGHTED user: `.search-complete-heading`
                  (index.css) gives this `<h3>` a visibly distinct green,
                  bolder treatment -- the plain `<h3>` before this ticket
                  read identically to every other heading on screen, which
                  is exactly "renders as a heading change" Nicole's report
                  named as not noticeable enough.

                  NOTICEABLE, for a SCREEN READER user: NOT handled on this
                  element. Two things ruled out `aria-live`/`role="status"`
                  living directly on this `<h3>`, each found and fixed in
                  its own round of review (see the persistent live region
                  mounted at the top of this component's `return`, right
                  after `<div className="search-flow">`, for the actual
                  fix and the full story of both):
                    1. `role="status"` overrides this element's implicit
                       heading role entirely -- confirmed by a real
                       regression (SearchFlow.test.tsx's own
                       `getByRole("heading", { name: "Search complete" })`
                       went red the moment this was tried, green once
                       reverted to a plain `<h3>`).
                    2. `aria-live="polite"` directly here doesn't actually
                       announce anything: this whole branch only exists
                       while `phase.kind === "done"`, so the attribute and
                       its content both enter the DOM in the SAME mutation
                       -- the exact mistake opus review N7 already found
                       once on this codebase (MagicLinkForm.tsx's own
                       comment: "A region inserted together with its own
                       content is not announced by most screen readers").

                  REACHABLE WITHOUT HUNTING: the "View N results" button
                  right after it, scrolling to the results section App.tsx
                  owns (`onViewResults`) -- argued over auto-scrolling
                  straight to the results the moment this phase is entered:

                  Auto-scroll DOES complete the action the user initiated,
                  which is a real point in its favor, but it fires from
                  `poll()` -- a background interval tick, not a click -- so
                  "the moment this phase is entered" can land while the
                  user has scrolled away to reread something above (editing
                  criteria for next time, say), or even while this whole
                  tab is `hidden` (App.tsx keeps SearchFlow mounted and
                  polling under "Already Scored Jobs"/"My Resumes" too --
                  see its own comment on why). Hijacking the user's scroll
                  position out from under them the instant a background
                  poll resolves is the "hostile if they've scrolled away
                  meanwhile" case this ticket's own notes warn about, and a
                  `scrollIntoView` fired against a `display: none` ancestor
                  (the hidden-tab case) is either a silent no-op or, on some
                  engines, a scroll that only becomes visible later when the
                  user switches tabs for an unrelated reason -- neither is
                  an improvement over doing nothing.

                  An explicit button sidesteps both failure modes for free,
                  not just in principle: it only exists inside this
                  `hidden`-toggled tab panel (App.tsx's `<div hidden=
                  {activeTab !== "search"}>` wraps this whole component), so
                  while the tab is hidden the button is non-interactive and
                  out of the a11y tree exactly like the rest of this panel
                  -- no guard code needed to keep a background completion
                  from doing anything to the screen the user is actually
                  looking at. And because the click is synchronous
                  (`scrollIntoView` runs in the same tick as the click), it
                  needs none of `activeTabRef`'s (ticket 11ead86)
                  "capture-then-compare" guard either -- that pattern exists
                  to protect an async action from a user who moved on DURING
                  the wait; there is no wait here for them to move on
                  during. The one real cost -- an extra click between
                  "notice completion" and "see results," versus zero for
                  auto-scroll -- is a small, bounded price for never
                  surprising a user who didn't ask to be moved. */}
              <h3 className="search-complete-heading">
                Search complete{phase.result.degraded ? " (with some failures)" : ""}
              </h3>
              {freshResultsCount !== undefined && freshResultsCount > 0 && (
                <button type="button" className="view-results-button" onClick={onViewResults}>
                  View {freshResultsCount} result{freshResultsCount === 1 ? "" : "s"}
                </button>
              )}
              {phase.result.degraded && (
                <p className="search-degraded-note" role="status">
                  {phase.result.failed} of {phase.result.linked} job
                  {phase.result.linked === 1 ? "" : "s"} couldn't be scored — retries were exhausted
                  or something else went wrong partway through. The rest of this search's results
                  are unaffected and ready below.
                </p>
              )}
              <dl>
                <dt>Scored</dt>
                <dd>{phase.result.scored}</dd>
                <dt>Total jobs found</dt>
                <dd>{phase.result.linked}</dd>
              </dl>
              <SearchSourceStatusList sources={phase.result.sources} />
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
