import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import { jobs as jobsTable, resumes, sourceDescriptors, userJobStatuses } from "../db/schema.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});
const db = drizzle(client);

// A real, canonical dataSource id (see db/seed.ts's SOURCE_DESCRIPTORS),
// matching the convention resumes.test.ts and searches.test.ts already use.
const DATA_SOURCE = "usajobs" as const;
const jobIds: string[] = [];
const resumeIds: string[] = [];

beforeAll(async () => {
  await client.connect();
  await db
    .insert(sourceDescriptors)
    .values([{ id: DATA_SOURCE, displayName: "USAJOBS" }])
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  if (jobIds.length > 0) {
    await db.delete(userJobStatuses).where(inArray(userJobStatuses.jobId, jobIds));
    await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
  }
  if (resumeIds.length > 0) {
    await db.delete(resumes).where(inArray(resumes.id, resumeIds));
  }
  await client.end();
});

function buildTestApp() {
  return buildApp({
    db,
    getScoreJob: () => {
      throw new Error("not used by these tests");
    },
  });
}

async function seedJob(): Promise<string> {
  const jobId = randomUUID();
  jobIds.push(jobId);
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
    resumeIds.push(resumeId);

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
    resumeIds.push(tailoredResumeId);

    const generic = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Generic resume ${randomUUID()}` },
    });
    const genericResumeId = (generic.json() as { id: string }).id;
    resumeIds.push(genericResumeId);

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
