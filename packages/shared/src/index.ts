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
  dataSource:
    | "usajobs"
    | "wa-state"
    | "greenhouse"
    | "lever"
    | "ashby"
    | "smartrecruiters"
    | "workable"
    | "recruitee"
    | "rippling";
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
  /**
   * Ticket 7701534: the resume already active THIS session, if any --
   * lets `POST /resumes` tell "resubmitting my own unchanged text" (e.g.
   * re-editing just to fix a typo elsewhere) apart from "this text
   * already belongs to a DIFFERENT saved resume" (a real duplicate).
   * Omitted on a genuinely first-ever submission this session. See
   * `CreateResumeDuplicateError`'s doc comment for what happens on the
   * latter.
   */
  currentResumeId?: string;
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
   * `getOrCreateResumeId` (apps/api/src/matching/pipeline.ts) at insert
   * time for a genuinely new resume, or the resume's EXISTING nickname
   * when this submission matched `currentResumeId` itself resubmitting
   * its own unchanged text (content-addressed find-or-create, ticket
   * 620ca30) — including one the user already renamed via `PATCH
   * /resumes/:id`. Ticket 38a7598: this is what `ResumeInput.tsx`
   * shows/pre-fills right in the submission flow, per Nicole's explicit
   * "at that moment... choosing the resume nickname" — never a value the
   * frontend invents itself.
   *
   * Ticket 7701534: text matching a DIFFERENT existing resume (not
   * `currentResumeId`) no longer reaches this success response at all —
   * see `CreateResumeDuplicateError`. This field's own "resubmission
   * resolves to the same real nickname" guarantee now only covers the
   * one case it still applies to: `currentResumeId` resubmitting itself.
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
 * One row of `GET /resumes`'s list (ticket 303cff0 -- "My Resumes" tab).
 * Deliberately NOT `resumeText`: the list is meant to be cheap to load for
 * every saved resume at once, and full text is fetched per-resume, on
 * demand, via the existing `GET /resumes/:id` -- see that route and
 * `GetResumeResponse` above.
 */
export type ResumeSummary = {
  id: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment. */
  resumeNickname: string;
  /** ISO 8601 timestamp (schema.ts's `resumes.createdAt`, `defaultNow()`). */
  createdAt: string;
};

export type ListResumesResponse = {
  /** Oldest first -- matches the "Resume 1", "Resume 2", ... nickname
   * numbering (ticket 38a7598), so list order and nickname order agree. */
  resumes: ResumeSummary[];
};

/**
 * `POST /resumes`'s `409` body (ticket 7701534) when the submitted text
 * exactly matches an EXISTING resume other than `currentResumeId` --
 * Nicole: "This resume has the exact same text as Resume 8... you can't
 * save an identical resume." Mirrors `POST /searches`'s own `{error,
 * searchId}` 409 pattern (ApiError's doc comment, apps/web/src/api/
 * client.ts) -- extra structured fields alongside the plain message, read
 * off `ApiError.body` the same structural way that one already is (see
 * `apiErrorStatus`/`inFlightSearchIdFromError` in SearchFlow.tsx).
 *
 * Deliberately does NOT fire for a resubmission of `currentResumeId`'s
 * OWN unchanged text -- that keeps succeeding exactly as before (ticket
 * 620ca30's content-addressed find-or-create, unchanged for that case).
 */
export type CreateResumeDuplicateError = {
  error: string;
  duplicateResumeId: string;
  duplicateResumeNickname: string;
};

/**
 * `PATCH /resumes/:id`'s `409` body (ticket 7701534) when `resumeNickname`
 * collides (case-insensitively) with a DIFFERENT resume's current
 * nickname. A `reason` discriminator, not just a message string, so the
 * frontend can react specifically (leave the user's typed value in place
 * rather than reverting it, per `handleNicknameCommit`'s ticket 38a7598
 * revert-on-any-other-failure behavior) without parsing English text.
 */
export type UpdateResumeNicknameConflictError = {
  error: string;
  reason: "nickname_conflict";
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
  /**
   * Ticket 410e1a2: let each `nearLocations` phrase ALSO match the other
   * cities of its metro area — "Seattle" also matching a posting located
   * only in "Bellevue, WA" or "Kirkland, WA".
   *
   * OPT-IN, and it stays opt-in. Omitted/`false` is the default and means
   * exactly today's literal matching, byte for byte (the flag selects a
   * different matcher-compiling branch, so "off" is the original code path
   * rather than a re-derivation of it). Nicole raised both sides herself
   * while dogfooding a real Seattle search: some searchers want the metro
   * assumed, others would be annoyed by an unrequested Kirkland commute —
   * so this is a visible checkbox, not a default, and the UI label names
   * the cities it will pull in.
   *
   * Only `nearLocations` is affected; `remoteOk` and every title axis are
   * untouched, and the flag alone (with no `nearLocations`) is not a
   * location restriction. Which cities count is a small curated,
   * evidence-carrying table of OMB/Census metro areas —
   * apps/api/src/sources/metroAreas.ts, which also documents what is
   * deliberately NOT grouped and why.
   */
  expandMetroAreas?: boolean;
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
  /**
   * Ticket bf2dd0a. Optional, caller-minted id for the LIGHTWEIGHT progress
   * side channel — see apps/api's `matching/estimateProgress.ts` for the
   * full design. `POST /searches/estimate` stays exactly as synchronous as
   * ever; this id, if supplied, only lets the caller also poll
   * `GET /searches/estimate/:requestId/progress` WHILE that blocking call is
   * still in flight, to show something better than a bare spinner ("3 of 8
   * sources checked"). Minted by the CALLER, not the server, because the
   * server has no way to hand back an id before the blocking response it's
   * attached to — the frontend generates one (`crypto.randomUUID()`) before
   * firing the request and starts polling immediately after, not after the
   * POST resolves. Omitting it costs nothing: the estimate runs identically
   * either way, just with no progress record to poll.
   */
  estimateRequestId?: string;
};

/**
 * One source's progress within a `POST /searches/estimate` run currently
 * being tracked under `EstimateProgressResponse.requestId` (ticket bf2dd0a).
 * Deliberately thinner than `SourceOutcome` — no jobsFound/skipRate/etc:
 * this is pure "has this source's fetch settled yet", read live while the
 * estimate is still running, not the rich per-source result the estimate's
 * own final response (`SourceOutcome`) carries once it's done.
 */
export type EstimateProgressSourceState = {
  sourceId: string;
  status: "pending" | "done";
};

/**
 * `GET /searches/estimate/:requestId/progress` (ticket bf2dd0a) — the
 * optional side channel a caller polls WHILE `POST /searches/estimate` is
 * still blocking, to answer "which of the selected sources have reported in
 * so far" instead of showing a bare spinner. NOT part of the estimate's
 * completion contract: the POST call still returns the final
 * `EstimateSearchResponse` synchronously in one response, exactly as before
 * this ticket, whether or not anything ever polls this endpoint. A 404 here
 * (no `EstimateProgressResponse` to return) means "no tracked run under this
 * id" — never started (the caller omitted `estimateRequestId`), already past
 * its retention window, or a process restart — and is an entirely normal,
 * expected outcome a poller should treat as "nothing to show yet", not an
 * error.
 */
export type EstimateProgressResponse = {
  requestId: string;
  /** How many sources this estimate run started with — every source the
   * caller selected, whether or not it ultimately succeeds. */
  total: number;
  /** How many of `total` have settled (fetched successfully OR failed) so
   * far. `completed === total` means every source has reported in; the
   * blocking POST itself finishes at essentially the same moment, since the
   * estimate path never reaches scoring. */
  completed: number;
  sources: EstimateProgressSourceState[];
  done: boolean;
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
 * One source's durable state within a search (ticket 4f88339, design
 * c54b9e0 §5.3) — the `search_sources` row, as the REST contract sees it.
 *
 * Deliberately THINNER than `SourceOutcome` above: no `boardCoverage`, no
 * `skipRate`, no `survivedFilter`. Those exist only in the fetch worker's
 * memory for the duration of one message and were never persisted, so a
 * durable read path cannot honestly produce them. What IS here is what
 * ticket 59fdc52's fourth acceptance criterion actually asked for —
 * "unavailable sources are reported per-source so the UI can show a source
 * as failed" — now answerable from Postgres alone, after a restart, from a
 * process that never handled the search. Persisting the richer per-source
 * telemetry is real follow-up work, deliberately not smuggled in here.
 */
export type SearchSourceState = {
  /** `Job["dataSource"]` — the same id `POST /searches` was given. */
  sourceId: string;
  status: "pending" | "complete" | "failed";
  /** Jobs this source linked to the search. `null` until the source
   * reaches a terminal state (and for a `failed` source that never got
   * far enough to link anything). */
  linkedJobCount: number | null;
  /** Only on `failed`: the worker's own classification
   * ("rate-limited", "source-search-timeout", "unknown-source", ...) or
   * "dispatch-failed" when the API could not publish the message at all. */
  errorKind?: string;
  errorMessage?: string;
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
 * REVISED FOR QUEUE-DRIVEN SEARCH (ticket 4f88339, design c54b9e0 §5.3).
 * Every field on the `"pending"` and `"complete"` members is now REBUILT
 * FROM POSTGRES on each request rather than read out of an in-memory
 * tracker that a restart erases — which is strictly stronger than what the
 * tracker provided: correct across restarts, correct across multiple API
 * processes, correct for a search this process never handled. The
 * `searchRuns` Map that used to back them is deleted outright.
 *
 * - `"pending"` — the search is genuinely still outstanding: at least one
 *   source has not reached a terminal state, or at least one linked job
 *   has neither a score nor a permanent-failure record. `scoredSoFar` is
 *   KEPT under its existing name and semantics (a count of jobs
 *   successfully scored, never a count of attempts) so `SearchFlow.tsx`'s
 *   poll loop and its out-of-order-poll guard keep working; it is now the
 *   durable count (linked jobs with a `job_matches` row for this search's
 *   resume) rather than an in-process increment. `linked` is the
 *   denominator that count is "of" — durable for the first time, which is
 *   what a reloaded page needs to rebuild a progress bar.
 * - `"complete"` — nothing is outstanding. `scored` + `permanentlyFailed` +
 *   `cappedForBudget` account for every one of the `linked` jobs.
 *   `degraded` is exactly `permanentlyFailed > 0`: a job that could not be
 *   scored is a REPORTABLE OUTCOME, not a blocker (one unscorable posting
 *   out of 180 must never hide the other 179 — CLAUDE.md's DLQ philosophy
 *   applied one level down from sources to jobs). There is deliberately no
 *   "mostly failed" middle state: real counts plus `degraded` let the UI
 *   decide how loud to be, which is the right place for that decision.
 *   `costEstimate` is NOT on this member any more — it was a
 *   `RunDemoMatchResult` field with no queue-driven analogue (no single
 *   run computes one) and no durable home. `POST /searches/estimate` still
 *   returns it, unchanged; that is where it belongs.
 *
 *   THREE-WAY, NOT TWO-WAY (ticket c9c676d). `permanentlyFailed` used to
 *   be the whole non-`scored` remainder, which conflated two outcomes the
 *   database has always distinguished (`job_match_failures.kind`) and a
 *   user would never: a job whose scoring was ATTEMPTED and permanently
 *   failed (expired key, retired model, retries exhausted) versus one that
 *   was deliberately NEVER ATTEMPTED because the search hit the scoring
 *   budget `POST /searches/estimate` priced up front. "We ran out of budget
 *   for these" is not "these are broken", and reporting a budget-bounded
 *   run as `degraded` told the user something had gone wrong when nothing
 *   had. `permanentlyFailed` is now GENUINE FAILURES ONLY and
 *   `cappedForBudget` carries the rest.
 * - `"failed"` — either the search could not be dispatched at all (no
 *   source's `fetch.source` message could be published), or TOTAL SCORING
 *   FAILURE: every linked job permanently failed and none was scored.
 *   That carve-out is deliberate and follows `runDemoMatch`'s own
 *   `isTotalScoringFailure` precedent: source failures are independent
 *   (USAJOBS being down says nothing about Lever), but scoring failures
 *   usually are not — an expired API key, a retired model id, or an
 *   exhausted budget fails every job identically, and reporting
 *   "complete, 0 of 180 scored" as a normal completion would be
 *   technically true and practically a lie.
 * - `"complete-details-unavailable"` — the `searches` row says
 *   `'complete'` but carries no `completed_at` latch, so there is no
 *   durable per-source/per-job ledger to derive details from. Still
 *   reachable, and deliberately kept: every pre-migration row, every
 *   CLI (`runDemoMatch`) row and every `POST /searches/estimate` row looks
 *   exactly like this, and they must keep behaving the way ticket 59fdc52
 *   made them behave. Results are fully queryable via
 *   `GET /resumes/:id/results` regardless.
 * - `"incomplete"` — a pre-queue row stuck at `'running'` with no
 *   `search_sources` ledger to interrogate. It may still be running
 *   elsewhere, or it may have died mid-scoring — never presented as
 *   `"complete"` just because a row exists (ticket 59fdc52 review round 2,
 *   "restart fallback can't report complete for a run that died after
 *   scoring 3 of 200"). Queue-driven searches do not reach this member:
 *   their work lives in RabbitMQ rather than in a process that can die
 *   with it, so the derive can say precisely what is still outstanding.
 */
export type SearchStatusResponse =
  | {
      searchId: string;
      status: "pending";
      resumeId: string;
      /** Linked jobs already scored for this search's resume. Same name
       * and same "successful scores only" semantics as before. */
      scoredSoFar: number;
      /** Jobs this search has linked SO FAR (it grows while sources are
       * still fetching). The denominator `scoredSoFar` is "of". */
      linked: number;
      /** Linked jobs whose scoring was ATTEMPTED and will never succeed —
       * a `score.job` message that exhausted its retries or failed
       * permanently. Narrowed by ticket c9c676d: budget-capped jobs used to
       * be counted here too and are now `cappedForBudget`. */
      permanentlyFailed: number;
      /** Linked jobs the fetch worker deliberately never sent for scoring,
       * because this search had already spent its shared scoring budget
       * (`DEFAULT_SCORE_THRESHOLD`, the same number
       * `POST /searches/estimate` prices). Not a failure: the jobs are
       * ingested, linked and queryable, they just have no match score.
       * Already non-zero mid-flight, because the fetch worker adjudicates
       * the budget as each source lands rather than at the end. */
      cappedForBudget: number;
      /** False while any source is still `pending`. This is what keeps
       * "every linked job is scored" from reading as TRUE for a search
       * with zero linked jobs — a brand-new search is `pending`, never
       * `complete`. */
      sourcesSettled: boolean;
      sources: SearchSourceState[];
      /** Set only when the search has been outstanding past the stall
       * window (see `routes/searches.ts`'s `STALL_AFTER_MS`): the marker
       * write for a dead-lettered message failed, so nothing will ever
       * settle this on its own. REPORTED, never auto-healed — replaying
       * from the DLQ is an operator action. Its value is the search's
       * `searchedAt`. */
      stalledSince?: string;
      /** Enumerated only alongside `stalledSince`: exactly which jobs are
       * still outstanding, so an operator can find them in the DLQ. */
      outstandingJobIds?: string[];
    }
  | { searchId: string; status: "failed"; resumeId: string; error?: string }
  | {
      searchId: string;
      status: "complete";
      resumeId: string;
      /** Linked jobs with a score for this search's resume. */
      scored: number;
      /**
       * Linked jobs whose scoring was ATTEMPTED and permanently failed —
       * retries exhausted, an expired API key, a retired model id, an
       * exhausted spend guard. Something went wrong.
       *
       * NARROWED BY TICKET c9c676d. This used to be every non-`scored`
       * linked job, budget-capped ones included; those are now
       * `cappedForBudget`. A consumer that wants the old "everything that
       * has no score" number is `permanentlyFailed + cappedForBudget`, but
       * it almost certainly wants to say something different about each.
       */
      permanentlyFailed: number;
      /**
       * Linked jobs the fetch worker deliberately never SENT for scoring,
       * because this search had already spent its shared scoring budget of
       * `DEFAULT_SCORE_THRESHOLD` jobs across all its sources — the same
       * number `POST /searches/estimate` priced and the caller authorized.
       * Nothing went wrong.
       *
       * The jobs are real: ingested, linked, and in `search_results`. They
       * simply have no match score, and a later run (or a hand-replayed
       * `score.job`) would score them normally — true of the hand-replay
       * since ticket 4f88339 (these rows never gated scoring), and true of
       * a later SEARCH only since ticket 9a53485, which stopped a capped
       * row written by one search from being read as a verdict on every
       * later search for the same resume. The honest UI sentence is
       * "42 more jobs matched but weren't scored — this search hit its
       * 200-job budget", not an error.
       *
       * Durably distinguished in the database by
       * `job_match_failures.kind = "score-threshold-capped"` since ticket
       * 4f88339; surfaced here since ticket c9c676d.
       */
      cappedForBudget: number;
      /** Jobs this search linked.
       * `scored + permanentlyFailed + cappedForBudget === linked`. */
      linked: number;
      sources: SearchSourceState[];
      /** ISO timestamp of the first read that observed this search
       * terminal (schema.ts's `searches.completedAt`). */
      completedAt: string;
      /**
       * `permanentlyFailed > 0` — finished, but something actually went
       * wrong while scoring.
       *
       * DELIBERATELY NOT `cappedForBudget > 0` (ticket c9c676d). A run that
       * only hit its budget is a fully successful run of exactly the size
       * the user was quoted before starting it; flagging it `degraded`
       * would train the user to ignore the flag on the searches where it
       * means something real. The budget is a product decision the caller
       * already consented to, not a fault. Show `cappedForBudget` plainly
       * and keep this boolean for faults.
       */
      degraded: boolean;
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
