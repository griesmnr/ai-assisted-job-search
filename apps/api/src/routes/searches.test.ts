import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import {
  jobMatchFailures,
  jobMatches,
  searchResults,
  searchSources,
  searches as searchesTable,
} from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { DEFAULT_SCORE_THRESHOLD, type ScoreJobFn, type ScoredJob } from "../matching/index.js";
import { loadEnvFile } from "../load-env.js";
import { STALL_AFTER_MS } from "./searches.js";
import type { DispatchFailure, PublishFetchSourceFn } from "../queue/publisher.js";
import {
  createFetchSourceHandler,
  type FetchSourceMessage,
  type ScoreJobMessage,
} from "../worker/fetchSourceWorker.js";
import { createScoreJobHandler, type SpendGuard } from "../worker/scoreJobWorker.js";
import type {
  JobSource,
  NormalizedJob,
  SearchCriteria as SourceFetchCriteria,
  SourceSearchResult,
} from "../sources/types.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see db/test-db.ts. This
// file used to connect straight to the shared dev Postgres.
let testDb: TestDatabase;
let db: NodePgDatabase;

// "usajobs" is one of the real dataSource ids demo-match.ts's
// seedSourceDescriptors always seeds — reused here for the same reason
// demo-match.test.ts uses it: no throwaway source_descriptors row needed.
const DATA_SOURCE = "usajobs" as const;

/** Never the real `prep/scoring-usage-stats.json`: the score worker writes
 * to whatever path it's given after a successful batch, and a test must
 * never touch the owner's real cost corpus. */
const TEST_USAGE_STATS_PATH = path.join(os.tmpdir(), `searches-test-usage-${randomUUID()}.json`);

beforeAll(async () => {
  testDb = await createTestDatabase("searches_test");
  db = testDb.db;
});

afterAll(async () => {
  // No manual row cleanup needed: everything this file created lives in
  // its own isolated database (created in beforeAll above), dropped whole
  // here.
  await testDb?.teardown();
  fs.rmSync(TEST_USAGE_STATS_PATH, { force: true });
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
 * point is mechanics (fan-out, polling, cost accounting), not filtering
 * itself. Company is derived from `externalId` (not a fixed "Test Co") so
 * a test seeding many of these doesn't accidentally collapse them all into
 * one survivor via the company|title dedupe every filter path applies. */
function matchingJob(
  externalId: string,
  dataSource: NormalizedJob["dataSource"] = DATA_SOURCE,
): NormalizedJob {
  return fakeJob(externalId, "Senior Software Engineer", {
    location: "Seattle, WA",
    company: `Test Co ${externalId}`,
    dataSource,
  });
}

class FakeSource implements JobSource {
  constructor(
    private readonly jobsToReturn: NormalizedJob[],
    readonly dataSource: NormalizedJob["dataSource"] = DATA_SOURCE,
  ) {}
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
      if (known.has(id))
        sources.push(new FakeSource(jobsToReturn, id as NormalizedJob["dataSource"]));
      else skipped.push({ id, reason: "not available in this test's fake resolver" });
    }
    return { sources, skipped };
  };
}

/** Resolver for multi-source tests: each id resolves to its OWN adapter
 * returning its OWN jobs, with a matching `dataSource` (the fetch worker
 * refuses to ingest under a mismatched natural key — see
 * `SourceMismatchError`). */
function fakeResolverPerSource(jobsBySource: Record<string, NormalizedJob[]>) {
  return (sourceIds: string[]) => {
    const sources: JobSource[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of sourceIds) {
      const jobs = jobsBySource[id];
      if (jobs) sources.push(new FakeSource(jobs, id as NormalizedJob["dataSource"]));
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

// ---------------------------------------------------------------------------
// The queue rig (ticket 4f88339).
//
// `POST /searches` no longer runs a search — it records one and publishes
// `fetch.source`. So these tests need two halves that used to be one:
//
//   1. a FAKE PUBLISHER, injected into the route, which captures what the
//      route would have put on the broker (and can be told to fail for a
//      given source, which is how the dispatch-failure path is exercised);
//   2. the REAL worker handlers (`createFetchSourceHandler` /
//      `createScoreJobHandler`) driven by hand against a fake channel, so
//      what these tests assert is the genuine end-to-end fan-out/fan-in —
//      route -> fetch.source -> ingest -> score.job -> job_matches /
//      job_match_failures -> the completion derive in GET /searches/:id —
//      with only the BROKER faked, not the workers.
//
// Everything else is real: real Postgres (per-file isolated database), the
// real route, the real ingest path, the real derive.
// ---------------------------------------------------------------------------

class FakeChannel extends EventEmitter {
  published: { exchange: string; routingKey: string; content: Buffer }[] = [];
  sentToQueue: { queue: string; content: Buffer; headers: Record<string, unknown> }[] = [];
  acked: ConsumeMessage[] = [];
  nacked: ConsumeMessage[] = [];

  publish(exchange: string, routingKey: string, content: Buffer): boolean {
    this.published.push({ exchange, routingKey, content });
    return true;
  }

  sendToQueue(queue: string, content: Buffer, options?: { headers?: Record<string, unknown> }) {
    this.sentToQueue.push({ queue, content, headers: options?.headers ?? {} });
    return true;
  }

  ack(msg: ConsumeMessage): void {
    this.acked.push(msg);
  }

  nack(msg: ConsumeMessage): void {
    this.nacked.push(msg);
  }

  async waitForConfirms(): Promise<void> {}
}

function fakeChannel(): FakeChannel & ConfirmChannel {
  return new FakeChannel() as unknown as FakeChannel & ConfirmChannel;
}

function consumeMessage(body: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(body)),
    fields: {
      routingKey: "fetch.source",
      exchange: "jobs",
      redelivered: false,
      consumerTag: "test-consumer",
      deliveryTag: 1,
    },
    properties: { headers, contentType: "application/json" },
  } as unknown as ConsumeMessage;
}

/** Captures what `POST /searches` publishes, and can refuse specific
 * sources so the dispatch-failure branch (design §4.1 step 5) is
 * exercisable without breaking a real broker. */
function fakePublisher(options: { failFor?: ReadonlySet<string> } = {}) {
  const published: FetchSourceMessage[] = [];
  const publish: PublishFetchSourceFn = async (messages) => {
    const failures: DispatchFailure[] = [];
    for (const message of messages) {
      if (options.failFor?.has(message.sourceId)) {
        failures.push({ sourceId: message.sourceId, error: "simulated broker failure" });
      } else {
        published.push(message);
      }
    }
    return failures;
  };
  return { publish, published };
}

type QueueRig = {
  /** Runs the real fetch worker against one captured message. */
  runFetch(message: FetchSourceMessage, headers?: Record<string, unknown>): Promise<void>;
  /** Runs the real score worker against one `score.job` body. */
  runScore(message: ScoreJobMessage, headers?: Record<string, unknown>): Promise<void>;
  /** Every `score.job` the fetch worker has published and not yet been
   * drained of. */
  takeScoreJobs(): ScoreJobMessage[];
  /** Fetch every message, then score every job it produced. */
  drain(messages: readonly FetchSourceMessage[]): Promise<void>;
  channel: FakeChannel;
};

function makeQueueRig(options: {
  sources: Partial<Record<string, JobSource>>;
  scoreJob?: ScoreJobFn;
  spendGuard?: SpendGuard;
  /** Applies to the SCORE worker only — 1 means "the first failure is
   * already the last attempt", which is how a permanent dead-letter is
   * forced deterministically. */
  scoreMaxAttempts?: number;
}): QueueRig {
  const channel = fakeChannel();
  const fetchHandler = createFetchSourceHandler({
    channel,
    db,
    sources: options.sources,
    log: () => {},
    onHighSkipRate: () => {},
  });
  const scoreHandler = createScoreJobHandler({
    channel,
    db,
    scoreJob: options.scoreJob ?? makeFakeScorer(),
    log: () => {},
    usageStatsPath: TEST_USAGE_STATS_PATH,
    ...(options.spendGuard ? { spendGuard: options.spendGuard } : {}),
    ...(options.scoreMaxAttempts !== undefined ? { maxAttempts: options.scoreMaxAttempts } : {}),
  });

  const rig: QueueRig = {
    channel,
    async runFetch(message, headers = {}) {
      await fetchHandler(consumeMessage(message, headers));
    },
    async runScore(message, headers = {}) {
      await scoreHandler(consumeMessage(message, headers));
    },
    takeScoreJobs() {
      const jobs = channel.published
        .filter((p) => p.routingKey === "score.job")
        .map((p) => JSON.parse(p.content.toString("utf-8")) as ScoreJobMessage);
      channel.published = [];
      return jobs;
    },
    async drain(messages) {
      for (const message of messages) await rig.runFetch(message);
      for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);
    },
  };
  return rig;
}

type StatusBody = {
  status: string;
  scored?: number;
  scoredSoFar?: number;
  linked?: number;
  permanentlyFailed?: number;
  sourcesSettled?: boolean;
  degraded?: boolean;
  completedAt?: string;
  stalledSince?: string;
  outstandingJobIds?: string[];
  error?: string;
  note?: string;
  sources?: Array<{
    sourceId: string;
    status: string;
    linkedJobCount: number | null;
    errorKind?: string;
  }>;
};

async function getStatus(
  app: ReturnType<typeof buildApp>,
  searchId: string,
): Promise<StatusBody & { httpStatus: number }> {
  const response = await app.inject({ method: "GET", url: `/searches/${searchId}` });
  return { ...(response.json() as StatusBody), httpStatus: response.statusCode };
}

describe("POST /searches/estimate", () => {
  it("reports a cost estimate, never calls scoreJob, and does not return a searchId", async () => {
    const jobs = [matchingJob(`est-a-${randomUUID()}`), matchingJob(`est-b-${randomUUID()}`)];
    const app = buildApp({
      db,
      inferTitles: async () => [],
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
      resumeId: string;
      candidatesNeedingScore: number;
      costEstimate: { jobCount: number };
      searchId?: string;
    };
    expect(body.resumeId).toBe(resumeId);
    expect(body.candidatesNeedingScore).toBe(jobs.length);
    expect(body.costEstimate.jobCount).toBe(jobs.length);
    expect(body.searchId).toBeUndefined();
  });

  it("reports a CAP-AWARE cost estimate — priced at scoreThreshold, not the full pool", async () => {
    // Ticket 59fdc52 review round 2: the estimate used to price the whole
    // pool needing a score, while a real run only ever scores
    // scoreThreshold of them.
    const jobs = Array.from({ length: DEFAULT_SCORE_THRESHOLD + 5 }, (_, i) =>
      matchingJob(`cap-${i}-${randomUUID()}`),
    );
    const app = buildApp({
      db,
      inferTitles: async () => [],
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
    const body = response.json() as {
      candidatesNeedingScore: number;
      cappedCount: number;
      scoreThreshold: number;
      costEstimate: { jobCount: number };
    };
    expect(body.candidatesNeedingScore).toBe(jobs.length);
    expect(body.scoreThreshold).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(body.cappedCount).toBe(jobs.length - DEFAULT_SCORE_THRESHOLD);
    expect(body.costEstimate.jobCount).toBe(DEFAULT_SCORE_THRESHOLD);
  });

  it("404s for an unknown resumeId", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
    });
    const response = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId: randomUUID(), sourceIds: [DATA_SOURCE] },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s when none of the requested sourceIds resolve", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
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
      inferTitles: async () => [],
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
    const app = buildApp({
      db,
      inferTitles: async () => [],
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

describe("POST /searches — fan-out (ticket 4f88339, design c54b9e0 §4.1)", () => {
  it("writes one pending search_sources row and publishes one fetch.source message per source, and returns 202 before any of them is consumed", async () => {
    const sourceIds = ["usajobs", "greenhouse", "lever"];
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({
        usajobs: [matchingJob(`fan-u-${randomUUID()}`, "usajobs")],
        greenhouse: [matchingJob(`fan-g-${randomUUID()}`, "greenhouse")],
        lever: [matchingJob(`fan-l-${randomUUID()}`, "lever")],
      }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds, criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId, status } = started.json() as { searchId: string; status: string };
    expect(status).toBe("pending");

    // Fan-out width is durable BEFORE anything consumes a message.
    const rows = await db.select().from(searchSources).where(eq(searchSources.searchId, searchId));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect(rows.every((r) => r.linkedJobCount === null)).toBe(true);
    expect(new Set(rows.map((r) => r.sourceDescriptorId))).toEqual(new Set(sourceIds));

    expect(publisher.published).toHaveLength(3);
    expect(new Set(publisher.published.map((m) => m.sourceId))).toEqual(new Set(sourceIds));
    expect(publisher.published.every((m) => m.searchId === searchId)).toBe(true);

    // And the `searches` row is committed before the publish — the
    // DB-then-publish ordering the design calls load-bearing.
    const searchRow = await db.select().from(searchesTable).where(eq(searchesTable.id, searchId));
    expect(searchRow[0]?.status).toBe("running");
    expect(searchRow[0]?.completedAt).toBeNull();
  });

  it("VACUOUS-TRUTH GUARD: a search with zero linked jobs yet reports pending, never complete (design §2)", async () => {
    // THE specific bug the `sourcesSettled` conjunct exists to prevent.
    // "Every job this search linked has been scored" is TRUE for a search
    // that has linked nothing, so without the source-level gate a
    // brand-new search reads as complete the instant POST returns.
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
        matchingJob(`vacuous-${randomUUID()}`),
      ]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    // Nothing has consumed the fetch.source message yet.
    const linked = await db
      .select()
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId));
    expect(linked).toHaveLength(0);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("pending");
    expect(body.status).not.toBe("complete");
    expect(body.sourcesSettled).toBe(false);
    expect(body.linked).toBe(0);
    expect(body.scoredSoFar).toBe(0);
  });

  it("runs end to end through both workers and reports a durable complete", async () => {
    const publisher = fakePublisher();
    const job = matchingJob(`e2e-${randomUUID()}`);
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });
    await rig.drain(publisher.published);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
    expect(body.linked).toBe(1);
    expect(body.permanentlyFailed).toBe(0);
    expect(body.degraded).toBe(false);
    expect(body.completedAt).toBeDefined();
    expect(body.sources).toEqual([
      { sourceId: DATA_SOURCE, status: "complete", linkedJobCount: 1 },
    ]);

    // The completion latch is durable, not recomputed-only.
    const row = await db.select().from(searchesTable).where(eq(searchesTable.id, searchId));
    expect(row[0]?.status).toBe("complete");
    expect(row[0]?.completedAt).not.toBeNull();

    // Results land in the database and are readable via the resume-scoped
    // results endpoint — decision #3, "results come from the database, not
    // a run's in-memory state".
    const results = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const resultsBody = results.json() as { results: Array<{ matchScore: number }> };
    expect(resultsBody.results).toHaveLength(1);
    expect(resultsBody.results[0]?.matchScore).toBe(77);
  });

  it("reports genuine intermediate progress: one source settled, one still fetching", async () => {
    const usajobsJob = matchingJob(`prog-u-${randomUUID()}`, "usajobs");
    const greenhouseJob = matchingJob(`prog-g-${randomUUID()}`, "greenhouse");
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({
        usajobs: [usajobsJob],
        greenhouse: [greenhouseJob],
      }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["usajobs", "greenhouse"], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({
      sources: {
        usajobs: new FakeSource([usajobsJob], "usajobs"),
        greenhouse: new FakeSource([greenhouseJob], "greenhouse"),
      },
    });

    // Only the first source's message is consumed, and its job scored.
    const first = publisher.published.find((m) => m.sourceId === "usajobs")!;
    await rig.runFetch(first);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    const midway = await getStatus(app, searchId);
    expect(midway.status).toBe("pending");
    expect(midway.sourcesSettled).toBe(false);
    expect(midway.scoredSoFar).toBe(1);
    expect(midway.linked).toBe(1);
    expect(midway.sources?.find((s) => s.sourceId === "usajobs")?.status).toBe("complete");
    expect(midway.sources?.find((s) => s.sourceId === "greenhouse")?.status).toBe("pending");

    const second = publisher.published.find((m) => m.sourceId === "greenhouse")!;
    await rig.runFetch(second);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    const done = await getStatus(app, searchId);
    expect(done.status).toBe("complete");
    expect(done.scored).toBe(2);
    expect(done.linked).toBe(2);
  });

  it("404s GET /searches/:id for a truly unknown id", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
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
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set(), []),
      publishFetchSource: fakePublisher().publish,
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["nonexistent-source"] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s on a duplicate sourceId (which is also what underwrites search_sources' unique constraint)", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
      publishFetchSource: fakePublisher().publish,
    });
    const resumeId = await createResume(app);
    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE, DATA_SOURCE] },
    });
    expect(response.statusCode).toBe(400);
  });

  it("400s a typo'd criteria field instead of silently stripping it (ticket 59fdc52 review round 3, F1)", async () => {
    // Live-verified defect: Fastify's AJV defaults include
    // `removeAdditional: true`; overriding only `coerceTypes` (round 2)
    // left it in effect, so `additionalProperties: false` on
    // searchCriteriaSchema silently DELETED an unrecognized key instead of
    // rejecting the request — "titleInclud" (missing the trailing "e")
    // silently became `criteria: {}`, this codebase's own "opt out of
    // filtering entirely" sentinel.
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`typo-${randomUUID()}`)]),
      publishFetchSource: fakePublisher().publish,
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

  it("a synchronous throw from getScoreJob() never wedges the resume, and nothing is published (ticket 59fdc52 review round 3, F2)", async () => {
    // The original defect was an in-memory guard set before
    // `getScoreJob()` threw, with nothing left to release it. The guard is
    // durable now, but the ordering requirement is identical and still
    // worth pinning: resolve the scorer BEFORE writing any state, so a
    // "no billing credentials configured" throw leaves nothing behind —
    // no `searches` row, no published message, no wedged resume.
    let calls = 0;
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        calls++;
        if (calls === 1) throw new Error("ANTHROPIC_API_KEY missing (simulated)");
        return makeFakeScorer();
      },
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`f2-${randomUUID()}`)]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const first = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(first.statusCode).toBe(500);
    expect(publisher.published).toHaveLength(0);
    const orphans = await db
      .select()
      .from(searchesTable)
      .where(eq(searchesTable.resumeId, resumeId));
    expect(orphans).toHaveLength(0);

    // The critical assertion: the resume must NOT be wedged — a second
    // POST /searches must proceed normally (202), not 409 forever.
    const second = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(second.statusCode).toBe(202);
  });
});

describe("POST /searches — dispatch failure (design §4.1 step 5)", () => {
  it("marks the individual source dispatch-failed and lets the others run", async () => {
    const usajobsJob = matchingJob(`disp-u-${randomUUID()}`, "usajobs");
    const publisher = fakePublisher({ failFor: new Set(["greenhouse"]) });
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({
        usajobs: [usajobsJob],
        greenhouse: [matchingJob(`disp-g-${randomUUID()}`, "greenhouse")],
      }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["usajobs", "greenhouse"], criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { usajobs: new FakeSource([usajobsJob], "usajobs") } });
    await rig.drain(publisher.published);

    const body = await getStatus(app, searchId);
    // The undeliverable source never wedges the search: it is already
    // terminal, so the search settles on the sources that did dispatch.
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
    const greenhouse = body.sources?.find((s) => s.sourceId === "greenhouse");
    expect(greenhouse?.status).toBe("failed");
    expect(greenhouse?.errorKind).toBe("dispatch-failed");
  });

  it("502s and marks the whole search failed when NO source could be dispatched", async () => {
    const publisher = fakePublisher({ failFor: new Set([DATA_SOURCE]) });
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [matchingJob(`nod-${randomUUID()}`)]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(started.statusCode).toBe(502);
    const { searchId } = started.json() as { searchId: string };

    const row = await db.select().from(searchesTable).where(eq(searchesTable.id, searchId));
    expect(row[0]?.status).toBe("failed");
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("failed");

    // And, critically, the resume is not wedged: a failed dispatch is
    // terminal, so the next POST is allowed straight through.
    const retry = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(retry.statusCode).toBe(502);
  });
});

describe("idempotency under redelivery (design §6.1/§6.2)", () => {
  it("running the fetch handler twice on the same message changes nothing", async () => {
    const job = matchingJob(`redeliver-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    const message = publisher.published[0]!;

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });

    await rig.runFetch(message);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);
    const afterFirst = await getStatus(app, searchId);
    const linksAfterFirst = await db
      .select()
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId));
    const sourceAfterFirst = await db
      .select()
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));

    // Redelivery: the identical message, handled again from the top.
    await rig.runFetch(message);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);
    const afterSecond = await getStatus(app, searchId);
    const linksAfterSecond = await db
      .select()
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId));
    const sourceAfterSecond = await db
      .select()
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));

    expect(linksAfterSecond).toHaveLength(linksAfterFirst.length);
    expect(linksAfterSecond).toHaveLength(1);
    // SET, not incremented — this is the assertion a counter design would
    // fail.
    expect(sourceAfterSecond[0]?.linkedJobCount).toBe(sourceAfterFirst[0]?.linkedJobCount);
    expect(sourceAfterSecond[0]?.linkedJobCount).toBe(1);
    expect(afterSecond.status).toBe(afterFirst.status);
    expect(afterSecond.scored).toBe(afterFirst.scored);
    expect(afterSecond.linked).toBe(afterFirst.linked);

    const matches = await db.select().from(jobMatches);
    const forThisJob = matches.filter((m) => m.resumeId === resumeId);
    expect(forThisJob).toHaveLength(1);
  });

  it("running the score handler twice on the same job scores it once", async () => {
    const job = matchingJob(`redeliver-score-${randomUUID()}`);
    const publisher = fakePublisher();
    let scoreCalls = 0;
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([job]) },
      scoreJob: async (j) => {
        scoreCalls++;
        return { matchScore: 80, rationale: `r for ${j.title}`, strengths: [], gaps: [] };
      },
    });
    await rig.runFetch(publisher.published[0]!);
    const scoreJobs = rig.takeScoreJobs();
    expect(scoreJobs).toHaveLength(1);

    await rig.runScore(scoreJobs[0]!);
    await rig.runScore(scoreJobs[0]!);

    // The already-scored check ran before the second Claude call would
    // have — no re-billing.
    expect(scoreCalls).toBe(1);
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
  });
});

describe("DLQ terminability (design §6.4, §8)", () => {
  it("a job whose score.job exhausts its retries gets a job_match_failures row and the search reaches complete+degraded, not stuck pending", async () => {
    const good = matchingJob(`dlq-ok-${randomUUID()}`);
    const bad = matchingJob(`dlq-bad-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [good, bad]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([good, bad]) },
      // maxAttempts 1: the first failure is already the last attempt, so a
      // retryable error dead-letters deterministically with no waiting.
      scoreMaxAttempts: 1,
      scoreJob: async (job) => {
        if (job.externalId === bad.externalId) throw new Error("simulated sustained outage");
        return { matchScore: 70, rationale: "ok", strengths: [], gaps: [] };
      },
    });
    await rig.runFetch(publisher.published[0]!);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("unknown");
    expect(failures[0]?.attempts).toBe(1);
    // The message really did dead-letter (nack, no requeue) rather than
    // being held.
    expect(rig.channel.nacked).toHaveLength(1);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.status).not.toBe("pending");
    expect(body.scored).toBe(1);
    expect(body.permanentlyFailed).toBe(1);
    expect(body.degraded).toBe(true);
  });

  it("TOTAL scoring failure is reported as failed, not as a normal complete (design §8)", async () => {
    const job = matchingJob(`total-fail-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([job]) },
      scoreMaxAttempts: 1,
      scoreJob: async () => {
        throw new Error("every call fails — e.g. an expired API key");
      },
    });
    await rig.runFetch(publisher.published[0]!);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("failed");
    expect(body.status).not.toBe("complete");
    expect(body.error).toContain("Total scoring failure");

    // Latched honestly, so a later poll agrees with the first one.
    const row = await db.select().from(searchesTable).where(eq(searchesTable.id, searchId));
    expect(row[0]?.status).toBe("failed");
    expect((await getStatus(app, searchId)).status).toBe("failed");
  });

  it("a job the SPEND GUARD refuses is terminal, not outstanding (ticket b53c422 interaction, design §10)", async () => {
    const first = matchingJob(`budget-a-${randomUUID()}`);
    const second = matchingJob(`budget-b-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [first, second]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    // Allow exactly one reservation, then refuse forever — the shape a
    // real tripped `ScoringSpendGuard` has for the rest of the process's
    // life.
    let allowed = 0;
    const spendGuard: SpendGuard = {
      tryReserve: () => {
        allowed++;
        return allowed === 1;
      },
    };
    const rig = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([first, second]) },
      spendGuard,
      scoreMaxAttempts: 1,
    });
    await rig.runFetch(publisher.published[0]!);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("spend-guard-exceeded");

    // Without that row, a budget-limited search would hang forever.
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
    expect(body.permanentlyFailed).toBe(1);
    expect(body.degraded).toBe(true);
  });
});

describe("source failure (CLAUDE.md's DLQ product behaviour, end to end)", () => {
  it("one source dead-letters, the others succeed, and the search still completes", async () => {
    const usajobsJob = matchingJob(`src-ok-${randomUUID()}`, "usajobs");
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({
        usajobs: [usajobsJob],
        greenhouse: [matchingJob(`src-bad-${randomUUID()}`, "greenhouse")],
      }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["usajobs", "greenhouse"], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    // The greenhouse adapter is NOT registered in this worker — an
    // `UnknownSourceError`, which `classify()` calls non-retryable, so the
    // message dead-letters immediately.
    const rig = makeQueueRig({ sources: { usajobs: new FakeSource([usajobsJob], "usajobs") } });
    await rig.drain(publisher.published);

    expect(rig.channel.nacked).toHaveLength(1);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
    const greenhouse = body.sources?.find((s) => s.sourceId === "greenhouse");
    expect(greenhouse?.status).toBe("failed");
    expect(greenhouse?.errorKind).toBe("unknown-source");
    expect(body.sources?.find((s) => s.sourceId === "usajobs")?.status).toBe("complete");
  });

  it("every source failing with nothing linked is reported failed, not an empty success", async () => {
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({
        greenhouse: [matchingJob(`all-bad-${randomUUID()}`, "greenhouse")],
      }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["greenhouse"], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: {} });
    await rig.drain(publisher.published);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("failed");
    expect(body.error).toContain("Every source");
  });

  it("a source that legitimately finds nothing is an empty COMPLETE, not a failure", async () => {
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([]) } });
    await rig.drain(publisher.published);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.linked).toBe(0);
    expect(body.scored).toBe(0);
    expect(body.degraded).toBe(false);
    expect(body.sources?.[0]?.linkedJobCount).toBe(0);
  });
});

describe("fetchSourceWorker's search_sources ledger writes (design §4.2)", () => {
  // These live here rather than in fetchSourceWorker.test.ts because that
  // file connects to a REAL RabbitMQ (unavailable in this sandbox — see
  // its own header note). The handler under test is the real one either
  // way; only the channel is faked.
  class ThrowingSource implements JobSource {
    readonly dataSource = DATA_SOURCE;
    async search(): Promise<SourceSearchResult> {
      throw new Error("simulated transient source failure");
    }
  }

  async function startSearchWithThrowingSource(): Promise<{
    app: ReturnType<typeof buildApp>;
    searchId: string;
    message: FetchSourceMessage;
    rig: QueueRig;
  }> {
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), []),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new ThrowingSource() } });
    return { app, searchId, message: publisher.published[0]!, rig };
  }

  it("the RETRY path writes nothing — the source is still pending, which is the truth", async () => {
    const { app, searchId, message, rig } = await startSearchWithThrowingSource();

    await rig.runFetch(message, { "x-attempt": 1 });

    expect(rig.channel.sentToQueue).toHaveLength(1); // scheduled a retry tier
    const rows = await db.select().from(searchSources).where(eq(searchSources.searchId, searchId));
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.errorKind).toBeNull();

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("pending");
    expect(body.sourcesSettled).toBe(false);
  });

  it("the RETRIES-EXHAUSTED path marks the source failed with its classified kind, and the search stops waiting on it", async () => {
    const { app, searchId, message, rig } = await startSearchWithThrowingSource();

    // Default maxAttempts is 4; arriving as attempt 4 means this delivery
    // is the last one.
    await rig.runFetch(message, { "x-attempt": 4 });

    expect(rig.channel.nacked).toHaveLength(1);
    expect(rig.channel.sentToQueue).toHaveLength(0);
    const rows = await db.select().from(searchSources).where(eq(searchSources.searchId, searchId));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.errorKind).toBe("unknown");
    expect(rows[0]?.errorMessage).toContain("simulated transient source failure");

    // Terminability: the dead-letter does not leave the search hanging.
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("failed");
    expect(body.status).not.toBe("pending");
  });
});

describe("GET /searches/:id answers from durable state alone (ticket 59fdc52's requirement, re-asserted)", () => {
  it("a BRAND-NEW Fastify instance — no shared module state of any kind — reports the correct complete payload", async () => {
    const job = matchingJob(`restart-${randomUUID()}`);
    const publisher = fakePublisher();
    const startingApp = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(startingApp);
    const started = await startingApp.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });
    await rig.drain(publisher.published);

    // "Restart": a completely separate app instance that never saw the
    // POST, never published anything, and shares nothing with the one
    // above except Postgres. Under the old design this is the case the
    // in-memory `searchRuns` Map could not answer; there is now no
    // in-memory state for it to miss.
    const restartedApp = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("a restarted process must not need a scorer to answer a poll");
      },
      publishFetchSource: async () => {
        throw new Error("a restarted process must not need a broker to answer a poll");
      },
    });

    const body = await getStatus(restartedApp, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(1);
    expect(body.linked).toBe(1);
    expect(body.sources?.[0]).toEqual({
      sourceId: DATA_SOURCE,
      status: "complete",
      linkedJobCount: 1,
    });
  });

  it("a mid-flight search polled from a fresh instance reports real progress, not 'incomplete'", async () => {
    const job = matchingJob(`restart-mid-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    // Fetching finished; scoring has not started.
    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });
    await rig.runFetch(publisher.published[0]!);
    rig.takeScoreJobs();

    const restartedApp = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const body = await getStatus(restartedApp, searchId);
    // The old design reported a hedging "incomplete" here because a
    // `running` row was ambiguous after a restart. It isn't any more.
    expect(body.status).toBe("pending");
    expect(body.sourcesSettled).toBe(true);
    expect(body.linked).toBe(1);
    expect(body.scoredSoFar).toBe(0);
  });
});

describe("GET /searches/:id — pre-queue rows keep ticket 59fdc52's honesty", () => {
  async function insertOrphanSearch(status: "running" | "complete" | "failed"): Promise<{
    searchId: string;
    resumeId: string;
  }> {
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const resumeId = await createResume(app);
    const searchId = randomUUID();
    // Bypasses both the route and runDemoMatch — this is exactly the shape
    // a row from before this migration (or from the CLI path) has: a
    // `searches` row with no `completed_at` latch and no per-source
    // ledger behind it.
    await db
      .insert(searchesTable)
      .values({ id: searchId, resumeId, searchedAt: new Date(), status });
    return { searchId, resumeId };
  }

  it("a row stuck at status='running' with no source ledger is reported incomplete, never complete", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("running");

    const body = await getStatus(app, searchId);
    expect(body.httpStatus).toBe(200);
    expect(body.status).toBe("incomplete");
    expect(body.status).not.toBe("complete");
  });

  it("a row with status='complete' and no latch is reported complete-details-unavailable, with a note — never bare 'complete'", async () => {
    // Ticket 59fdc52 review round 3, F3: this case must NOT share the
    // `status: "complete"` literal the durable case uses — see
    // SearchStatusResponse's doc comment (packages/shared) for why a
    // shared literal broke TypeScript narrowing for API consumers. It is
    // also what every `POST /searches/estimate` row looks like.
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("complete");

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete-details-unavailable");
    expect(body.status).not.toBe("complete");
    expect(body.note).toBeDefined();
  });

  it("a row with status='failed' is reported failed", async () => {
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used");
      },
    });
    const { searchId } = await insertOrphanSearch("failed");

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("failed");
  });
});

describe("the in-flight guard is durable now (design §4.4)", () => {
  it("409s a second POST for the same resume, and allows one again once the search reaches terminal", async () => {
    const job = matchingJob(`inflight-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
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

    // Finish the first search through the real workers.
    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });
    await rig.drain(publisher.published);

    // The guard releases on DURABLE terminal state, with no poll needed in
    // between — the third POST is what proves it, not a GET.
    const third = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(third.statusCode).toBe(202);
  });

  it("a STALLED search stops 409-ing once it is past the staleness window (design §6.5)", async () => {
    // The residual stall this window exists for: a marker write failed
    // AND the message dead-lettered, so nothing will ever settle this
    // search. Simulated directly by backdating `searched_at` past
    // STALL_AFTER_MS while leaving a source pending.
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
        matchingJob(`stall-${randomUUID()}`),
      ]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const first = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = first.json() as { searchId: string };

    // Still fresh: it blocks.
    const blocked = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(blocked.statusCode).toBe(409);

    await db
      .update(searchesTable)
      .set({ searchedAt: new Date(Date.now() - STALL_AFTER_MS - 60_000) })
      .where(eq(searchesTable.id, searchId));

    // One stalled search must never wedge a resume permanently — the
    // exact class of bug ticket 59fdc52 round 3 F2 found in the in-memory
    // version.
    const allowed = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(allowed.statusCode).toBe(202);

    // And the stalled search says so out loud rather than looking healthy.
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("pending");
    expect(body.stalledSince).toBeDefined();
    expect(Array.isArray(body.outstandingJobIds)).toBe(true);
  });

  it("ESTIMATE REGRESSION (design §4.4's trap): an estimate for a resume does NOT 409 the next real search for it", async () => {
    // `POST /searches/estimate` inserts a REAL `searches` row and REAL
    // `search_sources` rows (all left `pending`, since nothing ever
    // fetches for them). Under a naive derive that row is non-terminal
    // forever and would 409 every subsequent real search for the resume.
    // It does not, because `runDemoMatch` marks the row `'complete'` and
    // the guard only considers `status = 'running'` rows. This is the test
    // that stops anyone "simplifying" that away.
    const job = matchingJob(`estimate-trap-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const estimate = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(estimate.statusCode).toBe(200);

    // The estimate really did leave a searches row behind — otherwise this
    // test would pass vacuously.
    const estimateRows = await db
      .select()
      .from(searchesTable)
      .where(eq(searchesTable.resumeId, resumeId));
    expect(estimateRows).toHaveLength(1);
    expect(estimateRows[0]?.status).toBe("complete");

    const real = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(real.statusCode).toBe(202);
    expect(real.statusCode).not.toBe(409);

    // And a second estimate afterwards still doesn't 409 (the estimate
    // route has no guard at all — it spends no money).
    const secondEstimate = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(secondEstimate.statusCode).toBe(200);
  });
});

// Ticket d1fc9e2: `criteria.titleInclude` must reach each source's own
// `search()` as FETCH-level `criteria.keywords`, not just as the local
// post-fetch `filter` — that's the actual fix (USAJOBS narrowing its own
// query instead of fetching an unfiltered, pagination-capped sample of
// everything). On the estimate route a recording source observes that
// directly; on the queue-driven `POST /searches` the same object now
// travels on the `fetch.source` message, so that is what gets asserted
// there.
class RecordingFakeSource implements JobSource {
  readonly dataSource = DATA_SOURCE;
  received: SourceFetchCriteria[] = [];
  async search(criteria: SourceFetchCriteria): Promise<SourceSearchResult> {
    this.received.push(criteria);
    return { jobs: [], skipped: [], skipRate: 0 };
  }
}

describe("fetch-level criteria reaches the source's own search() (ticket d1fc9e2)", () => {
  it("POST /searches/estimate: titleInclude becomes criteria.keywords", async () => {
    const recorder = new RecordingFakeSource();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: () => ({ sources: [recorder], skipped: [] }),
    });
    const resumeId = await createResume(app);

    await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        criteria: { titleInclude: ["software engineer", "backend engineer"] },
      },
    });

    expect(recorder.received).toHaveLength(1);
    expect(recorder.received[0]).toEqual({
      keywords: ["software engineer", "backend engineer"],
    });
  });

  it("POST /searches: the same criteria travel on the fetch.source message and reach the worker's source.search()", async () => {
    const recorder = new RecordingFakeSource();
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: () => ({ sources: [recorder], skipped: [] }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const response = await app.inject({
      method: "POST",
      url: "/searches",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        criteria: { titleInclude: ["civil engineer"] },
      },
    });
    expect(response.statusCode).toBe(202);

    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.criteria).toEqual({ keywords: ["civil engineer"] });

    // ...and the worker really does hand that object to the adapter.
    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: recorder } });
    await rig.drain(publisher.published);
    expect(recorder.received).toHaveLength(1);
    expect(recorder.received[0]).toEqual({ keywords: ["civil engineer"] });
  });

  it("an empty/absent titleInclude sends NO keyword at all -- 'search every title' stays unrestricted at fetch time too, not just locally", async () => {
    const recorder = new RecordingFakeSource();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: () => ({ sources: [recorder], skipped: [] }),
    });
    const resumeId = await createResume(app);

    await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });

    expect(recorder.received).toHaveLength(1);
    expect(recorder.received[0]).toEqual({});
  });

  it("blank/whitespace-only title chips are dropped, not sent as a keyword or falsely treated as 'no restriction' (ticket c419a12, N7)", async () => {
    const recorder = new RecordingFakeSource();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: () => ({ sources: [recorder], skipped: [] }),
    });
    const resumeId = await createResume(app);

    // A blank chip alongside real ones: the blank one must be dropped, and
    // the real ones must still narrow the fetch -- not fall back to an
    // unkeyworded search just because one chip was empty.
    await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        criteria: { titleInclude: ["  ", "civil engineer", "   backend engineer   "] },
      },
    });

    expect(recorder.received).toHaveLength(1);
    expect(recorder.received[0]).toEqual({
      keywords: ["civil engineer", "backend engineer"],
    });
  });

  it("a titleInclude of ONLY blank chips is treated as no restriction at all -- no keyword sent, not a silent full-board fetch triggered by a falsy empty string (ticket c419a12, N7)", async () => {
    const recorder = new RecordingFakeSource();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("estimate must never need a real scorer");
      },
      resolveSourceIds: () => ({ sources: [recorder], skipped: [] }),
    });
    const resumeId = await createResume(app);

    await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: {
        resumeId,
        sourceIds: [DATA_SOURCE],
        criteria: { titleInclude: ["", "   "] },
      },
    });

    expect(recorder.received).toHaveLength(1);
    expect(recorder.received[0]).toEqual({});
  });
});

/**
 * DELETED WITH THIS TICKET, RECORDED RATHER THAN SILENTLY DROPPED
 * (ticket 4f88339):
 *
 * 1. `describe("searchRuns bound")` — exercised `pruneSearchRuns`'s
 *    500-entry eviction bound and its "never evict a pending entry" rule
 *    through the module-private `__testing` export. The in-memory tracker
 *    it tested is GONE (design c54b9e0 §5.4): `searchRuns`,
 *    `SearchRunState`, `MAX_TRACKED_SEARCHES`, `pruneSearchRuns` and
 *    `__testing` are all deleted. The unbounded-growth and
 *    unevictable-pending-entry bugs those existed to prevent cannot occur
 *    in a design with no in-memory tracker at all, so this is a deletion
 *    of a test whose subject no longer exists — not lost coverage.
 *
 * 2. `describe("POST /searches — default vs explicit criteria selection")`
 *    and `describe("POST /searches — swe-filter.ts's staff-level
 *    default")` — five end-to-end tests asserting that the LOCAL quality
 *    filter decided which jobs `POST /searches` actually paid to score.
 *    That filter ran inside `runDemoMatch`, which this route no longer
 *    calls; `fetchSourceWorker` ingests everything a source returns and
 *    publishes a `score.job` for every linked job, so on the queue path
 *    the filter currently does not run at all. These tests were not
 *    deleted because the behaviour stopped mattering — it matters a great
 *    deal, which is why routes/searches.ts's header comment carries a
 *    KNOWN GAP block naming it as needing its own follow-up ticket. They
 *    were deleted because they would otherwise have been quietly rewritten
 *    into assertions that no longer test the thing they were written for.
 *    Coverage that remains today: `sources/criteria.test.ts`
 *    (`compileFilter` itself), `matching/swe-filter.test.ts` (the CLI
 *    default's regexes), and `demo-match.test.ts` (the filter end to end
 *    through `runDemoMatch`, which `POST /searches/estimate` and the CLI
 *    both still use).
 */
