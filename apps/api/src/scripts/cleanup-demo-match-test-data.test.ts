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
  runCleanup,
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

type SeededResume = { resumeId: string; jobId: string; userJobStatusId: string };

/** Seeds one resume (tagged or not) plus one row in EVERY table that has a
 * `resumeId`/`searchId`-reachable FK to `resumes` -- job_match_failures,
 * user_job_statuses, handoffs, job_matches (direct `resume_id`), and
 * search_sources + search_results (via a `searches` row this resume owns).
 * Returns the ids tests need to assert on exactly what survives, and how. */
async function seedResumeWithFullDependents(
  resumeText: string,
  nickname = "Seeded resume",
): Promise<SeededResume> {
  const resumeId = randomUUID();
  await db.insert(resumes).values({
    id: resumeId,
    resumeText,
    resumeHash: randomUUID(),
    resumeNickname: nickname,
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

  const userJobStatusId = randomUUID();
  await db.insert(userJobStatuses).values({
    id: userJobStatusId,
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

  return { resumeId, jobId, userJobStatusId };
}

function taggedText(): string {
  return `${RESUME_TEXT_PREFIX} seeded ${randomUUID()}`;
}

function untaggedText(): string {
  return `A real, untagged resume ${randomUUID()}`;
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
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());
    const { resumeId: untaggedId } = await seedResumeWithFullDependents(untaggedText());

    const tagged = await findTaggedResumeIds(db);
    const taggedIds = tagged.map((r) => r.id);
    expect(taggedIds).toContain(taggedId);
    expect(taggedIds).not.toContain(untaggedId);
  });

  // Opus review, ticket 12fd73d, required F3: the prefix anchor (`LIKE
  // '<prefix>%'`, not `'%<prefix>%'`) is the one thing standing between
  // this script and matching a real resume that merely MENTIONS the tag
  // string somewhere in its body -- plausible now that the tag is a known
  // incident this project has written about in its own commit history.
  // Nothing else in this file would notice if that anchor were ever
  // relaxed to a substring match.
  it("does NOT match a resume whose text merely CONTAINS the tag, only one that STARTS with it", async () => {
    const { resumeId: containsOnlyId } = await seedResumeWithFullDependents(
      `My real resume. (Unrelated aside: I once debugged an issue involving ${RESUME_TEXT_PREFIX} rows.)`,
    );
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());

    const tagged = await findTaggedResumeIds(db);
    const taggedIds = tagged.map((r) => r.id);
    expect(taggedIds).not.toContain(containsOnlyId);
    expect(taggedIds).toContain(taggedId);
  });

  it("counts real dependent rows across every table for a tagged resume", async () => {
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());

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
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());
    const { resumeId: untaggedId } = await seedResumeWithFullDependents(untaggedText());

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

  // Opus review, ticket 12fd73d, required F1: unlike every other dependent
  // table, user_job_statuses is preserved -- its resume_id is NULLed, not
  // the row deleted -- because schema.ts documents that column as "never
  // worth keying on" and nullable precisely for "a backfilled row may
  // record a real application whose resume version is no longer
  // identifiable." A real "applied" fact must survive this cleanup even
  // for a (however unlikely) tagged resume.
  it("preserves the user_job_statuses ROW for a tagged resume, nulling resume_id rather than deleting it", async () => {
    const { resumeId: taggedId, userJobStatusId } =
      await seedResumeWithFullDependents(taggedText());

    await deleteTaggedResumes(db, [taggedId]);

    const rows = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.id, userJobStatusId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeId).toBeNull();
    expect(rows[0]?.status).toBe("saved");
  });

  it("is a no-op for an empty id list -- never deletes anything unscoped", async () => {
    const { resumeId: untaggedId } = await seedResumeWithFullDependents(untaggedText());

    await deleteTaggedResumes(db, []);

    expect(await db.select().from(resumes).where(eq(resumes.id, untaggedId))).toHaveLength(1);
  });
});

// Opus review, ticket 12fd73d, required F3b: `live: false` is this script's
// entire safety guarantee, and before this it was only proven at the
// `parseArgs` level -- nothing actually asserted that a dry run performs
// zero writes against a real database. These tests exercise `runCleanup`
// (what `main()` actually calls) directly.
describe("runCleanup", () => {
  it("a dry run (live: false) finds and counts, but deletes nothing", async () => {
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());

    const result = await runCleanup(db, { live: false });

    expect(result.deleted).toBe(false);
    expect(result.tagged.map((r) => r.id)).toContain(taggedId);
    expect(await db.select().from(resumes).where(eq(resumes.id, taggedId))).toHaveLength(1);
    expect(
      await db.select().from(jobMatches).where(eq(jobMatches.resumeId, taggedId)),
    ).toHaveLength(1);
  });

  it("a live run (live: true) finds, counts, AND deletes", async () => {
    const { resumeId: taggedId } = await seedResumeWithFullDependents(taggedText());

    const result = await runCleanup(db, { live: true });

    expect(result.deleted).toBe(true);
    expect(result.tagged.map((r) => r.id)).toContain(taggedId);
    expect(await db.select().from(resumes).where(eq(resumes.id, taggedId))).toHaveLength(0);
  });

  it("reports the total resume count alongside the tagged count", async () => {
    await seedResumeWithFullDependents(untaggedText());
    const before = await runCleanup(db, { live: false });
    const totalBefore = before.totalResumeCount;

    await seedResumeWithFullDependents(taggedText());
    const after = await runCleanup(db, { live: false });

    expect(after.totalResumeCount).toBe(totalBefore + 1);
    expect(after.tagged.length).toBeGreaterThanOrEqual(1);
  });

  it("is a clean no-op when nothing is tagged", async () => {
    // A fresh isolated database with zero rows -- proves "nothing tagged"
    // reports deleted: false and an empty list rather than erroring.
    const fresh = await createTestDatabase("cleanup_demo_match_test_data_empty_test");
    try {
      const result = await runCleanup(fresh.db, { live: true });
      expect(result.tagged).toEqual([]);
      expect(result.deleted).toBe(false);
      expect(result.totalResumeCount).toBe(0);
    } finally {
      await fresh.teardown();
    }
  });
});
