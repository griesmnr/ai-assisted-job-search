/**
 * Re-scores an EXISTING resume's already-scored `job_matches` rows against
 * the CURRENT shipped scoring schema (ticket 45e238e, requested directly by
 * Nicole: "I have a bunch of jobs that I intend to apply for... could we
 * rescore them with the new thing [level-fit, ticket b182bde]?").
 *
 * Distinct from `validate-level-fit.ts` (ticket d8746eb) in the one way that
 * makes this script simpler: that script validated the SCHEMA CHANGE itself
 * against a historical corpus whose job descriptions were never persisted,
 * so it had to live-re-fetch every posting before it could re-score
 * anything. This script re-scores real rows that are still IN the database
 * right now -- `jobs.description` is `text(...).notNull()` (db/schema.ts),
 * confirmed already stored from original ingestion -- so there is no live
 * re-fetch step at all: the SAME resume text is re-run against the
 * ALREADY-STORED job description through the CURRENT shipped scoring call,
 * and the result overwrites the existing `job_matches` row in place.
 *
 * SAFETY GATE (copied closely from `validate-level-fit.ts` -- ticket
 * d8746eb, itself refined across two real adversarial review rounds focused
 * specifically on preventing overspend, so its shape is trustworthy rather
 * than reinvented here):
 *
 *   - DRY RUN is the default. No flags at all prints the real job count and
 *     a real, grounded cost estimate, then stops before any Anthropic call.
 *   - `--live` is required to actually spend. Any OTHER argument (a typo,
 *     an unrecognized flag) is a hard error -- this script refuses to guess
 *     which mode was meant rather than silently defaulting one way or the
 *     other.
 *   - `resumeId` is a REQUIRED positional argument, never guessed as "the
 *     most recently used resume" -- operating on the wrong resume's data by
 *     accident would silently overwrite real match history for a resume
 *     Nicole did not intend to touch.
 *   - `MAX_ESTIMATED_SPEND_USD` is a hard ceiling, checked against the
 *     estimate's genuine WORST CASE (`CostEstimate.maxCostUsd` -- every job
 *     priced at `MAX_OUTPUT_TOKENS`, the model's real, code-enforced output
 *     cap) even with `--live`. Defaults conservatively to $5 -- this
 *     sandbox has no way to know Nicole's real job count (her data lives on
 *     her own machine only), so this is a starting point, not a measured
 *     figure; raise it deliberately in this file if a real batch needs a
 *     higher ceiling.
 *
 * NO NEW SCORING LOGIC: `makeClaudeScorer(anthropic)` (imported from
 * demo-match.ts) is called DIRECTLY, unmodified -- the exact same function
 * `runDemoMatch`'s real scoring path uses, with the exact same `SCHEMA`/
 * `SCORING_PREAMBLE`/`MODEL`/`MAX_OUTPUT_TOKENS` baked into it. This script
 * has no scoring call of its own to drift from what's actually shipped.
 * Likewise, the cost estimate reuses `estimateScoringCost`/
 * `describeCostEstimate`/`readUsageStats` directly rather than re-deriving a
 * second, parallel cost formula -- unlike `validate-level-fit.ts`, which
 * genuinely needed its OWN cost math for a two-arm A/B comparison, this
 * script re-scores under a SINGLE schema (the current one), so the
 * production single-arm estimator is exactly the right tool, not a
 * simplification of it.
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database and API key --
 * this never runs in CI or in the sandbox this ticket was implemented in):
 *
 *   npx tsx apps/api/src/scripts/rescore-existing-matches.ts <resumeId>          # DRY RUN, no spend
 *   npx tsx apps/api/src/scripts/rescore-existing-matches.ts <resumeId> --live   # the real, billed run
 *
 * Dismissed jobs are excluded by default (ticket ccc3d6e -- real spend on a
 * job you've already rejected is pure waste); add --include-dismissed to
 * rescore them too.
 *
 * Find your resumeId with, e.g.: `SELECT id FROM resumes;` against your own
 * database (docker-compose's Postgres) -- there is deliberately no "most
 * recent" auto-detection here (see the safety-gate note above).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LevelFit } from "@app/shared";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  describeCostEstimate,
  estimateScoringCost,
  makeClaudeScorer,
  readUsageStats,
  recordUsageStats,
  toNormalizedJob,
  type CostEstimate,
  type JobDescriptionRow,
  type ScoredJob,
} from "../matching/index.js";
import { jobMatches, jobs as jobsTable, resumes, userJobStatuses } from "../db/schema.js";
import { loadEnvFile } from "../load-env.js";

loadEnvFile();

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

/** Same real historical usage-stats file `readUsageStats` (demo-match.ts)
 * already reads and `runDemoMatch` already writes to after every live run --
 * reused here unmodified so this script's "measured" cost basis is grounded
 * in the SAME real per-call averages production scoring itself trusts, not
 * a second, parallel figure. Falls back to `estimateScoringCost`'s own
 * schema-grounded "bootstrap" basis (see that function's doc comment) when
 * this file doesn't exist yet -- e.g. a fresh checkout that has never run a
 * live scoring call. */
export const USAGE_STATS_PATH = "prep/scoring-usage-stats.json";

/** Directory the per-run report is written into -- same `prep/` directory
 * `validate-level-fit.ts`'s own report/snapshot files already live in
 * (gitignored: this is personal job-search content, never checked in).
 * Relative to the process's cwd, matching `validate-level-fit.ts`'s own
 * `REPORT_PATH`/`CORPUS_PATH`/etc. convention exactly -- that file does not
 * resolve these relative to `import.meta.url` either, so both scripts are
 * equally cwd-sensitive by the same established convention (run from the
 * repo root, per both files' own "Usage" doc comments). `main()` creates
 * this directory (`fs.mkdirSync(REPORT_DIR, {recursive: true})`) before the
 * scoring loop starts, so a fresh worktree/checkout or a different-cwd
 * invocation fails LOUDLY before any spend, not with an ENOENT thrown only
 * after every job has already been scored and billed. */
export const REPORT_DIR = "prep";

/**
 * Hard ceiling on the cost estimate computed in `main()`: if
 * `estimateScoringCost`'s real, grounded `maxCostUsd` (the genuine worst
 * case -- every job priced at `MAX_OUTPUT_TOKENS`, the model's actual
 * code-enforced output cap) exceeds this, the script refuses to proceed to
 * any live Claude call -- even with `--live`.
 *
 * Deliberately conservative ($5), NOT a measured figure: this ticket was
 * implemented in a sandbox with no access to Nicole's real database, so
 * there is no real job count to size this ceiling against (unlike
 * `validate-level-fit.ts`'s `MAX_ESTIMATED_SPEND_USD`, which WAS tuned
 * against a specific approved spend and a specific worst-case sample size,
 * because that ticket's whole sample was under this codebase's control).
 *
 * CORRECTED, 2026-09-13 (adversarial review of this ticket, round 1): an
 * earlier version of this comment claimed "$5 covers a few hundred
 * single-call re-scores comfortably" -- that was never checked against the
 * real `estimateScoringCost`/`MAX_OUTPUT_TOKENS` math and is false. Running
 * the REAL `estimateScoringCost` (this file's own `_cost-check-tmp.mjs`
 * scratch script, deleted after use -- see this commit) against a realistic
 * ~4-6k-character resume and `MAX_OUTPUT_TOKENS` (2000, `demo-match.ts`) at
 * $15/MTok output:
 *
 *   - "bootstrap" basis (no `prep/scoring-usage-stats.json` yet -- a fresh
 *     checkout, exactly this sandbox's own state): `maxCostUsd` crosses $5
 *     between 141 jobs ($4.98) and 142 jobs ($5.02).
 *   - "measured" basis (real historical per-call averages -- 3,874.5 in /
 *     454.2 out tokens/call, the same pre-b182bde figures
 *     `validate-level-fit.ts`'s own `$0.01843/call uncached` figure is
 *     built from): `maxCostUsd` crosses $5 between 118 jobs ($4.96) and 119
 *     jobs ($5.01).
 *
 * So the real ceiling this $5 default permits is **roughly 120-140 jobs**,
 * not "a few hundred" -- depending on which basis a real run lands on
 * (`describeCostEstimate`'s own log line at run time says which). This is
 * NOT being raised to compensate: $5 was never a measured figure to begin
 * with (see above), a real per-resume `job_matches` count is unknown here,
 * and raising it "to get the comment to match a rounder job count" would be
 * exactly the unilateral-raise this file already says never to do. If a
 * real batch needs a higher ceiling, raise this constant deliberately, with
 * the real job count that justifies it.
 */
export const MAX_ESTIMATED_SPEND_USD = 5.0;

/** How many times a single scoring call is retried after a failure, with
 * exponential backoff, before being reported as failed. Copied from
 * `validate-level-fit.ts`'s `SCORING_RETRY_COUNT`/`withRetry` (same value,
 * same rationale) rather than imported: that file is itself a one-off
 * script, not a shared library, and its own top comment establishes the
 * precedent of copying small frozen pieces of prior-reviewed shape into a
 * sibling script instead of reaching across two scripts for them (see this
 * file's own `OLD_SCHEMA`-less design note above -- this is the analogous
 * case for retry infra instead of scoring schema). The Anthropic SDK client
 * already retries some errors itself at the HTTP layer (`maxRetries`,
 * default 2) before ever throwing into this script; `withRetry` below is a
 * second, independent layer catching whatever the SDK gave up on or that
 * isn't SDK-retryable (this file's own `JSON.parse`/schema-shape failures
 * inside `makeClaudeScorer`), not the primary retry mechanism. Deliberately
 * just ONE retry (two attempts total), matching `validate-level-fit.ts`'s
 * own tuning: recovers most transient 429/5xx blips without risking a
 * runaway retry storm against a real rate limit. */
export const SCORING_RETRY_COUNT = 1;

/** Base delay before the first retry (doubled on each subsequent attempt).
 * See `SCORING_RETRY_COUNT`'s doc comment. */
export const SCORING_RETRY_BASE_DELAY_MS = 1000;

/**
 * Runs `fn`, retrying up to `retries` more times with exponential backoff if
 * it throws. Copied verbatim (shape and behavior) from
 * `validate-level-fit.ts`'s own `withRetry` -- see `SCORING_RETRY_COUNT`'s
 * doc comment for why this is a copy, not an import. Without this, a single
 * transient failure (e.g. a 429 burst) previously left that job's existing
 * `job_matches` row silently untouched with no automatic recovery -- the
 * per-job try/catch in `main()` would just count it as failed and move on.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const { retries = SCORING_RETRY_COUNT, baseDelayMs = SCORING_RETRY_BASE_DELAY_MS } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delayMs = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// PURE functions -- argv parsing, update-payload construction, spend-ceiling
// check, DB-row-to-NormalizedJob conversion. Every one of these is unit
// tested in rescore-existing-matches.test.ts against fixed fixtures, with no
// network/DB access. The I/O functions below (DB queries/updates, the live
// Claude call via `makeClaudeScorer`, file writes, `main`) are NOT unit
// tested -- thin, structurally obvious wiring around these functions and
// around real DB/API calls that can't be exercised without a real database
// and real spend. Same test/no-test split `validate-level-fit.ts` uses.
// ---------------------------------------------------------------------------

export type ParsedArgs = {
  resumeId: string;
  live: boolean;
  /** Ticket ccc3d6e, Nicole: "I think that I've dismissed all those
   * [wrong-location] jobs. Do you think that you could make your script
   * exclude dismissed jobs, please? To save a little more money?" Default
   * `false` -- dismissed jobs are excluded (skip real spend on jobs she's
   * already rejected), matching this app's own default dismissed-exclusion
   * (routes/resumes.ts, ticket 484889d decision #2). `--include-dismissed`
   * (naming mirrors that same route's own `includeDismissed` query param)
   * opts back into rescoring them -- same "never a silent, permanent drop,
   * always an explicit override" convention this app already established
   * for the level-fit and contract/temp filters. */
  includeDismissed: boolean;
};

const KNOWN_FLAGS = new Set(["--live", "--include-dismissed"]);

/**
 * Parses argv into `{resumeId, live, includeDismissed}`. Throws (rather than
 * logging and exiting itself) so `main()` controls presentation and tests
 * can assert on the thrown message directly. Hard-errors on:
 *
 *   - no positional argument at all -- `resumeId` is REQUIRED (ticket
 *     45e238e acceptance criteria: never silently guess "the most recently
 *     used resume" -- operating on the wrong resume's data by accident
 *     would silently overwrite real match history for the wrong resume).
 *   - more than one positional argument -- ambiguous: which one is the real
 *     resumeId?
 *   - any `--`-prefixed argument that isn't in `KNOWN_FLAGS` -- a typo like
 *     `--liv` or an unrecognized flag like `--dry-run` must hard-error, not
 *     silently fall through to dry-run (safe direction, but still a guess)
 *     or, worse, silently proceed to a live, billed run. Same "don't guess"
 *     principle `validate-level-fit.ts`'s own argv validation established.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  for (const arg of argv) {
    if (KNOWN_FLAGS.has(arg)) continue;
    if (arg.startsWith("--")) unknownFlags.push(arg);
    else positional.push(arg);
  }
  if (unknownFlags.length > 0) {
    throw new Error(
      `Unrecognized argument(s): ${unknownFlags.join(", ")}. Known flags are --live (spends real ` +
        "Anthropic API credit; omit it for a dry run) and --include-dismissed (rescore dismissed " +
        "jobs too; omit it to skip them). Refusing to guess which was meant -- exiting before any " +
        "Anthropic call.",
    );
  }
  if (positional.length === 0) {
    throw new Error(
      "resumeId is required. Usage: rescore-existing-matches.ts <resumeId> [--live] " +
        '[--include-dismissed]. This script never guesses "the most recently used resume" -- find ' +
        "yours with `SELECT id FROM resumes;` against your own database.",
    );
  }
  if (positional.length > 1) {
    throw new Error(
      `Expected exactly one resumeId, got ${positional.length}: ${positional.join(", ")}. Refusing ` +
        "to guess which one was meant.",
    );
  }
  return {
    resumeId: positional[0]!,
    live: argv.includes("--live"),
    includeDismissed: argv.includes("--include-dismissed"),
  };
}

export type JobMatchUpdate = {
  matchScore: number;
  rationale: string;
  levelFit: LevelFit | null;
  levelFitNote: string | null;
  strengths: string[] | null;
  gaps: string[] | null;
};

/**
 * Pure transform: a scorer's raw response (`ScoredJob`, imported from
 * demo-match.ts) into the exact fields the `job_matches` row update sets.
 * `levelFit`/`levelFitNote` are optional on `ScoredJob`'s TYPE only --
 * existing test fakes predate ticket b182bde (see that field's own doc
 * comment in demo-match.ts) -- a REAL `makeClaudeScorer` response always
 * carries them (`required` in `SCHEMA`), so the `?? null` fallback here only
 * ever fires for a fake scorer in a test, never for a real re-score.
 */
export function buildJobMatchUpdate(scored: ScoredJob): JobMatchUpdate {
  return {
    matchScore: scored.matchScore,
    rationale: scored.rationale,
    levelFit: scored.levelFit ?? null,
    levelFitNote: scored.levelFitNote ?? null,
    strengths: scored.strengths ?? null,
    gaps: scored.gaps ?? null,
  };
}

export type SpendCeilingCheck = {
  withinCeiling: boolean;
  ceilingUsd: number;
  costUsd: number;
};

/**
 * The actual spend gate: whether `estimate.maxCostUsd` (the genuine worst
 * case, every job at MAX_OUTPUT_TOKENS -- never the merely-probable figure)
 * exceeds `ceilingUsd`. `--live`/no-flag only decide whether a run is
 * ALLOWED to spend at all; THIS decides whether the amount it would spend
 * is one within the approved ceiling, checked against the real computed
 * estimate rather than against job count directly, so it catches any way
 * the real cost ends up larger than expected.
 *
 * Takes the WHOLE estimate object (matching `validate-level-fit.ts`'s own
 * `checkSpendCeiling`) and reads `.maxCostUsd` INSIDE this function, rather
 * than a bare `costUsd` number the caller extracts itself -- opus re-review
 * (45e238e, round 3) found the bare-number version could not be
 * mutation-tested: nothing would fail if `main()` were changed to pass
 * `probableCostUsd` instead of `maxCostUsd`, since the field selection
 * happened at the call site, outside any test's reach. Moving the field
 * choice in here means a test can call this function directly with a real
 * `CostEstimate` and prove which field it actually uses.
 */
export function checkSpendCeiling(
  estimate: Pick<CostEstimate, "maxCostUsd">,
  ceilingUsd: number = MAX_ESTIMATED_SPEND_USD,
): SpendCeilingCheck {
  const costUsd = estimate.maxCostUsd;
  return { withinCeiling: costUsd <= ceilingUsd, ceilingUsd, costUsd };
}

// ---------------------------------------------------------------------------
// I/O -- DB queries/updates, live scoring, file writes, CLI entry point. Not
// unit tested (network/DB/API access); kept thin and structurally obvious
// around the pure functions above.
// ---------------------------------------------------------------------------

export type ExistingMatchRow = JobDescriptionRow & {
  jobId: string;
  oldMatchScore: number;
  oldRationale: string;
  oldLevelFit: LevelFit | null;
  oldLevelFitNote: string | null;
  /** Fetched alongside the other `old*` fields so the per-job report can
   * show a genuinely complete OLD -> NEW diff (R2, adversarial review of
   * this ticket): `strengths`/`gaps` are overwritten by the same UPDATE as
   * `matchScore`/`rationale`/`levelFit`/`levelFitNote`, so this ticket's own
   * stated purpose ("nothing is silently overwritten without a visible
   * record") applies to them too, even though they weren't in the ticket's
   * literal acceptance-criteria minimum. */
  oldStrengths: string[] | null;
  oldGaps: string[] | null;
};

async function fetchResumeText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
): Promise<string | undefined> {
  const rows = await db
    .select({ resumeText: resumes.resumeText })
    .from(resumes)
    .where(eq(resumes.id, resumeId));
  return rows[0]?.resumeText;
}

/** Every `job_matches` row for `resumeId`, joined with `jobs` for the
 * already-stored description and everything else `NormalizedJob` needs --
 * see `toNormalizedJob`. Scoped to `resumeId` alone: never reads (or later,
 * updates) another resume's rows.
 *
 * By default also LEFT JOINs `user_job_statuses` (keyed on `job_id` ALONE --
 * ticket 0c319b2, a dismissed status is a fact about the job, not about
 * which resume viewed it) and excludes anything dismissed -- ticket ccc3d6e,
 * Nicole: real spend on a job she's already rejected is pure waste. Uses the
 * EXACT same `isNull(status) OR status != 'dismissed'` shape
 * `routes/resumes.ts` already uses for its own default dismissed-exclusion,
 * for consistency with what "dismissed" already means elsewhere in this app,
 * rather than a second, independently-invented filter. `includeDismissed`
 * restores the pre-ccc3d6e behavior (every match for the resume, regardless
 * of status). */
export async function fetchExistingMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
  includeDismissed: boolean,
): Promise<ExistingMatchRow[]> {
  const query = db
    .select({
      jobId: jobMatches.jobId,
      oldMatchScore: jobMatches.matchScore,
      oldRationale: jobMatches.rationale,
      oldLevelFit: jobMatches.levelFit,
      oldLevelFitNote: jobMatches.levelFitNote,
      oldStrengths: jobMatches.strengths,
      oldGaps: jobMatches.gaps,
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
    .from(jobMatches)
    .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
    .leftJoin(userJobStatuses, eq(userJobStatuses.jobId, jobsTable.id));

  return includeDismissed
    ? query.where(eq(jobMatches.resumeId, resumeId))
    : query.where(
        and(
          eq(jobMatches.resumeId, resumeId),
          or(isNull(userJobStatuses.status), ne(userJobStatuses.status, "dismissed"))!,
        ),
      );
}

/** Updates exactly one `(resumeId, jobId)` row -- `job_matches`'s own
 * `UNIQUE(resume_id, job_id)` constraint (db/schema.ts) makes this the
 * natural, unambiguous target; the `resumeId` filter is what guarantees
 * this NEVER touches another resume's row for the same job. */
async function updateJobMatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
  jobId: string,
  update: JobMatchUpdate,
): Promise<void> {
  await db
    .update(jobMatches)
    .set(update)
    .where(and(eq(jobMatches.resumeId, resumeId), eq(jobMatches.jobId, jobId)));
}

function connectDb(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { resumeId, live, includeDismissed } = parsed;

  console.log(
    `rescore-existing-matches: resumeId=${resumeId} -- ${
      live
        ? "LIVE RUN -- this WILL spend real Anthropic API credit"
        : "DRY RUN -- no Anthropic API calls will be made"
    }`,
  );

  const client = connectDb();
  try {
    await client.connect();
  } catch (err) {
    // Not wrapped in the same try/finally as the rest of main() below (a
    // connection failure means there is nothing yet to `client.end()`) --
    // caught separately here so it gets the same clean, actionable
    // messaging every other early-exit path in this script uses, instead of
    // a raw `pg` stack trace surfacing through main()'s top-level
    // `.catch(console.error)`.
    console.error(
      `Failed to connect to the database: ${err instanceof Error ? err.message : String(err)} -- ` +
        "check POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB in your .env " +
        "and that Postgres is actually running (`docker compose up -d`, from the host).",
    );
    process.exitCode = 1;
    return;
  }
  const db = drizzle(client);

  try {
    const resumeText = await fetchResumeText(db, resumeId);
    if (resumeText === undefined) {
      console.error(
        `No resume found with id "${resumeId}" -- refusing to guess a different one. Check the id ` +
          "(`SELECT id FROM resumes;`) and retry.",
      );
      process.exitCode = 1;
      return;
    }

    const existing = await fetchExistingMatches(db, resumeId, includeDismissed);
    if (includeDismissed) {
      console.log(`Found ${existing.length} existing job_matches row(s) for resume "${resumeId}".`);
    } else {
      // Ticket ccc3d6e: report the real exclusion count so the savings are
      // visible, not just assumed. This re-fetches every match's full job
      // data a second time (opus review: NOT actually "lightweight" as an
      // earlier version of this comment claimed -- for Nicole's real ~360
      // rows it's the whole payload pulled twice) purely to compute a
      // difference. Harmless here (no API spend, local Postgres, a
      // short-lived CLI run), but a cheap thing to tighten later: counting
      // the LEFT JOIN's dismissed side directly would need only one query.
      const allMatches = await fetchExistingMatches(db, resumeId, true);
      const dismissedCount = allMatches.length - existing.length;
      console.log(
        `Found ${existing.length} existing job_matches row(s) for resume "${resumeId}" ` +
          `(${dismissedCount} dismissed job(s) excluded -- pass --include-dismissed to rescore them too).`,
      );
    }
    if (existing.length === 0) {
      console.log("Nothing to rescore. Exiting.");
      return;
    }

    const usageStats = readUsageStats(USAGE_STATS_PATH);
    const normalizedJobs = existing.map((row) => toNormalizedJob(row));
    const costEstimate = estimateScoringCost(normalizedJobs, resumeText, usageStats);
    console.log(`\nCost estimate: ${describeCostEstimate(costEstimate)}`);
    console.log(
      `  (basis: ${costEstimate.basis}${
        usageStats
          ? `, grounded in ${usageStats.calls} real historical call(s) from ${USAGE_STATS_PATH}`
          : `, no ${USAGE_STATS_PATH} found -- schema-grounded bootstrap estimate from this run's own real prompt text`
      })`,
    );

    // The actual spend gate -- checked against the genuine WORST CASE
    // (every job at MAX_OUTPUT_TOKENS), not the merely-probable figure, and
    // even in dry-run mode so an oversized batch is caught before anyone
    // bothers re-running with --live.
    const spendCheck = checkSpendCeiling(costEstimate);
    if (!spendCheck.withinCeiling) {
      console.error(
        `\nWorst-case estimated cost ~$${spendCheck.costUsd.toFixed(2)} exceeds the approved ceiling ` +
          `of $${spendCheck.ceilingUsd.toFixed(2)} (MAX_ESTIMATED_SPEND_USD) -- refusing to proceed, ` +
          "even with --live. That ceiling defaults conservatively since this codebase has no way to " +
          "know your real job count -- raise MAX_ESTIMATED_SPEND_USD in this file deliberately if a " +
          "larger batch is genuinely intended.",
      );
      process.exitCode = 1;
      return;
    }

    if (!live) {
      console.log(
        "\nDry run: stopping here. No Anthropic API calls were made. Re-run with --live to actually " +
          "rescore.",
      );
      return;
    }

    // R6 (adversarial review): created before the loop starts, not just
    // before the final report write -- a missing `prep/` (fresh worktree,
    // or the script invoked from a different cwd, e.g. `apps/api/`) must
    // fail LOUDLY here, before a single dollar is spent, not silently wait
    // to throw on the last line after every job has already been billed.
    fs.mkdirSync(REPORT_DIR, { recursive: true });

    // R7 (adversarial review): the resumeId alone is not a unique report
    // filename -- re-running this script for the same resume (a later
    // rescore after more sources are added, a retry after some jobs failed,
    // simple curiosity) would silently overwrite the PREVIOUS run's report.
    // Combined with R2's fix (the report now records genuine pre-rescore OLD
    // values), an innocent second run would destroy the only on-disk record
    // of the FIRST run's original values, since the second run's "old"
    // values are the first run's "new" ones. A timestamp in the filename
    // means every run gets its own permanent record.
    const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(REPORT_DIR, `rescore-report-${resumeId}-${runTimestamp}.txt`);

    // R1 (adversarial review): every `job_matches` UPDATE below commits
    // immediately, but before this fix the report was only written to disk
    // AFTER the entire loop finished -- an interruption (Ctrl-C, dropped
    // connection, crash) at job 90 of 100 left ~90 rows irreversibly
    // overwritten and ~90 real API calls already billed, with ZERO durable
    // record of what the OLD values were (console scrollback only, lost the
    // moment the terminal closes). `emit` now appends each line to
    // `reportPath` immediately, in the same tick it's produced -- a crash
    // at any point still leaves a complete, accurate record of every job
    // processed before it, same safety-net philosophy as
    // `validate-level-fit.ts`'s `RAW_RESULTS_PATH` (see that constant's own
    // doc comment: "all that paid-for data was previously unrecoverable
    // short of re-running (and re-spending). This file is the safety net."),
    // adapted here to this script's per-job (not single-batch) structure.
    fs.writeFileSync(reportPath, "");
    const emit = (line: string = ""): void => {
      console.log(line);
      fs.appendFileSync(reportPath, line + "\n");
    };
    emit(
      `=== rescore-existing-matches report -- resumeId=${resumeId} -- ${new Date().toISOString()} ===`,
    );
    emit(`${existing.length} job(s) considered.\n`);

    console.log(
      `\nProceeding to LIVE rescoring of ${existing.length} job(s) -- this spends real Anthropic API ` +
        `credit. Report: ${reportPath} (written incrementally, one job at a time).`,
    );
    const anthropic = new Anthropic();
    const scoreJob = makeClaudeScorer(anthropic);

    let succeeded = 0;
    const failures: { jobId: string; title: string; company: string; error: string }[] = [];
    // Accumulated across the loop and recorded once, AFTER it finishes --
    // real usage from this run feeds the next run's cost estimate (nit,
    // adversarial review; mirrors `runDemoMatch`'s own `recordUsageStats`
    // call site in demo-match.ts, including the "after persistence,
    // best-effort" ordering below).
    let usageCalls = 0;
    let usageInputTokens = 0;
    let usageOutputTokens = 0;
    let usageCacheReadTokens = 0;
    let usageCacheCreationTokens = 0;

    /** Renders one OLD -> NEW line, or just the OLD value (prefixed
     * "(unchanged)") when `newVal` is omitted -- used for the failure path,
     * where nothing was actually written. */
    const diffLine = (label: string, oldVal: string, newVal?: string): string =>
      newVal === undefined
        ? `    ${label} (unchanged): ${oldVal}`
        : `    ${label}: ${oldVal} -> ${newVal}`;

    // Sequential, not concurrency-pooled: each job's update is independent
    // (no shared A/B pairing to keep in lockstep, unlike
    // validate-level-fit.ts's scoreBothArms), and keeping this simple
    // reduces rate-limit risk for what is, per-resume, normally a modest
    // batch. A per-job try/catch with a running success/failure count is
    // the right shape here (ticket 45e238e Notes) -- one job's failure
    // never aborts the batch, and its existing job_matches row is left
    // untouched (the UPDATE for that job simply never runs).
    for (const row of existing) {
      const job = toNormalizedJob(row);
      try {
        // R5 (adversarial review): wrapped in the same `withRetry` shape
        // `validate-level-fit.ts` uses -- see `SCORING_RETRY_COUNT`'s doc
        // comment for why this sits alongside, not instead of, the
        // Anthropic SDK's own built-in retry.
        const scored = await withRetry(() => scoreJob(job, resumeText));
        const update = buildJobMatchUpdate(scored);
        await updateJobMatch(db, resumeId, row.jobId, update);
        succeeded++;
        if (scored.usage) {
          usageCalls++;
          usageInputTokens += scored.usage.inputTokens;
          usageOutputTokens += scored.usage.outputTokens;
          usageCacheReadTokens += scored.usage.cacheReadTokens ?? 0;
          usageCacheCreationTokens += scored.usage.cacheCreationTokens ?? 0;
        }

        // R2 (adversarial review): a genuinely complete OLD -> NEW diff --
        // previously this line showed only `oldMatchScore`, silently
        // dropping the fact that `rationale`/`levelFit`/`levelFitNote`/
        // `strengths`/`gaps` are ALSO overwritten by the same UPDATE, which
        // defeated this report's whole stated purpose ("nothing is silently
        // overwritten without a visible record").
        emit(`${row.company} — ${row.title} (jobId ${row.jobId})`);
        emit(diffLine("matchScore", `${row.oldMatchScore}%`, `${update.matchScore}%`));
        emit(diffLine("levelFit", row.oldLevelFit ?? "n/a", update.levelFit ?? "n/a"));
        emit(
          diffLine(
            "levelFitNote",
            row.oldLevelFitNote ? `"${row.oldLevelFitNote}"` : "n/a",
            update.levelFitNote ? `"${update.levelFitNote}"` : "n/a",
          ),
        );
        emit(diffLine("rationale", `"${row.oldRationale}"`, `"${update.rationale}"`));
        emit(
          diffLine(
            "strengths",
            JSON.stringify(row.oldStrengths ?? []),
            JSON.stringify(update.strengths ?? []),
          ),
        );
        emit(
          diffLine("gaps", JSON.stringify(row.oldGaps ?? []), JSON.stringify(update.gaps ?? [])),
        );
        emit();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ jobId: row.jobId, title: row.title, company: row.company, error: message });
        emit(`${row.company} — ${row.title} (jobId ${row.jobId}): FAILED, row left untouched`);
        emit(diffLine("matchScore", `${row.oldMatchScore}%`));
        emit(diffLine("levelFit", row.oldLevelFit ?? "n/a"));
        emit(`    error: ${message}`);
        emit();
      }
    }

    emit(`\n${succeeded} succeeded, ${failures.length} failed.`);
    if (failures.length > 0) {
      emit("Failures (existing job_matches row left untouched for each):");
      for (const f of failures) emit(`  ${f.company} — ${f.title} (jobId ${f.jobId}): ${f.error}`);
    }
    console.log(`\nFull report written to ${reportPath}.`);

    if (usageCalls > 0) {
      try {
        recordUsageStats(USAGE_STATS_PATH, {
          calls: usageCalls,
          totalInputTokens: usageInputTokens,
          totalOutputTokens: usageOutputTokens,
          totalCacheReadTokens: usageCacheReadTokens,
          totalCacheCreationTokens: usageCacheCreationTokens,
        });
      } catch (err) {
        // Best-effort, same as runDemoMatch's own call site: this runs
        // AFTER every DB update above has already committed, so a failure
        // here can never take an already-persisted rescore down with it --
        // the only consequence is the NEXT run's cost estimate falls back
        // to the bootstrap path instead of a measured one.
        console.error(
          `  WARNING: failed to record usage stats to "${USAGE_STATS_PATH}" -- the ${usageCalls} ` +
            `call(s) from this run are NOT reflected in future cost estimates: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
