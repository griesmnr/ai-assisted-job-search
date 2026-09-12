import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedJob } from "../sources/types.js";
import {
  buildStratifiedSample,
  computeControlTally,
  computeFloorCrossings,
  computeNoiseVsEffect,
  computeRankChanges,
  estimateValidationCost,
  loadHistoricalAverages,
  mapWithConcurrency,
  matchCorpusToLivePool,
  rankJobs,
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

  it("caps the total sample at targetSize when tier1+tier2+controls already satisfy it", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ jobId: `x-${i}`, oldMatchScore: 60 }),
    );

    const result = buildStratifiedSample(candidates, {
      targetSize: 50,
      controlMinimum: 15,
      matchScoreFloor: 55,
    });

    expect(result.selected).toHaveLength(20);
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

  it("computes rank deltas only for jobs present in both the old and new lists", () => {
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
    // Old ranking (2 jobs): a (#1, 80), b (#2, 60).
    // New ranking (3 jobs, "only-new" at 90 outranks both): only-new (#1,
    // 90), b (#2, 80), a (#3, 55).
    expect(a.oldRank).toBe(1);
    expect(a.newRank).toBe(3);
    expect(a.rankDelta).toBe(-2);
    expect(b.oldRank).toBe(2);
    expect(b.newRank).toBe(2);
    expect(b.rankDelta).toBe(0);
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
