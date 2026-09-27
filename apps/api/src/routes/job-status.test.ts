import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp as buildApp, injectAs } from "../test-support/build-test-app.js";
import { jobs as jobsTable, sourceDescriptors, userJobStatuses } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see db/test-db.ts. This
// file used to connect straight to the shared dev Postgres.
let testDb: TestDatabase;
let db: NodePgDatabase;

// A real, canonical dataSource id (see db/seed.ts's SOURCE_DESCRIPTORS),
// matching the convention resumes.test.ts and searches.test.ts already use.
const DATA_SOURCE = "usajobs" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("job_status_test");
  db = testDb.db;
  await db
    .insert(sourceDescriptors)
    .values([{ id: DATA_SOURCE, displayName: "USAJOBS" }])
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  await testDb?.teardown();
});

function buildTestApp() {
  return buildApp({
    db,
    inferTitles: async () => [],
    getScoreJob: () => {
      throw new Error("not used by these tests");
    },
  });
}

async function seedJob(): Promise<string> {
  const jobId = randomUUID();
  await db.insert(jobsTable).values({
    id: jobId,
    externalId: `job-status-test-${jobId}`,
    dataSource: DATA_SOURCE,
    title: "A job",
    description: "a job description",
    company: "Test Co",
    linkToApply: `https://example.com/${jobId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return jobId;
}

describe("POST /jobs/:id/status", () => {
  it("creates a status row for a job with no prior status", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ jobId, status: "saved" });

    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("saved");
    expect(rows[0]?.appliedAt).toBeNull();
  });

  it("upserts in place: setting a second status on the same job updates the one row, not a second", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "dismissed" },
    });
    expect(second.statusCode).toBe(200);

    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("dismissed");
  });

  it("sets appliedAt when status is 'applied', and preserves it across a later non-applied write", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    const applied = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied" },
    });
    expect(applied.statusCode).toBe(200);
    const afterApplied = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, jobId));
    const appliedAt = afterApplied[0]?.appliedAt;
    expect(appliedAt).not.toBeNull();

    // Ticket 484889d decision: dismissing an already-applied job (or any
    // other later non-"applied" write) must not erase the real
    // applied-at timestamp — see job-status.ts's COALESCE comment.
    const dismissed = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "dismissed" },
    });
    expect(dismissed.statusCode).toBe(200);
    const afterDismissed = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, jobId));
    expect(afterDismissed[0]?.status).toBe("dismissed");
    expect(afterDismissed[0]?.appliedAt?.getTime()).toBe(appliedAt?.getTime());
  });

  it("records resumeId when given", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Job-status resume ${randomUUID()}` },
    });
    const resumeId = (created.json() as { id: string }).id;

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "resume_optimized", resumeId },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobId));
    expect(rows[0]?.resumeId).toBe(resumeId);
  });

  it("review round F3: a later non-'applied' status write does not clobber the resumeId an actual application recorded", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    const tailored = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Tailored resume ${randomUUID()}` },
    });
    const tailoredResumeId = (tailored.json() as { id: string }).id;

    const generic = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Generic resume ${randomUUID()}` },
    });
    const genericResumeId = (generic.json() as { id: string }).id;

    // Apply to the job with the tailored resume -- this is the write that
    // is supposed to be permanent (schema.ts's own doc comment on
    // resumeId names exactly this scenario).
    const applied = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied", resumeId: tailoredResumeId },
    });
    expect(applied.statusCode).toBe(200);
    const afterApplied = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, jobId));
    expect(afterApplied[0]?.resumeId).toBe(tailoredResumeId);
    const appliedAt = afterApplied[0]?.appliedAt;

    // Later: a DIFFERENT resume is loaded, and a non-"applied" status is
    // written for the SAME job (e.g. re-saving it). Before this fix, this
    // unconditionally overwrote resumeId to genericResumeId, falsely
    // asserting the application used the generic resume.
    const savedAgain = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved", resumeId: genericResumeId },
    });
    expect(savedAgain.statusCode).toBe(200);

    const afterSaved = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, jobId));
    expect(afterSaved[0]?.status).toBe("saved");
    // resumeId still points at the resume the application actually used...
    expect(afterSaved[0]?.resumeId).toBe(tailoredResumeId);
    // ...and the real applied-at timestamp is still untouched too.
    expect(afterSaved[0]?.appliedAt?.getTime()).toBe(appliedAt?.getTime());
  });

  it("404s for an unknown job id", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/jobs/does-not-exist/status",
      payload: { status: "saved" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an unknown resumeId rather than silently recording a dangling reference", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved", resumeId: "does-not-exist" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unrecognized status value with 400, not 500", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "interviewing" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a missing status field with 400, not 500", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const response = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

// Dogfooding feedback, 2026-09-08 -- Nicole: "you should be able to
// untoggle the buttons, like undismiss." Removes the row entirely rather
// than writing a fourth "none" enum value -- see this file's own header
// comment for why a missing row already means "no action taken"
// everywhere else in this codebase.
describe("DELETE /jobs/:id/status", () => {
  it("removes an existing status row, reverting the job to no-action-taken", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved" },
    });

    const response = await app.inject({ method: "DELETE", url: `/jobs/${jobId}/status` });
    expect(response.statusCode).toBe(204);

    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobId));
    expect(rows).toHaveLength(0);
  });

  it("is idempotent: clearing a job with no status row at all is not an error", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    const response = await app.inject({ method: "DELETE", url: `/jobs/${jobId}/status` });
    expect(response.statusCode).toBe(204);
  });

  it("404s for an unknown job id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "DELETE", url: "/jobs/does-not-exist/status" });
    expect(response.statusCode).toBe(404);
  });

  it("clearing one job's status does not affect a different job's status row", async () => {
    const app = buildTestApp();
    const jobA = await seedJob();
    const jobB = await seedJob();
    await app.inject({ method: "POST", url: `/jobs/${jobA}/status`, payload: { status: "saved" } });
    await app.inject({
      method: "POST",
      url: `/jobs/${jobB}/status`,
      payload: { status: "dismissed" },
    });

    await app.inject({ method: "DELETE", url: `/jobs/${jobA}/status` });

    const bRows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobB));
    expect(bRows).toHaveLength(1);
    expect(bRows[0]?.status).toBe("dismissed");
  });
});

/**
 * Ticket 3fc1e5e: `user_job_statuses` was keyed `unique(job_id)` -- ONE row
 * per job for the entire database -- so these routes were the sharpest
 * cross-user WRITE gap in the app: two users could not hold a status on the
 * same posting at all, and the second writer destroyed the first's row. The
 * table is now keyed `unique(user_id, job_id)` (migration 0017) and both
 * routes scope to `request.userId`.
 *
 * Every test below asserts against the DATABASE, not just the status code:
 * the pre-fix behavior returned a perfectly happy 200/204 while silently
 * overwriting or deleting the other user's authored fact -- which schema.ts
 * names as the one kind of data in this app that nothing can reconstruct.
 */
describe("cross-user isolation for job statuses (ticket 3fc1e5e)", () => {
  const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function rowFor(userId: string, jobId: string) {
    return db
      .select()
      .from(userJobStatuses)
      .where(and(eq(userJobStatuses.userId, userId), eq(userJobStatuses.jobId, jobId)));
  }

  it("two users can hold DIFFERENT statuses on the same job, in two separate rows", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "dismissed" },
    });
    const bWrite = await injectAs(app, USER_B, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied" },
    });
    expect(bWrite.statusCode).toBe(200);

    // TWO rows, not one. Pre-fix this was impossible: the unique(job_id)
    // constraint meant B's upsert conflicted with A's row and updated it.
    const allRows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.jobId, jobId));
    expect(allRows).toHaveLength(2);

    const aRow = await rowFor(USER_A, jobId);
    const bRow = await rowFor(USER_B, jobId);
    expect(aRow[0]?.status).toBe("dismissed");
    expect(bRow[0]?.status).toBe("applied");
  });

  it("user B applying to a job does not erase user A's appliedAt for it", async () => {
    // The concrete destruction the old key caused: `appliedAt` is the one
    // question this table exists to answer, and B's write took over A's row
    // wholesale -- timestamp included.
    const app = buildTestApp();
    const jobId = await seedJob();

    await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied" },
    });
    const aBefore = await rowFor(USER_A, jobId);
    const aAppliedAt = aBefore[0]!.appliedAt;
    expect(aAppliedAt).not.toBeNull();

    await injectAs(app, USER_B, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved" },
    });

    const aAfter = await rowFor(USER_A, jobId);
    expect(aAfter[0]?.status).toBe("applied");
    expect(aAfter[0]?.appliedAt).toEqual(aAppliedAt);
  });

  it("DELETE /jobs/:id/status cannot clear another user's status row", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied" },
    });

    // B clears "their" status for this job. They have none, so this is a
    // no-op -- but it still reports 204, because the route is deliberately
    // idempotent. That idempotency is exactly why the pre-fix version was
    // dangerous: it deleted A's row and looked identical doing it.
    const bDelete = await injectAs(app, USER_B, {
      method: "DELETE",
      url: `/jobs/${jobId}/status`,
    });
    expect(bDelete.statusCode).toBe(204);

    const aRow = await rowFor(USER_A, jobId);
    expect(aRow).toHaveLength(1);
    expect(aRow[0]?.status).toBe("applied");
  });

  it("a user deleting their OWN status for a job leaves the other user's row intact", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "saved" },
    });
    await injectAs(app, USER_B, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "dismissed" },
    });

    await injectAs(app, USER_A, { method: "DELETE", url: `/jobs/${jobId}/status` });

    expect(await rowFor(USER_A, jobId)).toHaveLength(0);
    const bRow = await rowFor(USER_B, jobId);
    expect(bRow).toHaveLength(1);
    expect(bRow[0]?.status).toBe("dismissed");
  });

  it("404s when the body names a resumeId belonging to another user, and writes nothing", async () => {
    // A status row records which resume was in hand. Accepting a stranger's
    // resumeId would file a false record of the caller's own history,
    // pointing at a resume they cannot even read.
    const app = buildTestApp();
    const jobId = await seedJob();

    const created = await injectAs(app, USER_A, {
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `User A resume ${randomUUID()}` },
    });
    const resumeA = (created.json() as { id: string }).id;

    const attempt = await injectAs(app, USER_B, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "resume_optimized", resumeId: resumeA },
    });

    // 404, and indistinguishable from a resumeId that never existed.
    expect(attempt.statusCode).toBe(404);
    expect(await rowFor(USER_B, jobId)).toHaveLength(0);

    // Sanity: the owner CAN use their own resume id on the same job, which
    // proves the 404 above is the ownership check and not a broken route.
    const ok = await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "resume_optimized", resumeId: resumeA },
    });
    expect(ok.statusCode).toBe(200);
    expect((await rowFor(USER_A, jobId))[0]?.resumeId).toBe(resumeA);
  });

  it("a status write by one user is invisible to the other's read of the same job", async () => {
    // Guards the pairing with routes/resumes.ts's results join: a row
    // written here must only ever surface for its own author.
    const app = buildTestApp();
    const jobId = await seedJob();

    await injectAs(app, USER_A, {
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "dismissed" },
    });

    expect(await rowFor(USER_B, jobId)).toHaveLength(0);
  });
});
