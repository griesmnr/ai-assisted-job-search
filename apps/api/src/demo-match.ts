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
import { GreenhouseSource } from "./sources/greenhouse.js";
import type { JobSource, NormalizedJob, SearchCriteria } from "./sources/types.js";

process.loadEnvFile();

export const MODEL = "claude-opus-5";
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
};

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
  const { jobs: found, skipped, skipRate } = await source.search(criteria);
  log(`  ${found.length} jobs, ${skipped.length} skipped (skipRate ${skipRate.toFixed(2)})\n`);

  const shortlist = filter(found).slice(0, maxJobs);

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
    return { resumeId, searchId, skipped: 0, newlyScored: 0, failed: 0, results: [] };
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
  };
}

// ---------------------------------------------------------------------------
// Shortlist filter for the real Greenhouse-backed run below. Greenhouse has
// no server-side keyword/location query support (it always returns a whole
// board — see sources/greenhouse.ts), so all of this narrowing has to happen
// client-side, on `filter`, not on `criteria`.
// ---------------------------------------------------------------------------

// Title filter: actual software engineering roles, not adjacent ones.
const SOFTWARE =
  /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit|intern|designer|field service|machine learning|data scientist)\b/i;

// Location filter: Washington, or genuinely US-remote. Excludes the many
// "Remote - Canada/UK/Poland" postings, which aren't applicable.
const PLACE = /(washington|seattle|bellevue|,\s*wa\b|remote\s*-\s*us|remote,\s*usa)/i;

export function filterSoftwareEngineeringJobs(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs
    .filter((j) => SOFTWARE.test(j.title) && !NOT.test(j.title))
    .filter((j) => PLACE.test(j.location ?? ""))
    .filter((j) => {
      const key = `${j.company}|${j.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

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

  const source = new GreenhouseSource({
    boardTokens: ["samsara", "flexport", "smartsheet", "pushpay"],
  });

  try {
    // No location/keyword in `criteria`: GreenhouseSource has no
    // server-side query support and substring-matches criteria.location
    // against the board's raw location string, which would incorrectly
    // reject "Remote - US" / "Seattle, WA" / "Bellevue" postings that
    // `filterSoftwareEngineeringJobs` (title + location regex + dedupe)
    // is specifically written to keep.
    await runDemoMatch({
      db,
      source,
      resumeText,
      scoreJob: makeClaudeScorer(anthropic),
      criteria: {},
      filter: filterSoftwareEngineeringJobs,
    });
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
