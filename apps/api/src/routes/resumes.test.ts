import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  sourceDescriptors,
  userJobStatuses,
} from "../db/schema.js";

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

// A real, canonical dataSource id (see db/seed.ts's SOURCE_DESCRIPTORS) —
// NOT a made-up test-only id. Ticket 59fdc52 review round 2 added
// server-side validation that ?source= on GET /resumes/:id/results must be
// one of the six real ids (a 400 on anything else, so a typo doesn't
// silently read as "zero results"), so this test's fixture data has to use
// a real one too, exactly like searches.test.ts's DATA_SOURCE already does.
const DATA_SOURCE = "usajobs" as const;
// A second real id, used only to prove "queried a DIFFERENT real source
// with no matching jobs" is a valid, non-400 "empty" result — as opposed
// to an unrecognized source id, which is the case the 400 check exists for.
const OTHER_REAL_DATA_SOURCE = "greenhouse" as const;
const resumeIds: string[] = [];
const jobIds: string[] = [];

beforeAll(async () => {
  await client.connect();
  // Real, permanent setup data (identical to what runDemoMatch's own
  // seedSourceDescriptors produces) — deliberately NOT deleted in afterAll,
  // matching demo-match.test.ts's own convention for the same id.
  await db
    .insert(sourceDescriptors)
    .values([
      { id: DATA_SOURCE, displayName: "USAJOBS" },
      { id: OTHER_REAL_DATA_SOURCE, displayName: "Greenhouse" },
    ])
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  if (jobIds.length > 0) {
    // user_job_statuses.job_id references jobs.id with no ON DELETE
    // cascade (schema.ts) — deleted first, or the jobs delete below fails
    // its FK constraint for any test that set a status.
    await db.delete(userJobStatuses).where(inArray(userJobStatuses.jobId, jobIds));
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

  it("rejects a non-string resumeText (400) rather than silently coercing it to a string", async () => {
    // Ticket 59fdc52 review round 2: Fastify's AJV coerces types by
    // default, so `{"resumeText": 123}` used to pass the `{ type: "string"
    // }` schema as the STRING "123" — a resume literally containing the
    // three characters "123" got created and hashed, no 400 anywhere.
    // `ajv: { customOptions: { coerceTypes: false } }` (index.ts) is the
    // fix; this proves it end to end rather than just at the unit level.
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: 123 },
    });
    expect(response.statusCode).toBe(400);

    // And, just as importantly: no resume containing "123" got created.
    const rows = await db.select().from(resumes).where(eq(resumes.resumeText, "123"));
    expect(rows).toHaveLength(0);
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

    // A real, known source id with no matching rows for this resume is a
    // valid, honest "empty" result (200) — distinct from an unrecognized
    // source id, which the next test covers.
    const nonMatching = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=${OTHER_REAL_DATA_SOURCE}`,
    });
    expect(nonMatching.statusCode).toBe(200);
    expect((nonMatching.json() as { results: unknown[] }).results).toHaveLength(0);
  });

  it("400s on an unrecognized source id rather than silently returning empty", async () => {
    const app = buildTestApp();
    const resumeText = `Unknown-source resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=not-a-real-source`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown resume id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist/results" });
    expect(response.statusCode).toBe(404);
  });

  it("400s on an unrecognized status value", async () => {
    const app = buildTestApp();
    const resumeText = `Bad status resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;
    resumeIds.push(resumeId);

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?status=not-a-real-status`,
    });
    expect(response.statusCode).toBe(400);
  });

  it(
    "includes each job's status, excludes dismissed by default, and shows them again for " +
      "?status=dismissed (ticket 484889d, 0c319b2 now merged)",
    async () => {
      const app = buildTestApp();
      const resumeText = `Status-view resume ${randomUUID()}`;
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const resumeId = (created.json() as { id: string }).id;
      resumeIds.push(resumeId);

      const untouchedId = await seedScoredJob(resumeId, 80, "Untouched job");
      const savedId = await seedScoredJob(resumeId, 75, "Saved job");
      const dismissedId = await seedScoredJob(resumeId, 70, "Dismissed job");

      await db.insert(userJobStatuses).values([
        {
          id: randomUUID(),
          jobId: savedId,
          status: "saved",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
          jobId: dismissedId,
          status: "dismissed",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const byId = (results: Array<{ jobId: string; status: string | null }>) =>
        new Map(results.map((r) => [r.jobId, r.status]));

      const defaultView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results`,
      });
      expect(defaultView.statusCode).toBe(200);
      const defaultBody = defaultView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      const defaultStatuses = byId(defaultBody.results);
      expect(defaultStatuses.get(untouchedId)).toBeNull();
      expect(defaultStatuses.get(savedId)).toBe("saved");
      // Decision #2 (git-bug 484889d): a dismissed job leaves the visible
      // (default) list.
      expect(defaultStatuses.has(dismissedId)).toBe(false);

      const dismissedView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results?status=dismissed`,
      });
      const dismissedBody = dismissedView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      expect(byId(dismissedBody.results).get(dismissedId)).toBe("dismissed");
      expect(dismissedBody.results).toHaveLength(1);
    },
  );

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
