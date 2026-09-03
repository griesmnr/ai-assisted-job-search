import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobMatches, jobs, resumes, sourceDescriptors } from "./schema";
import { createTestDatabase, type TestDatabase } from "./test-db";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see test-db.ts for why:
// this file used to connect straight to the shared dev Postgres, so two
// worktrees running it at the same moment could collide on the fixed ids
// below, and a branch with an unapplied migration could be broken by
// another branch's applied one.
let testDb: TestDatabase;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("schema_test");
  db = testDb.db;
  // onConflictDoNothing: a fixed id so a run that crashed after this
  // beforeAll but before the file's own teardown doesn't matter — the next
  // run gets a brand-new database anyway (see test-db.ts), but this also
  // means a real crash mid-file (after this insert, before afterAll) can't
  // wedge a RETRY of this same file against the SAME database (e.g. a
  // vitest --retry rerun reusing the process) on a PK violation here.
  await db
    .insert(sourceDescriptors)
    .values({
      id: "great-source-for-jobs",
      displayName: "Great Source OMG!",
    })
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  await testDb?.teardown();
});

describe("job_matches table", () => {
  const RESUME_ID = "schema-test-resume";
  const JOB_ID = "schema-test-job";

  beforeAll(async () => {
    // onConflictDoNothing on both: fixed ids so a run that crashed after
    // this beforeAll but before its own afterAll leaves these rows behind
    // — without this, every later run would fail on a PK violation here
    // instead of just reusing the leftover rows.
    await db
      .insert(resumes)
      .values({
        id: RESUME_ID,
        resumeText: "some resume text",
        resumeHash: "schema-test-resume-hash",
      })
      .onConflictDoNothing({ target: resumes.id });
    await db
      .insert(jobs)
      .values({
        id: JOB_ID,
        description: "here is the job description",
        externalId: "schema-test-external-id",
        dataSource: "great-source-for-jobs",
        title: "job title",
        company: "the best one",
        payType: "salary",
        commitment: "full-time",
        linkToApply: "www.awesome.com/job1",
        locationType: "hybrid",
        postedAt: new Date(),
      })
      .onConflictDoNothing({ target: jobs.id });
  });

  afterAll(async () => {
    await db.delete(jobMatches).where(eq(jobMatches.resumeId, RESUME_ID));
    await db.delete(jobs).where(eq(jobs.id, JOB_ID));
    await db.delete(resumes).where(eq(resumes.id, RESUME_ID));
  });

  it("rejects a duplicate (resume_id, job_id) — ticket 620ca30", async () => {
    await db.insert(jobMatches).values({
      id: "schema-test-match-1",
      resumeId: RESUME_ID,
      jobId: JOB_ID,
      matchScore: 80,
      rationale: "good match",
    });

    const error = await db
      .insert(jobMatches)
      .values({
        id: "schema-test-match-2",
        resumeId: RESUME_ID,
        jobId: JOB_ID,
        matchScore: 50,
        rationale: "a different, duplicate scoring attempt",
      })
      .catch((e) => e);

    expect(error.cause.code).toBe("23505");

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.resumeId, RESUME_ID));
    expect(rows).toHaveLength(1);
  });
});

describe("jobs table", () => {
  afterAll(async () => {
    await db.delete(jobs).where(eq(jobs.id, "job1"));
  });

  it("rejects a duplicate (data_source, external_id)", async () => {
    await db.insert(jobs).values({
      id: "job1",
      description: "here is the job description",
      externalId: "1234",
      dataSource: "great-source-for-jobs",
      title: "job title",
      company: "the best one",
      payType: "salary",
      commitment: "full-time",
      linkToApply: "www.awesome.com/job1",
      locationType: "hybrid",
      postedAt: new Date(),
    });

    const error = await db
      .insert(jobs)
      .values({
        id: "job2",
        description: "here is the job description",
        externalId: "1234",
        dataSource: "great-source-for-jobs",
        title: "job title",
        company: "the best one",
        payType: "salary",
        commitment: "full-time",
        linkToApply: "www.awesome.com/job1",
        locationType: "hybrid",
        postedAt: new Date(),
      })
      .catch((e) => e);

    expect(error.cause.code).toBe("23505");
  });
});
