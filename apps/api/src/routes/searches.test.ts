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
  jobs as jobsTable,
  searchResults,
  searchSources,
  searches as searchesTable,
} from "../db/schema.js";
import { createPooledTestDatabase, createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { DEFAULT_SCORE_THRESHOLD, type ScoreJobFn, type ScoredJob } from "../matching/index.js";
import { loadEnvFile } from "../load-env.js";
import { STALL_AFTER_MS } from "./searches.js";
import type { DispatchFailure, PublishFetchSourceFn } from "../queue/publisher.js";
import {
  createFetchSourceHandler,
  SCORE_THRESHOLD_CAPPED_KIND,
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
  /** Everything the FETCH worker wrote to its `log` hook. Captured rather
   * than swallowed (ticket 45ea34c) so a test can assert on a warning the
   * worker is supposed to emit loudly — an unfiltered message, say — which
   * is otherwise indistinguishable from the worker silently doing the same
   * thing. Still silent on stdout, exactly as `log: () => {}` was. */
  logs: string[];
};

function makeQueueRig(options: {
  sources: Partial<Record<string, JobSource>>;
  scoreJob?: ScoreJobFn;
  spendGuard?: SpendGuard;
  /** Applies to the SCORE worker only — 1 means "the first failure is
   * already the last attempt", which is how a permanent dead-letter is
   * forced deterministically. */
  scoreMaxAttempts?: number;
  /** Defaults to this file's shared single-client `db`. Overridden only by
   * the per-search-cap concurrency test (ticket c9c676d), which needs a
   * POOL: the cap's guard is `pg_advisory_xact_lock`, which is re-entrant
   * within a session, so two fetch handlers sharing one `pg.Client` cannot
   * tell a working guard from a broken one — the same reason the in-flight
   * guard's concurrency tests below use `createPooledTestDatabase`. */
  db?: NodePgDatabase;
}): QueueRig {
  const channel = fakeChannel();
  const logs: string[] = [];
  const rigDb = options.db ?? db;
  const fetchHandler = createFetchSourceHandler({
    channel,
    db: rigDb,
    sources: options.sources,
    log: (message) => logs.push(message),
    onHighSkipRate: () => {},
  });
  const scoreHandler = createScoreJobHandler({
    channel,
    db: rigDb,
    scoreJob: options.scoreJob ?? makeFakeScorer(),
    log: () => {},
    usageStatsPath: TEST_USAGE_STATS_PATH,
    ...(options.spendGuard ? { spendGuard: options.spendGuard } : {}),
    ...(options.scoreMaxAttempts !== undefined ? { maxAttempts: options.scoreMaxAttempts } : {}),
  });

  const rig: QueueRig = {
    channel,
    logs,
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
  cappedForBudget?: number;
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

  it("a job whose score.job dies in the worker's OUTER catch — not in the scoring loop — still reaches complete+degraded instead of sitting pending until the staleness backstop (ticket 96fc30d)", async () => {
    // The gap this pins: the scoring call itself SUCCEEDS here, and the
    // handler falls over afterwards, inserting `job_matches` (a Postgres
    // blip). That error lands in the handler's outer catch, which used to
    // dead-letter writing nothing at all — leaving the job with neither a
    // `job_matches` nor a `job_match_failures` row, so this search's
    // `outstanding` count never reached 0 and it read `pending` for the
    // full 45-minute `STALL_AFTER_MS` window before being called stalled.
    const good = matchingJob(`outer-ok-${randomUUID()}`);
    const doomed = matchingJob(`outer-blip-${randomUUID()}`);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [good, doomed]),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    // A `db` that is the real one except that the `job_matches` insert
    // fails while `failTheInsert` is set — which is how one specific
    // score.job message is made to die outside the per-resume loop while
    // its sibling goes through untouched. Everything else (including the
    // fetch worker's own writes and the `job_match_failures` write on the
    // dead-letter path) is delegated to the real db, bound to it so
    // drizzle's builders never see the proxy as `this`.
    let failTheInsert = false;
    const blippyDb = new Proxy(db as object, {
      get(target, prop) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (failTheInsert && table === jobMatches) {
              throw new Error("simulated Postgres blip on the job_matches insert");
            }
            return (db.insert as (t: never) => unknown)(table as never);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as NodePgDatabase;

    const rig = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([good, doomed]) },
      db: blippyDb,
      // The first failure is already the last attempt, so the outer catch
      // takes its retries-exhausted branch with no waiting.
      scoreMaxAttempts: 1,
    });
    await rig.runFetch(publisher.published[0]!);
    const scoreJobs = rig.takeScoreJobs();
    expect(scoreJobs).toHaveLength(2);

    const linkedJobIds = (
      await db.select().from(searchResults).where(eq(searchResults.searchId, searchId))
    ).map((row) => row.jobId);
    const doomedRow = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.externalId, doomed.externalId));
    const doomedJobId = doomedRow[0]!.id;
    expect(linkedJobIds).toContain(doomedJobId);

    for (const scoreJob of scoreJobs) {
      failTheInsert = scoreJob.jobId === doomedJobId;
      await rig.runScore(scoreJob);
    }

    // It really did dead-letter, and it really did score first — the
    // failure is entirely outside the per-resume loop.
    expect(rig.channel.nacked).toHaveLength(1);
    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.searchId, searchId));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.jobId).toBe(doomedJobId);
    expect(failures[0]?.kind).toBe("handler-unknown");
    expect(failures[0]?.errorMessage).toContain("simulated Postgres blip");

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.status).not.toBe("pending");
    expect(body.stalledSince).toBeUndefined();
    expect(body.linked).toBe(2);
    expect(body.scored).toBe(1);
    expect(body.permanentlyFailed).toBe(1);
    expect(body.degraded).toBe(true);
    expect(body.scored! + body.permanentlyFailed! + body.cappedForBudget!).toBe(body.linked);
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

describe("the per-search scoring cap (ticket 4f88339 review round 1 F1; per-SEARCH since ticket c9c676d)", () => {
  it("publishes at most DEFAULT_SCORE_THRESHOLD score.job messages for a single source, and the search STILL reaches a terminal state instead of hanging on the jobs it capped", async () => {
    // THE DEFECT THIS PINS. `POST /searches/estimate` prices a run that is
    // both filtered and capped at DEFAULT_SCORE_THRESHOLD; the queue path
    // published a score.job for EVERY job a source returned, so a real
    // search could spend ~30x the number the user consented to (the same
    // arithmetic ticket 59fdc52 review round 2 fixed for the estimate).
    //
    // The second half of this test is the part most likely to be missed,
    // and it is the reason the fix could not simply slice the publish
    // loop: ingestion happens BEFORE the cap, so the capped jobs have real
    // `search_results` rows. A job with a search_results row, no
    // job_matches row and no job_match_failures row is OUTSTANDING to the
    // completion derive — forever, since nothing will ever score or fail
    // it. Capping the publishes without accounting for those jobs would
    // trade a money bug for a search that never completes, which is worse.
    const overCap = DEFAULT_SCORE_THRESHOLD + 3;
    const jobs = Array.from({ length: overCap }, (_, i) =>
      matchingJob(`scorecap-${i}-${randomUUID()}`),
    );
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), jobs),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(jobs) } });
    await rig.runFetch(publisher.published[0]!);
    const scoreJobs = rig.takeScoreJobs();

    // THE BOUND ITSELF: 203 jobs linked, exactly 200 score.job messages.
    expect(scoreJobs).toHaveLength(DEFAULT_SCORE_THRESHOLD);

    // INGESTION IS NOT CAPPED — every job the source returned is linked,
    // exactly as DEFAULT_SCORE_THRESHOLD's own doc comment promises, and
    // the ledger reports the TRUE link count rather than the capped one
    // (the completion derive depends on that number meaning what it says).
    const linked = await db
      .select({ jobId: searchResults.jobId })
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId));
    expect(linked).toHaveLength(overCap);
    const sourceRows = await db
      .select()
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));
    expect(sourceRows[0]?.linkedJobCount).toBe(overCap);

    // The capped remainder is accounted for durably, and it is exactly the
    // jobs that did NOT get a message — not an overlapping set.
    const publishedJobIds = new Set(scoreJobs.map((s) => s.jobId));
    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(failures).toHaveLength(overCap - DEFAULT_SCORE_THRESHOLD);
    expect(failures.every((f) => f.kind === SCORE_THRESHOLD_CAPPED_KIND)).toBe(true);
    expect(failures.some((f) => publishedJobIds.has(f.jobId))).toBe(false);

    // DETERMINISTIC SLICE. The whole file rests on "a redelivery re-runs
    // the same work and writes the same rows" — a cap that picked a
    // different 200 on the second delivery would publish up to 400
    // score.job messages across two attempts and quietly defeat the bound.
    await rig.runFetch(publisher.published[0]!, { "x-attempt": 2 });
    const redelivered = rig.takeScoreJobs();
    expect(redelivered).toHaveLength(DEFAULT_SCORE_THRESHOLD);
    expect(new Set(redelivered.map((s) => s.jobId))).toEqual(publishedJobIds);
    // And the capped-job bookkeeping is idempotent too (ON CONFLICT DO
    // NOTHING), not one extra row per redelivery.
    const failuresAfterRedelivery = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(failuresAfterRedelivery).toHaveLength(overCap - DEFAULT_SCORE_THRESHOLD);

    // THE SEARCH MUST STILL TERMINATE. Score everything that was actually
    // published; nothing will ever arrive for the capped jobs.
    for (const scoreJob of scoreJobs) await rig.runScore(scoreJob);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.status).not.toBe("pending");
    expect(body.scored).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(body.linked).toBe(overCap);

    // THE PRESENTATION SPLIT (ticket c9c676d). This block used to assert
    // `permanentlyFailed === 3` and `degraded === true` — i.e. a run that
    // did exactly what its own estimate priced was reported to the caller
    // as a partially-broken search. Nothing here failed: three jobs were
    // linked past the budget and deliberately never sent for scoring.
    expect(body.permanentlyFailed).toBe(0);
    expect(body.cappedForBudget).toBe(overCap - DEFAULT_SCORE_THRESHOLD);
    expect(body.degraded).toBe(false);
    // The partition still accounts for every linked job; only the names of
    // the buckets changed.
    expect(body.scored! + body.permanentlyFailed! + body.cappedForBudget!).toBe(body.linked);
    expect(body.completedAt).toBeDefined();

    // The durable claim on the search's budget, which is what makes the cap
    // per-SEARCH rather than per-source (see fetchSourceWorker's
    // `adjudicateScoringBudget`).
    const claims = await db
      .select({ published: searchSources.publishedJobCount })
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));
    expect(claims.map((c) => c.published)).toEqual([DEFAULT_SCORE_THRESHOLD]);

    // Durably terminal, not just terminal-on-this-poll.
    const row = await db.select().from(searchesTable).where(eq(searchesTable.id, searchId));
    expect(row[0]?.status).toBe("complete");
    expect(row[0]?.completedAt).not.toBeNull();
  });

  it("THE HEADLINE: three sources sharing one search publish DEFAULT_SCORE_THRESHOLD score.job messages IN TOTAL, not that many EACH", async () => {
    // THE DEFECT THIS PINS, and why the single-source test above could
    // never catch it. Ticket 4f88339's cap was per (search, source) pair,
    // so `POST /searches/estimate` showed one 200-job number while a real
    // search across N sources could authorize N x 200. With the five
    // adapters `sources/registry.ts` ships that is 1,000 scored jobs —
    // ~$22 at the rate the 2026-09-23 live smoke test measured, against a
    // ~$4.40 estimate, and 1.5x the ENTIRE $15 lifetime-per-process
    // ScoringSpendGuard, so one broad search could drain the scoring worker
    // for every later search until an operator restarted it.
    //
    // Deliberately sized so NO SINGLE SOURCE EVER HITS ITS OWN OLD CAP:
    // three sources at 80 jobs each is 240 against a 200-job estimate while
    // every one of them sits at 40% of 200. That is the shape the old
    // "filtering shrank the pool, so the per-source cap rarely binds now"
    // argument could not see, because the overrun never needed the
    // per-source cap to bind at all.
    const perSource = 80;
    const sourceIds = ["usajobs", "greenhouse", "lever"] as const;
    expect(perSource * sourceIds.length).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
    expect(perSource).toBeLessThan(DEFAULT_SCORE_THRESHOLD);

    const run = randomUUID();
    const jobsBySource = Object.fromEntries(
      sourceIds.map((id) => [
        id,
        Array.from({ length: perSource }, (_, i) => matchingJob(`persearch-${id}-${i}-${run}`, id)),
      ]),
    ) as Record<string, NormalizedJob[]>;

    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource(jobsBySource),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [...sourceIds], criteria: {} },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };
    expect(publisher.published).toHaveLength(sourceIds.length);

    const rig = makeQueueRig({
      sources: Object.fromEntries(
        sourceIds.map((id) => [id, new FakeSource(jobsBySource[id]!, id)]),
      ),
    });
    for (const message of publisher.published) await rig.runFetch(message);
    const scoreJobs = rig.takeScoreJobs();

    // THE BOUND: 240 jobs linked across three sources, exactly 200
    // `score.job` messages total. Under the per-source cap this was 240.
    expect(scoreJobs).toHaveLength(DEFAULT_SCORE_THRESHOLD);
    expect(new Set(scoreJobs.map((s) => s.jobId)).size).toBe(DEFAULT_SCORE_THRESHOLD);

    // INGESTION IS STILL UNCAPPED. The cap bounds SPENDING, never coverage:
    // every job every source returned is linked and queryable, exactly as
    // DEFAULT_SCORE_THRESHOLD's own doc comment promises.
    const linked = await db
      .select({ jobId: searchResults.jobId })
      .from(searchResults)
      .where(eq(searchResults.searchId, searchId));
    expect(linked).toHaveLength(perSource * sourceIds.length);

    // The claims ledger sums to the budget and no further — this is the
    // invariant `adjudicateScoringBudget` maintains, read straight out of
    // Postgres rather than inferred from the message count.
    const claims = await db
      .select({
        sourceId: searchSources.sourceDescriptorId,
        published: searchSources.publishedJobCount,
        linkedJobCount: searchSources.linkedJobCount,
      })
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));
    expect(claims).toHaveLength(sourceIds.length);
    expect(claims.reduce((sum, c) => sum + (c.published ?? 0), 0)).toBe(DEFAULT_SCORE_THRESHOLD);
    // First-come-first-served, not an even split: the first two sources
    // take 80 each and the third gets the remaining 40. Asserted because it
    // is a deliberate design choice (an even N-way split would starve a
    // source that legitimately found 3 jobs), not an accident.
    expect(claims.map((c) => c.published).sort((a, b) => (b ?? 0) - (a ?? 0))).toEqual([
      80, 80, 40,
    ]);
    // `linked_job_count` keeps meaning what it says — the TRUE number of
    // jobs that source linked — and is NOT reduced to the published count.
    expect(claims.every((c) => c.linkedJobCount === perSource)).toBe(true);

    // AND THE SEARCH STILL TERMINATES. The 40 jobs the budget refused have
    // `job_match_failures` rows, so the completion derive does not wait on
    // them forever.
    for (const scoreJob of scoreJobs) await rig.runScore(scoreJob);
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.scored).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(body.cappedForBudget).toBe(perSource * sourceIds.length - DEFAULT_SCORE_THRESHOLD);
    expect(body.permanentlyFailed).toBe(0);
    expect(body.degraded).toBe(false);
  });

  it("a redelivery whose siblings have since spent the budget republishes its OWN prefix rather than un-publishing jobs already in flight", async () => {
    // THE DEFECT THIS PINS, which only exists because the cap became
    // per-search. Source A adjudicates first and claims the whole budget.
    // A NAIVE re-adjudication of A's redelivered message would recompute
    // "200 minus what my siblings hold" — and if a sibling has since
    // claimed anything, A's allowance SHRINKS, so A writes capped rows for
    // jobs it already published and that are already being scored. That
    // both misreports them and lets the set of jobs a search ever sent for
    // scoring drift above the budget over its lifetime. `max(previousClaim,
    // remaining)` in adjudicateScoringBudget is what prevents it; this test
    // is what would fail if someone "simplified" that max away.
    const run = randomUUID();
    const aJobs = Array.from({ length: DEFAULT_SCORE_THRESHOLD }, (_, i) =>
      matchingJob(`mono-a-${i}-${run}`, "usajobs"),
    );
    const bJobs = Array.from({ length: 10 }, (_, i) => matchingJob(`mono-b-${i}-${run}`, "lever"));

    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({ usajobs: aJobs, lever: bJobs }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["usajobs", "lever"], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    const aMessage = publisher.published.find((m) => m.sourceId === "usajobs")!;
    const bMessage = publisher.published.find((m) => m.sourceId === "lever")!;

    const rig = makeQueueRig({
      sources: { usajobs: new FakeSource(aJobs, "usajobs"), lever: new FakeSource(bJobs, "lever") },
    });

    await rig.runFetch(aMessage);
    const firstPublish = new Set(rig.takeScoreJobs().map((s) => s.jobId));
    expect(firstPublish.size).toBe(DEFAULT_SCORE_THRESHOLD);

    // B finds the budget gone and caps all ten of its own jobs.
    await rig.runFetch(bMessage);
    expect(rig.takeScoreJobs()).toHaveLength(0);

    // Now A is redelivered (attempt 2). Its own claim is already 200, so it
    // republishes exactly the same 200 and writes NO capped rows of its own.
    await rig.runFetch(aMessage, { "x-attempt": 2 });
    const republished = rig.takeScoreJobs();
    expect(republished).toHaveLength(DEFAULT_SCORE_THRESHOLD);
    expect(new Set(republished.map((s) => s.jobId))).toEqual(firstPublish);

    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    // Exactly B's ten, and not one of A's already-in-flight jobs.
    expect(failures).toHaveLength(bJobs.length);
    expect(failures.every((f) => f.kind === SCORE_THRESHOLD_CAPPED_KIND)).toBe(true);
    expect(failures.some((f) => firstPublish.has(f.jobId))).toBe(false);

    const claims = await db
      .select({
        sourceId: searchSources.sourceDescriptorId,
        published: searchSources.publishedJobCount,
      })
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));
    expect(claims.reduce((sum, c) => sum + (c.published ?? 0), 0)).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(claims.find((c) => c.sourceId === "lever")?.published).toBe(0);
  });

  it("five sources of one search adjudicating CONCURRENTLY still publish DEFAULT_SCORE_THRESHOLD in total (the advisory lock serializes; it does not merely narrow the window)", async () => {
    // Same reasoning as the in-flight guard's concurrency tests below, one
    // layer down. The budget check is a read of every sibling's claim and
    // then a write of this source's own, with real `await`s in between: two
    // fetch workers that both read before either writes would both see an
    // untouched budget and both take it. A POOL is mandatory —
    // `pg_advisory_xact_lock` is re-entrant within one session, so on this
    // file's shared single `pg.Client` a broken guard and a correct one are
    // indistinguishable.
    //
    // FIVE sources, not two, and equal job counts on purpose. Verified by
    // running this test against a build with the `pg_advisory_xact_lock`
    // line replaced by a no-op query (2026-09-23): two equal sources still
    // came out 180/20 — correct by scheduling luck, because the read-to-
    // write window is only a few round trips wide and two handlers stagger
    // naturally. At five, the unlocked build overruns every time. This is
    // the count at which the test actually tests something.
    const sourceIds = ["usajobs", "greenhouse", "lever", "ashby", "smartrecruiters"] as const;
    const pooled = createPooledTestDatabase(testDb.testDbName, 12);
    try {
      const run = randomUUID();
      const perSource = 60;
      expect(perSource * sourceIds.length).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
      const jobsBySource = Object.fromEntries(
        sourceIds.map((id) => [
          id,
          Array.from({ length: perSource }, (_, i) => matchingJob(`conc-${id}-${i}-${run}`, id)),
        ]),
      ) as Record<string, NormalizedJob[]>;

      const publisher = fakePublisher();
      const app = buildApp({
        db: pooled.db,
        inferTitles: async () => [],
        getScoreJob: makeFakeScorer,
        resolveSourceIds: fakeResolverPerSource(jobsBySource),
        publishFetchSource: publisher.publish,
      });
      const resumeId = await createResume(app);
      const started = await app.inject({
        method: "POST",
        url: "/searches",
        payload: { resumeId, sourceIds: [...sourceIds], criteria: {} },
      });
      expect(started.statusCode).toBe(202);
      const { searchId } = started.json() as { searchId: string };
      expect(publisher.published).toHaveLength(sourceIds.length);

      const rig = makeQueueRig({
        db: pooled.db,
        sources: Object.fromEntries(
          sourceIds.map((id) => [id, new FakeSource(jobsBySource[id]!, id)]),
        ),
      });

      // Genuinely in flight at once, interleaving at every await.
      await Promise.all(publisher.published.map((message) => rig.runFetch(message)));

      const scoreJobs = rig.takeScoreJobs();
      expect(scoreJobs).toHaveLength(DEFAULT_SCORE_THRESHOLD);
      expect(new Set(scoreJobs.map((s) => s.jobId)).size).toBe(DEFAULT_SCORE_THRESHOLD);

      const claims = await pooled.db
        .select({ published: searchSources.publishedJobCount })
        .from(searchSources)
        .where(eq(searchSources.searchId, searchId));
      expect(claims.reduce((sum, c) => sum + (c.published ?? 0), 0)).toBe(DEFAULT_SCORE_THRESHOLD);

      const failures = await pooled.db
        .select()
        .from(jobMatchFailures)
        .where(eq(jobMatchFailures.resumeId, resumeId));
      expect(failures).toHaveLength(perSource * sourceIds.length - DEFAULT_SCORE_THRESHOLD);
      expect(failures.every((f) => f.kind === SCORE_THRESHOLD_CAPPED_KIND)).toBe(true);
    } finally {
      await pooled.close();
    }
  });
});

describe("capped-for-budget vs genuine scoring failure in GET /searches/:id (ticket c9c676d)", () => {
  it("reports the two separately, keeps `degraded` for the genuine failure only, and still partitions `linked`", async () => {
    // THE DEFECT THIS PINS. `job_match_failures` rows are written for two
    // unrelated reasons and `deriveSearchState` counted them together, so a
    // search that merely hit its own cost cap read EXACTLY like one whose
    // API key had expired: same `permanentlyFailed` number, same
    // `degraded: true`. The `kind` column has carried the distinction
    // durably since ticket 4f88339; this is the test that it finally
    // reaches the caller.
    //
    // One search, both causes at once, which is the case a test with only
    // one cause cannot distinguish: 3 jobs over the budget (capped) AND one
    // job inside it whose scoring genuinely blows up (dead-lettered).
    const run = randomUUID();
    const overCap = DEFAULT_SCORE_THRESHOLD + 3;
    const jobs = Array.from({ length: overCap }, (_, i) => matchingJob(`mixed-${i}-${run}`));
    // Inside the budget, so it really is ATTEMPTED and really does fail —
    // as opposed to the tail, which is never attempted at all.
    const doomed = jobs[0]!;

    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), jobs),
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
      sources: { [DATA_SOURCE]: new FakeSource(jobs) },
      // 1: the first failure is already the last attempt, so the
      // dead-letter is deterministic and needs no waiting.
      scoreMaxAttempts: 1,
      scoreJob: async (job) => {
        if (job.externalId === doomed.externalId) throw new Error("simulated sustained outage");
        return { matchScore: 70, rationale: "ok", strengths: [], gaps: [] };
      },
    });
    await rig.runFetch(publisher.published[0]!);
    for (const scoreJob of rig.takeScoreJobs()) await rig.runScore(scoreJob);

    // The database really does hold both kinds — if it did not, the split
    // below would be asserting nothing.
    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    const kinds = failures.map((f) => f.kind).sort();
    expect(kinds.filter((k) => k === SCORE_THRESHOLD_CAPPED_KIND)).toHaveLength(3);
    expect(kinds.filter((k) => k !== SCORE_THRESHOLD_CAPPED_KIND)).toEqual(["unknown"]);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.linked).toBe(overCap);
    expect(body.scored).toBe(DEFAULT_SCORE_THRESHOLD - 1);
    // THE SPLIT. One genuine failure, three jobs the budget refused, and
    // they are not the same number in the response any more.
    expect(body.permanentlyFailed).toBe(1);
    expect(body.cappedForBudget).toBe(3);
    // The partition is still total: nothing fell out of the accounting.
    expect(body.scored! + body.permanentlyFailed! + body.cappedForBudget!).toBe(body.linked);
    // `degraded` tracks the genuine failure — which is present here, so it
    // is true. The companion assertion (capped-only => false) is in the
    // single-source cap test above; together they pin that `degraded`
    // follows `permanentlyFailed` and not the total.
    expect(body.degraded).toBe(true);
  });

  it("reports the split mid-flight too, not only on the terminal member", async () => {
    // The `pending` member carries `permanentlyFailed` as well, and one
    // number must not mean two different things in two members of the same
    // union. The budget is adjudicated as each source lands, so a poll
    // taken while a search is still running can already see capped jobs.
    const run = randomUUID();
    const overCap = DEFAULT_SCORE_THRESHOLD + 5;
    const usaJobs = Array.from({ length: overCap }, (_, i) =>
      matchingJob(`midflight-${i}-${run}`, "usajobs"),
    );
    const leverJobs = [matchingJob(`midflight-lever-${run}`, "lever")];

    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolverPerSource({ usajobs: usaJobs, lever: leverJobs }),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: ["usajobs", "lever"], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({
      sources: {
        usajobs: new FakeSource(usaJobs, "usajobs"),
        lever: new FakeSource(leverJobs, "lever"),
      },
    });
    // Only the FIRST source runs: the search is genuinely still pending on
    // the second, and nothing has been scored yet.
    await rig.runFetch(publisher.published.find((m) => m.sourceId === "usajobs")!);

    const body = await getStatus(app, searchId);
    expect(body.status).toBe("pending");
    expect(body.sourcesSettled).toBe(false);
    expect(body.scoredSoFar).toBe(0);
    expect(body.permanentlyFailed).toBe(0);
    expect(body.cappedForBudget).toBe(overCap - DEFAULT_SCORE_THRESHOLD);
  });
});

// ---------------------------------------------------------------------------
// `job_match_failures` IS SCOPED TO ITS SEARCH (ticket 9a53485).
//
// THE DEFECT THESE PIN, and the exact scenario opus's review of ticket
// c9c676d reproduced: the table was keyed by (resume_id, job_id) only, so a
// row written by one search spoke for every LATER search of the same resume.
// `deriveSearchState` counts a linked job as outstanding only while it has
// neither a `job_matches` nor a `job_match_failures` row — so a job search A
// had capped (or permanently failed) was already non-outstanding in search
// B, even though B had just published its own fresh `score.job` for it. B
// could therefore latch terminal BEFORE its own scoring attempt resolved,
// reporting a `cappedForBudget`/`permanentlyFailed` it never incurred
// ({scored: 0, cappedForBudget: 3, linked: 3} on a search that capped
// nothing).
//
// Both tests below run the real route, the real workers and the real derive
// twice over ONE resume, and the load-bearing assertion in each is the
// MID-FLIGHT poll of the second search: `pending`, with zero inherited
// failures. Before migration 0013 that poll returned a terminal member.
// ---------------------------------------------------------------------------

describe("job_match_failures is scoped to the search that wrote it (ticket 9a53485)", () => {
  it("a job CAPPED in one search gets a genuine fresh attempt in a later search for the same resume", async () => {
    const run = randomUUID();
    const overCap = DEFAULT_SCORE_THRESHOLD + 3;
    const board = Array.from({ length: overCap }, (_, i) => matchingJob(`scope-cap-${i}-${run}`));
    // The three the per-search cap refuses — deterministic, because
    // `ingestJobsForSearch` preserves board order (see fetchSourceWorker's
    // "WHY THE SLICE IS DETERMINISTIC" note).
    const tail = board.slice(DEFAULT_SCORE_THRESHOLD);

    // --- SEARCH 1: over the cap, so `tail` gets capped rows and nothing else.
    const publisher1 = fakePublisher();
    const app1 = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher1.publish,
    });
    const resumeId = await createResume(app1);
    const first = await app1.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(first.statusCode).toBe(202);
    const { searchId: searchId1 } = first.json() as { searchId: string };

    const rig1 = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig1.drain(publisher1.published);

    // Search 1 really did cap exactly the tail, and is terminal — which is
    // also what lets the second POST through the in-flight guard below.
    const firstBody = await getStatus(app1, searchId1);
    expect(firstBody.status).toBe("complete");
    expect(firstBody.scored).toBe(DEFAULT_SCORE_THRESHOLD);
    expect(firstBody.cappedForBudget).toBe(3);

    const capped = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(capped).toHaveLength(3);
    expect(capped.every((f) => f.kind === SCORE_THRESHOLD_CAPPED_KIND)).toBe(true);
    // The rows name the search that wrote them. This is the column the
    // whole fix hangs on; before it there was nothing here to assert.
    expect(capped.every((f) => f.searchId === searchId1)).toBe(true);

    // --- SEARCH 2: same resume, a board of ONLY the three jobs search 1
    // capped, so it is nowhere near its own (fresh, per-search) budget.
    const publisher2 = fakePublisher();
    const app2 = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), tail),
      publishFetchSource: publisher2.publish,
    });
    const second = await app2.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(second.statusCode).toBe(202);
    const { searchId: searchId2 } = second.json() as { searchId: string };
    expect(searchId2).not.toBe(searchId1);

    const rig2 = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(tail) } });
    await rig2.runFetch(publisher2.published[0]!);

    // A fresh attempt was genuinely published for all three — the old row
    // never gated scoring, so this part was never broken. What was broken
    // is that the derive stopped waiting for these messages' results.
    const scoreJobs = rig2.takeScoreJobs();
    expect(scoreJobs).toHaveLength(3);

    // THE REGRESSION. Polled after the fetch and BEFORE any of those three
    // score.job messages is handled, search 2 is still genuinely pending on
    // all three. Keyed by (resume, job), this poll returned `complete` with
    // cappedForBudget: 3 and scored: 0 — search 1's verdict, on a search
    // that had capped nothing and was still waiting on its own scores.
    const midFlight = await getStatus(app2, searchId2);
    expect(midFlight.status).toBe("pending");
    expect(midFlight.linked).toBe(3);
    expect(midFlight.scoredSoFar).toBe(0);
    expect(midFlight.cappedForBudget).toBe(0);
    expect(midFlight.permanentlyFailed).toBe(0);

    for (const scoreJob of scoreJobs) await rig2.runScore(scoreJob);

    const secondBody = await getStatus(app2, searchId2);
    expect(secondBody.status).toBe("complete");
    expect(secondBody.scored).toBe(3);
    expect(secondBody.cappedForBudget).toBe(0);
    expect(secondBody.permanentlyFailed).toBe(0);
    expect(secondBody.degraded).toBe(false);

    // Scoping took nothing away from search 1: its three rows are still
    // there, still its own, and search 2 wrote none of its own.
    const afterBySearch = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(afterBySearch.filter((f) => f.searchId === searchId1)).toHaveLength(3);
    expect(afterBySearch.filter((f) => f.searchId === searchId2)).toHaveLength(0);
  });

  it("a job whose scoring PERMANENTLY FAILED in one search gets a fresh attempt in a later search for the same resume", async () => {
    // The other half of the ticket's scenario: the row `scoreJobWorker`
    // writes on a dead-letter, rather than the one `fetchSourceWorker`
    // writes for the cap. Same table, same defect, different writer — and
    // this is the more damaging one, because a transient outage during
    // search 1 would permanently suppress the job for every later search
    // even after the outage was over.
    const run = randomUUID();
    const job = matchingJob(`scope-fail-${run}`);

    const publisher1 = fakePublisher();
    const app1 = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher1.publish,
    });
    const resumeId = await createResume(app1);
    const first = await app1.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId: searchId1 } = first.json() as { searchId: string };

    const rig1 = makeQueueRig({
      sources: { [DATA_SOURCE]: new FakeSource([job]) },
      // 1: the first failure is already the last attempt, so the
      // dead-letter (and its failure row) is deterministic.
      scoreMaxAttempts: 1,
      scoreJob: async () => {
        throw new Error("simulated sustained outage");
      },
    });
    await rig1.drain(publisher1.published);

    // The search's only job could not be scored at all, which is the
    // `failed` terminal member — and it is terminal, so the guard lets the
    // second POST through.
    const firstBody = await getStatus(app1, searchId1);
    expect(firstBody.status).toBe("failed");

    const failures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).not.toBe(SCORE_THRESHOLD_CAPPED_KIND);
    expect(failures[0]!.searchId).toBe(searchId1);

    // --- SEARCH 2: same resume, same job, and this time the scorer works.
    const publisher2 = fakePublisher();
    const app2 = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [job]),
      publishFetchSource: publisher2.publish,
    });
    const second = await app2.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    expect(second.statusCode).toBe(202);
    const { searchId: searchId2 } = second.json() as { searchId: string };

    const rig2 = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource([job]) } });
    await rig2.runFetch(publisher2.published[0]!);
    const scoreJobs = rig2.takeScoreJobs();
    expect(scoreJobs).toHaveLength(1);

    // THE REGRESSION. Keyed by (resume, job), this poll inherited search
    // 1's dead-letter: permanentlyFailed 1, terminal, degraded — decided
    // before search 2's own score.job had been handled at all.
    const midFlight = await getStatus(app2, searchId2);
    expect(midFlight.status).toBe("pending");
    expect(midFlight.linked).toBe(1);
    expect(midFlight.permanentlyFailed).toBe(0);
    expect(midFlight.cappedForBudget).toBe(0);

    for (const scoreJob of scoreJobs) await rig2.runScore(scoreJob);

    const secondBody = await getStatus(app2, searchId2);
    expect(secondBody.status).toBe("complete");
    expect(secondBody.scored).toBe(1);
    expect(secondBody.permanentlyFailed).toBe(0);
    expect(secondBody.degraded).toBe(false);

    // Still exactly one failure row, still search 1's. The fresh attempt
    // wrote a `job_matches` row instead, which is what makes the outcome
    // genuinely different rather than merely re-labelled.
    const afterFailures = await db
      .select()
      .from(jobMatchFailures)
      .where(eq(jobMatchFailures.resumeId, resumeId));
    expect(afterFailures).toHaveLength(1);
    expect(afterFailures[0]!.searchId).toBe(searchId1);
  });
});

describe("the in-flight guard under REAL concurrency (ticket 4f88339 review round 1, F2)", () => {
  it("two genuinely concurrent POSTs for the same resume: exactly one 202, one 409, one searches row, one fan-out", async () => {
    // THE DEFECT THIS PINS, and why the existing sequential in-flight test
    // could not catch it: the guard was a SELECT and then, later, a
    // separate INSERT. Two requests that both run the SELECT before either
    // runs its INSERT both see no live search, both get 202, both write a
    // `searches` row and both fan out a full set of fetch.source messages
    // — double the spend the caller authorized. The review reproduced
    // exactly this against a live buildApp. Awaiting the two POSTs one
    // after the other, as every other test in this file does, never
    // overlaps the two windows and always passes, fix or no fix.
    //
    // TWO THINGS MAKE THIS TEST REAL RATHER THAN THEATRICAL:
    //   1. `Promise.all`, so both handlers are genuinely in flight at once
    //      and interleave at every `await`.
    //   2. A POOL-backed db, not this file's shared single `pg.Client`.
    //      One client is one session: it cannot hold two transactions at
    //      once, and pg_advisory_xact_lock is re-entrant within a session,
    //      so on a single client a broken guard and a correct one are
    //      indistinguishable. Production runs on a Pool (index.ts); so
    //      does this test. (Verified against the pre-fix code on this same
    //      rig: both requests returned 202 and two `searches` rows
    //      existed.)
    const pooled = createPooledTestDatabase(testDb.testDbName);
    try {
      const publisher = fakePublisher();
      const app = buildApp({
        db: pooled.db,
        inferTitles: async () => [],
        getScoreJob: makeFakeScorer,
        resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
          matchingJob(`concurrent-${randomUUID()}`),
        ]),
        publishFetchSource: publisher.publish,
      });
      const resumeId = await createResume(app);

      const payload = { resumeId, sourceIds: [DATA_SOURCE], criteria: {} };
      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: "/searches", payload }),
        app.inject({ method: "POST", url: "/searches", payload }),
      ]);

      expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);

      const winner = first.statusCode === 202 ? first : second;
      const loser = first.statusCode === 202 ? second : first;
      const { searchId: winningSearchId } = winner.json() as { searchId: string };

      // The refusal points at the search that actually won, so the caller
      // can go poll it — the same contract the sequential 409 has.
      expect((loser.json() as { searchId: string }).searchId).toBe(winningSearchId);

      // EXACTLY ONE search row, and EXACTLY ONE fan-out. These are the two
      // assertions that catch the real harm: a duplicated `searches` row is
      // a duplicated set of fetch.source messages, which is duplicated
      // fetching and duplicated scoring spend.
      const rows = await db
        .select({ id: searchesTable.id })
        .from(searchesTable)
        .where(eq(searchesTable.resumeId, resumeId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(winningSearchId);
      expect(publisher.published).toHaveLength(1);
      expect(publisher.published[0]?.searchId).toBe(winningSearchId);

      // The loser left nothing behind: no orphan search_sources rows from a
      // transaction that rolled back or half-committed.
      const sourceRows = await db
        .select()
        .from(searchSources)
        .where(eq(searchSources.searchId, winningSearchId));
      expect(sourceRows).toHaveLength(1);
    } finally {
      await pooled.close();
    }
  });

  it("five concurrent POSTs for the same resume still produce exactly one search (the lock serializes, it does not merely narrow the window)", async () => {
    // A two-request test can pass by luck on a guard that only shrank the
    // race window. Five requests against a pool whose size exceeds them
    // means four of them are genuinely blocked on the advisory lock at
    // once — which is also the shape that would expose the pool-starvation
    // deadlock the route's comment warns about, if anything inside that
    // transaction ever reached for a second connection.
    const pooled = createPooledTestDatabase(testDb.testDbName, 10);
    try {
      const publisher = fakePublisher();
      const app = buildApp({
        db: pooled.db,
        inferTitles: async () => [],
        getScoreJob: makeFakeScorer,
        resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), [
          matchingJob(`concurrent5-${randomUUID()}`),
        ]),
        publishFetchSource: publisher.publish,
      });
      const resumeId = await createResume(app);

      const payload = { resumeId, sourceIds: [DATA_SOURCE], criteria: {} };
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => app.inject({ method: "POST", url: "/searches", payload })),
      );

      const accepted = responses.filter((r) => r.statusCode === 202);
      const refused = responses.filter((r) => r.statusCode === 409);
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(4);

      const rows = await db
        .select({ id: searchesTable.id })
        .from(searchesTable)
        .where(eq(searchesTable.resumeId, resumeId));
      expect(rows).toHaveLength(1);
      expect(publisher.published).toHaveLength(1);
      const { searchId } = accepted[0]!.json() as { searchId: string };
      for (const response of refused) {
        expect((response.json() as { searchId: string }).searchId).toBe(searchId);
      }
    } finally {
      await pooled.close();
    }
  });
});

// ---------------------------------------------------------------------------
// THE QUALITY FILTER ON THE QUEUE PATH (ticket 45ea34c).
//
// The defect these pin, confirmed live 2026-09-23: a real search for
// titleInclude ["Staff Software Engineer"] / nearLocations ["Seattle, WA"]
// — which `POST /searches/estimate` correctly priced at 1 job — ran through
// the queue and ignored that criteria completely, linking all 6,418
// Greenhouse postings and scoring the first 200 IN RAW BOARD ORDER (Account
// Executive, sales, ...). The criteria never reached the worker: the
// `fetch.source` message carried only `buildFetchCriteria`'s narrowed
// title-keyword hint for the adapter's own query.
//
// `compileFilter` itself is unit-tested in sources/criteria.test.ts, and the
// CLI default's regexes in matching/swe-filter.test.ts. These are
// deliberately NOT that: they drive the real route, the real publisher
// payload, and the real `fetchSourceWorker` handler over a source returning
// a MIX of matching and non-matching postings, with the matching ones LAST
// in board order so a "first N in whatever the board returned" regression
// cannot pass.
// ---------------------------------------------------------------------------

/** Board order for the headline test: three postings that miss the criteria
 * for three different reasons, then the two that actually match. Distinct
 * companies throughout, so `compileFilter`'s `company|title` dedupe never
 * gets to explain a result on its own. */
function mixedBoard(suffix: string): NormalizedJob[] {
  return [
    // Right city, wrong role — the exact shape the live run scored 200 of.
    fakeJob(`qf-miss-title-${suffix}`, "Account Executive, Commercial", {
      company: "Sales Co",
      location: "Seattle, WA",
      locationType: "onsite",
    }),
    // Right role, wrong city — and `remoteOk: false`, so nothing rescues it.
    fakeJob(`qf-miss-location-${suffix}`, "Staff Software Engineer", {
      company: "Austin Co",
      location: "Austin, TX",
      locationType: "onsite",
    }),
    // Wrong on both counts, and remote — proving `remoteOk: false` really
    // does mean "a confirmed-remote posting is not automatically in".
    fakeJob(`qf-miss-both-${suffix}`, "Accountant II", {
      company: "Books Co",
      location: "Remote - US",
      locationType: "remote",
    }),
    fakeJob(`qf-hit-exact-${suffix}`, "Staff Software Engineer", {
      company: "Hit Co One",
      location: "Seattle, WA",
      locationType: "onsite",
    }),
    // Title match by word-boundary substring, location match inside a
    // longer string — both are things `compileFilter` is supposed to allow.
    fakeJob(`qf-hit-suffixed-${suffix}`, "Staff Software Engineer, Platform", {
      company: "Hit Co Two",
      location: "Seattle, WA (hybrid)",
      locationType: "hybrid",
    }),
  ];
}

const NARROW_CRITERIA = {
  titleInclude: ["Staff Software Engineer"],
  nearLocations: ["Seattle, WA"],
  remoteOk: false,
};

describe("the quality filter on the queue path (ticket 45ea34c)", () => {
  async function linkedExternalIds(searchId: string): Promise<string[]> {
    const rows = await db
      .select({ externalId: jobsTable.externalId })
      .from(searchResults)
      .innerJoin(jobsTable, eq(searchResults.jobId, jobsTable.id))
      .where(eq(searchResults.searchId, searchId));
    return rows.map((r) => r.externalId).sort();
  }

  it("a narrow search links and scores ONLY the postings matching its criteria, not the ones the board happened to return first", async () => {
    const suffix = randomUUID();
    const board = mixedBoard(suffix);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: NARROW_CRITERIA },
    });
    expect(started.statusCode).toBe(202);
    const { searchId } = started.json() as { searchId: string };

    // 1. The criteria are ON THE WIRE, whole — not reduced to the adapter's
    //    title-keyword hint, which is what left the worker with nothing to
    //    filter on.
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0]?.filterCriteria).toEqual(NARROW_CRITERIA);
    expect(publisher.published[0]?.criteria).toEqual({
      keywords: ["Staff Software Engineer"],
    });

    // 2. The worker applies them BEFORE ingesting: the three misses never
    //    become `search_results` rows at all, mirroring the CLI path.
    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig.runFetch(publisher.published[0]!);

    expect(await linkedExternalIds(searchId)).toEqual([
      `qf-hit-exact-${suffix}`,
      `qf-hit-suffixed-${suffix}`,
    ]);

    // 3. And only those two are paid to be scored.
    const scoreJobs = rig.takeScoreJobs();
    expect(scoreJobs).toHaveLength(2);

    // 4. The ledger agrees — `linkedJobCount` counts matches, not the board.
    const sourceRows = await db
      .select()
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));
    expect(sourceRows[0]?.status).toBe("complete");
    expect(sourceRows[0]?.linkedJobCount).toBe(2);

    for (const scoreJob of scoreJobs) await rig.runScore(scoreJob);
    const body = await getStatus(app, searchId);
    expect(body.status).toBe("complete");
    expect(body.linked).toBe(2);
    expect(body.scored).toBe(2);
    expect(body.degraded).toBe(false);

    const results = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    expect((results.json() as { results: unknown[] }).results).toHaveLength(2);
  });

  it("the queue path keeps exactly the postings POST /searches/estimate priced — the acceptance criterion, asserted as an equality between the two routes", async () => {
    // The live defect was precisely a disagreement between these two: the
    // estimate said 1 job, the run scored 200. Separate resumes so the
    // in-flight guard never sees the two runs as one.
    const suffix = randomUUID();
    const board = mixedBoard(suffix);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });

    const estimateResumeId = await createResume(app);
    const estimate = await app.inject({
      method: "POST",
      url: "/searches/estimate",
      payload: {
        resumeId: estimateResumeId,
        sourceIds: [DATA_SOURCE],
        criteria: NARROW_CRITERIA,
      },
    });
    const estimateBody = estimate.json() as {
      candidatesNeedingScore: number;
      costEstimate: { jobCount: number };
    };
    expect(estimateBody.candidatesNeedingScore).toBe(2);
    expect(estimateBody.costEstimate.jobCount).toBe(2);

    const runResumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId: runResumeId, sourceIds: [DATA_SOURCE], criteria: NARROW_CRITERIA },
    });
    const { searchId } = started.json() as { searchId: string };

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig.runFetch(publisher.published[0]!);

    const linked = await linkedExternalIds(searchId);
    expect(linked).toHaveLength(estimateBody.candidatesNeedingScore);
    expect(rig.takeScoreJobs()).toHaveLength(estimateBody.costEstimate.jobCount);
  });

  it("no `criteria` in the request body travels as an explicit null and applies the CLI DEFAULT filter, exactly as the estimate does", async () => {
    // The `null`-not-omitted half of the wire format: `JSON.stringify`
    // drops an undefined-valued key, so "the caller supplied no criteria"
    // has to be spelled out or it is indistinguishable from a message
    // published before the field existed.
    const suffix = randomUUID();
    const board = [
      fakeJob(`qf-default-miss-${suffix}`, "Account Executive", {
        company: "Sales Co",
        location: "Seattle, WA",
        locationType: "onsite",
      }),
      matchingJob(`qf-default-hit-${suffix}`),
    ];
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE] },
    });
    const { searchId } = started.json() as { searchId: string };

    expect(publisher.published[0]?.filterCriteria).toBeNull();
    expect("filterCriteria" in (publisher.published[0] ?? {})).toBe(true);

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig.runFetch(publisher.published[0]!);

    expect(await linkedExternalIds(searchId)).toEqual([`qf-default-hit-${suffix}`]);
    expect(rig.takeScoreJobs()).toHaveLength(1);
  });

  it("an explicit empty `{}` still means 'filter nothing' on the queue path too — a non-engineering posting is linked and scored", async () => {
    // The third arm of the three-way state, and the one every other test in
    // this file leans on: `{}` is a real criteria object that restricts
    // nothing, NOT a synonym for the CLI default.
    const suffix = randomUUID();
    const board = [
      fakeJob(`qf-optout-${suffix}`, "Account Executive", {
        company: "Sales Co",
        location: "Seattle, WA",
        locationType: "onsite",
      }),
    ];
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: {} },
    });
    const { searchId } = started.json() as { searchId: string };
    expect(publisher.published[0]?.filterCriteria).toEqual({});

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig.runFetch(publisher.published[0]!);

    expect(await linkedExternalIds(searchId)).toEqual([`qf-optout-${suffix}`]);
    expect(rig.takeScoreJobs()).toHaveLength(1);
  });

  it("a message with NO filterCriteria field at all is processed unfiltered AND says so loudly, rather than silently inventing a filter or dead-lettering valid work", async () => {
    // Backward compatibility with anything that published a `fetch.source`
    // message before this field existed. The two tempting alternatives are
    // both worse: applying the CLI default would change what an old message
    // means without anyone asking, and rejecting it would dead-letter work
    // that is otherwise perfectly valid.
    const suffix = randomUUID();
    const board = mixedBoard(suffix);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);

    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: NARROW_CRITERIA },
    });
    const { searchId } = started.json() as { searchId: string };

    // Strip the field back off, reproducing a pre-45ea34c publisher.
    const { filterCriteria: _dropped, ...legacyMessage } = publisher.published[0]!;
    expect("filterCriteria" in legacyMessage).toBe(false);

    const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
    await rig.runFetch(legacyMessage);

    // Unfiltered: all five postings, including the three the criteria on
    // the ORIGINAL message would have rejected.
    expect(await linkedExternalIds(searchId)).toHaveLength(board.length);
    expect(rig.takeScoreJobs()).toHaveLength(board.length);
    expect(rig.logs.some((line) => line.includes("NO FILTER CRITERIA ON MESSAGE"))).toBe(true);
  });

  it("a malformed filterCriteria dead-letters as an invalid message instead of throwing out of the handler", async () => {
    // `compileFilter` would otherwise reach `.map` on a non-array or
    // `.replace` on a number and throw something `classify()` files under
    // "unknown" — i.e. RETRYABLE — so a permanently-broken body would burn
    // every retry tier before dead-lettering, on every redelivery.
    const suffix = randomUUID();
    const board = mixedBoard(suffix);
    const publisher = fakePublisher();
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: makeFakeScorer,
      resolveSourceIds: fakeResolver(new Set([DATA_SOURCE]), board),
      publishFetchSource: publisher.publish,
    });
    const resumeId = await createResume(app);
    const started = await app.inject({
      method: "POST",
      url: "/searches",
      payload: { resumeId, sourceIds: [DATA_SOURCE], criteria: NARROW_CRITERIA },
    });
    const { searchId } = started.json() as { searchId: string };
    const good = publisher.published[0]!;

    const malformed = [
      "not an object at all",
      { titleInclude: "software engineer" },
      { remoteOk: "yes" },
      { commitmentIn: ["fulltime"] },
    ];

    for (const filterCriteria of malformed) {
      const rig = makeQueueRig({ sources: { [DATA_SOURCE]: new FakeSource(board) } });
      await rig.runFetch({ ...good, filterCriteria } as unknown as FetchSourceMessage);

      // Dead-lettered on the first attempt (non-retryable), nothing
      // published, nothing written.
      expect(rig.channel.nacked).toHaveLength(1);
      expect(rig.channel.acked).toHaveLength(0);
      expect(rig.channel.sentToQueue).toHaveLength(0);
      expect(rig.takeScoreJobs()).toHaveLength(0);
      expect(await linkedExternalIds(searchId)).toEqual([]);
    }
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
 *
 *    UPDATE (ticket 45ea34c): that follow-up ticket exists and is done —
 *    the queue path applies the filter again, and "the quality filter on
 *    the queue path" above is the queue-shaped replacement for this
 *    coverage. It is not a restoration of the deleted tests: those drove
 *    `runDemoMatch` through the route, which this route no longer calls.
 */
