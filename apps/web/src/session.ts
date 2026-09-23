/**
 * Tab-scoped persistence for the two things a page reload used to destroy
 * (git-bug 3f05144).
 *
 * WHY THIS EXISTS — the reproduction, not the hypothesis (2026-09-04, this
 * dev container, Vite 8.2.1 + React 19.2 + headless Chromium 151):
 *
 *   Nicole set her laptop down mid cost-estimate and came back to a blank
 *   app. The ticket's leading hypothesis was that the tab had been
 *   RELOADED — either by Chrome's memory-saver tab discard, or by Vite's
 *   dev-mode HMR client forcing `location.reload()` when its WebSocket
 *   reconnects after a sleep. Driving the real app in a real browser and
 *   killing/restarting the `apps/web` Vite dev server under it reproduced
 *   the reported symptom exactly: the console logs
 *   "[vite] server connection lost. Polling for restart...", the browser
 *   re-requests the HTML document, and every piece of in-memory React
 *   state — resume, source toggles, criteria, the cost estimate, and the
 *   `searchId` of a RUNNING search — is gone. See the ticket's git-bug
 *   comment / this branch's commit message for the captured evidence.
 *
 *   The same run against a PRODUCTION build (`vite build` + `vite
 *   preview`, which ships no HMR client and opens no dev WebSocket) did
 *   NOT reload when the server was killed and restarted. So the
 *   dev-server-reconnect path is dev-only. What is NOT dev-only is the
 *   consequence: a browser tab discard (Chrome memory saver), an OOM tab
 *   crash, an accidental Cmd-R, or a laptop-sleep-induced reload all
 *   present to this app as exactly the same event — a fresh page load with
 *   empty React state — and none of those are fixed by shipping a
 *   production build. That is why the fix is persistence, not a Vite
 *   config change: the trigger we could reproduce is dev-only, but the
 *   failure mode it exposes is not.
 *
 * WHY sessionStorage AND NOT localStorage: `sessionStorage` survives a
 * reload of the same tab and dies with the tab. That is precisely the
 * lifetime of "a search I am currently running." `localStorage` would
 * resurrect a days-old `searchId` on a genuinely new visit, which is
 * confusing rather than helpful — a stale run would poll, 404, and have to
 * be cleaned up for no benefit.
 *
 * Single-user app with no accounts or login (see App.tsx's doc comment),
 * so these keys need no per-user scoping — a fixed name is correct.
 *
 * Every access is wrapped: `sessionStorage` can throw on ACCESS (not just
 * on write) in a browser configured to block site data, and persistence is
 * a convenience — the app must keep working without it.
 */
import type { EstimateSearchResponse } from "@app/shared";

/** Bump the `.vN` suffix on any shape change: an old record then simply
 * fails to load and the app starts clean, instead of being hand-migrated. */
const APP_STATE_KEY = "jobsearch.web.appState.v4";
const ACTIVE_SEARCH_KEY = "jobsearch.web.activeSearch.v1";

export type Commitment = "full-time" | "part-time" | "contract";

export type CriteriaFormState = {
  nearLocations: string;
  remoteOk: boolean;
  /** Ticket b9e6251: the explicit "I'll work anywhere" opt-in -- required
   * before an otherwise-empty location criteria is honored as "search
   * every location" rather than blocking the estimate. Bumped
   * `APP_STATE_KEY` to `.v2` for this field, per this file's own
   * version-bump convention above. */
  anyLocationOk: boolean;
  commitmentIn: Commitment[];
};

/** Everything App.tsx owns that a reload should not have to be re-typed. */
export type PersistedAppState = {
  resumeId: string;
  /** Restored into the paste box so a reload doesn't look like the resume
   * was thrown away — the single most visible half of Nicole's report
   * ("it was all clear again"). */
  resumeText: string;
  /** Ticket 38a7598: the resume's nickname, restored into `ResumeInput`'s
   * field on reload the same way `resumeText` is above — otherwise a
   * reload would show the box as unnamed even though the server still has
   * a real nickname for this resume. Bumped `APP_STATE_KEY` to `.v4` for
   * this field, per this file's own version-bump convention. */
  resumeNickname: string;
  selectedSourceIds: string[];
  titleChips: string[];
  criteriaForm: CriteriaFormState;
  /** Ticket ffbf9fb: the user-adjustable match-score floor (App.tsx's
   * `scoreFloor` state), shared by both tabs and by `useResults`'s
   * `minScore` argument. Bumped `APP_STATE_KEY` to `.v3` for this field, per
   * this file's own version-bump convention above. */
  scoreFloor: number;
};

/**
 * The money-relevant half: a `POST /searches` that has already been paid
 * for and is still scoring server-side. `searchId` alone is enough to
 * reconnect (`GET /searches/:id`), but the `estimate` is stored alongside
 * it because the "Search running..." panel renders the pre-run COST
 * figures (probable/max USD) from it, and there is no way to rebuild
 * those specifically from the server after a reload — `POST
 * /searches/estimate` is a synchronous, money-priced call the app must
 * not silently re-fire on every mount. `startedAt` keeps the elapsed timer
 * honest across the reload.
 *
 * UPDATED, ticket 2e7ba8a: the "N of M scored" denominator used to be
 * read from this persisted `estimate.costEstimate.jobCount` too, for the
 * same "nothing else has it" reason above — `GET /searches/:id`'s
 * `"pending"` member used to carry only `scoredSoFar`. It now also carries
 * `linked`, a DB-backed, durably-growing count re-derivable on every poll
 * (ticket c9c676d), so the denominator no longer needs to survive in
 * storage at all: SearchFlow.tsx's "running" panel reads it straight off
 * the live poll response, same as `scoredSoFar`. `estimate` staying in
 * this record is now solely about the cost figures and (via
 * `scoreThreshold`) the budget-cap wording — not the denominator.
 *
 * `scoredSoFar` (and, by the same reasoning since ticket 2e7ba8a, `linked`
 * and the rest of the live per-poll fields) is deliberately NOT persisted:
 * the restore path polls immediately on mount, so the real values land
 * within one round trip, and leaving them out means the record is written
 * once per run rather than re-serialized on every 2s poll tick.
 */
export type PersistedActiveSearch = {
  searchId: string;
  resumeId: string;
  startedAt: number;
  estimate: EstimateSearchResponse;
};

function readRaw(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return undefined;
    return JSON.parse(raw);
  } catch {
    // Unreadable (blocked storage) or unparseable (hand-edited, truncated
    // by a quota error mid-write) — either way there is nothing to restore.
    return undefined;
  }
}

function writeRaw(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded or storage blocked. Persistence is best-effort; the
    // app is fully functional without it.
  }
}

function removeRaw(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Same as writeRaw.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const COMMITMENTS: readonly string[] = ["full-time", "part-time", "contract"];

function parseCriteriaForm(value: unknown): CriteriaFormState | undefined {
  if (!isRecord(value)) return undefined;
  const { nearLocations, remoteOk, anyLocationOk, commitmentIn } = value;
  if (typeof nearLocations !== "string") return undefined;
  if (typeof remoteOk !== "boolean") return undefined;
  if (typeof anyLocationOk !== "boolean") return undefined;
  if (!isStringArray(commitmentIn)) return undefined;
  if (!commitmentIn.every((entry) => COMMITMENTS.includes(entry))) return undefined;
  return { nearLocations, remoteOk, anyLocationOk, commitmentIn: commitmentIn as Commitment[] };
}

export function readAppState(): PersistedAppState | undefined {
  const value = readRaw(APP_STATE_KEY);
  if (!isRecord(value)) return undefined;
  const { resumeId, resumeText, resumeNickname, selectedSourceIds, titleChips, scoreFloor } = value;
  if (typeof resumeId !== "string" || resumeId.length === 0) return undefined;
  if (typeof resumeText !== "string") return undefined;
  if (typeof resumeNickname !== "string") return undefined;
  if (!isStringArray(selectedSourceIds) || !isStringArray(titleChips)) return undefined;
  // Range-checked against the slider's own 0-90 bounds (ScoreFloorControl),
  // not just "is a finite number" -- opus review, ticket ffbf9fb: a
  // hand-edited or otherwise out-of-range persisted value (e.g. `1e6`)
  // would otherwise load fine and go straight to `?minScore=`, while the
  // slider itself renders clamped at 90 -- a visible mismatch between what
  // the UI shows and what's actually sent to the server.
  if (typeof scoreFloor !== "number" || !Number.isFinite(scoreFloor)) return undefined;
  if (scoreFloor < 0 || scoreFloor > 90) return undefined;
  const criteriaForm = parseCriteriaForm(value.criteriaForm);
  if (criteriaForm === undefined) return undefined;
  return {
    resumeId,
    resumeText,
    resumeNickname,
    selectedSourceIds,
    titleChips,
    criteriaForm,
    scoreFloor,
  };
}

export function writeAppState(state: PersistedAppState): void {
  writeRaw(APP_STATE_KEY, state);
}

export function clearAppState(): void {
  removeRaw(APP_STATE_KEY);
}

/**
 * Validates only what the "Search running..." / "Search complete" panels
 * actually READ off the estimate (the three `toFixed`-ed currency numbers,
 * the two counts, and the two lists). Deeper per-`SourceOutcome`
 * validation would be ceremony: this object was produced by this app's own
 * API client, in this same tab, minutes ago — the only way its shape can
 * drift is an app-version change across a reload, and the `.v1` key
 * suffix is what retires the record in that case.
 */
function parseEstimate(value: unknown): EstimateSearchResponse | undefined {
  if (!isRecord(value)) return undefined;
  const { costEstimate, alreadyScored, cappedCount, sourceOutcomes, skippedSources } = value;
  if (!isRecord(costEstimate)) return undefined;
  if (typeof costEstimate.jobCount !== "number") return undefined;
  if (typeof costEstimate.maxCostUsd !== "number") return undefined;
  if (typeof costEstimate.probableCostUsd !== "number") return undefined;
  if (typeof alreadyScored !== "number" || typeof cappedCount !== "number") return undefined;
  if (!Array.isArray(sourceOutcomes) || !Array.isArray(skippedSources)) return undefined;
  return value as unknown as EstimateSearchResponse;
}

export function readActiveSearch(): PersistedActiveSearch | undefined {
  const value = readRaw(ACTIVE_SEARCH_KEY);
  if (!isRecord(value)) return undefined;
  const { searchId, resumeId, startedAt } = value;
  if (typeof searchId !== "string" || searchId.length === 0) return undefined;
  if (typeof resumeId !== "string" || resumeId.length === 0) return undefined;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  const estimate = parseEstimate(value.estimate);
  if (estimate === undefined) return undefined;
  return { searchId, resumeId, startedAt, estimate };
}

export function writeActiveSearch(record: PersistedActiveSearch): void {
  writeRaw(ACTIVE_SEARCH_KEY, record);
}

/**
 * Drops the in-flight-search record ONLY if it belongs to `resumeId`.
 *
 * The scoping is the point, not defensive habit. `SearchFlow` clears the
 * record whenever its own phase is not "running", and that includes its
 * very first render — so an unscoped delete would let a mount for resume B
 * destroy the record of a still-running, already-paid-for run of resume A
 * (reachable by pasting a new resume while a search is in flight and then
 * reloading). Silently losing a live run is the exact failure this ticket
 * exists to fix, so a record this mount did not adopt is left alone; it
 * dies with the tab like everything else in `sessionStorage`.
 */
export function clearActiveSearchFor(resumeId: string): void {
  const record = readActiveSearch();
  if (record !== undefined && record.resumeId !== resumeId) return;
  removeRaw(ACTIVE_SEARCH_KEY);
}
