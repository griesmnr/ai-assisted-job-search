import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MATCH_SCORE_FLOOR,
  nextResumeNicknameFor,
  type CreateResumeResponse,
  type ScoredJobResult,
  type SearchCriteria,
  type UpdateResumeTextResponse,
  type UserJobStatus,
} from "@app/shared";
import {
  clearJobStatus,
  createResume,
  getResume,
  setJobStatus,
  updateResumeNickname,
  updateResumeText,
} from "./api/client";
import {
  GroupedResultsList,
  groupKeyForStatus,
  type ScoredGroupKey,
} from "./components/GroupedResultsList";
import {
  clearLandOnScoredTabMarker,
  hasLandOnScoredTabMarker,
  MagicLinkLanding,
  readMagicLinkTokenFromUrl,
} from "./components/MagicLinkLanding";
import { MagicLinkPrompt } from "./components/MagicLinkPrompt";
import { SignedInCue } from "./components/SignedInCue";
import { SignInRecovery } from "./components/SignInRecovery";
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
 * REMOVED by ticket 5c4242d, 2026-10-10: `EXTRA_TITLE_CHIPS` and
 * `mergeTitleChips` used to live here, appending the fixed trio "Program
 * Analyst" / "IT Specialist" / "Computer Scientist" to EVERY resume's
 * title chips at the two call sites below, unconditionally (ticket
 * 8a403ee).
 *
 * WHY REMOVED: John (IT/DevOps) tested on 2026-10-10 and got that
 * identical trio -- the same one Nicole always gets -- and correctly
 * cancelled two of three as wrong for his field. This hardcoded list was
 * one of TWO sources of those three titles. The other,
 * `resume-title-inference.ts`'s prompt, was already fixed by ticket
 * 17a5c8f (2026-10-06, Jay's report: a technical writer got the same
 * software trio) to DERIVE field-appropriate federal titles from the
 * resume instead of copying hardcoded prompt examples. 17a5c8f closed
 * having fixed only that one source, so the user-visible symptom
 * reproduced for a different underlying reason: the AI was deriving
 * John's titles correctly and this frontend list was overriding them.
 *
 * Deleted outright rather than conditioned on field, because the AI side
 * already does that job -- `titleChips` is now simply `suggestedTitles`
 * (or the user's own edits to it), nothing appended after the fact.
 * Verified LIVE before deleting, per this ticket's own instruction not to
 * trust the prompt fix by inference alone, that Nicole's standing
 * requirement ("I do still want the government ones to come up") still
 * holds without this list:
 *
 *   Full-stack engineer resume -> model's raw titles included "IT
 *   Specialist" (alongside "Software Engineer", "Backend Engineer", etc).
 *
 *   Technical-writer resume (Jay's shape) -> model's raw titles included
 *   "Writer-Editor" and "Technical Information Specialist"; the software
 *   trio did not appear at all.
 *
 * Had the software resume NOT produced a federal equivalent live, this
 * ticket's instructions were to leave the hardcode in place and report
 * back instead of deleting something Nicole asked for twice -- that
 * branch did not trigger, so no conditional-on-field logic was needed
 * here.
 *
 * Related, not fixed here: ticket 99b6b25 is about gating these federal
 * chips (now entirely the AI's decision) and their advertising copy
 * (`SearchCriteriaForm.tsx`'s "A few title variations..." hint, still
 * present) on USAJOBS being CONFIGURED at all -- a deployment question,
 * independent of this ticket's per-resume field question.
 */

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
  if (apiErrorStatus(err) !== 409) return false;
  const body = (err as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return false;
  return (body as { reason?: unknown }).reason === "nickname_conflict";
}

/**
 * Reads the HTTP status off whatever `./api/client` threw, structurally
 * rather than via `err instanceof ApiError` -- for the reason
 * `isNicknameConflictError` above already gives: this component's tests
 * replace `./api/client` wholesale with `vi.mock`, so the `ApiError` class
 * identity visible here is not necessarily the one a rejected mock built
 * its error from, and an `instanceof` check would answer "no" in exactly
 * the tests that exist to prove these branches work.
 *
 * A near-twin of `apiErrorStatus` in SearchFlow.tsx, which is module-
 * private there. Deliberately duplicated rather than shared for now: the
 * honest shared home is `api/client.ts` (alongside
 * `magicLinkRejectionReason`, already an error-shape reader), and moving it
 * there means editing SearchFlow.tsx, which a separate ticket is editing
 * concurrently. Worth collapsing into one helper when that lands.
 */
function apiErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Ticket 368b6cc (Nicole, dogfooding: "when there are no resumes and no
 * already scored jobs, I don't want to see the parentheses zero... I
 * think it's a little tacky"). `scoredJobCount`/`resumeCount` were
 * already `undefined` (never 0) while their list is still loading, so
 * this shared formatter extends the exact same "nothing to show yet"
 * treatment to an ACTUAL zero once loading finishes -- one place used by
 * all four render call sites (tab button + heading, for each of the two
 * counts) so they can't drift into showing "(0)" in one spot and not the
 * other.
 */
function formatCount(count: number | undefined): string {
  return count !== undefined && count > 0 ? ` (${count})` : "";
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
 *   3. Explicit "Get estimate" / "Run search" flow (SearchFlow) ->
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
 * UPDATE (ticket dba885e, epic 2b9e9dd): every request now carries a
 * real, anonymous per-browser identity (identity.ts) -- the original
 * "single-user, no accounts, no login" decision (#2, 2026-08-29) is
 * being deliberately walked back, in stages, starting with that
 * identity plumbing. Nothing in THIS file reads or branches on it yet
 * (that starts with ticket b2f9dfd); every resume/result/status this
 * component renders is still, for now, whatever the API returns
 * unscoped, same as before this ticket.
 */
type Tab = "search" | "scored" | "resumes";

function JobSearchApp() {
  const sourcesState = useSources();
  // Ticket f4a7f07: "New Job Search" and "Already Scored Jobs". Nicole,
  // after several rounds of thinking out loud, settled on exactly these
  // two -- no saved/other sub-split yet ("I haven't figured that out
  // yet"), and moving results out of the main flow entirely is itself the
  // fix for a separate thing she flagged: previously-scored results
  // appearing inline the moment a resume is pasted, before any new search
  // runs, read as "jarring... old stuff".
  const [activeTab, setActiveTab] = useState<Tab>("search");
  // Review fix (F2, ticket 11ead86): the "latest value" ref idiom --
  // `handleActivateResume` below needs to read `activeTab` AFTER an
  // `await`, where its own closed-over `activeTab` (captured at the start
  // of that call, when the click fired) is frozen at whatever it was
  // THEN, not whatever it is NOW. This ref is kept current every render
  // specifically so that call can ask "is the tab still what it was when
  // I started," not just "what is it."
  //
  // An earlier version of this comment also claimed a `useState` snapshot
  // "can't tell 'unchanged since the click' apart from 'changed and
  // changed back'." Re-review deleted that: the ref cannot tell them
  // apart either -- `activeTabRef.current === tabAtClick` is equally blind
  // to a round trip, proven by navigating My Resumes -> Already Scored ->
  // My Resumes mid-fetch and watching the switch still fire. The
  // behaviour is right (a user who returned to the originating tab did
  // still ask to activate); the justification was false.
  //
  // Mutated directly during render (no effect) -- safe and ordinary
  // for this exact pattern, and this repo has no react-hooks lint plugin
  // to object (SearchFlow.tsx's own mount-only effects make the same
  // note for a different idiom).
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  /** Opus review F1 (ticket 5a7e957): latches true the first time the
   * "been here before?" offer is shown, so its host stays mounted and its
   * in-flight state survives the gate closing underneath it. See the mount
   * site for the concrete bug. */
  const signInRecoveryEverShownRef = useRef(false);
  // Ticket bb2f275, Nicole (live): landing on "Already Scored Jobs" right
  // after a successful magic-link verification is the more meaningful
  // destination than the default "New Job Search" -- MagicLinkLanding.tsx
  // bakes a marker into the URL it reloads to specifically for this. A
  // mount-only effect (not the `activeTab` initializer above) because
  // consuming the marker has a real side effect (stripping it out of the
  // URL via `history.replaceState`, so a LATER, unrelated reload doesn't
  // keep forcing this tab) -- doing that inside a `useState` initializer
  // would run it twice under StrictMode's double-invoked render (the same
  // hazard MagicLinkLanding.tsx's own `startedRef`/`aliveRef` comments
  // document at length for its token-redemption POST). A plain effect is
  // safe here specifically because consuming the marker IS idempotent
  // (checking presence before acting): StrictMode's mount -> cleanup ->
  // remount runs this twice too, but the second run finds the marker
  // already gone and does nothing, which is the correct outcome, not a bug.
  useEffect(() => {
    if (hasLandOnScoredTabMarker()) {
      setActiveTab("scored");
      clearLandOnScoredTabMarker();
    }
  }, []);
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
  // Ticket d7d3d59: true between the picker's "Paste a new resume" click and
  // whichever of its two exits comes first -- a submit that actually lands (a
  // NEW resume now exists, and `resumeId` names it), or Cancel. This is the
  // ONE state that says "the expanded form on screen is composing a resume
  // that does not exist yet, even though `resumeId` is set and names a
  // DIFFERENT, still-active resume."
  //
  // WHY A FLAG AND NOT `setResumeId(undefined)`, which the ticket itself
  // guessed would be simpler. Clearing `resumeId` for this flow is the
  // approach ticket cdc2c39's round-2 review already tried and rejected for
  // the Edit flow, and every reason still holds here -- checked reader by
  // reader:
  //   - the persist effect below (`if (resumeId === undefined)
  //     clearAppState()`) would WIPE sessionStorage the instant the user
  //     clicked "Paste a new resume", which is ticket 3f05144's "it was all
  //     clear again" report exactly.
  //   - `{resumeId && (<div hidden={...}>...</div>)}` in the render below
  //     UNMOUNTS sources/criteria/search -- SearchFlow included -- rather
  //     than hiding them. ac141d0's own review caught that unmounting
  //     SearchFlow kills an in-flight poll with no way back, which is why
  //     that gate uses `hidden` for editing in the first place.
  //   - ResumeInput's expanded form renders its "Cancel" button only when
  //     `resumeId !== undefined`, so clearing it would delete the only exit
  //     from this form (ac141d0's dead-end, reintroduced).
  //   - ResumeInput's "Use a saved resume:" list renders only when
  //     `resumeId === undefined` (ticket e2b5f9c), so clearing it would
  //     re-offer the saved-resume list the user declined one click ago --
  //     and break App.resumeLock.test.tsx's "'Paste a new resume' opens the
  //     ordinary expanded paste form", which asserts that list is absent.
  //   - `showSignInRecovery` (`resumeId === undefined && ...`) could offer
  //     "been here before?" mid-paste to someone plainly not lost.
  //   - `key={resumeId}` on `<ResumeInput>` would remount the form on the
  //     click, and `useResults(resumeId, ...)` would drop the active
  //     resume's results.
  // So `resumeId` keeps meaning exactly what it has always meant -- "the
  // resume this session is actively using" -- and this flag carries the new
  // distinction instead. The three readers that genuinely needed to change
  // (the nickname suggestion effect, `handleNicknameCommit`, and
  // `handleResumeSubmit`'s first-save reconciliation) each read it below.
  //
  // Not persisted, deliberately: `resumeEditing` isn't either, so a reload
  // mid-paste lands back on the collapsed bar for the still-active resume,
  // and a persisted `true` would otherwise strand a session in "composing"
  // with no form on screen.
  const [pastingNewResume, setPastingNewResume] = useState(false);
  const [resumeActivating, setResumeActivating] = useState(false);
  const [resumeActivateError, setResumeActivateError] = useState<string | null>(null);
  // Review fix (F3, ticket 11ead86): clear a stale activation error on any
  // TAB CHANGE, not just the search-tab-specific escapes that already
  // cleared it (`handleChangeResume`, `handleCancelChange`, and the start
  // of `handleActivateResume` itself). Before `MyResumes` existed as a
  // second renderer of this SAME shared state, those three were every
  // place `resumeActivateError` could be shown, so they were also every
  // place that needed to clear it. Now a failure from the search tab's
  // picker plants a `role="alert"` above the My Resumes list too (both
  // read the same state), and it had no clear point of its own: switching
  // TO that tab didn't drop it, and once there, it had no Cancel-equivalent
  // to dismiss it with -- it would simply persist for the rest of the
  // session, including across further navigation.
  //
  // CHOSEN OVER a per-row/per-tab dismiss button: every existing clear
  // point for this state is already "the user left the context that
  // produced the error" (Cancel out of the picker, or a successful retry
  // already covers the only in-context case worth clearing for).
  // "Switched tabs" is the exact same kind of event for `MyResumes`, which
  // has no modal state to Cancel out of in the first place -- there is no
  // "context" narrower than the tab itself to attach a dismiss control to.
  // Adding one would be a second, bespoke dismissal idiom for a single
  // error line, where this is one rule already covering every surface.
  useEffect(() => {
    setResumeActivateError(null);
    // Mount-only concern is a non-issue: `resumeActivateError` is already
    // `null` at mount, so this effect's first run is a true no-op: see
    // SearchFlow.tsx's own mount-only effects for the same observation
    // applied to a different piece of state.
  }, [activeTab]);
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
  // prior reload.
  //
  // CORRECTED, ticket 3db5b35 (review finding F3) -- this used to claim
  // "ResumeInput's field isn't rendered at all" before a first submission
  // (ticket 5a79aa4's gating), which that ticket's own reversal makes
  // false: the field DOES render pre-save now, and this is no longer
  // simply empty in that state either. It starts `""` here (unchanged --
  // nothing's restored yet on a fresh session), but the pre-save
  // suggestion effect a little further down (`nicknameSuggestionSeededRef`)
  // fills it with a client-side guess once the saved-resumes list LOADS
  // SUCCESSFULLY -- not merely once it settles, which is a distinction that
  // review finding F2 turned into a real bug: a FAILED load is settled too,
  // and treating it as "zero resumes" manufactured a confident "Resume 1"
  // out of a response that said nothing at all. So the field stays blank on
  // an error rather than carrying an invented name. See that effect, and
  // `handleResumeSubmit`'s own
  // comment, for the full story of why a SUGGESTION has to stand in here
  // rather than the real server default, which doesn't exist until a save
  // actually happens.
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
  // Ticket 4cafff3: memoized on the same deps as `criteria` above, and for a
  // stronger reason than tidiness. SearchFlow's invalidation effect lists
  // `formState` in its dependency array, so an inline object literal here
  // would make that effect re-run on EVERY App render rather than only when
  // the form actually changes. Harmless today -- `sameVisibleForm` compares
  // by value -- but it leaves a trap: the natural "optimization" of that
  // comparator to a reference check would then invalidate the estimate on
  // any unrelated App re-render (a poll tick, a status write, results
  // loading), making an estimate impossible to see at all. The PM review of
  // this ticket confirmed by mutation that the App-level tests CANNOT catch
  // that, because App happens not to re-render between the estimate landing
  // and the assertion; only SearchFlow's own negative-control unit test
  // does. Memoizing removes the trap rather than relying on that test.
  const searchFormState = useMemo(
    () => ({ titleChips, ...criteriaForm }),
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
  // checkbox) before "Get estimate" is even reachable -- see the
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
    // the "Get estimate" button itself, which sits AFTER this
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

  // Ticket 9e5fcf3 (part (a)): same "a plain ref owned here, handed down
  // into one sibling, read back inside a callback handed down into
  // another" shape `locationSectionRef`/`handleInvalidEstimateAttempt`
  // already use just above -- SearchFlow doesn't know the results section
  // exists below it (it's a sibling, not a child) any more than SearchFlow
  // knows about SearchCriteriaForm's location section, and for the same
  // reason doesn't need to: App.tsx is what sits above both and can wire
  // them together without either one knowing the other exists.
  const resultsSectionRef = useRef<HTMLDivElement | null>(null);

  function handleViewResults() {
    resultsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Ticket 9e5fcf3 (part (b)): which search's own results "Results from
  // this search" is currently scoped to -- see `useResults.ts`'s `searchId`
  // parameter and `getResults`'s own doc comment (api/client.ts) for the
  // full argument for doing this server-side rather than holding a
  // client-side job-id set. Set exactly once per completed run
  // (`handleSearchComplete` below, from the `searchId` SearchFlow's
  // `onSearchComplete` now carries), and deliberately NOT persisted to
  // sessionStorage -- `hasFreshSearchResults` already isn't (a reload loses
  // "Results from this search" entirely, by design; see that state's own
  // comment), so this would be the one durable half of an otherwise
  // non-durable pair, restoring a search SCOPE across a reload that
  // restores no section to apply it to.
  //
  // Reset to `undefined` alongside `hasFreshSearchResults` below whenever
  // `resumeId` changes -- not merely cosmetic. A stale searchId surviving a
  // resume switch would ask `GET /resumes/<new resumeId>/results?searchId=
  // <old search's id>` for a search that belongs to a DIFFERENT resume,
  // which 404s (the single-resume route's own ownership check, resumes.ts)
  // the moment a new search is estimated/run for the new resume reads this
  // hook before `handleSearchComplete` has had a chance to overwrite it.
  const [lastSearchId, setLastSearchId] = useState<string | undefined>(undefined);
  const { state: resultsState, refresh } = useResults(resumeId, scoreFloor, lastSearchId);
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
  // Ticket 3db5b35: a BEST-EFFORT pre-save nickname suggestion, seeded
  // once per unsaved resume the first time `resumesListState` reaches
  // "ready" (NOT "error" -- see review finding F2 below), so the field
  // ResumeInput now shows before a first save (reversing 5a79aa4) isn't
  // just sitting empty. `true` once seeded; checked instead of
  // re-deriving from `resumeNickname` itself so that a user clearing the
  // field by hand (to type something else entirely) is never fought by
  // this effect re-filling it on the next render -- seeding is a one-shot
  // default, not a standing invariant.
  //
  // Ticket d7d3d59: one-shot PER UNSAVED RESUME, not per session, which is
  // the correction. It used to be armed exactly once at mount and never
  // again, so the SECOND resume of a session (the picker's "Paste a new
  // resume") got no suggestion at all -- and, with `resumeId` still set, the
  // field showed the PREVIOUS resume's real nickname instead.
  // `handleStartPasteNew` re-arms it (and clears the field, so the
  // `prev === ""` guard below lets a fresh suggestion through).
  const nicknameSuggestionSeededRef = useRef(false);
  // Ticket 3db5b35 (adversarial review finding F1, severe): a SEPARATE
  // flag from the suggestion ref above, and the actual fix for "pasting
  // text you already have saved silently renames it." The suggestion
  // effect below calls `setResumeNickname` directly -- NOT through
  // `handleNicknameChange` -- specifically so this ref stays `false` for
  // a value this app guessed on the user's behalf, and only flips `true`
  // when the user's own fingers touched the field. `handleResumeSubmit`
  // requires this (ALONGSIDE the server's own `isNew`, not instead of it)
  // before ever treating a mismatch between the suggestion and the
  // server's real default as "the user asked for something different" --
  // see that function's comment for why `isNew` alone, or this flag
  // alone, each independently fails to close the bug.
  //
  // CORRECTED, ticket d7d3d59: this IS reset now, in `handleStartPasteNew`,
  // and that reset is load-bearing rather than tidiness. The old claim --
  // that a stale `true` could never be read, because the only reader was
  // gated on `resumeId === undefined` and `resumeId` is never cleared --
  // stopped holding the moment that reader learned about a SECOND unsaved
  // resume (`isNewResumeSave` below). Concretely: rename Resume 1 by hand
  // (this ref latches `true`), then "Change" -> "Paste a new resume", then
  // submit without ever opening the nickname field. Without the reset, the
  // reconciliation would read a `true` left over from the OTHER resume and
  // PATCH the client-side guess ("Resume 2") over whatever the server
  // actually assigned -- a rename nobody typed, which is review finding F1's
  // own failure mode wearing a different hat.
  const nicknameUserEditedRef = useRef(false);
  useEffect(() => {
    // Nothing to suggest once a real resume (and its real nickname) exists
    // -- this is specifically the BEFORE-A-SAVE case. Ticket d7d3d59:
    // "before a save" includes the picker's "Paste a new resume", where
    // `resumeId` is set but names a DIFFERENT resume and the form on screen
    // is composing one that does not exist yet (see `pastingNewResume`).
    if (resumeId !== undefined && !pastingNewResume) return;
    if (nicknameSuggestionSeededRef.current) return;
    // Review finding F2: wait for a REAL list, not merely a settled one.
    // `resumesListState` starts "idle"/"loading" on every mount
    // (useResumesList.ts) -- those still just wait, same as before. But
    // "error" used to fall through to `existingCount = 0` and confidently
    // suggest "Resume 1" anyway -- manufacturing a specific, countable
    // claim out of a request that told this app LITERALLY NOTHING about
    // how many resumes exist. For someone who already has a real "Resume
    // 1," pasting brand-new text without ever touching the nickname field
    // then produced a server-side 409 collision and a red-outlined field
    // for a name they never typed. "Error" now leaves the field empty
    // AND leaves `nicknameSuggestionSeededRef` unset, so a later
    // successful refresh of the list (if one ever happens before the
    // first save) still gets a chance to seed a real suggestion rather
    // than being permanently locked out by one failed request.
    if (resumesListState.status !== "ready") return;
    nicknameSuggestionSeededRef.current = true;
    // Same numbering scheme the server itself uses at insert time
    // (`getOrCreateResumeId`, apps/api/src/matching/pipeline.ts) --
    // `nextResumeNicknameFor` (@app/shared, review finding F6) is the ONE
    // place that formula lives now, used by both sides specifically so
    // they cannot silently drift apart the way two independent copies of
    // "count + 1" otherwise could. Still just a best-effort GUESS, not
    // fetched, because there is no endpoint that returns "what would you
    // suggest" without actually creating a resume (see
    // `handleResumeSubmit`'s own comment for the full argument against
    // adding one) -- it can still disagree with the real server default
    // (another tab/session creating a resume in between), which is
    // exactly why `handleResumeSubmit` never trusts a mismatch here as
    // proof of anything by itself.
    setResumeNickname((prev) =>
      prev === "" ? nextResumeNicknameFor(resumesListState.data.resumes.length) : prev,
    );
  }, [resumeId, pastingNewResume, resumesListState]);
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
  // rather than a misleading "(0)". Ticket 368b6cc: an ACTUAL zero, once
  // loaded, gets the same treatment -- see `formatCount` below.
  const scoredJobCount =
    allResultsState.status === "ready"
      ? (allResultsState.data.totalMatchingCount ?? allResultsState.data.results.length) +
        (allResultsState.data.hiddenBelowFloor ?? 0)
      : undefined;

  // Ticket 303cff0: same "count in the tab button itself" pattern as
  // `scoredJobCount` above, `undefined` (not 0) before the list has
  // actually loaded so the tab button shows no number rather than a
  // misleading "(0)" while still fetching. Ticket 368b6cc: an ACTUAL zero,
  // once loaded, gets the same treatment -- see `formatCount` below.
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
    // Ticket 9e5fcf3: `lastSearchId` resets alongside `hasFreshSearchResults`
    // on every one of these same triggers. Not just tidiness on the
    // `resumeId` branch of this effect -- see that state's own declaration
    // comment for the 404 a stale searchId would cause against a resume it
    // doesn't belong to. On the other two triggers (criteria/source change,
    // same resume) a stale value wouldn't 404, but it would be reused by
    // the NEXT `getResults` call for no reason -- harmless since nothing
    // renders it while `hasFreshSearchResults` is false either way, but
    // there's no reason to let it linger past the point it stopped meaning
    // anything.
    setLastSearchId(undefined);
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

  /**
   * Ticket 6ba221e: picks between "edit this resume in place" and "create a
   * new resume" for a submit, and recovers when the first turns out to be
   * impossible. See `handleResumeSubmit`'s own comment for why
   * `resumeLocked` is the thing that decides.
   *
   * THE 404 FALLBACK IS A REGRESSION FIX, not belt-and-braces (fable review
   * of 6ba221e, F1). `resumeId` is restored from sessionStorage across a
   * reload, and nothing in this app ever clears it on a failed lookup: the
   * mount-only hydration effect above swallows its own `getResume` error by
   * design, leaving `resumeLocked` at `false`. So if the row named by a
   * restored `resumeId` no longer exists -- a dev-database reset is the
   * realistic way there, and this project's own topology (the owner's
   * container versus a sandbox Postgres) makes it routine -- the collapsed
   * bar still reads "Using Resume 1" with an "Edit" button, and every
   * submit from then on would `PUT /resumes/<gone>/text` and 404. Forever,
   * on every retry, with no path out short of clearing sessionStorage by
   * hand.
   *
   * Before this ticket that submit was a `POST`, which quietly created a
   * fresh row and healed the session as a side effect. Routing edits to the
   * PUT closed that accidental escape hatch, so it is reopened explicitly
   * and narrowly: a 404 from the edit means "the resume I was editing is
   * gone", and the only sensible reading of the user's click then is "save
   * this text", which is exactly what `createResume` does. The resulting
   * new id replaces the stale one in state (`setResumeId` at the call
   * site), so the session is self-healing from then on.
   *
   * Deliberately ONLY 404, and only from the edit path. Any other status
   * (400 on an over-length paste, 500, a network failure) propagates and
   * surfaces as `resumeError` exactly as before -- silently converting a
   * failed edit into a NEW resume for any other reason would be the "I
   * edited Resume 1 and got Resume 2" surprise this whole ticket exists to
   * remove.
   *
   * Ticket 11ead86 (open) would give the restored-but-missing resume a
   * general recovery path; this does not wait on it, and should be
   * revisited rather than assumed redundant when it lands.
   */
  async function saveResumeText(
    resumeText: string,
  ): Promise<CreateResumeResponse | UpdateResumeTextResponse> {
    // Ticket d7d3d59: `pastingNewResume` joins the condition as a SECOND,
    // independent reason to POST. It changes nothing today -- the picker that
    // sets it is reachable only from a locked resume's "Change", so
    // `resumeLocked` is always true alongside it -- which is exactly why it is
    // safe to add, and the point is that it no longer has to be inferred. The
    // destructive mistake available on this line is routing a "paste a new
    // resume" to the PUT and overwriting the resume the user just declined to
    // reuse (see `handleResumeSubmit`'s own comment); naming the intent
    // directly means a future change to how `resumeLocked` is maintained
    // cannot quietly re-enable it.
    if (resumeId === undefined || pastingNewResume || resumeLocked) return createResume(resumeText);
    try {
      return await updateResumeText(resumeId, resumeText);
    } catch (err) {
      if (apiErrorStatus(err) !== 404) throw err;
      return createResume(resumeText);
    }
  }

  async function handleResumeSubmit(resumeText: string) {
    setResumeSubmitting(true);
    setResumeError(null);
    // Ticket 3db5b35: captured BEFORE `saveResumeText` below, which is what
    // that ticket's acceptance criteria called "before the first save."
    // `resumeNickname` is read here, not `lastSavedNickname`, because nothing
    // has been "saved" yet for this to be the server-confirmed baseline of.
    //
    // CORRECTED, ticket d7d3d59. This used to be `resumeId === undefined`
    // alone, with a comment arguing that "paste a new resume while locked"
    // was deliberately excluded because that form's nickname field showed the
    // OLD resume's real nickname rather than a fresh suggestion. That was a
    // true description of a BUG, not a design: the field showed the previous
    // resume's name precisely because the suggestion effect refused to seed
    // while `resumeId` was set, and a name typed there was PATCHed onto the
    // previous resume (this ticket's data-loss half). Now that the effect
    // seeds a real "Resume N+1" suggestion for this flow too, the two cases
    // are genuinely the same thing -- a resume being named as it is created
    // -- and the reconciliation below has to cover both. Every other guard in
    // that gate (`isNew`, `nicknameUserEditedRef`) is unchanged and still
    // required; this only widens WHICH submits are eligible to be checked by
    // them.
    const isNewResumeSave = resumeId === undefined || pastingNewResume;
    const nicknameAtSubmit = resumeNickname.trim();
    try {
      // TICKET 6ba221e: AN EDIT IS AN UPDATE, NOT A NEW RESUME. This one
      // branch is the fix for Nicole's own report -- "if I'm on resume one
      // and I make an edit and I hit save and it's still called resume
      // one, it actually becomes resume 2". Every submit used to be
      // `createResume`, and because resumes were content-addressed,
      // different text meant a different row and a fresh "Resume N".
      //
      // WHY THE CONDITION IS `!resumeLocked` AND NOT A NEW STATE FLAG.
      // There are exactly three ways to reach this function with a
      // `resumeId` already set, and ticket 88f11d7's own design separates
      // them cleanly:
      //   - the collapsed bar's "Edit" (UNLOCKED only -- a locked resume's
      //     button says "Change" and opens the picker instead), which is
      //     an edit of this resume. -> PUT.
      //   - the picker's "Paste a new resume" (reachable only when LOCKED,
      //     since only a locked resume has a "Change" button at all),
      //     which is explicitly a NEW resume while the old one stays
      //     active in state. -> POST. Routing this to PUT would overwrite
      //     the locked resume the user just declined to reuse -- the one
      //     genuinely destructive mistake available here.
      //   - a `resumeId` restored from sessionStorage, whose form is only
      //     reachable via one of the two above.
      // So `resumeLocked` already encodes "which of the two intents is
      // this". `resumeLocked` is kept current on every path that changes the
      // active resume (see its own declaration).
      //
      // CORRECTED, d7d3d59: this comment used to end "and adding a parallel
      // flag would be a second source of truth to drift." A parallel flag now
      // exists -- `pastingNewResume`, read by `saveResumeText` above -- so
      // that warning needs reconciling rather than deleting, because it is
      // still the right instinct.
      //
      // The two coexist deliberately and do different jobs. `resumeLocked`
      // answers "is this resume already committed to a search", which is what
      // separates edit from create on the ORDINARY paths above.
      // `pastingNewResume` names the picker's intent DIRECTLY -- "the form on
      // screen is composing a resume that does not exist yet" -- which is a
      // fact about the form, not about the resume, and is the thing three
      // other readers actually need (the suggestion effect, the nickname
      // commit refusal, and `isNewResumeSave`). Inferring it from
      // `resumeLocked` is what produced d7d3d59's bug: the nickname commit
      // PATCHed the PREVIOUS resume because nothing told it the form was
      // composing a new one.
      //
      // On the drift risk, measured rather than hand-waved: in
      // `saveResumeText` the two signals are redundant today, and a mutation
      // removing `pastingNewResume ||` from that one condition fails NO test,
      // because the picker is only reachable from a locked resume so
      // `resumeLocked` already forces the POST. It is kept there as
      // belt-and-braces precisely because it states the intent rather than a
      // proxy for it -- and because `resumeLocked`'s own maintenance is the
      // thing most likely to change. If that redundancy ever becomes a
      // liability, delete it from `saveResumeText` and not from the three
      // readers where it is the only signal.
      //
      // The resumes page (MyResumes.tsx) has its own, separate edit
      // affordance that does NOT go through here and is NOT lock-gated --
      // see `PUT /resumes/:id/text`'s route comment for why the endpoint
      // itself permits a locked resume's text to change.
      //
      // KNOWN SEAM, recorded rather than fixed (fable review of 6ba221e):
      // the two affordances now disagree about locked resumes. This page
      // offers a locked resume "Change" (pick another / paste a new one)
      // and never "Edit"; My Resumes will happily rewrite the same
      // resume's text. That follows from the two tickets' own decisions --
      // 88f11d7 shaped THIS flow, 6ba221e added editing THERE -- and is
      // consistent in the data layer (the endpoint allows it either way).
      // It is still a surface a user can notice, so it is named here
      // instead of waiting to be rediscovered as a bug.
      const saveResult = await saveResumeText(resumeText);
      const { id, suggestedTitles, resumeNickname: defaultNickname, isLocked } = saveResult;
      // Ticket 3db5b35 (review finding F1, severe): `isNew` only exists on
      // `CreateResumeResponse` -- `UpdateResumeTextResponse` (the PUT
      // branch's return type) has no such concept, an edit never
      // "creates" anything. Narrowed with `in` rather than widening
      // `UpdateResumeTextResponse` to carry a field that would always be
      // meaningless there. See `CreateResumeResponse.isNew`'s doc comment
      // (@app/shared) and the reconciliation block below for why this
      // specific boolean is what makes the defect structurally
      // impossible rather than merely guarded against.
      const isNew = "isNew" in saveResult && saveResult.isNew;
      setResumeId(id);
      // Ticket d7d3d59: the "paste a new resume" flow ends HERE, the moment a
      // save lands -- `resumeId` now names the resume the form was composing,
      // so from this point the nickname field is editing a real, existing row
      // and `handleNicknameCommit` must be allowed to PATCH it again. That
      // matters even on the failure path below: a nickname PATCH that 409s
      // leaves the form open on purpose so the value stays fixable in place,
      // and the fix is committed by a blur against THIS id.
      setPastingNewResume(false);
      // Ticket 88f11d7: the server's real, just-computed answer, never
      // assumed. `POST /resumes` can report `true` when the submitted text
      // resolved to an already-searched resume; the `PUT` branch above can
      // report it if a real search landed between the last time this state
      // was refreshed and this save. Either way the server just looked, and
      // this state follows it rather than guessing from the branch taken.
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
      // Ticket 5c4242d: no more `mergeTitleChips` appending a fixed extra
      // trio here (see the removal doc comment near the top of this file)
      // -- `suggestedTitles` already carries whatever federal-equivalent
      // titles genuinely fit THIS resume's field, derived by
      // resume-title-inference.ts (ticket 17a5c8f). Runs on every
      // successful submit, not just the first -- a resubmit fully
      // replaces titleChips from the server's fresh suggestedTitles.
      setTitleChips(inferredTitles);
      // Review fix round 2 (ticket cdc2c39): an edit is only "done" once
      // a submission actually lands -- not on the Edit click itself (see
      // `resumeEditing`'s own doc comment above). A no-op on the
      // first-ever submission, where this was already false. Ticket
      // 3db5b35: the nickname reconciliation block below can override
      // this back to `true` for a first-save nickname-commit failure --
      // see its own comment for why staying expanded is what keeps the
      // error visible at all.
      setResumeEditing(false);
      // Ticket 303cff0: a genuinely new resume, a resubmission that
      // matched an existing one (per `createResume`'s find-or-create), or
      // (ticket 6ba221e) an in-place text edit -- in all three cases "My
      // Resumes" should reflect the current state without waiting for some
      // unrelated action to happen to refresh it. An edit changes nothing
      // the list itself displays (id/nickname/createdAt are all
      // untouched), but the list is also what the resumes page renders its
      // per-row text fetches from, and an unconditional refresh here is
      // cheaper to reason about than a per-branch one.
      refreshResumesList();

      // Ticket 3db5b35 -- THE PRE-SAVE SUGGESTION PROBLEM, AND WHY THIS IS
      // THE ANSWER RATHER THAN A NEW ENDPOINT.
      //
      // Jay's feedback (relayed by Nicole) asked for the nickname field to
      // be visible, pre-filled, and editable BEFORE the first save. The
      // real server default (`CreateResumeResponse.resumeNickname`) only
      // exists AFTER `POST /resumes` resolves -- there has never been an
      // endpoint that returns "what would you suggest" without actually
      // creating a resume, and this ticket's own scope (see its git-bug)
      // says not to build one speculatively. So the field above shows a
      // CLIENT-SIDE best-effort guess instead (`nicknameSuggestionSeededRef`'s
      // effect: "Resume " + one more than the already-loaded list's count,
      // the same formula the server itself uses) -- close enough to be a
      // reasonable starting point, not guaranteed to match.
      //
      // That means by the time THIS line runs, two nicknames can both be
      // real: `defaultNickname` (what the server actually resolved --
      // see `isNew` below for why that is NOT necessarily "the new row's
      // default") and `nicknameAtSubmit` (whatever was sitting in the
      // field at the moment of submit -- the unedited guess, or the
      // user's own edit).
      //
      // THE DEFECT THIS GATE EXISTS TO CLOSE (adversarial review finding
      // F1, severe, caught with a passing test that proved it): the
      // ORIGINAL version of this gate was `nicknameAtSubmit !==
      // defaultNickname`, on the theory that a mismatch means "the user
      // edited it." IT DOES NOT. `POST /resumes` is find-or-create (see
      // `saveResumeText`/`createResume`'s own comments) -- a mismatch is
      // EQUALLY produced, and in the single most ordinary returning-user
      // action (paste text you already have saved, touch nothing) MORE
      // LIKELY produced, by the suggestion simply being wrong about a row
      // that already exists under its own real, possibly already-renamed
      // name. That old gate would PATCH the suggestion over it --
      // silently destroying a name the user chose, on a resume they
      // never even opened the nickname field for.
      //
      // So intent now requires BOTH independent signals, neither
      // sufficient alone:
      //   - `isNew` (the server's own `getOrCreateResumeId` answer,
      //     carried onto the wire for the first time by this ticket --
      //     see `CreateResumeResponse.isNew`, @app/shared): PROVES this
      //     request is the one that inserted the row `defaultNickname`
      //     describes, not a find-or-create hit against someone else's
      //     history. Required because `nicknameUserEditedRef` alone is
      //     insufficient too: a user who BOTH types a name AND happens to
      //     paste text that resolves to an existing resume would still
      //     rename that existing row on `nicknameUserEditedRef` alone.
      //   - `nicknameUserEditedRef.current` (set only inside
      //     `handleNicknameChange`, never by the suggestion effect's own
      //     `setResumeNickname` call -- see that ref's own comment):
      //     PROVES a human actually touched the field, which `isNew`
      //     alone cannot: a genuinely new resume whose unedited
      //     client-side guess happens to equal the server's real default
      //     needs no PATCH, but one where it DOESN'T happen to match
      //     (the client/server race the suggestion's own comment already
      //     names) must not trigger a rename the user never asked for
      //     just because the row is new.
      // `nicknameAtSubmit !== defaultNickname` stays as a cheap
      // additional skip (no network call for a no-op match) -- never
      // again as the test of intent by itself.
      if (
        isNewResumeSave &&
        isNew &&
        nicknameUserEditedRef.current &&
        nicknameAtSubmit.length > 0 &&
        nicknameAtSubmit !== defaultNickname
      ) {
        setNicknameSaving(true);
        try {
          const { resumeNickname: saved } = await updateResumeNickname(id, nicknameAtSubmit);
          setResumeNickname(saved);
          setLastSavedNickname(saved);
          refreshResumesList();
        } catch (err) {
          // Same non-reverting treatment `handleNicknameCommit` already
          // gives a collision (ticket 7701534): the user's intended name
          // stays visible, red-outlined, and fixable in place, rather than
          // silently swapped back to the server's generic "Resume N" right
          // after they just typed over it. Any OTHER failure (network,
          // etc.) reverts, same as `handleNicknameCommit`'s existing
          // behavior for that case -- there's nothing wrong with the
          // VALUE, only the request, and the resume itself is already
          // saved under the server's real default either way.
          //
          // UNLIKE `handleNicknameCommit`, both branches here must
          // explicitly ASSIGN `resumeNickname` rather than just choosing
          // whether to revert it: the `setResumeNickname(defaultNickname)`
          // a few lines above (part of the ordinary save-success path,
          // which always runs first) already overwrote it, so "don't
          // revert" has nothing left to fall back to -- the collision
          // branch has to explicitly put the user's attempted value BACK.
          setNicknameError(err instanceof Error ? err.message : String(err));
          if (isNicknameConflictError(err)) {
            setResumeNickname(nicknameAtSubmit);
          } else {
            setResumeNickname(defaultNickname);
            setLastSavedNickname(defaultNickname);
          }
          // `setResumeEditing(false)` above already ran (the resume save
          // itself succeeded) -- with `resumeId` now set and `editingResume`
          // false, the collapsed summary bar is what would render next, and
          // that branch does NOT render `nicknameError` at all (only the
          // expanded form does -- see ResumeInput.tsx). Overriding back to
          // `true` here keeps the form open specifically so the error (and
          // the offending/reverted value) stays visible, same as every
          // OTHER nickname-commit failure already is.
          setResumeEditing(true);
        } finally {
          setNicknameSaving(false);
        }
      }
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
  //
  // Ticket 3db5b35 (review finding F1, severe): also the ONLY place
  // `nicknameUserEditedRef` is ever set `true`. The pre-save suggestion
  // effect above deliberately calls `setResumeNickname` directly, never
  // this function, so a value this app guessed on the user's behalf can
  // never be mistaken for one the user actually typed -- `handleResumeSubmit`
  // reads this ref before ever treating a first-save nickname as something
  // to apply over the server's own default.
  //
  // CORRECTED, d7d3d59: this comment used to say the ref is "never reset
  // back to `false`", which was true only while its single reader could not
  // be reached twice per session. `handleStartPasteNew` now DOES reset it,
  // and that reset is load-bearing rather than tidiness -- without it, a
  // stale `true` from the first resume would let the second resume's
  // untouched suggestion be applied as though the user had typed it.
  // See the ref's own declaration, and the dedicated test.
  function handleNicknameChange(nextNickname: string) {
    nicknameUserEditedRef.current = true;
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
    // TICKET d7d3d59, THE DATA-LOSS HALF. `resumeId` is set during "paste a
    // new resume" and names the PREVIOUS, still-active resume -- so without
    // this line, naming the resume you are about to create renamed the one you
    // just declined to reuse, on blur, with no error and no sign anything had
    // happened. Same family as 3db5b35's F1 (a client that could not tell
    // which resume a nickname belonged to), and the same answer: the field is
    // purely local state until a save gives it a real row to attach to, which
    // is already exactly what it does before a FIRST save (the
    // `resumeId === undefined` return above). `handleResumeSubmit` is what
    // persists the typed name, via the reconciliation PATCH against the id the
    // POST actually returns.
    if (pastingNewResume) return;
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
    // Ticket d7d3d59: the other exit from "paste a new resume" (the first is a
    // submit that lands). Nothing was created, so the previously-active resume
    // is active again in every respect -- including its own nickname, which the
    // `setResumeNickname(lastSavedNickname)` above already restores over the
    // suggestion this flow seeded. Without clearing the flag here, that
    // restored real nickname would then be unrenameable: `handleNicknameCommit`
    // would keep refusing to PATCH for the rest of the session.
    setPastingNewResume(false);
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
  //
  // Ticket d7d3d59: this is also where the nickname field is handed over from
  // the OLD resume to the one about to be created. Three writes, each closing
  // one half of this ticket's bug:
  //   - `setPastingNewResume(true)` -- the form is now composing a resume that
  //     does not exist yet (see that state's own doc comment for why this is a
  //     flag rather than `setResumeId(undefined)`).
  //   - clearing `resumeNickname` and re-arming
  //     `nicknameSuggestionSeededRef` -- together these let the suggestion
  //     effect seed a real "Resume N+1" for THIS resume. Clearing is what makes
  //     the effect's `prev === ""` guard pass; re-arming the ref is what makes
  //     it run at all a second time. `lastSavedNickname` is deliberately NOT
  //     cleared: it is still the old resume's server-confirmed name, which
  //     `handleCancelEdit` restores from and which the persist effect keeps
  //     writing to sessionStorage, correctly, for as long as that resume is the
  //     active one.
  //   - resetting `nicknameUserEditedRef` -- a `true` latched while renaming
  //     the PREVIOUS resume must not be read as "the user typed a name for this
  //     one" (see that ref's own comment for the concrete rename-then-paste
  //     scenario that produces).
  function handleStartPasteNew() {
    activationTokenRef.current++;
    setResumeChanging(false);
    setResumeActivating(false);
    setResumeEditing(true);
    setNicknameError(null);
    setResumeError(null);
    setPastingNewResume(true);
    nicknameSuggestionSeededRef.current = false;
    nicknameUserEditedRef.current = false;
    setResumeNickname("");
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
    // Review fix (F2, ticket 11ead86): which tab this click actually
    // happened on -- a plain closure read of `activeTab` is correct here
    // specifically BECAUSE it's taken before the `await` below, while this
    // call is still running with the render that owned the click. See the
    // tab-switch call near the end of this function for what it's for.
    const tabAtClick = activeTab;
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
      // Ticket 88f11d7, then 5c4242d (no more appended extras -- see this
      // file's removal doc comment near the top): an activated resume's
      // OWN cached suggestions, not whatever chips happened to be showing
      // for the resume being switched away from.
      setTitleChips(data.suggestedTitles ?? []);
      setResumeEditing(false);
      setResumeChanging(false);
      setResumeError(null);
      // Adversarial review fix (F1, ticket 11ead86, blocker): this handler
      // used to leave `pastingNewResume` untouched, on an invariant
      // `saveResumeText`'s own comment states explicitly -- "the picker
      // that sets it is reachable only from a locked resume's 'Change',
      // since only a locked resume has a 'Change' button at all" -- which
      // was true back when `handleActivateResume` had exactly one caller
      // (that same picker, always reached with `resumeLocked` true
      // alongside it). `MyResumes`'s new "Use {nickname}" action is a
      // SECOND caller, reachable with `pastingNewResume` true and
      // `resumeLocked` either value: a user can open "Change" -> "Paste a
      // new resume" (setting `pastingNewResume` true), think better of it,
      // switch to the "My Resumes" tab INSTEAD of clicking Cancel, and
      // activate a different saved resume from there. Without this reset,
      // every future action on the NEWLY ACTIVATED resume was silently
      // misrouted by `pastingNewResume` still reading true:
      // `handleNicknameCommit`'s `if (pastingNewResume) return;` swallowed
      // a rename of the real, now-active resume with no error and no
      // visible sign it hadn't happened, and `saveResumeText` routed a
      // text edit to `createResume` instead of `updateResumeText` --
      // minting a surprise new resume on an ordinary edit, which is ticket
      // 6ba221e's own user report ("I make an edit and I hit save and it's
      // still called resume one, it actually becomes resume 2") restored
      // through a door that ticket's fix never anticipated. Resetting here
      // restores the invariant for BOTH callers: a no-op for the picker's
      // own "Use Resume N" (which never sets this flag in the first
      // place), real for this one.
      setPastingNewResume(false);
      // Investigated, not fixed (reviewer's flag): does `nicknameUserEditedRef`/
      // `nicknameSuggestionSeededRef` need the same reset? No live bug found --
      // recorded rather than silently dropped. `nicknameUserEditedRef.current`
      // is read only inside `handleResumeSubmit`'s rename-reconciliation gate,
      // behind `isNewResumeSave` (`resumeId === undefined || pastingNewResume`,
      // captured fresh at THAT call's own start) -- with `pastingNewResume`
      // now correctly false here, any later submit against the just-activated
      // resume has `isNewResumeSave === false`, so a stale `true` left over
      // from an abandoned "paste new" never reaches that gate regardless of
      // this ref's value. `nicknameSuggestionSeededRef`'s own effect
      // independently re-checks `resumeId !== undefined && !pastingNewResume`
      // first and returns before ever consulting this ref -- also now closed
      // by the same reset. Both refs are inert here once `pastingNewResume`
      // itself is correct; resetting them too would be redundant defense, not
      // a second bug.
      // Ticket 11ead86 (acceptance criterion): land on "New Job Search" on
      // a successful activation -- `handleViewResume` already demonstrates
      // the tab-switch pattern in the other direction (results -> My
      // Resumes).
      //
      // Review fix (F2, ticket 11ead86): GUARDED, not unconditional. An
      // earlier version fired this unconditionally, on the claim that it
      // was "a no-op when this fires from the search tab's own picker,
      // already on that tab." That claim is only true if the tab hasn't
      // changed since the click -- false in general, because this `await`
      // gives the user a real window to navigate: click "Use Resume 8"
      // from "My Resumes", switch to "Already Scored Jobs" while
      // `getResume` is still in flight, and the unconditional version
      // yanked the user back to "New Job Search" out from under whatever
      // they'd switched to read. `activeTabRef` (declared near
      // `activeTab`'s own `useState`) is what makes "still on the tab this
      // click happened from" checkable here, where a plain closure read of
      // `activeTab` (frozen at `tabAtClick`, above) cannot be: only switch
      // if nothing moved the tab out from under this call while it was
      // waiting on the network.
      if (activeTabRef.current === tabAtClick) setActiveTab("search");
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

  // Ticket 9e5fcf3 (part (c)), cause found and verified 2026-10-10: this
  // used to call `refresh()` and stop there -- `refresh()` is `useResults`'s
  // own callback, feeding ONLY "Results from this search". It never touched
  // `refreshAllResults()` (`useAllResults`'s callback, feeding "Already
  // Scored Jobs"), so a freshly-completed search's new rows never reached
  // that tab's list OR its header count without a full page reload --
  // `scoredJobCount` (declared above) derives from the exact same
  // `allResultsState` that list reads, so the one missing call explains
  // BOTH of Nicole's "things are not automatically updating" reports at
  // once. `refreshAllResults()` is safe to add unconditionally here for the
  // same reason `handleSetStatus`/`handleClearStatus` already call it
  // alongside `refresh()`: `useAllResults`'s own stale-while-revalidate
  // design (see that hook's doc comment, mirroring `useResults`'s) means
  // this refetch updates the list in place rather than flashing it away --
  // the exact regression `useResults.ts`'s line-48 comment records Nicole
  // hitting once already, now doubly guarded against by sharing that same
  // hook design rather than inventing a different refresh here.
  function handleSearchComplete(searchId: string) {
    // Ticket 9e5fcf3 (part (b)): set BEFORE `refresh()` below, deliberately.
    // `lastSearchId` already joins `useResults`'s dependency array, so this
    // alone is enough to make the next fetch ask for the right scope --
    // ordering it first means that even in the (here, purely theoretical --
    // React 18's automatic batching coalesces both of this function's
    // `setState` calls into one re-render in practice) case where these two
    // updates landed across two separate renders instead of one, the FIRST
    // of those renders would already carry the correct, new `searchId`
    // rather than a stale one. See that state's own declaration comment for
    // the full argument for scoping this server-side.
    setLastSearchId(searchId);
    refresh();
    refreshAllResults();
    // The one place `hasFreshSearchResults` is ever set true — SearchFlow
    // only calls onSearchComplete when a run's poll result.status is
    // literally "complete" (never on "failed"/"incomplete"), so this is a
    // genuine successful run, not a speculative or partial one.
    setHasFreshSearchResults(true);
  }

  // Ticket d0a7074, Nicole (dogfooding): "is there a magic link opportunity
  // on the already scored jobs page too?" -- then, once told it wasn't
  // there: "that's what I was hoping to see." So the offer now covers both
  // results tabs, not just "Results from this search".
  //
  // WHY THIS IS ONE HOISTED INSTANCE AND NOT ONE PER TAB: all three tab
  // panels stay mounted at once (only `hidden` toggles -- ticket f4a7f07),
  // and MagicLinkPrompt keeps `dismissed`/`email`/`phase` in its own local
  // state. Two mount points would therefore be two INDEPENDENT states:
  // "Not now" on one tab and the prompt is still sitting there on the
  // other, or submit the address on one tab and the other still shows an
  // empty form asking again.
  //
  // Ticket 931df8a superseded the mechanism this paragraph used to
  // describe, so it is rewritten rather than left to describe a design
  // that no longer exists: the prompt was `position: fixed` (ticket
  // d3a95d1), which made it trivially detached from any particular
  // section -- "the card renders in the same corner either way" was true
  // precisely because it rendered nowhere in document flow at all. The
  // anchor DOM node is placed right after the topmost result of whichever
  // tab is active (see `magicLinkAnchor`/`magicLinkPortalRoot`, declared
  // below this function's `showMagicLinkPrompt`), which is the opposite
  // property: which section it belongs to is no longer incidental, it is
  // exactly the gate below. What hasn't changed is the REASON for one
  // hoisted instance -- `<MagicLinkPrompt />` still mounts once, at this
  // same JSX call site, never duplicated per tab -- only how its RENDERED
  // DOM gets to the right section (a portal moved between anchors,
  // instead of a fixed box that didn't need to move at all).
  //
  // Ticket 042db32: that anchor DOM node's OWN position here is unchanged
  // by this paragraph's ticket -- still right after the topmost result,
  // for all the same reasons above. What 042db32 changed is purely CSS,
  // in index.css, on top of this same node: at a wide-enough viewport the
  // card now renders visually beside the results (taken out of the
  // results list's own vertical flow) rather than sandwiched between two
  // specific result cards, with a separate, explicitly-argued fallback for
  // viewports with no "side" to float to. See index.css's comment at
  // `.magic-link-prompt-anchor` for why (another round of real user
  // feedback: in-flow placement fixed one complaint and caused another),
  // and for why that is a CSS-only change that needed nothing different
  // from this hook or from `ResultsList.tsx`/`GroupedResultsList.tsx`.
  //
  // WHAT THE GATE PRESERVES: ticket 9f06f8f's placement rule is unchanged
  // -- the email is asked for only after real scored results are on
  // screen, never before. Both arms require at least one VISIBLE result:
  // "find these results again later" is a strange offer when nothing is on
  // screen to come back for, and `hiddenBelowFloor` alone doesn't count --
  // the user cannot see those. The "My Resumes" tab is not an arm at all,
  // so it never shows the prompt.
  //
  // `searchArmReady` reproduces the FULL chain of conditions the old
  // mount inherited from its ancestors, not just the `length > 0` check it
  // carried inline. Opus review (F1, BLOCKING) caught that the first
  // version of this gate dropped the `{resumeId && ...}` and
  // `hidden={resumeEditing || resumeChanging}` wrappers it used to live
  // inside: with those gone, clicking "Change" or "Edit" on the collapsed
  // resume bar left this fixed-position card floating over the resume
  // picker, whose own section gets no clearance padding -- occluding the
  // bottom rows and, on a narrow viewport, the "Submit" button
  // itself, with no way to scroll out from under it. That is the exact
  // occlusion class the clearance rule below exists to prevent,
  // reintroduced somewhere the clearance does not reach.
  const searchArmReady =
    resumeId !== undefined &&
    !resumeEditing &&
    !resumeChanging &&
    hasFreshSearchResults &&
    resultsState.status === "ready" &&
    resultsState.data.results.length > 0;

  const scoredArmReady =
    allResultsState.status === "ready" && allResultsState.data.results.length > 0;

  const showMagicLinkPrompt =
    (activeTab === "search" && searchArmReady) || (activeTab === "scored" && scoredArmReady);

  // Ticket 931df8a, Jay's feedback relayed by Nicole: the prompt was
  // `position: fixed` bottom-right, so it appeared next to the search
  // controls the instant a search finished -- Jay was still scrolled at the
  // top and had no idea any results existed yet. "The trigger ... is great,
  // ... When he happens to scroll down is when he should start being able
  // to see that email message." So the fix is WHERE this renders, not WHEN
  // -- `searchArmReady`/`scoredArmReady`/`showMagicLinkPrompt` above are
  // untouched.
  //
  // `ResultsList`/`GroupedResultsList` hand back the DOM node right after
  // the topmost result via `onFirstResultAnchorChange`, computed into
  // `magicLinkAnchor` below. Placed after the FIRST result, not the last:
  // the old `position: fixed` design (ticket d3a95d1) exists on the
  // historical record specifically because "inline at the end of the
  // results list... meant a long results list could push it far below the
  // fold -- never reached in practice". Anchoring to the END would
  // reintroduce exactly that failure the first time either tab's list
  // grows (the "Already Scored Jobs" tab spans every resume ever scored,
  // per ticket 3f0883f, so it is not even bounded the way a single
  // search's curated list is). Anchoring ABOVE the topmost result would
  // satisfy the ticket's literal rule too, but makes the ask the first
  // thing a scrolling user meets, ahead of the results they opened the tab
  // for -- the thing Jay was actually looking for. After the first result
  // is the compromise: a user who scrolls past result #1 has necessarily
  // seen that there ARE results (fixing Jay's exact complaint), without
  // the ask outranking them.
  const [searchResultsAnchor, setSearchResultsAnchor] = useState<HTMLLIElement | null>(null);
  const [scoredResultsAnchor, setScoredResultsAnchor] = useState<HTMLLIElement | null>(null);
  // Fallback for the one case neither list can offer an anchor: all of a
  // tab's results filtered down to zero VISIBLE cards by ResultsList's/
  // GroupedResultsList's own hide-overqualified/underqualified/contract
  // checkboxes (data.results.length > 0, so the arm is still "ready" --
  // see searchArmReady/scoredArmReady above, which key off the UNFILTERED
  // fetch -- but `visible.length` is 0, so no `<ResultCard>`, and therefore
  // no anchor, is rendered). Without this, that filter state would leave
  // `magicLinkPortalRoot` (below) with nowhere to live, which would have
  // the same practical effect as unmounting it -- losing a dismissal, a
  // half-typed address, or a just-sent "check your inbox" receipt over
  // nothing but a checkbox click, the exact class of bug ticket d0a7074's
  // review F2 already fixed once. Always mounted (independent of any
  // gate) and empty unless actually pressed into service, so it costs
  // nothing in the common case.
  const [fallbackMagicLinkAnchor, setFallbackMagicLinkAnchor] = useState<HTMLDivElement | null>(
    null,
  );
  // Uses the anchor belonging to the ACTIVE tab, and ONLY that one -- never
  // borrows the other tab's anchor as a stand-in. Review round 2 (BLOCKING):
  // an earlier version fell through to `searchResultsAnchor ?? scoredResultsAnchor`
  // before reaching the fallback below, on the theory that any live anchor
  // beats none. That reasoning ignored WHERE the borrowed anchor lives:
  // both tab panels are `<div hidden={activeTab !== ...}>` (`display:
  // none` on the inactive one), so borrowing the other tab's anchor
  // attaches `magicLinkPortalRoot` inside a `display: none` subtree while
  // `showMagicLinkPrompt` -- and therefore `magicLinkPortalRoot.hidden` --
  // is `false`. The app believes the card is on screen; it is invisible
  // and out of the accessibility tree. Reproduced concretely: one search
  // result with `levelFit: "overqualified"` (so `searchArmReady` stays
  // true -- it keys off the unfiltered fetch) plus one scored job on the
  // OTHER tab (so `scoredResultsAnchor` is set, but inside that tab's
  // hidden panel); checking "Hide roles I'm overqualified for" empties
  // `visible`, nulling `searchResultsAnchor`; the old chain fell through to
  // the hidden `scoredResultsAnchor` instead of the fallback, and the
  // heading query failed with the host measurably `hidden: false` inside a
  // `[hidden]` ancestor. It is reachable in the owner's own data too: both
  // of her real applied-to postings are in the overqualified bucket
  // (ResultsList.tsx's own comment on `hideOverqualified`), and "Already
  // Scored Jobs" accumulates every job ever scored, so this is the normal
  // steady state after her first search, not a contrived edge case.
  //
  // The fallback below already does, strictly better, what the borrow was
  // trying to do: it is always mounted AND visible (never inside a
  // `hidden` tab panel), so it keeps `magicLinkPortalRoot` attached
  // somewhere live without ever attaching it somewhere invisible. The
  // "filtered to zero cards" test exercises exactly this path.
  const magicLinkAnchor =
    (activeTab === "scored" ? scoredResultsAnchor : searchResultsAnchor) ?? fallbackMagicLinkAnchor;

  // The portal target `<MagicLinkPrompt />` always renders into (see the
  // mount site, near the end of this component). Created exactly ONCE --
  // the lazy `useState` initializer runs again under StrictMode's dev-only
  // double-invoke, but only one of the two resulting elements is ever kept
  // and used, and discarding the other is harmless since nothing has been
  // attached to it yet (the same "safe to double-invoke" shape as `useState(
  // () => new Map())`) -- and NEVER replaced, which is the whole point:
  // this is not the same thing as `magicLinkAnchor` above, and the
  // difference is load-bearing. An earlier version of this fix portaled
  // `MagicLinkPrompt` directly into `magicLinkAnchor`, which changes
  // identity on every tab switch -- and confirmed by running it (two of
  // this ticket's own new tests failed, each showing the card reset to its
  // untouched pitch state after a tab switch that should have preserved
  // "dismissed" or "check your inbox"): React's portal reconciliation
  // compares the CONTAINER, not just the children, so handing `createPortal`
  // a different DOM node unmounts and remounts whatever it was told to
  // render, destroying `dismissed`/`email`/`phase` -- exactly the F2
  // failure ticket d0a7074 already fixed once, reintroduced by a different
  // mechanism. Portaling into THIS node instead, and separately moving
  // *this node itself* between anchors with plain imperative DOM calls
  // (the effect below) rather than through `createPortal`'s own container
  // prop, keeps the container React sees constant, so it never tears the
  // portaled component down no matter which anchor currently holds it.
  const [magicLinkPortalRoot] = useState(() => {
    const el = document.createElement("div");
    el.className = "magic-link-prompt-host";
    return el;
  });

  // Moves `magicLinkPortalRoot` to whichever anchor is currently correct,
  // via plain `Node.appendChild` -- which also REMOVES it from wherever it
  // was previously attached, so one call both detaches and reattaches.
  // This is pure DOM manipulation outside React's tree entirely (React
  // only ever manages `magicLinkPortalRoot`'s CONTENTS via the portal at
  // the mount site, never its parent), which is exactly why it does not
  // trigger the remount described above: nothing about this changes what
  // `createPortal` is told to target.
  //
  // `useLayoutEffect`, not `useEffect`: runs synchronously after the DOM
  // mutations of this same commit but before the browser paints, so a
  // freshly-available anchor (e.g. the moment a search completes) does not
  // have even one paint where the card is attached to its old position (or
  // nowhere at all, on the very first anchor it ever gets).
  //
  // Review round 2, required: the invariant this `appendChild` depends on,
  // stated explicitly because nothing else in this file says it. `magicLinkAnchor`
  // is a `<li className="magic-link-prompt-anchor" ... />` that React
  // renders with NO children of its own (see ResultsList.tsx/
  // GroupedResultsList.tsx -- it is always a self-closing element). That is
  // load-bearing, not incidental: React only reconciles a DOM node's
  // children if IT rendered that node with children in the first place.
  // Appending `magicLinkPortalRoot` here, outside React, is invisible to
  // React precisely because React has nothing of its own to reconcile
  // inside this `<li>` on the next render -- it never looks inside and
  // never notices (let alone removes) a node it didn't put there. If
  // either component is ever changed to give this `<li>` real React
  // children, that next render's reconciliation WILL diff the `<li>`'s
  // child list against what React itself rendered, which does not include
  // `magicLinkPortalRoot` -- and can drop it.
  useLayoutEffect(() => {
    if (magicLinkAnchor && magicLinkPortalRoot.parentNode !== magicLinkAnchor) {
      magicLinkAnchor.appendChild(magicLinkPortalRoot);
    }
  }, [magicLinkAnchor, magicLinkPortalRoot]);

  // `showMagicLinkPrompt` is unchanged (see above) -- what changed is HOW
  // it hides the card. The old JSX-authored host div could set `hidden`
  // declaratively; `magicLinkPortalRoot` is a plain DOM node React does not
  // render attributes onto, so this effect is the direct equivalent.
  // `useLayoutEffect` for the same before-paint reason as the move above.
  useLayoutEffect(() => {
    magicLinkPortalRoot.hidden = !showMagicLinkPrompt;
  }, [magicLinkPortalRoot, showMagicLinkPrompt]);

  // Ticket 5a7e957: the "been here before?" entry point, for someone who
  // saved their email and then lost this browser's storage. Nicole's own rule
  // for when it belongs on screen: "on any site run where there's no data?
  // because if there is data, or they use the site normally, they'll get
  // prompted as we discussed."
  //
  // That is the right rule for a reason worth writing down: `MagicLinkPrompt`
  // ALREADY performs recovery, because an address that already has an account
  // takes the adopt branch in `routes/auth.ts`. So a second entry point is
  // needed only where the prompt cannot render -- nothing scored. Two doors
  // into the same room at once would just be confusing.
  //
  // `resumeId === undefined` is the refinement: someone who has pasted a
  // resume but not searched yet has no scored results, but is mid-onboarding
  // rather than lost, and offering them a way back would read as the app not
  // noticing what they are doing. `hiddenBelowFloor` counts as data here --
  // jobs exist, they are merely filtered, so this browser is plainly not
  // empty.
  //
  // Whether the visitor is signed in is NOT checked here: `SignInRecovery`
  // reads `getVerifiedEmail()` itself and renders nothing when set, the same
  // way `SignedInCue` does the inverse. The two share the header slot and are
  // mutually exclusive by construction.
  // Opus review N1: `resumesListState` too, not just `resumeId`. `resumeId`
  // comes from `sessionStorage`, so it is TAB-scoped -- close the tab and the
  // "they're mid-onboarding, not lost" refinement evaporates, and a returning
  // visitor with saved resumes but nothing scored would be offered a way back
  // they cannot need. Resumes are scoped to the user id in `localStorage`, so
  // their mere existence proves that id survived, which is exactly the
  // question "are they lost?" is asking. This is the account-scoped version
  // of the check the session-scoped one was standing in for.
  // Opus review round 3 (S2): an ERROR in either fetch means "we don't know
  // whether this browser has data", and the two guesses do not cost the same.
  // Guessing "has data" hides the only path back from the one person who by
  // definition cannot see their own data -- and the error that would explain it
  // renders inside a tab panel they may not be looking at (the default tab is
  // "search"). Guessing "empty" costs a returning user one redundant offer,
  // which the adopt branch handles idempotently. `loading` still withholds it,
  // so the link does not flash in and out on a slow connection. The two fetches
  // are issued from independent effects, so the wait is max(t1, t2), not their
  // sum.
  const nothingScoredInThisBrowser =
    allResultsState.status === "error" ||
    (allResultsState.status === "ready" &&
      allResultsState.data.results.length === 0 &&
      (allResultsState.data.hiddenBelowFloor ?? 0) === 0);
  const noResumesOnThisAccount =
    resumesListState.status === "error" ||
    (resumesListState.status === "ready" && resumesListState.data.resumes.length === 0);
  const showSignInRecovery =
    resumeId === undefined && noResumesOnThisAccount && nothingScoredInThisBrowser;

  // Ticket 9e00bc9 built a gate here (`showWelcomeParagraph`, backed by
  // `hasOwnResumes` and an App-level `verifiedEmail` read) so the welcome
  // paragraph below would disappear once this browser/account had evidence
  // of prior use. Ticket 0a378a5 removed that gate at Nicole's explicit
  // instruction -- "make that paragraph always visible" -- after she looked
  // for the paragraph she had asked for on her own app and could not find
  // it. The gated behavior was never something she asked for; the PM had
  // put "should it show for returning users too" into 9e00bc9's scope and
  // framed a permanent explainer as clutter on her behalf. This is a
  // correction of that framing, not a reversal of a decision she made.
  //
  // The gate's own history is worth keeping even though the gate is gone.
  // Opus review round 1 (F2) measured, in real Chromium against this app's
  // built CSS, a real layout jump on every load for a returning user with
  // data if the paragraph defaulted to visible during the loading window
  // before `useResumesList`/`useAllResults` resolve -- 146.3px at 1280px
  // wide, 235.9px at 390px, both hooks starting `idle` and settling in a
  // post-mount effect. `getVerifiedEmail()` read synchronously
  // (`useState(getVerifiedEmail)`, the same pattern `SignedInCue` still
  // uses) eliminated it: a verified visitor never saw the paragraph for even
  // one frame, so there was no loading window left to jump out of.
  //
  // Those figures are NOT moot, and an earlier version of this comment
  // saying so was exactly wrong -- opus review of 0a378a5 (F1) caught it.
  // The gate never created that 146.3px / 235.9px cost; it HID it. Removing
  // the gate converts a transient jump into a permanent COST of identical
  // size (a jump is transient by definition; the cost is what persists): 146.3px at 1366/1280px wide and 235.9px at 390px are now the
  // paragraph's STANDING contribution to above-fold height on every render
  // for every visitor. Re-measured independently in real Chromium against
  // this app's built CSS, 2026-10-08, and reproduced to the digit.
  //
  // What that costs, measured rather than guessed, and who pays it: a
  // first-time visitor pays nothing -- no saved resumes and no signed-in cue
  // (unverified by definition), so the paste box sits fully visible with
  // 206px of headroom on a 1366x768 laptop and 148px on a 390x844 phone. The
  // cost lands on a RETURNING user with saved resumes, which is to say the
  // owner, who is the one person the paragraph is not for: the paste box's
  // bottom edge sits 3.1px below the fold at 3 saved resumes on laptop,
  // 67.6px below at 8, and 88.5px / 153.0px below on phone. It saturates at
  // 8 because `.resume-pick-saved .resume-picker-options` caps at
  // `max-height: 12rem`, so the worst case is bounded. The paste box is
  // never HIDDEN in any measured case -- the "Paste your resume" label and
  // the textarea's top edge stay above the fold throughout, and `Submit`
  // only renders once there is text -- so this is degraded, not broken. It
  // has its own ticket; see git-bug for the measured levers.
  //
  // Do not read any of this as license to reintroduce a gate. The owner
  // asked for the paragraph to be always visible, in those words, after
  // looking for it on her own app and not finding it. The fold cost is paid
  // by shortening or tightening the paragraph, or by reclaiming vertical
  // space elsewhere on the page -- not by hiding it from anyone.
  //
  // One known defect is made permanent by this change, recorded here rather
  // than dropped (review F3) because 9e00bc9 documented it and deleting the
  // note while universalizing the defect would lose it: beside
  // `SignedInCue`, a verified user now sees this unverified-newcomer
  // greeting and "These results are saved to <email>" on screen at the same
  // time. 9e00bc9's gate closed that as a side effect. Accepted consequence
  // of an explicit instruction, not an oversight -- the fix is to reword the
  // paragraph so it reads sensibly to someone already signed in, which is a
  // copy decision and hers to make.

  // Latches true the first time the recovery offer is due, so the component is
  // not mounted before then. A ref rather than state: it only ever goes true,
  // and nothing needs a re-render on its account -- the render that sets it is
  // already happening. Monotonic and idempotent, so StrictMode's double
  // invocation is harmless. NOT what preserves the panel's state across the
  // gate closing; see the mount site.
  if (showSignInRecovery) signInRecoveryEverShownRef.current = true;
  const signInRecoveryEverShown = signInRecoveryEverShownRef.current;

  return (
    <main className="app">
      {/* Ticket a5c8fa9: the h1 and the signed-in cue share one row, so the
          cue sits top-right of the app without being `position: fixed` --
          see SignedInCue's own doc comment for why that distinction has
          mattered repeatedly here. Renders nothing at all when the visitor
          has no verified email, in which case this collapses to just the
          heading. */}
      <div className="app-header">
        <h1>FitScore</h1>
        <SignedInCue />
        {/* Opus review F1: the gate is passed DOWN as `offered` rather than
            used to mount or unmount, for the same reason the prompt host
            below uses `hidden` -- a bare `{showSignInRecovery && ...}`
            destroys the component's state the instant the gate closes. The
            most natural thing a user does while waiting for the email is
            start pasting their resume, which gives this browser data, closes
            the gate, and used to take the "Check your inbox" confirmation off
            screen mid-wait. `SignInRecovery` decides for itself whether to
            render, and deliberately keeps showing a confirmation after
            `offered` goes false: a receipt is not an offer.
            `signInRecoveryEverShown` only delays the FIRST mount until the
            offer has been earned once; it is not what preserves state (opus
            review round 3, N-a: removing it entirely passes the whole suite,
            because `SignInRecovery`'s own null-return already does that work).
            Kept because mounting nothing before the offer is due is tidier
            than mounting a component that immediately returns null. */}
        {signInRecoveryEverShown && <SignInRecovery offered={showSignInRecovery} />}
      </div>

      {/* Ticket 9e00bc9: a sibling of `.app-header`, not a child of it,
          deliberately. `.app-header` is `display: flex; flex-wrap: wrap`
          with a top-right slot already shared by `SignedInCue` and
          `SignInRecovery` (tickets a5cf8a9, 5a7e957) -- dropping a
          full-width paragraph INTO that row would need its own
          `flex-basis: 100%` (the precedent `.sign-in-recovery-open` already
          sets) just to behave like a normal block element. Placing it after
          the row instead gets that behavior for free, in normal flow, with
          zero risk of disturbing where the cue or the recovery link land --
          and the ticket's own placement rule ("in `.app-header` or
          immediately after it") allows exactly this.

          Ticket 0a378a5: renders unconditionally now -- see the comment
          above `signInRecoveryEverShownRef` for the gate this replaced and
          why its own measurements are kept. Deliberately a `<p>`, not a
          `<section>`: `index.css`'s global `section` rule would give this a
          top border that was never wanted here. */}
      <p className="app-welcome">
        Welcome to FitScore! Find jobs that fit your experience—not just your search terms. We take
        the pain out of job hunting by searching open roles for you and comparing them directly with
        your resume. Each job gets a match score from 1–100, so you can quickly spot the
        opportunities that best align with your skills and experience. Spend less time searching and
        more time applying!
      </p>

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
          {formatCount(scoredJobCount)}
        </button>
        <button
          type="button"
          className="tab-button"
          aria-pressed={activeTab === "resumes"}
          onClick={() => setActiveTab("resumes")}
        >
          My Resumes
          {formatCount(resumeCount)}
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
            // Ticket 582ee40: lets ResumeInput's ordinary form branch tell an
            // unlocked "Edit" apart from the locked picker's "Paste a new
            // resume" -- both reach that branch with `resumeId` already set,
            // and only the former should show the saved-resume list again
            // (see that branch's own comment in ResumeInput.tsx for the full
            // argument).
            pastingNewResume={pastingNewResume}
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
              <h2>Search these jobs — and see the cost first</h2>
              <p className="search-pitch">
                Claude actually compares your resume against each job description that matches your
                titles, one at a time, and judges how well you&apos;d really fit. That real
                comparison is what the cost below pays for.
              </p>
              <SearchFlow
                resumeId={resumeId}
                sourceIds={[...selectedSourceIds]}
                criteria={criteria}
                // Ticket 4cafff3: the raw form, not just the derived
                // `criteria` above -- see SearchFlow's own `formState` doc
                // comment for why. Deliberately built the same shape
                // `buildSearchCriteria` takes (titleChips + the whole
                // `CriteriaFormState`), so every field this ticket's scope
                // lists (nearLocations, expandMetroAreas, remoteOk,
                // anyLocationOk, commitmentIn, titleChips) is covered by
                // construction, not by an enumerated list that could drift
                // out of sync with `CriteriaFormState` itself.
                formState={searchFormState}
                disableEstimate={!hasLocationSignal}
                onEstimateStart={() => {
                  setHasFreshSearchResults(false);
                  // Ticket 9e5fcf3: a re-estimate with the SAME
                  // criteria/sourceIds (clicking "Done" then "Get estimate"
                  // again without changing anything) doesn't re-run the
                  // `[selectedSourceIds, criteria, resumeId]` effect above
                  // (none of its deps changed), so `lastSearchId` would
                  // otherwise keep pointing at the PREVIOUS completed
                  // search through the whole "estimating"/"estimated" dead
                  // window -- harmless (same resume, so no 404 risk;
                  // nothing renders it while `hasFreshSearchResults` is
                  // false either way) but stale. Clearing it here too keeps
                  // it tracking "the last FRESH search" in lockstep with
                  // `hasFreshSearchResults`, the same symmetry this
                  // callback already keeps for that state.
                  setLastSearchId(undefined);
                }}
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
                // Ticket 9e5fcf3 (part (a)): see `freshResultsCount`'s own
                // doc comment (SearchFlow.tsx) for why this is computed
                // here rather than inside SearchFlow, and the "View N
                // results" button's own JSX comment there for the full
                // argument for a click-triggered scroll over auto-scroll.
                freshResultsCount={
                  hasFreshSearchResults && resultsState.status === "ready"
                    ? resultsState.data.results.length
                    : undefined
                }
                onViewResults={handleViewResults}
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
                this component beyond the data it's handed. Ticket 9e5fcf3
                (part (b)): that same fetch is now also scoped to
                `lastSearchId` (useResults.ts), so this list holds only the
                MOST RECENT search's own results -- a second search on the
                same resume no longer pools together with the first's
                (Nicole, relaying John's testing: "he was expecting to see
                results from only this search"). `resultsSectionRef`
                (ticket 9e5fcf3 part (a)) is the scroll target for
                SearchFlow's "View N results" button above -- attached to
                this whole section rather than just the list so the score
                floor control and the "No jobs matched" fallback are both
                included in what scrolling into view actually shows. */}
            {hasFreshSearchResults && resultsState.status === "ready" && (
              <section className="results-section" ref={resultsSectionRef}>
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
                    onFirstResultAnchorChange={setSearchResultsAnchor}
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
            {formatCount(scoredJobCount)}
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
                groupFor={scoredGroupFor}
                onSetStatus={handleSetStatus}
                onClearStatus={handleClearStatus}
                onViewResume={handleViewResume}
                onFirstResultAnchorChange={setScoredResultsAnchor}
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
            {formatCount(resumeCount)}
          </h2>
          {resumesListState.status === "loading" && <p>Loading resumes...</p>}
          {resumesListState.status === "error" && (
            <p role="alert">Could not load resumes: {resumesListState.message}</p>
          )}
          {resumesListState.status === "ready" && (
            <MyResumes
              resumes={resumesListState.data.resumes}
              focusResume={focusResume}
              // Ticket e7666de: a rename changes which row sorts where
              // (`sortResumesByNickname`, in MyResumes.tsx), and that sort
              // runs over THIS array -- refetching it is what actually
              // moves the row, not anything MyResumes can do locally.
              onRenamed={refreshResumesList}
              // Ticket 11ead86: the SAME activation state/handler the
              // search tab's "Change" picker already uses (ticket
              // 88f11d7) -- a second caller of `handleActivateResume`,
              // not a second copy of its state. `activeResumeId` is what
              // lets exactly one row show "Active" instead of a redundant
              // "Use {nickname}" button; see MyResumes.tsx's own comment
              // for why that row isn't simply hidden.
              activeResumeId={resumeId}
              onActivateResume={(id) => void handleActivateResume(id)}
              activating={resumeActivating}
              activateError={resumeActivateError}
              searching={searchRunning}
            />
          )}
        </section>
      </div>

      {/* Ticket 9f06f8f (epic 2b9e9dd child 4): THE ONE PLACE the email is
          ever asked for. Ticket d0a7074 hoisted the HOST here, out of the
          search tab's own results section, so that a SINGLE instance can
          serve both results tabs -- see `showMagicLinkPrompt` above for the
          gate it carries instead of physical nesting, and for why one
          instance rather than one per tab.

          `hidden`, NOT conditional rendering, for the tab half of that
          gate -- the same pattern (and the same reason) as the three tab
          panels above and the resume-editing wrapper inside the search
          tab: see ticket ac141d0's comment on that wrapper. Opus review
          (F2, BLOCKING) caught that a bare `{showMagicLinkPrompt && ...}`
          UNMOUNTS this component on any tab switch that fails the gate,
          destroying the local `dismissed`/`email`/`phase` it holds. Three
          concrete regressions, all of which the old inline mount was
          immune to because it sat inside a `hidden` div: a dismissed
          prompt came back after a round trip through "My Resumes"; a
          half-typed address was wiped by the same trip; and worst, the
          "Check your inbox" confirmation vanished, so the app stopped
          showing any record of a link it had just sent AND re-armed the
          send button for a silent double-send. Hiding with `hidden` keeps
          one instance alive across every tab switch while still removing
          it visually and from the a11y tree.

          Ticket 931df8a: this JSX call site -- where `<MagicLinkPrompt />`
          sits in the REACT TREE -- stays exactly where it always was, for
          exactly the reason above: moving it would unmount/remount it on
          every tab switch, destroying the state d0a7074 and F2 fought to
          keep. `createPortal`'s container here is `magicLinkPortalRoot`
          (declared above, next to `showMagicLinkPrompt`) -- a single
          imperatively-created div that NEVER changes identity, so this
          portal is never told to target a different container and
          therefore never gets torn down by React on that account. What
          actually moves is `magicLinkPortalRoot` ITSELF, between anchors,
          via plain `appendChild` in a `useLayoutEffect` -- invisible to
          React, since React only manages this node's contents. See that
          effect's own comment for why the more obvious version of this fix
          (portaling straight into the anchor, which changes identity on
          every tab switch) does NOT work -- it was tried, and it visibly
          failed two of this ticket's own new tests before being replaced
          with this one.

          The anchor itself is the node right after the topmost result in
          whichever results list is relevant, handed back by `ResultsList`/
          `GroupedResultsList` via `onFirstResultAnchorChange`.
          `position: fixed` and the `.results-section` clearance padding it
          required (index.css) are both gone, and stay gone -- see that
          file's comment at the old `.magic-link-prompt-floating` site for
          why fixed positioning's occlusion-bug history (N1/N2/N3) is not
          something ticket 042db32 reopens even though this card floats
          again.

          Ticket 042db32: that ticket changed how this SAME anchor node is
          styled, not where it sits in the DOM -- it's still this one node,
          right after the topmost result, for the reasons above. Index.css
          now renders it beside the results on a wide-enough viewport
          (`position: absolute`, out of `.result-cards`' own flex flow) and
          pinned to the viewport's top edge while scrolling on a narrow one
          (`position: sticky`, still a flex-flow member) -- see that file's
          long comment at `.magic-link-prompt-anchor` for the full
          reasoning and the measurement script that checked both.

          Still genuinely unmounts when NEITHER arm is ready -- e.g. a
          criteria or source change resets `hasFreshSearchResults`. That
          matches the old behavior exactly (the old mount died with its
          results section) and is the right call anyway: that reset means
          "you're composing a different search now," so a dismissal of the
          previous one carries no information. (`magicLinkPortalRoot` can
          still be attached somewhere in that window via the fallback
          anchor below, but the `hidden` toggled on it by the other effect
          above -- unaffected by any of this -- is what actually keeps a
          STILL-MOUNTED card off screen between tab switches; here, the
          JSX condition unmounts the card outright, which is the deliberate
          difference.) */}
      {(searchArmReady || scoredArmReady) && createPortal(<MagicLinkPrompt />, magicLinkPortalRoot)}
      {/* The fallback anchor itself: see `fallbackMagicLinkAnchor`'s own
          comment above for the one case it exists for. Always rendered,
          deliberately outside any tab's `hidden` panel so it is never
          itself unmounted by a tab switch -- an empty `<div>` with no
          layout footprint unless `magicLinkAnchor` actually resolves to
          it. */}
      <div ref={setFallbackMagicLinkAnchor} />
    </main>
  );
}

/**
 * Ticket 9f06f8f (epic 2b9e9dd child 4): the emailed sign-in link's landing
 * view is a FULL-PAGE TAKEOVER, and this wrapper is what makes that true in
 * the one way that matters -- `JobSearchApp` is not mounted at all while a
 * token is being redeemed, so none of its data hooks (useSources,
 * useResults, useResumesList) fire a single request under the identity the
 * browser is in the middle of replacing.
 *
 * WHY A WRAPPER COMPONENT rather than an early `return` inside
 * `JobSearchApp`: React hooks cannot be skipped, so an early return there
 * would have to sit ABOVE every other hook in the file -- safe only as long
 * as nobody ever adds a hook above it, and silently producing a
 * "rendered fewer hooks than expected" crash the day someone does. Splitting
 * the components makes the guarantee structural instead of a rule to
 * remember. It costs one component and no behavior: with no
 * `#magicLinkToken=` in the URL fragment (every ordinary page load), this
 * renders exactly what it always did.
 *
 * `useState(readMagicLinkTokenFromUrl)` reads the URL ONCE, at first render,
 * the same pattern `restored`/`readAppState` already uses in `JobSearchApp`
 * and for the same reason: `MagicLinkLanding` strips the token out of the URL
 * fragment with `history.replaceState` as soon as it has an answer, and this
 * view must not switch out from under itself the moment that happens.
 */
function App() {
  const [magicLinkToken] = useState(readMagicLinkTokenFromUrl);
  if (magicLinkToken !== undefined) return <MagicLinkLanding token={magicLinkToken} />;
  return <JobSearchApp />;
}

export default App;
