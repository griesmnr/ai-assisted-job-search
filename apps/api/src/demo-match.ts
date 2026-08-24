/**
 * End-to-end vertical slice, real infrastructure underneath.
 *
 *   real job postings  ->  Claude  ->  ranked match scores  ->  Postgres
 *
 * Bypasses the queue and the API, but not the database: the resume, the
 * jobs, and every match score are persisted, so running this twice does
 * not pay Claude twice for identical work (ticket 620ca30). Everything
 * that decides *which* jobs get scored and *how* they get persisted lives
 * in `runDemoMatch`, which takes its dependencies as arguments so tests can
 * inject a fake scorer and a fake source instead of hitting the real
 * Anthropic API or the real USAJOBS/Greenhouse APIs.
 *
 *   npx tsx apps/api/src/demo-match.ts
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { Job } from "@app/shared";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { seedSourceDescriptors } from "./db/seed.js";
import { jobMatches, jobs as jobsTable, resumes, searches, searchSources } from "./db/schema.js";
import { ingestJobsForSearch } from "./ingest/ingestJobs.js";
import { createAshbySourceFromEnv } from "./sources/ashby.js";
import { CompositeSource, type PerSourceOutcome } from "./sources/composite.js";
import { createGreenhouseSourceFromEnv } from "./sources/greenhouse.js";
import { createLeverSourceFromEnv } from "./sources/lever.js";
import { createSmartRecruitersSourceFromEnv } from "./sources/smartrecruiters.js";
import { filterSoftwareEngineeringJobs } from "./sources/swe-filter.js";
import type { JobSource, NormalizedJob, SearchCriteria, TokenOutcome } from "./sources/types.js";

process.loadEnvFile();

/**
 * Scoring model. Chosen by Nicole 2026-08-22 on the evidence of the A/B in
 * `model-ab.ts`, which re-scored the same real jobs against the same real
 * resume with both models: sonnet produced the same #1, the same top-5 set,
 * and the same overall ordering as opus for roughly 40% less. That was a
 * defensible-either-way call at 13 candidates; at 130 (ticket b723fb9 took
 * the funnel from 545 postings to 6,038) the cost difference stops being
 * theoretical.
 *
 * Note this makes new scores not strictly comparable to the opus-scored
 * rows already in `job_matches` — including the 72% and 74% Nicole applied
 * to. The A/B says the *ranking* agrees, which is what the shortlist
 * actually consumes, so mixed scales are acceptable here; re-scoring
 * history to match would cost more than the inconsistency does.
 * Re-run `model-ab.ts` before changing this again.
 */
export const MODEL = "claude-sonnet-5";

/**
 * Hard cap on the scorer's own response size — the JSON schema below is
 * small (a score, a rationale, two short string arrays), so this is rarely
 * actually reached, but it's the real, code-enforced upper bound on output
 * tokens per call and is reused below as the worst-case input to
 * `estimateScoringCost`'s bootstrap path.
 */
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Spend-guard threshold (ticket 16c824a) — replaces `MAX_JOBS`, which used
 * to silently slice the shortlist to 12 in board-iteration order. That was
 * the bug: it went uncaught for two funnel-widening tickets (545 -> 6,038
 * -> 11,609 postings) because nothing measured or reported the truncation.
 *
 * This constant is NOT a truncation-by-order cap — `runDemoMatch` no longer
 * has one of those at all; every survivor gets ingested and is eligible to
 * be scored. It is a SPEND guard: above this many jobs actually needing a
 * *new* score in one run (already-scored jobs are free — ticket 620ca30),
 * scoring stops at the threshold and says so explicitly
 * (`"N survivors, THRESHOLD scored, M not scored (cap)"`) instead of
 * quietly spending more than expected. Scoring the rest requires explicit
 * opt-in (`allowAboveThreshold` / `ALLOW_SCORE_ABOVE_THRESHOLD=true`).
 *
 * Pool size this assumes: comfortably under a few hundred jobs needing a
 * new score per run. 129 total survivors (Greenhouse only) was the
 * measurement that motivated "score everything" over a cleverer selection
 * heuristic (git-bug 16c824a). Ticket 8d3f4a1 wires Lever, Ashby, and
 * SmartRecruiters into the same search and may grow the pool by an unknown
 * multiple — SmartRecruiters alone lists 4,771 postings for ONE company
 * before filtering. If real runs start landing above this threshold
 * routinely, that is this exact ticket's original bug recurring at 10x the
 * scale, pointed at the bank account instead of at coverage — raise (or
 * rethink) this number deliberately, don't just flip the opt-in on
 * permanently.
 */
export const DEFAULT_SCORE_THRESHOLD = 200;

const SCHEMA = {
  type: "object",
  properties: {
    matchScore: {
      type: "integer",
      description: "0-100. How well this candidate matches this posting.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences. What lines up, and what is missing.",
    },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["matchScore", "rationale", "strengths", "gaps"],
  additionalProperties: false,
};

/**
 * What a scorer produces. `matchScore` and `rationale` are the two columns
 * `job_matches` always had; `strengths`/`gaps` are the discrete objections
 * a screener would raise — the highest-signal part of what the model
 * actually returns, and the marginal cost of asking for them is zero (the
 * call is already made). They're persisted as `jsonb` columns so a second
 * run's database-backed results carry them too, not just the run that
 * originally scored the job.
 */
export type ScoredJob = {
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
  /**
   * Real token usage for this call, when the scorer can report it — the
   * live Claude scorer below always can (`response.usage`). Used only to
   * update the on-disk usage stats that back `estimateScoringCost`'s spend
   * guard (ticket 16c824a); never persisted to `job_matches`. Optional so
   * every existing `ScoreJobFn` fake (demo-match.test.ts) keeps compiling
   * unchanged — a fake scorer has no real usage to report.
   */
  usage?: { inputTokens: number; outputTokens: number };
};

/** Injectable so tests can assert call counts without spending real Claude
 * tokens (or requiring `ANTHROPIC_API_KEY`) and without needing a resume
 * closed over module state. */
export type ScoreJobFn = (job: NormalizedJob, resumeText: string) => Promise<ScoredJob>;

/**
 * The exact prompt text a real scoring call sends. Extracted so
 * `estimateScoringCost` can measure the REAL character count of what would
 * actually be sent — not a guessed per-job token figure — for its bootstrap
 * estimate (see that function's doc comment).
 */
export function buildScoringPrompt(job: NormalizedJob, resumeText: string): string {
  return [
    "Score how well this candidate matches this job posting.",
    "Be honest and calibrated — most candidates are not a 90.",
    "",
    "=== RESUME ===",
    resumeText,
    "",
    "=== JOB POSTING ===",
    `Title: ${job.title}`,
    `Employer: ${job.company}`,
    `Location: ${job.location ?? "not stated"} (${job.locationType})`,
    `Type: ${job.payType}, ${job.commitment}`,
    "",
    job.description.slice(0, 6000),
  ].join("\n");
}

export function makeClaudeScorer(anthropic: Anthropic): ScoreJobFn {
  return async function scoreJob(job: NormalizedJob, resumeText: string): Promise<ScoredJob> {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: buildScoringPrompt(job, resumeText) }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block returned");
    const parsed = JSON.parse(text.text) as Omit<ScoredJob, "usage">;
    return {
      ...parsed,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  };
}

/**
 * $/million tokens for `MODEL` (claude-sonnet-5) — mirrors model-ab.ts's own
 * `PRICING` table for the same model. Duplicated rather than imported:
 * model-ab.ts reads `prep/resume.txt` and constructs an `Anthropic` client
 * at MODULE LOAD time (not inside its `main()`), so importing it here would
 * make every test — and every non-scoring code path — depend on that file
 * existing and `ANTHROPIC_API_KEY` being set. Same reason
 * `filterSoftwareEngineeringJobs` lives in swe-filter.ts instead of here;
 * see the re-export comment near the bottom of this file.
 */
const SONNET_PRICE_PER_MILLION_TOKENS = { in: 3, out: 15 };

/**
 * ~4 characters per token is the standard rough estimate for English text
 * (the same figure both OpenAI's and Anthropic's own tokenizer guidance
 * cite) — used only to convert a REAL character count (this run's actual
 * prompt text, built by the same `buildScoringPrompt` the live scorer
 * sends) into an estimated token count. Only the conversion ratio is
 * approximate; the character counts it's applied to are exact, not
 * guessed.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Running totals of REAL per-call token usage, accumulated across live
 * runs (see `recordUsageStats` / the end of the scoring loop in
 * `runDemoMatch`). Read back by `estimateScoringCost` so the pre-scoring
 * cost estimate is grounded in what scoring actually cost last time, not a
 * one-off guess. `calls` counts real Claude calls only — a fake test
 * scorer's `ScoredJob` has no `usage`, so test runs never pollute this.
 */
export type UsageStats = {
  calls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};

/**
 * Reads previously recorded usage stats. Returns `undefined` — not a
 * thrown error — when the file is missing (every project's very first
 * scoring run, or a fresh checkout) or unparseable: a stats file existing
 * is an optimization for the cost estimate, never a precondition for
 * scoring to work.
 */
export function readUsageStats(path: string): UsageStats | undefined {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    if (
      typeof parsed.calls === "number" &&
      typeof parsed.totalInputTokens === "number" &&
      typeof parsed.totalOutputTokens === "number" &&
      parsed.calls > 0
    ) {
      return parsed as UsageStats;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Merges `added` real usage into whatever `readUsageStats(path)` currently
 * holds (treating a missing/corrupt file as zero) and writes the result
 * back — the running average `estimateScoringCost` reads next run. */
export function recordUsageStats(
  path: string,
  added: { calls: number; totalInputTokens: number; totalOutputTokens: number },
): void {
  if (added.calls === 0) return;
  const prior = readUsageStats(path) ?? { calls: 0, totalInputTokens: 0, totalOutputTokens: 0 };
  const next: UsageStats = {
    calls: prior.calls + added.calls,
    totalInputTokens: prior.totalInputTokens + added.totalInputTokens,
    totalOutputTokens: prior.totalOutputTokens + added.totalOutputTokens,
  };
  fs.writeFileSync(path, JSON.stringify(next, null, 2));
}

export type CostEstimate = {
  jobCount: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  /**
   * "measured": both averages come from `usageStats` — real recorded calls
   * from a prior run. "bootstrap": no recorded calls exist yet, so input is
   * estimated from THIS run's real prompt character counts (see
   * `CHARS_PER_TOKEN_ESTIMATE`) and output assumes the worst case,
   * `MAX_OUTPUT_TOKENS` per job (the model's actual hard cap) — real
   * numbers from this codebase, never an invented per-job dollar figure.
   */
  basis: "measured" | "bootstrap";
};

/**
 * Estimates the cost of scoring `jobsToScore`, before any of those calls
 * are made (ticket 16c824a). Prefers `usageStats` — real, measured
 * input/output token averages recorded from this project's own prior live
 * runs (see `recordUsageStats`) — over the bootstrap path, which still
 * grounds itself in real numbers (this run's actual prompt text, and the
 * code's own `max_tokens` cap) rather than an arbitrary guess.
 */
export function estimateScoringCost(
  jobsToScore: NormalizedJob[],
  resumeText: string,
  usageStats: UsageStats | undefined,
  pricePerMillionTokens: { in: number; out: number } = SONNET_PRICE_PER_MILLION_TOKENS,
): CostEstimate {
  const jobCount = jobsToScore.length;
  const basis: CostEstimate["basis"] =
    usageStats && usageStats.calls > 0 ? "measured" : "bootstrap";

  if (jobCount === 0) {
    return {
      jobCount: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      basis,
    };
  }

  let estimatedInputTokens: number;
  let estimatedOutputTokens: number;
  if (basis === "measured") {
    const avgInputTokens = usageStats!.totalInputTokens / usageStats!.calls;
    const avgOutputTokens = usageStats!.totalOutputTokens / usageStats!.calls;
    estimatedInputTokens = Math.round(avgInputTokens * jobCount);
    estimatedOutputTokens = Math.round(avgOutputTokens * jobCount);
  } else {
    const totalPromptChars = jobsToScore.reduce(
      (sum, job) => sum + buildScoringPrompt(job, resumeText).length,
      0,
    );
    estimatedInputTokens = Math.round(totalPromptChars / CHARS_PER_TOKEN_ESTIMATE);
    estimatedOutputTokens = MAX_OUTPUT_TOKENS * jobCount;
  }

  const estimatedCostUsd =
    (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
    (estimatedOutputTokens / 1e6) * pricePerMillionTokens.out;

  return { jobCount, estimatedInputTokens, estimatedOutputTokens, estimatedCostUsd, basis };
}

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
   * Spend guard (ticket 16c824a). Above this many jobs actually NEEDING a
   * new score this run (already-scored jobs are free — ticket 620ca30),
   * scoring stops here unless `allowAboveThreshold` is set — see
   * `DEFAULT_SCORE_THRESHOLD`'s doc comment for the pool-size assumption
   * and why it isn't a `maxJobs`-style truncation. Defaults to
   * `DEFAULT_SCORE_THRESHOLD`.
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
   * `"prep/scoring-usage-stats.json"` — deliberately a different file from
   * `outputPath` (`prep/match-results.json`), which holds ranked results a
   * user may have already applied from and must never be touched by this.
   */
  usageStatsPath?: string;
  outputPath?: string;
  log?: (message: string) => void;
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
export type BoardCoverageEntry = TokenOutcome & { survivedFilter: number };

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
  /** The pre-scoring cost estimate computed for whatever was actually
   * attempted this run (i.e. after any cap) — see `estimateScoringCost`. */
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
 * Rather than pretend the correlation is exact, this function runs two
 * cheap sanity checks over its own output and calls `warn` when either
 * fires, instead of silently returning numbers that may misattribute
 * survivors between boards:
 *
 *   1. `sum(survivedFilter)` across every returned entry should equal
 *      `filtered.length` — every survivor should be attributed to exactly
 *      one token. A mismatch PROVES some misattribution happened
 *      (over-counted somewhere, under-counted somewhere, or both), but a
 *      MATCHING sum does not prove there was none: errors can cancel. Two
 *      tokens sharing a name can double-count 2 survivors up to 4 while a
 *      third, nameless token under-counts its own 2 down to 0 — sum stays
 *      right (4) while every individual number is wrong. That's what
 *      check 2 is for.
 *   2. Two or more entries reporting the identical `companyName`
 *      (case-insensitively) are flagged directly — this is exactly the
 *      double-counting hazard, caught independent of whether the sum
 *      happens to net out.
 *
 * Neither check proves the report is correct; both together catch every
 * hazard this function's own review turned up. A board that's actually
 * healthy must never silently read as "0 survived filtering" (that reads
 * as dead and is exactly what gets a productive token deleted) without at
 * least a `warn` alongside it.
 */
export function buildBoardCoverage(
  tokenOutcomes: TokenOutcome[] | undefined,
  filtered: NormalizedJob[],
  warn: (message: string) => void = (message) => console.warn(message),
): BoardCoverageEntry[] {
  if (!tokenOutcomes || tokenOutcomes.length === 0) return [];

  const survivedByCompany = new Map<string, number>();
  for (const job of filtered) {
    const key = job.company.trim().toLowerCase();
    survivedByCompany.set(key, (survivedByCompany.get(key) ?? 0) + 1);
  }

  const coverage = tokenOutcomes.map((outcome) => ({
    ...outcome,
    survivedFilter: outcome.companyName
      ? (survivedByCompany.get(outcome.companyName.trim().toLowerCase()) ?? 0)
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
        `(${[...duplicateNames].join(", ")}) — each such token's survivedFilter counts every ` +
        `survivor attributed to that name, so they are almost certainly double-counted between ` +
        `those tokens specifically, regardless of whether the totals above happened to match.`,
    );
  }

  return coverage;
}

/**
 * The one-line-per-board summary ticket b723fb9 exists to make possible:
 * outcomes that used to all look like "nothing from this employer" now
 * read as distinct, specific problems.
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
    case "ok":
      return `${entry.postingCount} posting(s), ${entry.survivedFilter} survived filtering`;
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
        errorMessage: outcome.errorMessage,
        boardCoverage: [],
      };
    }

    const { result } = outcome;
    const filteredForSource = filtered.filter((j) => j.dataSource === outcome.dataSource);

    return {
      dataSource: outcome.dataSource,
      status: result.jobs.length === 0 ? "empty" : "ok",
      jobsFound: result.jobs.length,
      skippedCount: result.skipped.length,
      skipRate: result.skipRate,
      survivedFilter: filteredForSource.length,
      errorMessage: undefined,
      boardCoverage: buildBoardCoverage(result.tokenOutcomes, filteredForSource, warn),
    };
  });
}

/**
 * The one-line-per-source summary parallel to `describeBoardOutcome` — see
 * `SourceOutcome`'s doc comment for why the vocabulary mirrors
 * `TokenStatus` one level up.
 */
export function describeSourceOutcome(entry: SourceOutcome): string {
  switch (entry.status) {
    case "error":
      return `${entry.errorMessage ?? "search failed (unknown error)"} — rerun to retry`;
    case "empty":
      return "0 postings returned this run";
    case "ok":
      return (
        `${entry.jobsFound} posting(s), ${entry.skippedCount} skipped ` +
        `(skipRate ${entry.skipRate.toFixed(2)}), ${entry.survivedFilter} survived filtering`
      );
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
async function getOrCreateResumeId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeText: string,
): Promise<string> {
  const resumeHash = hashResumeText(resumeText);

  await db
    .insert(resumes)
    .values({ id: randomUUID(), resumeText, resumeHash })
    .onConflictDoNothing({ target: resumes.resumeHash });

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
  return rows[0]!.id;
}

export async function runDemoMatch(options: RunDemoMatchOptions): Promise<RunDemoMatchResult> {
  const {
    db,
    sources,
    resumeText,
    scoreJob,
    criteria = {},
    filter = (jobs: NormalizedJob[]) => jobs,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    allowAboveThreshold = false,
    usageStatsPath = "prep/scoring-usage-stats.json",
    outputPath = "prep/match-results.json",
    log = console.log,
  } = options;

  if (sources.length === 0) {
    throw new Error("runDemoMatch: `sources` must contain at least one JobSource.");
  }

  // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
  // db/seed.ts. Ensures the FK from jobs.data_source to
  // source_descriptors doesn't reject the very first insert on a fresh
  // database.
  await seedSourceDescriptors(db);

  const resumeId = await getOrCreateResumeId(db, resumeText);

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
  const perSource = await new CompositeSource(sources).search(criteria);

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

  // Ticket 16c824a: no `maxJobs`-style truncation here. Every survivor gets
  // ingested and is a scoring CANDIDATE — the old bug was slicing this list
  // to 12 in source/board iteration order before any of it reached the
  // database, so employers late in the token list (Coinbase, Databricks,
  // ...) were never even ingested, let alone scored. The spend guard below
  // (`scoreThreshold`/`allowAboveThreshold`) gates which candidates get
  // SCORED, not which ones get persisted.
  const candidates = filtered;

  const sourceOutcomes = buildSourceOutcomes(perSource, filtered, (message) =>
    log(`  WARNING: ${message}`),
  );
  log("  Source coverage:");
  for (const so of sourceOutcomes) {
    log(`    ${so.dataSource}: ${describeSourceOutcome(so)}`);
    for (const b of so.boardCoverage) {
      log(`      ${b.token}: ${describeBoardOutcome(b)}`);
    }
  }
  log("");

  const searchId = randomUUID();
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

  const linkedJobIds: string[] = [];
  for (const [dataSource, jobsForSource] of candidatesByDataSource) {
    const { linkedJobIds: linked } = await ingestJobsForSearch(
      db,
      searchId,
      dataSource,
      jobsForSource,
    );
    linkedJobIds.push(...linked);
  }

  if (linkedJobIds.length === 0) {
    log("No jobs found.");
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
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
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        basis: "bootstrap",
      },
    };
  }

  // Map linked job ids back to the NormalizedJob payload a scorer needs
  // (title/description/etc — not stored on job_matches). Looked up by
  // (dataSource, externalId) TOGETHER — see the two-level map built below.
  const dbRows = await db
    .select({
      id: jobsTable.id,
      externalId: jobsTable.externalId,
      dataSource: jobsTable.dataSource,
    })
    .from(jobsTable)
    .where(
      and(
        inArray(jobsTable.dataSource, [...candidatesByDataSource.keys()]),
        inArray(
          jobsTable.externalId,
          candidates.map((j) => j.externalId),
        ),
      ),
    );
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
    const nj = jobByDataSourceAndExternalId.get(row.dataSource)?.get(row.externalId);
    if (nj) normalizedJobById.set(row.id, nj);
  }

  // Score only what has no score yet for this resume. This is the whole
  // point of ticket 620ca30: a second run against the same candidates must
  // make zero Claude calls.
  const alreadyScoredRows = await db
    .select({ jobId: jobMatches.jobId })
    .from(jobMatches)
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, linkedJobIds)));
  const alreadyScoredIds = new Set(alreadyScoredRows.map((r) => r.jobId));
  const needsScoreIds = linkedJobIds.filter((id) => !alreadyScoredIds.has(id));
  const needsScoreJobs = needsScoreIds
    .map((id) => normalizedJobById.get(id))
    .filter((nj): nj is NormalizedJob => nj !== undefined);

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
    `Estimated cost to score all ${needsScoreIds.length}: ~$${preCapEstimate.estimatedCostUsd.toFixed(2)} ` +
      `(~${preCapEstimate.estimatedInputTokens} in / ~${preCapEstimate.estimatedOutputTokens} out tokens, ` +
      `${preCapEstimate.basis} estimate).`,
  );

  // Above `scoreThreshold`, cap here rather than score everything, unless
  // the caller explicitly opted in. This is NOT the old `MAX_JOBS` bug
  // resurfacing: it only ever binds above a few hundred jobs actually
  // needing a score, it is reported plainly (never silent), and it exists
  // purely to guard spend — see DEFAULT_SCORE_THRESHOLD's doc comment.
  const overThreshold = needsScoreIds.length > scoreThreshold && !allowAboveThreshold;
  const toScoreIds = overThreshold ? needsScoreIds.slice(0, scoreThreshold) : needsScoreIds;
  const cappedCount = needsScoreIds.length - toScoreIds.length;

  if (cappedCount > 0) {
    // Literal format ticket 16c824a asks for — a truncated run must never
    // read like a complete one.
    log(
      `${filtered.length} survivors, ${toScoreIds.length} scored, ${cappedCount} not scored (cap). ` +
        `${needsScoreIds.length} jobs need scoring, above the ${scoreThreshold}-job spend-guard threshold. ` +
        `Set allowAboveThreshold (or ALLOW_SCORE_ABOVE_THRESHOLD=true for the CLI) to score all ` +
        `${needsScoreIds.length} on the next run.`,
    );
  }

  const costEstimate = estimateScoringCost(
    toScoreIds.map((id) => normalizedJobById.get(id)!),
    resumeText,
    usageStats,
  );

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
    const settled = await Promise.allSettled(
      toScoreIds.map(async (jobId) => {
        const nj = normalizedJobById.get(jobId);
        if (!nj) {
          // Should be impossible: every id in toScoreIds came from
          // linkedJobIds, which ingestJobsForSearch derived from this
          // same candidate set.
          throw new Error(`runDemoMatch: no NormalizedJob found for linked job id "${jobId}"`);
        }
        const scored = await scoreJob(nj, resumeText);
        return { jobId, ...scored };
      }),
    );

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

    // Real usage from this run's successful calls feeds next run's cost
    // estimate (ticket 16c824a) — a fake test scorer's rows have no
    // `usage`, so test runs never write to `usageStatsPath`.
    const rowsWithUsage = newlyScoredRows.filter(
      (r): r is typeof r & { usage: NonNullable<ScoredJob["usage"]> } => r.usage !== undefined,
    );
    if (rowsWithUsage.length > 0) {
      recordUsageStats(usageStatsPath, {
        calls: rowsWithUsage.length,
        totalInputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.inputTokens, 0),
        totalOutputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.outputTokens, 0),
      });
    }

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
            strengths: r.strengths,
            gaps: r.gaps,
          })),
        )
        .onConflictDoNothing({ target: [jobMatches.resumeId, jobMatches.jobId] });
    }
  }

  // Final results come from the database, not from this run's in-memory
  // scores — so a second run, which scores nothing new, still prints the
  // full ranked list instead of almost nothing.
  const finalRows = await db
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
    })
    .from(jobMatches)
    .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, linkedJobIds)));

  const results: RankedResult[] = finalRows.map((r) => ({
    ...r,
    strengths: r.strengths ?? [],
    gaps: r.gaps ?? [],
  }));
  results.sort((a, b) => b.matchScore - a.matchScore);

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`Full JSON written to ${outputPath}\n`);
  log("─── ranked ───");
  for (const j of results) {
    log(`  ${String(j.matchScore).padStart(3)}%  ${j.title}  —  ${j.company}`);
  }

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
    costEstimate,
  };
}

// ---------------------------------------------------------------------------
// Shortlist filter for the real Greenhouse-backed run below. Moved to
// sources/swe-filter.ts (ticket b723fb9 review fix #3) so
// check-greenhouse-board.ts can reuse the exact same filter without pulling
// in this file's much heavier import graph (Drizzle, `pg`, the Anthropic
// SDK, and the top-level `process.loadEnvFile()` call a few lines up, which
// throws if no `.env` exists) — see that file's doc comment for the full
// reasoning. Re-exported here (imported above) so every existing import of
// `filterSoftwareEngineeringJobs` from "./demo-match.js" keeps working
// unchanged.
// ---------------------------------------------------------------------------
export { filterSoftwareEngineeringJobs };

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const resumeText = fs.readFileSync("prep/resume.txt", "utf8");
  const anthropic = new Anthropic();

  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();
  const db = drizzle(client);

  // Employer lists are configuration (GREENHOUSE_BOARD_TOKENS,
  // LEVER_COMPANIES, ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES — .env),
  // not literals here (ticket b723fb9, extended to all four sources by
  // ticket d8417b2) — see .env.example for the documented default lists
  // and apps/api/src/scripts/check-{greenhouse,lever,ashby,smartrecruiters}
  // -board.ts for how each was verified before being added.
  //
  // Each `createXSourceFromEnv()` throws synchronously if ITS OWN env var
  // isn't set (a deliberate per-source design — see each function's doc
  // comment). Built independently and caught individually here, not as one
  // block, so Nicole not having gotten around to configuring (say) Lever
  // yet doesn't prevent Greenhouse/Ashby/SmartRecruiters from searching —
  // the same "one source's problem can't take the others down" principle
  // `CompositeSource` applies at request time, applied here at
  // configuration time too. Only "literally nothing is configured" is
  // treated as fatal, below.
  const sourceBuilders: Array<{ name: string; build: () => JobSource }> = [
    { name: "greenhouse", build: createGreenhouseSourceFromEnv },
    { name: "lever", build: createLeverSourceFromEnv },
    { name: "ashby", build: createAshbySourceFromEnv },
    { name: "smartrecruiters", build: createSmartRecruitersSourceFromEnv },
  ];
  const sources: JobSource[] = [];
  for (const { name, build } of sourceBuilders) {
    try {
      sources.push(build());
    } catch (err) {
      console.warn(`Skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(
      "No job sources are configured. Set at least one of GREENHOUSE_BOARD_TOKENS, " +
        "LEVER_COMPANIES, ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES in .env — see .env.example.",
    );
  }

  try {
    // No location/keyword in `criteria`: every one of these adapters has
    // no (or only partial) server-side query support and substring-matches
    // criteria.location against the board's raw location string, which
    // would incorrectly reject "Remote - US" / "Seattle, WA" / "Bellevue"
    // postings that `filterSoftwareEngineeringJobs` (title + location
    // regex + dedupe) is specifically written to keep.
    // Spend-guard opt-in (ticket 16c824a): unset/anything-but-"true" means
    // a pool needing more than DEFAULT_SCORE_THRESHOLD new scores gets
    // capped at the threshold this run, reported plainly, and requires this
    // env var on a subsequent run to score the rest.
    const allowAboveThreshold = process.env.ALLOW_SCORE_ABOVE_THRESHOLD === "true";

    const result = await runDemoMatch({
      db,
      sources,
      resumeText,
      scoreJob: makeClaudeScorer(anthropic),
      criteria: {},
      filter: filterSoftwareEngineeringJobs,
      allowAboveThreshold,
    });

    if (result.cappedCount > 0) {
      console.error(
        `${result.cappedCount} job(s) needing a score were NOT scored this run because the spend-guard ` +
          `threshold applied. Set ALLOW_SCORE_ABOVE_THRESHOLD=true and re-run to score the rest.`,
      );
    }
    if (result.failed > 0) {
      console.error(
        `${result.failed} of ${result.failed + result.newlyScored} scoring call(s) failed this run ` +
          `(they will be retried, not re-billed, on the next run).`,
      );
    }
    if (isTotalScoringFailure(result)) {
      console.error(
        `All ${result.failed} scoring call(s) attempted this run failed and none succeeded — treating this as a failed run.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
