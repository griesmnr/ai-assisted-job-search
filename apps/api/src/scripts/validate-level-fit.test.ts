import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedJob } from "../sources/types.js";
import {
  buildStratifiedSample,
  checkSpendCeiling,
  computeControlTally,
  computeFloorCrossings,
  computeMeanAbsDiff,
  computeNoiseVsEffect,
  computeRankChanges,
  estimateValidationCost,
  loadHistoricalAverages,
  mapWithConcurrency,
  matchCorpusToLivePool,
  rankJobs,
  scoreBothArms,
  withRetry,
  CONTROL_MINIMUM,
  MAX_ESTIMATED_SPEND_USD,
  MAX_SAMPLE_SIZE,
  REPEAT_SUBSET_SIZE,
  SAMPLE_SIZE,
  type HistoricalMatchEntry,
  type SampleCandidate,
} from "./validate-level-fit.js";

function makeLiveJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
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

function makeCandidate(overrides: Partial<SampleCandidate> = {}): SampleCandidate {
  return {
    jobId: randomUUID(),
    externalId: "ext-1",
    title: "Software Engineer",
    company: "Acme",
    oldMatchScore: 40,
    oldRationale: "A reasonable skills match with no leveling concerns noted.",
    liveJob: makeLiveJob(),
    ...overrides,
  };
}

describe("matchCorpusToLivePool", () => {
  it("matches a historical entry to a live job by externalId + company", () => {
    const corpus: HistoricalMatchEntry[] = [
      {
        jobId: "j1",
        externalId: "8036387",
        title: "Software Engineer II",
        company: "Samsara",
        matchScore: 78,
        rationale: "Strong match.",
      },
    ];
    const livePool = [makeLiveJob({ externalId: "8036387", company: "Samsara" })];

    const { matched, skipped } = matchCorpusToLivePool(corpus, livePool);

    expect(skipped).toEqual([]);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.liveJob.company).toBe("Samsara");
    expect(matched[0]!.oldMatchScore).toBe(78);
  });

  it("skips a historical entry with no live match (expired/filled/withdrawn) and reports it", () => {
    const corpus: HistoricalMatchEntry[] = [
      {
        jobId: "j1",
        externalId: "does-not-exist",
        title: "Gone",
        company: "Nowhere",
        matchScore: 60,
        rationale: "n/a",
      },
    ];

    const { matched, skipped } = matchCorpusToLivePool(corpus, []);

    expect(matched).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.jobId).toBe("j1");
  });

  it("disambiguates by company when the same externalId appears from more than one live source", () => {
    const corpus: HistoricalMatchEntry[] = [
      {
        jobId: "j1",
        externalId: "123",
        title: "Engineer",
        company: "RealCo",
        matchScore: 50,
        rationale: "n/a",
      },
    ];
    const livePool = [
      makeLiveJob({ externalId: "123", company: "OtherCo", dataSource: "lever" }),
      makeLiveJob({ externalId: "123", company: "RealCo", dataSource: "ashby" }),
    ];

    const { matched } = matchCorpusToLivePool(corpus, livePool);

    expect(matched).toHaveLength(1);
    expect(matched[0]!.liveJob.company).toBe("RealCo");
    expect(matched[0]!.liveJob.dataSource).toBe("ashby");
  });
});

describe("buildStratifiedSample", () => {
  it("includes every tier-1 (at/above floor) job unconditionally, even past targetSize", () => {
    const tier1Jobs = Array.from({ length: 8 }, (_, i) =>
      makeCandidate({ jobId: `tier1-${i}`, oldMatchScore: 60 }),
    );

    const result = buildStratifiedSample(tier1Jobs, { targetSize: 5, matchScoreFloor: 55 });

    expect(result.tier1Count).toBe(8);
    expect(result.selected).toHaveLength(8);
  });

  it("fills tier 2 (level-language jobs) up to targetSize after tier 1", () => {
    const tier1 = [makeCandidate({ jobId: "t1", oldMatchScore: 70, oldRationale: "great fit" })];
    const tier2 = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        jobId: `t2-${i}`,
        oldMatchScore: 30,
        oldRationale: "candidate is overqualified for this posting",
      }),
    );

    const result = buildStratifiedSample([...tier1, ...tier2], {
      targetSize: 3,
      matchScoreFloor: 55,
      controlMinimum: 0,
    });

    // 1 tier-1 (unconditional) + 2 tier-2 (fills the remaining 2 of targetSize 3)
    expect(result.selected).toHaveLength(3);
    expect(result.tier1Count).toBe(1);
    expect(result.tier2AddedCount).toBe(2);
  });

  it("guarantees the control minimum even past targetSize", () => {
    const nonControls = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        jobId: `nc-${i}`,
        oldMatchScore: 30,
        oldRationale: "candidate is overqualified for this posting",
      }),
    );
    const controls = Array.from({ length: 4 }, (_, i) =>
      makeCandidate({
        jobId: `c-${i}`,
        oldMatchScore: 30,
        oldRationale: "solid technical alignment, no concerns",
      }),
    );

    const result = buildStratifiedSample([...nonControls, ...controls], {
      targetSize: 5,
      controlMinimum: 4,
      matchScoreFloor: 55,
    });

    // targetSize alone would only leave room for tier1(0)+tier2(5) = 5, no
    // room left for controls -- but the control minimum must still be met,
    // even though this pushes the sample to 9.
    expect(result.controlCount).toBeGreaterThanOrEqual(4);
    expect(result.selected.length).toBeGreaterThan(5);
  });

  it("does not pad the control count when fewer controls are available than the minimum", () => {
    const nonControls = Array.from({ length: 5 }, (_, i) =>
      makeCandidate({
        jobId: `nc-${i}`,
        oldRationale: "candidate is overqualified for this posting",
      }),
    );
    const oneControl = [makeCandidate({ jobId: "only-control", oldRationale: "solid fit" })];

    const result = buildStratifiedSample([...nonControls, ...oneControl], {
      targetSize: 10,
      controlMinimum: 15,
      matchScoreFloor: 55,
    });

    expect(result.controlCount).toBe(1);
    expect(result.selected).toHaveLength(6);
  });

  it("fills remaining slots with tier 4 (whatever's left) up to targetSize", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ jobId: `x-${i}`, oldMatchScore: 30, oldRationale: "fine skills match" }),
    );

    const result = buildStratifiedSample(candidates, {
      targetSize: 4,
      controlMinimum: 2,
      matchScoreFloor: 55,
    });

    expect(result.selected).toHaveLength(4);
    expect(result.controlsAddedCount).toBe(2);
    expect(result.fillAddedCount).toBe(2);
  });

  it("selects exactly what's available (no artificial padding) when that's already under targetSize", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ jobId: `x-${i}`, oldMatchScore: 60 }),
    );

    const result = buildStratifiedSample(candidates, {
      targetSize: 50,
      controlMinimum: 15,
      matchScoreFloor: 55,
    });

    // All 20 are tier-1 (>= floor) and already satisfy controlMinimum, so
    // tier 2/4 have nothing left to add -- the result is exactly the 20
    // available, not padded up toward targetSize=50.
    expect(result.selected).toHaveLength(20);
    expect(result.tier2AddedCount).toBe(0);
    expect(result.fillAddedCount).toBe(0);
    expect(result.hardCapped).toBe(false);
  });

  it("truncates the sample to hardCap when tier 1 alone (unconditional) exceeds it (S4 secondary defense, opus review round 1)", () => {
    const hugeTier1 = Array.from({ length: 80 }, (_, i) =>
      makeCandidate({ jobId: `t1-${i}`, oldMatchScore: 70 }),
    );

    const result = buildStratifiedSample(hugeTier1, {
      targetSize: 50,
      controlMinimum: 15,
      matchScoreFloor: 55,
      hardCap: 60,
    });

    expect(result.tier1Count).toBe(80);
    expect(result.selected).toHaveLength(60);
    expect(result.hardCapped).toBe(true);
  });

  it("does not truncate when the sample is already at or under the default MAX_SAMPLE_SIZE", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ jobId: `x-${i}`, oldMatchScore: 70 }),
    );
    expect(10).toBeLessThan(MAX_SAMPLE_SIZE);

    const result = buildStratifiedSample(candidates, { matchScoreFloor: 55 });

    expect(result.selected).toHaveLength(10);
    expect(result.hardCapped).toBe(false);
  });

  it("never duplicates a candidate across tiers", () => {
    // A tier-1 job that ALSO has level language and ALSO has no level
    // language depending on how it's phrased -- construct one job that
    // qualifies for both tier 1 and tier 2 to confirm it's only added once.
    const dualTierJob = makeCandidate({
      jobId: "dual",
      oldMatchScore: 70,
      oldRationale: "candidate is overqualified for this posting",
    });

    const result = buildStratifiedSample([dualTierJob], {
      targetSize: 50,
      controlMinimum: 0,
      matchScoreFloor: 55,
    });

    expect(result.selected).toHaveLength(1);
    expect(result.tier1Count).toBe(1);
    expect(result.tier2AddedCount).toBe(0);
  });
});

describe("loadHistoricalAverages", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-level-fit-test-"));

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
  });

  it("computes real per-call averages from a valid stats file", () => {
    const filePath = path.join(tmpDir, "stats.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        model: "claude-sonnet-5",
        calls: 200,
        totalInputTokens: 774900,
        totalOutputTokens: 90845,
      }),
    );

    const result = loadHistoricalAverages(filePath);

    expect(result).toBeDefined();
    expect(result!.calls).toBe(200);
    expect(result!.avgInputTokens).toBeCloseTo(3874.5, 5);
    expect(result!.avgOutputTokens).toBeCloseTo(454.225, 5);
  });

  it("returns undefined when the file does not exist", () => {
    expect(loadHistoricalAverages(path.join(tmpDir, "nope.json"))).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "{not json");

    expect(loadHistoricalAverages(filePath)).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    const filePath = path.join(tmpDir, "incomplete.json");
    fs.writeFileSync(filePath, JSON.stringify({ model: "claude-sonnet-5", calls: 0 }));

    expect(loadHistoricalAverages(filePath)).toBeUndefined();
  });
});

describe("estimateValidationCost", () => {
  it("reproduces ticket d8746eb's own worked cost estimate ($0.01843/call uncached, ~$2.65 total)", () => {
    const result = estimateValidationCost(3874.5, 454.2, 50, 20);

    // Per-call uncached cost for arm A, per the ticket's Notes section.
    const perCallArmA = result.costArmAUsd / result.callsArmA;
    expect(perCallArmA).toBeCloseTo(0.01843, 4);

    const perCallArmB = result.costArmBUsd / result.callsArmB;
    expect(perCallArmB).toBeCloseTo(0.01942, 4);

    expect(result.callsArmA).toBe(70);
    expect(result.callsArmB).toBe(70);
    expect(result.totalCalls).toBe(140);
    expect(result.totalCostUsd).toBeCloseTo(2.65, 1);
  });

  it("scales calls with sampleSize and repeatSubsetSize", () => {
    const result = estimateValidationCost(1000, 500, 10, 0);
    expect(result.callsArmA).toBe(10);
    expect(result.callsArmB).toBe(10);
    expect(result.totalCalls).toBe(20);
  });

  it("prices arm B's extra output tokens on top of the arm-A average", () => {
    const withoutExtra = estimateValidationCost(1000, 500, 1, 0, 0);
    const withExtra = estimateValidationCost(1000, 500, 1, 0, 100);
    expect(withExtra.costArmBUsd).toBeGreaterThan(withoutExtra.costArmBUsd);
    expect(withExtra.costArmAUsd).toBeCloseTo(withoutExtra.costArmAUsd, 10);
  });
});

describe("checkSpendCeiling (R5/S4, the actual spend gate)", () => {
  it("is within ceiling for the ticket's own approved ~$2.65 worked estimate", () => {
    const estimate = estimateValidationCost(3874.5, 454.2, SAMPLE_SIZE, REPEAT_SUBSET_SIZE);
    const check = checkSpendCeiling(estimate);

    expect(check.withinCeiling).toBe(true);
    expect(check.ceilingUsd).toBe(MAX_ESTIMATED_SPEND_USD);
  });

  it("refuses a sample size large enough to reproduce S4's identified ~$3.22 worst case (large tier-1 count stacked with the guaranteed control minimum)", () => {
    // S4's worst case: tier 1 (unconditional) alone spikes past
    // targetSize, and tier 3 still guarantees CONTROL_MINIMUM controls on
    // top of that -- reproduced here directly against
    // `buildStratifiedSample` rather than hand-picking a sample size, so
    // this test would catch a regression in EITHER the sampling logic or
    // the ceiling check.
    const hugeTier1 = Array.from({ length: 65 }, (_, i) =>
      makeCandidate({ jobId: `t1-${i}`, oldMatchScore: 70 }),
    );
    const sampleResult = buildStratifiedSample(hugeTier1, {
      targetSize: SAMPLE_SIZE,
      controlMinimum: CONTROL_MINIMUM,
      matchScoreFloor: 55,
      hardCap: Number.POSITIVE_INFINITY, // isolate the cost check itself, not the S4 construction-time cap
    });
    const estimate = estimateValidationCost(
      3874.5,
      454.2,
      sampleResult.selected.length,
      REPEAT_SUBSET_SIZE,
    );

    expect(estimate.totalCostUsd).toBeGreaterThan(MAX_ESTIMATED_SPEND_USD);
    const check = checkSpendCeiling(estimate);
    expect(check.withinCeiling).toBe(false);
  });

  it("respects a caller-supplied ceiling override", () => {
    const estimate = estimateValidationCost(1000, 500, 10, 0);
    expect(checkSpendCeiling(estimate, estimate.totalCostUsd - 0.01).withinCeiling).toBe(false);
    expect(checkSpendCeiling(estimate, estimate.totalCostUsd + 0.01).withinCeiling).toBe(true);
  });
});

describe("rankJobs / computeRankChanges (shipped tiebreak ordering)", () => {
  it("ranks strictly by matchScore descending", () => {
    const ranked = rankJobs([
      { jobId: "a", title: "A", company: "Co", matchScore: 40 },
      { jobId: "b", title: "B", company: "Co", matchScore: 80 },
      { jobId: "c", title: "C", company: "Co", matchScore: 60 },
    ]);

    expect(ranked.map((r) => r.jobId)).toEqual(["b", "c", "a"]);
  });

  it("breaks a matchScore tie by levelFit (well_matched before unjudged before underqualified before overqualified)", () => {
    const ranked = rankJobs([
      { jobId: "over", title: "T", company: "Co", matchScore: 70, levelFit: "overqualified" },
      { jobId: "well", title: "T", company: "Co", matchScore: 70, levelFit: "well_matched" },
      { jobId: "under", title: "T", company: "Co", matchScore: 70, levelFit: "underqualified" },
      { jobId: "unjudged", title: "T", company: "Co", matchScore: 70 },
    ]);

    expect(ranked.map((r) => r.jobId)).toEqual(["well", "unjudged", "under", "over"]);
  });

  it("never lets levelFit move a job ahead of one with a strictly higher score", () => {
    const ranked = rankJobs([
      { jobId: "high-over", title: "T", company: "Co", matchScore: 80, levelFit: "overqualified" },
      { jobId: "low-well", title: "T", company: "Co", matchScore: 60, levelFit: "well_matched" },
    ]);

    expect(ranked.map((r) => r.jobId)).toEqual(["high-over", "low-well"]);
  });

  it("breaks a fully-tied score+levelFit by jobId ascending", () => {
    const ranked = rankJobs([
      { jobId: "b", title: "T", company: "Co", matchScore: 70, levelFit: "well_matched" },
      { jobId: "a", title: "T", company: "Co", matchScore: 70, levelFit: "well_matched" },
    ]);

    expect(ranked.map((r) => r.jobId)).toEqual(["a", "b"]);
  });

  it("ranks BOTH the old and new lists over the SAME intersection of jobs present in both (R1 fix, opus review round 1)", () => {
    const oldJobs = [
      { jobId: "a", title: "A", company: "Co", matchScore: 80 },
      { jobId: "b", title: "B", company: "Co", matchScore: 60 },
      { jobId: "only-old", title: "OO", company: "Co", matchScore: 50 },
    ];
    const newJobs = [
      { jobId: "a", title: "A", company: "Co", matchScore: 55, levelFit: "overqualified" as const },
      { jobId: "b", title: "B", company: "Co", matchScore: 80, levelFit: "well_matched" as const },
      { jobId: "only-new", title: "ON", company: "Co", matchScore: 90 },
    ];

    const rows = computeRankChanges(oldJobs, newJobs);

    expect(rows.map((r) => r.jobId).sort()).toEqual(["a", "b"]);
    const a = rows.find((r) => r.jobId === "a")!;
    const b = rows.find((r) => r.jobId === "b")!;
    // "only-old" and "only-new" are excluded from BOTH rankings entirely,
    // not just missing from the output rows -- the intersection is {a, b}.
    // Old ranking (2 jobs, over the intersection only): a (#1, 80), b (#2,
    // 60). New ranking (2 jobs, same intersection): b (#1, 80) outranks a
    // (#2, 55).
    //
    // Before the R1 fix, the old list was ranked over ALL 3 old-list rows
    // while the new list was ranked over ALL 3 new-list rows (two
    // DIFFERENTLY-SIZED rankings) -- "only-new" (90) would then outrank
    // both a and b in the new ranking, fabricating oldRank=1/newRank=3
    // (rankDelta=-2) for "a" and oldRank=2/newRank=2 (rankDelta=0) for "b",
    // even though neither of those numbers reflects a's or b's position
    // relative to each other.
    expect(a.oldRank).toBe(1);
    expect(a.newRank).toBe(2);
    expect(a.rankDelta).toBe(-1);
    expect(b.oldRank).toBe(2);
    expect(b.newRank).toBe(1);
    expect(b.rankDelta).toBe(1);
  });

  it("does not skew unrelated jobs' ranks when one job's arm-B call failed (R1 regression, opus review round 1)", () => {
    // Worst case identified in review: if the single TOP-scoring job's
    // arm-B call fails and is absent from the new list, ranking the old
    // list over ALL its rows (including the failed job) while ranking the
    // new list over only the survivors used to shift every remaining job's
    // new rank up by one relative to its old rank -- fabricating "moved up
    // by 1" for every other job, none of which actually changed at all.
    const oldJobs = [
      { jobId: "top", title: "Top", company: "Co", matchScore: 90 },
      { jobId: "mid", title: "Mid", company: "Co", matchScore: 70 },
      { jobId: "low", title: "Low", company: "Co", matchScore: 50 },
    ];
    // "top"'s arm-B call failed -- it's simply absent from the new list,
    // exactly like a `rows.filter((r) => r.armB)` result would produce.
    const newJobs = [
      { jobId: "mid", title: "Mid", company: "Co", matchScore: 70 },
      { jobId: "low", title: "Low", company: "Co", matchScore: 50 },
    ];

    const rows = computeRankChanges(oldJobs, newJobs);

    const mid = rows.find((r) => r.jobId === "mid")!;
    const low = rows.find((r) => r.jobId === "low")!;
    expect(mid.oldRank).toBe(1);
    expect(mid.newRank).toBe(1);
    expect(mid.rankDelta).toBe(0);
    expect(low.oldRank).toBe(2);
    expect(low.newRank).toBe(2);
    expect(low.rankDelta).toBe(0);
  });
});

describe("computeFloorCrossings", () => {
  it("classifies a job moving from below floor to at/above it as into-display", () => {
    const summary = computeFloorCrossings(
      [
        {
          jobId: "a",
          title: "A",
          company: "Co",
          oldScore: 50,
          newScore: 60,
          levelFit: "well_matched",
        },
      ],
      55,
    );

    expect(summary.rows[0]!.direction).toBe("into-display");
    expect(summary.intoDisplayCount).toBe(1);
    expect(summary.outOfDisplayCount).toBe(0);
    expect(summary.byLevelFit["well_matched"]).toEqual({ into: 1, out: 0 });
  });

  it("classifies a job moving from at/above floor to below it as out-of-display", () => {
    const summary = computeFloorCrossings(
      [
        {
          jobId: "a",
          title: "A",
          company: "Co",
          oldScore: 60,
          newScore: 50,
          levelFit: "overqualified",
        },
      ],
      55,
    );

    expect(summary.rows[0]!.direction).toBe("out-of-display");
    expect(summary.outOfDisplayCount).toBe(1);
    expect(summary.byLevelFit["overqualified"]).toEqual({ into: 0, out: 1 });
  });

  it("classifies a job that stays on the same side of the floor as unchanged", () => {
    const summary = computeFloorCrossings([
      { jobId: "a", title: "A", company: "Co", oldScore: 60, newScore: 65 },
      { jobId: "b", title: "B", company: "Co", oldScore: 40, newScore: 45 },
    ]);

    expect(summary.rows.every((r) => r.direction === "unchanged")).toBe(true);
    expect(summary.intoDisplayCount).toBe(0);
    expect(summary.outOfDisplayCount).toBe(0);
  });

  it("buckets an unjudged (null levelFit) crossing under 'unjudged'", () => {
    const summary = computeFloorCrossings([
      { jobId: "a", title: "A", company: "Co", oldScore: 50, newScore: 60, levelFit: null },
    ]);

    expect(summary.byLevelFit["unjudged"]).toEqual({ into: 1, out: 0 });
  });
});

describe("computeNoiseVsEffect", () => {
  it("computes mean absolute effect and mean absolute noise separately", () => {
    const result = computeNoiseVsEffect(
      [
        { armA: 60, armB: 65 },
        { armA: 40, armB: 30 },
      ],
      [
        { run1: 60, run2: 58 },
        { run1: 70, run2: 76 },
      ],
    );

    // mean(|65-60|, |30-40|) = mean(5, 10) = 7.5
    expect(result.meanAbsEffect).toBeCloseTo(7.5, 5);
    expect(result.effectSampleSize).toBe(2);
    // mean(|58-60|, |76-70|) = mean(2, 6) = 4
    expect(result.meanAbsNoise).toBeCloseTo(4, 5);
    expect(result.noiseSampleSize).toBe(2);
  });

  it("reports meanAbsNoise as undefined (not 0 or NaN) when there is no repeat data", () => {
    const result = computeNoiseVsEffect([{ armA: 60, armB: 65 }], []);

    expect(result.meanAbsNoise).toBeUndefined();
    expect(result.noiseSampleSize).toBe(0);
  });
});

describe("computeMeanAbsDiff (R3: mean |A - old| drift; R4: arm B's own noise floor)", () => {
  it("computes the mean absolute difference across pairs", () => {
    const result = computeMeanAbsDiff([
      { a: 60, b: 65 },
      { a: 40, b: 30 },
    ]);

    // mean(|65-60|, |30-40|) = mean(5, 10) = 7.5
    expect(result.mean).toBeCloseTo(7.5, 5);
    expect(result.sampleSize).toBe(2);
  });

  it("reports mean as undefined (not 0 or NaN) when there are no pairs", () => {
    const result = computeMeanAbsDiff([]);

    expect(result.mean).toBeUndefined();
    expect(result.sampleSize).toBe(0);
  });
});

describe("computeControlTally", () => {
  it("tallies well_matched vs. misses among controls", () => {
    const tally = computeControlTally([
      { jobId: "a", title: "A", company: "Co", levelFit: "well_matched", levelFitNote: "" },
      {
        jobId: "b",
        title: "B",
        company: "Co",
        levelFit: "overqualified",
        levelFitNote: "surprising",
      },
      { jobId: "c", title: "C", company: "Co", levelFit: "well_matched", levelFitNote: "" },
    ]);

    expect(tally.total).toBe(3);
    expect(tally.wellMatchedCount).toBe(2);
    expect(tally.misses).toHaveLength(1);
    expect(tally.misses[0]!.jobId).toBe("b");
  });

  it("treats a missing/undefined levelFit as a miss, not a silent pass", () => {
    const tally = computeControlTally([
      { jobId: "a", title: "A", company: "Co", levelFit: undefined, levelFitNote: undefined },
    ]);

    expect(tally.wellMatchedCount).toBe(0);
    expect(tally.misses).toHaveLength(1);
  });
});

describe("mapWithConcurrency", () => {
  it("processes every item and preserves result order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(results.map((r) => (r.status === "fulfilled" ? r.value : undefined))).toEqual([
      30, 10, 20,
    ]);
  });

  it("never runs more than `limit` items concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("isolates one item's rejection from the others (allSettled semantics)", async () => {
    const items = [1, 2, 3];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n * 10;
    });

    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[1]!.status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 30 });
  });
});

describe("withRetry (S1: one bounded retry with backoff)", () => {
  it("returns the result on the first try without retrying when fn succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries once after a failure and succeeds on the second attempt", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        return "ok";
      },
      { retries: 1, baseDelayMs: 1 },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("throws the last error after exhausting all retries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { retries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("fail 2");
    expect(calls).toBe(2);
  });

  it("never retries when retries: 0", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("nope");
        },
        { retries: 0, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});

describe("scoreBothArms (S1: one shared concurrency pool across both arms)", () => {
  it("returns arm-A and arm-B results in the same order as the input items", async () => {
    const items = ["x", "y", "z"];
    const { armA, armB } = await scoreBothArms(
      items,
      2,
      async (item) => `A:${item}`,
      async (item) => `B:${item}`,
    );

    expect(armA.map((r) => (r.status === "fulfilled" ? r.value : undefined))).toEqual([
      "A:x",
      "A:y",
      "A:z",
    ]);
    expect(armB.map((r) => (r.status === "fulfilled" ? r.value : undefined))).toEqual([
      "B:x",
      "B:y",
      "B:z",
    ]);
  });

  it("never runs more than `concurrency` calls in flight TOTAL across both arms combined (the S1 bug: two separate pools each bounded to the same limit used to double the real concurrency)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async (): Promise<void> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
    };
    const items = Array.from({ length: 10 }, (_, i) => i);

    await scoreBothArms(
      items,
      3,
      async () => track(),
      async () => track(),
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("isolates one arm's rejection from the other arm and from other items", async () => {
    const items = [1, 2, 3];
    const { armA, armB } = await scoreBothArms(
      items,
      2,
      async (n) => {
        if (n === 2) throw new Error("armA boom");
        return `A:${n}`;
      },
      async (n) => `B:${n}`,
    );

    expect(armA[0]).toEqual({ status: "fulfilled", value: "A:1" });
    expect(armA[1]!.status).toBe("rejected");
    expect(armA[2]).toEqual({ status: "fulfilled", value: "A:3" });
    expect(armB.every((r) => r.status === "fulfilled")).toBe(true);
  });
});
