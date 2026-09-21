/**
 * Placeholder export for @app/shared.
 *
 * Proves the package builds, is importable from both apps/api and apps/web
 * via the pnpm workspace protocol, and is covered by the root Vitest run.
 * Real shared types/utilities (e.g. the Job/Match domain types) land here
 * as the API and web contract solidifies.
 */
export function ping(): string {
  return "pong";
}

/**
 * Minimum match score (0-100) to display in the ranked list (ticket 1b9f81e).
 * Jobs scoring below this are still scored and persisted in the database, but
 * hidden from the printed/returned ranked list. This is a display filter only,
 * not a scoring or persistence filter — the threshold can be retuned later
 * without re-paying to score anything already in the database.
 */
export const MATCH_SCORE_FLOOR = 55;

export type Job = {
  id: string;
  externalId: string;
  dataSource: "usajobs" | "wa-state" | "greenhouse" | "lever" | "ashby" | "smartrecruiters";
  title: string;
  description: string;
  company: string;
  // Optional because not every source knows. USAJOBS publishes structured
  // pay and schedule codes; Greenhouse's board API carries neither, for any
  // posting. Requiring them would mean either dropping those sources or
  // guessing — and a guess here writes invented data into the database.
  // "Not stated" is the honest representation of a posting that doesn't state it.
  payType?: "hourly" | "salary";
  commitment?: "full-time" | "part-time" | "contract";
  // Also optional, same reasoning. Measured against real Greenhouse boards:
  // Airbnb asks a custom "Workplace Type" question so this maps cleanly;
  // Discord asks nothing equivalent. Requiring it meant 0 of 3 Discord jobs
  // surviving normalization. A posting that doesn't state its work
  // arrangement genuinely doesn't state it.
  locationType?: "remote" | "onsite" | "hybrid";
  location?: string;
  linkToApply: string;
  postedAt: Date;
};

export type Resume = {
  id: string;
  resumeText: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment (ticket 38a7598). */
  resumeNickname: string;
};

export type JobMatch = {
  id: string;
  resumeId: string;
  jobId: string;
  matchScore: number;
  rationale: string;
};

export type Search = {
  id: string;
  resumeId: string;
  searchedAt: Date;
};

export type SearchResult = {
  id: string;
  searchId: string;
  jobId: string;
};

export type SearchSource = {
  searchId: string;
  sourceDescriptorId: string;
};

export type SourceDescriptor = {
  id: string;
  displayName: string;
};

// ---------------------------------------------------------------------------
// REST API wire contract (ticket 59fdc52, review round 2).
//
// apps/web depends on @app/shared and deliberately NOT on @app/api (a
// separate app forces a real REST boundary — see CLAUDE.md's stack table).
// Every shape a route actually sends or accepts over HTTP lives here so the
// frontend never hand-redeclares it from reading route handler source.
// Internal-only shapes (RunDemoMatchResult, ScoreJobFn, ...) stay in
// apps/api/src/demo-match.ts — they never cross the wire.
// ---------------------------------------------------------------------------

export type CreateResumeRequest = {
  resumeText: string;
};

export type CreateResumeResponse = {
  id: string;
  /**
   * Job title keywords Claude inferred from this resume (ticket 39b4a48),
   * shown to the user as editable/removable chips — replaces the old
   * hardcoded software-engineering title default. Always a real array,
   * never absent: `[]` means inference ran and found nothing to suggest
   * (or failed — see resume-title-inference.ts, a failure degrades to
   * `[]` rather than blocking resume creation), which the frontend must
   * treat as "no suggestions to show", not an error.
   */
  suggestedTitles: string[];
  /**
   * A real, distinct default ("Resume 1", "Resume 2", ...) assigned by
   * `getOrCreateResumeId` (apps/api/src/demo-match.ts) at insert time for a
   * genuinely new resume, or the resume's EXISTING nickname when this
   * submission matched a resume that already existed (content-addressed
   * find-or-create, ticket 620ca30) — including one the user already
   * renamed via `PATCH /resumes/:id`. Ticket 38a7598: this is what
   * `ResumeInput.tsx` shows/pre-fills right in the submission flow, per
   * Nicole's explicit "at that moment... choosing the resume nickname" —
   * never a value the frontend invents itself, so a resubmission of
   * identical text is guaranteed to show the SAME real nickname the
   * resume already carries, never a fresh guess that could drift from it.
   */
  resumeNickname: string;
};

export type GetResumeResponse = {
  id: string;
  resumeText: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment. */
  resumeNickname: string;
};

/**
 * `PATCH /resumes/:id` (ticket 38a7598) — renames a resume's nickname.
 * Deliberately minimal: this is NOT a general resume-editing endpoint (the
 * ticket's own Scope excludes that) — the only field it can change is
 * `resumeNickname`, never `resumeText` (that would break content-addressing:
 * `resumeHash` is derived from the text and never recomputed after insert).
 */
export type UpdateResumeNicknameRequest = {
  resumeNickname: string;
};

export type UpdateResumeNicknameResponse = {
  id: string;
  resumeNickname: string;
};

/**
 * The user's own status toward a job (ticket 0c319b2, apps/api/src/db/
 * schema.ts's `userJobStatusEnum`). Mirrored here rather than imported from
 * apps/api because nothing under apps/api/src ever crosses the wire into
 * @app/web — see this file's header comment.
 *
 * Review round F4 (git-bug 484889d): the runtime array is exported too, as
 * `USER_JOB_STATUSES`, and the type is derived FROM it (`(typeof
 * USER_JOB_STATUSES)[number]`) rather than the array being typed against a
 * separately hand-written union. Before this, `apps/api/src/routes/
 * resumes.ts` and `apps/api/src/routes/job-status.ts` each hand-duplicated
 * their own local `KNOWN_STATUSES` array (used for runtime validation,
 * since a `type` has no runtime representation) — two copies that could
 * silently drift from this type and from each other. One canonical runtime
 * list here removes that drift risk; both route files now import
 * `USER_JOB_STATUSES` instead of redeclaring it.
 */
export const USER_JOB_STATUSES = ["saved", "resume_optimized", "applied", "dismissed"] as const;
export type UserJobStatus = (typeof USER_JOB_STATUSES)[number];

/**
 * Leveling fit (ticket b182bde), judged separately from `matchScore` in the
 * SAME scoring call — see `SCHEMA`/`SCORING_PREAMBLE` in
 * apps/api/src/demo-match.ts. `matchScore` alone conflated capability fit
 * with leveling fit: the same structural fact ("candidate has far more
 * experience than the posting asks for") produced `matchScore` values
 * ranging 42-78 across six real postings, because nothing told the model to
 * separate the two judgments. Three values, not a single "overqualified"
 * flag, because the corpus shows the mismatch in both directions (a
 * Staff-level posting scores someone under-leveled for it too).
 */
export type LevelFit = "underqualified" | "well_matched" | "overqualified";

export type ScoredJobResult = {
  jobId: string;
  /**
   * Ticket 3f0883f: which resume THIS result was scored against —
   * `jobMatches.resumeId`, carried per-row for the same reason
   * `resumeNickname` (below) is: once "Already Scored Jobs" spans every
   * resume, not just the active one, the SAME `jobId` can legitimately
   * appear twice, once per resume, with two different match scores. A
   * response-level `resumeId` can't express that, and neither can a
   * single `jobId` alone stay a unique list key or a safe target for a
   * resume-specific action -- see ResultCard.tsx's "Optimize Resume"
   * handoff, which used to trust a single caller-supplied `resumeId`
   * prop (silently correct only because every card, at the time,
   * necessarily belonged to the one active resume) and now reads this
   * field instead.
   */
  resumeId: string;
  externalId: string;
  title: string;
  company: string;
  // Plain string, not Job["dataSource"]: this comes straight off the `jobs`
  // table's `data_source` FK column (source_descriptors.id), which is not
  // itself narrowed to the six-member union at the DB layer.
  dataSource: string;
  location: string | null;
  locationType: Job["locationType"] | null;
  applyUrl: string;
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
  /**
   * The user's current status toward this job, or `null` when no
   * `user_job_statuses` row exists for it yet (ticket 484889d — added
   * alongside the frontend since no REST surface previously read this
   * column at all; see that ticket's report for what else was missing).
   */
  status: UserJobStatus | null;
  /**
   * Ticket 38a7598 review fix: the nickname of the resume THIS result was
   * scored against, carried per-result rather than only once at the top
   * level of `GetResumeResultsResponse` (see that type's own doc comment
   * for the "why now, not later" reasoning) -- the very next ticket
   * (3f0883f) widens "Already Scored Jobs" to span MULTIPLE resumes at
   * once, where the SAME posting can legitimately appear twice, once per
   * resume, with two different nicknames. A single response-level field
   * cannot express that; this is what `ResultCard.tsx`'s "Searched with:
   * <nickname>" line now reads, straight off its own `result`, never a
   * prop threaded down from a caller.
   */
  resumeNickname: string;
  /**
   * `null` for a row scored before this ticket, or any row a caller
   * declines to judge — NEVER coerced to `"well_matched"` on read (that
   * would fabricate a claim the model never made). By convention, a real
   * `levelFit` usually comes with a `levelFitNote` (see that field's own
   * comment for why this is convention, not a guarantee).
   */
  levelFit: LevelFit | null;
  /**
   * One plain sentence for the candidate on how level fit affects their
   * real chance of being hired here. Empty string (not null) when
   * `levelFit` is `"well_matched"` — see `SCHEMA` in demo-match.ts.
   *
   * By convention, a real `levelFit` usually comes with a `levelFitNote`,
   * but this is NOT enforced at the schema level (no DB constraint, no
   * runtime check) — treat `levelFitNote` as independently nullable.
   * Confirmed non-enforced by the ticket b182bde review: that ticket's own
   * `resumes.test.ts` tiebreak-ordering fixtures seed rows with
   * `levelFit: "overqualified"` and `levelFitNote: null`, contradicting the
   * old "always coupled" claim this comment used to make. The app degrades
   * gracefully either way (pill renders, no tooltip, no note block), so
   * this is a documentation-accuracy fix, not a bug fix.
   */
  levelFitNote: string | null;
  /**
   * Ticket 8f5a79c: does this posting read as contract/temp work? Computed
   * server-side at read time (`apps/api/src/sources/swe-filter.ts`'s
   * `looksLikeContractOrTemp` — a structured `commitment === "contract"`
   * signal where the source reports one, falling back to title phrasing
   * otherwise), never stored as its own DB column: it's fully derivable
   * from data the row already has, so persisting a duplicate of it would
   * just be another place for it to drift stale.
   *
   * Deliberately NOT an exclusion — contract/temp postings pass the same
   * SOFTWARE/NOT title filter as any other SWE title and are mixed into
   * this same ranked list, per Nicole's explicit ask (git-bug 8f5a79c
   * correction: "they should be able to choose whether they want it... i
   * just thought you were saying that theyd be in a different result
   * section"). This field exists so the frontend's "Hide contract/temp
   * roles" toggle (ResultsList.tsx/GroupedResultsList.tsx) can filter the
   * existing corpus client-side — same pattern as `levelFit` feeding "Hide
   * roles above my level" — never a separate section/tab and never a
   * server round-trip.
   */
  isContractOrTemp: boolean;
};

export type GetResumeResultsResponse = {
  resumeId: string;
  /**
   * Ticket 38a7598: originally the ONE place a card's "Searched with"
   * label read its nickname from, on the (true, at the time) reasoning
   * that every result in one response was scored against the same resume
   * (`?resumeId=` scopes the whole query). Review fix, same ticket: that
   * doesn't hold up against the very next ticket (3f0883f), which widens
   * "Already Scored Jobs" to span MULTIPLE resumes at once — the same
   * posting can then legitimately appear twice, once per resume, with two
   * different nicknames, which this single response-level field can't
   * express. `ScoredJobResult.resumeNickname` is now the canonical,
   * per-result source `ResultCard.tsx` actually reads. This field is kept
   * for convenience/back-compat (it costs nothing extra — the route
   * already looks the resume up to 404-check `resumeId`), but nothing in
   * apps/web reads it anymore; don't add a new reader of it without first
   * checking whether the caller actually wants the per-result field
   * instead.
   */
  resumeNickname: string;
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied — see
   * git-bug 1b9f81e. */
  hiddenBelowFloor?: number;
  /** Present only when `fetchScoredResults`'s server-side LIMIT actually
   * truncated the matching rows (see git-bug e9a82f3) -- the true count of
   * rows matching the same filters, BEFORE the limit was applied. `results`
   * is capped at that limit regardless of how large this number gets, so
   * the frontend can tell "everything that matched" (`results.length ===
   * totalMatchingCount`, this field absent) apart from "there's more than
   * we're showing" (this field present and larger than `results.length`)
   * without guessing from `results.length` alone. */
  totalMatchingCount?: number;
};

/**
 * `GET /results` (ticket 3f0883f) -- the cross-resume counterpart to
 * `GetResumeResultsResponse`, deliberately WITHOUT a top-level `resumeId`/
 * `resumeNickname`: there isn't one singular resume to name when `results`
 * spans every resume in the database. Each `ScoredJobResult` already
 * carries its own `resumeId`/`resumeNickname`, which is what makes this
 * response shape possible at all -- see that type's own doc comments.
 */
export type GetAllResultsResponse = {
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied -- same
   * meaning as `GetResumeResultsResponse.hiddenBelowFloor`, just summed
   * across every resume instead of one. */
  hiddenBelowFloor?: number;
  /** Present only when truncated -- same meaning as
   * `GetResumeResultsResponse.totalMatchingCount`, just summed across every
   * resume instead of one (see git-bug e9a82f3). */
  totalMatchingCount?: number;
};

/**
 * `POST /jobs/:id/status` (ticket 484889d). `resumeId` is optional and
 * records which resume was in hand when the status was set — see
 * `userJobStatuses.resumeId`'s doc comment in apps/api/src/db/schema.ts for
 * why it's an attribute, never part of the row's identity.
 */
export type SetJobStatusRequest = {
  status: UserJobStatus;
  resumeId?: string;
};

export type SetJobStatusResponse = {
  jobId: string;
  status: UserJobStatus;
  updatedAt: string;
};

export type SourceHealth = {
  id: Job["dataSource"];
  displayName: string;
  /** A short, factual line about what this source actually covers — e.g.
   * "U.S. federal government positions" for USAJOBS, or a few of the real
   * companies configured for an ATS-backed source. Grounded in what's
   * actually configured/true for this deployment, not generic marketing
   * copy (ticket e493085). Absent for a source with no adapter (it never
   * reaches the frontend at all — see ticket d480357). */
  description?: string;
  configured: boolean;
  error?: string;
};

export type GetSourcesResponse = {
  sources: SourceHealth[];
};

/**
 * The shortlist filter, parameterized (ticket 59fdc52 review round 2 PM
 * ruling, git-bug 59fdc52 comment 2026-08-29). Four fields, mapping
 * directly onto the filter that already existed in
 * apps/api/src/sources/swe-filter.ts post-4450f39 — deliberately NOT the
 * full preferences-as-data model from f0f16de (still open); this is the
 * minimum that makes the API configurable without inventing a schema
 * nobody has validated.
 *
 * Matching is substring/word-boundary, case-insensitive — never a raw
 * user-supplied regex (footgun + ReDoS risk). When a caller omits
 * `criteria` entirely, the API applies a default that reproduces
 * demo-match.ts's `filterSoftwareEngineeringJobs` EXACTLY — see
 * apps/api/src/sources/criteria.ts's `compileFilter` and its live-pool
 * equivalence proof.
 */
export type SearchCriteria = {
  /** Title phrases that qualify. ANY match passes. */
  titleInclude?: string[];
  /** Title phrases that disqualify, applied after include. ANY match
   * rejects. */
  titleExclude?: string[];
  /** Place names that qualify regardless of work arrangement — i.e. "near
   * enough to commute". */
  nearLocations?: string[];
  /** Accept confirmed-remote roles anywhere in-country. */
  remoteOk?: boolean;
  /**
   * Which `Job["commitment"]` values are acceptable. Omitted/empty means
   * no restriction (same pattern as every other field here). A posting
   * whose commitment is genuinely unknown (not every source reports it —
   * see swe-filter.ts's Greenhouse comment, which never populates this
   * field at all) is EXCLUDED once this restriction is non-empty, not
   * included permissively (ticket 18c9f18's PM ruling): the user
   * explicitly asked for e.g. "full-time only", and a job this app cannot
   * verify as full-time does not satisfy that ask. This is a real,
   * deliberate exception to `nearLocations`/`remoteOk`'s own "unmatched
   * data still doesn't get penalized beyond what was asked" spirit --
   * those fields only restrict what a caller opted into; commitment is
   * the first field here that also has real ambiguity in the underlying
   * source data (not every ATS reports it), and treating "can't verify"
   * as "assume it matches" would silently show jobs the user said they
   * didn't want. See apps/api/src/sources/criteria.ts's `compileFilter`
   * for the implementation and apps/api/src/sources/*.ts's `mapCommitment`
   * functions for which sources actually populate this (USAJOBS, Lever,
   * Ashby, SmartRecruiters -- Greenhouse never does).
   */
  commitmentIn?: Job["commitment"][];
};

/**
 * Ticket aff284b review R1: `estimatedInputTokens` alone is NOT the whole
 * prompt post-caching — it mirrors the Claude API's own `input_tokens`
 * field, which is only the UNCACHED remainder of a prompt once a run's
 * scoring calls share a cached prefix (see
 * `apps/api/src/demo-match.ts`'s `buildCachedPrefix`/`makeClaudeScorer`).
 * A real 200-job run measured `estimatedInputTokens` understating the
 * actual number of prompt tokens sent by ~90% when read as "the" input
 * count. `estimatedCacheReadTokens`/`estimatedCacheCreationTokens` carry
 * the rest of what was actually sent — total tokens sent for a call is
 * always `estimatedInputTokens + estimatedCacheReadTokens +
 * estimatedCacheCreationTokens`. Every caller that renders this to a user
 * (`describeCostEstimate` in demo-match.ts) must show that total, or label
 * `estimatedInputTokens` explicitly as "uncached" — never present it bare
 * as though it were the whole prompt.
 */
export type CostEstimate = {
  jobCount: number;
  /** Uncached input tokens only — the API's `input_tokens`. See this
   * type's own doc comment; do not treat this as the whole prompt. */
  estimatedInputTokens: number;
  /** Cache-read tokens (billed at 0.1x the input rate). 0 on the
   * "bootstrap" basis, which has no way to know the run-time cache-hit
   * split in advance — see `estimateScoringCost`'s doc comment. */
  estimatedCacheReadTokens: number;
  /** Cache-creation (cache-write) tokens (billed at 1.25x the input rate,
   * default 5-minute TTL), counted ONCE per run regardless of job count —
   * a run writes its cache exactly once (ticket aff284b review S1). 0 on
   * the "bootstrap" basis, same reasoning as `estimatedCacheReadTokens`. */
  estimatedCacheCreationTokens: number;
  estimatedOutputTokens: number;
  /** Kept for internal/back-compat reference — equals `probableCostUsd` on
   * BOTH basis values now (ticket 1a2cde3 — see that field's own doc
   * comment). Not for display: ticket e493085/e85fa9b — Nicole asked to
   * see plain "Max cost" / "Probable cost" numbers, not token buckets or a
   * third ambiguous "estimated" figure. UI code should read `maxCostUsd` /
   * `probableCostUsd` directly. */
  estimatedCostUsd: number;
  /**
   * A genuine worst-case ceiling, grounded in the model's real hard output
   * cap (`MAX_OUTPUT_TOKENS`) applied to every job — never exceeded by an
   * actual run, since that cap is code-enforced on every scoring call
   * (`demo-match.ts`'s `makeClaudeScorer`). Computed the same way on both
   * `basis` values (ticket e85fa9b): previously only "bootstrap" had a
   * ceiling at all.
   */
  maxCostUsd: number;
  /**
   * The best real-data guess at what a run will actually cost. On
   * "measured" basis this comes from genuine historical averages
   * (`usageStats`) — a real, grounded number, not an assumption. On
   * "bootstrap" (no prior run has ever completed, so no measured data
   * exists at all), this ticket (1a2cde3) replaced an earlier
   * bootstrap-equals-`maxCostUsd` tie with a real, non-arbitrary signal
   * instead: the scorer's response is JSON-schema-shaped (a score, a short
   * rationale, two short string arrays — see `demo-match.ts`'s `SCHEMA`),
   * not free text, so a realistic typical output size can be estimated
   * FROM that schema rather than assumed to hit the hard cap every call.
   * See `demo-match.ts`'s `TYPICAL_OUTPUT_CHARS_PER_JOB` for the real
   * measurement this is grounded in. Narrow/temporary in a different sense
   * now: the app's first completed run makes `usageStats` non-empty, and
   * every estimate after that is "measured" — a genuinely observed number,
   * strictly better than even a well-grounded schema guess.
   */
  probableCostUsd: number;
  basis: "measured" | "bootstrap";
};

export type SkippedSource = {
  id: string;
  reason: string;
};

export type BoardCoverageEntry = {
  token: string;
  status: "not-found" | "empty" | "ok" | "error";
  postingCount: number;
  companyName?: string;
  message?: string;
  skippedCount: number;
  survivedFilter: number;
  /**
   * How many of this token's title-passing postings were excluded
   * specifically because they're "somewhere in the US" with no evidence of
   * a remote work arrangement (ticket 14289ac) — distinct from every other
   * reason a token can contribute zero survivors (not-found, empty, error,
   * or filtered out for an unrelated reason). See apps/api's
   * `BoardCoverageEntry` (demo-match.ts) for the full reasoning; this is
   * the same field, mirrored into the REST contract.
   */
  excludedForMissingWorkArrangement: number;
};

export type SourceOutcome = {
  dataSource: Job["dataSource"];
  status: "ok" | "empty" | "error";
  jobsFound: number;
  skippedCount: number;
  skipRate: number;
  survivedFilter: number;
  /** Source-level total of `BoardCoverageEntry.excludedForMissingWorkArrangement`
   * across every token of this source — ticket 14289ac. See that field's
   * doc comment. */
  excludedForMissingWorkArrangement: number;
  errorMessage?: string;
  boardCoverage: BoardCoverageEntry[];
};

export type EstimateSearchRequest = {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
};

/**
 * Cap-aware (ticket 59fdc52 review round 2, F "estimate is wrong by
 * ~30x"): `costEstimate` reflects exactly what a real `POST /searches` run
 * would spend THIS run — i.e. after `scoreThreshold` capping — not the cost
 * of scoring the entire pool that needs a score. `candidatesNeedingScore`
 * is the full (uncapped) count so a caller can see how much would be
 * deferred; `cappedCount` and `scoreThreshold` say by how much and why.
 */
export type EstimateSearchResponse = {
  resumeId: string;
  costEstimate: CostEstimate;
  candidatesNeedingScore: number;
  scoreThreshold: number;
  cappedCount: number;
  alreadyScored: number;
  sourceOutcomes: SourceOutcome[];
  skippedSources: SkippedSource[];
};

export type StartSearchRequest = {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
};

export type StartSearchResponse = {
  searchId: string;
  status: "pending";
  skippedSources: SkippedSource[];
};

/**
 * `GET /searches/:id`. Every member has its OWN `status` literal (ticket
 * 59fdc52 review round 3, F3 — blocking): an earlier version reused
 * `status: "complete"` for both the live, in-memory-tracked result AND the
 * restart-fallback case (a `searches` row found in the database, but this
 * API process's own in-memory tracker never heard of the run), which meant
 * the two members were NOT distinguishable by `status` alone — TypeScript
 * can only narrow a union by a discriminant that is unique per member, so
 * `if (r.status === "complete") { r.newlyScored }` failed to compile
 * (`r` narrowed to the UNION of both "complete" members, and only one of
 * them has `newlyScored`). A frontend hitting that would have had to
 * reverse-engineer the shape (e.g. `!("note" in r)`) instead of narrowing
 * on `status` the normal way — exactly what AC3 (response types come from
 * `@app/shared`, not redeclared) exists to prevent.
 *
 * - `"pending"` / `"failed"` / `"complete"` — live, in-memory-tracked
 *   status for a run this API process started and is still tracking (or
 *   just finished tracking). `"pending"` additionally carries `scoredSoFar`
 *   (ticket 1998875) — a running count of jobs successfully scored so far
 *   this run, incremented as each `scoreOne` call in `runDemoMatch`
 *   resolves (see that function's `onJobScored` option). It counts
 *   SUCCESSFUL scores only, matching `newlyScored`'s semantics on the
 *   `"complete"` member below — a job whose call failed isn't "scored," it
 *   will be retried on the next run. This is the only piece of progress
 *   surfaced mid-run; per-job scores themselves are still never exposed
 *   until the run completes (decision: results come from the database,
 *   never from in-memory state).
 * - `"complete-details-unavailable"` — the `searches` row's own completion
 *   marker (schema.ts's `searchStatusEnum`) says `'complete'`, but this API
 *   process's in-memory tracker has lost the run (e.g. a restart) so the
 *   rich per-run details (`newlyScored`, `costEstimate`, ...) aren't
 *   available — only that it finished. Results are still fully queryable
 *   via `GET /resumes/:id/results` regardless (decision: results come from
 *   the database, never from in-memory state).
 * - `"incomplete"` — the row's own marker was never set to `'complete'`
 *   (still at `'running'`, or explicitly `'failed'` with no live error
 *   detail available). Distinct from `"failed"`: it means "this API
 *   process cannot confirm what happened" — it may still be running
 *   elsewhere, or it may have died mid-scoring — never presented as
 *   `"complete"` just because a row exists (ticket 59fdc52 review round 2,
 *   "restart fallback can't report complete for a run that died after
 *   scoring 3 of 200").
 */
export type SearchStatusResponse =
  | { searchId: string; status: "pending"; resumeId: string; scoredSoFar: number }
  | { searchId: string; status: "failed"; resumeId: string; error?: string }
  | {
      searchId: string;
      status: "complete";
      resumeId: string;
      newlyScored: number;
      failed: number;
      skipped: number;
      cappedCount: number;
      costEstimate: CostEstimate;
      sourceOutcomes: SourceOutcome[];
    }
  | {
      searchId: string;
      status: "complete-details-unavailable";
      resumeId: string;
      note: string;
    }
  | {
      searchId: string;
      status: "incomplete";
      resumeId: string;
      note: string;
    };
