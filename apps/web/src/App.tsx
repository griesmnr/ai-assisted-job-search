import { useEffect, useMemo, useRef, useState } from "react";
import {
  MATCH_SCORE_FLOOR,
  type ScoredJobResult,
  type SearchCriteria,
  type UserJobStatus,
} from "@app/shared";
import { clearJobStatus, createResume, setJobStatus, updateResumeNickname } from "./api/client";
import {
  GroupedResultsList,
  groupKeyForStatus,
  type ScoredGroupKey,
} from "./components/GroupedResultsList";
import { ResultsList } from "./components/ResultsList";
import { ResumeInput } from "./components/ResumeInput";
import { ScoreFloorControl } from "./components/ScoreFloorControl";
import { SearchCriteriaForm } from "./components/SearchCriteriaForm";
import { SearchFlow } from "./components/SearchFlow";
import { SourceToggles } from "./components/SourceToggles";
import { useAllResults } from "./hooks/useAllResults";
import { useResults } from "./hooks/useResults";
import { useSources } from "./hooks/useSources";
import { clearAppState, readAppState, writeAppState, type CriteriaFormState } from "./session";
import { splitPhrases } from "./criteriaText";

/**
 * Ticket 09b8e4d, then ticket 8a403ee: some employers phrase job titles
 * differently enough that a resume-inferred title alone misses them --
 * USAJOBS' federal job-series names (Program Analyst, IT Specialist,
 * Computer Scientist) are the concrete case that motivated this, but
 * Nicole's own point (dogfooding, ticket 8a403ee) is that it isn't
 * strictly a federal/private-sector split -- Boeing uses "Program
 * Analyst"/"Programmer Analyst" too. Fixed list, not resume-derived
 * guessing (inferring title-equivalents from arbitrary resume content is
 * speculative NLP no ticket has asked for).
 *
 * Ticket 09b8e4d originally surfaced these as a separate "click to add"
 * suggestion row, shown only while USAJOBS was selected. Ticket 8a403ee
 * folds them directly into `titleChips` instead, unconditionally, at the
 * same moment resume-inferred titles populate it (`handleResumeSubmit`
 * below) -- Nicole, dogfooding: "you never know if somebody's going to
 * zone out" past a suggestion they had to notice and click. Deliberately
 * NOT re-synced to source-toggle state after that: her own explicit
 * simplification ("I don't want to build all the functionality for...
 * they should just behave the same as every other chips") -- added once,
 * then a fully ordinary, user-owned, removable chip like any other.
 */
const EXTRA_TITLE_CHIPS = ["Program Analyst", "IT Specialist", "Computer Scientist"];

/**
 * Derives the actual `SearchCriteria` to send from the current title chips
 * and the remaining plain-text fields (ticket 39b4a48, superseding ticket
 * 957bc22's undefined-vs-{} design).
 *
 * ALWAYS returns a real `SearchCriteria` object now, never `undefined` --
 * this is the deliberate fix for a real gap ticket 957bc22 left open.
 * `compileFilter` (apps/api/src/sources/criteria.ts) treats `undefined` as
 * "reproduce the OLD hardcoded software-engineering default" (including
 * ticket 6b2313a's staff-level title exclusion) and a real object,
 * even `{}`, as "no title restriction beyond what's actually specified."
 * Nicole was explicit that the old default must never come back silently:
 * "I'd rather have it be a really expensive search offered than a blind
 * default." Zero title chips now means a real, visible "search every
 * title" state (an empty `titleInclude` is simply omitted from the
 * object, which is what "no restriction" already means to compileFilter)
 * -- never a silent fallback to the hidden default a user never chose.
 */
function buildSearchCriteria(form: CriteriaFormState & { titleChips: string[] }): SearchCriteria {
  const nearLocations = splitPhrases(form.nearLocations);
  const criteria: SearchCriteria = {};
  if (form.titleChips.length > 0) criteria.titleInclude = form.titleChips;
  if (nearLocations.length > 0) criteria.nearLocations = nearLocations;
  if (form.remoteOk) criteria.remoteOk = true;
  if (form.commitmentIn.length > 0) criteria.commitmentIn = form.commitmentIn;
  return criteria;
}

/**
 * The whole v1 product screen (ticket 484889d — see its git-bug for the
 * full decision history this implements):
 *
 *   1. Paste a resume -> POST /resumes.
 *   2. Toggle sources -> filters the (already fetched) scored corpus
 *      instantly, client-side. Never triggers a fetch (decision #3).
 *   3. Explicit "Estimate search cost" / "Run search" flow (SearchFlow) ->
 *      the only place this app spends money, and only on confirm
 *      (decision #4).
 *   4. Curated results list, floor-applied with a stated hidden count, per
 *      job status controls (decision #1/#2). The floor itself is user-
 *      adjustable (ticket ffbf9fb's `ScoreFloorControl`, one shared value
 *      for both tabs) -- unlike the source toggles above, moving it
 *      re-fetches `GET /resumes/:id/results` at the new `?minScore=`
 *      (useResults.ts), since a lower floor can surface jobs the server
 *      never sent to the client at the old one.
 *
 * Single-user, no accounts, no login (decision #2 on the 2026-08-29
 * comment) -- there is exactly one implicit "user" and no session/auth
 * concept anywhere in this file or the API it talks to.
 */
type Tab = "search" | "scored";

function App() {
  const sourcesState = useSources();
  // Ticket f4a7f07: "New Job Search" and "Already Scored Jobs". Nicole,
  // after several rounds of thinking out loud, settled on exactly these
  // two -- no saved/other sub-split yet ("I haven't figured that out
  // yet"), and moving results out of the main flow entirely is itself the
  // fix for a separate thing she flagged: previously-scored results
  // appearing inline the moment a resume is pasted, before any new search
  // runs, read as "jarring... old stuff".
  const [activeTab, setActiveTab] = useState<Tab>("search");
  // Ticket 3f05144: read ONCE, at first render, before any state below is
  // initialized. A reload is indistinguishable from a first visit from
  // inside React, so restoring has to happen in the state initializers
  // themselves — an effect that re-set this state after mount would race
  // the effects that clear/derive it (the "default every configured source
  // to selected" effect below, in particular) and could be seen by the
  // user as a visible flash of the empty state.
  const [restored] = useState(readAppState);
  const [resumeId, setResumeId] = useState<string | undefined>(restored?.resumeId);
  // Held here, not only inside ResumeInput, so a reload can put the pasted
  // text back in the box. Nicole's report led with exactly this ("it was
  // all clear again"), and a restored resumeId with an empty paste box
  // would read as a half-restored app.
  const [resumeText, setResumeText] = useState(restored?.resumeText ?? "");
  const [resumeSubmitting, setResumeSubmitting] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // Ticket ac141d0: true while ResumeInput shows its full expanded form
  // for a resume that already exists (i.e. the user clicked "Edit" on
  // the collapsed summary bar). Deliberately NOT derived from `resumeId`
  // -- see ResumeInput.tsx's top-of-file doc comment for why conflating
  // the two reproduced ticket 3f05144 back in cdc2c39. Also gates the
  // sources/criteria/search section below (ac141d0: hide those while
  // editing). Not persisted: a mid-edit reload should land back in the
  // collapsed, last-submitted-state view, not stay expanded with stale
  // text sessionStorage never captured anyway (ResumeInput's `text` is
  // its own uncommitted local state, never written out).
  const [resumeEditing, setResumeEditing] = useState(false);
  // Ticket 38a7598: "Resume 1"/"Resume 2"/... assigned by the server at
  // creation time (CreateResumeResponse.resumeNickname), or restored from a
  // prior reload. Empty string (not undefined) before any resume has been
  // submitted this session/reload -- ResumeInput's field isn't rendered at
  // all in that state (ticket 5a79aa4; gated on `resumeId`, not on this
  // being non-empty).
  const [resumeNickname, setResumeNickname] = useState(restored?.resumeNickname ?? "");
  // Ticket 38a7598 review fix: the last value the SERVER actually
  // confirmed (either a fresh `CreateResumeResponse.resumeNickname` or a
  // successful `PATCH /resumes/:id` response) -- tracked separately from
  // `resumeNickname` above, which also holds every uncommitted keystroke
  // while the user is typing. Without this distinction there was no value
  // to fall back to: an empty-trim commit returned early AFTER
  // `handleNicknameChange` had already pushed the empty string into
  // `resumeNickname` (and from there into sessionStorage), leaving the UI
  // blank, sessionStorage blank, and the server's real nickname untouched
  // -- three different values with no way to reconcile them. Same problem
  // after a FAILED PATCH: the bad/attempted value stayed in `resumeNickname`
  // instead of reverting. Seeded from `restored` on reload as the best
  // available guess at "what the server last confirmed" (there is no
  // PATCH round-trip on a restore, so this can't be re-verified without a
  // network call this ticket doesn't add).
  const [lastSavedNickname, setLastSavedNickname] = useState(restored?.resumeNickname ?? "");
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(
    () => new Set(restored?.selectedSourceIds ?? []),
  );
  // Ticket 39b4a48: starts empty, populated from POST /resumes's real
  // suggestedTitles the moment a resume is submitted (handleResumeSubmit
  // below) -- never a hardcoded default.
  const [titleChips, setTitleChips] = useState<string[]>(restored?.titleChips ?? []);
  const [criteriaForm, setCriteriaForm] = useState<CriteriaFormState>(
    restored?.criteriaForm ?? {
      nearLocations: "",
      remoteOk: false,
      anyLocationOk: false,
      commitmentIn: [],
    },
  );
  // Ticket ffbf9fb: user-adjustable match-score floor, one shared value for
  // both tabs (not two independent ones) -- "my floor" is one setting, not
  // per-screen, and `MATCH_SCORE_FLOOR` was already a single global constant
  // before this ticket. Defaults to that same constant so behavior is
  // unchanged until the user actually moves the slider.
  const [scoreFloor, setScoreFloor] = useState<number>(restored?.scoreFloor ?? MATCH_SCORE_FLOOR);
  const criteria = useMemo(
    () => buildSearchCriteria({ titleChips, ...criteriaForm }),
    [titleChips, criteriaForm],
  );
  // Ticket b9e6251: an empty location (no nearLocations, no remoteOk) used
  // to mean "no restriction, search anywhere" SILENTLY -- the same shape
  // of never-explicitly-chosen default Nicole's own principle already
  // rejected for title keywords ("I'd rather have it be a really
  // expensive search offered than a blind default"). Now that state
  // requires the explicit `anyLocationOk` opt-in (SearchCriteriaForm's own
  // checkbox) before "Estimate search cost" is even reachable -- see the
  // `disableEstimate` prop passed to SearchFlow below.
  // Matches SearchCriteriaForm's own identical check (its warning text
  // depends on the same condition) -- both call the shared `splitPhrases`
  // (opus review F3): a plain `.trim().length > 0` test treats a lone ","
  // as a real signal (a non-empty string that actually splits to ZERO
  // real phrases), silently letting exactly the punctuation-only input
  // through that this ticket exists to stop. Real `splitPhrases` parsing
  // in both places, not a cheaper substitute, closes that gap while still
  // guaranteeing the two checks can't drift out of sync with each other.
  const hasLocationSignal =
    splitPhrases(criteriaForm.nearLocations).length > 0 ||
    criteriaForm.remoteOk ||
    criteriaForm.anyLocationOk;

  // Ticket 371713d: the cross-component link between "Estimate search
  // cost" (SearchFlow) and "the location section" (SearchCriteriaForm) --
  // real siblings, no parent/child relationship between them. App.tsx
  // already coordinates every other cross-sibling interaction in this file
  // (onEstimateStart clearing hasFreshSearchResults, onSearchComplete
  // triggering refresh, etc.), so this follows the same shape: a plain ref
  // object owned here, handed DOWN into SearchCriteriaForm to attach to the
  // DOM node, and read back here inside a callback handed DOWN into
  // SearchFlow. Neither sibling needs to know the other exists.
  const locationSectionRef = useRef<HTMLDivElement | null>(null);

  function handleInvalidEstimateAttempt() {
    locationSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Ticket 371713d, opus review F4: scrolling alone leaves DOM focus on
    // the "Estimate search cost" button itself, which sits AFTER this
    // section in DOM order -- a keyboard user tabbing onward from there
    // moves further away from the field that needs fixing, and a screen
    // reader user gets no re-announcement at all on a blocked attempt.
    // Moving real focus onto the location text input fixes both: Tab now
    // continues naturally from the location section, and most screen
    // readers announce the newly-focused input (including its
    // `aria-invalid`/label) on focus change. `locationSectionRef` already
    // wraps exactly one `<input>` (the commute-locations text field), so a
    // plain `querySelector` is simpler than adding a second, single-purpose
    // ref just for this.
    locationSectionRef.current?.querySelector("input")?.focus({ preventScroll: true });
  }

  const { state: resultsState, refresh } = useResults(resumeId, scoreFloor);
  // Ticket 3f0883f: "Already Scored Jobs" is the cross-resume browsable
  // history now, not the current resume's own results narrowed down --
  // its own, separately-fetched state, deliberately not derived from
  // `resultsState` above (which stays single-resume, feeding ONLY
  // "Results from this search"). See hooks/useAllResults.ts's own doc
  // comment for why it isn't gated on `resumeId` the way `useResults` is.
  const { state: allResultsState, refresh: refreshAllResults } = useAllResults(scoreFloor);

  // Ticket 0308d7e (Nicole, dogfooding ac141d0: "when I said I wanted
  // number, I wanted it in the tab itself... I want people to know that
  // there are already scored jobs there"): computed once here so the
  // "Already Scored Jobs" nav tab button and its own h2 heading (below)
  // can't drift apart -- EVERY scored job across every resume, shown or
  // not (a job hidden below the match-quality floor was still scored, and
  // still cost real money to score, so it counts here). Ticket 3f0883f:
  // now reads `allResultsState`, not `resultsState` -- the whole point of
  // this count is "how many scored jobs exist to browse," which stopped
  // meaning "for the current resume" once the tab itself did.  `undefined`
  // before there's real data to count (`allResultsState.status !==
  // "ready"`), not 0 -- both call sites treat that as "show no number yet"
  // rather than a misleading "(0)".
  const scoredJobCount =
    allResultsState.status === "ready"
      ? (allResultsState.data.totalMatchingCount ?? allResultsState.data.results.length) +
        (allResultsState.data.hiddenBelowFloor ?? 0)
      : undefined;

  // Ticket f4a7f07, refined live: "results should be reserved for results
  // from the most recent search... cleared every time a new search is
  // estimated or a filter is toggled, and they should only reappear when
  // the new search has come." This tracks whether the CURRENT tab's
  // results section should show anything at all -- it doesn't duplicate
  // the fetch (still reuses `resultsState.data` above, the same one
  // "Already Scored Jobs" reads), it just gates whether "New Job Search"
  // is currently allowed to display it. Reset to false by two effects
  // below (criteria/source change, and SearchFlow's onEstimateStart);
  // set true only by onSearchComplete, once a real run actually finishes.
  const [hasFreshSearchResults, setHasFreshSearchResults] = useState(false);

  useEffect(() => {
    setHasFreshSearchResults(false);
  }, [selectedSourceIds, criteria]);

  // Ticket 3f0883f: the snapshot below (and its fallback) used to key by
  // bare `jobId` -- safe only because a single resume's results can never
  // repeat a `jobId` (job_matches is UNIQUE(resume_id, job_id)). Now that
  // "Already Scored Jobs" spans every resume, the SAME jobId can appear
  // twice with two different groups (e.g. saved under one resume,
  // untouched under another) -- a bare-jobId Map would let the second
  // resume's entry silently clobber the first's. Same composite identity
  // GroupedResultsList.tsx uses for its own list keys, for the same reason.
  function scoredResultKey(r: { jobId: string; resumeId: string }): string {
    return `${r.jobId}-${r.resumeId}`;
  }

  // Ticket bec2f98: "Already Scored Jobs" group placement is a SNAPSHOT
  // taken when the tab is opened, not a live recompute on every render --
  // Nicole caught this herself: "if somebody clicks optimize resume on a
  // saved job, it's going to suddenly disappear... from that current
  // state." `handleSetStatus` below still calls `refresh()`/
  // `refreshAllResults()` on every status write (so a card's own badge/
  // actions update in place, via live `allResultsState.data`), but that
  // refetch must NOT itself reshuffle which group a card renders under --
  // only opening (or re-opening) this tab takes a new snapshot.
  //
  // Two effects because the snapshot needs BOTH "the tab just became
  // active" and "data is actually ready" to fire, and those don't
  // necessarily land on the same render (data can still be loading the
  // instant the tab opens). `snapshotPendingRef` bridges them: the first
  // effect (keyed only on `activeTab`) arms it exactly once per tab-open;
  // the second effect (keyed on `[activeTab, allResultsState]`, so it
  // re-runs on every refetch too) only actually captures a new snapshot
  // while the flag is armed, then disarms it -- a later refetch from a
  // status write re-runs this effect but does nothing, since the flag is
  // already false.
  const [scoredGroupSnapshot, setScoredGroupSnapshot] = useState<Map<
    string,
    ScoredGroupKey
  > | null>(null);
  const scoredSnapshotPendingRef = useRef(false);

  useEffect(() => {
    if (activeTab === "scored") scoredSnapshotPendingRef.current = true;
  }, [activeTab]);

  useEffect(() => {
    if (
      activeTab === "scored" &&
      scoredSnapshotPendingRef.current &&
      allResultsState.status === "ready"
    ) {
      const snapshot = new Map(
        allResultsState.data.results.map(
          (r) => [scoredResultKey(r), groupKeyForStatus(r.status)] as const,
        ),
      );
      setScoredGroupSnapshot(snapshot);
      scoredSnapshotPendingRef.current = false;
    }
  }, [activeTab, allResultsState]);

  // Fallback covers a job the snapshot has never seen (e.g. a fresh search
  // landed new jobs while already on this tab, before the next open
  // re-snapshots) -- it gets a live-computed group rather than being
  // silently dropped.
  function scoredGroupFor(result: ScoredJobResult): ScoredGroupKey {
    return scoredGroupSnapshot?.get(scoredResultKey(result)) ?? groupKeyForStatus(result.status);
  }

  // Default every CONFIGURED source to selected the first time the source
  // list loads, so the first thing a user sees isn't an empty toggle set
  // they have to fill in themselves. An unconfigured source is never
  // auto-selected -- it doesn't even appear in the toggle list (ticket
  // d480357: SourceToggles drops unconfigured entries before rendering).
  //
  // Ticket 3f05144: skipped entirely when a selection was restored from
  // this tab's session, even if that selection is EMPTY. "I unchecked
  // every source" is a real state the user chose, and the `prev.size > 0`
  // check alone cannot tell it apart from "nothing has been chosen yet" —
  // so after a reload the defaults would silently check every source back
  // on, which is worse than starting over: it is starting over while
  // looking like it didn't.
  const restoredSourceSelectionRef = useRef(restored !== undefined);

  useEffect(() => {
    if (sourcesState.status !== "ready") return;
    if (restoredSourceSelectionRef.current) return;
    setSelectedSourceIds((prev) => {
      if (prev.size > 0) return prev;
      return new Set(sourcesState.sources.filter((s) => s.configured).map((s) => s.id));
    });
  }, [sourcesState]);

  // Ticket 3f05144: the single writer of the app-state record. Mirrors
  // SearchFlow's own persist effect (one writer, keyed on the state it
  // persists) for the same reason.
  //
  // Gated on `resumeId`: with no resume there is nothing worth restoring —
  // the app's initial screen IS the empty state — and writing a record
  // then would only give a reload a way to resurrect stale toggles under a
  // blank resume box.
  useEffect(() => {
    if (resumeId === undefined) {
      clearAppState();
      return;
    }
    writeAppState({
      resumeId,
      resumeText,
      // Ticket 38a7598 review fix (round 2): persist `lastSavedNickname`
      // (the last value the SERVER confirmed), not `resumeNickname` (which
      // can hold uncommitted keystrokes mid-edit). Persisting the live
      // input value meant typing without blurring, then reloading, seeded
      // `lastSavedNickname` itself from that never-sent text on restore --
      // after which the unchanged-value no-op check (ticket 38a7598 fix 4)
      // would treat the real, server-side value as already saved and skip
      // every future PATCH for it, silently freezing the divergence rather
      // than self-healing on the next blur.
      resumeNickname: lastSavedNickname,
      selectedSourceIds: [...selectedSourceIds],
      titleChips,
      criteriaForm,
      scoreFloor,
    });
  }, [
    resumeId,
    resumeText,
    lastSavedNickname,
    selectedSourceIds,
    titleChips,
    criteriaForm,
    scoreFloor,
  ]);

  function toggleSource(sourceId: string) {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }

  async function handleResumeSubmit(resumeText: string) {
    setResumeSubmitting(true);
    setResumeError(null);
    try {
      const {
        id,
        suggestedTitles,
        resumeNickname: defaultNickname,
      } = await createResume(resumeText);
      setResumeId(id);
      // Captured on SUBMIT, not on every keystroke (ticket 3f05144): the
      // text worth restoring is the text that actually produced this
      // resumeId, and persisting a half-typed draft on each character
      // would be a write per keystroke for no benefit.
      setResumeText(resumeText);
      // Ticket 38a7598: the server's real default ("Resume N") or, for a
      // resubmission of already-existing text, that resume's real
      // (possibly already-renamed) nickname -- never invented client-side.
      setResumeNickname(defaultNickname);
      // Review fix: this IS a server-confirmed value (it came straight off
      // this response), so it's also the new "last known-good" baseline a
      // later empty-trim or failed commit should revert back to.
      setLastSavedNickname(defaultNickname);
      setNicknameError(null);
      // Defensive, not just decorative: an older cached client build, a
      // test fixture written before this field existed, or any future API
      // response shape drift should degrade to "no suggestions" rather
      // than crash buildSearchCriteria's `.length` check below.
      const inferredTitles = suggestedTitles ?? [];
      // Ticket 8a403ee: EXTRA_TITLE_CHIPS appended AFTER the resume-
      // inferred ones (Nicole: "add the chips... after all of the other
      // ones"), case-insensitively deduped against them so a resume whose
      // own inferred titles already include e.g. "IT Specialist" doesn't
      // get a visually-duplicate chip. Runs on every successful submit,
      // not just the first -- same lifecycle `inferredTitles` itself
      // already has (a resubmit already fully replaces titleChips from
      // the server's fresh suggestedTitles; this follows that same reset,
      // per Nicole's "behave the same as every other chip").
      const inferredLower = new Set(inferredTitles.map((t) => t.toLowerCase()));
      const extras = EXTRA_TITLE_CHIPS.filter((t) => !inferredLower.has(t.toLowerCase()));
      setTitleChips([...inferredTitles, ...extras]);
      // Review fix round 2 (ticket cdc2c39): an edit is only "done" once
      // a submission actually lands -- not on the Edit click itself (see
      // `resumeEditing`'s own doc comment above). A no-op on the
      // first-ever submission, where this was already false.
      setResumeEditing(false);
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : String(err));
    } finally {
      setResumeSubmitting(false);
    }
  }

  // Ticket 38a7598: fires on every keystroke in ResumeInput's nickname
  // field -- purely local/session state, no network call (mirrors
  // `session.ts`'s own "don't write per keystroke" reasoning, applied here
  // to "don't PATCH per keystroke" instead). `handleNicknameCommit` below
  // is what actually persists it.
  function handleNicknameChange(nextNickname: string) {
    setResumeNickname(nextNickname);
  }

  // Fires on blur (or Enter -- ResumeInput.tsx). A no-op (no PATCH, no
  // error, no refetch) for a value that's UNCHANGED from what the server
  // last confirmed -- checked against `lastSavedNickname`, not against
  // whatever `resumeNickname` currently holds, since those two can differ
  // (see `lastSavedNickname`'s own doc comment above). This is also a
  // no-op for a whitespace-only value, matching the server's own rejection
  // of an empty nickname (routes/resumes.ts) -- but unlike the old
  // behavior, it REVERTS the local `resumeNickname` state back to
  // `lastSavedNickname` first (ticket 38a7598 review fix): before this,
  // `handleNicknameChange` had already pushed the empty string into
  // `resumeNickname` (and from there into sessionStorage) by the time this
  // function ran, so the field went blank locally while the server's real
  // nickname was untouched -- with no feedback that anything had gone
  // wrong. Same revert on a FAILED PATCH: the attempted value must not
  // stay parked in local state as though it had taken effect.
  async function handleNicknameCommit(nextNickname: string) {
    if (resumeId === undefined) return;
    const trimmed = nextNickname.trim();
    if (trimmed === lastSavedNickname) return;
    if (trimmed.length === 0) {
      setResumeNickname(lastSavedNickname);
      return;
    }
    setNicknameSaving(true);
    setNicknameError(null);
    try {
      const { resumeNickname: saved } = await updateResumeNickname(resumeId, trimmed);
      setResumeNickname(saved);
      setLastSavedNickname(saved);
      refresh();
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : String(err));
      setResumeNickname(lastSavedNickname);
    } finally {
      setNicknameSaving(false);
    }
  }

  // Ticket ac141d0: fires from the collapsed summary bar's "Edit". Sets
  // `resumeEditing`, not `resumeId` -- see that state's own doc comment
  // above for why (cdc2c39's round-2 lesson: conflating the two wiped
  // sessionStorage on every edit). `resumeId` itself is untouched, so
  // SearchFlow stays MOUNTED and an in-flight search keeps polling --
  // sources/criteria/search only go `hidden` (review fix: an earlier
  // version of this diff unmounted that whole block instead, which
  // silently killed the poll with no way back; see the `hidden`
  // wrapper's own comment below for the full story). Clears any stale
  // nickname-PATCH AND resume-submission error since the user is about
  // to change what's in the box -- review round 2 (N1): without the
  // latter, a failed resubmit's error message could survive an Edit ->
  // Cancel round trip and sit, stale, under the collapsed bar.
  function handleEditResume() {
    setResumeEditing(true);
    setNicknameError(null);
    setResumeError(null);
  }

  // Review fix (ticket ac141d0): the escape hatch ResumeInput's "Cancel"
  // needs -- see its own doc comment for why it exists (clearing the
  // textarea mid-edit was otherwise a genuine dead end, with no Edit
  // button in that branch and, now, sources/criteria/search hidden
  // too). Only sets `resumeEditing` back to false; `resumeId`,
  // `resumeNickname`, `resumeText` are all untouched -- this is a
  // discard, not a submit, so nothing about the resume actually changes.
  // Also clears a stale resume-submission error (review round 2, N1): a
  // failed resubmit shows "Could not save resume: ..." while expanded;
  // giving up via Cancel rather than fixing and resubmitting shouldn't
  // leave that error sitting, orphaned, under the collapsed bar.
  function handleCancelEdit() {
    setResumeEditing(false);
    setResumeError(null);
  }

  // Review fix, ticket 3f0883f: `resumeId` is now a REQUIRED parameter,
  // supplied by the caller (ResultCard, via `result.resumeId`) -- not
  // this function closing over the session's own active `resumeId`
  // state. Same bug class the "Optimize Resume" handoff had and was
  // fixed for (see ResultCard.tsx's doc comment on `onSetStatus`): once
  // a card on "Already Scored Jobs" can belong to a DIFFERENT resume
  // than whatever's active this session (or none at all), writing the
  // session's `resumeId` into `user_job_statuses.resume_id` would
  // silently attribute the status to the wrong resume -- or NULL, on a
  // tab this ticket newly makes reachable with no active resume at all.
  async function handleSetStatus(jobId: string, status: UserJobStatus, resumeId: string) {
    await setJobStatus(jobId, status, resumeId);
    refresh();
    // Ticket 3f0883f: a status write must also update the cross-resume
    // "Already Scored Jobs" view, not just "Results from this search" --
    // a job can be visible in both (or only the former, once a card
    // belongs to a resume that isn't the current session's active one).
    refreshAllResults();
  }

  async function handleClearStatus(jobId: string) {
    await clearJobStatus(jobId);
    refresh();
    refreshAllResults();
  }

  function handleSearchComplete() {
    refresh();
    // The one place `hasFreshSearchResults` is ever set true — SearchFlow
    // only calls onSearchComplete when a run's poll result.status is
    // literally "complete" (never on "failed"/"incomplete"), so this is a
    // genuine successful run, not a speculative or partial one.
    setHasFreshSearchResults(true);
  }

  return (
    <main className="app">
      <h1>AI-Assisted Job Search</h1>

      <nav className="tab-nav" aria-label="Sections">
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "search"}
          onClick={() => setActiveTab("search")}
        >
          New Job Search
        </button>
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "scored"}
          onClick={() => setActiveTab("scored")}
        >
          Already Scored Jobs
          {scoredJobCount !== undefined && ` (${scoredJobCount})`}
        </button>
      </nav>

      {/* Ticket f4a7f07: both tabs stay MOUNTED at all times -- only
          `hidden` (the DOM attribute, not conditional rendering) toggles
          which one shows. This is deliberate and tied to ticket 3f05144
          (in-progress state silently lost on tab-discard/background): if
          switching tabs unmounted SearchFlow, an in-progress cost estimate
          or a running search's poll would be destroyed by the mere act of
          checking the other tab, which is exactly the kind of state loss
          Nicole flagged as a real problem. `hidden` keeps every hook
          (useSources, useResults) and every child component's internal
          state alive underneath, regardless of which tab is visible. */}
      <div hidden={activeTab !== "search"}>
        <section className="resume-section">
          <ResumeInput
            onSubmit={(text) => void handleResumeSubmit(text)}
            submitting={resumeSubmitting}
            initialText={resumeText}
            resumeId={resumeId}
            nickname={resumeNickname}
            onNicknameChange={handleNicknameChange}
            onNicknameCommit={(next) => void handleNicknameCommit(next)}
            nicknameSaving={nicknameSaving}
            nicknameError={nicknameError}
            editingResume={resumeEditing}
            onEditResume={handleEditResume}
            onCancelEdit={handleCancelEdit}
          />
          {/* Ticket 0308d7e: the "Resume ready." paragraph that used to
              sit here is gone -- Nicole, dogfooding ac141d0: "I don't
              think we need the resume-ready words anymore." Redundant
              once the collapsed "Using Resume N" bar (ac141d0) already
              says the same thing. */}
          {resumeError && <p role="alert">Could not save resume: {resumeError}</p>}
        </section>

        {/* Ticket ac141d0: `hidden`, not conditional rendering -- an
            earlier version of this fix used `{resumeId && !resumeEditing
            && (...)}`, which UNMOUNTS this whole block (SearchFlow
            included) while editing. Review caught that this silently
            kills an in-flight search's poll with no way back (the exact
            hazard the tab-switch comment above this one already
            documents and defends against for the SAME component, via the
            SAME `hidden` pattern) -- worse, clicking Edit during
            SearchFlow's brief "starting" phase (between POST /searches
            and its first successful response) orphans the run entirely:
            SearchFlow's own persist effect deliberately doesn't write a
            sessionStorage record for that phase (see its own comment),
            so there's nothing to re-adopt on remount, AND the polling
            interval `enterRunning` schedules fires anyway on the by-then
            -unmounted component, with nothing left able to ever clear
            it. `hidden` keeps SearchFlow mounted the whole time (its
            poll keeps running, exactly like an active tab-switch), while
            still visually and from-the-a11y-tree removing it -- which is
            what actually closes cdc2c39 review's F10 (a real, paid
            search running against a resume that's no longer on screen):
            the user can't SEE or touch it while editing, but it isn't
            silently destroyed either. Selections underneath
            (selectedSourceIds, criteriaForm, titleChips) were always
            untouched by this either way. */}
        {resumeId && (
          <div hidden={resumeEditing}>
            <section className="sources-section">
              <h2>Which sources do you want to search?</h2>
              {sourcesState.status === "loading" && <p>Loading sources...</p>}
              {sourcesState.status === "error" && (
                <p role="alert">Could not load sources: {sourcesState.message}</p>
              )}
              {sourcesState.status === "ready" && (
                <SourceToggles
                  // SourceToggles itself filters out `configured: false`
                  // sources (ticket d480357) -- that invariant lives in the
                  // component, not here, so it holds regardless of what a
                  // caller passes. `checkSourceHealth` (GET /sources) is
                  // unchanged and still reports every seeded source,
                  // including unconfigured ones, for a possible future
                  // admin/debug view.
                  sources={sourcesState.sources}
                  selected={selectedSourceIds}
                  onToggle={toggleSource}
                />
              )}
            </section>

            <section className="criteria-section">
              <h2>Narrow your search</h2>
              <SearchCriteriaForm
                titleChips={titleChips}
                nearLocations={criteriaForm.nearLocations}
                remoteOk={criteriaForm.remoteOk}
                anyLocationOk={criteriaForm.anyLocationOk}
                commitmentIn={criteriaForm.commitmentIn}
                locationSectionRef={locationSectionRef}
                onTitleChipsChange={setTitleChips}
                onChange={setCriteriaForm}
              />
            </section>

            <section className="search-section">
              <h2>Find new matches</h2>
              <p className="search-pitch">
                This isn't a keyword search. Claude actually reads your resume against each job
                description, one at a time, and judges how well you'd really fit — that real reading
                is what the cost below pays for.
              </p>
              <SearchFlow
                resumeId={resumeId}
                sourceIds={[...selectedSourceIds]}
                criteria={criteria}
                disableEstimate={!hasLocationSignal}
                onEstimateStart={() => setHasFreshSearchResults(false)}
                onInvalidEstimateAttempt={handleInvalidEstimateAttempt}
                onSearchComplete={handleSearchComplete}
              />
            </section>

            {/* Ticket f4a7f07, refined live: this section shows ONLY the
                most recent search's results, and ONLY once one has
                actually completed since the last estimate/filter change --
                never previously-scored jobs left over from before. That's
                the deliberate distinction from "Already Scored Jobs"
                below: "there should be a distinction between these are
                the results of this current search, and they're not going
                to randomly populate with old stuff." Reuses the same
                `resultsState.data` fetch as the other tab (no duplicate
                request) -- `hasFreshSearchResults` just gates whether
                THIS section is allowed to show it right now. Ticket
                bec2f98: that shared fetch now uses `includeDismissed:
                true` (useResults.ts), so a dismissed job from a fresh
                search shows up here too, visibly marked "Dismissed" via
                ResultCard's existing status pill -- no change needed in
                this component beyond the data it's handed. */}
            {hasFreshSearchResults && resultsState.status === "ready" && (
              <section className="results-section">
                <h2>Results from this search</h2>
                <ScoreFloorControl value={scoreFloor} onChange={setScoreFloor} />
                {resultsState.data.results.length > 0 ||
                (resultsState.data.hiddenBelowFloor ?? 0) > 0 ? (
                  <ResultsList
                    data={resultsState.data}
                    selectedSourceIds={selectedSourceIds}
                    onSetStatus={handleSetStatus}
                    onClearStatus={handleClearStatus}
                  />
                ) : (
                  <p>No jobs matched this search.</p>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      <div hidden={activeTab !== "scored"}>
        <section className="results-section">
          {/* Nicole, dogfooding: a bare "Results" heading here read as a
              stray leftover (the tab button itself already says "Already
              Scored Jobs"). Ticket 0308d7e: the count itself moved into
              that same tab button (see `scoredJobCount`'s own comment
              above for what it counts and why) -- kept here too,
              deliberately, per Nicole's own "why not, let's just leave it
              there" when asked if the duplication was fine. */}
          <h2>
            Already Scored Jobs
            {scoredJobCount !== undefined && ` (${scoredJobCount})`}
          </h2>
          {/* Ticket 3f0883f: no longer gated on `resumeId` -- this tab is
              the cross-resume browsable history now, and "no resume active
              THIS session" is not the same question as "has anything ever
              been scored." The old "Paste a resume in 'New Job Search'..."
              placeholder is gone with it: an empty `allResultsState` (truly
              nothing ever scored) already renders "No jobs scored yet."
              below, which is the correct message either way. */}
          <ScoreFloorControl value={scoreFloor} onChange={setScoreFloor} />
          {allResultsState.status === "loading" && <p>Loading results...</p>}
          {allResultsState.status === "error" && (
            <p role="alert">Could not load results: {allResultsState.message}</p>
          )}
          {allResultsState.status === "ready" &&
            (allResultsState.data.results.length > 0 ||
            (allResultsState.data.hiddenBelowFloor ?? 0) > 0 ? (
              <GroupedResultsList
                data={allResultsState.data}
                selectedSourceIds={selectedSourceIds}
                groupFor={scoredGroupFor}
                onSetStatus={handleSetStatus}
                onClearStatus={handleClearStatus}
              />
            ) : (
              // Ticket f4a7f07: unlike ticket 093d9fe's inline-surprise
              // reasoning (hide entirely so an unrequested empty section
              // doesn't read as broken), this tab is somewhere Nicole
              // deliberately navigates TO -- a silently blank panel here
              // would itself read as broken, so an explicit "nothing yet"
              // message is the right call in this location specifically.
              <p>No jobs scored yet.</p>
            ))}
        </section>
      </div>
    </main>
  );
}

export default App;
