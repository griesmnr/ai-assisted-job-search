import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { eq } from "drizzle-orm";
import { jobMatches, jobs, resumes, sourceDescriptors } from "./schema";

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

beforeAll(async () => {
  await client.connect();
  await db.insert(sourceDescriptors).values({
    id: "great-source-for-jobs",
    displayName: "Great Source OMG!",
  });
});

describe("job_matches table", () => {
  const RESUME_ID = "schema-test-resume";
  const JOB_ID = "schema-test-job";

  beforeAll(async () => {
    await db.insert(resumes).values({ id: RESUME_ID, resumeText: "some resume text" });
    await db.insert(jobs).values({
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
    });
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

afterAll(async () => {
  await db.delete(jobs).where(eq(jobs.id, "job1"));
  await db.delete(sourceDescriptors).where(eq(sourceDescriptors.id, "great-source-for-jobs"));
  await client.end();
});
