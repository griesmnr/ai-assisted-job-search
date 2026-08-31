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
};

export type GetResumeResultsResponse = {
  resumeId: string;
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied — see
   * git-bug 1b9f81e. */
  hiddenBelowFloor?: number;
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

export type CostEstimate = {
  jobCount: number;
  estimatedInputTokens: number;
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
 * `GET /searches/:id`. "incomplete" is distinct from "failed": it means
 * this API process lost live progress tracking for the run (e.g. a
 * restart) and the `searches` row's own completion marker says it never
 * reached completion either — so it may still be running in another
 * process, or it may have died. Never reported as "complete" unless the
 * row's marker says so (ticket 59fdc52 review round 2, F "restart fallback
 * can't report complete for a run that died after scoring 3 of 200").
 */
export type SearchStatusResponse =
  | { searchId: string; status: "pending"; resumeId: string }
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
      status: "complete" | "incomplete";
      resumeId: string;
      note: string;
    };
