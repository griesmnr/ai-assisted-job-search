import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchResults,
  searchSources,
} from "./db/schema.js";
import {
  buildBoardCoverage,
  buildSourceOutcomes,
  describeBoardOutcome,
  describeSourceOutcome,
  DEFAULT_SCORE_THRESHOLD,
  estimateScoringCost,
  isTotalScoringFailure,
  readUsageStats,
  recordUsageStats,
  runDemoMatch,
  type BoardCoverageEntry,
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
      matchScore: 50 + n,
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
    expect(second.results).toHaveLength(3); // all 3 now have a score

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

    // The literal format ticket 16c824a asks for: a truncated run must
    // never read like a complete one.
    expect(logs.some((line) => line.includes("5 survivors, 2 scored, 3 not scored (cap)"))).toBe(
      true,
    );
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
    const RESUME_TEXT = `${RESUME_TEXT_PREFIX} spend-guard-measured ${randomUUID()}`;
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
    expect(statsAfterFirst).toEqual({ calls: 3, totalInputTokens: 3000, totalOutputTokens: 600 });

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

  it("measured path: uses the exact average of usageStats, ignoring prompt text entirely", () => {
    const stats = { calls: 10, totalInputTokens: 10_000, totalOutputTokens: 2_000 };
    const estimate = estimateScoringCost(SAMPLE_JOBS, "resume text", stats);
    expect(estimate.basis).toBe("measured");
    // avg 1000 in / 200 out per call * 2 jobs.
    expect(estimate.estimatedInputTokens).toBe(2000);
    expect(estimate.estimatedOutputTokens).toBe(400);
    expect(estimate.estimatedCostUsd).toBeCloseTo((2000 / 1e6) * 3 + (400 / 1e6) * 15, 10);
  });

  it("a usageStats object with calls: 0 is treated as no data (bootstrap), not a measured average of zero", () => {
    const estimate = estimateScoringCost(SAMPLE_JOBS, "resume text", {
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

  it("recordUsageStats accumulates across multiple calls instead of overwriting", () => {
    const statsPath = path.join(outputDir, `accumulate-${randomUUID()}.json`);
    recordUsageStats(statsPath, { calls: 2, totalInputTokens: 1000, totalOutputTokens: 100 });
    recordUsageStats(statsPath, { calls: 3, totalInputTokens: 1500, totalOutputTokens: 150 });

    expect(readUsageStats(statsPath)).toEqual({
      calls: 5,
      totalInputTokens: 2500,
      totalOutputTokens: 250,
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
