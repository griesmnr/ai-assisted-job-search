/**
 * The matching pipeline itself: `runDemoMatch` and everything it needs —
 * resume find-or-create, applied-job lookup, board/source coverage
 * reporting, ranking, and the match-score floor.
 *
 * Split out of demo-match.ts (ticket 690c838), which is now a thin CLI
 * entry point that imports from here (see `apps/api/src/matching/index.ts`)
 * instead of the other way around — this file must never import FROM
 * demo-match.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Job, LevelFit } from "@app/shared";
import { MATCH_SCORE_FLOOR } from "@app/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { seedSourceDescriptors } from "../db/seed.js";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchSources,
  userJobStatuses,
} from "../db/schema.js";
import { describeCrossSourceMerge, ingestJobsForSearch } from "../ingest/ingestJobs.js";
import { loadEnvFile } from "../load-env.js";
import { CompositeSource, type PerSourceOutcome } from "../sources/composite.js";
import type { JobSource, NormalizedJob, SearchCriteria, TokenOutcome } from "../sources/types.js";
import { DEFAULT_SCORE_THRESHOLD, MODEL, type ScoreJobFn, type ScoredJob } from "./scoring.js";
import {
  type CostEstimate,
  describeCostEstimate,
  estimateScoringCost,
  readUsageStats,
  recordUsageStats,
} from "./usage-cost.js";

// See load-env.ts: BEFORE ticket 2fd6706, `process.loadEnvFile()` looked
// for `.env` relative to the CURRENT WORKING DIRECTORY, not this file's
// location -- meaning `.env` loaded correctly via demo-match.ts's own
// standalone entry point (cwd /workspace) but silently missed when the
// server started via `pnpm --filter @app/api dev` or the root `pnpm dev`
// (cwd apps/api, pnpm runs a workspace package's scripts with cwd set to
// that package's directory), since there is no apps/api/.env, only the
// root one. Ticket 2fd6706 fixed loadEnvFile() itself to resolve `.env`
// from a fixed path (via import.meta.url) instead of process.cwd() -- this
// call site needed no change, it already just calls the shared function,
// and now gets the correct file regardless of caller cwd. In the real
// dev-container flow the cwd-dependence was always harmless either way:
// docker-compose.yml's `env_file: .env` on the `dev` service already
// injects every variable into `process.env` before this module loads, so a
// missing *local* .env here just means there's nothing left to add.
//
// Lives here rather than in demo-match.ts (ticket 690c838 move) so it runs
// once whenever ANY consumer of the pipeline loads it — routes/searches.ts,
// routes/resumes.ts, index.ts, and demo-match.ts's own CLI tail all reach
// this via matching/index.ts — exactly as it did when this whole pipeline
// and demo-match.ts's CLI tail were one file.
loadEnvFile();

/**
 * Ticket 2b93534: the SAME underlying mechanism `load-env.ts`'s
 * `REPO_ROOT_ENV_PATH` fixes (see that file's doc comment for the full
 * story), applied here. `usageStatsPath`'s default below used to be the
 * bare relative string `"prep/scoring-usage-stats.json"`, resolved by
 * `fs.readFileSync`/`writeFileSync` relative to `process.cwd()` at
 * read/write time — a real file when this pipeline runs via
 * `demo-match.ts`'s own CLI entry point (cwd == repo root) but a silent
 * miss when the long-running API server is started via `pnpm dev` /
 * `pnpm --filter @app/api dev` / `cd apps/api && pnpm dev` (cwd ==
 * `apps/api`). `POST /searches/estimate` (routes/searches.ts) never
 * overrides this option, so every estimate served by a server started the
 * normal way silently fell back to the less-accurate bootstrap cost basis
 * instead of real historical per-call averages — no error, no log, just a
 * quieter, wrong number.
 *
 * Fixed the identical way: resolve relative to THIS FILE's own location
 * via `import.meta.url`, which Node fixes at module-load time regardless
 * of the caller's cwd, instead of depending on `process.cwd()` at all.
 * This file lives at `apps/api/src/matching/pipeline.ts`, four directory
 * levels below the repo root (`matching/` -> `src/` -> `apps/api/` ->
 * `apps/` -> repo root), hence `../../../../prep/scoring-usage-stats.json`.
 * Every caller that omits `usageStatsPath` — the CLI (demo-match.ts's
 * `main()`) and `POST /searches/estimate` alike — now reads/writes the
 * SAME real file regardless of its own startup cwd; a caller that wants a
 * different file (every test in demo-match.test.ts and searches.test.ts)
 * still explicitly overrides it, unaffected by this change.
 *
 * OUT OF SCOPE, DELIBERATELY: `scoreJobWorker.ts`'s own `USAGE_STATS_PATH`
 * constant is a separate, hand-copied instance of the same string literal
 * (ticket b53c422) that stays cwd-relative on purpose — that ticket fixed
 * it procedurally (a README instruction: launch from the repo root, not
 * via `pnpm --filter`), not structurally, and ticket 2b93534's scope
 * explicitly excludes touching it. Exported (`fileURLToPath`, not the raw
 * `URL`) so a test can assert the resolved path directly without needing a
 * real file, a real cwd, or a full `runDemoMatch` run — mirrors
 * `load-env.test.ts`'s approach for `REPO_ROOT_ENV_PATH`.
 */
export const DEFAULT_USAGE_STATS_PATH = fileURLToPath(
  new URL("../../../../prep/scoring-usage-stats.json", import.meta.url),
);

export type RankedResult = {
  jobId: string;
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  locationType: string | null;
  applyUrl: string;
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
  /**
   * Ticket b182bde. Optional on this TYPE (matching `ScoredJob.usage?` and
   * `ScoredJob.levelFit?` above) so the ~10 existing `makeRankedResult` test
   * fixtures in demo-match.test.ts keep compiling unchanged — this is an
   * internal CLI-path type (see `fetchRankedResults`'s own doc comment:
   * `routes/resumes.ts` reads straight from the database and does not go
   * through this type), not the public REST shape (`ScoredJobResult` in
   * packages/shared, where these two fields are NOT optional). A real
   * `fetchRankedResults` call always sets both (to `null` for an unjudged
   * row, never omits them).
   */
  levelFit?: LevelFit | null;
  levelFitNote?: string | null;
};

export type RunDemoMatchOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /**
   * Every source this run should search — Greenhouse, Lever, Ashby,
   * SmartRecruiters, or any combination (ticket d8417b2 wired all four in;
   * before that, this was a single `source: JobSource` and only Greenhouse
   * was ever passed). Fanned out via `CompositeSource`
   * (sources/composite.ts), which isolates one source's total failure from
   * the others — see that file's top-of-file comment for why it does NOT
   * itself pretend to be a single `JobSource`. Must be non-empty; an empty
   * array throws rather than silently searching nothing.
   */
  sources: JobSource[];
  resumeText: string;
  scoreJob: ScoreJobFn;
  /**
   * Defaults to `{}` (no criteria). Deliberately NOT `{ location:
   * "Washington" }`: `GreenhouseSource` (and any other client-side-filtered
   * source) substring-matches `criteria.location` against the board's raw
   * location string, which would reject "Remote - US" / "Seattle, WA" /
   * "Bellevue" — precisely the postings `filter` below exists to keep.
   * Location narrowing belongs in `filter`, not in `criteria`, for any
   * source whose adapter does that kind of substring match.
   */
  criteria?: SearchCriteria;
  /**
   * Applied to everything every source returned (the union, across all
   * configured sources). Defaults to the identity function (no filtering)
   * — callers that want title/location/dedupe narrowing (see `main()`
   * below for the real one) pass it explicitly. Every survivor gets
   * ingested — ticket 16c824a removed the `maxJobs` truncation that used
   * to slice this down in source/board iteration order before any of it
   * reached the database. What gets SCORED (as opposed to merely ingested)
   * is a separate, later decision — see `scoreThreshold`/`allowAboveThreshold`.
   */
  filter?: (jobs: NormalizedJob[]) => NormalizedJob[];
  /**
   * Companion to `filter` (ticket 14289ac): given the SAME union of raw
   * jobs `filter` receives, returns whichever of them were excluded
   * SPECIFICALLY because they're "somewhere in the US" with no evidence,
   * structured or textual, of a remote work arrangement — a plain boolean
   * `filter` can't report distinctly, since it just says "not a survivor."
   * Defaults to a function that always returns `[]` (no metadata-exclusion
   * reporting), same "opt in by passing the real thing" shape as `filter`
   * itself defaulting to identity. The one real implementation is
   * swe-filter.ts's `excludedForMissingWorkArrangement`, and it's only
   * meaningful when `filter` is (or is built from) `filterSoftwareEngineeringJobs`
   * — `main()` below and the REST routes wire the two together so they're
   * never passed inconsistently (e.g. one reflecting `criteria`-based
   * filtering while the other reports against a filter that doesn't even
   * have a "us-wide" concept — see `sources/criteria.ts`'s `passesLocation`,
   * which is a different, simpler model with nothing to report here, hence
   * `compileExcludedForMissingWorkArrangement` returning `() => []` for any
   * explicit `criteria`). Threaded into `sourceOutcomes` /
   * `BoardCoverageEntry` exactly like `filter`'s survivors are, through the
   * same reporting channel — see `SourceOutcome.excludedForMissingWorkArrangement`.
   */
  excludedForMissingWorkArrangement?: (jobs: NormalizedJob[]) => NormalizedJob[];
  /**
   * Spend guard (ticket 16c824a). Above this many jobs actually NEEDING a
   * new score this run (already-scored jobs are free — ticket 620ca30),
   * scoring stops here unless `allowAboveThreshold` is set — see
   * `DEFAULT_SCORE_THRESHOLD`'s doc comment for the pool-size assumption
   * and for exactly what this does and does not truncate (it bounds
   * SCORING/spend, not ingestion, and a plain rerun drains it for free).
   * Defaults to `DEFAULT_SCORE_THRESHOLD`.
   */
  scoreThreshold?: number;
  /**
   * Explicit opt-in to score MORE than `scoreThreshold` jobs in one run.
   * Defaults to `false` — a pool above the threshold gets capped, not
   * silently scored in full, unless a caller deliberately sets this (or,
   * in `main()`, sets `ALLOW_SCORE_ABOVE_THRESHOLD=true`).
   */
  allowAboveThreshold?: boolean;
  /**
   * Where real per-call token usage accumulates across runs (see
   * `recordUsageStats`), read back by `estimateScoringCost` so the
   * pre-scoring cost estimate is grounded in this project's own measured
   * history rather than a one-off guess. Defaults to
   * `DEFAULT_USAGE_STATS_PATH` (ticket 2b93534) — a fixed, `import.meta.url`
   * -resolved absolute path to `prep/scoring-usage-stats.json` at the repo
   * root, correct regardless of the caller's `process.cwd()`. Deliberately
   * a different file from `outputPath` (`prep/match-results.json`), which
   * holds ranked results a user may have already applied from and must
   * never be touched by this.
   */
  usageStatsPath?: string;
  outputPath?: string;
  log?: (message: string) => void;
  /**
   * Ticket 1998875: fired once per job that finishes SUCCESSFULLY inside
   * the `scoreOne`/`Promise.allSettled` loop below — i.e. once per
   * eventual `newlyScored`, not once per attempt. A failed `scoreJob` call
   * does not fire this (mirrors `newlyScored` vs `failed` in
   * `RunDemoMatchResult`: a failed attempt isn't "scored," it gets retried
   * on the next run, so counting it here would overstate progress). Called
   * synchronously the moment each call resolves — NOT batched until
   * `Promise.allSettled` itself settles — so a caller polling a counter
   * this increments (routes/searches.ts) can observe genuine intermediate
   * values while the run is still in flight, not just a jump straight to
   * the final total. Deliberately does NOT change what `scoreOne` returns,
   * the two-phase warm/batch structure, or the single batched
   * `db.insert(jobMatches)` after everything settles (ticket 1998875 scope:
   * "NOT a scoring-pipeline restructure") — this is purely an
   * observability hook layered on top of the existing loop. Optional and
   * defaults to a no-op so every existing caller (the CLI's `main()`,
   * every `runDemoMatch` test) keeps working unchanged.
   */
  onJobScored?: () => void;
  /**
   * Ticket bf2dd0a: fired once per configured SOURCE as its own fetch
   * settles — success or failure — inside `CompositeSource#search`'s
   * `Promise.allSettled` fan-out, threaded straight through unchanged (see
   * that method's own doc comment for why it fires per-source, via
   * `.finally()`, rather than once for the whole batch). Exists for the
   * SAME reason `onJobScored` above does — a caller polling a counter this
   * increments can show genuine incremental progress instead of a bare
   * spinner — but for the FETCH phase rather than the scoring phase, which
   * matters because `POST /searches/estimate` (routes/searches.ts) never
   * reaches scoring at all (`estimateOnly`, `NEVER_SCORE`): `onJobScored`
   * fires zero times on that path no matter how slow the run is, while this
   * fires once per source regardless of `estimateOnly`. See
   * `matching/estimateProgress.ts` for the in-memory record this feeds on
   * the estimate route. Optional and defaults to a no-op so every existing
   * caller (the CLI's `main()`, every `runDemoMatch` test) keeps working
   * unchanged.
   */
  onSourceSettled?: (dataSource: Job["dataSource"]) => void;
  /**
   * Overrides the randomly generated `searches.id` this run creates.
   * Ticket 59fdc52: the REST API's async "run a search" route needs to hand
   * the client a pollable id *before* this (multi-minute, billed) call
   * resolves — it generates the id, starts tracking it, kicks this off
   * without awaiting, and needs that same id to end up on the `searches`
   * row so a later `GET /searches/:id` can find it in the database even if
   * the API process restarts before the run finishes (see that route's doc
   * comment). Defaults to a fresh `randomUUID()` when omitted, exactly as
   * before this ticket.
   */
  searchId?: string;
  /**
   * Ticket 59fdc52: fetches and ingests real postings, computes the
   * pre-scoring cost estimate, and returns — WITHOUT calling `scoreJob` for
   * any of them. This is what backs the REST API's `POST /searches/estimate`
   * (decision: "a search must be able to report its cost before spending").
   * Fetching and ingestion are free (no Claude calls), so an estimate run
   * still grows the durable job corpus exactly like a real run does; a
   * follow-up real run against the same resume/sources re-fetches (cheap,
   * idempotent — `ingestJobsForSearch` upserts) and scores only what
   * `estimateOnly` deliberately left unscored. Defaults to `false`.
   */
  estimateOnly?: boolean;
};

/**
 * One configured token's outcome, extended with how many of its postings
 * survived `filter` — the third distinction ticket b723fb9 asks for, that
 * `TokenOutcome` alone (source-level) can't make: a board can be "ok"
 * (real, has postings) and still contribute zero jobs to the funnel
 * because none matched the title/location filter. `status`/`postingCount`
 * describe the source; `survivedFilter` describes what THIS run's `filter`
 * did with them. A user staring at an empty result can read this list and
 * tell "your board token is wrong" apart from "that employer isn't
 * hiring right now" apart from "they're hiring, just not for this" —
 * three different problems that otherwise all look like silence.
 */
export type BoardCoverageEntry = TokenOutcome & {
  survivedFilter: number;
  /**
   * How many of this token's postings, past the title filter, were
   * excluded specifically because they're "somewhere in the US" with no
   * evidence — structured or textual — of a remote work arrangement
   * (ticket 14289ac; see swe-filter.ts's `excludedForMissingWorkArrangement`
   * and `LocationRejectionReason`). Correlated to this token by the SAME
   * `companyName`-matching `buildBoardCoverage` already uses for
   * `survivedFilter`, and carries the identical hazard — see that field's
   * WARNING above. Always `0` for a token whose source doesn't populate
   * `tokenOutcomes` at all (this array is then `[]`, per
   * `buildBoardCoverage`'s early return) — as of this ticket that's still
   * true for Lever, Ashby, and SmartRecruiters, so a source-level total
   * (`SourceOutcome.excludedForMissingWorkArrangement`) is the only place
   * this reads correctly for those three; only Greenhouse gets the
   * per-employer breakdown today. A board contributing zero survivors with
   * a nonzero count here is DISTINCT from one contributing zero for every
   * other already-tracked reason — that distinction is this ticket's whole
   * point.
   */
  excludedForMissingWorkArrangement: number;
};

export type RunDemoMatchResult = {
  resumeId: string;
  searchId: string;
  /** How many of the ingested candidate jobs already had a score for this
   * resume and so were NOT sent to Claude. */
  skipped: number;
  /** How many jobs were actually scored (Claude calls made AND
   * successfully persisted) this run. */
  newlyScored: number;
  /**
   * Jobs Claude was asked to score but whose call rejected (e.g. a
   * transient overload). Distinct from `skipped` — a failed job was
   * neither skipped nor scored, so the next run will retry it, not treat
   * it as done.
   */
  failed: number;
  results: RankedResult[];
  /**
   * One entry per configured source (ticket d8417b2) — Greenhouse, Lever,
   * Ashby, SmartRecruiters, whichever were passed as `sources`. Replaces
   * what used to be a single `boardCoverage: BoardCoverageEntry[]` from
   * back when `runDemoMatch` only ever took one `source`. See
   * `SourceOutcome`.
   */
  sourceOutcomes: SourceOutcome[];
  /**
   * How many jobs needed a NEW score this run (ingested candidates minus
   * `skipped`), before the spend-guard cap was applied. `newlyScored +
   * failed + cappedCount === candidatesNeedingScore` (ticket 16c824a).
   */
  candidatesNeedingScore: number;
  /**
   * How many of `candidatesNeedingScore` were NOT scored this run because
   * `scoreThreshold` applied and `allowAboveThreshold` wasn't set. Always 0
   * when the pool was at/under the threshold, or the override was active.
   * A nonzero value here means this run's `results` is a truncated view of
   * what's scoreable, not the whole pool — callers must not present it as
   * complete without surfacing this number.
   */
  cappedCount: number;
  /**
   * The `scoreThreshold` actually in effect this run (the caller's override
   * or `DEFAULT_SCORE_THRESHOLD`). Ticket 59fdc52 review round 2: the REST
   * API's cost-estimate response was reporting the cost of scoring the
   * WHOLE pool while a real run caps spend at this number — carrying the
   * threshold itself is what lets a caller understand why `costEstimate`
   * and `candidatesNeedingScore` disagree.
   */
  scoreThreshold: number;
  /**
   * The pre-scoring cost estimate for whatever was actually ATTEMPTED this
   * run — i.e. after `scoreThreshold` capping, exactly like a real run's
   * spend (see `estimateScoringCost`). `estimateOnly` computes this the
   * same cap-aware way rather than pricing the full uncapped pool: pricing
   * the uncapped pool overstated cost by ~30x against what a real run
   * (which caps at `scoreThreshold`) would actually bill (ticket 59fdc52
   * review round 2).
   */
  costEstimate: CostEstimate;
};

/**
 * One-line-per-source funnel status, computed once per `runDemoMatch` call
 * from `CompositeSource`'s `PerSourceOutcome[]` (sources/composite.ts) plus
 * this run's post-`filter` survivors. Deliberately mirrors `TokenStatus`'s
 * vocabulary (`TokenOutcome`, ticket b723fb9) one level up rather than
 * inventing a parallel shape: `TokenOutcome` already solved "tell a bad
 * employer TOKEN apart from a quiet employer apart from a filtered-out
 * employer" *within* one source; this is the identical three-way
 * distinction for a whole SOURCE within a search that now spans several —
 * "Lever wasn't asked" (Lever simply isn't in `sources`, so it has no entry
 * here at all — nothing to average away), "Lever returned nothing"
 * (`status: "empty"`), and "Lever returned postings, none survived
 * filtering" (`status: "ok"`, `survivedFilter: 0`) are three different,
 * user-visible problems that a single skipRate merged across all four
 * sources would collapse into one indistinguishable number. See ticket
 * d8417b2.
 */
export type SourceOutcome = {
  dataSource: Job["dataSource"];
  /**
   * "error": this source's own `search()` call rejected outright —
   * `CompositeSource` isolated it so it couldn't take the other configured
   * sources down with it (see composite.ts's `PerSourceOutcome`). "empty":
   * `search()` succeeded and returned zero raw postings. "ok": `search()`
   * succeeded and returned at least one raw posting — independent of
   * whether any of them survived `filter`; see `survivedFilter` for that.
   */
  status: "ok" | "empty" | "error";
  /** Raw postings this source returned, before `filter`. Always 0 for
   * "error" — nothing was fetched. */
  jobsFound: number;
  /** This source's own record-level skip count — never summed across
   * sources. */
  skippedCount: number;
  /** This source's OWN `skipRate` (see `SourceSearchResult.skipRate`),
   * never averaged against any other source's. Always 0 for "error". */
  skipRate: number;
  /**
   * How many of THIS source's raw postings survived `filter` this run.
   * Computed by an exact `dataSource` match
   * against `filtered` — unlike `BoardCoverageEntry.survivedFilter`'s
   * company-NAME correlation (free text, a documented latent hazard — see
   * that field's WARNING), `NormalizedJob.dataSource` is a closed enum the
   * adapter itself stamps, so this number carries none of that
   * misattribution risk.
   */
  survivedFilter: number;
  /**
   * How many of THIS source's title-passing postings were excluded
   * specifically for missing work-arrangement metadata — ticket 14289ac,
   * source-level total (sums the same jobs `BoardCoverageEntry.excludedForMissingWorkArrangement`
   * attributes per-token where a per-token breakdown is available). Always
   * `0` for "error" (nothing was fetched) and for a run that didn't pass
   * `RunDemoMatchOptions.excludedForMissingWorkArrangement`. This is the
   * number that makes a source contributing zero survivors FOR THIS REASON
   * distinguishable from one contributing zero for every other reason —
   * "error" (fetch failed), "empty" (no postings at all), or "ok" with
   * `survivedFilter: 0` and THIS at `0` too (postings existed, none
   * matched, and it wasn't the missing-metadata rule specifically).
   */
  excludedForMissingWorkArrangement: number;
  /** Present only when `status === "error"`. */
  errorMessage: string | undefined;
  /**
   * This source's own per-token/per-employer breakdown, when it populates
   * `tokenOutcomes` (Greenhouse does, as of ticket b723fb9; Lever, Ashby,
   * and SmartRecruiters do not yet — see this ticket's report). Empty for
   * "error" (nothing was fetched to break down) and for any source that
   * doesn't populate `tokenOutcomes` at all.
   */
  boardCoverage: BoardCoverageEntry[];
};

/**
 * True when every scoring call this run attempted failed and nothing new
 * got scored — as opposed to a healthy run that simply found nothing to
 * score (0 failed, 0 newlyScored, e.g. everything was already scored) or
 * a partial failure (some succeeded). `main()` uses this to decide
 * whether to exit non-zero: since `runDemoMatch` uses `Promise.allSettled`
 * (not `Promise.all`) to score a batch, a total failure — e.g. Anthropic
 * 529ing on every job — no longer throws, and without this check would be
 * observationally identical, at the process exit code, to a successful
 * search that found nothing (ticket 620ca30 review finding B3). Extracted
 * as a pure function so this decision has a direct unit test instead of
 * only being exercised by reading `main()`.
 */
export function isTotalScoringFailure(
  result: Pick<RunDemoMatchResult, "failed" | "newlyScored">,
): boolean {
  return result.failed > 0 && result.newlyScored === 0;
}

/**
 * Extends each raw `TokenOutcome` (source-level: does the token resolve,
 * does the board have postings) with `survivedFilter` — how many of
 * `filtered` (this run's `filter` applied to everything the source
 * returned) came from that token's employer.
 * Matched by `NormalizedJob.company` against `TokenOutcome.companyName`
 * (case-insensitively) rather than by tagging every job with its token,
 * which would mean widening `NormalizedJob` for a concern specific to this
 * reporting. Returns `[]` when the source didn't populate `tokenOutcomes`
 * at all (ticket b723fb9's board-coverage reporting is opt-in per source,
 * not a requirement every `JobSource` implementation must satisfy).
 *
 * WARNING (ticket b723fb9 review finding #1): this correlation is by
 * NAME, not by token, and `TokenOutcome.companyName` is free text an
 * employer typed into a form field — see the WARNING on that field for
 * the concrete hazards (two tokens self-reporting the same name double-
 * counts survivors onto both; a name that differs from the survivors'
 * `company` under-counts to zero while the board is actually healthy).
 * None of that fires against the 25 tokens configured today, but it is
 * real and latent, not hypothetical — `fivetran`'s real API response
 * self-reports `"Fivetran "` with a trailing space today; only `.trim()`
 * keeps that one matching.
 *
 * Rather than pretend the correlation is exact, this function runs three
 * cheap sanity checks over its own output and calls `warn` when any fires,
 * instead of silently returning numbers that may misattribute survivors
 * (or exclusions) between boards:
 *
 *   1. `sum(survivedFilter)` across every returned entry should equal
 *      `filtered.length` — every survivor should be attributed to exactly
 *      one token. A mismatch PROVES some misattribution happened
 *      (over-counted somewhere, under-counted somewhere, or both), but a
 *      MATCHING sum does not prove there was none: errors can cancel. Two
 *      tokens sharing a name can double-count 2 survivors up to 4 while a
 *      third, nameless token under-counts its own 2 down to 0 — sum stays
 *      right (4) while every individual number is wrong. That's what
 *      check 3 is for.
 *   2. Ticket 14289ac: the identical check, run again for
 *      `excludedForMissingWorkArrangement` instead of `survivedFilter` —
 *      the same free-text `companyName` correlation feeds both fields off
 *      the same `tokenOutcomes` list, so it can misattribute exclusions
 *      exactly as easily as it can misattribute survivors, and a board
 *      contributing real exclusions must not silently read as "0" any
 *      more than one contributing real survivors should.
 *   3. Two or more entries reporting the identical `companyName`
 *      (case-insensitively) are flagged directly — this is exactly the
 *      double-counting hazard, caught independent of whether either sum
 *      happens to net out.
 *
 * No single check proves the report is correct; together they catch every
 * hazard this function's own review turned up. A board that's actually
 * healthy must never silently read as "0 survived filtering" (that reads
 * as dead and is exactly what gets a productive token deleted) without at
 * least a `warn` alongside it.
 */
export function buildBoardCoverage(
  tokenOutcomes: TokenOutcome[] | undefined,
  filtered: NormalizedJob[],
  warn: (message: string) => void = (message) => console.warn(message),
  /**
   * Ticket 14289ac: the title-passing postings of THIS source that were
   * excluded specifically for missing work-arrangement metadata (see
   * swe-filter.ts's `excludedForMissingWorkArrangement`), correlated to a
   * token by `companyName` the same way `filtered` is for `survivedFilter`
   * below. Defaults to `[]` so every existing caller (including the tests
   * in demo-match.test.ts written before this ticket) keeps working
   * unchanged and simply gets `0` for the new field.
   */
  excludedForMissingWorkArrangement: NormalizedJob[] = [],
): BoardCoverageEntry[] {
  if (!tokenOutcomes || tokenOutcomes.length === 0) return [];

  const survivedByCompany = new Map<string, number>();
  for (const job of filtered) {
    const key = job.company.trim().toLowerCase();
    survivedByCompany.set(key, (survivedByCompany.get(key) ?? 0) + 1);
  }

  const excludedByCompany = new Map<string, number>();
  for (const job of excludedForMissingWorkArrangement) {
    const key = job.company.trim().toLowerCase();
    excludedByCompany.set(key, (excludedByCompany.get(key) ?? 0) + 1);
  }

  const coverage = tokenOutcomes.map((outcome) => ({
    ...outcome,
    survivedFilter: outcome.companyName
      ? (survivedByCompany.get(outcome.companyName.trim().toLowerCase()) ?? 0)
      : 0,
    excludedForMissingWorkArrangement: outcome.companyName
      ? (excludedByCompany.get(outcome.companyName.trim().toLowerCase()) ?? 0)
      : 0,
  }));

  const attributedTotal = coverage.reduce((sum, entry) => sum + entry.survivedFilter, 0);
  if (attributedTotal !== filtered.length) {
    warn(
      `buildBoardCoverage: per-token survivedFilter counts sum to ${attributedTotal}, but ` +
        `${filtered.length} job(s) actually survived filtering this run. TokenOutcome.companyName ` +
        `is free text, not a stable key (two tokens can self-report the same name, or a name can ` +
        `differ from what actually survived) — the board-coverage numbers below may misattribute ` +
        `survivors between tokens. Do not conclude a token contributed nothing from this report alone.`,
    );
  }

  const attributedExcluded = coverage.reduce(
    (sum, entry) => sum + entry.excludedForMissingWorkArrangement,
    0,
  );
  if (attributedExcluded !== excludedForMissingWorkArrangement.length) {
    warn(
      `buildBoardCoverage: per-token excludedForMissingWorkArrangement counts sum to ` +
        `${attributedExcluded}, but ${excludedForMissingWorkArrangement.length} job(s) were actually ` +
        `excluded for missing work-arrangement metadata this run. TokenOutcome.companyName ` +
        `is free text, not a stable key (two tokens can self-report the same name, or a name can ` +
        `differ from what actually was excluded) — the board-coverage numbers below may misattribute ` +
        `exclusions between tokens. Do not conclude a token contributed nothing from this report alone.`,
    );
  }

  const namesSeen = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const entry of coverage) {
    if (!entry.companyName) continue;
    const key = entry.companyName.trim().toLowerCase();
    if (namesSeen.has(key)) duplicateNames.add(key);
    namesSeen.add(key);
  }
  if (duplicateNames.size > 0) {
    warn(
      `buildBoardCoverage: multiple tokens self-report the same company name ` +
        `(${[...duplicateNames].join(", ")}) — each such token's survivedFilter AND ` +
        `excludedForMissingWorkArrangement counts every job attributed to that name, so both are ` +
        `almost certainly double-counted between those tokens specifically, regardless of whether ` +
        `the totals above happened to match.`,
    );
  }

  return coverage;
}

/**
 * The one-line-per-board summary ticket b723fb9 exists to make possible:
 * outcomes that used to all look like "nothing from this employer" now
 * read as distinct, specific problems.
 *
 * Basis note (ticket 14289ac): the "ok" branch below prints `survivedFilter`
 * and `excludedForMissingWorkArrangement` in one sentence, which reads as
 * two counts on the same basis — they are not. `survivedFilter` is DEDUPED
 * (company|title dedupe, from `filterSoftwareEngineeringJobs`);
 * `excludedForMissingWorkArrangement` deliberately is NOT deduped (see that
 * function's own doc comment in swe-filter.ts) and counts raw postings, so
 * the two numbers cannot be summed or diffed against each other as if they
 * partitioned the same denominator.
 */
export function describeBoardOutcome(entry: BoardCoverageEntry): string {
  switch (entry.status) {
    case "not-found":
      return "board does not exist (404) — check the token";
    case "empty":
      return "board exists, 0 postings right now";
    case "error":
      // `entry.message` already says what happened — a fetch failure
      // ("Greenhouse request for board ... timed out...", "... HTTP
      // 503..."), a rate limit ("Greenhouse rate limit exceeded (HTTP
      // 429)..."), or, for a token search() never got to after a 429,
      // "not checked — search() stopped issuing requests after board ...
      // was rate-limited". All three are potentially resolved by a later
      // run, hence the shared "rerun to retry" — this is NOT "not-found":
      // the board may be perfectly healthy, this run just couldn't
      // confirm that.
      return `${entry.message ?? "fetch failed (unknown error)"} — rerun to retry`;
    case "ok": {
      const base = `${entry.postingCount} posting(s), ${entry.survivedFilter} survived filtering`;
      // Ticket 14289ac: only append this when nonzero, so the common case
      // (no metadata-excluded postings) reads exactly as it always has —
      // the whole point is that a NONzero count here now stands out
      // instead of being silent.
      return entry.excludedForMissingWorkArrangement > 0
        ? `${base} (+${entry.excludedForMissingWorkArrangement} more excluded for missing ` +
            `work-arrangement metadata — "United States" with no evidence of a remote arrangement)`
        : base;
    }
  }
}

/**
 * Builds one `SourceOutcome` per entry in `perSource` (see that type's doc
 * comment). `filtered` is the SAME post-`filter` array
 * `buildBoardCoverage` already receives — bucketed here by exact
 * `dataSource` before being handed to `buildBoardCoverage` per source, so a
 * token from one source can never be credited with another source's
 * survivors even if their `TokenOutcome.companyName`s happen to collide
 * (e.g. two different sources both hosting a board that self-reports
 * "Acme") — `buildBoardCoverage`'s own name-correlation hazard (see its doc
 * comment) is scoped per-source here, not left free to cross source
 * boundaries too.
 */
export function buildSourceOutcomes(
  perSource: PerSourceOutcome[],
  filtered: NormalizedJob[],
  warn: (message: string) => void = (message) => console.warn(message),
  /** Ticket 14289ac: same union-of-all-sources shape as `filtered`, bucketed
   * per source below exactly like `filtered` already is for `survivedFilter`.
   * Defaults to `[]` so existing callers (including demo-match.test.ts's
   * pre-ticket tests) are unaffected and simply see `0`. */
  excludedForMissingWorkArrangement: NormalizedJob[] = [],
): SourceOutcome[] {
  return perSource.map((outcome): SourceOutcome => {
    if (outcome.status === "error") {
      return {
        dataSource: outcome.dataSource,
        status: "error",
        jobsFound: 0,
        skippedCount: 0,
        skipRate: 0,
        survivedFilter: 0,
        excludedForMissingWorkArrangement: 0,
        errorMessage: outcome.errorMessage,
        boardCoverage: [],
      };
    }

    const { result } = outcome;
    const filteredForSource = filtered.filter((j) => j.dataSource === outcome.dataSource);
    const excludedForSource = excludedForMissingWorkArrangement.filter(
      (j) => j.dataSource === outcome.dataSource,
    );

    return {
      dataSource: outcome.dataSource,
      status: result.jobs.length === 0 ? "empty" : "ok",
      jobsFound: result.jobs.length,
      skippedCount: result.skipped.length,
      skipRate: result.skipRate,
      survivedFilter: filteredForSource.length,
      excludedForMissingWorkArrangement: excludedForSource.length,
      errorMessage: undefined,
      boardCoverage: buildBoardCoverage(
        result.tokenOutcomes,
        filteredForSource,
        warn,
        excludedForSource,
      ),
    };
  });
}

/**
 * The one-line-per-source summary parallel to `describeBoardOutcome` — see
 * `SourceOutcome`'s doc comment for why the vocabulary mirrors
 * `TokenStatus` one level up.
 *
 * Basis note (ticket 14289ac): same caveat as `describeBoardOutcome` —
 * `survivedFilter` (deduped) and `excludedForMissingWorkArrangement` (not
 * deduped) appear in the same "ok" sentence below but are not on the same
 * basis; see `describeBoardOutcome`'s doc comment for the full explanation.
 */
export function describeSourceOutcome(entry: SourceOutcome): string {
  switch (entry.status) {
    case "error":
      return `${entry.errorMessage ?? "search failed (unknown error)"} — rerun to retry`;
    case "empty":
      return "0 postings returned this run";
    case "ok": {
      const base =
        `${entry.jobsFound} posting(s), ${entry.skippedCount} skipped ` +
        `(skipRate ${entry.skipRate.toFixed(2)}), ${entry.survivedFilter} survived filtering`;
      // Ticket 14289ac — see describeBoardOutcome's identical treatment.
      return entry.excludedForMissingWorkArrangement > 0
        ? `${base} (+${entry.excludedForMissingWorkArrangement} more excluded for missing ` +
            `work-arrangement metadata)`
        : base;
    }
  }
}

/**
 * Deterministic content hash used as the resumes upsert key. Two identical
 * resumes hash identically regardless of process/timing, which is what
 * makes `INSERT ... ON CONFLICT (resume_hash) DO NOTHING` a correct,
 * race-safe find-or-create — unlike a plain select-then-insert, this is
 * safe even if two `runDemoMatch` calls for the same resume text overlap.
 */
function hashResumeText(resumeText: string): string {
  return createHash("sha256").update(resumeText, "utf8").digest("hex");
}

/**
 * Finds-or-creates the `resumes` row for this exact resume text, keyed on
 * `resume_hash` (a UNIQUE column — see db/schema.ts), not `resume_text`
 * directly: Postgres btree index rows are capped around 2704 bytes and a
 * real resume can exceed that, so `UNIQUE(resume_text)` would fail at
 * insert time for a long resume. Hashing first sidesteps that and doubles
 * as the concurrency fix: the upsert always attempts the insert (cheap —
 * one row, no Claude call involved), lets `ON CONFLICT DO NOTHING` resolve
 * a race for free, and then selects by the same hash. Two concurrent
 * callers for the same resume text are guaranteed to agree on exactly one
 * winning row afterward — no duplicate `resumes` rows, and no
 * `ORDER BY`-dependent ambiguity about which one "the" row is.
 */
/**
 * Exported (ticket 59fdc52) so the REST API's `POST /resumes` can find-or-
 * create a resume row directly — resumes are content-addressed by
 * `resumeHash` (ticket 620ca30), and this is the one place that hashing +
 * upsert logic lives. Reusing it here, rather than reimplementing the same
 * hash-then-upsert dance in a route handler, is exactly the "reuse
 * runDemoMatch's persistence, don't reimplement it" instruction: a resume
 * paste alone doesn't need a full `runDemoMatch` run (which also fetches
 * and would ingest jobs) — it only needs this one step.
 *
 * Ticket 38a7598: a genuinely NEW resume also gets a real, distinct default
 * nickname ("Resume N") assigned right here, at insert time — never left
 * blank for a later pass to fix. `N` is one more than the current row
 * count, read just before the insert. This is deliberately a BEST-EFFORT
 * scheme, not a strictly-monotonic guarantee: two concurrent calls for two
 * DIFFERENT new resumes could both read the same count and mint the same
 * "Resume N" (the same race `getOrCreateResumeId`'s hash-based upsert below
 * is explicitly safe against — for the HASH, not for this count). Accepted
 * for this ticket's scope (a single-user app with no concurrent resume
 * submissions in practice — see the ticket's own "implementer's call on
 * exact numbering scheme"); a strictly-unique numbering would need a DB
 * sequence or a serializable transaction around both statements, which is
 * more machinery than this feature's actual usage pattern justifies.
 */
/**
 * Ticket 7701534: `isNew` tells the caller whether THIS call is the one
 * that created the row, vs. found one that already existed. `POST
 * /resumes` needs this to tell "a genuinely new resume" apart from
 * "this text already belongs to some other resume" (a duplicate, per
 * Nicole's own ask) -- the `id` alone can't distinguish those, since
 * find-or-create returns a real id either way. Determined from whether
 * the upsert's own `RETURNING` came back non-empty (this call's insert
 * really landed), not from a second, separate existence check -- no
 * extra query, and no race between "check" and "insert" for a different
 * caller to land in.
 */
export type GetOrCreateResumeResult = { id: string; isNew: boolean };

export async function getOrCreateResumeId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeText: string,
): Promise<GetOrCreateResumeResult> {
  const resumeHash = hashResumeText(resumeText);

  const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(resumes);
  const nextResumeNumber = (countRows[0]?.count ?? 0) + 1;

  const inserted = await db
    .insert(resumes)
    .values({
      id: randomUUID(),
      resumeText,
      resumeHash,
      resumeNickname: `Resume ${nextResumeNumber}`,
    })
    .onConflictDoNothing({ target: resumes.resumeHash })
    .returning({ id: resumes.id });

  if (inserted.length > 0) {
    return { id: inserted[0]!.id, isNew: true };
  }

  const rows = await db
    .select({ id: resumes.id })
    .from(resumes)
    .where(eq(resumes.resumeHash, resumeHash))
    .limit(1);
  if (rows.length === 0) {
    // Should be impossible: the insert above either created this row or
    // no-opped because a row with this hash already existed.
    throw new Error(
      `getOrCreateResumeId: no resumes row found for hash "${resumeHash}" after upsert`,
    );
  }
  return { id: rows[0]!.id, isNew: false };
}

/** The subset of a `jobs` row needed to build a `NormalizedJob` for
 * (re-)scoring -- exactly the columns `db/schema.ts`'s `jobs` table
 * carries, minus `id`/`postedAt` type narrowing quirks. Moved here from
 * `scripts/rescore-existing-matches.ts` (opus review, ticket 4065511):
 * `worker/scoreJobWorker.ts` needs this same DB-row-to-NormalizedJob
 * conversion and importing it from a CLI script pointed the dependency
 * arrow backwards -- exactly the "shared pipeline pieces don't belong in
 * scripts" problem ticket 690c838 created `matching/` to fix. */
export type JobDescriptionRow = {
  externalId: string;
  dataSource: string;
  title: string;
  description: string;
  company: string;
  payType: "hourly" | "salary" | null;
  commitment: "full-time" | "part-time" | "contract" | null;
  locationType: "remote" | "onsite" | "hybrid" | null;
  location: string | null;
  linkToApply: string;
  postedAt: Date;
};

/**
 * Converts one already-stored `jobs` row into the `NormalizedJob` shape
 * `buildJobSuffix`/`makeClaudeScorer` expect -- no live re-fetch (`jobs.
 * description` is `NOT NULL`, always populated from original ingestion).
 * Only real conversion needed: drizzle's nullable columns come back as
 * `null`; `NormalizedJob`'s optional fields want `undefined` for "not
 * stated" (same convention `Job`'s own doc comment in packages/shared
 * uses). `dataSource` is widened from the column's plain `text` type to
 * `NormalizedJob["dataSource"]`'s literal union with a cast: the column is
 * a `text` FK to `source_descriptors.id` at the TYPE level, but every real
 * row's value IS one of that union's literals (ingestion never writes
 * anything else there).
 */
export function toNormalizedJob(row: JobDescriptionRow): NormalizedJob {
  return {
    externalId: row.externalId,
    dataSource: row.dataSource as NormalizedJob["dataSource"],
    title: row.title,
    description: row.description,
    company: row.company,
    payType: row.payType ?? undefined,
    commitment: row.commitment ?? undefined,
    locationType: row.locationType ?? undefined,
    location: row.location ?? undefined,
    linkToApply: row.linkToApply,
    postedAt: row.postedAt,
  };
}

/**
 * Marks `searches.status = 'complete'` for `searchId`. Called right before
 * EVERY successful return point in `runDemoMatch` (the empty-pool early
 * return, the `estimateOnly` early return, and the normal end) — ticket
 * 59fdc52 review round 2: without this, `GET /searches/:id`'s DB-fallback
 * branch (used once an API process's in-memory tracker has lost this run —
 * e.g. after a restart) could not tell "this run finished" apart from
 * "this run's process died after scoring 3 of 200"; both left an identical
 * `searches` row behind. If `runDemoMatch` itself throws before reaching
 * one of these call sites, the row is simply never updated and stays at
 * its `'running'` default — the honest signal, not a guess. (A caller that
 * catches the rejection, e.g. the REST API's `POST /searches` route, is
 * responsible for marking `'failed'` itself — see that route.)
 */
async function markSearchComplete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  searchId: string,
): Promise<void> {
  await db.update(searches).set({ status: "complete" }).where(eq(searches.id, searchId));
}

/**
 * The DB-backed ranked-results query shared by a normal run's tail (every
 * `linkedJobId`, some newly scored this run) and `estimateOnly`'s early
 * return (only `alreadyScoredIds` — nothing new was scored). Extracted
 * (ticket 59fdc52) so both paths honor the same "results come from the
 * database, not in-memory state" invariant with one implementation, not two
 * that could drift. Returns `[]` without querying when `jobIds` is empty —
 * an empty `inArray(...)` is a Drizzle/Postgres edge case worth avoiding
 * explicitly rather than relying on it happening to behave.
 */
/**
 * Job ids among `jobIds` the user has already APPLIED to (ticket 0c319b2).
 * Read-only; this function never writes a status row — recording an
 * application is a user action, not something a scoring run infers.
 *
 * Keyed on `job_id` alone, with no `resume_id` in the query at ALL. That is
 * deliberate and is the whole reason `user_job_statuses` is keyed the way it
 * is (see its comment in db/schema.ts): this lookup happens during a search
 * run, which is scoped to ONE resume — and the resume in hand today is
 * routinely not the resume an application was sent with. Filtering by resume
 * here would make "have I applied to X?" answer "no" the moment the user
 * rewrites her resume, which is exactly the bug the table's key exists to
 * prevent.
 *
 * Only `applied` is excluded, not `dismissed`/`saved`/`resume_optimized` —
 * acting on those is a UI concern and explicitly out of this ticket's scope.
 */
export async function fetchAppliedJobIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  jobIds: string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const rows = await db
    .select({ jobId: userJobStatuses.jobId })
    .from(userJobStatuses)
    .where(and(eq(userJobStatuses.status, "applied"), inArray(userJobStatuses.jobId, jobIds)));
  return new Set(rows.map((r) => r.jobId));
}

async function fetchRankedResults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
  jobIds: string[],
): Promise<RankedResult[]> {
  if (jobIds.length === 0) return [];

  // Ticket 0c319b2. Applied here — on the ranked list every caller renders,
  // shared by the normal run's tail and `estimateOnly`'s early return — and
  // NOT on `candidates`/`needsScoreIds` above (computed earlier in
  // `runDemoMatch`, keyed only on `jobMatches.resumeId`, with no
  // applied-status check). That is a real, accepted tradeoff, not a free
  // lunch: an applied job usually already has a `job_matches` row for the
  // resume that applied to it, but not for every resume — rewrite the
  // resume to a new version and re-search while the job is still open, and
  // it has no row under the new `resumeId`, so it lands in `needsScoreIds`
  // and consumes one real Claude call even though it's already applied to
  // (see `user-job-statuses.test.ts`'s v2MatchForX case, which exercises
  // exactly this). Filtering it out of `needsScoreIds` instead would close
  // that gap, but this ticket's scope is deliberately a small, additive
  // presentation filter — it doesn't thread applied-status into the
  // scoring-decision path, which stays resume-version-agnostic and is
  // shared with ticket aff284b's scoring-loop work. Ingestion and scoring
  // stay complete either way, so the row and its score remain in the
  // database for a future "jobs I applied to" view. This is presentation
  // filtering, not corpus filtering — accept the occasional extra scoring
  // call as the cost of keeping it that way.
  const appliedJobIds = await fetchAppliedJobIds(db, jobIds);

  const rows = await db
    .select({
      jobId: jobsTable.id,
      externalId: jobsTable.externalId,
      title: jobsTable.title,
      company: jobsTable.company,
      location: jobsTable.location,
      locationType: jobsTable.locationType,
      applyUrl: jobsTable.linkToApply,
      matchScore: jobMatches.matchScore,
      rationale: jobMatches.rationale,
      strengths: jobMatches.strengths,
      gaps: jobMatches.gaps,
      levelFit: jobMatches.levelFit,
      levelFitNote: jobMatches.levelFitNote,
    })
    .from(jobMatches)
    .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, jobIds)));

  const results: RankedResult[] = rows
    .filter((r) => !appliedJobIds.has(r.jobId))
    .map((r) => ({
      ...r,
      strengths: r.strengths ?? [],
      gaps: r.gaps ?? [],
      // `levelFit`/`levelFitNote` stay `null` as-is — never coerced (ticket
      // b182bde): unlike strengths/gaps, a `null` here is a real, distinct
      // state ("never judged"), not "the model returned nothing".
    }));
  results.sort(compareRankedResults);
  return results;
}

/**
 * Ticket b182bde: `matchScore DESC` is the whole ranking; `levelFit` is a
 * TIEBREAK ONLY, applied exclusively when two results share the exact same
 * `matchScore` — it must never move a job ahead of one with a strictly
 * higher score (both of Nicole's real applied-to postings are in the
 * "overqualified" bucket; a design that let level fit override the score
 * would have hidden her own real choices). `jobId ASC` as the final
 * tiebreak makes the order fully deterministic — see git-bug b182bde's
 * Context: 21 of 25 displayed jobs were tied on `matchScore` with no
 * secondary sort key at all before this ticket.
 *
 * Duplicates the CASE expression `routes/resumes.ts` builds in SQL for the
 * same ordering — see that file's `levelFitRank` — because this file's
 * `fetchRankedResults` sorts an already-fetched JS array instead of
 * ordering the SQL query itself. Kept in sync by the rank NUMBERS matching
 * (0/1/2/3 below), not by shared code, since one lives in SQL and the other
 * in JS.
 */
function levelFitTiebreakRank(levelFit: LevelFit | null | undefined): number {
  switch (levelFit) {
    case "well_matched":
      return 0;
    case "underqualified":
      return 2;
    case "overqualified":
      return 3;
    default:
      // `null`/`undefined`: an unjudged (legacy, or pre-migration) row.
      // Deliberately BETWEEN well_matched and underqualified, not lumped in
      // with either — an unjudged row is neither known-good nor
      // known-mismatched.
      return 1;
  }
}

export function compareRankedResults(a: RankedResult, b: RankedResult): number {
  if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
  const rankDiff = levelFitTiebreakRank(a.levelFit) - levelFitTiebreakRank(b.levelFit);
  if (rankDiff !== 0) return rankDiff;
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

/**
 * Filters ranked results to exclude jobs below the match score floor
 * (ticket 1b9f81e). Returns both the filtered results and the count of
 * jobs that were below the floor. The floor is a display filter only — the
 * jobs remain persisted in the database with their scores.
 */
export function applyMatchScoreFloor(results: RankedResult[]): {
  displayed: RankedResult[];
  belowFloorCount: number;
} {
  const displayed = results.filter((r) => r.matchScore >= MATCH_SCORE_FLOOR);
  const belowFloorCount = results.length - displayed.length;
  return { displayed, belowFloorCount };
}

export async function runDemoMatch(options: RunDemoMatchOptions): Promise<RunDemoMatchResult> {
  const {
    db,
    sources,
    resumeText,
    scoreJob,
    criteria = {},
    filter = (jobs: NormalizedJob[]) => jobs,
    excludedForMissingWorkArrangement: excludeMissingArrangementFn = () => [],
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    allowAboveThreshold = false,
    usageStatsPath = DEFAULT_USAGE_STATS_PATH,
    outputPath = "prep/match-results.json",
    log = console.log,
    searchId: providedSearchId,
    estimateOnly = false,
    onJobScored,
    onSourceSettled,
  } = options;

  if (sources.length === 0) {
    throw new Error("runDemoMatch: `sources` must contain at least one JobSource.");
  }

  // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
  // db/seed.ts. Ensures the FK from jobs.data_source to
  // source_descriptors doesn't reject the very first insert on a fresh
  // database.
  await seedSourceDescriptors(db);

  // Ticket 7701534: `getOrCreateResumeId` now also reports `isNew`, which
  // only `POST /resumes` (routes/resumes.ts) needs to distinguish "a
  // genuinely new resume" from "this text already belongs to another
  // resume" -- irrelevant here, this CLI/worker path has always treated
  // find-or-create as a single outcome either way.
  const { id: resumeId } = await getOrCreateResumeId(db, resumeText);

  // Ticket 59fdc52 review round 3, N2: the `searches` row (and its
  // `search_sources` links) used to be inserted AFTER fetch+filter below —
  // both of which run arbitrary code (`CompositeSource#search`, and a
  // caller-supplied `filter`) that can reject. If either did, this
  // function's promise rejected before a `searches` row ever existed, so
  // the REST API's `POST /searches` catch handler's `markSearchFailed`
  // (routes/searches.ts) — an `UPDATE searches SET status = 'failed' WHERE
  // id = searchId` — silently matched ZERO rows, and `searchId` (already
  // handed to the client in the 202 response) would 404 forever on a later
  // `GET /searches/:id`, even after a restart, rather than surfacing as
  // "failed". Both `searchId` and `sources` are already known at this
  // point — nothing below needs fetch or filter to have run first — so the
  // row (and its per-source links) are created here instead, before either
  // of those can throw.
  const searchId = providedSearchId ?? randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId, searchedAt: new Date() });
  // One row per CONFIGURED source, not per source that actually returned
  // jobs this run — this records what the search covered; success/failure
  // per source lives in `sourceOutcomes`, not here. `search_sources` has
  // always allowed multiple rows per search (no uniqueness constraint
  // beyond its own id — see db/schema.ts); this is the first ticket that
  // actually inserts more than one.
  await db
    .insert(searchSources)
    .values(sources.map((s) => ({ id: randomUUID(), searchId, sourceDescriptorId: s.dataSource })));

  log(
    `Fetching real postings from ${sources.length} source(s): ` +
      `${sources.map((s) => s.dataSource).join(", ")}...`,
  );
  // CompositeSource isolates one source's total failure from the others —
  // see sources/composite.ts. It deliberately returns one PerSourceOutcome
  // per source rather than one merged SourceSearchResult, for the same
  // reason TokenOutcome (ticket b723fb9) exists one level down: an
  // aggregate number across sources of very different sizes hides exactly
  // which one is unhealthy.
  const perSource = await new CompositeSource(sources).search(criteria, onSourceSettled);

  const found: NormalizedJob[] = [];
  for (const outcome of perSource) {
    if (outcome.status === "ok") {
      found.push(...outcome.result.jobs);
      log(
        `  ${outcome.dataSource}: ${outcome.result.jobs.length} jobs, ` +
          `${outcome.result.skipped.length} skipped (skipRate ${outcome.result.skipRate.toFixed(2)})`,
      );
    } else {
      log(`  ${outcome.dataSource}: FAILED — ${outcome.errorMessage} (other sources unaffected)`);
    }
  }
  log("");

  // NOTE (adversarial review): `filter` now runs over the UNION of every
  // configured source's jobs, not one source's alone. For
  // `filterSoftwareEngineeringJobs` specifically, that means its
  // `${company}|${title}` dedupe (swe-filter.ts) now also collapses an
  // identical (company, title) pair posted to TWO different sources into
  // one survivor — previously impossible with a single source. Likely
  // desirable (the same real opening shouldn't count twice because an
  // employer cross-posts to Greenhouse and Lever), but it's an emergent
  // consequence of merging before filtering, not something this ticket set
  // out to build, and swe-filter.ts itself is unchanged.
  const filtered = filter(found);

  // Ticket 14289ac: the SAME union `filter` just ran over, asked a
  // different question — not "did it survive" but "was it excluded
  // specifically for missing work-arrangement metadata." See
  // `RunDemoMatchOptions.excludedForMissingWorkArrangement`'s doc comment
  // for why this is a separate function rather than something `filter`
  // itself reports.
  const excludedForMetadata = excludeMissingArrangementFn(found);

  // Ticket 16c824a: no `maxJobs`-style truncation here. Every survivor gets
  // ingested and is a scoring CANDIDATE — the old bug was slicing this list
  // to 12 in source/board iteration order before any of it reached the
  // database, so employers late in the token list (Coinbase, Databricks,
  // ...) were never even ingested, let alone scored. The spend guard below
  // (`scoreThreshold`/`allowAboveThreshold`) gates which candidates get
  // SCORED, not which ones get persisted.
  const candidates = filtered;

  const sourceOutcomes = buildSourceOutcomes(
    perSource,
    filtered,
    (message) => log(`  WARNING: ${message}`),
    excludedForMetadata,
  );
  log("  Source coverage:");
  for (const so of sourceOutcomes) {
    log(`    ${so.dataSource}: ${describeSourceOutcome(so)}`);
    for (const b of so.boardCoverage) {
      log(`      ${b.token}: ${describeBoardOutcome(b)}`);
    }
  }
  log("");

  // Group the candidates by each job's OWN `dataSource` — there is no
  // longer one single top-level "the" source to ingest under.
  // `ingestJobsForSearch` upserts on (data_source, external_id) and, per
  // its own doc comment, assumes every job in one call shares the
  // `dataSource` argument passed in; a batch spanning multiple real
  // sources under one label would upsert fine (each NormalizedJob carries
  // its own correct dataSource) but then fail its own post-insert lookup
  // for every job whose real dataSource differs from that one label — see
  // composite.ts's top-of-file comment for the full reasoning. Calling it
  // once per real dataSource sidesteps that entirely.
  //
  // NOTE (adversarial review): this also changes what `ingestJobsForSearch`'s
  // own transaction covers. Its doc comment argues for atomicity ("either
  // every job in this batch ends up inserted and linked, or none of it is")
  // — that guarantee now holds PER SOURCE, not per run: if the Lever call
  // below throws after the Greenhouse call already committed, Greenhouse's
  // jobs stay committed and linked while Lever's are rolled back, not both
  // rolled back together. That's the same one-source-can't-take-down-the-
  // others isolation this ticket applies everywhere else (CompositeSource,
  // SourceOutcome), just worth naming explicitly here since it's a real
  // narrowing of what "atomic" meant before multiple sources existed.
  const candidatesByDataSource = new Map<string, NormalizedJob[]>();
  for (const job of candidates) {
    const list = candidatesByDataSource.get(job.dataSource);
    if (list) list.push(job);
    else candidatesByDataSource.set(job.dataSource, [job]);
  }

  // DEDUPED ACROSS SOURCES, not just concatenated (ticket 78d31b7). One
  // call's own `linkedJobIds` is distinct, but since cross-source duplicate
  // detection landed, a LATER source's call can legitimately return an id
  // an EARLIER source's call already returned - that is exactly what
  // "these two postings are the same job" resolves to. Concatenating would
  // put that id in `linkedJobIds` twice, and everything downstream here
  // (`needsScoreIds`, `toScoreIds`, the `scoreOne` fan-out) is a plain
  // filter over this array, so the job would be sent to Claude twice in one
  // run - paying twice for the duplicate this feature exists to stop. A Set
  // preserves first-seen order, so the deterministic ordering the capping
  // logic relies on is unchanged.
  const linkedJobIdSet = new Set<string>();
  for (const [dataSource, jobsForSource] of candidatesByDataSource) {
    const { linkedJobIds: linked, crossSourceMerges } = await ingestJobsForSearch(
      db,
      searchId,
      dataSource,
      jobsForSource,
    );
    for (const id of linked) linkedJobIdSet.add(id);
    // Ticket 78d31b7 review F2b: a merge silently and permanently removes a
    // posting from this run's results, so say so. Empty in the normal case.
    for (const merge of crossSourceMerges) log(describeCrossSourceMerge(merge));
  }
  const linkedJobIds = [...linkedJobIdSet];

  if (linkedJobIds.length === 0) {
    log("No jobs found.");
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
    await markSearchComplete(db, searchId);
    return {
      resumeId,
      searchId,
      skipped: 0,
      newlyScored: 0,
      failed: 0,
      results: [],
      sourceOutcomes,
      candidatesNeedingScore: 0,
      cappedCount: 0,
      scoreThreshold,
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0,
        probableCostUsd: 0,
        basis: "bootstrap",
      },
    };
  }

  // Map linked job ids back to the NormalizedJob payload a scorer needs
  // (title/description/etc — not stored on job_matches).
  //
  // KEYED BY `jobs.id`, OVER EXACTLY `linkedJobIds` (ticket 78d31b7 review
  // F1). This query used to be scoped to this run's OWN candidates —
  // `dataSource IN (this run's sources) AND external_id IN (this run's
  // externalIds)` — on the assumption that every id `ingestJobsForSearch`
  // returns is one of them. Cross-source duplicate detection broke that
  // assumption: a posting merged into ANOTHER source's row puts THAT row's
  // id in `linkedJobIds`, and that source need not be part of this run at
  // all (not selected this time, its fetch failed, or it has since delisted
  // the posting). The id then had no entry in the map below, and the very
  // next thing that happens to it is `estimateScoringCost` — which threw
  // inside `buildScoringPrompt` on the `undefined`, BEFORE the
  // `estimateOnly` branch, so `POST /searches`, `POST /searches/estimate`
  // and the CLI all failed together, permanently for that resume (the only
  // thing that would clear it is scoring the row that crashes). Selecting
  // by id closes the gap by construction: every `NormalizedJob` field is a
  // real `jobs` column, so any linked row can supply its own payload even
  // when nothing in this run's candidate set describes it.
  //
  // Deliberately not chunked, for the same reason the sibling lookup in
  // ingestJobs.ts isn't: one bound parameter per id, so the ceiling is
  // 65,535 linked jobs in a single run — an order of magnitude past the
  // largest single-source response this repo has seen (4,771, ticket
  // 3067e2c).
  const dbRows = await db
    .select({
      id: jobsTable.id,
      externalId: jobsTable.externalId,
      dataSource: jobsTable.dataSource,
      title: jobsTable.title,
      description: jobsTable.description,
      company: jobsTable.company,
      payType: jobsTable.payType,
      commitment: jobsTable.commitment,
      locationType: jobsTable.locationType,
      location: jobsTable.location,
      linkToApply: jobsTable.linkToApply,
      postedAt: jobsTable.postedAt,
    })
    .from(jobsTable)
    .where(inArray(jobsTable.id, linkedJobIds));
  // A two-level lookup (dataSource -> externalId -> job), not a single
  // joined-string key: with multiple sources in play, two different
  // sources can plausibly reuse the same externalId format (e.g. both hand
  // out small sequential numeric ids), and looking up by externalId alone
  // would silently collide two unrelated jobs from different sources onto
  // the same NormalizedJob.
  const jobByDataSourceAndExternalId = new Map<string, Map<string, NormalizedJob>>();
  for (const j of candidates) {
    let byExternalId = jobByDataSourceAndExternalId.get(j.dataSource);
    if (!byExternalId) {
      byExternalId = new Map();
      jobByDataSourceAndExternalId.set(j.dataSource, byExternalId);
    }
    byExternalId.set(j.externalId, j);
  }
  const normalizedJobById = new Map<string, NormalizedJob>();
  for (const row of dbRows) {
    // Prefer the in-memory candidate when this run actually fetched this
    // row's posting: `ingestJobsForSearch` upserts with ON CONFLICT DO
    // NOTHING, so a row that already existed keeps whatever text it was
    // first ingested with, while the candidate carries what the source is
    // publishing TODAY — which is the fairer thing to score. Falling back
    // to the stored row is what covers the F1 case above, where nothing in
    // this run describes the row at all.
    const nj = jobByDataSourceAndExternalId.get(row.dataSource)?.get(row.externalId);
    normalizedJobById.set(row.id, nj ?? toNormalizedJob(row));
  }

  /**
   * `normalizedJobById.get(id)` with the invariant it relies on stated out
   * loud. Every id in `linkedJobIds` was just SELECTed back out of `jobs`
   * above, so a miss here means a row vanished between the two statements
   * (nothing in this app deletes `jobs` rows) — not the routine
   * "this run didn't fetch that posting" case, which the fallback above
   * now handles. Throwing rather than silently dropping the job: the
   * previous code filtered misses out of `needsScoreJobs` and then used a
   * bare `!` at the cost-estimate call three lines apart, so the same gap
   * quietly under-counted the estimate in one place and crashed with an
   * unreadable TypeError in the other.
   */
  const requireNormalizedJob = (id: string): NormalizedJob => {
    const nj = normalizedJobById.get(id);
    if (!nj) {
      throw new Error(
        `runDemoMatch: no jobs row found for linked job id "${id}" immediately after ` +
          `selecting every linked id back out of the jobs table. This should be impossible.`,
      );
    }
    return nj;
  };

  // Score only what has no score yet for this resume. This is the whole
  // point of ticket 620ca30: a second run against the same candidates must
  // make zero Claude calls.
  const alreadyScoredRows = await db
    .select({ jobId: jobMatches.jobId })
    .from(jobMatches)
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, linkedJobIds)));
  const alreadyScoredIds = new Set(alreadyScoredRows.map((r) => r.jobId));
  const needsScoreIds = linkedJobIds.filter((id) => !alreadyScoredIds.has(id));
  const needsScoreJobs = needsScoreIds.map(requireNormalizedJob);

  // Spend guard (ticket 16c824a). Estimated BEFORE any scoring call is
  // made, over every job that needs a new score — not the whole survivor
  // pool, since already-scored jobs cost nothing to reconfirm (ticket
  // 620ca30).
  const usageStats = readUsageStats(usageStatsPath);
  const preCapEstimate = estimateScoringCost(needsScoreJobs, resumeText, usageStats);
  log(
    `${filtered.length} survivor(s) after filtering; ${needsScoreIds.length} need scoring ` +
      `(${alreadyScoredIds.size} already scored — skipped, saving that many Claude calls).`,
  );
  log(
    `Estimated cost to score all ${needsScoreIds.length}: ${describeCostEstimate(preCapEstimate)}.`,
  );

  // Above `scoreThreshold`, cap SCORING (not ingestion) here unless the
  // caller explicitly opted in — see `DEFAULT_SCORE_THRESHOLD`'s doc
  // comment for precisely what this does and does not truncate, and why a
  // plain rerun drains a bound cap for free. Computed BEFORE the
  // `estimateOnly` check below (ticket 59fdc52 review round 2, "estimate is
  // wrong by ~30x"): a real run never spends more than this cap allows in
  // one call, so an estimate that priced `preCapEstimate` — the FULL
  // uncapped pool — was answering a different question than "what will
  // POST /searches actually bill me". `costEstimate` from here on is
  // cap-aware: exactly what would be attempted (and billed) this run.
  const overThreshold = needsScoreIds.length > scoreThreshold && !allowAboveThreshold;
  const toScoreIds = overThreshold ? needsScoreIds.slice(0, scoreThreshold) : needsScoreIds;
  const cappedCount = needsScoreIds.length - toScoreIds.length;

  const costEstimate = estimateScoringCost(
    toScoreIds.map(requireNormalizedJob),
    resumeText,
    usageStats,
  );

  // Ticket 59fdc52: `estimateOnly` stops HERE, before any `scoreJob` call —
  // fetching and ingestion above already happened (free), but nothing below
  // this point that costs money runs. `costEstimate`/`cappedCount` are the
  // SAME cap-aware numbers a real run would compute (see above) — this is
  // "what would POST /searches actually spend and defer if run right now",
  // not the full pool's price. `results` still comes from the database
  // (decision: "results come from the database, not a run's in-memory
  // state"), scoped to whatever was ALREADY scored before this call — there
  // is nothing newly scored to add to it.
  if (estimateOnly) {
    log(
      `estimateOnly=true — stopping before any scoring call. Nothing new was scored or billed ` +
        `this run.`,
    );
    const fetchedResults = await fetchRankedResults(db, resumeId, [...alreadyScoredIds]);
    const { displayed: results, belowFloorCount } = applyMatchScoreFloor(fetchedResults);
    if (belowFloorCount > 0) {
      log(`${results.length} shown, ${belowFloorCount} below ${MATCH_SCORE_FLOOR}%`);
    }
    await markSearchComplete(db, searchId);
    return {
      resumeId,
      searchId,
      skipped: alreadyScoredIds.size,
      newlyScored: 0,
      failed: 0,
      results,
      sourceOutcomes,
      candidatesNeedingScore: needsScoreIds.length,
      cappedCount,
      scoreThreshold,
      costEstimate,
    };
  }

  log(`Scoring ${toScoreIds.length} of ${linkedJobIds.length} candidates with ${MODEL}...\n`);

  let newlyScoredCount = 0;
  let failedCount = 0;

  if (toScoreIds.length > 0) {
    // Promise.allSettled, not Promise.all: every one of these calls is
    // already billed the moment it resolves or rejects. Promise.all
    // rejects the whole batch on the FIRST failure, which would throw
    // away every fulfilled (paid-for) score alongside the failed one —
    // and because nothing gets persisted, a rerun would re-score (and
    // re-pay for) all of them, including the ones that already succeeded.
    // allSettled keeps every fulfilled result so only the actual failures
    // get retried next time.
    const scoreOne = async (jobId: string): Promise<{ jobId: string } & ScoredJob> => {
      // Should be impossible, and `requireNormalizedJob` says why: every id
      // in `toScoreIds` came from `linkedJobIds`, and `normalizedJobById` is
      // built by selecting every one of those ids back out of `jobs`. (The
      // comment that used to sit here said the map was derived from "this
      // same candidate set" — that stopped being true when cross-source
      // duplicate detection made `ingestJobsForSearch` able to return a row
      // this run never fetched, which is exactly the crash review F1 found.
      // The lookup is now keyed on `jobs.id`, so the invariant holds again.)
      const nj = requireNormalizedJob(jobId);
      const scored = await scoreJob(nj, resumeText);
      // Fired here, not after `Promise.allSettled` below settles: this is
      // what makes the count observable WHILE the run is still in flight
      // (ticket 1998875) rather than only once the whole batch is done —
      // see `onJobScored`'s doc comment on `RunDemoMatchOptions`.
      onJobScored?.();
      return { jobId, ...scored };
    };

    // Ticket aff284b: score the FIRST job alone and await it before firing
    // the rest concurrently — do NOT collapse this back into a single
    // `Promise.allSettled(toScoreIds.map(scoreOne))`. Every call in this
    // loop sends a byte-identical cached prefix (preamble + resume — see
    // makeClaudeScorer), but per Anthropic's own docs (verified live
    // 2026-08-31, platform.claude.com/docs/en/build-with-claude/
    // prompt-caching.md): "a cache entry only becomes available after the
    // first response begins ... If you need cache hits for parallel
    // requests, wait for the first response before sending subsequent
    // requests." Firing every one of `toScoreIds` at once — this loop's
    // shape before this ticket — means none of them can read a cache
    // entry the others are simultaneously racing to write, which would
    // make this entire ticket's saving zero on the real 200-job run it
    // exists for, silently, since `Promise.allSettled` reports only one
    // batch result and never distinguishes "every call missed the cache"
    // from "caching isn't in play." Scoring #1 alone first makes it the
    // run's one cache WRITE; every concurrent call after it is a cache
    // READ. Costs one extra network round trip of latency before the
    // batch starts — real, but negligible next to a 200-call run, and
    // the only way the promised ~25% saving is actually realized instead
    // of merely intended.
    //
    // Cache LIFETIME across a long run (ticket aff284b requirement:
    // "confirm behavior and whether refreshes are automatic") — verified
    // live 2026-09-02, platform.claude.com/docs/en/build-with-claude/
    // prompt-caching.md: "The cache is refreshed for no additional cost
    // each time the cached content is used," measured from the START of
    // each request, not its completion. So every READ automatically
    // extends the 5-minute default TTL for free — no explicit re-warm
    // call needed. In THIS shape that makes the concern close to moot
    // anyway: `restIds` below fires as one concurrent batch immediately
    // after the single warming call above, not job-by-job — every call in
    // a run, including a 200-job one, starts within the same handful of
    // seconds, nowhere near the 5-minute boundary. The auto-refresh matters
    // for a hypothetically slower or more sequential caller of
    // `makeClaudeScorer`; it is not something this run shape currently
    // depends on to stay warm.
    const [firstId, ...restIds] = toScoreIds;
    const settled: PromiseSettledResult<{ jobId: string } & ScoredJob>[] = [
      ...(await Promise.allSettled([scoreOne(firstId)])),
      ...(await Promise.allSettled(restIds.map((jobId) => scoreOne(jobId)))),
    ];

    const newlyScoredRows: Array<{ jobId: string } & ScoredJob> = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        newlyScoredRows.push(result.value);
      } else {
        failedCount++;
        const jobId = toScoreIds[i]!;
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        log(`  FAILED to score job ${jobId}: ${reason} (will retry on the next run)`);
      }
    });
    newlyScoredCount = newlyScoredRows.length;

    if (newlyScoredRows.length > 0) {
      // onConflictDoNothing as defense-in-depth: two runs racing (or a
      // human running the script twice at once) both compute a score for
      // the same job, and the second insert simply no-ops on the
      // (resume_id, job_id) unique constraint instead of erroring or
      // creating a duplicate.
      await db
        .insert(jobMatches)
        .values(
          newlyScoredRows.map((r) => ({
            id: randomUUID(),
            resumeId,
            jobId: r.jobId,
            matchScore: r.matchScore,
            rationale: r.rationale,
            // `ScoredJob.levelFit`/`levelFitNote` are optional on the TYPE
            // only (see that type's doc comment) — a real scorer always
            // sets them (SCHEMA's `required`), so `?? null` here only ever
            // fires for a test fake that omits them, never for a real
            // Claude call.
            levelFit: r.levelFit ?? null,
            levelFitNote: r.levelFitNote ?? null,
            strengths: r.strengths,
            gaps: r.gaps,
          })),
        )
        .onConflictDoNothing({ target: [jobMatches.resumeId, jobMatches.jobId] });
    }

    // Real usage from this run's successful calls feeds next run's cost
    // estimate (ticket 16c824a) — a fake test scorer's rows have no
    // `usage`, so test runs never write to `usageStatsPath`.
    //
    // Deliberately AFTER the `db.insert(jobMatches)` above, and wrapped in
    // try/catch (ticket 16c824a review F1, reproduced live): this used to
    // run BEFORE the insert with nothing guarding it, so an unwritable
    // `usageStatsPath` (missing directory, read-only FS, ENOSPC, EACCES —
    // `runDemoMatch` is exported and a future RabbitMQ scoring worker is a
    // planned second caller with its own cwd) threw and discarded 3 of 3
    // already-PAID-FOR scores along with it — the exact failure mode
    // `Promise.allSettled` above exists to prevent. This write is now
    // strictly best-effort: if it fails, the scores above are already
    // safely in the database and stay there; the only consequence is that
    // the NEXT run's cost estimate falls back to the bootstrap path
    // instead of a measured one.
    const rowsWithUsage = newlyScoredRows.filter(
      (r): r is typeof r & { usage: NonNullable<ScoredJob["usage"]> } => r.usage !== undefined,
    );
    if (rowsWithUsage.length > 0) {
      try {
        recordUsageStats(usageStatsPath, {
          calls: rowsWithUsage.length,
          totalInputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.inputTokens, 0),
          totalOutputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.outputTokens, 0),
          // Ticket aff284b: recorded separately from totalInputTokens so a
          // stats file written before this ticket (which has neither field)
          // is detectably stale and gets discarded rather than blended --
          // see readUsageStats's staleness check. As of review round 4 F3,
          // estimateScoringCost prices cache reads/writes by measuring the
          // CURRENT run's real resume directly rather than reading these
          // fields back out, but they stay recorded: they're the raw data
          // any future recalibration of that estimate would need.
          totalCacheReadTokens: rowsWithUsage.reduce(
            (sum, r) => sum + (r.usage.cacheReadTokens ?? 0),
            0,
          ),
          totalCacheCreationTokens: rowsWithUsage.reduce(
            (sum, r) => sum + (r.usage.cacheCreationTokens ?? 0),
            0,
          ),
        });
      } catch (err) {
        log(
          `  WARNING: failed to record usage stats to "${usageStatsPath}" — the ${rowsWithUsage.length} ` +
            `score(s) above are already persisted and unaffected; only the NEXT run's cost estimate ` +
            `will fall back to the bootstrap path. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  // Cap summary — emitted AFTER scoring, not before (ticket 16c824a review
  // F2): "scored" must be what actually got persisted, not a prediction
  // `Promise.allSettled` could still falsify with a failure. Base is
  // `linkedJobIds.length`, not `filtered.length` — `linkedJobIds.length ===
  // alreadyScoredIds.size + needsScoreIds.length` exactly (every linked id
  // is either already-scored or needs one), and `needsScoreIds.length ===
  // newlyScoredCount + failedCount + cappedCount` exactly (every id sent to
  // `Promise.allSettled` either fulfills or rejects, and every id NOT sent
  // is capped) — so the four numbers below always sum to the total with no
  // unaccounted remainder, unlike the earlier `filtered.length`-based line
  // this replaced.
  if (cappedCount > 0) {
    const nextRerunPicksUp = Math.min(cappedCount, scoreThreshold);
    log(
      `${linkedJobIds.length} candidate(s): ${alreadyScoredIds.size} already scored, ` +
        `${newlyScoredCount} scored this run, ${failedCount} failed, ${cappedCount} not scored (cap). ` +
        `${needsScoreIds.length} jobs needed scoring this run, above the ${scoreThreshold}-job ` +
        `spend-guard threshold (estimated cost of what was actually attempted: ` +
        `${describeCostEstimate(costEstimate)}). A plain rerun with no flags will pick up the next ` +
        `${nextRerunPicksUp} of the remaining ${cappedCount} at no extra cost (already-scored jobs are ` +
        `free — ticket 620ca30); set allowAboveThreshold (or ALLOW_SCORE_ABOVE_THRESHOLD=true for the ` +
        `CLI) to score all ${cappedCount} remaining in this run instead.`,
    );
  }

  // Final results come from the database, not from this run's in-memory
  // scores — so a second run, which scores nothing new, still prints the
  // full ranked list instead of almost nothing.
  const fetchedResults = await fetchRankedResults(db, resumeId, linkedJobIds);
  const { displayed: results, belowFloorCount } = applyMatchScoreFloor(fetchedResults);

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`Full JSON written to ${outputPath}\n`);
  log("─── ranked ───");
  for (const j of results) {
    log(`  ${String(j.matchScore).padStart(3)}%  ${j.title}  —  ${j.company}`);
  }
  if (belowFloorCount > 0) {
    log(`\n${results.length} shown, ${belowFloorCount} below ${MATCH_SCORE_FLOOR}%`);
  }

  await markSearchComplete(db, searchId);

  return {
    resumeId,
    searchId,
    skipped: alreadyScoredIds.size,
    newlyScored: newlyScoredCount,
    failed: failedCount,
    results,
    sourceOutcomes,
    candidatesNeedingScore: needsScoreIds.length,
    cappedCount,
    scoreThreshold,
    costEstimate,
  };
}
