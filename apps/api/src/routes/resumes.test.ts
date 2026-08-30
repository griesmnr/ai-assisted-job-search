import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import { jobMatches, jobs as jobsTable, resumes, sourceDescriptors } from "../db/schema.js";

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

const DATA_SOURCE = "resumes-route-test-source";
const resumeIds: string[] = [];
const jobIds: string[] = [];

beforeAll(async () => {
  await client.connect();
  await db
    .insert(sourceDescriptors)
    .values({ id: DATA_SOURCE, displayName: "Resumes Route Test Source" })
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  if (jobIds.length > 0) {
    await db.delete(jobMatches).where(inArray(jobMatches.jobId, jobIds));
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

describe("POST /resumes", () => {
  it("creates a resume from pasted text and returns its id", async () => {
    const app = buildTestApp();
    const resumeText = `Resume text ${randomUUID()}`;
    const response = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string };
    expect(typeof body.id).toBe("string");
    resumeIds.push(body.id);

    const rows = await db.select().from(resumes).where(eq(resumes.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeText).toBe(resumeText);
  });

  it("is content-addressed: posting identical text twice returns the same id", async () => {
    const app = buildTestApp();
    const resumeText = `Repeated resume text ${randomUUID()}`;

    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    const firstId = (first.json() as { id: string }).id;
    const secondId = (second.json() as { id: string }).id;
    resumeIds.push(firstId);
    expect(secondId).toBe(firstId);
  });

  it("rejects an empty resumeText with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a missing resumeText field with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/resumes", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a resumeText over the length ceiling with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: "x".repeat(200_001) },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /resumes/:id", () => {
  it("returns a previously created resume", async () => {
    const app = buildTestApp();
    const resumeText = `Fetch-me resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const id = (created.json() as { id: string }).id;
    resumeIds.push(id);

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id, resumeText });
  });

  it("404s for an unknown id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });
});

describe("GET /resumes/:id/results", () => {
  async function seedScoredJob(
    resumeId: string,
    matchScore: number,
    title: string,
  ): Promise<string> {
    const jobId = randomUUID();
    jobIds.push(jobId);
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `results-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title,
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
    });
    return jobId;
  }

  it("returns scored jobs best match first, and applies a minScore floor with a hidden count", async () => {
    const app = buildTestApp();
    const resumeText = `Results resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    await seedScoredJob(resumeId, 90, "High match");
    await seedScoredJob(resumeId, 60, "Mid match");
    await seedScoredJob(resumeId, 30, "Low match");

    const all = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as {
      results: Array<{ matchScore: number }>;
      hiddenBelowFloor?: number;
    };
    expect(allBody.results.map((r) => r.matchScore)).toEqual([90, 60, 30]);
    expect(allBody.hiddenBelowFloor).toBeUndefined();

    const floored = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?minScore=55`,
    });
    expect(floored.statusCode).toBe(200);
    const flooredBody = floored.json() as {
      results: Array<{ matchScore: number }>;
      hiddenBelowFloor: number;
    };
    expect(flooredBody.results.map((r) => r.matchScore)).toEqual([90, 60]);
    expect(flooredBody.hiddenBelowFloor).toBe(1);
  });

  it("filters by source", async () => {
    const app = buildTestApp();
    const resumeText = `Source-filter resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    await seedScoredJob(resumeId, 70, "Matches source");

    const matching = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=${DATA_SOURCE}`,
    });
    expect((matching.json() as { results: unknown[] }).results).toHaveLength(1);

    const nonMatching = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=some-other-source`,
    });
    expect((nonMatching.json() as { results: unknown[] }).results).toHaveLength(0);
  });

  it("404s for an unknown resume id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist/results" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a status filter with 400 rather than silently ignoring it (0c319b2 not merged)", async () => {
    const app = buildTestApp();
    const resumeText = `Status resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?status=saved`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-numeric minScore with 400, not 500", async () => {
    const app = buildTestApp();
    const resumeText = `Bad minScore resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?minScore=not-a-number`,
    });
    expect(response.statusCode).toBe(400);
  });
});
