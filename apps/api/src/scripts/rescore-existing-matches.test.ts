import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NormalizedJob } from "../sources/types.js";
import type { CostEstimate, JobDescriptionRow, ScoredJob, UsageStats } from "../matching/index.js";
import { estimateScoringCost, toNormalizedJob } from "../matching/index.js";
import { jobMatches, jobs, resumes, sourceDescriptors, userJobStatuses } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  MAX_ESTIMATED_SPEND_USD,
  buildJobMatchUpdate,
  checkSpendCeiling,
  fetchExistingMatches,
  parseArgs,
} from "./rescore-existing-matches.js";

loadEnvFile();

function makeJobRow(overrides: Partial<JobDescriptionRow> = {}): JobDescriptionRow {
  return {
    externalId: "ext-1",
    dataSource: "greenhouse",
    title: "Software Engineer",
    description: "A real job description.",
    company: "Acme",
    payType: null,
    commitment: null,
    locationType: null,
    location: null,
    linkToApply: "https://example.com/jobs/1",
    postedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-1",
    dataSource: "greenhouse",
    title: "Software Engineer",
    description: "A real job description.",
    company: "Acme",
    linkToApply: "https://example.com/jobs/1",
    postedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeScoredJob(overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    matchScore: 72,
    rationale: "Solid overlap on backend experience.",
    levelFit: "well_matched",
    levelFitNote: "",
    strengths: ["Node.js", "Postgres"],
    gaps: ["Kubernetes"],
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("parses a bare resumeId as a dry run", () => {
    expect(parseArgs(["resume-123"])).toEqual({
      resumeId: "resume-123",
      live: false,
      includeDismissed: false,
    });
  });

  it("parses resumeId + --live as a live run", () => {
    expect(parseArgs(["resume-123", "--live"])).toEqual({
      resumeId: "resume-123",
      live: true,
      includeDismissed: false,
    });
  });

  it("accepts --live before the resumeId too", () => {
    expect(parseArgs(["--live", "resume-123"])).toEqual({
      resumeId: "resume-123",
      live: true,
      includeDismissed: false,
    });
  });

  it("parses --include-dismissed alongside --live", () => {
    expect(parseArgs(["resume-123", "--live", "--include-dismissed"])).toEqual({
      resumeId: "resume-123",
      live: true,
      includeDismissed: true,
    });
  });

  it("parses --include-dismissed on its own, dry-run by default", () => {
    expect(parseArgs(["resume-123", "--include-dismissed"])).toEqual({
      resumeId: "resume-123",
      live: false,
      includeDismissed: true,
    });
  });

  it("hard-errors when resumeId is missing entirely", () => {
    expect(() => parseArgs([])).toThrow(/resumeId is required/i);
  });

  it("hard-errors when only --live is given, with no resumeId", () => {
    expect(() => parseArgs(["--live"])).toThrow(/resumeId is required/i);
  });

  it("hard-errors on an unrecognized flag instead of silently proceeding", () => {
    expect(() => parseArgs(["resume-123", "--dry-run"])).toThrow(/Unrecognized argument/i);
  });

  it("hard-errors on a typo'd flag rather than treating it as a resumeId", () => {
    expect(() => parseArgs(["resume-123", "--liv"])).toThrow(/Unrecognized argument/i);
  });

  it("hard-errors on a typo of --include-dismissed rather than silently ignoring it", () => {
    expect(() => parseArgs(["resume-123", "--include-dismisse"])).toThrow(/Unrecognized argument/i);
  });

  it("hard-errors on more than one positional argument (ambiguous resumeId)", () => {
    expect(() => parseArgs(["resume-123", "resume-456"])).toThrow(/Expected exactly one resumeId/i);
  });
});

describe("buildJobMatchUpdate", () => {
  it("carries every field straight through for a full, real-shaped response", () => {
    const scored = makeScoredJob({
      matchScore: 88,
      rationale: "Strong match.",
      levelFit: "overqualified",
      levelFitNote: "This role is likely a step down in scope for you.",
      strengths: ["Leadership"],
      gaps: [],
    });
    expect(buildJobMatchUpdate(scored)).toEqual({
      matchScore: 88,
      rationale: "Strong match.",
      levelFit: "overqualified",
      levelFitNote: "This role is likely a step down in scope for you.",
      strengths: ["Leadership"],
      gaps: [],
    });
  });

  it("falls back to null for levelFit/levelFitNote when a fake scorer omits them", () => {
    const scored = makeScoredJob();
    // A real makeClaudeScorer response always includes these (SCHEMA
    // requires them) -- this branch only exercises a test fake / a
    // ScoredJob shape from before ticket b182bde.
    delete (scored as Partial<ScoredJob>).levelFit;
    delete (scored as Partial<ScoredJob>).levelFitNote;
    const update = buildJobMatchUpdate(scored);
    expect(update.levelFit).toBeNull();
    expect(update.levelFitNote).toBeNull();
  });

  it("falls back to null for strengths/gaps when absent", () => {
    const scored = makeScoredJob();
    delete (scored as Partial<ScoredJob>).strengths;
    delete (scored as Partial<ScoredJob>).gaps;
    const update = buildJobMatchUpdate(scored);
    expect(update.strengths).toBeNull();
    expect(update.gaps).toBeNull();
  });

  it("never carries usage through to the update payload", () => {
    const scored = makeScoredJob({
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    const update = buildJobMatchUpdate(scored);
    expect(update).not.toHaveProperty("usage");
  });
});

describe("checkSpendCeiling", () => {
  it("is within ceiling when cost is under the default ceiling", () => {
    const result = checkSpendCeiling({ maxCostUsd: 1.23 });
    expect(result).toEqual({
      withinCeiling: true,
      ceilingUsd: MAX_ESTIMATED_SPEND_USD,
      costUsd: 1.23,
    });
  });

  it("is within ceiling exactly at the boundary", () => {
    expect(checkSpendCeiling({ maxCostUsd: MAX_ESTIMATED_SPEND_USD }).withinCeiling).toBe(true);
  });

  it("refuses when cost exceeds the default ceiling", () => {
    const result = checkSpendCeiling({ maxCostUsd: MAX_ESTIMATED_SPEND_USD + 0.01 });
    expect(result.withinCeiling).toBe(false);
  });

  it("respects an explicit custom ceiling instead of the default", () => {
    expect(checkSpendCeiling({ maxCostUsd: 2.5 }, 2.0).withinCeiling).toBe(false);
    expect(checkSpendCeiling({ maxCostUsd: 1.5 }, 2.0).withinCeiling).toBe(true);
  });

  // Opus re-review (45e238e, round 3): `checkSpendCeiling` now takes the
  // WHOLE estimate and reads `.maxCostUsd` internally specifically so this
  // test can prove it reads the right field -- passing an object where
  // `probableCostUsd` is under the ceiling but `maxCostUsd` is over it, and
  // asserting the result follows `maxCostUsd`, fails if the implementation
  // is ever mutated to read `probableCostUsd` instead.
  it("reads maxCostUsd, not probableCostUsd, from the estimate -- these can genuinely disagree", () => {
    const estimate = { maxCostUsd: MAX_ESTIMATED_SPEND_USD + 1, probableCostUsd: 0.01 } as Pick<
      CostEstimate,
      "maxCostUsd" | "probableCostUsd"
    >;
    expect(checkSpendCeiling(estimate).withinCeiling).toBe(false);
  });
});

describe("toNormalizedJob", () => {
  it("converts a fully-populated row straight through", () => {
    const row = makeJobRow({
      payType: "salary",
      commitment: "full-time",
      locationType: "remote",
      location: "Remote - US",
    });
    expect(toNormalizedJob(row)).toEqual(
      makeNormalizedJob({
        payType: "salary",
        commitment: "full-time",
        locationType: "remote",
        location: "Remote - US",
      }),
    );
  });

  it("converts every nullable DB column to undefined, not null", () => {
    const row = makeJobRow({ payType: null, commitment: null, locationType: null, location: null });
    const job = toNormalizedJob(row);
    expect(job.payType).toBeUndefined();
    expect(job.commitment).toBeUndefined();
    expect(job.locationType).toBeUndefined();
    expect(job.location).toBeUndefined();
    // NOT "genuinely absent as a key" -- `toNormalizedJob` sets these as an
    // explicit `undefined` VALUE on an always-present key (`payType: row
    // .payType ?? undefined`), the same "present key, possibly-undefined
    // value" shape every real job-source normalizer already produces
    // (`ashby.ts`/`lever.ts`'s own `mapPayType` returns, spread into their
    // `Job` object literals the identical way). The property-access
    // assertions above already correctly test that shape; the previous
    // version of this line additionally claimed the key was "genuinely
    // absent" and asserted it via `"payType" in job ? job.payType :
    // undefined` -- a tautology that evaluates to `undefined` whether or
    // not the key exists, so it could never have caught a regression to a
    // real `null` (or any other non-undefined value) either.
  });

  it("preserves title/company/description/externalId/linkToApply/postedAt exactly", () => {
    const postedAt = new Date("2026-03-15T00:00:00.000Z");
    const row = makeJobRow({
      externalId: "gh-999",
      title: "Staff Backend Engineer",
      description: "Full posting text.",
      company: "Widgets Inc",
      linkToApply: "https://boards.example.com/999",
      postedAt,
    });
    const job = toNormalizedJob(row);
    expect(job.externalId).toBe("gh-999");
    expect(job.title).toBe("Staff Backend Engineer");
    expect(job.description).toBe("Full posting text.");
    expect(job.company).toBe("Widgets Inc");
    expect(job.linkToApply).toBe("https://boards.example.com/999");
    expect(job.postedAt).toBe(postedAt);
  });
});

describe("cost estimate math (via the real, shipped estimateScoringCost)", () => {
  // This script deliberately reuses demo-match.ts's own estimateScoringCost
  // rather than a second, parallel cost formula (see rescore-existing-
  // matches.ts's top comment) -- these tests confirm the SCRIPT's actual
  // call pattern (real historical per-call token averages -> a real dollar
  // figure) produces the right number, using a fixed, known UsageStats
  // fixture rather than a real prep/scoring-usage-stats.json file.
  const resumeText = "A".repeat(6000); // long enough to clear the cache-prefix minimum
  const usageStats: UsageStats = {
    model: "claude-sonnet-5",
    calls: 100,
    totalInputTokens: 30_000, // 300 tokens/call average uncached input
    totalOutputTokens: 20_000, // 200 tokens/call average output
    totalCacheReadTokens: 500_000,
    totalCacheCreationTokens: 2_000,
  };

  it("computes a real dollar figure for a known job count and known averages", () => {
    const jobs: NormalizedJob[] = [makeNormalizedJob(), makeNormalizedJob({ externalId: "ext-2" })];
    const estimate = estimateScoringCost(jobs, resumeText, usageStats);
    expect(estimate.basis).toBe("measured");
    expect(estimate.jobCount).toBe(2);
    // avgInputTokens = 300/call, avgOutputTokens = 200/call, 2 jobs ->
    // 600 uncached input tokens + 400 output tokens, at $3/$15 per MTok,
    // plus this run's own real cache-read/cache-creation tokens computed
    // from the real (long) resumeText -- assert it's a real positive
    // number in the right ballpark rather than re-deriving the whole cache
    // formula here (that's estimateScoringCost's own, already-tested
    // arithmetic; this test is about THIS script's call pattern).
    expect(estimate.probableCostUsd).toBeGreaterThan(0.005);
    expect(estimate.probableCostUsd).toBeLessThan(0.05);
    expect(estimate.maxCostUsd).toBeGreaterThanOrEqual(estimate.probableCostUsd);
  });

  it("scales the measured-basis estimate linearly with job count", () => {
    const oneJob = estimateScoringCost([makeNormalizedJob()], resumeText, usageStats);
    const tenJobs = estimateScoringCost(
      Array.from({ length: 10 }, (_, i) => makeNormalizedJob({ externalId: `ext-${i}` })),
      resumeText,
      usageStats,
    );
    // Not exactly 10x (cache-creation is paid once per run, not per job --
    // see estimateScoringCost's own doc comment, so the ratio is somewhat
    // UNDER 10x), but growth is still dominated by the per-job terms
    // (uncached input + output + cache reads), so it comfortably clears a
    // much looser bound.
    expect(tenJobs.probableCostUsd).toBeGreaterThan(oneJob.probableCostUsd * 3);
    expect(tenJobs.probableCostUsd).toBeLessThan(oneJob.probableCostUsd * 10);
  });

  it("falls back to a real, grounded bootstrap estimate with no usage stats", () => {
    const estimate = estimateScoringCost([makeNormalizedJob()], resumeText, undefined);
    expect(estimate.basis).toBe("bootstrap");
    expect(estimate.probableCostUsd).toBeGreaterThan(0);
  });

  it("returns zero cost for zero jobs", () => {
    const estimate = estimateScoringCost([], resumeText, usageStats);
    expect(estimate.jobCount).toBe(0);
    expect(estimate.probableCostUsd).toBe(0);
    expect(estimate.maxCostUsd).toBe(0);
  });
});

describe("spend ceiling wired to the REAL estimateScoringCost output (R4, adversarial review)", () => {
  // Every test above either hand-feeds an arbitrary number to
  // checkSpendCeiling in isolation, or checks estimateScoringCost's output
  // in isolation -- nothing exercises the actual composition main() performs
  // (call the real estimator, then check ITS OUTPUT against the ceiling).
  // That gap matters concretely: `checkSpendCeiling` must use
  // `estimate.maxCostUsd` (the genuine worst case), not `.probableCostUsd`
  // (the merely-likely figure, ~2-4x smaller at this scale). Opus re-review
  // round 3 found the FIRST version of this test still passed a bare
  // `estimate.maxCostUsd` NUMBER to `checkSpendCeiling`, so the field
  // selection happened here in the test rather than inside the function
  // under test -- mutating `checkSpendCeiling`'s internals (or main()'s call
  // site, before checkSpendCeiling took the whole estimate) to use
  // `probableCostUsd` would NOT have failed this test. Passing the whole
  // `estimate` object below, now that `checkSpendCeiling` reads the field
  // itself, closes that gap for real.
  //
  // "Realistic" here means this codebase's own already-established
  // historical per-call token averages -- 3,874.5 input / 454.2 output
  // tokens/call -- the exact figures `validate-level-fit.test.ts` cites as
  // producing "$0.01843/call uncached" (see that file's "reproduces ticket
  // d8746eb's own worked cost estimate" test), NOT arbitrary numbers.
  const realisticUsageStats: UsageStats = {
    model: "claude-sonnet-5",
    calls: 1000,
    totalInputTokens: 3_874_500, // 3,874.5 tokens/call
    totalOutputTokens: 454_200, // 454.2 tokens/call
  };
  const resumeText = "A".repeat(6000); // clears the cache-prefix minimum, same as the suite above

  function makeJobs(n: number): NormalizedJob[] {
    return Array.from({ length: n }, (_, i) => makeNormalizedJob({ externalId: `ext-${i}` }));
  }

  it("refuses a batch whose REAL worst-case cost exceeds the default ceiling", () => {
    // 150 jobs at these real per-call averages: maxCostUsd ~= $6.32 (worst
    // case, MAX_OUTPUT_TOKENS per job) vs. probableCostUsd ~= $2.85 (typical
    // case) -- comfortably on opposite sides of the $5 default ceiling.
    // Mutating the ceiling check to use `probableCostUsd` instead of
    // `maxCostUsd` would flip this specific assertion from refused to
    // allowed, which is exactly the under-check this test exists to catch.
    const estimate = estimateScoringCost(makeJobs(150), resumeText, realisticUsageStats);
    expect(estimate.probableCostUsd).toBeLessThan(MAX_ESTIMATED_SPEND_USD);
    expect(estimate.maxCostUsd).toBeGreaterThan(MAX_ESTIMATED_SPEND_USD);

    // Pass the WHOLE estimate, not `estimate.maxCostUsd` -- a bare number
    // here would let checkSpendCeiling's field choice go untested (see the
    // describe block's own comment for why this matters).
    const check = checkSpendCeiling(estimate);
    expect(check.withinCeiling).toBe(false);
  });

  it("allows a batch whose REAL worst-case cost is within the default ceiling", () => {
    // 100 jobs at the same real per-call averages: maxCostUsd ~= $4.22,
    // safely under the $5 ceiling -- confirms the ceiling isn't simply
    // refusing everything, only batches that actually exceed it.
    const estimate = estimateScoringCost(makeJobs(100), resumeText, realisticUsageStats);
    expect(estimate.maxCostUsd).toBeLessThan(MAX_ESTIMATED_SPEND_USD);

    const check = checkSpendCeiling(estimate);
    expect(check.withinCeiling).toBe(true);
  });
});

// Real Postgres, not a mock: the whole point of this feature is a WHERE
// clause (a LEFT JOIN + isNull/ne/or condition), which isn't meaningfully
// testable as a pure function -- unlike the rest of this file, which follows
// this script family's established "pure logic only, DB/API I/O paths carry
// their own carve-out" convention. Follows the exact same createTestDatabase
// pattern already used for real-DB coverage elsewhere in this codebase
// (ingestJobs.test.ts, routes/resumes.test.ts).
describe("fetchExistingMatches — dismissed-job exclusion (ticket ccc3d6e)", () => {
  let testDb: TestDatabase;
  const DATA_SOURCE = "rescore-test-source";
  const RESUME_ID = "rescore-test-resume";

  beforeAll(async () => {
    testDb = await createTestDatabase("rescore_existing_matches_test");
    const db = testDb.db;
    await db
      .insert(sourceDescriptors)
      .values({ id: DATA_SOURCE, displayName: "Rescore Test Source" });
    await db.insert(resumes).values({
      id: RESUME_ID,
      resumeText: "resume text",
      resumeHash: "rescore-test-resume-hash",
      resumeNickname: "Resume 1",
    });
  });

  afterAll(async () => {
    await testDb?.teardown();
  });

  async function seedJobMatch(status: "dismissed" | "saved" | null): Promise<string> {
    const db = testDb.db;
    const jobId = randomUUID();
    await db.insert(jobs).values({
      id: jobId,
      externalId: `ext-${jobId}`,
      dataSource: DATA_SOURCE,
      title: "Software Engineer",
      description: "A real job description.",
      company: "Acme",
      linkToApply: "https://example.com/apply",
      postedAt: new Date("2026-01-01"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId: RESUME_ID,
      jobId,
      matchScore: 70,
      rationale: "Old rationale.",
    });
    if (status !== null) {
      await db.insert(userJobStatuses).values({
        id: randomUUID(),
        jobId,
        status,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return jobId;
  }

  it("excludes a dismissed job by default, but includes an untouched and a saved job", async () => {
    const untouchedId = await seedJobMatch(null);
    const savedId = await seedJobMatch("saved");
    const dismissedId = await seedJobMatch("dismissed");

    const result = await fetchExistingMatches(testDb.db, RESUME_ID, false);
    const ids = new Set(result.map((r) => r.jobId));

    expect(ids.has(untouchedId)).toBe(true);
    expect(ids.has(savedId)).toBe(true);
    expect(ids.has(dismissedId)).toBe(false);
  });

  it("--include-dismissed restores the dismissed job", async () => {
    const dismissedId = await seedJobMatch("dismissed");

    const excluded = await fetchExistingMatches(testDb.db, RESUME_ID, false);
    expect(excluded.some((r) => r.jobId === dismissedId)).toBe(false);

    const included = await fetchExistingMatches(testDb.db, RESUME_ID, true);
    expect(included.some((r) => r.jobId === dismissedId)).toBe(true);
  });
});
