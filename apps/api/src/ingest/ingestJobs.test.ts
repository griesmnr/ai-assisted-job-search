import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, searches, searchResults, sourceDescriptors, resumes } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import type { NormalizedJob } from "../sources/types.js";
import { ingestJobsForSearch } from "./ingestJobs.js";

// Node 22 can read .env itself - no dotenv dependency needed (ticket 2b54470:
// tolerates a missing file, see load-env.ts).
loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see db/test-db.ts. This
// file used to connect straight to the shared dev Postgres, where the
// hardcoded fixture ids below could collide with another worktree's
// concurrent run.
let testDb: TestDatabase;

// Widened to `string` (not the const-inferred literal type) so it can be
// cast to NormalizedJob["dataSource"] below without TS treating it as an
// impossible cast between two disjoint literal types. This id only needs
// to be a valid `source_descriptors.id` FK target for this test - it is
// not meant to be a real source.
const DATA_SOURCE: string = "ingest-test-source";
const RESUME_ID = "ingest-test-resume";
const SEARCH_ID = "ingest-test-search";
const OTHER_SEARCH_ID = "ingest-test-search-2";

function makeNormalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-1",
    dataSource: DATA_SOURCE as NormalizedJob["dataSource"],
    title: "Widget Engineer",
    description: "Build widgets",
    company: "Widget Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase("ingest_jobs_test");
  const db = testDb.db;
  await db.insert(sourceDescriptors).values({ id: DATA_SOURCE, displayName: "Ingest Test Source" });
  await db.insert(resumes).values({
    id: RESUME_ID,
    resumeText: "resume text",
    resumeHash: "ingest-test-resume-hash",
    resumeNickname: "Resume 1",
  });
  await db.insert(searches).values([
    { id: SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() },
    { id: OTHER_SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() },
  ]);
});

afterAll(async () => {
  await testDb?.teardown();
});

describe("ingestJobsForSearch", () => {
  it("ingesting the same posting twice results in one row (6bf2196)", async () => {
    const db = testDb.db;
    const job = makeNormalizedJob({ externalId: "dup-1" });

    const first = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);
    expect(first.newlyInsertedJobIds).toHaveLength(1);
    expect(first.linkedJobIds).toHaveLength(1);

    // Simulate a RabbitMQ redelivery: the exact same fetch.source message
    // gets processed again from scratch.
    const second = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);

    // No new row - the second call reports nothing newly inserted...
    expect(second.newlyInsertedJobIds).toHaveLength(0);
    // ...but still correctly links the (pre-existing) job to the search.
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);

    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dataSource, DATA_SOURCE), eq(jobs.externalId, "dup-1")));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.linkedJobIds[0]);
  });

  it("does not double-publish-worthy jobs on redelivery: only the first call reports a newly inserted id", async () => {
    const db = testDb.db;
    // This is the DB-level half of "a redelivered score.job publish
    // doesn't double-publish for an already-ingested job" - the worker
    // test (fetchSourceWorker.test.ts) proves the queue-level behavior;
    // this proves the signal it relies on.
    const job = makeNormalizedJob({ externalId: "redelivery-1" });

    const first = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);

    expect(first.newlyInsertedJobIds).toEqual(first.linkedJobIds);
    expect(second.newlyInsertedJobIds).toEqual([]);
  });

  it("links a pre-existing job (ingested via a different search) without re-inserting it", async () => {
    const db = testDb.db;
    const job = makeNormalizedJob({ externalId: "cross-search-1" });

    const first = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);
    const second = await ingestJobsForSearch(db, OTHER_SEARCH_ID, DATA_SOURCE, [job]);

    expect(first.newlyInsertedJobIds).toHaveLength(1);
    // Same underlying job, already ingested by the first search - the
    // second search must not re-score it.
    expect(second.newlyInsertedJobIds).toHaveLength(0);
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);

    const links = await db
      .select()
      .from(searchResults)
      .where(eq(searchResults.jobId, first.linkedJobIds[0]));
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => l.searchId))).toEqual(new Set([SEARCH_ID, OTHER_SEARCH_ID]));
  });

  it("relinking the same (search, job) pair does not create a duplicate search_results row", async () => {
    const db = testDb.db;
    const job = makeNormalizedJob({ externalId: "relink-1" });

    await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);
    await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);
    await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, [job]);

    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dataSource, DATA_SOURCE), eq(jobs.externalId, "relink-1")));
    expect(rows).toHaveLength(1);

    const links = await db.select().from(searchResults).where(eq(searchResults.jobId, rows[0].id));
    expect(links).toHaveLength(1);
  });

  it("returns empty results for an empty jobs array without touching the DB", async () => {
    const db = testDb.db;
    const result = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, []);
    expect(result).toEqual({ linkedJobIds: [], newlyInsertedJobIds: [] });
  });

  it(
    "ingests more than 5,461 postings in one call (the real per-statement bound-parameter " +
      "ceiling for the 12-column jobs table: 65,535 / 12 ≈ 5,461, ticket 3067e2c) without " +
      "throwing, and links/reports every single one - not just the first 500-row chunk",
    async () => {
      const db = testDb.db;
      // 6,000 rows needs 12 chunks at JOBS_INSERT_CHUNK's 500-row size, and
      // an unchunked insert of this many rows (12 params/row = 72,000
      // params) is well past Postgres's 65,535 bound-parameter cap - this
      // is exactly the case that threw "Failed query: insert into jobs..."
      // before this ticket's chunking fix.
      const ROW_COUNT = 6000;
      const jobsBatch = Array.from({ length: ROW_COUNT }, (_, i) =>
        makeNormalizedJob({ externalId: `chunk-test-${i}` }),
      );

      const result = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, jobsBatch);

      expect(result.newlyInsertedJobIds).toHaveLength(ROW_COUNT);
      expect(result.linkedJobIds).toHaveLength(ROW_COUNT);
      // Every id is distinct - proves no chunk's rows were dropped or
      // double-counted across the 12 separate INSERT statements.
      expect(new Set(result.linkedJobIds).size).toBe(ROW_COUNT);

      const externalIds = jobsBatch.map((job) => job.externalId);
      const rows = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.dataSource, DATA_SOURCE), inArray(jobs.externalId, externalIds)));
      expect(rows).toHaveLength(ROW_COUNT);

      const links = await db
        .select({ id: searchResults.id })
        .from(searchResults)
        .where(
          and(
            eq(searchResults.searchId, SEARCH_ID),
            inArray(searchResults.jobId, result.linkedJobIds),
          ),
        );
      expect(links).toHaveLength(ROW_COUNT);
    },
    30000,
  );

  it(
    "correctly separates newly-inserted from pre-existing jobs when a single chunked call " +
      "mixes both, interleaved across every 500-row chunk boundary (opus review, ticket 3067e2c)",
    async () => {
      const db = testDb.db;
      // The 6,000-row test above only exercises the all-new path - every
      // row in every chunk is a fresh insert, so it can't catch a bug where
      // `inserted`/`newlyInsertedJobIds` gets reset per-chunk instead of
      // accumulated, or where a conflicting row in one chunk is mishandled
      // relative to a non-conflicting row in the next. This forces that:
      // 1,500 jobs pre-exist (ingested via a first, separate search), then
      // one 3,000-row call interleaves them 1:1 with 1,500 brand-new jobs,
      // so every 500-row JOBS_INSERT_CHUNK chunk contains an even mix of
      // conflicting and non-conflicting rows.
      const PRE_EXISTING_COUNT = 1500;
      const preExisting = Array.from({ length: PRE_EXISTING_COUNT }, (_, i) =>
        makeNormalizedJob({ externalId: `interleave-old-${i}` }),
      );
      const seeded = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, preExisting);
      expect(seeded.newlyInsertedJobIds).toHaveLength(PRE_EXISTING_COUNT);

      const interleaved: NormalizedJob[] = [];
      for (let i = 0; i < PRE_EXISTING_COUNT; i++) {
        interleaved.push(makeNormalizedJob({ externalId: `interleave-old-${i}` }));
        interleaved.push(makeNormalizedJob({ externalId: `interleave-new-${i}` }));
      }

      const result = await ingestJobsForSearch(db, OTHER_SEARCH_ID, DATA_SOURCE, interleaved);

      expect(result.linkedJobIds).toHaveLength(2 * PRE_EXISTING_COUNT);
      expect(new Set(result.linkedJobIds).size).toBe(2 * PRE_EXISTING_COUNT);
      // Exactly the "-new-" half is newly inserted - none of the
      // pre-existing "-old-" jobs' ids leaked into this set.
      expect(result.newlyInsertedJobIds).toHaveLength(PRE_EXISTING_COUNT);
      expect(new Set(result.newlyInsertedJobIds).size).toBe(PRE_EXISTING_COUNT);
      const preExistingIds = new Set(seeded.linkedJobIds);
      for (const id of result.newlyInsertedJobIds) {
        expect(preExistingIds.has(id)).toBe(false);
      }
    },
    30000,
  );

  it("rolls back the insert when the caller's dataSource doesn't match the job's own dataSource (transaction regression)", async () => {
    const db = testDb.db;
    // The job itself is tagged DATA_SOURCE (a valid FK target, so the
    // INSERT succeeds), but the caller passes a DIFFERENT dataSource as
    // the query parameter - the same shape of bug the worker's dispatch
    // check (SourceMismatchError) exists to prevent one layer up, and
    // exactly what makes the "should be impossible" throw in
    // ingestJobsForSearch fire: the row got inserted under DATA_SOURCE,
    // but the post-insert select filters on WRONG_DATA_SOURCE and finds
    // nothing. Without db.transaction() wrapping the whole function, that
    // insert would already be committed by the time the throw happens -
    // a real, permanently orphaned row from a call the caller correctly
    // treated as failed.
    const externalId = "transaction-rollback-1";
    const job = makeNormalizedJob({ externalId });
    const wrongDataSource = "ingest-test-WRONG-source";

    await expect(ingestJobsForSearch(db, SEARCH_ID, wrongDataSource, [job])).rejects.toThrow(
      /no jobs row found/,
    );

    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dataSource, DATA_SOURCE), eq(jobs.externalId, externalId)));
    expect(rows).toHaveLength(0);
  });
});
