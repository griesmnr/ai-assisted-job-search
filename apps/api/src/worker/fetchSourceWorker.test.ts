import { randomUUID } from "node:crypto";
import type { Job } from "@app/shared";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { jobs, resumes, searches, searchResults, sourceDescriptors } from "../db/schema.js";
import { setupTopology } from "../queue/topology.js";
import {
  AuthFailedError,
  TransientSourceError,
  type JobSource,
  type NormalizedJob,
  type SearchCriteria,
  type SourceSearchResult,
} from "../sources/types.js";
import {
  FETCH_SOURCE_QUEUE,
  FETCH_SOURCE_RETRY_QUEUE,
  JOBS_EXCHANGE,
  startFetchSourceWorker,
  type FetchSourceMessage,
  type HighSkipRateInfo,
} from "./fetchSourceWorker.js";

process.loadEnvFile();

// ---------------------------------------------------------------------------
// Postgres setup (same pattern as db/schema.test.ts and ingest/ingestJobs.test.ts)
// ---------------------------------------------------------------------------

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});
const db = drizzle(client);

const RESUME_ID = "worker-test-resume";
// Widened to `string` (not the const-inferred literal) so it can be cast to
// Job["dataSource"] / NormalizedJob["dataSource"] below - this id is only a
// valid `source_descriptors.id` FK target for this test, not a real source.
const SOURCE_ID: string = "worker-test-source";

// ---------------------------------------------------------------------------
// RabbitMQ setup
// ---------------------------------------------------------------------------

let connection: ChannelModel;
let channel: ConfirmChannel;

const SCORE_JOB_QUEUE = "score.job";
const FETCH_SOURCE_DLQ = "fetch.source.dlq";

async function purgeAll() {
  await channel.purgeQueue(FETCH_SOURCE_QUEUE);
  await channel.purgeQueue(FETCH_SOURCE_RETRY_QUEUE);
  await channel.purgeQueue(FETCH_SOURCE_DLQ);
  await channel.purgeQueue(SCORE_JOB_QUEUE);
}

async function queueCount(queue: string): Promise<number> {
  const { messageCount } = await channel.checkQueue(queue);
  return messageCount;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function publishFetchSource(message: FetchSourceMessage) {
  channel.publish(JOBS_EXCHANGE, FETCH_SOURCE_QUEUE, Buffer.from(JSON.stringify(message)), {
    persistent: true,
    contentType: "application/json",
  });
}

// ---------------------------------------------------------------------------
// Fake JobSource - scripted per-call behavior, never touches the network.
// ---------------------------------------------------------------------------

class ScriptedSource implements JobSource {
  readonly dataSource: Job["dataSource"];
  calls = 0;

  constructor(
    dataSource: Job["dataSource"],
    private readonly script: (call: number) => Promise<SourceSearchResult>,
  ) {
    this.dataSource = dataSource;
  }

  async search(_criteria: SearchCriteria): Promise<SourceSearchResult> {
    this.calls += 1;
    return this.script(this.calls);
  }
}

function normalizedJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "worker-ext-1",
    dataSource: SOURCE_ID as NormalizedJob["dataSource"],
    title: "Widget Engineer",
    description: "Build widgets",
    company: "Widget Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function okResult(jobsFound: NormalizedJob[], skipped: SourceSearchResult["skipped"] = []) {
  const total = jobsFound.length + skipped.length;
  return Promise.resolve<SourceSearchResult>({
    jobs: jobsFound,
    skipped,
    skipRate: total === 0 ? 0 : skipped.length / total,
  });
}

// ---------------------------------------------------------------------------

let activeConsumerTag: string | undefined;

async function stopConsumer() {
  if (activeConsumerTag) {
    await channel.cancel(activeConsumerTag);
    activeConsumerTag = undefined;
  }
}

beforeAll(async () => {
  await client.connect();
  await db.insert(sourceDescriptors).values({ id: SOURCE_ID, displayName: "Worker Test Source" });
  await db.insert(resumes).values({ id: RESUME_ID, resumeText: "resume text" });

  const topology = await setupTopology();
  connection = topology.connection;
  channel = topology.channel;
});

afterEach(async () => {
  await stopConsumer();
  await purgeAll();
});

afterAll(async () => {
  await db.delete(searchResults);
  await db.delete(searches).where(eq(searches.resumeId, RESUME_ID));
  await db.delete(jobs).where(eq(jobs.dataSource, SOURCE_ID));
  await db.delete(resumes).where(eq(resumes.id, RESUME_ID));
  await db.delete(sourceDescriptors).where(eq(sourceDescriptors.id, SOURCE_ID));
  await client.end();

  await channel.close();
  await connection.close();
});

async function makeSearch(): Promise<string> {
  const searchId = randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId: RESUME_ID, searchedAt: new Date() });
  return searchId;
}

describe("fetchSourceWorker", () => {
  it("consumes fetch.source, persists the job, and publishes one score.job for a new job", async () => {
    const searchId = await makeSearch();
    const externalId = `success-${randomUUID()}`;
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([normalizedJob({ externalId })]),
    );

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1);
    // fetch.source itself should have drained (message was acked).
    await waitFor(async () => (await queueCount(FETCH_SOURCE_QUEUE)) === 0);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(1);

    const [scoreMsg] = await drainQueue(SCORE_JOB_QUEUE, 1);
    expect(JSON.parse(scoreMsg.content.toString())).toEqual({ jobId: rows[0].id });
  });

  it("a redelivered fetch.source message does not double-publish score.job for an already-ingested job (6bf2196)", async () => {
    const searchId = await makeSearch();
    const externalId = `redelivered-${randomUUID()}`;
    const message: FetchSourceMessage = { searchId, sourceId: SOURCE_ID, criteria: {} };
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([normalizedJob({ externalId })]),
    );

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      log: () => {},
    });

    // First delivery: ingests the job and publishes score.job once.
    publishFetchSource(message);
    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1);
    await waitFor(async () => source.calls === 1);

    // Redelivery: RabbitMQ's at-least-once guarantee means the exact same
    // message can arrive again (e.g. the worker died after ack didn't
    // reach the broker). Simulate that by publishing the identical
    // message again and letting the worker process it a second time.
    publishFetchSource(message);
    await waitFor(async () => source.calls === 2);
    await waitFor(async () => (await queueCount(FETCH_SOURCE_QUEUE)) === 0);

    // Give any (incorrect) second publish a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 150));
    expect(await queueCount(SCORE_JOB_QUEUE)).toBe(1);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(1);
  });

  it("a non-retryable error dead-letters immediately without consuming a retry", async () => {
    const searchId = await makeSearch();
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () => {
      throw new AuthFailedError("bad credentials");
    });

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      maxAttempts: 5,
      log: () => {},
    });

    const start = Date.now();
    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 2000 });
    const elapsedMs = Date.now() - start;

    // Only one call - it never went through the retry queue at all.
    expect(source.calls).toBe(1);
    expect(await queueCount(FETCH_SOURCE_RETRY_QUEUE)).toBe(0);
    expect(await queueCount(FETCH_SOURCE_QUEUE)).toBe(0);
    expect(await queueCount(SCORE_JOB_QUEUE)).toBe(0);
    // No backoff was paid - dead-lettered essentially immediately.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("a repeatedly-failing (retryable) message ends up in the DLQ after bounded attempts and does not spin forever", async () => {
    const searchId = await makeSearch();
    const maxAttempts = 3;
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () => {
      throw new TransientSourceError("upstream is down");
    });

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      maxAttempts,
      backoffMs: () => 40, // fast, fixed backoff so the test doesn't wait on real-world delays
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 5000 });

    // Exactly maxAttempts calls - bounded, not unbounded.
    expect(source.calls).toBe(maxAttempts);

    // Give the (now-exhausted) retry path a moment to prove it stays quiet
    // - if attempts weren't actually bounded, more calls/messages would
    // keep appearing here.
    await new Promise((r) => setTimeout(r, 300));

    expect(source.calls).toBe(maxAttempts);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(1);
    expect(await queueCount(FETCH_SOURCE_QUEUE)).toBe(0);
    expect(await queueCount(FETCH_SOURCE_RETRY_QUEUE)).toBe(0);
  });

  it("retries a transient failure and succeeds on a later attempt, publishing score.job exactly once", async () => {
    const searchId = await makeSearch();
    const externalId = `retry-then-succeed-${randomUUID()}`;
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], (call) => {
      if (call < 2) throw new TransientSourceError("flaky upstream");
      return okResult([normalizedJob({ externalId })]);
    });

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      maxAttempts: 4,
      backoffMs: () => 40,
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 3000 });
    expect(source.calls).toBe(2);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(0);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(1);
  });

  it("treats a high skipRate as a signal even though the message still succeeds", async () => {
    const searchId = await makeSearch();
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([], [{ externalId: "unmappable-1", reason: "schema drift" }]),
    );

    const alerts: HighSkipRateInfo[] = [];

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      onHighSkipRate: (info) => alerts.push(info),
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_QUEUE)) === 0);
    await waitFor(async () => alerts.length === 1);

    expect(alerts[0]).toMatchObject({ searchId, sourceId: SOURCE_ID, skipRate: 1 });
    // A 100% skip rate legitimately produced zero jobs - no score.job to publish.
    expect(await queueCount(SCORE_JOB_QUEUE)).toBe(0);
  });
});

async function drainQueue(queue: string, count: number) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const msg = await channel.get(queue);
    if (!msg) break;
    messages.push(msg);
    channel.ack(msg);
  }
  return messages;
}
