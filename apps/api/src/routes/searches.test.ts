import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import { jobMatches, searches as searchesTable } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { DEFAULT_SCORE_THRESHOLD, type ScoreJobFn, type ScoredJob } from "../demo-match.js";
import { __testing } from "./searches.js";
import type { JobSource, NormalizedJob, SourceSearchResult } from "../sources/types.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see db/test-db.ts. This
// file used to connect straight to the shared dev Postgres.
let testDb: TestDatabase;
let db: NodePgDatabase;

// "usajobs" is one of the real dataSource ids demo-match.ts's
// seedSourceDescriptors always seeds — reused here for the same reason
// demo-match.test.ts uses it: no throwaway source_descriptors row needed.
const DATA_SOURCE = "usajobs" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("searches_test");
  db = testDb.db;
});

afterAll(async () => {
  // No manual row cleanup needed: everything this file created lives in
  // its own isolated database (created in beforeAll above), dropped whole
  // here.
  await testDb?.teardown();
});

function fakeJob(
  externalId: string,
  title: string,
  overrides: Partial<NormalizedJob> = {},
): NormalizedJob {
  return {
    externalId,
    dataSource: DATA_SOURCE,
    title,
    description: `Description for ${title}`,
    company: "Test Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote - US",
    linkToApply: `https://example.com/${externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** A title/location combination that survives BOTH the CLI default filter
 * and a generic "software engineer" custom filter — used by tests whose
 * point is mechanics (async polling, cost accounting), not filtering
 * itself. Company is derived from `externalId` (not a fixed "Test Co") so
 * a test seeding many of these doesn't accidentally collapse them all into
 * one survivor via the company|title dedupe every filter path applies. */
function matchingJob(externalId: string): NormalizedJob {
  return fakeJob(externalId, "Senior Software Engineer", {
    location: "Seattle, WA",
    company: `Test Co ${externalId}`,
  });
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
  return id;
}

async function pollUntilDone(
  app: ReturnType<typeof buildApp>,
  searchId: string,
): Promise<{ status: string; newlyScored?: number; failed?: number; cappedCount?: number }> {
  let body: { status: string; newlyScored?: number; failed?: number; cappedCount?: number } = {
    status: "",
  };
  for (let i = 0; i < 150; i++) {
    const poll = await app.inject({ method: "GET", url: `/searches/${searchId}` });
    body = poll.json() as typeof body;
    if (body.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return body;
}

describe("POST /searches/estimate", () => {
  it("reports a cost estimate, never calls scoreJob, and does not return a searchId", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
        matchingJob(`estimate-${randomUUID()}`),
        matchingJob(`estimate-${randomUUID()}`),
      ]),
    });
    const resumeId = await createResume(app);

    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      searchId?: string;
      candidatesNeedingScore: number;
      scoreThreshold: number;
      cappedCount: number;
      costEstimate: { jobCount: number };
    };
    expect(body.candidatesNeedingScore).toBe(2);
    expect(body.costEstimate.jobCount).toBe(2);
    expect(body.cappedCount).toBe(0);
    expect(body.scoreThreshold).toBe(DEFAULT_SCORE_THRESHOLD);
    // Ticket 59fdc52 review round 2: an estimate's searchId used to be
    // returned but never registered anywhere pollable, so GET /searches/:id
    // on it falsely reported a finished search. Simplest correct fix:
    // don't hand one out.
    expect(body.searchId).toBeUndefined();

    // No job_matches rows should exist for this resume — nothing was
    // actually scored (the whole point of estimateOnly).
    const scored = await db.select().from(jobMatches).where(eq(jobMatches.resumeId, resumeId));
    expect(scored).toHaveLength(0);
  });

  it("reports a CAP-AWARE cost estimate — priced at scoreThreshold, not the full pool", async () => {
    // Ticket 59fdc52 review round 2, F "estimate is wrong by ~30x": a real
    // POST /searches run never scores more than scoreThreshold jobs in one
    // go, so the estimate must price exactly that many, with the rest
    // reported via cappedCount — not the price of the whole pool.
    const poolSize = DEFAULT_SCORE_THRESHOLD + 7;
    const jobs = Array.from({ length: poolSize }, (_, i) =>
      matchingJob(`cap-${i}-${randomUUID()}`),
    );
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), jobs),
    });
    const resumeId = await createResume(app);

    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      candidatesNeedingScore: number;
      scoreThreshold: number;
      cappedCount: number;
      costEstimate: { jobCount: number };
    };
    expect(body.candidatesNeedingScore).toBe(poolSize);
    expect(body.scoreThreshold).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(body.cappedCount).toBe(7);
    // The priced count is the CAPPED subset, not the full pool of 207.
    expect(body.costEstimate.jobCount).toBe(DEFAULT_SCORE_THRESHOLD);
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

  it("400s on a duplicate sourceId, cleanly, rather than a mangled skippedSources entry", async () => {
    // Round 1's version of this bug: a duplicate sourceIds array produced
    // skippedSources[0].id === "usajobs,usajobs" (every id joined
    // together). Fixed at the schema level (uniqueItems) — this asserts
    // the clean outcome, not the old broken shape.
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE, DATA_SOURCE] },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /searches + GET /searches/:id — mechanics", () => {
  it("runs a search asynchronously and can be polled to completion", async () => {
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`run-${randomUUID()}`)]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string; status: string };
    expect(typeof searchId).toBe("string");

    const body = await pollUntilDone(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.newlyScored).toBe(1);

    // Results land in the database and are readable via the resume-scoped
    // results endpoint — decision #3, "results come from the database, not
    // a run's in-memory state".
    const results = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const resultsBody = results.json() as { results: Array<{ matchScore: number }> };
    expect(resultsBody.results).toHaveLength(1);
    expect(resultsBody.results[0]?.matchScore).toBe(77);
  });

  it("GET /searches/:id reports a genuinely rising scoredSoFar across multiple polls during an in-progress run, not just 0-then-final (ticket 1998875, F1)", async () => {
    // A gated, call-order-tracking scorer — NOT per-job gates keyed by
    // externalId, because runDemoMatch's own two-phase warm-then-batch
    // structure (demo-match.ts: score `firstId` alone via
    // `Promise.allSettled([scoreOne(firstId)])`, THEN fire
    // `restIds.map(scoreOne)` as one concurrent batch) means the test
    // cannot predict up front WHICH job becomes "first". Keying the gate by
    // INVOCATION ORDER instead sidesteps that entirely: call #0 is always
    // whichever job the two-phase structure chose to warm the cache with,
    // and calls #1+ are always the batch — regardless of which specific
    // job that turns out to be.
    let releaseFirst: () => void = () => {};
    const gateFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseRest: () => void = () => {};
    const gateRest = new Promise<void>((resolve) => {
      releaseRest = resolve;
    });
    let calls = 0;
    const gatedScorer: ScoreJobFn = async (job) => {
      const gate = calls === 0 ? gateFirst : gateRest;
      calls++;
      await gate;
      return {
        matchScore: 60,
        rationale: `fake rationale for ${job.title}`,
        strengths: [],
        gaps: [],
      };
    };

    const jobs = [
      matchingJob(`rising-0-${randomUUID()}`),
      matchingJob(`rising-1-${randomUUID()}`),
      matchingJob(`rising-2-${randomUUID()}`),
    ];
    const app = buildApp({
      db,
      getScoreJob: () => gatedScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), jobs),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };

    // Poll #1: nothing released yet — must be pending at 0, proving the
    // count starts at 0 rather than skipping straight to a nonzero value.
    const pollAtStart = await app.inject({ method: "GET", url: `/searches/${searchId}` });
    const bodyAtStart = pollAtStart.json() as { status: string; scoredSoFar?: number };
    expect(bodyAtStart.status).toBe("pending");
    expect(bodyAtStart.scoredSoFar).toBe(0);

    // Release only the first (cache-warming) job. The batch (restIds) is
    // still gated, so the run must sit at exactly 1 scored, still pending,
    // until this test explicitly moves it forward again.
    releaseFirst();
    let bodyAtOne: { status: string; scoredSoFar?: number } = { status: "" };
    for (let i = 0; i < 150; i++) {
      const poll = await app.inject({ method: "GET", url: `/searches/${searchId}` });
      bodyAtOne = poll.json() as typeof bodyAtOne;
      if (bodyAtOne.scoredSoFar === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Poll #2: a GENUINE rise from the poll #1 reading (0 -> 1), observed
    // WHILE the run is still pending — this is the assertion that would
    // fail if scoredSoFar were only ever reported as 0-then-final (e.g. if
    // the counter were incremented from a loop AFTER the whole batch
    // settles, rather than per-job as each call resolves).
    expect(bodyAtOne.status).toBe("pending");
    expect(bodyAtOne.scoredSoFar).toBe(1);

    // Release the batch (the other two jobs) and let the run finish.
    releaseRest();
    const finalBody = await pollUntilDone(app, searchId);
    expect(finalBody.status).toBe("complete");
    expect(finalBody.newlyScored).toBe(jobs.length);
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

  it("400s on a duplicate sourceId", async () => {
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE, DATA_SOURCE] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a second concurrent POST /searches for the same resume with 409", async () => {
    // The in-flight guard (ticket 59fdc52 review round 2, F2's application-
    // level half). A controllable scorer — resolves only once `release()`
    // is called — guarantees the FIRST run is still pending when the
    // SECOND request arrives, rather than racing against real timing.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controllableScorer: ScoreJobFn = async (_job) => {
      await gate;
      return { matchScore: 50, rationale: "r", strengths: [], gaps: [] };
    };
    const app = buildApp({
      db,
      getScoreJob: () => controllableScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`gate-${randomUUID()}`)]),
    });
    const resumeId = await createResume(app);

    const first = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(first.statusCode).toBe(202);
    const { searchId: firstId } = first.json() as { searchId: string };

    const second = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { searchId: string }).searchId).toBe(firstId);

    release();
    await pollUntilDone(app, firstId);

    // Once the first run finishes, the resume is no longer in-flight — a
    // THIRD request should succeed normally.
    const third = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(third.statusCode).toBe(202);
    const { searchId: thirdId } = third.json() as { searchId: string };
    await pollUntilDone(app, thirdId);
  });

  it("400s a typo'd criteria field instead of silently stripping it (ticket 59fdc52 review round 3, F1)", async () => {
    // Live-verified defect: Fastify's AJV defaults include
    // `removeAdditional: true`; overriding only `coerceTypes` (round 2)
    // left it in effect, so `additionalProperties: false` on
    // searchCriteriaSchema silently DELETED an unrecognized key instead of
    // rejecting the request — "titleInclud" (missing the trailing "e")
    // silently became `criteria: {}`, this codebase's own "opt out of
    // filtering entirely" sentinel. `removeAdditional: false` (index.ts) is
    // the fix; this proves the typo now fails loudly instead of quietly
    // defeating the whole quality-filter default.
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`typo-${randomUUID()}`)]),
    });
    const resumeId = await createResume(app);

    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        // Deliberate typo: "titleInclud", not "titleInclude".
        criteria: { titleInclud: ["software engineer"] },
      },
    });
    expect(response.statusCode).toBe(400);

    // And the same typo on the free (never-spends-money) estimate route.
    const estimateResponse = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: { titleInclud: ["x"] } },
    });
    expect(estimateResponse.statusCode).toBe(400);
  });

  it("a synchronous throw from getScoreJob() never wedges the resume's in-flight guard (ticket 59fdc52 review round 3, F2)", async () => {
    // Live-verified defect: getScoreJob() used to be called INLINE while
    // building runDemoMatch's argument object, AFTER inFlightByResume.set
    // and searchRuns.set had already run. Production's factory
    // (`() => makeClaudeScorer(new Anthropic())`) throws synchronously
    // without ANTHROPIC_API_KEY — a real, supported "no billing configured
    // yet" state — which meant that throw left the guard permanently set
    // (every later POST /searches for that resume 409'd forever) and the
    // searchRuns entry stuck at "pending" forever (pruneSearchRuns
    // correctly never evicts a pending entry, so this was an unevictable
    // leak). getScoreJob() is now called BEFORE either map is touched, in
    // its own try/catch.
    let calls = 0;
    const app = buildApp({
      db,
      getScoreJob: () => {
        calls++;
        if (calls === 1) throw new Error("ANTHROPIC_API_KEY missing (simulated)");
        return makeFakeScorer();
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`f2-${randomUUID()}`)]),
    });
    const resumeId = await createResume(app);

    const first = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(first.statusCode).toBe(500);

    // The critical assertion: the resume must NOT be wedged as "in-flight"
    // by the failed attempt — a second POST /searches must be able to
    // proceed normally (202), not 409 forever.
    const second = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(second.statusCode).toBe(202);
    const { searchId } = second.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);
    expect(body.status).toBe("complete");
  });
});

describe("POST /searches — default vs explicit criteria selection (ticket 59fdc52 review round 2)", () => {
  it("scores ONLY jobs the default (CLI-equivalent) filter would have survived", async () => {
    // The exact defect class that shipped: an unfiltered search scored 200
    // Samsara sales/support postings alongside 5 real engineering roles.
    // This proves the default now excludes the non-engineering postings.
    const relevant = matchingJob(`relevant-${randomUUID()}`);
    const irrelevant = fakeJob(`irrelevant-${randomUUID()}`, "Account Executive, Commercial", {
      location: "Remote - US",
    });
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [relevant, irrelevant]),
    });
    const resumeId = await createResume(app);

    // No `criteria` field at all — the default path.
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE] },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);

    expect(body.status).toBe("complete");
    // Only the relevant job was scored — the sales job was ingested (the
    // corpus still grows — decision #3) but never sent to Claude.
    expect(body.newlyScored).toBe(1);

    const results = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const resultsBody = results.json() as { results: Array<{ externalId: string }> };
    expect(resultsBody.results.map((r) => r.externalId)).toEqual([relevant.externalId]);
  });

  it("an explicit criteria overrides the default — a title the CLI filter would reject", async () => {
    const productManagerJob = fakeJob(`pm-${randomUUID()}`, "Senior Product Manager", {
      location: "Remote - US",
    });
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [productManagerJob]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        criteria: { titleInclude: ["product manager"], remoteOk: true },
      },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);

    expect(body.status).toBe("complete");
    expect(body.newlyScored).toBe(1);
  });

  it("an explicit empty criteria object opts OUT of filtering entirely", async () => {
    const irrelevant = fakeJob(`opt-out-${randomUUID()}`, "Accountant II", {
      location: "Remote - US",
    });
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [irrelevant]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);

    expect(body.status).toBe("complete");
    expect(body.newlyScored).toBe(1);
  });
});

describe("POST /searches — swe-filter.ts's staff-level default, CLI/no-criteria path only (ticket 6b2313a)", () => {
  // History (opus review F3, PM-ratified): an earlier round of this ticket
  // also gave the EXPLICIT-criteria path its own hidden titleExclude
  // default, tested here with two more end-to-end cases. That default was
  // reverted (see criteria.ts and criteria.test.ts) — it was actively wrong
  // on that path, not just redundant. This describe block now covers only
  // what's actually true post-revert: the staff-level exclusion lives
  // solely in swe-filter.ts's `NOT` regex, reached only via
  // `compileFilter(undefined)` (no `criteria` field at all in the request
  // body). An explicit `criteria` — even `{}` — never sees it; see the
  // "opts OUT of filtering entirely" test above.
  it("the CLI/no-criteria default excludes a staff-level title end to end", async () => {
    const staffJob = fakeJob(`staff-${randomUUID()}`, "Staff Software Engineer", {
      location: "Seattle, WA",
    });
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [staffJob]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE] },
    });
    const { searchId } = started.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);

    expect(body.status).toBe("complete");
    expect(body.newlyScored).toBe(0);
  });

  it("an explicit empty criteria object does NOT exclude a staff-level title — the default is CLI-only, not a title-exclude default that also applies to explicit criteria (F3 revert)", async () => {
    const staffJob = fakeJob(`staff-empty-crit-${randomUUID()}`, "Staff Software Engineer", {
      location: "Seattle, WA",
    });
    const app = buildApp({
      db,
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [staffJob]),
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    const body = await pollUntilDone(app, searchId);

    expect(body.status).toBe("complete");
    expect(body.newlyScored).toBe(1);
  });
});

describe("GET /searches/:id — restart fallback honesty (ticket 59fdc52 review round 2)", () => {
  async function insertOrphanSearch(status: "running" | "complete" | "failed"): Promise<{
    searchId: string;
    resumeId: string;
  }> {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const resumeId = await createResume(app);
    const searchId = randomUUID();
    // Bypasses runDemoMatch entirely — simulates a `searches` row exactly
    // as it would look if the API process that started this run died (or
    // finished, or explicitly failed) WITHOUT this process's in-memory
    // tracker ever having heard of it — the exact scenario the DB-fallback
    // branch of GET /searches/:id has to handle honestly.
    await db
      .insert(searchesTable)
      .values({ id: searchId, resumeId, searchedAt: new Date(), status });
    return { searchId, resumeId };
  }

  it("a row stuck at status='running' is reported incomplete, never complete", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("running");

    const response = await app.inject({ method: "GET", url: `/searches/${searchId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string };
    expect(body.status).toBe("incomplete");
    expect(body.status).not.toBe("complete");
  });

  it("a row with status='complete' is reported complete-details-unavailable, with a note — never bare 'complete'", async () => {
    // Ticket 59fdc52 review round 3, F3: this case must NOT share the
    // `status: "complete"` literal the live, in-memory-tracked case uses —
    // see SearchStatusResponse's doc comment (packages/shared) for why a
    // shared literal broke TypeScript narrowing for API consumers.
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("complete");

    const response = await app.inject({ method: "GET", url: `/searches/${searchId}` });
    const body = response.json() as { status: string; note?: string };
    expect(body.status).toBe("complete-details-unavailable");
    expect(body.status).not.toBe("complete");
    expect(body.note).toBeDefined();
  });

  it("a row with status='failed' is reported failed", async () => {
    const app = buildApp({
      db,
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("failed");

    const response = await app.inject({ method: "GET", url: `/searches/${searchId}` });
    const body = response.json() as { status: string };
    expect(body.status).toBe("failed");
  });
});

describe("searchRuns bound (ticket 59fdc52 review round 2)", () => {
  it("pruneSearchRuns evicts oldest complete/failed entries once over the cap, never a pending one", () => {
    const { searchRuns, MAX_TRACKED_SEARCHES, pruneSearchRuns } = __testing;
    searchRuns.clear();
    try {
      // One pending entry inserted FIRST (oldest by insertion order) — if
      // eviction ignored status, this would be the first thing deleted.
      searchRuns.set("pending-oldest", { status: "pending", resumeId: "r0", scoredSoFar: 0 });
      for (let i = 0; i < MAX_TRACKED_SEARCHES + 50; i++) {
        searchRuns.set(`complete-${i}`, {
          status: "complete",
          resumeId: `r${i}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          result: {} as any,
        });
      }
      expect(searchRuns.size).toBeGreaterThan(MAX_TRACKED_SEARCHES);

      pruneSearchRuns();

      expect(searchRuns.size).toBeLessThanOrEqual(MAX_TRACKED_SEARCHES);
      expect(searchRuns.has("pending-oldest")).toBe(true);
    } finally {
      searchRuns.clear();
    }
  });
});
