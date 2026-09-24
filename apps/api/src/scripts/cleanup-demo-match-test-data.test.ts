import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  handoffs,
  jobMatches,
  jobMatchFailures,
  jobs as jobsTable,
  resumes,
  searches,
  searchResults,
  searchSources,
  sourceDescriptors,
  userJobStatuses,
} from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  countDependents,
  deleteTaggedResumes,
  findTaggedResumeIds,
  parseArgs,
  RESUME_TEXT_PREFIX,
} from "./cleanup-demo-match-test-data.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

const DATA_SOURCE = "usajobs" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("cleanup_demo_match_test_data_test");
  db = testDb.db;
  await db
    .insert(sourceDescriptors)
    .values({ id: DATA_SOURCE, displayName: "USAJOBS" })
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  await testDb?.teardown();
});

async function seedJob(): Promise<string> {
  const id = randomUUID();
  await db.insert(jobsTable).values({
    id,
    externalId: `cleanup-test-${id}`,
    dataSource: DATA_SOURCE,
    title: "Test Job",
    description: "a job description",
    company: "Test Co",
    linkToApply: `https://example.com/${id}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

/** Seeds one resume (tagged or not) plus one row in EVERY table that has a
 * `resumeId`/`searchId`-reachable FK to `resumes` -- job_match_failures,
 * user_job_statuses, handoffs, job_matches (direct `resume_id`), and
 * search_sources + search_results (via a `searches` row this resume owns).
 * Returns the resume id so tests can assert on exactly what survives. */
async function seedResumeWithFullDependents(tagged: boolean): Promise<string> {
  const resumeId = randomUUID();
  const resumeText = tagged
    ? `${RESUME_TEXT_PREFIX} seeded ${randomUUID()}`
    : `A real, untagged resume ${randomUUID()}`;
  await db.insert(resumes).values({
    id: resumeId,
    resumeText,
    resumeHash: randomUUID(),
    resumeNickname: tagged ? "Tagged test fixture" : "Nicole's real resume",
  });

  const jobId = await seedJob();

  const searchId = randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId, searchedAt: new Date() });

  await db.insert(searchSources).values({
    id: randomUUID(),
    searchId,
    sourceDescriptorId: DATA_SOURCE,
  });
  await db.insert(searchResults).values({ id: randomUUID(), searchId, jobId });

  await db.insert(jobMatches).values({
    id: randomUUID(),
    resumeId,
    jobId,
    matchScore: 80,
    rationale: "fake rationale",
    strengths: [],
    gaps: [],
  });

  await db.insert(userJobStatuses).values({
    id: randomUUID(),
    jobId,
    status: "saved",
    resumeId,
  });

  await db.insert(handoffs).values({
    id: randomUUID(),
    jobId,
    resumeId,
    resumeText,
    jobDescription: "a job description",
    jobTitle: "Test Job",
    company: "Test Co",
    expiresAt: new Date(Date.now() + 60_000),
  });

  await db.insert(jobMatchFailures).values({
    id: randomUUID(),
    searchId,
    resumeId,
    jobId,
    kind: "rate-limited",
    errorMessage: "fake failure",
    attempts: 3,
  });

  return resumeId;
}

describe("parseArgs", () => {
  it("defaults to a dry run with no arguments", () => {
    expect(parseArgs([])).toEqual({ live: false });
  });

  it("--live opts into an actual run", () => {
    expect(parseArgs(["--live"])).toEqual({ live: true });
  });

  it("hard-errors on an unrecognized flag rather than silently ignoring it", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unrecognized argument/);
  });
});

describe("findTaggedResumeIds / countDependents / deleteTaggedResumes", () => {
  it("finds only resumes whose text starts with the tag, ignoring untagged ones", async () => {
    const taggedId = await seedResumeWithFullDependents(true);
    const untaggedId = await seedResumeWithFullDependents(false);

    const tagged = await findTaggedResumeIds(db);
    const taggedIds = tagged.map((r) => r.id);
    expect(taggedIds).toContain(taggedId);
    expect(taggedIds).not.toContain(untaggedId);
  });

  it("counts real dependent rows across every table for a tagged resume", async () => {
    const taggedId = await seedResumeWithFullDependents(true);

    const counts = await countDependents(db, [taggedId]);
    expect(counts).toEqual({
      job_match_failures: 1,
      user_job_statuses: 1,
      handoffs: 1,
      job_matches: 1,
      search_sources: 1,
      search_results: 1,
      searches: 1,
    });
  });

  it("returns all-zero counts for an empty id list, without querying", async () => {
    const counts = await countDependents(db, []);
    expect(counts).toEqual({
      job_match_failures: 0,
      user_job_statuses: 0,
      handoffs: 0,
      job_matches: 0,
      search_sources: 0,
      search_results: 0,
      searches: 0,
    });
  });

  // The property this whole script exists to prove: deleting the tagged
  // resume also removes EVERY row that references it (no leftover FK
  // orphans), while an untagged resume and its own dependents are left
  // completely untouched.
  it("deletes a tagged resume and all its dependents, and leaves an untagged resume's own data untouched", async () => {
    const taggedId = await seedResumeWithFullDependents(true);
    const untaggedId = await seedResumeWithFullDependents(false);

    await deleteTaggedResumes(db, [taggedId]);

    // The tagged resume and every table that referenced it are gone.
    expect(await db.select().from(resumes).where(eq(resumes.id, taggedId))).toHaveLength(0);
    expect(
      await db.select().from(jobMatches).where(eq(jobMatches.resumeId, taggedId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(userJobStatuses).where(eq(userJobStatuses.resumeId, taggedId)),
    ).toHaveLength(0);
    expect(await db.select().from(handoffs).where(eq(handoffs.resumeId, taggedId))).toHaveLength(0);
    expect(
      await db.select().from(jobMatchFailures).where(eq(jobMatchFailures.resumeId, taggedId)),
    ).toHaveLength(0);
    expect(await db.select().from(searches).where(eq(searches.resumeId, taggedId))).toHaveLength(0);

    // The untagged resume and every one of ITS rows survived, completely
    // unaffected by the tagged resume's deletion.
    expect(await db.select().from(resumes).where(eq(resumes.id, untaggedId))).toHaveLength(1);
    expect(
      await db.select().from(jobMatches).where(eq(jobMatches.resumeId, untaggedId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(userJobStatuses).where(eq(userJobStatuses.resumeId, untaggedId)),
    ).toHaveLength(1);
    expect(await db.select().from(handoffs).where(eq(handoffs.resumeId, untaggedId))).toHaveLength(
      1,
    );
    expect(
      await db.select().from(jobMatchFailures).where(eq(jobMatchFailures.resumeId, untaggedId)),
    ).toHaveLength(1);
    expect(await db.select().from(searches).where(eq(searches.resumeId, untaggedId))).toHaveLength(
      1,
    );
  });

  it("is a no-op for an empty id list -- never deletes anything unscoped", async () => {
    const untaggedId = await seedResumeWithFullDependents(false);

    await deleteTaggedResumes(db, []);

    expect(await db.select().from(resumes).where(eq(resumes.id, untaggedId))).toHaveLength(1);
  });
});
