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
  searchResults as searchResultsTable,
  searches as searchesTable,
  searchSources as searchSourcesTable,
} from "../db/schema.js";
import type { ScoreJobFn, ScoredJob } from "../demo-match.js";
import type { JobSource, NormalizedJob, SourceSearchResult } from "../sources/types.js";

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

// "usajobs" is one of the real dataSource ids demo-match.ts's
// seedSourceDescriptors always seeds — reused here for the same reason
// demo-match.test.ts uses it: no throwaway source_descriptors row needed.
const DATA_SOURCE = "usajobs" as const;
const resumeIds: string[] = [];

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  // Clean up everything these tests created, keyed off the resumes: every
  // search/job/match this file produces is reachable from one of these
  // resume ids since each test uses its own fresh resume. Jobs are found
  // via search_results (NOT job_matches) because estimateOnly runs
  // deliberately ingest jobs without ever scoring them — a job_matches-only
  // cleanup would leave those orphaned.
  if (resumeIds.length > 0) {
    const searchRows = await db
      .select({ id: searchesTable.id })
      .from(searchesTable)
      .where(inArray(searchesTable.resumeId, resumeIds));
    const searchIds = searchRows.map((r) => r.id);

    let jobIds: string[] = [];
    if (searchIds.length > 0) {
      const linkRows = await db
        .select({ jobId: searchResultsTable.jobId })
        .from(searchResultsTable)
        .where(inArray(searchResultsTable.searchId, searchIds));
      jobIds = [...new Set(linkRows.map((r) => r.jobId))];
    }

    await db.delete(jobMatches).where(inArray(jobMatches.resumeId, resumeIds));
    if (searchIds.length > 0) {
      await db.delete(searchResultsTable).where(inArray(searchResultsTable.searchId, searchIds));
      await db.delete(searchSourcesTable).where(inArray(searchSourcesTable.searchId, searchIds));
    }
    if (jobIds.length > 0) await db.delete(jobsTable).where(inArray(jobsTable.id, jobIds));
    await db.delete(searchesTable).where(inArray(searchesTable.resumeId, resumeIds));
    await db.delete(resumes).where(inArray(resumes.id, resumeIds));
  }
  await client.end();
});

function fakeJob(externalId: string, title: string): NormalizedJob {
  return {
    externalId,
    dataSource: DATA_SOURCE,
    title,
    description: `Description for ${title}`,
    company: "Test Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: `https://example.com/${externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

class FakeSource implements JobSource {
  readonly dataSource = DATA_SOURCE;
  constructor(private readonly jobsToReturn: NormalizedJob[]) {}
  async search(): Promise<SourceSearchResult> {
    return { jobs: this.jobsToReturn, skipped: [], skipRate: 0 };
  }
}

/**
 * Stands in for `sources/registry.ts`'s real `buildSourceSelection` — never
 * calls a real `createXSourceFromEnv` or hits a real job-board API. "known"
 * maps every requested id the caller wants to actually resolve to a
 * FakeSource returning `jobsToReturn`; anything else lands in `skipped`,
 * matching the real function's shape for unrecognized/unconfigured ids.
 */
function fakeResolver(known: Set<string>, jobsToReturn: NormalizedJob[]) {
  return (sourceIds: string[]) => {
    const sources: JobSource[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of sourceIds) {
      if (known.has(id)) sources.push(new FakeSource(jobsToReturn));
      else skipped.push({ id, reason: "not available in this test's fake resolver" });
    }
    return { sources, skipped };
  };
}

function makeFakeScorer(): ScoreJobFn {
  return async (job: NormalizedJob): Promise<ScoredJob> => ({
    matchScore: 77,
    rationale: `fake rationale for ${job.title}`,
    strengths: ["fake strength"],
    gaps: ["fake gap"],
  });
}

async function createResume(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/resumes",
    payload: { resumeText: `Search test resume ${randomUUID()}` },
  });
  const id = (response.json() as { id: string }).id;
  resumeIds.push(id);
  return id;
}

describe("POST /searches/estimate", () => {
  it("reports a cost estimate and never calls scoreJob", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
        fakeJob(`estimate-${randomUUID()}`, "Estimate Job A"),
        fakeJob(`estimate-${randomUUID()}`, "Estimate Job B"),
      ]),
    });
    const resumeId = await createResume(app);

    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE] },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      searchId: string;
      candidatesNeedingScore: number;
      costEstimate: { jobCount: number };
    };
    expect(body.candidatesNeedingScore).toBe(2);
    expect(body.costEstimate.jobCount).toBe(2);

    // No job_matches rows should exist for this resume — nothing was
    // actually scored (the whole point of estimateOnly).
    const scored = await db.select().from(jobMatches).where(eq(jobMatches.resumeId, resumeId));
    expect(scored).toHaveLength(0);
  });

  it("404s for an unknown resumeId", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
    });
    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId: "does-not-exist", sourceIds: [DATA_SOURCE] },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s when none of the requested sourceIds resolve", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
      resolveSourceIds: fakeResolver(new Set(), []),
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: ["nonexistent-source"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s on a missing sourceIds field", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /searches + GET /searches/:id", () => {
  it("runs a search asynchronously with a fake scorer, and can be polled to completion", async () => {
    const jobTitle = `Poll Job ${randomUUID()}`;
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
        fakeJob(`run-${randomUUID()}`, jobTitle),
      ]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE] },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string; status: string };
    expect(typeof searchId).toBe("string");

    // The run is fired-and-forget from the handler's perspective, but with
    // a fake in-process scorer (no real network/Claude latency) it resolves
    // on a microtask/short-timer scale — poll briefly rather than assuming
    // it's already done the instant the 202 comes back.
    let status = "";
    let body: { status: string; newlyScored?: number } = { status: "" };
    for (let i = 0; i < 150; i++) {
      const poll = await app.inject({ method: "GET", url: `/searches/${searchId}` });
      body = poll.json() as typeof body;
      status = body.status;
      if (status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(status).toBe("complete");
    expect(body.newlyScored).toBe(1);

    // Results land in the database and are readable via the resume-scoped
    // results endpoint — decision #3, "results come from the database, not
    // a run's in-memory state".
    const results = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const resultsBody = results.json() as { results: Array<{ title: string; matchScore: number }> };
    expect(resultsBody.results).toEqual([
      expect.objectContaining({ title: jobTitle, matchScore: 77 }),
    ]);
  });

  it("404s GET /searches/:id for a truly unknown id", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const response = await app.inject({ method: "GET", url: "/searches/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });

  it("400s when none of the requested sourceIds resolve", async () => {
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set(), []),
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["nonexistent-source"] },
    });
    expect(response.statusCode).toBe(400);
  });
});
