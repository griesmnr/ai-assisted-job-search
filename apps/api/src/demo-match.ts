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
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { seedSourceDescriptors } from "./db/seed.js";
import { jobMatches, jobs as jobsTable, resumes, searches, searchSources } from "./db/schema.js";
import { ingestJobsForSearch } from "./ingest/ingestJobs.js";
import { createGreenhouseSourceFromEnv } from "./sources/greenhouse.js";
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
export const MAX_JOBS = 12;

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
};

/** Injectable so tests can assert call counts without spending real Claude
 * tokens (or requiring `ANTHROPIC_API_KEY`) and without needing a resume
 * closed over module state. */
export type ScoreJobFn = (job: NormalizedJob, resumeText: string) => Promise<ScoredJob>;

export function makeClaudeScorer(anthropic: Anthropic): ScoreJobFn {
  return async function scoreJob(job: NormalizedJob, resumeText: string): Promise<ScoredJob> {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
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
          ].join("\n"),
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block returned");
    return JSON.parse(text.text) as ScoredJob;
  };
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
  source: JobSource;
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
   * Applied to everything the source returned, before truncating to
   * `maxJobs`. Defaults to the identity function (no filtering) — callers
   * that want title/location/dedupe narrowing (see `main()` below for the
   * real one) pass it explicitly.
   */
  filter?: (jobs: NormalizedJob[]) => NormalizedJob[];
  maxJobs?: number;
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
  /** How many of the shortlisted jobs already had a score for this resume
   * and so were NOT sent to Claude. */
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
   * Per-token funnel breakdown, empty when `source.search()` didn't
   * populate `tokenOutcomes` (sources without that concept — see
   * `SourceSearchResult.tokenOutcomes`). See `BoardCoverageEntry`.
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
 * returned, before the `maxJobs` slice) came from that token's employer.
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
    source,
    resumeText,
    scoreJob,
    criteria = {},
    filter = (jobs: NormalizedJob[]) => jobs,
    maxJobs = MAX_JOBS,
    outputPath = "prep/match-results.json",
    log = console.log,
  } = options;

  // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
  // db/seed.ts. Ensures the FK from jobs.data_source to
  // source_descriptors doesn't reject the very first insert on a fresh
  // database.
  await seedSourceDescriptors(db);

  const resumeId = await getOrCreateResumeId(db, resumeText);

  log(`Fetching real postings from ${source.dataSource.toUpperCase()}...`);
  const { jobs: found, skipped, skipRate, tokenOutcomes } = await source.search(criteria);
  log(`  ${found.length} jobs, ${skipped.length} skipped (skipRate ${skipRate.toFixed(2)})\n`);

  // Computed before the `maxJobs` slice, specifically so board-level
  // survivor counts below reflect what actually passed `filter`, not what
  // was left after also truncating to the shortlist size.
  const filtered = filter(found);
  const shortlist = filtered.slice(0, maxJobs);

  const boardCoverage = buildBoardCoverage(tokenOutcomes, filtered, (message) =>
    log(`  WARNING: ${message}`),
  );
  if (boardCoverage.length > 0) {
    log("  Board coverage:");
    for (const b of boardCoverage) {
      log(`    ${b.token}: ${describeBoardOutcome(b)}`);
    }
    log("");
  }

  const searchId = randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId, searchedAt: new Date() });
  await db
    .insert(searchSources)
    .values({ id: randomUUID(), searchId, sourceDescriptorId: source.dataSource });

  // Upsert on (data_source, external_id) and link every job — new or
  // already known — to this search. Reuses the same idempotent path the
  // queue worker uses (ingest/ingestJobs.ts), rather than a second
  // parallel upsert implementation.
  const { linkedJobIds } = await ingestJobsForSearch(db, searchId, source.dataSource, shortlist);

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
      boardCoverage,
    };
  }

  // Map linked job ids back to the NormalizedJob payload a scorer needs
  // (title/description/etc — not stored on job_matches). Looked up by
  // (dataSource, externalId) rather than assumed positional, so this
  // stays correct even if ingestJobsForSearch's internal ordering ever
  // changes.
  const dbRows = await db
    .select({ id: jobsTable.id, externalId: jobsTable.externalId })
    .from(jobsTable)
    .where(
      and(
        eq(jobsTable.dataSource, source.dataSource),
        inArray(
          jobsTable.externalId,
          shortlist.map((j) => j.externalId),
        ),
      ),
    );
  const jobByExternalId = new Map(shortlist.map((j) => [j.externalId, j]));
  const normalizedJobById = new Map<string, NormalizedJob>();
  for (const row of dbRows) {
    const nj = jobByExternalId.get(row.externalId);
    if (nj) normalizedJobById.set(row.id, nj);
  }

  // Score only what has no score yet for this resume. This is the whole
  // point of the ticket: a second run against the same shortlist must
  // make zero Claude calls.
  const alreadyScoredRows = await db
    .select({ jobId: jobMatches.jobId })
    .from(jobMatches)
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, linkedJobIds)));
  const alreadyScoredIds = new Set(alreadyScoredRows.map((r) => r.jobId));
  const toScoreIds = linkedJobIds.filter((id) => !alreadyScoredIds.has(id));

  log(
    `Scoring ${toScoreIds.length} of ${linkedJobIds.length} candidates with ${MODEL} ` +
      `(${alreadyScoredIds.size} already scored — skipped, saving that many Claude calls)...\n`,
  );

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
          // same shortlist.
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
    boardCoverage,
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

  // Board tokens are configuration (GREENHOUSE_BOARD_TOKENS, .env), not a
  // literal here (ticket b723fb9) — see .env.example for the documented
  // default list and apps/api/src/scripts/check-greenhouse-board.ts for
  // how to check whether a candidate employer hosts on Greenhouse at all
  // before adding its token.
  const source = createGreenhouseSourceFromEnv();

  try {
    // No location/keyword in `criteria`: GreenhouseSource has no
    // server-side query support and substring-matches criteria.location
    // against the board's raw location string, which would incorrectly
    // reject "Remote - US" / "Seattle, WA" / "Bellevue" postings that
    // `filterSoftwareEngineeringJobs` (title + location regex + dedupe)
    // is specifically written to keep.
    const result = await runDemoMatch({
      db,
      source,
      resumeText,
      scoreJob: makeClaudeScorer(anthropic),
      criteria: {},
      filter: filterSoftwareEngineeringJobs,
    });

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
