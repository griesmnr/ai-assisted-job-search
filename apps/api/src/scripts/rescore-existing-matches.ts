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
 * Find your resumeId with, e.g.: `SELECT id FROM resumes;` against your own
 * database (docker-compose's Postgres) -- there is deliberately no "most
 * recent" auto-detection here (see the safety-gate note above).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LevelFit } from "@app/shared";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  describeCostEstimate,
  estimateScoringCost,
  makeClaudeScorer,
  readUsageStats,
  type ScoredJob,
} from "../demo-match.js";
import { jobMatches, jobs as jobsTable, resumes } from "../db/schema.js";
import { loadEnvFile } from "../load-env.js";
import type { NormalizedJob } from "../sources/types.js";

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
 * (gitignored: this is personal job-search content, never checked in). */
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
 * $5 covers a few hundred single-call re-scores comfortably at this
 * project's real per-call cost (see `demo-match.ts`'s own measurements --
 * a 200-job live run has historically landed under $2 with prompt caching
 * warm) while still catching a wildly larger-than-expected batch. If your
 * real `job_matches` count for this resume needs a higher ceiling, raise
 * this constant deliberately -- it is not something this script will ever
 * raise on your behalf.
 */
export const MAX_ESTIMATED_SPEND_USD = 5.0;

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
};

const KNOWN_FLAGS = new Set(["--live"]);

/**
 * Parses argv into `{resumeId, live}`. Throws (rather than logging and
 * exiting itself) so `main()` controls presentation and tests can assert on
 * the thrown message directly. Hard-errors on:
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
      `Unrecognized argument(s): ${unknownFlags.join(", ")}. Known flag is --live (spends real ` +
        `Anthropic API credit; omit it for a dry run). Refusing to guess which was meant -- exiting ` +
        `before any Anthropic call.`,
    );
  }
  if (positional.length === 0) {
    throw new Error(
      "resumeId is required. Usage: rescore-existing-matches.ts <resumeId> [--live]. This script " +
        'never guesses "the most recently used resume" -- find yours with `SELECT id FROM resumes;` ' +
        "against your own database.",
    );
  }
  if (positional.length > 1) {
    throw new Error(
      `Expected exactly one resumeId, got ${positional.length}: ${positional.join(", ")}. Refusing ` +
        "to guess which one was meant.",
    );
  }
  return { resumeId: positional[0]!, live: argv.includes("--live") };
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
 * The actual spend gate: whether `costUsd` (this script always passes
 * `CostEstimate.maxCostUsd`, the genuine worst case -- see `main()`)
 * exceeds `ceilingUsd`. `--live`/no-flag only decide whether a run is
 * ALLOWED to spend at all; THIS decides whether the amount it would spend
 * is one within the approved ceiling, checked against the real computed
 * estimate rather than against job count directly, so it catches any way
 * the real cost ends up larger than expected.
 */
export function checkSpendCeiling(
  costUsd: number,
  ceilingUsd: number = MAX_ESTIMATED_SPEND_USD,
): SpendCeilingCheck {
  return { withinCeiling: costUsd <= ceilingUsd, ceilingUsd, costUsd };
}

/** The subset of a `jobs` row this script needs to build a `NormalizedJob`
 * for re-scoring -- exactly the columns `db/schema.ts`'s `jobs` table
 * carries, minus `id`/`postedAt` type narrowing quirks. */
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
 * `buildJobSuffix`/`makeClaudeScorer` expect -- no live re-fetch, per this
 * ticket's whole premise (`jobs.description` is `NOT NULL`, confirmed
 * already stored from original ingestion). Only real conversion needed:
 * drizzle's nullable columns come back as `null`; `NormalizedJob`'s optional
 * fields want `undefined` for "not stated" (same convention `Job`'s own doc
 * comment in packages/shared uses). `dataSource` is widened from the
 * column's plain `text` type to `NormalizedJob["dataSource"]`'s literal
 * union with a cast: the column is a `text` FK to `source_descriptors.id`
 * at the TYPE level, but every real row's value IS one of that union's
 * literals (ingestion never writes anything else there).
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
 * updates) another resume's rows. */
async function fetchExistingMatches(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
): Promise<ExistingMatchRow[]> {
  return db
    .select({
      jobId: jobMatches.jobId,
      oldMatchScore: jobMatches.matchScore,
      oldRationale: jobMatches.rationale,
      oldLevelFit: jobMatches.levelFit,
      oldLevelFitNote: jobMatches.levelFitNote,
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
    .where(eq(jobMatches.resumeId, resumeId));
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
  const { resumeId, live } = parsed;

  console.log(
    `rescore-existing-matches: resumeId=${resumeId} -- ${
      live
        ? "LIVE RUN -- this WILL spend real Anthropic API credit"
        : "DRY RUN -- no Anthropic API calls will be made"
    }`,
  );

  const client = connectDb();
  await client.connect();
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

    const existing = await fetchExistingMatches(db, resumeId);
    console.log(`Found ${existing.length} existing job_matches row(s) for resume "${resumeId}".`);
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
    const spendCheck = checkSpendCeiling(costEstimate.maxCostUsd);
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

    console.log(
      `\nProceeding to LIVE rescoring of ${existing.length} job(s) -- this spends real Anthropic API ` +
        "credit.",
    );
    const anthropic = new Anthropic();
    const scoreJob = makeClaudeScorer(anthropic);

    const lines: string[] = [];
    const emit = (line: string = ""): void => {
      lines.push(line);
      console.log(line);
    };
    emit(
      `=== rescore-existing-matches report -- resumeId=${resumeId} -- ${new Date().toISOString()} ===`,
    );
    emit(`${existing.length} job(s) considered.\n`);

    let succeeded = 0;
    const failures: { jobId: string; title: string; company: string; error: string }[] = [];

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
        const scored = await scoreJob(job, resumeText);
        const update = buildJobMatchUpdate(scored);
        await updateJobMatch(db, resumeId, row.jobId, update);
        succeeded++;
        emit(
          `OLD ${row.oldMatchScore}% -> NEW ${update.matchScore}%  [${update.levelFit ?? "n/a"}]  ` +
            `${row.company} — ${row.title}`,
        );
        if (update.levelFitNote) emit(`    note: "${update.levelFitNote}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ jobId: row.jobId, title: row.title, company: row.company, error: message });
        emit(
          `OLD ${row.oldMatchScore}% -> FAILED (row left untouched)  ${row.company} — ${row.title}: ${message}`,
        );
      }
    }

    emit(`\n${succeeded} succeeded, ${failures.length} failed.`);
    if (failures.length > 0) {
      emit("Failures (existing job_matches row left untouched for each):");
      for (const f of failures) emit(`  ${f.company} — ${f.title} (jobId ${f.jobId}): ${f.error}`);
    }

    const reportPath = path.join(REPORT_DIR, `rescore-report-${resumeId}.txt`);
    fs.writeFileSync(reportPath, lines.join("\n") + "\n");
    console.log(`\nFull report written to ${reportPath}.`);
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
