import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs, resumes, searches, sourceDescriptors } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import type { NormalizedJob } from "../sources/types.js";
import {
  DIFFERENT_REQ_SAME_COMPANY,
  SAME_REQ_ATS_A,
  SAME_REQ_ATS_B,
} from "./textSimilarity.fixtures.js";

/**
 * A REAL A/B, not an assertion in a comment (ticket 78d31b7's acceptance
 * criteria ask for the check measured ON and OFF, on a representative
 * batch, with the numbers reported).
 *
 * "Off" is produced by swapping `findCrossSourceDuplicates` for a function
 * that returns an empty map — which is exactly what `ingestJobsForSearch`
 * did before this ticket, so the baseline really is the old code path and
 * not a differently-shaped stand-in. Everything else (the same database,
 * the same seeded corpus, the same batch size, the same inserts) is held
 * constant.
 *
 * Lives in its own file because the mock is file-wide and would otherwise
 * disable the very thing `crossSourceDedup.test.ts` exists to test.
 *
 * WHAT THIS PRINTED ON 2026-09-23 (dev container), for the record — rerun
 * it to regenerate, the assertions below are deliberately loose because the
 * POINT is the numbers, not a millisecond budget:
 *
 *   check OFF (pre-ticket baseline)          151 ms
 *   check ON, no candidates (today's state)  163 ms   (+11 ms, +7.6%)
 *   check ON, every posting has a candidate  369 ms  (+218 ms, +144%)
 *
 * and, with SEEDED_CORPUS temporarily raised to 20,000 to see how the
 * unindexed candidate scan scales: +58 ms for the no-candidate case,
 * i.e. about 3 ms per 1,000 rows of `jobs` per ingest call. See
 * crossSourceDuplicates.ts's MEASURED COST section for what follows from
 * that and when an index becomes worth adding.
 */
const checkState = vi.hoisted(() => ({ enabled: true }));

vi.mock("./crossSourceDuplicates.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crossSourceDuplicates.js")>();
  return {
    ...actual,
    findCrossSourceDuplicates: async (
      ...args: Parameters<typeof actual.findCrossSourceDuplicates>
    ) => (checkState.enabled ? actual.findCrossSourceDuplicates(...args) : new Map()),
  };
});

import { ingestJobsForSearch } from "./ingestJobs.js";

loadEnvFile();

let testDb: TestDatabase;

const SEED_SOURCE: string = "perf-test-source-seed";
const INGEST_SOURCE: string = "perf-test-source-ingest";
const RESUME_ID = "perf-test-resume";
const SEARCH_ID = "perf-test-search";

/**
 * Matches the live per-source volumes measured on 2026-09-23 (98844f1
 * comment #1: rippling 619, smartrecruiters 493, ashby 433, lever 396,
 * workable 298, recruitee 65 — 2,304 jobs total across 8 sources). The
 * seeded corpus is the whole database the check has to search; the batch is
 * one source's response, sized above the largest real one so the number
 * reported is pessimistic rather than flattering.
 */
const SEEDED_CORPUS = 2400;
const BATCH_SIZE = 1200;

/** Timed runs per scenario, after a discarded warm-up. */
const RUNS = 3;

function makeJob(dataSource: string, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext",
    dataSource: dataSource as NormalizedJob["dataSource"],
    title: "Software Engineer",
    description: SAME_REQ_ATS_A,
    company: "Perf Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** Timings are noisy on a shared dev container; the median of a few runs is
 * a far more honest number to quote than a single sample or a mean. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function timeIngest(enabled: boolean, tag: string, batch: NormalizedJob[]): Promise<number> {
  checkState.enabled = enabled;
  const samples: number[] = [];
  // One warm-up (discarded): the first call pays for query planning and
  // connection warm-up that has nothing to do with this check.
  for (let run = 0; run < RUNS + 1; run++) {
    const runBatch = batch.map((job) => ({
      ...job,
      externalId: `${tag}-r${run}-${job.externalId}`,
    }));
    const started = performance.now();
    await ingestJobsForSearch(testDb.db, SEARCH_ID, INGEST_SOURCE, runBatch);
    const elapsed = performance.now() - started;
    if (run > 0) samples.push(elapsed);
  }
  return median(samples);
}

beforeAll(async () => {
  testDb = await createTestDatabase("cross_source_dedup_perf_test");
  const db = testDb.db;
  await db.insert(sourceDescriptors).values([
    { id: SEED_SOURCE, displayName: "Perf Seed Source" },
    { id: INGEST_SOURCE, displayName: "Perf Ingest Source" },
  ]);
  await db.insert(resumes).values({
    id: RESUME_ID,
    resumeText: "resume text",
    resumeHash: "perf-test-resume-hash",
    resumeNickname: "Resume 1",
  });
  await db.insert(searches).values({ id: SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() });

  // The corpus the check has to search: SEEDED_CORPUS rows under a
  // DIFFERENT source, with realistic full-length descriptions. The first
  // BATCH_SIZE of them are the ones the "every posting has a candidate"
  // scenario deliberately collides with.
  const seeded = Array.from({ length: SEEDED_CORPUS }, (_, i) => ({
    id: `perf-seed-${i}`,
    externalId: `seed-${i}`,
    dataSource: SEED_SOURCE,
    title: `Software Engineer ${i}`,
    description: i % 2 === 0 ? SAME_REQ_ATS_A : DIFFERENT_REQ_SAME_COMPANY,
    company: `Perf Company ${i}`,
    payType: "salary" as const,
    commitment: "full-time" as const,
    locationType: "remote" as const,
    location: "Remote",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
  }));
  for (let i = 0; i < seeded.length; i += 500) {
    await db.insert(jobs).values(seeded.slice(i, i + 500));
  }
}, 120000);

afterAll(async () => {
  await testDb?.teardown();
});

describe("cross-source duplicate detection: measured ingest cost", () => {
  it(
    `ingests ${BATCH_SIZE} postings against a ${SEEDED_CORPUS}-job corpus without meaningfully ` +
      `slowing ingestion`,
    async () => {
      // SCENARIO 1 — REALISTIC. No posting in the batch matches anything
      // already in the database on company + title + location. This is
      // today's actual state: 0 cross-source collisions across 2,304 live
      // jobs and 32 companies (98844f1). The check costs exactly one extra
      // SELECT that returns nothing, plus normalizing three short fields
      // per posting.
      const noCollision = Array.from({ length: BATCH_SIZE }, (_, i) =>
        makeJob(INGEST_SOURCE, {
          externalId: `nc-${i}`,
          company: `Fresh Company ${i}`,
          title: `Software Engineer ${i}`,
        }),
      );

      // SCENARIO 2 — WORST CASE. EVERY posting matches an existing row on
      // company + title + location, so gate 2 runs on all BATCH_SIZE of
      // them... and all of them FAIL it (materially different
      // descriptions), so every row is still inserted. That keeps the
      // insert work identical to the baseline, which is what makes the
      // comparison honest: the whole delta is the check itself.
      const allCollide = Array.from({ length: BATCH_SIZE }, (_, i) =>
        makeJob(INGEST_SOURCE, {
          externalId: `wc-${i}`,
          company: `Perf Company ${i}`,
          title: `Software Engineer ${i}`,
          description: i % 2 === 0 ? DIFFERENT_REQ_SAME_COMPANY : SAME_REQ_ATS_B,
        }),
      );

      const baselineMs = await timeIngest(false, "off", noCollision);
      const realisticMs = await timeIngest(true, "on", noCollision);
      const worstCaseMs = await timeIngest(true, "wc", allCollide);

      const report =
        `\n[78d31b7 measured ingest cost] batch=${BATCH_SIZE} postings, ` +
        `corpus=${SEEDED_CORPUS} jobs from another source, median of ${RUNS} runs:\n` +
        `  check OFF (pre-ticket baseline)          ${baselineMs.toFixed(0)} ms\n` +
        `  check ON, no candidates (today's state)  ${realisticMs.toFixed(0)} ms ` +
        `(${(realisticMs - baselineMs).toFixed(0)} ms, ` +
        `${(((realisticMs - baselineMs) / baselineMs) * 100).toFixed(1)}%)\n` +
        `  check ON, every posting has a candidate  ${worstCaseMs.toFixed(0)} ms ` +
        `(${(worstCaseMs - baselineMs).toFixed(0)} ms, ` +
        `${(((worstCaseMs - baselineMs) / baselineMs) * 100).toFixed(1)}%)\n`;
      console.log(report);

      // Deliberately loose bounds. The point of this test is to PRODUCE the
      // numbers above on whatever machine runs it; asserting a tight
      // millisecond budget would make it a flaky benchmark rather than a
      // regression guard. What it does guard is the shape of the cost: the
      // check must stay a small fraction of ingest, not double it.
      expect(realisticMs).toBeLessThan(baselineMs * 1.5 + 250);
      expect(worstCaseMs).toBeLessThan(baselineMs * 2 + 1000);
    },
    180000,
  );
});
