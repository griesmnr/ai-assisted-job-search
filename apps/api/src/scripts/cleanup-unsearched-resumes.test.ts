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
import { createPooledTestDatabase, createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  countDependents,
  countTotalResumes,
  findCleanupCandidates,
  findResumeIdsWithLiveSearch,
  findResumesWithNoScoredJobs,
  parseArgs,
  runCleanup,
} from "./cleanup-unsearched-resumes.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

const DATA_SOURCE = "usajobs" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("cleanup_unsearched_resumes_test");
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
    externalId: `cleanup-unsearched-test-${id}`,
    dataSource: DATA_SOURCE,
    title: "Test Job",
    description: "a job description",
    company: "Test Co",
    linkToApply: `https://example.com/${id}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return id;
}

async function seedResume(nickname = "Seeded resume"): Promise<string> {
  const id = randomUUID();
  await db.insert(resumes).values({
    id,
    resumeText: `Resume text ${randomUUID()}`,
    resumeHash: randomUUID(),
    resumeNickname: nickname,
  });
  return id;
}

/** A resume that ran a real search that has FINISHED (searches/
 * search_sources/search_results all exist, `status: "complete"`,
 * `completedAt` set -- so it does NOT count as a live search, ticket
 * 25eac27's own F2 exclusion) but has NO job_matches -- either every job
 * scoring attempt failed (jobMatchFailures rows, if `withFailures`) or
 * nothing was ever scored at all. This is the case that distinguishes
 * this script's actual criterion ("zero job_matches") from the looser
 * "zero searches" reading of Nicole's own words -- both must count as
 * cleanup candidates. See `seedResumeWithLiveSearch` below for the
 * DIFFERENT case (a search still running) this must NOT be confused
 * with. */
async function seedSearchedButUnscoredResume(withFailures: boolean): Promise<{
  resumeId: string;
  jobId: string;
}> {
  const resumeId = await seedResume();
  const jobId = await seedJob();
  const searchId = randomUUID();
  await db.insert(searches).values({
    id: searchId,
    resumeId,
    searchedAt: new Date(),
    status: "complete",
    completedAt: new Date(),
  });
  await db.insert(searchSources).values({
    id: randomUUID(),
    searchId,
    sourceDescriptorId: DATA_SOURCE,
  });
  await db.insert(searchResults).values({ id: randomUUID(), searchId, jobId });
  if (withFailures) {
    await db.insert(jobMatchFailures).values({
      id: randomUUID(),
      searchId,
      resumeId,
      jobId,
      kind: "rate-limited",
      errorMessage: "fake failure",
      attempts: 3,
    });
  }
  return { resumeId, jobId };
}

/** A resume with at least one REAL job_matches row -- must never be
 * touched by this script, regardless of what else it carries. */
async function seedScoredResume(nickname = "Scored resume"): Promise<{
  resumeId: string;
  jobId: string;
  userJobStatusId: string;
}> {
  const resumeId = await seedResume(nickname);
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
  await db
    .insert(userJobStatuses)
    .values({ id: userJobStatusId, jobId, status: "saved", resumeId });
  await db.insert(handoffs).values({
    id: randomUUID(),
    jobId,
    resumeId,
    resumeText: "some text",
    jobDescription: "a job description",
    jobTitle: "Test Job",
    company: "Test Co",
    expiresAt: new Date(Date.now() + 60_000),
  });
  return { resumeId, jobId, userJobStatusId };
}

/** A resume with a search that is genuinely LIVE right now -- `status:
 * "running"`, no `completedAt`, `searchedAt` recent -- and, deliberately,
 * zero `job_matches` (scoring hasn't landed one yet). Opus review, ticket
 * 25eac27, required F2: this must be EXCLUDED from cleanup even though it
 * matches the raw "zero job_matches" criterion, because it is not junk --
 * it's a search Nicole is actively running. `stalledMs`, when given, backs
 * `searchedAt` off far enough to simulate a STALLED (not live) search
 * instead. */
async function seedResumeWithLiveSearch(stalledMs?: number): Promise<{
  resumeId: string;
  searchId: string;
}> {
  const resumeId = await seedResume();
  const searchId = randomUUID();
  const searchedAt = stalledMs === undefined ? new Date() : new Date(Date.now() - stalledMs);
  await db.insert(searches).values({
    id: searchId,
    resumeId,
    searchedAt,
    status: "running",
  });
  await db.insert(searchSources).values({
    id: randomUUID(),
    searchId,
    sourceDescriptorId: DATA_SOURCE,
  });
  return { resumeId, searchId };
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

describe("findResumesWithNoScoredJobs", () => {
  it("finds a resume with no searches at all", async () => {
    const resumeId = await seedResume();
    const found = await findResumesWithNoScoredJobs(db);
    expect(found.map((r) => r.id)).toContain(resumeId);
  });

  it("finds a resume that searched but scored nothing", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(false);
    const found = await findResumesWithNoScoredJobs(db);
    expect(found.map((r) => r.id)).toContain(resumeId);
  });

  it("finds a resume whose every scoring attempt FAILED (job_match_failures, no job_matches)", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(true);
    const found = await findResumesWithNoScoredJobs(db);
    expect(found.map((r) => r.id)).toContain(resumeId);
  });

  it("does NOT find a resume with at least one real job_matches row", async () => {
    const { resumeId } = await seedScoredResume();
    const found = await findResumesWithNoScoredJobs(db);
    expect(found.map((r) => r.id)).not.toContain(resumeId);
  });

  it("never returns duplicate rows for a resume with MULTIPLE scored jobs", async () => {
    const resumeId = await seedResume();
    for (let i = 0; i < 3; i++) {
      const jobId = await seedJob();
      await db.insert(jobMatches).values({
        id: randomUUID(),
        resumeId,
        jobId,
        matchScore: 80,
        rationale: "fake rationale",
        strengths: [],
        gaps: [],
      });
    }
    const found = await findResumesWithNoScoredJobs(db);
    expect(found.map((r) => r.id)).not.toContain(resumeId);
    // And the unrelated LEFT JOIN never emitted this resume even once.
    expect(found.filter((r) => r.id === resumeId)).toHaveLength(0);
  });
});

describe("countTotalResumes", () => {
  it("increments by exactly 1 when a resume is added", async () => {
    const before = await countTotalResumes(db);
    await seedResume();
    const after = await countTotalResumes(db);
    expect(after).toBe(before + 1);
  });
});

describe("countDependents", () => {
  it("counts real dependent rows across every table for an unscored-but-searched resume", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(true);
    const counts = await countDependents(db, [resumeId]);
    expect(counts).toEqual({
      job_match_failures: 1,
      user_job_statuses: 0,
      handoffs: 0,
      job_matches: 0,
      search_sources: 1,
      search_results: 1,
      searches: 1,
    });
  });

  it("returns all-zero counts for an empty id list", async () => {
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
});

describe("runCleanup", () => {
  it("a dry run (live: false) finds and counts, but deletes nothing", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(true);

    const result = await runCleanup(db, { live: false });

    expect(result.deleted).toBe(false);
    expect(result.candidates.map((r) => r.id)).toContain(resumeId);
    expect(await db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(1);
    expect(
      await db.select().from(jobMatchFailures).where(eq(jobMatchFailures.resumeId, resumeId)),
    ).toHaveLength(1);
  });

  it("a live run deletes an unsearched resume and all its dependents", async () => {
    const resumeId = await seedResume();

    const result = await runCleanup(db, { live: true });

    expect(result.deleted).toBe(true);
    expect(result.candidates.map((r) => r.id)).toContain(resumeId);
    expect(await db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(0);
  });

  it("a live run deletes a searched-but-unscored resume (job_match_failures, no job_matches) and its dependents", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(true);

    await runCleanup(db, { live: true });

    expect(await db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(0);
    expect(
      await db.select().from(jobMatchFailures).where(eq(jobMatchFailures.resumeId, resumeId)),
    ).toHaveLength(0);
    expect(await db.select().from(searches).where(eq(searches.resumeId, resumeId))).toHaveLength(0);
  });

  // The property this whole script exists to guarantee: a resume with real
  // scored jobs is NEVER touched, no matter what else this run deletes.
  it("never touches a scored resume, even while deleting unscored ones in the same run", async () => {
    const { resumeId: scoredId, userJobStatusId } = await seedScoredResume();
    const unscoredId = await seedResume();

    const result = await runCleanup(db, { live: true });

    expect(result.candidates.map((r) => r.id)).not.toContain(scoredId);
    expect(result.candidates.map((r) => r.id)).toContain(unscoredId);

    expect(await db.select().from(resumes).where(eq(resumes.id, scoredId))).toHaveLength(1);
    expect(
      await db.select().from(jobMatches).where(eq(jobMatches.resumeId, scoredId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(userJobStatuses).where(eq(userJobStatuses.id, userJobStatusId)),
    ).toHaveLength(1);
    expect(
      (await db.select().from(userJobStatuses).where(eq(userJobStatuses.id, userJobStatusId)))[0]
        ?.resumeId,
    ).toBe(scoredId);

    expect(await db.select().from(resumes).where(eq(resumes.id, unscoredId))).toHaveLength(0);
  });

  it("preserves (NULLs, does not delete) a user_job_statuses row for a deleted resume", async () => {
    // A user_job_statuses row can only reasonably exist for a resume that
    // WAS scored at some point (see ResultCard.tsx -- status buttons only
    // render on scored results), so this seeds one directly against an
    // otherwise-unscored resume to exercise the defensive NULL-not-delete
    // path even in a scenario this app's own UI wouldn't normally produce.
    const resumeId = await seedResume();
    const jobId = await seedJob();
    const userJobStatusId = randomUUID();
    await db
      .insert(userJobStatuses)
      .values({ id: userJobStatusId, jobId, status: "saved", resumeId });

    await runCleanup(db, { live: true });

    const rows = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.id, userJobStatusId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeId).toBeNull();
    expect(rows[0]?.status).toBe("saved");
  });

  it("is a clean no-op when nothing qualifies", async () => {
    const fresh = await createTestDatabase("cleanup_unsearched_resumes_empty_test");
    try {
      const result = await runCleanup(fresh.db, { live: true });
      expect(result.candidates).toEqual([]);
      expect(result.deleted).toBe(false);
    } finally {
      await fresh.teardown();
    }
  });

  it("reports the real total resume count alongside the candidate count", async () => {
    await seedScoredResume();
    const before = await runCleanup(db, { live: false });
    const totalBefore = before.totalResumeCount;

    await seedResume();
    const after = await runCleanup(db, { live: false });

    expect(after.totalResumeCount).toBe(totalBefore + 1);
  });
});

// Opus review, ticket 25eac27, required F2: a resume with a search
// genuinely live right now must not read as junk just because scoring
// hasn't landed a job_matches row for it yet.
describe("live-search exclusion (ticket 25eac27, opus review F2)", () => {
  it("findResumeIdsWithLiveSearch finds a resume with a running, uncompleted, recent search", async () => {
    const { resumeId } = await seedResumeWithLiveSearch();
    const found = await findResumeIdsWithLiveSearch(db, [resumeId]);
    expect(found.has(resumeId)).toBe(true);
  });

  it("findResumeIdsWithLiveSearch does NOT find a STALLED search (past the stall window)", async () => {
    const { resumeId } = await seedResumeWithLiveSearch(60 * 60 * 1000); // 1h old
    const found = await findResumeIdsWithLiveSearch(db, [resumeId]);
    expect(found.has(resumeId)).toBe(false);
  });

  it("findResumeIdsWithLiveSearch does NOT find a COMPLETED search", async () => {
    const { resumeId } = await seedSearchedButUnscoredResume(false);
    const found = await findResumeIdsWithLiveSearch(db, [resumeId]);
    expect(found.has(resumeId)).toBe(false);
  });

  it("findCleanupCandidates excludes a resume with a live search, even though it has zero job_matches", async () => {
    const { resumeId } = await seedResumeWithLiveSearch();
    const candidates = await findCleanupCandidates(db);
    expect(candidates.map((r) => r.id)).not.toContain(resumeId);
  });

  it("findCleanupCandidates INCLUDES a resume whose search has STALLED (not live, just stuck)", async () => {
    const { resumeId } = await seedResumeWithLiveSearch(60 * 60 * 1000);
    const candidates = await findCleanupCandidates(db);
    expect(candidates.map((r) => r.id)).toContain(resumeId);
  });

  it("a live run does NOT delete a resume with a currently live search", async () => {
    const { resumeId, searchId } = await seedResumeWithLiveSearch();

    const result = await runCleanup(db, { live: true });

    expect(result.candidates.map((r) => r.id)).not.toContain(resumeId);
    expect(await db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(1);
    expect(await db.select().from(searches).where(eq(searches.id, searchId))).toHaveLength(1);
  });
});

// Opus review, ticket 25eac27, required F1 (and F4, round 2): the FIRST
// version of this script deleted job_matches as its own dependent-delete
// step, proven against a real concurrent connection to convert a race
// into silent data loss (see the module doc comment's full incident
// writeup). The FIRST version of these tests hand-rolled a copy of the
// lock sequence instead of calling the real `runCleanup` -- proven
// vacuous: deleting `.for("update")` from the real live path left every
// test in this file green, since none of them actually exercised it.
// These now drive `runCleanup` itself, against a REAL second connection
// (a single `pg.Client` cannot hold two transactions at once, so a
// broken lock and a correct one would be indistinguishable on it -- same
// reasoning `searches.test.ts`'s own advisory-lock concurrency tests
// already documented for `createPooledTestDatabase`).
describe("concurrency: a job scored mid-run must not be lost (ticket 25eac27, opus review F1/F4)", () => {
  it("runCleanup itself blocks on an uncommitted concurrent job_matches insert, then correctly spares the resume once it commits", async () => {
    const resumeId = await seedResume();
    const jobId = await seedJob();

    const pooled = createPooledTestDatabase(testDb.testDbName, 4);
    try {
      // A second, independent connection holding an UNCOMMITTED insert --
      // this is the "concurrent search scoring a job" the module doc
      // comment describes, caught in the act, not yet durable.
      let releaseConcurrentTx: () => void = () => {};
      const concurrentTxGate = new Promise<void>((resolve) => {
        releaseConcurrentTx = resolve;
      });
      let concurrentTxSettled = false;
      const concurrentTx = pooled.db
        .transaction(async (tx) => {
          await tx.insert(jobMatches).values({
            id: randomUUID(),
            resumeId,
            jobId,
            matchScore: 80,
            rationale: "landed mid-cleanup, held open until released",
            strengths: [],
            gaps: [],
          });
          // Holds this transaction (and its FOR KEY SHARE lock on the
          // resume, taken by the insert above) open until released.
          await concurrentTxGate;
        })
        .then(() => {
          concurrentTxSettled = true;
        });
      // Give the insert above a real chance to actually land before
      // racing runCleanup's own first pass against it.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The REAL function under test, against the SAME pooled db. Its
      // first pass reads zero job_matches (the insert above is still
      // uncommitted and therefore invisible to it under READ COMMITTED),
      // so it proceeds to lock the resume -- which must now block on the
      // concurrent transaction's own uncommitted FOR KEY SHARE.
      let cleanupSettled = false;
      const cleanupRun = runCleanup(pooled.db, { live: true }).then((result) => {
        cleanupSettled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(cleanupSettled).toBe(false); // still blocked on the lock

      releaseConcurrentTx();
      await concurrentTx;
      expect(concurrentTxSettled).toBe(true);

      const result = await cleanupRun;
      expect(cleanupSettled).toBe(true);

      // runCleanup's own re-check, now under its granted lock, saw the
      // just-committed match and correctly excluded the resume.
      expect(result.candidates.map((r) => r.id)).not.toContain(resumeId);
      expect(await pooled.db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(
        1,
      );
      expect(
        await pooled.db.select().from(jobMatches).where(eq(jobMatches.resumeId, resumeId)),
      ).toHaveLength(1);
    } finally {
      await pooled.close();
    }
  });

  // Opus review round 2, required F3: the live-search exclusion was
  // racy in exactly the same class of bug as F1 -- a POST /searches
  // insert of its `searches` row (uncommitted) left a resume looking
  // like plain junk to runCleanup's own unlocked first pass, and its
  // FOR UPDATE lock then proceeded on that stale read the instant the
  // poster committed, unless the live-search check is ALSO re-run
  // under the lock (not just job_matches).
  it("runCleanup blocks on an uncommitted concurrent searches insert too, then correctly spares the resume once it commits", async () => {
    const resumeId = await seedResume();

    const pooled = createPooledTestDatabase(testDb.testDbName, 4);
    try {
      let releaseConcurrentTx: () => void = () => {};
      const concurrentTxGate = new Promise<void>((resolve) => {
        releaseConcurrentTx = resolve;
      });
      let concurrentTxSettled = false;
      const concurrentTx = pooled.db
        .transaction(async (tx) => {
          // Simulates POST /searches inserting its searches row --
          // uncommitted, but already holding the FOR KEY SHARE lock on
          // the resume that makes the race possible.
          await tx
            .insert(searches)
            .values({ id: randomUUID(), resumeId, searchedAt: new Date(), status: "running" });
          await concurrentTxGate;
        })
        .then(() => {
          concurrentTxSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));

      let cleanupSettled = false;
      const cleanupRun = runCleanup(pooled.db, { live: true }).then((result) => {
        cleanupSettled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(cleanupSettled).toBe(false);

      releaseConcurrentTx();
      await concurrentTx;
      expect(concurrentTxSettled).toBe(true);

      const result = await cleanupRun;
      expect(cleanupSettled).toBe(true);

      expect(result.candidates.map((r) => r.id)).not.toContain(resumeId);
      expect(await pooled.db.select().from(resumes).where(eq(resumes.id, resumeId))).toHaveLength(
        1,
      );
      expect(
        await pooled.db.select().from(searches).where(eq(searches.resumeId, resumeId)),
      ).toHaveLength(1);
    } finally {
      await pooled.close();
    }
  });
});
