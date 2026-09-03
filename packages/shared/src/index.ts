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
};

export type GetResumeResponse = {
  id: string;
  resumeText: string;
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

export type ScoredJobResult = {
  jobId: string;
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
};

export type GetResumeResultsResponse = {
  resumeId: string;
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied — see
   * git-bug 1b9f81e. */
  hiddenBelowFloor?: number;
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
  estimatedCostUsd: number;
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
};

export type SourceOutcome = {
  dataSource: Job["dataSource"];
  status: "ok" | "empty" | "error";
  jobsFound: number;
  skippedCount: number;
  skipRate: number;
  survivedFilter: number;
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
  costEstimateDescription: string;
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
