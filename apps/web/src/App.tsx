import { useEffect, useMemo, useRef, useState } from "react";
import {
  MATCH_SCORE_FLOOR,
  type ScoredJobResult,
  type SearchCriteria,
  type UserJobStatus,
} from "@app/shared";
import {
  clearJobStatus,
  createResume,
  getResume,
  setJobStatus,
  updateResumeNickname,
} from "./api/client";
import {
  GroupedResultsList,
  groupKeyForStatus,
  type ScoredGroupKey,
} from "./components/GroupedResultsList";
import { MyResumes, type FocusResume } from "./components/MyResumes";
import { ResultsList } from "./components/ResultsList";
import { ResumeInput } from "./components/ResumeInput";
import { ScoreFloorControl } from "./components/ScoreFloorControl";
import { SearchCriteriaForm } from "./components/SearchCriteriaForm";
import { SearchFlow } from "./components/SearchFlow";
import { SourceToggles } from "./components/SourceToggles";
import { useAllResults } from "./hooks/useAllResults";
import { useResults } from "./hooks/useResults";
import { useResumesList } from "./hooks/useResumesList";
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
 * Ticket 88f11d7: factored out of `handleResumeSubmit` so
 * `handleActivateResume` ("Change" -> "Use Resume N") can build the exact
 * same title-chip set from a DIFFERENT response shape
 * (`GetResumeResponse.suggestedTitles` instead of `CreateResumeResponse.
 * suggestedTitles`) without the two call sites drifting out of sync. Same
 * "resume-inferred titles, then EXTRA_TITLE_CHIPS appended, case-
 * insensitively deduped against them" behavior either way (ticket 8a403ee).
 */
function mergeTitleChips(inferredTitles: string[]): string[] {
  const inferredLower = new Set(inferredTitles.map((t) => t.toLowerCase()));
  const extras = EXTRA_TITLE_CHIPS.filter((t) => !inferredLower.has(t.toLowerCase()));
  return [...inferredTitles, ...extras];
}

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
/**
 * True when `err` is the `409` `PATCH /resumes/:id` answers a nickname
 * collision with (ticket 7701534, `UpdateResumeNicknameConflictError` in
 * @app/shared). Structural, not `instanceof ApiError` -- same reasoning as
 * SearchFlow.tsx's `apiErrorStatus`/`inFlightSearchIdFromError`: this
 * component's own tests mock `./api/client` wholesale, so the `ApiError`
 * class identity a mocked rejection carries is not guaranteed to be the
 * same one this module imports.
 *
 * `handleNicknameCommit` below uses this to skip its normal revert-to-
 * last-saved-value behavior specifically for a collision -- Nicole: "it
 * should highlight... red outline on the field" only makes sense if the
 * OFFENDING value stays visible to fix, unlike a generic failure (network
 * error, etc.), where reverting is still correct (nothing wrong with the
 * value itself, just the request).
 */
function isNicknameConflictError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 409) return false;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return false;
  return (body as { reason?: unknown }).reason === "nickname_conflict";
}

function buildSearchCriteria(form: CriteriaFormState & { titleChips: string[] }): SearchCriteria {
  const nearLocations = splitPhrases(form.nearLocations);
  const criteria: SearchCriteria = {};
  if (form.titleChips.length > 0) criteria.titleInclude = form.titleChips;
  if (nearLocations.length > 0) criteria.nearLocations = nearLocations;
  // Ticket 410e1a2: sent only when it is both checked AND has something to
  // act on. `expandMetroAreas` alone expands nothing (it widens
  // `nearLocations` entries, and there are none), so sending it with an
  // empty location list would put a flag on the wire that cannot change a
  // single result -- and would show up in the request as if the user had
  // narrowed something.
  if (form.expandMetroAreas && nearLocations.length > 0) criteria.expandMetroAreas = true;
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
type Tab = "search" | "scored" | "resumes";

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
  // Ticket 88f11d7: `GetResumeResponse.isLocked`/`CreateResumeResponse.
  // isLocked` for the CURRENTLY active resume -- starts `false` (the
  // honest answer for a session with no resume yet), set from the real
  // server response on every path that can change which resume is active
  // (a fresh/resubmitted `createResume` below, `handleActivateResume`'s
  // `getResume`, and the mount-only hydration effect further down for a
  // resumeId restored from a PRIOR session/reload, which otherwise has no
  // way to learn this without a network call).
  const [resumeLocked, setResumeLocked] = useState(false);
  // Ticket 88f11d7: true between a "Change" click (only reachable once
  // `resumeLocked`) and either activating an existing resume, choosing
  // "Paste a new resume" (which flips this to `resumeEditing` instead --
  // see `handleStartPasteNew`), or Cancel. Deliberately separate from
  // `resumeEditing`, same reasoning ResumeInput.tsx's own doc comment
  // gives for keeping `editingResume` separate from `resumeId`: conflating
  // "showing the picker" with "a resume exists" (or with "showing the
  // paste form") would reproduce that same class of bug.
  const [resumeChanging, setResumeChanging] = useState(false);
  const [resumeActivating, setResumeActivating] = useState(false);
  const [resumeActivateError, setResumeActivateError] = useState<string | null>(null);
  // Review fix (F2, ticket 88f11d7): a generation counter guarding
  // `handleActivateResume`'s async `getResume` against being applied AFTER
  // the user has already left the picker (Cancel or "Paste a new resume")
  // -- without this, a slow `getResume` that resolves after Cancel already
  // returned the UI to "Using Resume 1" would silently overwrite it with
  // Resume 8 anyway the instant the response landed, including yanking
  // `resumeId` out from under an already-mounted `SearchFlow`. Every
  // caller that leaves the picker without an activation actually
  // completing (`handleCancelChange`, `handleStartPasteNew`) bumps this;
  // `handleActivateResume` captures the value at its OWN start and only
  // applies its result if nothing bumped it in between -- the same
  // "snapshot a token, compare on resolve" shape `estimateRequestId`
  // already uses (SearchFlow.tsx) for an analogous stale-response problem.
  const activationTokenRef = useRef(0);
  // Ticket 88f11d7 (Nicole: "I don't think that we should allow a change
  // of resume while a search is in progress"): mirrors SearchFlow's own
  // `"starting"`/`"running"` phases via its `onRunningChange` callback --
  // see that prop's doc comment (SearchFlow.tsx) for exactly which phases
  // count and why. Passed straight through as ResumeInput's `searching`
  // prop, which disables the collapsed bar's action button
  // UNCONDITIONALLY while true -- "Edit" exactly as much as "Change" (see
  // that prop's own doc comment, ResumeInput.tsx, for why an unlocked
  // "Edit" needs this gate too).
  const [searchRunning, setSearchRunning] = useState(false);
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
      expandMetroAreas: false,
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

  // Ticket 88f11d7: hydrates `resumeLocked` for a resumeId RESTORED from a
  // prior session/reload -- every other path that can set an active
  // resumeId (a fresh/resubmitted `createResume`, `handleActivateResume`'s
  // `getResume`) already carries the real server-computed `isLocked` on its
  // own response and sets it directly; a plain reload is the one path with
  // no such response to read, since sessionStorage never persisted this
  // field. Mount-only (`restored` is `useState`'s initializer value, read
  // once at first render per its own doc comment above, so it's safe as an
  // effectively-constant dependency) and a genuine no-op for a fresh
  // session (`restored` is `undefined`). Best-effort: a failed fetch here
  // just leaves `resumeLocked` at its honest `false` default rather than
  // blocking anything else on this page.
  useEffect(() => {
    if (restored?.resumeId === undefined) return;
    let cancelled = false;
    getResume(restored.resumeId)
      .then((data) => {
        if (!cancelled) setResumeLocked(data.isLocked);
      })
      .catch(() => {
        // Best-effort hydration only -- see comment above.
      });
    return () => {
      cancelled = true;
    };
    // Mount-only by design, empty deps kept deliberately empty -- this repo
    // has no react-hooks lint plugin configured (SearchFlow.tsx's own
    // mount-only effects make the same note), so nothing enforces this
    // either way.
  }, []);
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
  // Ticket 303cff0 ("My Resumes" tab): its own independently-fetched list,
  // same shape as `allResultsState` above -- not derived from anything
  // else on this page (there is no other place that already holds every
  // saved resume's id/nickname/createdAt at once).
  const { state: resumesListState, refresh: refreshResumesList } = useResumesList();
  // Ticket 1e183a4: which resume a result card's "Searched with:" link
  // most recently asked to jump to -- see FocusResume's own doc comment
  // (MyResumes.tsx) for why this carries a `token`, not just an id.
  // `undefined` before any card has ever been clicked this session.
  const [focusResume, setFocusResume] = useState<FocusResume | undefined>(undefined);

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

  // Ticket 303cff0: same "count in the tab button itself" pattern as
  // `scoredJobCount` above, `undefined` (not 0) before the list has
  // actually loaded so the tab button shows no number rather than a
  // misleading "(0)" while still fetching.
  const resumeCount =
    resumesListState.status === "ready" ? resumesListState.data.resumes.length : undefined;

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
    // Ticket 88f11d7: `resumeId` joins the deps -- switching which resume
    // is active (a resubmitted new paste, or now "Change" -> "Use Resume
    // N") must clear a PREVIOUS resume's "fresh search results" the same
    // way toggling a source or editing criteria already does; otherwise a
    // completed run's results could briefly keep showing under a
    // just-activated, unrelated resume the instant its own (empty) results
    // fetch resolves.
  }, [selectedSourceIds, criteria, resumeId]);

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
      // Ticket 7701534: `resumeId` (this component's OWN current state, not
      // a fresh value) is what lets the server tell "resubmitting my own
      // unchanged text" apart from "this text already belongs to a
      // DIFFERENT saved resume" -- see createResume's own doc comment. A
      // duplicate rejects with a 409 whose message already names the
      // colliding resume; caught below like any other failure, no special
      // handling needed here (unlike the nickname-collision case, this one
      // has no in-progress value to preserve -- the paste box already
      // holds exactly what the user typed, untouched either way).
      const {
        id,
        suggestedTitles,
        resumeNickname: defaultNickname,
        isLocked,
      } = await createResume(resumeText, resumeId);
      setResumeId(id);
      // Ticket 88f11d7: the server's real, just-computed answer -- a
      // resubmission of `currentResumeId`'s own text is the one case that
      // can land here already locked (every other path through this
      // function is a genuinely new resume, never locked yet).
      setResumeLocked(isLocked);
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
      setTitleChips(mergeTitleChips(inferredTitles));
      // Review fix round 2 (ticket cdc2c39): an edit is only "done" once
      // a submission actually lands -- not on the Edit click itself (see
      // `resumeEditing`'s own doc comment above). A no-op on the
      // first-ever submission, where this was already false.
      setResumeEditing(false);
      // Ticket 303cff0: a genuinely new resume (or a resubmission that
      // matched an existing one, per `createResume`'s find-or-create) --
      // either way, "My Resumes" should reflect it without waiting for
      // some unrelated action to happen to refresh it.
      refreshResumesList();
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
      // Ticket 303cff0: keeps "My Resumes" showing the current nickname
      // rather than whatever it had cached from before the rename.
      refreshResumesList();
    } catch (err) {
      setNicknameError(err instanceof Error ? err.message : String(err));
      // Ticket 7701534: a nickname COLLISION is the one failure that does
      // NOT revert -- Nicole wants the offending value visible, red-
      // outlined, and fixable in place, not silently swapped back to
      // whatever it was before. Every other failure (network error, a
      // future validation this route adds, ...) keeps the original
      // revert: there's nothing wrong with THAT value, only the request,
      // so parking a "failed" value in state as though it had taken
      // effect would be the wrong call there.
      if (!isNicknameConflictError(err)) {
        setResumeNickname(lastSavedNickname);
      }
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
  // too). `resumeId`, `resumeText` are untouched -- this is a discard,
  // not a submit, so nothing about the SAVED resume actually changes.
  // Also clears a stale resume-submission error (review round 2, N1): a
  // failed resubmit shows "Could not save resume: ..." while expanded;
  // giving up via Cancel rather than fixing and resubmitting shouldn't
  // leave that error sitting, orphaned, under the collapsed bar.
  //
  // Ticket 7701534 review round 1 (F1): `resumeNickname`/`nicknameError`
  // ARE reverted/cleared now, unlike the claim this comment used to make.
  // A rejected nickname-collision attempt (handleNicknameCommit) is the
  // one case that deliberately leaves the OFFENDING value sitting in
  // `resumeNickname` uncommitted, with `nicknameError` still set, so the
  // user can see and fix it in place. Cancelling out of the form instead
  // of fixing it used to strand that state: the form unmounts (so
  // `nicknameError` -- rendered only inside it -- vanishes with no trace),
  // while the collapsed bar kept showing the REJECTED value as "Using
  // {nickname}" -- confidently wrong, since the server never accepted it.
  // Reverting here, the same way a failed PATCH already reverts on every
  // OTHER path, makes Cancel a true discard of everything unsaved,
  // nickname included.
  function handleCancelEdit() {
    setResumeEditing(false);
    setResumeError(null);
    setResumeNickname(lastSavedNickname);
    setNicknameError(null);
  }

  // Ticket 88f11d7: fires from the collapsed summary bar's "Change" (the
  // locked counterpart to `handleEditResume`) -- opens the picker, not the
  // paste form. Same error-clearing as `handleEditResume`, plus the
  // picker's own `resumeActivateError`.
  function handleChangeResume() {
    setResumeChanging(true);
    setNicknameError(null);
    setResumeError(null);
    setResumeActivateError(null);
  }

  // Fires from the picker's "Cancel" -- a pure discard, same shape as
  // `handleCancelEdit`: nothing about the active resume changes. Review
  // fix (F2): bumps `activationTokenRef` so a still-in-flight
  // `handleActivateResume` call this Cancel is walking away from can
  // never apply its result after the fact -- see that ref's own doc
  // comment.
  function handleCancelChange() {
    activationTokenRef.current++;
    setResumeChanging(false);
    setResumeActivating(false);
    setResumeActivateError(null);
  }

  // Fires from the picker's "Paste a new resume" -- hands off from the
  // picker straight into the ordinary expanded form, the same one an
  // unlocked "Edit" already opens (ResumeInput.tsx renders identically
  // either way once `editingResume` is true). Review fix (F2): same
  // in-flight-activation invalidation as `handleCancelChange` -- this is
  // also a way to leave the picker without an activation completing.
  function handleStartPasteNew() {
    activationTokenRef.current++;
    setResumeChanging(false);
    setResumeActivating(false);
    setResumeEditing(true);
    setNicknameError(null);
    setResumeError(null);
  }

  // Ticket 88f11d7 (Nicole: "already exists in full, use resume 8...
  // doesn't need to submit anything or check anything. It just needs to
  // say the active resume is now 8... it's a pick, not a paste"). Fires
  // from the picker's "Use Resume N" -- a pure `GET /resumes/:id`, NEVER
  // `createResume`/`POST /resumes`: that's what keeps this from ever
  // tripping the ticket 7701534 duplicate-text guardrail (submitting
  // Resume 8's own text while Resume 16 is `currentResumeId` would 409 --
  // this path never submits anything at all).
  async function handleActivateResume(id: string) {
    // Review fix (F2): snapshot BEFORE the network call, so a later bump
    // (Cancel, "Paste a new resume", or a second activation click) is
    // unambiguously detectable once this resolves.
    const token = ++activationTokenRef.current;
    setResumeActivating(true);
    setResumeActivateError(null);
    try {
      const data = await getResume(id);
      // Superseded -- the user left the picker (or started a DIFFERENT
      // activation) while this was in flight. Applying it now would
      // silently resurrect a resume the user already walked away from;
      // a no-op is the correct behavior, not an error.
      if (activationTokenRef.current !== token) return;
      setResumeId(data.id);
      // Captured the same way a submit captures it (ticket 3f05144): the
      // text this resumeId actually resolves to, so a reload restores the
      // same activated resume rather than an empty box.
      setResumeText(data.resumeText);
      setResumeNickname(data.resumeNickname);
      setLastSavedNickname(data.resumeNickname);
      setResumeLocked(data.isLocked);
      setNicknameError(null);
      // Ticket 88f11d7: same "resume-inferred titles + EXTRA_TITLE_CHIPS"
      // rebuild a fresh submit already does (`mergeTitleChips`) -- an
      // activated resume's OWN cached suggestions, not whatever chips
      // happened to be showing for the resume being switched away from.
      setTitleChips(mergeTitleChips(data.suggestedTitles ?? []));
      setResumeEditing(false);
      setResumeChanging(false);
      setResumeError(null);
    } catch (err) {
      // Same supersession guard as the success path above -- a failure
      // for an activation the user already cancelled/replaced must not
      // resurrect an error banner for a picker that may no longer even
      // be showing.
      if (activationTokenRef.current === token) {
        setResumeActivateError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (activationTokenRef.current === token) setResumeActivating(false);
    }
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

  // Ticket 1e183a4, Nicole: "the resume 13 should now become a link to the
  // My Resumes page with that resume highlighted and the text already
  // expanded." Switches tabs AND sets the focus target in one go -- see
  // FocusResume's own doc comment (MyResumes.tsx) for why `token` is
  // `Date.now()` rather than just the id (a second click on the same
  // resume, from a different card, while already on that tab, must still
  // re-scroll/re-flash).
  function handleViewResume(resumeId: string) {
    setActiveTab("resumes");
    setFocusResume({ id: resumeId, token: Date.now() });
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
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "resumes"}
          onClick={() => setActiveTab("resumes")}
        >
          My Resumes
          {resumeCount !== undefined && ` (${resumeCount})`}
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
            // Review fix (N1, ticket 88f11d7): `key={resumeId}` forces a
            // remount whenever the ACTIVE resumeId itself changes --
            // needed now that `handleActivateResume` ("Change" -> "Use
            // Resume N") is a second way `resumeId` can change without a
            // submission, alongside the existing resubmit-new-text path.
            // Without this, ResumeInput's own `text` local state (seeded
            // ONCE from `initialText` at mount, by design -- see this
            // component's own doc comment on that prop) stays whatever it
            // held for the PREVIOUS resume: reproduced live -- "Change" ->
            // "Use Resume 8" -> "Change" -> "Paste a new resume" rendered
            // the textarea still showing Resume 1's text while every
            // other piece of state (the collapsed bar, resumeId,
            // resumeNickname) already said Resume 8. Submitting it
            // unchanged would harmlessly 409 against the ticket 7701534
            // duplicate-text guardrail, but editing it even slightly would
            // silently create a new resume derived from the WRONG base
            // text. A remount re-seeds `text` from the current
            // `initialText`, which by then is always the activated
            // resume's own real text (`handleActivateResume` sets
            // `resumeText` from the same `GET /resumes/:id` response).
            // Safe against the OTHER thing a key change can break --
            // losing an in-progress, uncommitted edit -- because `resumeId`
            // never changes mid-edit on its own; it only ever changes at
            // the SAME moment a submission or activation lands, both of
            // which make discarding any stale local `text` the correct
            // behavior, not a loss.
            key={resumeId}
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
            isLocked={resumeLocked}
            changingResume={resumeChanging}
            onChangeResume={handleChangeResume}
            onCancelChange={handleCancelChange}
            onStartPasteNew={handleStartPasteNew}
            onActivateResume={(id) => void handleActivateResume(id)}
            resumes={resumesListState.status === "ready" ? resumesListState.data.resumes : []}
            activating={resumeActivating}
            activateError={resumeActivateError}
            searching={searchRunning}
          />
          {/* Ticket 0308d7e: the "Resume ready." paragraph that used to
              sit here is gone -- Nicole, dogfooding ac141d0: "I don't
              think we need the resume-ready words anymore." Redundant
              once the collapsed "Using Resume N" bar (ac141d0) already
              says the same thing. */}
          {/* Ticket 7701534: `.resume-error` gives this the same red-text
              treatment `.resume-nickname-error` already has -- previously
              unstyled plain text, which undersold what is now sometimes a
              real blocking validation error (duplicate resume text), not
              just an occasional network hiccup. */}
          {resumeError && (
            <p role="alert" className="resume-error">
              Could not save resume: {resumeError}
            </p>
          )}
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
          // Ticket 88f11d7: `resumeChanging` joins `resumeEditing` in this
          // gate -- the picker (ResumeInput's third branch) hides
          // sources/criteria/search for exactly the same reason the
          // expanded paste form already does (ac141d0's comment below is
          // otherwise unchanged: SearchFlow stays MOUNTED underneath
          // either way, so an in-flight run's poll is never interrupted by
          // opening the picker).
          <div hidden={resumeEditing || resumeChanging}>
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
                expandMetroAreas={criteriaForm.expandMetroAreas}
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
                onRunningChange={setSearchRunning}
                // Review fix (F1, ticket 88f11d7): fires the moment
                // SearchFlow itself confirms a real run exists (its
                // `onRealSearchStarted` doc comment has the full story) --
                // this is what makes `resumeLocked` become true THIS
                // SESSION for a resume that was unlocked when the run
                // started, instead of only ever learning about it from a
                // later reload's hydration fetch. `true` is always the
                // correct write here: a locked resume staying locked is a
                // no-op, and there is no unlock path this could wrongly
                // clobber.
                onRealSearchStarted={() => setResumeLocked(true)}
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
                    onViewResume={handleViewResume}
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
                onViewResume={handleViewResume}
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

      {/* Ticket 303cff0: `hidden`, same as the other two tabs above -- kept
          mounted so switching away and back doesn't re-fetch or lose an
          expanded row's already-fetched text. */}
      <div hidden={activeTab !== "resumes"}>
        <section className="resumes-section">
          <h2>
            My Resumes
            {resumeCount !== undefined && ` (${resumeCount})`}
          </h2>
          {resumesListState.status === "loading" && <p>Loading resumes...</p>}
          {resumesListState.status === "error" && (
            <p role="alert">Could not load resumes: {resumesListState.message}</p>
          )}
          {resumesListState.status === "ready" && (
            <MyResumes resumes={resumesListState.data.resumes} focusResume={focusResume} />
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
