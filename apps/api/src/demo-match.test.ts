import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MATCH_SCORE_FLOOR } from "@app/shared";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchResults,
  searchSources,
} from "./db/schema.js";
import {
  applyMatchScoreFloor,
  buildBoardCoverage,
  buildCachedPrefix,
  buildJobSuffix,
  buildScoringPrompt,
  buildSourceOutcomes,
  describeBoardOutcome,
  describeCostEstimate,
  describeSourceOutcome,
  DEFAULT_SCORE_THRESHOLD,
  estimateScoringCost,
  isTotalScoringFailure,
  makeClaudeScorer,
  MODEL,
  readUsageStats,
  recordUsageStats,
  runDemoMatch,
  type BoardCoverageEntry,
  type RankedResult,
  type ScoredJob,
  type ScoreJobFn,
  type SourceOutcome,
} from "./demo-match.js";
import type { PerSourceOutcome } from "./sources/composite.js";
import type {
  JobSource,
  NormalizedJob,
  SourceSearchResult,
  TokenOutcome,
} from "./sources/types.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const db = drizzle(client);

// "usajobs" is one of the real dataSource ids demo-match.ts always seeds
// via seedSourceDescriptors (see db/seed.ts) — using it here also proves
// runDemoMatch's own seeding step works, without needing a throwaway
// source_descriptors row. Unlike the jobs/resumes/searches rows this test
// creates, the "usajobs" source_descriptors row is real, permanent setup
// data (identical to what `db:seed` produces) and is deliberately NOT
// deleted in afterAll.
const DATA_SOURCE = "usajobs" as const;

function job(externalId: string, title: string): NormalizedJob {
  return {
    externalId,
    dataSource: DATA_SOURCE,
    title,
    description: `Description for ${title}`,
    company: "Test Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: `https://example.com/${externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

class FakeSource implements JobSource {
  readonly dataSource = DATA_SOURCE;
  constructor(private readonly jobsToReturn: NormalizedJob[]) {}
  async search(): Promise<SourceSearchResult> {
    return { jobs: this.jobsToReturn, skipped: [], skipRate: 0 };
  }
}

/**
 * Base for `makeCountingScorer`'s per-job score (ticket e8e59e6).
 *
 * Was 50 until 2026-09-03. That put every job whose externalId ends in 0-4
 * at 50-54 — below `MATCH_SCORE_FLOOR` (55, ticket 1b9f81e, merged
 * 2026-09-02) — so `runDemoMatch`'s floor filter, working exactly as
 * designed, dropped those jobs from the `results` list that seven
 * pipeline-mechanics tests in this file assert against. Those tests predate
 * the floor and are about dedup, partial-failure resilience, spend capping
 * and multi-source merging, none of which care what a score IS, so the
 * fixture moved above the business rule rather than the business rule
 * moving down.
 *
 * 70 is picked so every externalId suffix `makeCountingScorer` is used
 * against in this file (0-19; the widest is `MANY_JOBS` in the spend-guard
 * describe — some OTHER fixtures in this file, like the cost-estimate-only
 * ones, number higher but are never routed through this scorer) lands in
 * 70-89 — clear of the floor at the bottom and of 100 at the top, so the
 * fake scores stay plausible percentages. The "counting-scorer fixture
 * scores" test near the bottom of this file pins that invariant against a
 * hand-maintained upper bound (`HIGHEST_FIXTURE_SUFFIX`, not a scan of this
 * file's actual fixtures), so a future floor change above 89 fails with one
 * obvious assertion instead of seven mysteriously empty `results` arrays.
 * That constant must be raised by hand in step with any new
 * makeCountingScorer fixture numbered past 19 — it won't catch that on its
 * own.
 */
const COUNTING_SCORER_BASE = 70;

/** The score `makeCountingScorer` returns for a job whose externalId ends
 * in `-n`. Extracted so the invariant test below can check the formula
 * without a database. */
function countingScoreFor(n: number): number {
  return COUNTING_SCORER_BASE + n;
}

/** Counts invocations so tests can assert exactly how many (real, billed)
 * scorer calls happened, without an ANTHROPIC_API_KEY or any network
 * access. */
function makeCountingScorer(): { scoreJob: ScoreJobFn; calls: () => number } {
  let calls = 0;
  const scoreJob: ScoreJobFn = async (jobArg: NormalizedJob): Promise<ScoredJob> => {
    calls++;
    // Deterministic, distinguishable-per-job score so sort order is
    // checkable.
    const n = Number(jobArg.externalId.split("-").pop());
    return {
      matchScore: countingScoreFor(n),
      rationale: `fake rationale for ${jobArg.title}`,
      strengths: [`strength for ${jobArg.title}`],
      gaps: [`gap for ${jobArg.title}`],
    };
  };
  return { scoreJob, calls: () => calls };
}

/** Like makeCountingScorer, but also reports fixed, fake `usage` — the
 * shape a real `makeClaudeScorer` call always returns (`response.usage`).
 * Used to exercise the ticket-16c824a spend-guard cost estimate, which
 * only ever updates `usageStatsPath` from `ScoredJob.usage` — a plain
 * `makeCountingScorer` never reports it, so it never pollutes those
 * tests. */
function makeUsageReportingScorer(
  inputTokens: number,
  outputTokens: number,
): { scoreJob: ScoreJobFn; calls: () => number } {
  let calls = 0;
  const scoreJob: ScoreJobFn = async (jobArg: NormalizedJob): Promise<ScoredJob> => {
    calls++;
    return {
      matchScore: 70,
      rationale: `fake rationale for ${jobArg.title}`,
      strengths: [`strength for ${jobArg.title}`],
      gaps: [`gap for ${jobArg.title}`],
      usage: { inputTokens, outputTokens },
    };
  };
  return { scoreJob, calls: () => calls };
}

/** Like makeCountingScorer, but rejects for any job whose externalId is in
 * `failFor` — used to prove a partial-batch failure doesn't throw away the
 * calls that DID succeed (ticket 620ca30 review finding #2). */
function makeFlakyScorer(failFor: ReadonlySet<string>): {
  scoreJob: ScoreJobFn;
  calls: () => number;
} {
  let calls = 0;
  const scoreJob: ScoreJobFn = async (jobArg: NormalizedJob): Promise<ScoredJob> => {
    calls++;
    if (failFor.has(jobArg.externalId)) {
      throw new Error(`simulated 529 overload for ${jobArg.externalId}`);
    }
    return {
      // Flat 60: above MATCH_SCORE_FLOOR (55), so a job this scorer
      // succeeds on is visible in `runDemoMatch`'s floor-filtered `results`
      // and a job it fails on is absent because it has no score at all —
      // the distinction every caller of this fixture is actually testing
      // (ticket e8e59e6).
      matchScore: 60,
      rationale: `fake rationale for ${jobArg.title}`,
      strengths: [],
      gaps: [],
    };
  };
  return { scoreJob, calls: () => calls };
}

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-match-test-"));
const outputPath = path.join(outputDir, "match-results.json");
/** Default `usageStatsPath` for every test below (ticket 16c824a) — a tmp
 * file, never the real `prep/scoring-usage-stats.json`, so test runs can
 * never pollute (or be polluted by) real recorded usage. Individual tests
 * that need to exercise the "measured" cost-estimate path use their own
 * path instead, so they don't share state with each other. */
const usageStatsPath = path.join(outputDir, "scoring-usage-stats.json");

/** Every RESUME_TEXT below is prefixed with this. `afterAll` sweeps rows by
 * exact text, which only catches what THIS run created — a hard process
 * kill (not a thrown error; that's already covered by resolving ids via
 * SELECT, see below) skips `afterAll` entirely and leaks a row under a
 * `randomUUID()` no later run will ever generate again. A shared,
 * recognizable prefix means a leaked row can still be found and swept by
 * hand (`resume_text LIKE 'ticket-620ca30-demo-match-test: %'`) — the
 * per-run UUID after it still keeps every run's own rows distinct from
 * each other. */
const RESUME_TEXT_PREFIX = "ticket-620ca30-demo-match-test:";

/**
 * Filler long enough that `RESUME_TEXT_PREFIX + " " + <id> + " " +
 * LONG_RESUME_FILLER` clears `CACHE_MIN_PREFIX_TOKENS` (1,024) once run
 * through `buildCachedPrefix`/`CHARS_PER_TOKEN_ESTIMATE` — ticket aff284b
 * review round 3 F4 makes `estimateScoringCost`'s "measured" path branch on
 * real prefix length, so any test asserting the NORMAL (caching-assumed)
 * measured-cost formulas needs resume text that actually clears the
 * minimum, not an arbitrarily short placeholder string. 6,200 chars
 * (measured: 200 reps of a 31-char string) is comfortably over the
 * ~4,100-char threshold with room to spare.
 */
const LONG_RESUME_FILLER = "Experienced software engineer. ".repeat(200);

// What this test FILE owns. Populated by each describe block's own
// `beforeAll` (see below) — which run at suite start, before any `it` in
// that describe, not from any `it`'s outcome — so these arrays are
// complete before the top-level `afterAll` below ever runs, independent
// of whether `runDemoMatch` succeeds or throws inside a given `it`.
//
// The previous version of this cleanup derived resumeId/searchId from
// `runDemoMatch`'s *return value*. That's wrong: runDemoMatch inserts
// `searches`, `search_sources`, `jobs` and `search_results` rows well
// before it can return, so any throw partway through (the exact case
// finding #2's flaky-scorer test exists to cover, and the exact case a
// real Anthropic outage would produce) leaks rows under ids the test
// never learned. `afterAll`'s cleanup would then try to delete `jobs`
// while an orphaned `search_results` row still referenced them, hit a
// foreign key violation, throw, and skip every delete after it —
// including `resumes` — permanently accumulating rows in the shared dev
// database across every future run of this suite (ticket 620ca30 review
// finding B2). Resolving ids by SELECT from data this file hard-codes
// (RESUME_TEXT constants, externalIds) instead of trusting a return value
// fixes that: cleanup works identically whether the run that created
// those rows succeeded or threw.
const allExternalIds: string[] = [];
const allResumeTexts: string[] = [];

beforeAll(async () => {
  await client.connect();
});

/** Runs `fn`, logging (not throwing) on failure, so one statement failing
 * — e.g. because a prior run left the database in a state this cleanup
 * doesn't fully anticipate — can't skip every statement after it. */
async function safeDelete(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[demo-match.test.ts afterAll] cleanup step "${label}" failed:`, err);
  }
}

afterAll(async () => {
  // Resolve everything by SELECT from the statically-known externalIds/
  // resumeTexts above — never from a runDemoMatch return value (see the
  // comment on those arrays). Each resolution is independent of the
  // others succeeding.
  let jobIds: string[] = [];
  let resumeIds: string[] = [];
  let searchIds: string[] = [];

  if (allExternalIds.length > 0) {
    const rows = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(eq(jobsTable.dataSource, DATA_SOURCE), inArray(jobsTable.externalId, allExternalIds)),
      );
    jobIds = rows.map((r) => r.id);
  }
  if (allResumeTexts.length > 0) {
    const rows = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(inArray(resumes.resumeText, allResumeTexts));
    resumeIds = rows.map((r) => r.id);
  }
  if (resumeIds.length > 0) {
    const rows = await db
      .select({ id: searches.id })
      .from(searches)
      .where(inArray(searches.resumeId, resumeIds));
    searchIds = rows.map((r) => r.id);
  }

  // Children before parents: search_results/search_sources/job_matches
  // reference jobs/searches/resumes, so they must go first or the
  // corresponding parent delete hits a foreign key violation.
  if (jobIds.length > 0 || searchIds.length > 0) {
    await safeDelete("search_results", () =>
      db
        .delete(searchResults)
        .where(
          or(
            jobIds.length > 0 ? inArray(searchResults.jobId, jobIds) : undefined,
            searchIds.length > 0 ? inArray(searchResults.searchId, searchIds) : undefined,
          ),
        ),
    );
  }
  if (searchIds.length > 0) {
    await safeDelete("search_sources", () =>
      db.delete(searchSources).where(inArray(searchSources.searchId, searchIds)),
    );
  }
  if (resumeIds.length > 0 || jobIds.length > 0) {
    await safeDelete("job_matches", () =>
      db
        .delete(jobMatches)
        .where(
          or(
            resumeIds.length > 0 ? inArray(jobMatches.resumeId, resumeIds) : undefined,
            jobIds.length > 0 ? inArray(jobMatches.jobId, jobIds) : undefined,
          ),
        ),
    );
  }
  if (allExternalIds.length > 0) {
    await safeDelete("jobs", () =>
      db
        .delete(jobsTable)
        .where(
          and(eq(jobsTable.dataSource, DATA_SOURCE), inArray(jobsTable.externalId, allExternalIds)),
        ),
    );
  }
  if (searchIds.length > 0) {
    await safeDelete("searches", () => db.delete(searches).where(inArray(searches.id, searchIds)));
  }
  if (allResumeTexts.length > 0) {
    await safeDelete("resumes", () =>
      db.delete(resumes).where(inArray(resumes.resumeText, allResumeTexts)),
    );
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  await client.end();
});

describe("runDemoMatch (ticket 620ca30)", () => {
  const FAKE_JOBS: NormalizedJob[] = [
    job("demo-match-test-1", "Widget Engineer"),
    job("demo-match-test-2", "Gadget Engineer"),
    job("demo-match-test-3", "Gizmo Engineer"),
  ];
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} main ${randomUUID()}`;
  let firstRunResumeId: string | undefined;

  beforeAll(() => {
    allExternalIds.push(...FAKE_JOBS.map((j) => j.externalId));
    allResumeTexts.push(RESUME_TEXT);
  });

  it("scores every job on the first run, then scores ZERO jobs on a second run against the same candidates", async () => {
    const scorer = makeCountingScorer();
    const source = new FakeSource(FAKE_JOBS);

    const first = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });
    firstRunResumeId = first.resumeId;

    expect(first.newlyScored).toBe(FAKE_JOBS.length);
    expect(first.skipped).toBe(0);
    expect(first.failed).toBe(0);
    expect(scorer.calls()).toBe(FAKE_JOBS.length);
    expect(first.results).toHaveLength(FAKE_JOBS.length);
    // Ranked descending by matchScore.
    for (let i = 1; i < first.results.length; i++) {
      expect(first.results[i - 1]!.matchScore).toBeGreaterThanOrEqual(first.results[i]!.matchScore);
    }
    // strengths/gaps persisted and returned, not silently dropped.
    for (const r of first.results) {
      expect(r.strengths.length).toBeGreaterThan(0);
      expect(r.gaps.length).toBeGreaterThan(0);
    }

    // Same posting ingested twice (via the same call, and again below)
    // must produce exactly one `jobs` row per external id.
    const jobRowsAfterFirst = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.dataSource, DATA_SOURCE),
          inArray(
            jobsTable.externalId,
            FAKE_JOBS.map((j) => j.externalId),
          ),
        ),
      );
    expect(jobRowsAfterFirst).toHaveLength(FAKE_JOBS.length);

    // --- second run: identical resume, identical candidate jobs ---
    const second = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    // The acceptance criterion: nothing new to score, so zero Claude
    // calls happen on the second run.
    expect(second.newlyScored).toBe(0);
    expect(second.skipped).toBe(FAKE_JOBS.length);
    expect(second.failed).toBe(0);
    expect(scorer.calls()).toBe(FAKE_JOBS.length); // unchanged from the first run

    // Results still come back in full — from the database, not from this
    // (empty) run's scoring — so a second run isn't a worse UX than the
    // first. strengths/gaps still present, read back from jsonb columns.
    expect(second.results).toHaveLength(FAKE_JOBS.length);
    expect(new Set(second.results.map((r) => r.externalId))).toEqual(
      new Set(first.results.map((r) => r.externalId)),
    );
    for (const r of second.results) {
      expect(r.strengths.length).toBeGreaterThan(0);
      expect(r.gaps.length).toBeGreaterThan(0);
    }

    // Still exactly one `jobs` row per external id — re-ingesting the same
    // postings a second time did not create duplicates.
    const jobRowsAfterSecond = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.dataSource, DATA_SOURCE),
          inArray(
            jobsTable.externalId,
            FAKE_JOBS.map((j) => j.externalId),
          ),
        ),
      );
    expect(jobRowsAfterSecond).toHaveLength(FAKE_JOBS.length);

    // And exactly one job_matches row per (resume, job) — the unique
    // constraint plus the skip-if-already-scored logic together mean no
    // duplicate scoring rows ever land.
    const matchRows = await db
      .select()
      .from(jobMatches)
      .where(eq(jobMatches.resumeId, first.resumeId));
    expect(matchRows).toHaveLength(FAKE_JOBS.length);

    // The output file reflects the database-backed second-run results.
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8")) as unknown[];
    expect(written).toHaveLength(FAKE_JOBS.length);
  });

  it("reuses the same resumes row for identical resume text instead of inserting a duplicate", async () => {
    const scorer = makeCountingScorer();
    const source = new FakeSource(FAKE_JOBS);

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(run.resumeId).toBe(firstRunResumeId);

    const resumeRows = await db.select().from(resumes).where(eq(resumes.resumeText, RESUME_TEXT));
    expect(resumeRows).toHaveLength(1);
  });
});

describe("runDemoMatch: a scorer that throws for one job (ticket 620ca30 review finding #2)", () => {
  const FAKE_JOBS: NormalizedJob[] = [
    job("demo-match-flaky-1", "Widget Engineer"),
    job("demo-match-flaky-2", "Gadget Engineer"),
    job("demo-match-flaky-3", "Gizmo Engineer"),
  ];
  const FAILING_EXTERNAL_ID = "demo-match-flaky-2";
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} flaky-scorer ${randomUUID()}`;

  beforeAll(() => {
    allExternalIds.push(...FAKE_JOBS.map((j) => j.externalId));
    allResumeTexts.push(RESUME_TEXT);
  });

  it("persists the fulfilled scores from a partially-failed batch instead of discarding all of them", async () => {
    const source = new FakeSource(FAKE_JOBS);
    const flaky = makeFlakyScorer(new Set([FAILING_EXTERNAL_ID]));

    const first = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: flaky.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    // 3 candidates, 1 throws: 2 fulfilled scores get persisted, not 0.
    expect(flaky.calls()).toBe(3);
    expect(first.newlyScored).toBe(2);
    expect(first.failed).toBe(1);
    expect(first.skipped).toBe(0);
    expect(first.results).toHaveLength(2);

    const matchRowsAfterFirst = await db
      .select()
      .from(jobMatches)
      .where(eq(jobMatches.resumeId, first.resumeId));
    expect(matchRowsAfterFirst).toHaveLength(2);

    // --- rerun with a scorer that no longer fails ---
    // The already-succeeded 2 jobs must NOT be re-billed; only the job
    // that failed last time should be retried.
    const fixed = makeCountingScorer();
    const second = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: fixed.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(fixed.calls()).toBe(1); // only the previously-failed job
    expect(second.newlyScored).toBe(1);
    expect(second.skipped).toBe(2);
    expect(second.failed).toBe(0);
    // The retried job now appears in the ranked list alongside the two that
    // succeeded the first time. This is the DISPLAY claim, and it only
    // holds because both fixture scorers involved clear MATCH_SCORE_FLOOR
    // (makeFlakyScorer's flat 60, makeCountingScorer's COUNTING_SCORER_BASE
    // + n) — ticket e8e59e6. The PERSISTENCE claim this test exists for
    // ("all 3 now have a score") is the floor-blind job_matches count
    // immediately below; that one is what must never regress.
    expect(second.results).toHaveLength(3);

    const matchRowsAfterSecond = await db
      .select()
      .from(jobMatches)
      .where(eq(jobMatches.resumeId, first.resumeId));
    expect(matchRowsAfterSecond).toHaveLength(3);
  });
});

describe("runDemoMatch: filter hook", () => {
  const FAKE_JOBS: NormalizedJob[] = [
    job("demo-match-filter-1", "Widget Engineer"),
    job("demo-match-filter-2", "Sales Development Rep"),
    job("demo-match-filter-3", "Widget Support Specialist"),
  ];
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} filter-hook ${randomUUID()}`;

  beforeAll(() => {
    allExternalIds.push(...FAKE_JOBS.map((j) => j.externalId));
    allResumeTexts.push(RESUME_TEXT);
  });

  it("narrows the shortlist before scoring when a filter is provided, and scores everything when it is not", async () => {
    const source = new FakeSource(FAKE_JOBS);
    const scorer = makeCountingScorer();

    // Only the posting with "Engineer" in the title survives — proves
    // `filter` runs before scoring, not merely as decoration on the output.
    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
      filter: (jobs) => jobs.filter((j) => j.title.includes("Engineer")),
    });

    expect(scorer.calls()).toBe(1);
    expect(run.newlyScored).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.title).toBe("Widget Engineer");
  });
});

describe("runDemoMatch: the searches row survives a rejection during fetch/filter (ticket 59fdc52 review round 3, N2)", () => {
  const FAKE_JOBS: NormalizedJob[] = [job("demo-match-n2-1", "Widget Engineer")];
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} n2-filter-throws ${randomUUID()}`;

  beforeAll(() => {
    allResumeTexts.push(RESUME_TEXT);
    // Deliberately NOT pushing FAKE_JOBS' externalIds to allExternalIds:
    // a throwing filter (below) means `runDemoMatch` never reaches
    // ingestion, so no `jobs` row is ever created for this test — nothing
    // there needs cleanup registration.
  });

  it("creates the searches row BEFORE fetch/filter run, so a throw there still leaves it findable", async () => {
    // Previously, the `searches` row was inserted AFTER
    // `CompositeSource#search` and `filter` both ran — either of which can
    // reject (a caller-supplied `filter`, in particular, is arbitrary
    // code). If it did, `runDemoMatch`'s promise rejected before any
    // `searches` row existed at all. The REST API's `POST /searches` catch
    // handler (`markSearchFailed`, routes/searches.ts) does
    // `UPDATE searches SET status = 'failed' WHERE id = searchId` — against
    // a row that was never created, that UPDATE silently matches zero rows,
    // and the id 404s on every later `GET /searches/:id`, even immediately,
    // even before any restart. This test proves the row exists regardless
    // of where in fetch/filter the rejection happens.
    const source = new FakeSource(FAKE_JOBS);
    const scorer = makeCountingScorer();
    const throwingFilter = (): NormalizedJob[] => {
      throw new Error("simulated filter bug (N2 regression test)");
    };

    await expect(
      runDemoMatch({
        db,
        sources: [source],
        resumeText: RESUME_TEXT,
        scoreJob: scorer.scoreJob,
        outputPath,
        usageStatsPath,
        log: () => {},
        filter: throwingFilter,
      }),
    ).rejects.toThrow("simulated filter bug (N2 regression test)");

    // The scorer was never reached — the throw happened well before
    // scoring, which is exactly why the OLD searches-row-insert-after-
    // filter ordering left nothing behind for a caller to mark failed.
    expect(scorer.calls()).toBe(0);

    const resumeRows = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.resumeText, RESUME_TEXT));
    expect(resumeRows).toHaveLength(1);

    const searchRows = await db
      .select({ id: searches.id, status: searches.status })
      .from(searches)
      .where(eq(searches.resumeId, resumeRows[0]!.id));
    expect(searchRows).toHaveLength(1);
    // Never reached markSearchComplete (demo-match.ts) — the row is exactly
    // where a caller's own failure handler needs to find it: existing, and
    // still at its 'running' default, ready to be marked 'failed'.
    expect(searchRows[0]!.status).toBe("running");
  });
});

/** A FakeSource that also returns `tokenOutcomes`, for exercising the
 * board-coverage reporting added by ticket b723fb9. Kept separate from
 * the plain `FakeSource` above (which every pre-existing test relies on
 * returning exactly `{ jobs, skipped: [], skipRate: 0 }`) rather than
 * adding an optional constructor param there, so this ticket's addition
 * can't accidentally change behavior any existing test depends on. */
class FakeSourceWithTokenOutcomes implements JobSource {
  readonly dataSource = DATA_SOURCE;
  constructor(
    private readonly jobsToReturn: NormalizedJob[],
    private readonly tokenOutcomes: TokenOutcome[],
  ) {}
  async search(): Promise<SourceSearchResult> {
    return {
      jobs: this.jobsToReturn,
      skipped: [],
      skipRate: 0,
      tokenOutcomes: this.tokenOutcomes,
    };
  }
}

/** Fills in the two fields ticket b723fb9's review added
 * (`message`/`skippedCount`) with their common "nothing unusual" values, so
 * test fixtures below can state only what varies per case. */
function outcome(partial: Omit<TokenOutcome, "message" | "skippedCount">): TokenOutcome {
  return { message: undefined, skippedCount: 0, ...partial };
}

describe("runDemoMatch: board coverage (ticket b723fb9)", () => {
  const FAKE_JOBS: NormalizedJob[] = [
    { ...job("demo-match-coverage-1", "Backend Engineer"), company: "Acme" },
    { ...job("demo-match-coverage-2", "Backend Engineer"), company: "Widgetco" },
  ];
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} board-coverage ${randomUUID()}`;

  beforeAll(() => {
    allExternalIds.push(...FAKE_JOBS.map((j) => j.externalId));
    allResumeTexts.push(RESUME_TEXT);
  });

  it("distinguishes a 404'd token, an empty board, a fetch error, a board whose postings all failed filtering, and a board with a survivor — end to end through runDemoMatch", async () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "ghost-co", status: "not-found", postingCount: 0, companyName: undefined }),
      outcome({ token: "quiet-co", status: "empty", postingCount: 0, companyName: undefined }),
      {
        token: "flaky-co",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: "timed out after 15000ms",
        skippedCount: 0,
      },
      outcome({ token: "widgetco", status: "ok", postingCount: 1, companyName: "Widgetco" }),
      outcome({ token: "acme", status: "ok", postingCount: 1, companyName: "Acme" }),
    ];
    const source = new FakeSourceWithTokenOutcomes(FAKE_JOBS, tokenOutcomes);
    const scorer = makeCountingScorer();

    // Only Acme's posting survives — Widgetco's identical title still gets
    // filtered out, so its board reads "ok" (real, has a posting) with
    // zero survivors, distinct from ghost-co (404), flaky-co (fetch
    // error), and quiet-co (real, zero postings).
    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
      filter: (jobs) => jobs.filter((j) => j.company === "Acme"),
    });

    // sourceOutcomes has exactly one entry (only one source was searched),
    // carrying this source's own funnel numbers plus its per-token
    // breakdown, unchanged in shape from the old top-level `boardCoverage`.
    expect(run.sourceOutcomes).toHaveLength(1);
    const [so] = run.sourceOutcomes;
    expect(so).toMatchObject({
      dataSource: DATA_SOURCE,
      status: "ok",
      jobsFound: FAKE_JOBS.length,
      skippedCount: 0,
      skipRate: 0,
      survivedFilter: 1,
    });
    expect(so!.boardCoverage).toEqual([
      {
        token: "ghost-co",
        status: "not-found",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
        survivedFilter: 0,
      },
      {
        token: "quiet-co",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
        survivedFilter: 0,
      },
      {
        token: "flaky-co",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: "timed out after 15000ms",
        skippedCount: 0,
        survivedFilter: 0,
      },
      {
        token: "widgetco",
        status: "ok",
        postingCount: 1,
        companyName: "Widgetco",
        message: undefined,
        skippedCount: 0,
        survivedFilter: 0,
      },
      {
        token: "acme",
        status: "ok",
        postingCount: 1,
        companyName: "Acme",
        message: undefined,
        skippedCount: 0,
        survivedFilter: 1,
      },
    ]);
  });

  it("is an empty array when the source doesn't populate tokenOutcomes (plain FakeSource)", async () => {
    const source = new FakeSource([]);
    const scorer = makeCountingScorer();

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: `${RESUME_TEXT_PREFIX} board-coverage-none ${randomUUID()}`,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(run.sourceOutcomes).toHaveLength(1);
    expect(run.sourceOutcomes[0]!.boardCoverage).toEqual([]);
    // Zero jobs from this source this run -> "empty", not "ok".
    expect(run.sourceOutcomes[0]!.status).toBe("empty");
  });
});

describe("runDemoMatch: multiple sources (ticket d8417b2)", () => {
  const GH_JOBS: NormalizedJob[] = [
    { ...job("demo-match-multi-gh-1", "Backend Engineer"), dataSource: "greenhouse" },
  ];
  const LEVER_JOBS: NormalizedJob[] = [
    { ...job("demo-match-multi-lv-1", "Frontend Engineer"), dataSource: "lever" },
  ];
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} multi-source ${randomUUID()}`;

  beforeAll(() => {
    // Deliberately NOT pushed to the shared `allExternalIds` array: that
    // array is only ever queried under `eq(jobsTable.dataSource,
    // DATA_SOURCE)` ("usajobs") by the top-level `afterAll` below, so an
    // externalId tagged "greenhouse"/"lever" would never match there
    // anyway. `allResumeTexts` IS shared — resuming via resumeId/searchId
    // is dataSource-agnostic, so the top-level afterAll's job_matches/
    // search_results/searches/resumes cleanup still reaches these rows.
    // Only the `jobs` rows themselves (dataSource "greenhouse"/"lever")
    // need this describe's own cleanup, below.
    allResumeTexts.push(RESUME_TEXT);
  });

  afterAll(async () => {
    // Self-contained, not dependent on running before/after the top-level
    // afterAll: resolves and deletes children before parents itself,
    // rather than assuming the top-level afterAll's later job_matches/
    // search_results cleanup (keyed by resumeId/searchId, not by these
    // jobs' dataSource) will have already run. Nested `afterAll` hooks run
    // before an outer, top-level one, so if this deleted `jobs` rows
    // directly while a job_matches/search_results row still referenced
    // them, the FK constraint would reject it.
    const jobRows = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        or(
          and(
            eq(jobsTable.dataSource, "greenhouse"),
            inArray(
              jobsTable.externalId,
              GH_JOBS.map((j) => j.externalId),
            ),
          ),
          and(
            eq(jobsTable.dataSource, "lever"),
            inArray(
              jobsTable.externalId,
              LEVER_JOBS.map((j) => j.externalId),
            ),
          ),
        ),
      );
    const jobIds = jobRows.map((r) => r.id);
    if (jobIds.length > 0) {
      await safeDelete("multi-source search_results", () =>
        db.delete(searchResults).where(inArray(searchResults.jobId, jobIds)),
      );
      await safeDelete("multi-source job_matches", () =>
        db.delete(jobMatches).where(inArray(jobMatches.jobId, jobIds)),
      );
      await safeDelete("multi-source jobs", () =>
        db.delete(jobsTable).where(inArray(jobsTable.id, jobIds)),
      );
    }
  });

  it("merges jobs from every configured source into one shortlist and ingests each under its own dataSource", async () => {
    class GreenhouseFake implements JobSource {
      readonly dataSource = "greenhouse" as const;
      async search(): Promise<SourceSearchResult> {
        return { jobs: GH_JOBS, skipped: [], skipRate: 0 };
      }
    }
    class LeverFake implements JobSource {
      readonly dataSource = "lever" as const;
      async search(): Promise<SourceSearchResult> {
        return { jobs: LEVER_JOBS, skipped: [], skipRate: 0 };
      }
    }
    const scorer = makeCountingScorer();

    const run = await runDemoMatch({
      db,
      sources: [new GreenhouseFake(), new LeverFake()],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    // Both sources' jobs made it into the shortlist and got scored — not
    // just the first source configured.
    expect(scorer.calls()).toBe(2);
    expect(run.newlyScored).toBe(2);
    expect(run.results.map((r) => r.title).sort()).toEqual([
      "Backend Engineer",
      "Frontend Engineer",
    ]);

    // One SourceOutcome per configured source — health stays per-source,
    // not averaged into one number.
    expect(run.sourceOutcomes).toHaveLength(2);
    const byDataSource = new Map(run.sourceOutcomes.map((so) => [so.dataSource, so]));
    expect(byDataSource.get("greenhouse")).toMatchObject({ status: "ok", jobsFound: 1 });
    expect(byDataSource.get("lever")).toMatchObject({ status: "ok", jobsFound: 1 });

    // Both jobs actually landed in `jobs` under their OWN dataSource, not
    // collapsed onto a single one.
    const ghRows = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.dataSource, "greenhouse"),
          eq(jobsTable.externalId, "demo-match-multi-gh-1"),
        ),
      );
    expect(ghRows).toHaveLength(1);
    const lvRows = await db
      .select()
      .from(jobsTable)
      .where(
        and(eq(jobsTable.dataSource, "lever"), eq(jobsTable.externalId, "demo-match-multi-lv-1")),
      );
    expect(lvRows).toHaveLength(1);
  });

  it("one source's search() rejecting does not prevent the other configured sources from returning and scoring jobs", async () => {
    class GreenhouseFake implements JobSource {
      readonly dataSource = "greenhouse" as const;
      async search(): Promise<SourceSearchResult> {
        return { jobs: GH_JOBS, skipped: [], skipRate: 0 };
      }
    }
    class BrokenLever implements JobSource {
      readonly dataSource = "lever" as const;
      async search(): Promise<SourceSearchResult> {
        throw new Error("simulated total Lever outage");
      }
    }
    const scorer = makeCountingScorer();
    const RESUME_TEXT_2 = `${RESUME_TEXT_PREFIX} multi-source-partial-failure ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT_2);

    const run = await runDemoMatch({
      db,
      sources: [new GreenhouseFake(), new BrokenLever()],
      resumeText: RESUME_TEXT_2,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    // Greenhouse's job still made it all the way through scoring despite
    // Lever's search() rejecting outright.
    expect(run.newlyScored).toBe(1);
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.title).toBe("Backend Engineer");

    // Lever's failure is visible, distinctly, not silently dropped and not
    // indistinguishable from "Lever returned nothing".
    const byDataSource = new Map(run.sourceOutcomes.map((so) => [so.dataSource, so]));
    expect(byDataSource.get("greenhouse")).toMatchObject({ status: "ok", jobsFound: 1 });
    const leverOutcome = byDataSource.get("lever")!;
    expect(leverOutcome.status).toBe("error");
    expect(leverOutcome.errorMessage).toBe("simulated total Lever outage");
    expect(leverOutcome.jobsFound).toBe(0);
  });

  it("throws synchronously when called with an empty sources array", async () => {
    const scorer = makeCountingScorer();
    await expect(
      runDemoMatch({
        db,
        sources: [],
        resumeText: `${RESUME_TEXT_PREFIX} empty-sources ${randomUUID()}`,
        scoreJob: scorer.scoreJob,
        outputPath,
        usageStatsPath,
        log: () => {},
      }),
    ).rejects.toThrow(/at least one JobSource/);
  });
});

describe("runDemoMatch: spend guard (ticket 16c824a)", () => {
  // 20 candidates from one source, deliberately more than the old
  // MAX_JOBS=12 that used to silently slice this list in source/board
  // iteration order — this is the "employer late in the token list" the
  // original ticket's acceptance criteria asked for a test proving.
  const MANY_JOBS: NormalizedJob[] = Array.from({ length: 20 }, (_, i) => ({
    ...job(`demo-match-spend-guard-order-${i}`, `Engineer ${i}`),
    company: i === 19 ? "Last-In-Order Co" : "Test Co",
  }));
  const CAP_JOBS: NormalizedJob[] = Array.from({ length: 5 }, (_, i) =>
    job(`demo-match-spend-guard-cap-${i}`, `Engineer ${i}`),
  );

  beforeAll(() => {
    allExternalIds.push(
      ...MANY_JOBS.map((j) => j.externalId),
      ...CAP_JOBS.map((j) => j.externalId),
    );
  });

  it("does not truncate by iteration order — a candidate late in a pool well under the default threshold still gets scored", async () => {
    const source = new FakeSource(MANY_JOBS);
    const scorer = makeCountingScorer();
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-order ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(run.candidatesNeedingScore).toBe(MANY_JOBS.length);
    expect(run.cappedCount).toBe(0);
    expect(run.newlyScored).toBe(MANY_JOBS.length);
    expect(scorer.calls()).toBe(MANY_JOBS.length);
    // The LAST job in the source's iteration order — exactly what MAX_JOBS
    // used to drop — made it all the way to a persisted score.
    expect(run.results.some((r) => r.company === "Last-In-Order Co")).toBe(true);
  });

  it("caps scoring at scoreThreshold when the pool needing new scores exceeds it, and states the cap plainly", async () => {
    const source = new FakeSource(CAP_JOBS);
    const scorer = makeCountingScorer();
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-cap ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);
    const logs: string[] = [];

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      scoreThreshold: 2,
      outputPath,
      usageStatsPath,
      log: (m) => logs.push(m),
    });

    expect(run.candidatesNeedingScore).toBe(5);
    expect(run.cappedCount).toBe(3);
    expect(run.newlyScored).toBe(2);
    expect(run.failed).toBe(0);
    expect(scorer.calls()).toBe(2);
    expect(run.results).toHaveLength(2);

    // A truncated run must never read like a complete one (ticket 16c824a
    // review F2: the numbers here must close exactly — 0 already scored +
    // 2 scored this run + 0 failed + 3 capped === 5 candidates).
    expect(
      logs.some((line) =>
        line.includes(
          "5 candidate(s): 0 already scored, 2 scored this run, 0 failed, 3 not scored (cap)",
        ),
      ),
    ).toBe(true);
  });

  it("F2/F3: cap arithmetic closes exactly (including already-scored jobs and a failing call), and the capped-out jobs are pinned as a recorded decision, not an accident", async () => {
    const ALL_JOBS: NormalizedJob[] = Array.from({ length: 10 }, (_, i) =>
      job(`demo-match-spend-guard-f2f3-${i}`, `F2F3 Engineer ${i}`),
    );
    allExternalIds.push(...ALL_JOBS.map((j) => j.externalId));
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-f2f3 ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);
    const source = new FakeSource(ALL_JOBS);

    // Run 0: pre-score ONLY the first 4 (indices 0-3), via a filter — these
    // are "already scored" going into run 1 below.
    const preScore = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: makeCountingScorer().scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
      filter: (jobs) => jobs.filter((j) => Number(j.externalId.split("-").pop()) < 4),
    });
    expect(preScore.newlyScored).toBe(4);

    // Run 1: the FULL pool (all 10). Of the 6 needing a score (indices
    // 4-9, in that order), a flaky scorer fails index 4 specifically, and
    // scoreThreshold=3 caps the attempt at the first 3 of those 6 (4,5,6)
    // — so 7,8,9 are capped out.
    const FAILING_EXTERNAL_ID = "demo-match-spend-guard-f2f3-4";
    const flaky = makeFlakyScorer(new Set([FAILING_EXTERNAL_ID]));
    const logs: string[] = [];

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: flaky.scoreJob,
      scoreThreshold: 3,
      outputPath,
      usageStatsPath,
      log: (m) => logs.push(m),
    });

    // The arithmetic itself (ticket 16c824a review F2): every one of the
    // 10 linked candidates is accounted for exactly once.
    expect(run.skipped).toBe(4);
    expect(run.candidatesNeedingScore).toBe(6);
    expect(run.newlyScored).toBe(2);
    expect(run.failed).toBe(1);
    expect(run.cappedCount).toBe(3);
    expect(run.skipped + run.newlyScored + run.failed + run.cappedCount).toBe(10);

    // WHICH jobs the cap selected is pinned, not accidental (ticket
    // 16c824a review F3): 0-3 were pre-scored, 4 failed (will retry), 5-6
    // were newly scored this run, and 7-9 are the ones the cap dropped.
    //
    // Read from `job_matches` directly rather than from `run.results`
    // (ticket e8e59e6). What F3 pins is which jobs the run decided to spend
    // a scoring call on and RECORDED — a persistence fact. `run.results` is
    // the floor-filtered display list (`applyMatchScoreFloor`, ticket
    // 1b9f81e), so a job can be correctly scored and persisted and still be
    // absent from it merely for scoring below 55. Using it here conflated
    // "the cap skipped this job" with "this job scored badly" — two
    // different outcomes that must not share one assertion. The DB query
    // below can only distinguish them: a row exists iff a score was
    // computed and persisted, whatever its value.
    const scoredRows = await db
      .select({ title: jobsTable.title })
      .from(jobMatches)
      .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
      .where(eq(jobMatches.resumeId, run.resumeId));
    const scoredTitles = scoredRows.map((r) => r.title);
    // Exactly the 6 below and nothing else — this resume is unique to this
    // test, so every job_matches row under it came from these two runs.
    expect(scoredTitles).toHaveLength(6);
    for (const i of [0, 1, 2, 3, 5, 6]) {
      expect(scoredTitles).toContain(`F2F3 Engineer ${i}`);
    }
    for (const i of [4, 7, 8, 9]) {
      expect(scoredTitles).not.toContain(`F2F3 Engineer ${i}`);
    }

    // The post-scoring log line reflects what ACTUALLY happened (not a
    // pre-scoring prediction a failure could falsify), closes arithmetically,
    // and states that a plain rerun drains the cap for free.
    const capLine = logs.find((l) => l.includes("not scored (cap)"));
    expect(capLine).toBeDefined();
    expect(capLine).toContain("10 candidate(s)");
    expect(capLine).toContain("4 already scored");
    expect(capLine).toContain("2 scored this run");
    expect(capLine).toContain("1 failed");
    expect(capLine).toContain("3 not scored (cap)");
    expect(capLine).toMatch(/rerun/i);
  });

  it("F1: a failing usage-stats write does not discard already-persisted, already-paid-for scores", async () => {
    const F1_JOBS: NormalizedJob[] = [
      job("demo-match-spend-guard-f1-1", "F1 Engineer 1"),
      job("demo-match-spend-guard-f1-2", "F1 Engineer 2"),
      job("demo-match-spend-guard-f1-3", "F1 Engineer 3"),
    ];
    allExternalIds.push(...F1_JOBS.map((j) => j.externalId));
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-f1 ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);

    // Points at a directory that does not exist — `fs.writeFileSync`
    // inside `recordUsageStats` throws ENOENT for this, every time.
    // Reproduces the review's live probe: 3 real (billed) scoring calls,
    // stats write fails, must NOT lose the 3 already-persisted scores.
    const unwritableUsageStatsPath = path.join(
      outputDir,
      "no-such-directory",
      `stats-${randomUUID()}.json`,
    );
    const logs: string[] = [];

    const run = await runDemoMatch({
      db,
      sources: [new FakeSource(F1_JOBS)],
      resumeText: RESUME_TEXT,
      scoreJob: makeUsageReportingScorer(1000, 200).scoreJob,
      outputPath,
      usageStatsPath: unwritableUsageStatsPath,
      log: (m) => logs.push(m),
    });

    // The 3 paid-for calls are ALL persisted — this is the whole point of
    // F1 — not discarded because the (unrelated, best-effort) stats write
    // failed.
    expect(run.newlyScored).toBe(3);
    expect(run.failed).toBe(0);
    expect(run.results).toHaveLength(3);

    // A second run against the same candidates makes ZERO new scoring
    // calls — proof the scores really did land in `job_matches`, not just
    // in this run's in-memory return value.
    const rerun = await runDemoMatch({
      db,
      sources: [new FakeSource(F1_JOBS)],
      resumeText: RESUME_TEXT,
      scoreJob: makeCountingScorer().scoreJob,
      outputPath,
      usageStatsPath: unwritableUsageStatsPath,
      log: () => {},
    });
    expect(rerun.newlyScored).toBe(0);
    expect(rerun.skipped).toBe(3);

    // The failure is surfaced, not swallowed silently.
    expect(logs.some((l) => l.includes("WARNING") && l.includes("usage stats"))).toBe(true);
    // And the stats file itself was never created (the directory doesn't
    // exist), proving the write genuinely failed rather than trivially
    // succeeding.
    expect(fs.existsSync(unwritableUsageStatsPath)).toBe(false);
  });

  it("scores every candidate when allowAboveThreshold is set, even above scoreThreshold", async () => {
    const source = new FakeSource(CAP_JOBS);
    const scorer = makeCountingScorer();
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-override ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      scoreThreshold: 2,
      allowAboveThreshold: true,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(run.candidatesNeedingScore).toBe(5);
    expect(run.cappedCount).toBe(0);
    expect(run.newlyScored).toBe(5);
    expect(scorer.calls()).toBe(5);
  });

  it("already-scored jobs count toward neither the cap nor the cost estimate — a full rerun costs nothing regardless of scoreThreshold", async () => {
    const source = new FakeSource(CAP_JOBS);
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-rerun-free ${randomUUID()}`;
    allResumeTexts.push(RESUME_TEXT);

    const first = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: makeCountingScorer().scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });
    expect(first.newlyScored).toBe(5);

    // A tiny threshold on the SECOND run must not cap anything: nothing
    // needs a new score, so there is nothing to cap or to spend on.
    const second = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob: makeCountingScorer().scoreJob,
      scoreThreshold: 1,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    expect(second.candidatesNeedingScore).toBe(0);
    expect(second.cappedCount).toBe(0);
    expect(second.newlyScored).toBe(0);
    expect(second.skipped).toBe(5);
    expect(second.costEstimate).toMatchObject({ jobCount: 0, estimatedCostUsd: 0 });
  });

  it("records real usage from a usage-reporting scorer, and a later run's cost estimate becomes 'measured'", async () => {
    const measuredUsageStatsPath = path.join(outputDir, `usage-measured-${randomUUID()}.json`);
    const RUN1_JOBS: NormalizedJob[] = [
      job("demo-match-spend-guard-measured-1", "Engineer 1"),
      job("demo-match-spend-guard-measured-2", "Engineer 2"),
      job("demo-match-spend-guard-measured-3", "Engineer 3"),
    ];
    const RUN2_JOBS: NormalizedJob[] = [
      job("demo-match-spend-guard-measured-4", "Engineer 4"),
      job("demo-match-spend-guard-measured-5", "Engineer 5"),
      job("demo-match-spend-guard-measured-6", "Engineer 6"),
    ];
    allExternalIds.push(
      ...RUN1_JOBS.map((j) => j.externalId),
      ...RUN2_JOBS.map((j) => j.externalId),
    );
    // Long enough to clear CACHE_MIN_PREFIX_TOKENS (see LONG_RESUME_FILLER's
    // doc comment) — this test asserts the NORMAL measured-basis formula
    // (avg * jobCount), which only applies once a resume's prefix actually
    // qualifies for caching.
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-measured ${randomUUID()} ${LONG_RESUME_FILLER}`;
    allResumeTexts.push(RESUME_TEXT);

    // No usage stats file exists yet for this path — the FIRST run must
    // fall back to the bootstrap estimate, not pretend to have measured
    // data.
    const first = await runDemoMatch({
      db,
      sources: [new FakeSource(RUN1_JOBS)],
      resumeText: RESUME_TEXT,
      scoreJob: makeUsageReportingScorer(1000, 200).scoreJob,
      outputPath,
      usageStatsPath: measuredUsageStatsPath,
      log: () => {},
    });
    expect(first.newlyScored).toBe(3);
    expect(first.costEstimate.basis).toBe("bootstrap");

    const statsAfterFirst = readUsageStats(measuredUsageStatsPath);
    expect(statsAfterFirst).toEqual({
      model: MODEL,
      calls: 3,
      totalInputTokens: 3000,
      totalOutputTokens: 600,
      // makeUsageReportingScorer reports plain {inputTokens, outputTokens}
      // usage (no cache fields) — ticket aff284b's recordUsageStats still
      // always writes concrete numbers, 0 here, not undefined.
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });

    // SECOND run, different candidates (nothing already scored), same
    // usage-stats file: the cost estimate must now be grounded in run 1's
    // real recorded usage instead of the bootstrap fallback.
    const second = await runDemoMatch({
      db,
      sources: [new FakeSource(RUN2_JOBS)],
      resumeText: RESUME_TEXT,
      scoreJob: makeUsageReportingScorer(1000, 200).scoreJob,
      outputPath,
      usageStatsPath: measuredUsageStatsPath,
      log: () => {},
    });
    expect(second.costEstimate.basis).toBe("measured");
    expect(second.costEstimate.estimatedInputTokens).toBe(3000); // avg 1000 * 3 jobs
    expect(second.costEstimate.estimatedOutputTokens).toBe(600); // avg 200 * 3 jobs
  });
});

describe("runDemoMatch: first-then-batch cache pre-warm ordering (ticket aff284b review R3)", () => {
  // The single mechanism the entire caching saving depends on: a cache
  // entry isn't readable until the WRITING call's response begins (see the
  // "do NOT collapse this back" comment on `[firstId, ...restIds]` in
  // demo-match.ts). Before this test, that shape was guarded only by a
  // comment — nothing here would have failed if someone collapsed it back
  // into a single `Promise.allSettled(toScoreIds.map(scoreOne))`.
  const PREWARM_JOBS: NormalizedJob[] = Array.from({ length: 4 }, (_, i) =>
    job(`demo-match-prewarm-${i}`, `Prewarm Engineer ${i}`),
  );
  const RESUME_TEXT = `${RESUME_TEXT_PREFIX} prewarm-ordering ${randomUUID()}`;

  beforeAll(() => {
    allExternalIds.push(...PREWARM_JOBS.map((j) => j.externalId));
    allResumeTexts.push(RESUME_TEXT);
  });

  /**
   * Records a `start:<id>` event the instant it's invoked (synchronously,
   * before any await) and a `resolve:<id>` event only after an artificial
   * delay — long enough that a batch of calls fired essentially
   * synchronously (the collapsed, buggy shape) will ALL have logged their
   * `start` event before any of them can log `resolve`, while calls fired
   * one-at-a-time-then-batch (the correct shape) cannot interleave a
   * second call's `start` before the first call's `resolve`, because
   * nothing invokes the second call until the first call's own
   * `Promise.allSettled` has already resolved.
   */
  function makeOrderTrackingScorer(): { scoreJob: ScoreJobFn; events: string[] } {
    const events: string[] = [];
    const scoreJob: ScoreJobFn = async (jobArg: NormalizedJob): Promise<ScoredJob> => {
      events.push(`start:${jobArg.externalId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`resolve:${jobArg.externalId}`);
      return {
        // Left at 50 (below MATCH_SCORE_FLOOR) deliberately, unlike the
        // fixtures raised for ticket e8e59e6: this test asserts only
        // `newlyScored` and the recorded call ORDER, never `run.results`,
        // so the floor's display filter cannot reach any of its
        // assertions — and a below-floor score here keeps at least one
        // integration fixture proving that scoring/persistence still
        // happen for jobs the floor will later hide.
        matchScore: 50,
        rationale: `fake rationale for ${jobArg.title}`,
        strengths: [],
        gaps: [],
      };
    };
    return { scoreJob, events };
  }

  it("awaits the first job's call to completion before any other job's call starts — fails if the two-phase structure is collapsed back into one batch", async () => {
    const source = new FakeSource(PREWARM_JOBS);
    const { scoreJob, events } = makeOrderTrackingScorer();

    const run = await runDemoMatch({
      db,
      sources: [source],
      resumeText: RESUME_TEXT,
      scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });

    // Sanity: every job really was scored (this test is about ORDERING,
    // not merely about all jobs eventually completing).
    expect(run.newlyScored).toBe(PREWARM_JOBS.length);
    expect(events.filter((e) => e.startsWith("start:"))).toHaveLength(PREWARM_JOBS.length);
    expect(events.filter((e) => e.startsWith("resolve:"))).toHaveLength(PREWARM_JOBS.length);

    // The very first event must be some job starting.
    expect(events[0]).toMatch(/^start:/);
    const firstJobId = events[0]!.slice("start:".length);

    // The SECOND event must be that SAME job resolving — nothing else can
    // have started in between, because phase 1 awaits
    // `Promise.allSettled([scoreOne(firstId)])` alone before phase 2 ever
    // calls `scoreOne` for any other job. If the two-phase structure were
    // collapsed into one `Promise.allSettled(toScoreIds.map(scoreOne))`,
    // every job's `start` event would be pushed synchronously before any
    // `resolve` event (the 20ms delay guarantees the timers can't fire
    // until the synchronous `.map()` call finishes), so `events[1]` would
    // be another job's `start:...`, not this job's `resolve:...` — this
    // assertion is exactly what would catch that regression.
    expect(events[1]).toBe(`resolve:${firstJobId}`);

    // Every OTHER job's `start` event occurs strictly after the first
    // job's own `resolve` event (index 1) — i.e. after the cache-writing
    // call has already completed.
    const otherStartIndices = PREWARM_JOBS.filter((j) => j.externalId !== firstJobId).map((j) =>
      events.indexOf(`start:${j.externalId}`),
    );
    for (const idx of otherStartIndices) {
      expect(idx).toBeGreaterThan(1);
    }
  });
});

describe("buildSourceOutcomes / describeSourceOutcome (ticket d8417b2)", () => {
  // No DB needed — pure functions, mirroring buildBoardCoverage's own
  // pure-function test suite one level up.
  it("reports 'error' with zeroed funnel numbers and no boardCoverage when a source's search() rejected", () => {
    const perSource: PerSourceOutcome[] = [
      { dataSource: "lever", status: "error", errorMessage: "network unreachable" },
    ];
    const outcomes = buildSourceOutcomes(perSource, []);
    expect(outcomes).toEqual([
      {
        dataSource: "lever",
        status: "error",
        jobsFound: 0,
        skippedCount: 0,
        skipRate: 0,
        survivedFilter: 0,
        errorMessage: "network unreachable",
        boardCoverage: [],
      },
    ]);
  });

  it("reports 'empty' (not 'ok') when a source succeeded but returned zero jobs", () => {
    const perSource: PerSourceOutcome[] = [
      { dataSource: "ashby", status: "ok", result: { jobs: [], skipped: [], skipRate: 0 } },
    ];
    const outcomes = buildSourceOutcomes(perSource, []);
    expect(outcomes[0]!.status).toBe("empty");
    expect(outcomes[0]!.jobsFound).toBe(0);
  });

  it("reports 'ok' with survivedFilter 0 when a source returned postings but none survived this run's filter — distinct from 'empty'", () => {
    const smartRecruitersJob = job("sr-1", "Sales Development Rep");
    const perSource: PerSourceOutcome[] = [
      {
        dataSource: "smartrecruiters",
        status: "ok",
        result: { jobs: [smartRecruitersJob], skipped: [], skipRate: 0 },
      },
    ];
    // Nothing survived `filter` this run (simulated: filtered is empty).
    const outcomes = buildSourceOutcomes(perSource, []);
    expect(outcomes[0]).toMatchObject({ status: "ok", jobsFound: 1, survivedFilter: 0 });
  });

  it("attributes survivedFilter by exact dataSource, never crediting one source's survivors to another", () => {
    const ghJob = { ...job("gh-1", "Backend Engineer"), dataSource: "greenhouse" as const };
    const lvJob = { ...job("lv-1", "Backend Engineer"), dataSource: "lever" as const };
    const perSource: PerSourceOutcome[] = [
      {
        dataSource: "greenhouse",
        status: "ok",
        result: { jobs: [ghJob], skipped: [], skipRate: 0 },
      },
      { dataSource: "lever", status: "ok", result: { jobs: [lvJob], skipped: [], skipRate: 0 } },
    ];
    // Both jobs "survived" (e.g. an identity filter) — each source's own
    // entry must credit only its own job.
    const outcomes = buildSourceOutcomes(perSource, [ghJob, lvJob]);
    const byDataSource = new Map(outcomes.map((o) => [o.dataSource, o]));
    expect(byDataSource.get("greenhouse")!.survivedFilter).toBe(1);
    expect(byDataSource.get("lever")!.survivedFilter).toBe(1);
  });

  it("describeSourceOutcome names 'ok', 'empty', and 'error' distinctly", () => {
    const ok: SourceOutcome = {
      dataSource: "greenhouse",
      status: "ok",
      jobsFound: 10,
      skippedCount: 1,
      skipRate: 0.1,
      survivedFilter: 3,
      errorMessage: undefined,
      boardCoverage: [],
    };
    const empty: SourceOutcome = {
      dataSource: "lever",
      status: "empty",
      jobsFound: 0,
      skippedCount: 0,
      skipRate: 0,
      survivedFilter: 0,
      errorMessage: undefined,
      boardCoverage: [],
    };
    const errored: SourceOutcome = {
      dataSource: "ashby",
      status: "error",
      jobsFound: 0,
      skippedCount: 0,
      skipRate: 0,
      survivedFilter: 0,
      errorMessage: "timed out",
      boardCoverage: [],
    };

    const descriptions = new Set([
      describeSourceOutcome(ok),
      describeSourceOutcome(empty),
      describeSourceOutcome(errored),
    ]);
    expect(descriptions.size).toBe(3);
    expect(describeSourceOutcome(ok)).toMatch(/10 posting\(s\).*3 survived/);
    expect(describeSourceOutcome(empty)).toMatch(/0 postings/);
    expect(describeSourceOutcome(errored)).toMatch(/timed out/);
  });
});

describe("buildBoardCoverage / describeBoardOutcome (ticket b723fb9)", () => {
  // No DB needed — pure functions.
  it("returns [] when tokenOutcomes is undefined or empty", () => {
    expect(buildBoardCoverage(undefined, [])).toEqual([]);
    expect(buildBoardCoverage([], [])).toEqual([]);
  });

  it("matches survivors to a token by company name, case-insensitively, and reports 0 for a token with no companyName", () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "acme", status: "ok", postingCount: 5, companyName: "ACME Inc" }),
      outcome({ token: "no-name", status: "empty", postingCount: 0, companyName: undefined }),
    ];
    // "acme inc" (lowercase) must still match "ACME Inc" (companyName) —
    // and this is the ONLY survivor, so sum(survivedFilter) == 1 ==
    // filtered.length: no warning fires.
    const filtered: NormalizedJob[] = [
      { ...job("cov-1", "Backend Engineer"), company: "acme inc" },
    ];
    const warn = vi.fn();
    const coverage = buildBoardCoverage(tokenOutcomes, filtered, warn);

    expect(coverage).toEqual([
      {
        token: "acme",
        status: "ok",
        postingCount: 5,
        companyName: "ACME Inc",
        message: undefined,
        skippedCount: 0,
        survivedFilter: 1,
      },
      {
        token: "no-name",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
        survivedFilter: 0,
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  // Ticket b723fb9 review finding #1: the name correlation is latent, not
  // safe. These two cases are the reviewer's hazards A and C, made
  // concrete: the correlation silently mis-set survivedFilter, and this
  // guard is what makes that visible instead of silently wrong.
  it("hazard A: two tokens self-reporting the identical company name both claim every survivor (double-count) — and the invariant check warns", () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "acme-east", status: "ok", postingCount: 2, companyName: "Acme" }),
      outcome({ token: "acme-west", status: "ok", postingCount: 2, companyName: "Acme" }),
    ];
    const filtered: NormalizedJob[] = [
      { ...job("hazard-a-1", "Backend Engineer"), company: "Acme" },
      { ...job("hazard-a-2", "Backend Engineer"), company: "Acme" },
      { ...job("hazard-a-3", "Backend Engineer"), company: "Acme" },
    ];
    const warn = vi.fn();

    const coverage = buildBoardCoverage(tokenOutcomes, filtered, warn);

    // Documented, not desired: both entries report all 3 survivors — the
    // correlation cannot tell the two tokens apart by name alone.
    expect(coverage[0]!.survivedFilter).toBe(3);
    expect(coverage[1]!.survivedFilter).toBe(3);
    // Both checks fire independently: sum (6) != filtered.length (3), AND
    // "Acme" is a duplicate companyName across the two entries.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((call) => /sums? to 6/i.test(call[0] as string))).toBe(true);
    expect(warn.mock.calls.some((call) => /same company name/i.test(call[0] as string))).toBe(true);
  });

  // Ticket b723fb9 review round 2 (non-blocking finding): a matching sum
  // does NOT prove the report is correct — errors can cancel. Two tokens
  // double-counting 2 survivors up to 4 while a third, nameless token
  // under-counts its own 2 down to 0 nets to the same total (4 == 4), so
  // the sum check alone stays silent. This is exactly why
  // buildBoardCoverage also checks for duplicate companyNames
  // independently of whether the sum happens to match.
  it("hazard E: a double-count and an under-count can cancel in the sum, but the duplicate-name check still warns", () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "acme-east", status: "ok", postingCount: 2, companyName: "Acme" }),
      outcome({ token: "acme-west", status: "ok", postingCount: 2, companyName: "Acme" }),
      outcome({ token: "no-name", status: "ok", postingCount: 2, companyName: undefined }),
    ];
    const filtered: NormalizedJob[] = [
      { ...job("hazard-e-1", "Backend Engineer"), company: "Acme" },
      { ...job("hazard-e-2", "Backend Engineer"), company: "Acme" },
      { ...job("hazard-e-3", "Backend Engineer"), company: "Whoever" },
      { ...job("hazard-e-4", "Backend Engineer"), company: "Whoever" },
    ];
    const warn = vi.fn();

    const coverage = buildBoardCoverage(tokenOutcomes, filtered, warn);

    // Sum: 2 (acme-east) + 2 (acme-west) + 0 (no-name) = 4 == filtered.length
    // (4) — the sum check alone would stay silent here.
    const attributedTotal = coverage.reduce((sum, e) => sum + e.survivedFilter, 0);
    expect(attributedTotal).toBe(filtered.length);
    // But the duplicate-name check still fires, because it doesn't depend
    // on the sum at all.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/same company name/i);
  });

  it("hazard C: a token with no companyName reports 0 survivors even though its postings are in the shortlist — and the invariant check warns", () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "no-company-name", status: "ok", postingCount: 2, companyName: undefined }),
    ];
    const filtered: NormalizedJob[] = [
      { ...job("hazard-c-1", "Backend Engineer"), company: "Whoever" },
      { ...job("hazard-c-2", "Backend Engineer"), company: "Whoever" },
    ];
    const warn = vi.fn();

    const coverage = buildBoardCoverage(tokenOutcomes, filtered, warn);

    // The board reads as if it contributed nothing ("0 survived
    // filtering") while its 2 postings are, in fact, in the shortlist —
    // exactly the under-count that would get a productive token deleted.
    expect(coverage[0]!.survivedFilter).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/sums? to 0/i);
  });

  it("does not warn when every survivor is accounted for by exactly one token", () => {
    const tokenOutcomes: TokenOutcome[] = [
      outcome({ token: "acme", status: "ok", postingCount: 1, companyName: "Acme" }),
    ];
    const filtered: NormalizedJob[] = [{ ...job("ok-1", "Backend Engineer"), company: "Acme" }];
    const warn = vi.fn();

    buildBoardCoverage(tokenOutcomes, filtered, warn);

    expect(warn).not.toHaveBeenCalled();
  });

  it("describeBoardOutcome names each of the four outcomes distinctly", () => {
    const notFound: BoardCoverageEntry = {
      token: "x",
      status: "not-found",
      postingCount: 0,
      companyName: undefined,
      message: undefined,
      skippedCount: 0,
      survivedFilter: 0,
    };
    const empty: BoardCoverageEntry = {
      token: "x",
      status: "empty",
      postingCount: 0,
      companyName: undefined,
      message: undefined,
      skippedCount: 0,
      survivedFilter: 0,
    };
    const errored: BoardCoverageEntry = {
      token: "x",
      status: "error",
      postingCount: 0,
      companyName: undefined,
      message: "network error",
      skippedCount: 0,
      survivedFilter: 0,
    };
    const okNoSurvivors: BoardCoverageEntry = {
      token: "x",
      status: "ok",
      postingCount: 10,
      companyName: "X",
      message: undefined,
      skippedCount: 0,
      survivedFilter: 0,
    };
    const okWithSurvivors: BoardCoverageEntry = {
      token: "x",
      status: "ok",
      postingCount: 10,
      companyName: "X",
      message: undefined,
      skippedCount: 0,
      survivedFilter: 3,
    };

    const descriptions = new Set([
      describeBoardOutcome(notFound),
      describeBoardOutcome(empty),
      describeBoardOutcome(errored),
      describeBoardOutcome(okNoSurvivors),
      describeBoardOutcome(okWithSurvivors),
    ]);
    // All five must read as distinct messages — that distinction is the
    // entire point of this ticket.
    expect(descriptions.size).toBe(5);
    expect(describeBoardOutcome(notFound)).toMatch(/404/);
    expect(describeBoardOutcome(empty)).toMatch(/0 postings/);
    expect(describeBoardOutcome(errored)).toMatch(/network error/);
    expect(describeBoardOutcome(okNoSurvivors)).toMatch(/10 posting\(s\), 0 survived/);
    expect(describeBoardOutcome(okWithSurvivors)).toMatch(/10 posting\(s\), 3 survived/);
  });
});

describe("estimateScoringCost / readUsageStats / recordUsageStats (ticket 16c824a)", () => {
  // No DB needed — pure functions / plain file I/O against a tmp path.
  const SAMPLE_JOBS: NormalizedJob[] = [
    job("cost-estimate-1", "Backend Engineer"),
    job("cost-estimate-2", "Frontend Engineer"),
  ];

  it("returns all zeros for an empty job list, without touching usageStats at all", () => {
    const estimate = estimateScoringCost([], "resume text", undefined);
    expect(estimate).toEqual({
      jobCount: 0,
      estimatedInputTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      basis: "bootstrap",
    });
  });

  it("bootstrap path: derives input tokens from the REAL prompt text length (not a flat guess) and output from MAX_OUTPUT_TOKENS", () => {
    const estimate = estimateScoringCost(SAMPLE_JOBS, "resume text", undefined);
    expect(estimate.basis).toBe("bootstrap");
    expect(estimate.jobCount).toBe(2);
    // Bootstrap output is the model's own hard cap (2000) per job — a real,
    // code-enforced number, not invented.
    expect(estimate.estimatedOutputTokens).toBe(2000 * 2);
    expect(estimate.estimatedInputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("measured path: uses the exact average of usageStats for input/output tokens, ignoring prompt text for those two fields", () => {
    // Long enough to clear CACHE_MIN_PREFIX_TOKENS (see LONG_RESUME_FILLER's
    // doc comment) — ticket aff284b review round 3 F4 makes the measured
    // path branch on real prefix length, and this test exercises the
    // NORMAL (caching) branch.
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} cost-estimate-avg ${LONG_RESUME_FILLER}`;
    const stats = { model: MODEL, calls: 10, totalInputTokens: 10_000, totalOutputTokens: 2_000 };
    const estimate = estimateScoringCost(SAMPLE_JOBS, RESUME_TEXT, stats);
    expect(estimate.basis).toBe("measured");
    // avg 1000 in / 200 out per call * 2 jobs.
    expect(estimate.estimatedInputTokens).toBe(2000);
    expect(estimate.estimatedOutputTokens).toBe(400);
    // `stats` carries no cache fields at all here (this test predates
    // ticket aff284b's cache tracking). `estimatedCostUsd` is NOT purely
    // input/output-average-driven though: ticket aff284b review round 2 S2
    // (cache-creation) and round 3 F3 (cache-read) both made cache cost
    // measured directly from THIS run's real cached prefix
    // (`buildCachedPrefix(RESUME_TEXT)`) — see `estimateScoringCost`'s
    // inline comments — independent of what, if anything, `stats` says
    // about cache usage. So BOTH cache buckets come out nonzero here even
    // though `stats` never mentions caching at all.
    const prefixTokens = Math.round(buildCachedPrefix(RESUME_TEXT).length / 4);
    expect(estimate.estimatedCacheCreationTokens).toBe(prefixTokens);
    expect(estimate.estimatedCacheReadTokens).toBe(prefixTokens * (SAMPLE_JOBS.length - 1));
    const expectedCost =
      (2000 / 1e6) * 3 +
      (400 / 1e6) * 15 +
      (prefixTokens / 1e6) * 3 * 1.25 +
      (estimate.estimatedCacheReadTokens / 1e6) * 3 * 0.1;
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 10);
  });

  // Ticket aff284b: the measured path must price cache reads/writes at
  // their OWN rate (0.1x / 1.25x of the input price — see
  // CACHE_READ_PRICE_MULTIPLIER/CACHE_WRITE_PRICE_MULTIPLIER's doc
  // comment), not blend them into the flat input-token cost the way this
  // function did before this ticket.
  it("measured path: prices cache-read and cache-creation tokens at their own rate, not the flat input rate, and computes both directly from this run's real prefix (not stats)", () => {
    // Long enough to clear CACHE_MIN_PREFIX_TOKENS — see LONG_RESUME_FILLER.
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} cost-estimate-rates ${LONG_RESUME_FILLER}`;
    const stats = {
      model: MODEL,
      calls: 10,
      totalInputTokens: 10_000,
      totalOutputTokens: 2_000,
      totalCacheReadTokens: 100_000,
      totalCacheCreationTokens: 1_000,
    };
    const estimate = estimateScoringCost(SAMPLE_JOBS, RESUME_TEXT, stats);
    expect(estimate.basis).toBe("measured");
    // avg 1000 in / 100 (2 jobs) — token AVERAGES are unaffected by cache
    // accounting; only estimatedCostUsd changes.
    expect(estimate.estimatedInputTokens).toBe(2000);
    expect(estimate.estimatedOutputTokens).toBe(400);
    // Ticket aff284b review round 3 F3: cache READS are no longer a
    // historical average either — like cache-creation (S2), they're
    // computed directly from this run's real prefix:
    // `prefixTokens * (jobCount - 1)`, since every job after the first
    // reads the cache once (the first call is the WRITE, not a read).
    // `stats.totalCacheReadTokens: 100_000` above is intentionally left in
    // the fixture and intentionally NOT reflected below, to prove it's
    // ignored — same as `totalCacheCreationTokens` already was as of S2.
    const prefixTokens = Math.round(buildCachedPrefix(RESUME_TEXT).length / 4);
    const expectedCacheReadTokens = prefixTokens * (SAMPLE_JOBS.length - 1);
    expect(estimate.estimatedCacheReadTokens).toBe(expectedCacheReadTokens);
    expect(estimate.estimatedCacheReadTokens).not.toBe(20_000); // old avg(100_000/10)*2 formula
    // Cache CREATION does NOT scale by jobCount (ticket aff284b review
    // S1 — a run writes its cache exactly once regardless of job count),
    // and — ticket aff284b review round 2 S2 — it is no longer derived
    // from `stats.totalCacheCreationTokens` at all.
    expect(estimate.estimatedCacheCreationTokens).toBe(prefixTokens);
    expect(estimate.estimatedCacheCreationTokens).not.toBe(100); // the old (wrong) per-call average
    const expectedCost =
      (2000 / 1e6) * 3 + // ordinary input, full rate
      (expectedCacheReadTokens / 1e6) * 3 * 0.1 + // cache read, 0.1x
      (prefixTokens / 1e6) * 3 * 1.25 + // cache creation, 1.25x, ONCE per run
      (400 / 1e6) * 15; // output, unaffected by caching
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 10);
    // Sanity check against the PRE-aff284b flat-rate formula: caching must
    // make the estimate cheaper than treating every cache token as a full
    // -price input token, or the "savings" this ticket exists to capture
    // would not actually show up in the estimate at all.
    const flatRateCost =
      ((2000 + expectedCacheReadTokens + prefixTokens) / 1e6) * 3 + (400 / 1e6) * 15;
    expect(estimate.estimatedCostUsd).toBeLessThan(flatRateCost);
  });

  // Ticket aff284b review S1: the defect this test originally pinned down
  // — before the S1 fix, cache-creation was multiplied by jobCount just
  // like cache-read, which charged a large job count N times the actual
  // one-time cache-write cost. Uses a job count large enough (50) that a
  // per-job-multiplied behavior and a correct once-per-run behavior
  // produce clearly different numbers, not numbers that could
  // coincidentally match.
  //
  // CORRECTED (ticket aff284b review round 2 S2): this test used to also
  // assert that `Math.round(2_113 / 5) = 423` was the CORRECT projected
  // cache-creation estimate for this fixture. It is not — see the inline
  // comment in `estimateScoringCost` for the math (totalCacheCreationTokens
  // / calls only equals the real per-run write cost when every historical
  // run scored exactly one job) and the CostEstimate.estimatedCacheCreationTokens
  // doc comment. The reviewer verified this directly against this
  // ticket's own live stats: 5 calls, 1 real cache write of 2,113 tokens
  // — the real per-run write cost is 2,113, not 423. This test now
  // asserts the estimate matches the real cached-prefix measurement
  // (`buildCachedPrefix`) instead of the old (wrong) historical average,
  // and separately proves that average is no longer even consulted for
  // this field.
  it("S1/S2/F3: cache-creation is charged ONCE per run and cache-read scales by (jobCount - 1), both measured from the real cached prefix, not a historical average", () => {
    // Long enough to clear CACHE_MIN_PREFIX_TOKENS — see LONG_RESUME_FILLER.
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} cost-estimate-s1s2f3 ${LONG_RESUME_FILLER}`;
    const MANY_SAMPLE_JOBS: NormalizedJob[] = Array.from({ length: 50 }, (_, i) =>
      job(`s1-cost-estimate-${i}`, `Engineer ${i}`),
    );
    const stats = {
      model: MODEL,
      calls: 5,
      totalInputTokens: 5_000,
      totalOutputTokens: 1_000,
      totalCacheReadTokens: 8_452, // 4 of 5 historical calls were reads
      totalCacheCreationTokens: 2_113, // 1 of 5 historical calls was the one write
    };
    const estimate = estimateScoringCost(MANY_SAMPLE_JOBS, RESUME_TEXT, stats);
    const prefixTokens = Math.round(buildCachedPrefix(RESUME_TEXT).length / 4);

    // Cache READ (ticket aff284b review round 3 F3): `prefixTokens *
    // (jobCount - 1)`, NOT the historical average this used to be —
    // `stats.totalCacheReadTokens: 8_452` above is intentionally left in
    // the fixture and intentionally NOT reflected below, to prove it's
    // ignored.
    const oldHistoricalAverage = Math.round((8_452 / 5) * 50); // = 84,520, the now-removed formula
    expect(estimate.estimatedCacheReadTokens).toBe(prefixTokens * (MANY_SAMPLE_JOBS.length - 1));
    expect(estimate.estimatedCacheReadTokens).not.toBe(oldHistoricalAverage);

    // Cache CREATION must NOT scale with jobCount, AND must not come from
    // `stats.totalCacheCreationTokens` at all — it's measured directly
    // from this run's real cached prefix instead.
    const oldWrongPerCallAverage = Math.round(2_113 / 5); // = 423
    const oldWrongPerJobMultiple = Math.round((2_113 / 5) * 50); // = 21,130
    expect(estimate.estimatedCacheCreationTokens).toBe(prefixTokens);
    expect(estimate.estimatedCacheCreationTokens).not.toBe(oldWrongPerCallAverage);
    expect(estimate.estimatedCacheCreationTokens).not.toBe(oldWrongPerJobMultiple);
  });

  // Ticket aff284b review round 3 F4: a resume whose cached prefix falls
  // under CACHE_MIN_PREFIX_TOKENS never actually creates a cache entry (see
  // `buildCachedPrefix`'s doc comment) — every call sends the FULL prompt
  // (prefix + suffix) at the flat rate, nothing discounted, nothing
  // written. Before this fix the measured path still priced this scenario
  // as though caching happened, treating `avgInputTokens` (a per-call
  // average of the UNCACHED REMAINDER from historical, cache-qualifying
  // runs) as though it covered the whole prompt — the reviewer's own live
  // measurement found this produced an estimate roughly HALF the real cost
  // ($0.0426 estimated vs. ~$0.088 real for a 10-job short-resume run),
  // the non-conservative direction this file's cost estimates otherwise
  // avoid.
  it("F4: a resume too short to cache falls back to full per-job prompt pricing, not an illusory cache split", () => {
    // Long enough to be a realistic "just under the minimum" resume (not a
    // one-line placeholder) — chosen so its heuristic-estimated prefix
    // token count is comfortably under CACHE_MIN_PREFIX_TOKENS (1,024).
    const SHORT_RESUME = "Cache-minimum probe resume text. ".repeat(115);
    const prefixTokens = Math.round(buildCachedPrefix(SHORT_RESUME).length / 4);
    expect(prefixTokens).toBeLessThan(1024); // guards the fixture itself

    const JOB_DESCRIPTION_FILLER =
      "Requires distributed systems, cloud infra, and cross-team collaboration experience. ".repeat(
        20,
      );
    const JOBS_10: NormalizedJob[] = Array.from({ length: 10 }, (_, i) => ({
      ...job(`f4-short-resume-${i}`, `Engineer ${i}`),
      description: JOB_DESCRIPTION_FILLER,
    }));

    // Historical stats from a DIFFERENT (long-resume, cache-qualifying)
    // run — proves the short-resume branch doesn't blend a caching-shaped
    // historical average into a run that cannot itself cache. `avgInputTokens`
    // here mirrors a realistic per-job SUFFIX-only figure (what a normal
    // caching run's uncached remainder looks like for a similarly-sized job
    // description), so the "illusory cache" comparison below is
    // apples-to-apples, not an arbitrary round number.
    const suffixTokensPerCall = Math.round(
      buildScoringPrompt(JOBS_10[0]!, SHORT_RESUME).length / 4 - prefixTokens,
    );
    const stats = {
      model: MODEL,
      calls: 10,
      totalInputTokens: suffixTokensPerCall * 10, // per-call UNCACHED REMAINDER from a caching run
      totalOutputTokens: 2_000,
      totalCacheReadTokens: 80_000,
      totalCacheCreationTokens: 2_113,
    };
    const estimate = estimateScoringCost(JOBS_10, SHORT_RESUME, stats);

    expect(estimate.basis).toBe("measured");
    expect(estimate.estimatedCacheReadTokens).toBe(0);
    expect(estimate.estimatedCacheCreationTokens).toBe(0);

    // Full real prompt (prefix + suffix) for every job, priced at the flat
    // input rate — the same char-count approach the bootstrap path uses.
    const totalPromptChars = JOBS_10.reduce(
      (sum, j) => sum + buildScoringPrompt(j, SHORT_RESUME).length,
      0,
    );
    const expectedInputTokens = Math.round(totalPromptChars / 4);
    expect(estimate.estimatedInputTokens).toBe(expectedInputTokens);

    const expectedCost =
      (expectedInputTokens / 1e6) * 3 + (estimate.estimatedOutputTokens / 1e6) * 15;
    expect(estimate.estimatedCostUsd).toBeCloseTo(expectedCost, 10);

    // The fix must move the estimate in the CONSERVATIVE direction
    // (higher), not lower: pricing the whole prompt uncached, every job, is
    // more expensive than the (wrong) illusory-cache formula it replaced
    // (avgInputTokens * jobCount, plus a discounted cache read/write split
    // that never actually happens for a resume this short).
    const illusoryCachedCost =
      ((suffixTokensPerCall * 10) / 1e6) * 3 +
      ((prefixTokens * 9) / 1e6) * 3 * 0.1 +
      (prefixTokens / 1e6) * 3 * 1.25 +
      (estimate.estimatedOutputTokens / 1e6) * 15;
    expect(estimate.estimatedCostUsd).toBeGreaterThan(illusoryCachedCost);
  });

  // Ticket aff284b review round 3 F4: a single-job run has no second job to
  // ever read a warm cache — only the one call happens, and that call is
  // the cache WRITE, not a read. This holds even when the resume's prefix
  // comfortably clears CACHE_MIN_PREFIX_TOKENS.
  it("F4: a single-job run estimates zero cache-read tokens (only the one call's write happens), even when the prefix qualifies for caching", () => {
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} cost-estimate-single-job ${LONG_RESUME_FILLER}`;
    const ONE_JOB: NormalizedJob[] = [job("f4-single-job", "Solo Engineer")];
    const stats = { model: MODEL, calls: 10, totalInputTokens: 10_000, totalOutputTokens: 2_000 };
    const estimate = estimateScoringCost(ONE_JOB, RESUME_TEXT, stats);

    expect(estimate.basis).toBe("measured");
    expect(estimate.estimatedCacheReadTokens).toBe(0);
    // The write still happens — jobCount === 1 doesn't mean nothing is
    // cached, only that nothing reads it back within this run.
    const prefixTokens = Math.round(buildCachedPrefix(RESUME_TEXT).length / 4);
    expect(estimate.estimatedCacheCreationTokens).toBe(prefixTokens);
    expect(estimate.estimatedCacheCreationTokens).toBeGreaterThan(0);
  });

  it("a usageStats object with calls: 0 is treated as no data (bootstrap), not a measured average of zero", () => {
    const estimate = estimateScoringCost(SAMPLE_JOBS, "resume text", {
      model: MODEL,
      calls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
    expect(estimate.basis).toBe("bootstrap");
  });

  it("readUsageStats returns undefined (not a throw) for a missing file", () => {
    const missingPath = path.join(outputDir, `does-not-exist-${randomUUID()}.json`);
    expect(readUsageStats(missingPath)).toBeUndefined();
  });

  it("readUsageStats returns undefined (not a throw) for malformed JSON", () => {
    const badPath = path.join(outputDir, `malformed-${randomUUID()}.json`);
    fs.writeFileSync(badPath, "{ not valid json");
    expect(readUsageStats(badPath)).toBeUndefined();
  });

  // Ticket aff284b review R2: a PRE-aff284b stats file — same shape
  // `{model, calls, totalInputTokens, totalOutputTokens}`, no cache keys
  // at all — must be treated as STALE (same as a model mismatch), not
  // silently accepted with its missing cache fields defaulted to 0. The
  // pre-aff284b `totalInputTokens` meant "the whole prompt"; the current
  // code's `totalInputTokens` means "the uncached remainder only" — same
  // field name, incompatible meanings, so blending them would silently
  // corrupt the average (reviewer measured ~7x overestimate in one
  // reconstructed scenario). This is the regression test the review
  // explicitly asked for.
  it("R2: a pre-aff284b stats file (no cache fields at all) is treated as stale and discarded, not blended in as current", () => {
    const statsPath = path.join(outputDir, `pre-aff284b-shape-${randomUUID()}.json`);
    // Exact pre-aff284b UsageStats shape — same MODEL, so a model check
    // alone would NOT catch this; only the missing cache keys do.
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        model: MODEL,
        calls: 50,
        totalInputTokens: 500_000,
        totalOutputTokens: 50_000,
      }),
    );

    // Must read as stale/absent, exactly like a model mismatch — not as a
    // valid 50-call average with 0 cache activity.
    expect(readUsageStats(statsPath)).toBeUndefined();

    // Concretely: estimateScoringCost must fall back to "bootstrap" for
    // this path's data, not silently treat the old average as "measured".
    const estimate = estimateScoringCost(SAMPLE_JOBS, "resume text", readUsageStats(statsPath));
    expect(estimate.basis).toBe("bootstrap");

    // And recordUsageStats, called against this same path, must start a
    // FRESH average (treating the old file as though it didn't exist) —
    // not accumulate the old whole-prompt-meaning totals into the new
    // uncached-remainder-meaning field.
    recordUsageStats(statsPath, {
      calls: 3,
      totalInputTokens: 3_000,
      totalOutputTokens: 600,
      totalCacheReadTokens: 9_000,
      totalCacheCreationTokens: 500,
    });
    expect(readUsageStats(statsPath)).toEqual({
      model: MODEL,
      calls: 3, // NOT 53 — the old 50 calls were discarded, not blended
      totalInputTokens: 3_000, // NOT 503_000
      totalOutputTokens: 600,
      totalCacheReadTokens: 9_000,
      totalCacheCreationTokens: 500,
    });
  });

  // A file that DOES carry at least one cache field (the shape every
  // post-aff284b `recordUsageStats` write produces) is current, not stale
  // — only a file missing BOTH cache fields is treated as pre-aff284b.
  it("a stats file with cache fields present (even if 0) is treated as current, not stale", () => {
    const statsPath = path.join(outputDir, `post-aff284b-shape-${randomUUID()}.json`);
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        model: MODEL,
        calls: 5,
        totalInputTokens: 1_000,
        totalOutputTokens: 500,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      }),
    );
    expect(readUsageStats(statsPath)).toEqual({
      model: MODEL,
      calls: 5,
      totalInputTokens: 1_000,
      totalOutputTokens: 500,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
  });

  it("recordUsageStats accumulates across multiple calls instead of overwriting", () => {
    const statsPath = path.join(outputDir, `accumulate-${randomUUID()}.json`);
    recordUsageStats(statsPath, { calls: 2, totalInputTokens: 1000, totalOutputTokens: 100 });
    recordUsageStats(statsPath, { calls: 3, totalInputTokens: 1500, totalOutputTokens: 150 });

    expect(readUsageStats(statsPath)).toEqual({
      model: MODEL,
      calls: 5,
      totalInputTokens: 2500,
      totalOutputTokens: 250,
      // Ticket aff284b: neither call above reported cache usage, so these
      // accumulate to 0 — but they're still concrete numbers on the
      // returned object, not absent keys (see readUsageStats's doc
      // comment), so a plain `toEqual` against the pre-aff284b 4-key shape
      // would fail here.
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
  });

  it("recordUsageStats with calls: 0 is a no-op (never creates a file for a batch with no real usage)", () => {
    const statsPath = path.join(outputDir, `noop-${randomUUID()}.json`);
    recordUsageStats(statsPath, { calls: 0, totalInputTokens: 0, totalOutputTokens: 0 });
    expect(fs.existsSync(statsPath)).toBe(false);
  });

  it("DEFAULT_SCORE_THRESHOLD is a positive, sane number (regression guard against an accidental 0 or negative that would cap every run to nothing)", () => {
    expect(DEFAULT_SCORE_THRESHOLD).toBeGreaterThan(0);
  });

  // Ticket 16c824a review F5: MODEL has already changed once (opus ->
  // sonnet). Stats recorded under a different model must never blend into
  // the current average — different model, different typical response
  // length AND price.
  it("readUsageStats ignores stats recorded under a different model instead of treating them as current", () => {
    const statsPath = path.join(outputDir, `stale-model-${randomUUID()}.json`);
    // Carries cache fields (post-aff284b shape) deliberately, so this
    // fixture isolates the MODEL-mismatch dimension only — without them,
    // ticket aff284b review R2's "missing both cache fields" staleness
    // check (see the test above/below named "R2: ...") would ALSO reject
    // this file, for a different reason, and this test would no longer be
    // testing what its name says.
    fs.writeFileSync(
      statsPath,
      JSON.stringify({
        model: "claude-opus-5",
        calls: 20,
        totalInputTokens: 50_000,
        totalOutputTokens: 10_000,
        totalCacheReadTokens: 5_000,
        totalCacheCreationTokens: 500,
      }),
    );

    // Read back under the CURRENT model (default `expectedModel`) — the
    // opus-recorded stats must not surface as if they were sonnet's.
    expect(readUsageStats(statsPath)).toBeUndefined();
    // But they DO exist if asked about under their own model — this isn't
    // corruption, it's a legitimate different-model record being filtered.
    expect(readUsageStats(statsPath, "claude-opus-5")).toMatchObject({ calls: 20 });
  });

  it("recordUsageStats starts a fresh average instead of blending in prior stats recorded under a different model", () => {
    const statsPath = path.join(outputDir, `model-switch-${randomUUID()}.json`);
    recordUsageStats(
      statsPath,
      { calls: 10, totalInputTokens: 10_000, totalOutputTokens: 2_000 },
      "claude-opus-5",
    );

    // Now record under the CURRENT model — must start fresh (10 calls),
    // not accumulate onto opus's 10 (which would silently claim 20 calls
    // of a mixed, meaningless average).
    recordUsageStats(
      statsPath,
      { calls: 3, totalInputTokens: 3_000, totalOutputTokens: 600 },
      MODEL,
    );

    expect(readUsageStats(statsPath, MODEL)).toEqual({
      model: MODEL,
      calls: 3,
      totalInputTokens: 3_000,
      totalOutputTokens: 600,
      // Ticket aff284b — see the identical note on the "accumulates"
      // test above.
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
    });
    // The stale opus record is gone — superseded, not blended — once a
    // write for the current model has happened. There's one file, one
    // model's average in it at a time; a switch resets it rather than
    // accumulating a second, parallel average nothing ever reads.
    expect(readUsageStats(statsPath, "claude-opus-5")).toBeUndefined();
  });
});

/** Minimal shape of what `makeClaudeScorer` actually sends/reads on
 * `anthropic.messages.create` — just enough to assert on cache_control
 * placement and to feed back a synthetic `usage`. Cast to `Anthropic`
 * with `as unknown as Anthropic` (never `any`) so this fake doesn't need
 * to satisfy the real SDK's full, heavily-overloaded `create` signature. */
type FakeCreateParams = {
  model: string;
  max_tokens: number;
  messages: Array<{
    role: string;
    content: Array<{ type: string; text: string; cache_control?: { type: string } }>;
  }>;
};
type FakeUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
};

/** Fakes just enough of an `Anthropic` client for `makeClaudeScorer`
 * (ticket aff284b): captures every `create` call's params (so tests can
 * assert on cache_control/block placement) and returns a scorable JSON
 * response carrying caller-supplied `usage`. No real network, no
 * ANTHROPIC_API_KEY required — unlike the live measurement behind this
 * ticket's before/after numbers (see the commit message), this is a pure
 * unit test of the request/response WIRING, not of real cache behavior. */
function makeFakeAnthropicClient(usage: FakeUsage): {
  anthropic: Anthropic;
  capturedParams: FakeCreateParams[];
} {
  const capturedParams: FakeCreateParams[] = [];
  const fakeClient = {
    messages: {
      create: async (params: FakeCreateParams) => {
        capturedParams.push(params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                matchScore: 77,
                rationale: "fake rationale",
                strengths: ["fake strength"],
                gaps: ["fake gap"],
              }),
            },
          ],
          usage,
        };
      },
    },
  };
  return { anthropic: fakeClient as unknown as Anthropic, capturedParams };
}

describe("makeClaudeScorer prompt caching (ticket aff284b)", () => {
  const RESUME_TEXT =
    "Jane Doe. Senior Backend Engineer. 6 years Node.js, TypeScript, Postgres, RabbitMQ. " +
    "Built message-driven services with retries, DLQs, and idempotent consumers. " +
    "Led a migration from a monolith to a queue-based fan-out/fan-in architecture. " +
    "Comfortable with schema design and migrations against a real relational database. " +
    "Contributed to a React/TypeScript frontend against a REST API boundary. " +
    "Prior roles: Acme Corp (2019-2023), Globex (2016-2019). BS Computer Science.";
  const JOB = job("caching-test-1", "Staff Backend Engineer");

  it("sends the cached prefix as the FIRST content block, with cache_control ephemeral, and the job suffix as a second, unmarked block", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient({
      input_tokens: 50,
      output_tokens: 40,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
    });
    const scoreJob = makeClaudeScorer(anthropic);
    await scoreJob(JOB, RESUME_TEXT);

    expect(capturedParams).toHaveLength(1);
    const content = capturedParams[0]!.messages[0]!.content;
    expect(content).toHaveLength(2);

    // Block 1: the cached prefix, byte-identical to buildCachedPrefix's
    // own output, cache_control-marked, and FIRST in the array — caching
    // is a prefix match, so anything after this block is what varies.
    expect(content[0]!.text).toBe(buildCachedPrefix(RESUME_TEXT));
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });

    // Block 2: the per-job suffix, byte-identical to buildJobSuffix's own
    // output, with NO cache_control — this is the part that legitimately
    // varies from call to call and must never be inside the cached region.
    expect(content[1]!.text).toBe(buildJobSuffix(JOB));
    expect(content[1]!.cache_control).toBeUndefined();

    // The two blocks concatenated reproduce buildScoringPrompt's combined
    // string exactly — same invariant that function's own doc comment
    // documents.
    expect(content[0]!.text + content[1]!.text).toBe(buildScoringPrompt(JOB, RESUME_TEXT));
  });

  it("buildCachedPrefix folds the instruction preamble in ahead of the resume, so the whole cacheable region is covered by one cache_control breakpoint", () => {
    const prefix = buildCachedPrefix(RESUME_TEXT);
    const preambleIndex = prefix.indexOf("Score how well this candidate matches this job posting.");
    const resumeMarkerIndex = prefix.indexOf("=== RESUME ===");
    const resumeIndex = prefix.indexOf(RESUME_TEXT);

    expect(preambleIndex).toBeGreaterThanOrEqual(0);
    expect(resumeMarkerIndex).toBeGreaterThan(preambleIndex);
    expect(resumeIndex).toBeGreaterThan(resumeMarkerIndex);
    // Nothing job-specific (title/company/description) leaks into the
    // cached prefix — that's buildJobSuffix's job, and it must stay out
    // of the cache_control-marked block.
    expect(prefix).not.toContain(JOB.title);
    expect(prefix).not.toContain(JOB.description);
  });

  it("propagates real cache-read/cache-creation usage from the API response into ScoredJob.usage, separately from inputTokens", async () => {
    const { anthropic } = makeFakeAnthropicClient({
      input_tokens: 317,
      output_tokens: 486,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 2113,
    });
    const scoreJob = makeClaudeScorer(anthropic);
    const scored = await scoreJob(JOB, RESUME_TEXT);

    expect(scored.usage).toEqual({
      inputTokens: 317,
      outputTokens: 486,
      cacheReadTokens: 0,
      cacheCreationTokens: 2113,
    });
  });

  it("a real cache READ (subsequent call against a warm cache) reports nonzero cacheReadTokens and zero cacheCreationTokens", async () => {
    const { anthropic } = makeFakeAnthropicClient({
      input_tokens: 215,
      output_tokens: 362,
      cache_read_input_tokens: 2113,
      cache_creation_input_tokens: 0,
    });
    const scoreJob = makeClaudeScorer(anthropic);
    const scored = await scoreJob(JOB, RESUME_TEXT);

    expect(scored.usage?.cacheReadTokens).toBe(2113);
    expect(scored.usage?.cacheCreationTokens).toBe(0);
  });

  // Ticket aff284b acceptance criterion: "A resume too short to cache
  // still scores correctly." Per the live API docs (see buildCachedPrefix's
  // doc comment), a prefix under the ~1,024-token minimum simply never
  // creates a cache entry — cache_creation_input_tokens comes back 0, the
  // call is billed and scored normally, and NOTHING errors. This test
  // reproduces that response shape against the fake client; the actual
  // live behavior (a short resume genuinely producing a 0/0 cache
  // response, with no error) is confirmed with a real API call in the
  // ticket's commit message.
  it("a resume too short to cache still scores correctly — cache_control is sent regardless, and a 0/0 (no cache created) response does not error", async () => {
    const SHORT_RESUME = "Software engineer. 3 years experience. TypeScript, Node, Postgres.";
    const { anthropic, capturedParams } = makeFakeAnthropicClient({
      input_tokens: 210,
      output_tokens: 120,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    const scoreJob = makeClaudeScorer(anthropic);
    const scored = await scoreJob(JOB, SHORT_RESUME);

    // cache_control is still sent unconditionally — makeClaudeScorer does
    // not special-case resume length, the API itself decides whether the
    // prefix qualifies.
    const content = capturedParams[0]!.messages[0]!.content;
    expect(content[0]!.cache_control).toEqual({ type: "ephemeral" });

    // The call still scores correctly — no throw, a real matchScore comes
    // back — and the cache fields both report 0 rather than null/undefined
    // or an error.
    expect(scored.matchScore).toBe(77);
    expect(scored.usage).toEqual({
      inputTokens: 210,
      outputTokens: 120,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("describeCostEstimate (ticket 16c824a review F4)", () => {
  // No DB needed — pure function.
  it("renders a bootstrap estimate as an explicit ceiling (≤$…), not a point estimate", () => {
    const description = describeCostEstimate({
      jobCount: 129,
      estimatedInputTokens: 100_000,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 258_000, // 2000 * 129 — the worst-case bootstrap assumption
      estimatedCostUsd: 4.93,
      basis: "bootstrap",
    });
    expect(description).toMatch(/^≤\$4\.93/);
    expect(description).not.toMatch(/^~\$/);
  });

  it("renders a measured estimate as a point estimate (~$…), not a ceiling — it's grounded in real prior usage, not a worst case", () => {
    const description = describeCostEstimate({
      jobCount: 129,
      estimatedInputTokens: 60_000,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 40_000,
      estimatedCostUsd: 1.83,
      basis: "measured",
    });
    expect(description).toMatch(/^~\$1\.83/);
    expect(description).not.toMatch(/^≤/);
  });

  it("renders zero jobs distinctly, without a dollar sign implying a real (if tiny) estimate was computed", () => {
    const description = describeCostEstimate({
      jobCount: 0,
      estimatedInputTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      basis: "bootstrap",
    });
    expect(description).toBe("$0.00 (nothing needs scoring)");
  });

  // Ticket aff284b review R1: a pure rendering test — this `estimate` is a
  // hand-built `CostEstimate` literal, not the output of
  // `estimateScoringCost`. Only two of its numbers are genuinely traceable
  // to the reviewer's reproduction: the 49,120 uncached figure and the
  // 471,720 real total. The 91,160 cache-read and 331,440 cache-creation
  // splits are illustrative fill-ins to reach that total and reviewer's
  // own arithmetic, NOT reproduced measurements (ticket aff284b review
  // round 2 N1 — an earlier version of this comment overclaimed both were
  // "the exact defect reproduced"; per S2's fix above, cache-creation in
  // particular could never legitimately reach 331,440 for a 200-job run,
  // since it's now a one-time prefix measurement, not something that
  // scales with job count). What matters for this test is only that
  // `describeCostEstimate` renders the sum of all three buckets, not
  // `estimatedInputTokens` alone — see the assertions below.
  it("R1: shows the REAL total tokens sent (uncached + cache-read + cache-creation), not the uncached remainder alone", () => {
    const estimate = {
      jobCount: 200,
      estimatedInputTokens: 49_120,
      estimatedCacheReadTokens: 91_160,
      estimatedCacheCreationTokens: 331_440,
      estimatedOutputTokens: 100_000,
      estimatedCostUsd: 1.93,
      basis: "measured" as const,
    };
    const description = describeCostEstimate(estimate);

    const realTotal = 49_120 + 91_160 + 331_440;
    expect(realTotal).toBe(471_720);
    // The old bug: the description used to show only 49,120 as "in
    // tokens" — an ~89.6% understatement of what was actually sent.
    expect(description).toContain(`${realTotal}`);
    expect(description).not.toMatch(/~49120 in\b/);
    // The uncached remainder is still visible, but labeled, not bare.
    expect(description).toMatch(/49120 uncached/);
    expect(description).toMatch(/91160 cache-read/);
    expect(description).toMatch(/331440 cache-write/);
  });
});

describe("isTotalScoringFailure (ticket 620ca30 review finding B3)", () => {
  // No DB needed — pure function. Extracted out of main() specifically so
  // this exit-code decision has a direct test instead of only being
  // exercised by reading main()'s body.
  it("is true only when every attempted scoring call failed and none succeeded", () => {
    expect(isTotalScoringFailure({ failed: 3, newlyScored: 0 })).toBe(true);
  });

  it("is false when nothing failed (a healthy run, including one that scored nothing new)", () => {
    expect(isTotalScoringFailure({ failed: 0, newlyScored: 0 })).toBe(false);
    expect(isTotalScoringFailure({ failed: 0, newlyScored: 5 })).toBe(false);
  });

  it("is false on a partial failure — some scores still succeeded", () => {
    expect(isTotalScoringFailure({ failed: 1, newlyScored: 2 })).toBe(false);
  });
});

describe("counting-scorer fixture scores clear MATCH_SCORE_FLOOR (ticket e8e59e6)", () => {
  // Pure arithmetic — no DB needed. This exists because the collision it
  // guards was invisible: `makeCountingScorer`'s old `50 + n` silently put
  // every job numbered 0-4 below the floor introduced later by ticket
  // 1b9f81e, and the only symptom was seven DB-backed pipeline tests
  // asserting on an empty `results` array — a failure mode that reads like
  // "the pipeline is broken", not "the fixture data is stale". One
  // explicit assertion on the formula makes the next such change (raising
  // MATCH_SCORE_FLOOR, or adding a fixture numbered past 19) fail here,
  // where the message says exactly what is wrong.
  //
  // 19 is the largest externalId suffix any fixture in this file uses
  // (`MANY_JOBS` in the spend-guard describe, 20 jobs indexed 0-19). Raise
  // it in step with any fixture that numbers jobs higher.
  const HIGHEST_FIXTURE_SUFFIX = 19;

  it("keeps every fixture job at or above the floor and at or below 100", () => {
    for (let n = 0; n <= HIGHEST_FIXTURE_SUFFIX; n++) {
      const score = countingScoreFor(n);
      expect(score).toBeGreaterThanOrEqual(MATCH_SCORE_FLOOR);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("stays distinguishable per job, so tests that check rank order still can", () => {
    const scores = Array.from({ length: HIGHEST_FIXTURE_SUFFIX + 1 }, (_, n) =>
      countingScoreFor(n),
    );
    expect(new Set(scores).size).toBe(scores.length);
  });
});

describe("applyMatchScoreFloor (ticket 1b9f81e)", () => {
  // Pure function tests — no DB needed.
  function makeRankedResult(matchScore: number, title: string): RankedResult {
    return {
      jobId: `job-${title}`,
      externalId: `ext-${title}`,
      title,
      company: "Test Co",
      location: "Remote",
      locationType: "remote",
      applyUrl: "https://example.com",
      matchScore,
      rationale: "test rationale",
      strengths: [],
      gaps: [],
    };
  }

  it("excludes all jobs when all are below the floor", () => {
    const results = [
      makeRankedResult(40, "Job 1"),
      makeRankedResult(50, "Job 2"),
      makeRankedResult(MATCH_SCORE_FLOOR - 1, "Job 3"),
    ];
    const { displayed, belowFloorCount } = applyMatchScoreFloor(results);
    expect(displayed).toHaveLength(0);
    expect(belowFloorCount).toBe(3);
  });

  it("includes all jobs when all are at or above the floor", () => {
    const results = [
      makeRankedResult(MATCH_SCORE_FLOOR, "Job 1"),
      makeRankedResult(75, "Job 2"),
      makeRankedResult(100, "Job 3"),
    ];
    const { displayed, belowFloorCount } = applyMatchScoreFloor(results);
    expect(displayed).toHaveLength(3);
    expect(belowFloorCount).toBe(0);
  });

  it("filters mixed results: includes above-floor, excludes below-floor", () => {
    const results = [
      makeRankedResult(100, "Job 1"),
      makeRankedResult(40, "Job 2"),
      makeRankedResult(75, "Job 3"),
      makeRankedResult(50, "Job 4"),
      makeRankedResult(60, "Job 5"),
    ];
    const { displayed, belowFloorCount } = applyMatchScoreFloor(results);
    expect(displayed).toHaveLength(3);
    expect(belowFloorCount).toBe(2);
    // Verify the correct jobs were included
    expect(displayed.map((r) => r.matchScore).sort((a, b) => b - a)).toEqual([100, 75, 60]);
  });

  it(`includes jobs exactly at the floor (${MATCH_SCORE_FLOOR}%)`, () => {
    const results = [
      makeRankedResult(MATCH_SCORE_FLOOR - 1, "Below"),
      makeRankedResult(MATCH_SCORE_FLOOR, "AtFloor"),
      makeRankedResult(MATCH_SCORE_FLOOR + 1, "Above"),
    ];
    const { displayed, belowFloorCount } = applyMatchScoreFloor(results);
    expect(displayed).toHaveLength(2);
    expect(belowFloorCount).toBe(1);
    expect(displayed.map((r) => r.title)).toEqual(["AtFloor", "Above"]);
  });

  it("handles empty input", () => {
    const { displayed, belowFloorCount } = applyMatchScoreFloor([]);
    expect(displayed).toHaveLength(0);
    expect(belowFloorCount).toBe(0);
  });
});
