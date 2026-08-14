import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, searches, searchResults, resumes, sourceDescriptors } from "../db/schema.js";
import type { NormalizedJob } from "../sources/types.js";
import { ingestJobsForSearch } from "./ingestJobs.js";

// Node 22 can read .env itself - no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const db = drizzle(client);

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
  await client.connect();
  await db.insert(sourceDescriptors).values({ id: DATA_SOURCE, displayName: "Ingest Test Source" });
  await db.insert(resumes).values({ id: RESUME_ID, resumeText: "resume text" });
  await db.insert(searches).values([
    { id: SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() },
    { id: OTHER_SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(searchResults).where(eq(searchResults.searchId, SEARCH_ID));
  await db.delete(searchResults).where(eq(searchResults.searchId, OTHER_SEARCH_ID));
  await db.delete(searches).where(eq(searches.id, SEARCH_ID));
  await db.delete(searches).where(eq(searches.id, OTHER_SEARCH_ID));
  await db.delete(jobs).where(eq(jobs.dataSource, DATA_SOURCE));
  await db.delete(resumes).where(eq(resumes.id, RESUME_ID));
  await db.delete(sourceDescriptors).where(eq(sourceDescriptors.id, DATA_SOURCE));
  await client.end();
});

describe("ingestJobsForSearch", () => {
  it("ingesting the same posting twice results in one row (6bf2196)", async () => {
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
    const result = await ingestJobsForSearch(db, SEARCH_ID, DATA_SOURCE, []);
    expect(result).toEqual({ linkedJobIds: [], newlyInsertedJobIds: [] });
  });
});
