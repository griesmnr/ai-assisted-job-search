import { randomUUID } from "node:crypto";
import type { Job } from "@app/shared";
import type { ChannelModel, ConfirmChannel } from "amqplib";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { jobs, resumes, searches, sourceDescriptors } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { FETCH_SOURCE_RETRY_TIERS, setupTopology } from "../queue/topology.js";
import {
  AuthFailedError,
  RateLimitedError,
  TransientSourceError,
  type JobSource,
  type NormalizedJob,
  type SearchCriteria,
  type SourceSearchResult,
} from "../sources/types.js";
import {
  FETCH_SOURCE_QUEUE,
  JOBS_EXCHANGE,
  SCORE_JOB_ROUTING_KEY,
  startFetchSourceWorker,
  type FetchSourceMessage,
  type HighSkipRateInfo,
  type RetryTier,
} from "./fetchSourceWorker.js";

process.loadEnvFile();

// ---------------------------------------------------------------------------
// Postgres setup — isolated, per-run database (ticket c434a6e). This file
// used to connect straight to the shared dev Postgres under fixed fixture
// ids ("worker-test-source", "worker-test-resume") — exactly the ids two
// concurrent worktrees' runs collided on with a real FK violation (see
// git-bug c434a6e's incident history). See ../db/test-db.ts.
// ---------------------------------------------------------------------------

let testDb: TestDatabase;
let db: NodePgDatabase;

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
const connectionErrors: unknown[] = [];

const SCORE_JOB_QUEUE = "score.job";
const FETCH_SOURCE_DLQ = "fetch.source.dlq";

// Fast, short-lived retry tiers for tests that need to actually observe a
// retry round-trip without waiting on the real (1s/2s/4s/8s) production
// backoff in FETCH_SOURCE_RETRY_TIERS. Declared the same way topology.ts
// declares the real tiers (queue-level TTL, DLX back to fetch.source) so
// they exercise the identical mechanism, just faster.
const TEST_RETRY_TIERS: RetryTier[] = [
  { queue: "fetch.source.retry.test.100ms", delayMs: 100 },
  { queue: "fetch.source.retry.test.300ms", delayMs: 300 },
  { queue: "fetch.source.retry.test.900ms", delayMs: 900 },
];

// Two more dedicated tiers, used only by the B1 regression test below to
// exercise the raw RabbitMQ mechanics directly (bypassing the worker
// entirely) - a long delay published first, a short delay published
// second, proving the short one is not blocked behind the long one.
const MECHANICS_LONG_TIER: RetryTier = {
  queue: "fetch.source.retry.test.mechanics-long",
  delayMs: 1200,
};
const MECHANICS_SHORT_TIER: RetryTier = {
  queue: "fetch.source.retry.test.mechanics-short",
  delayMs: 150,
};

async function purgeAll() {
  await channel.purgeQueue(FETCH_SOURCE_QUEUE);
  await channel.purgeQueue(FETCH_SOURCE_DLQ);
  await channel.purgeQueue(SCORE_JOB_QUEUE);
  for (const tier of FETCH_SOURCE_RETRY_TIERS) await channel.purgeQueue(tier.queue);
  for (const tier of TEST_RETRY_TIERS) await channel.purgeQueue(tier.queue);
  await channel.purgeQueue(MECHANICS_LONG_TIER.queue);
  await channel.purgeQueue(MECHANICS_SHORT_TIER.queue);
}

async function queueCount(queue: string): Promise<number> {
  const { messageCount } = await channel.checkQueue(queue);
  return messageCount;
}

async function retryTierMessageCount(tiers: ReadonlyArray<RetryTier>): Promise<number> {
  let total = 0;
  for (const tier of tiers) {
    total += await queueCount(tier.queue);
  }
  return total;
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

/** Wraps a ConfirmChannel so its FIRST `publish` call to `matchRoutingKey`
 * throws synchronously (simulating a publish failure) and every call after
 * that - including retries of the same logical publish - behaves normally.
 * Used to reproduce "attempt 1 inserts the job row, then the score.job
 * publish fails, so it retries; attempt 2 must not lose the message just
 * because the row already exists" (B2). */
function withFailingFirstPublish(target: ConfirmChannel, matchRoutingKey: string): ConfirmChannel {
  let failed = false;
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "publish") {
        return (...args: Parameters<ConfirmChannel["publish"]>) => {
          const [, routingKey] = args;
          if (!failed && routingKey === matchRoutingKey) {
            failed = true;
            throw new Error("simulated: publish failed before confirm (test)");
          }
          return target.publish(...args);
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  }) as ConfirmChannel;
}

/** Wraps a ConfirmChannel so `nack` throws synchronously every time,
 * simulating "the channel died mid-flight" - i.e. a failure reaching
 * *outside* the handler's own try/catch (the catch block's own cleanup
 * call is what throws here, not something the try block guards). Used by
 * the H2 regression test. */
function withBrokenNack(target: ConfirmChannel): ConfirmChannel {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "nack") {
        return () => {
          throw new Error("simulated: channel closed mid-flight (test)");
        };
      }
      return Reflect.get(t, prop, receiver);
    },
  }) as ConfirmChannel;
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
  testDb = await createTestDatabase("fetch_source_worker_test");
  db = testDb.db;
  await db.insert(sourceDescriptors).values({ id: SOURCE_ID, displayName: "Worker Test Source" });
  await db
    .insert(resumes)
    .values({ id: RESUME_ID, resumeText: "resume text", resumeHash: "worker-test-resume-hash" });

  const topology = await setupTopology();
  connection = topology.connection;
  channel = topology.channel;
  // Deliberately NOT a blanket `connection.on("error", () => {})`: a
  // checkQueue failure on a missing queue is a *channel*-level protocol
  // error (verified - it never reaches the connection), so the shared
  // connection doesn't need a swallow for the H1 test's sake, and a bare
  // swallow here would hide a genuine connection-level error from every
  // other test in this file. Instead, record any connection error and
  // assert there were none at the end - the H1 test's own temporary
  // channel gets its own scoped `tempChannel.on("error", ...)`.
  connection.on("error", (err) => connectionErrors.push(err));

  // `durable: false`, unlike every real topology.ts queue: these are
  // throwaway, test-only substitutes for the real retry tiers, not part
  // of the actual topology. Durable would mean they survive a broker
  // restart and keep showing up in `docker compose down`/the management
  // UI looking exactly like production infrastructure, indistinguishable
  // from the real fetch.source.retry.* queues at a glance. They're also
  // explicitly deleted in afterAll below, but non-durable is the backstop
  // for whatever that misses (a test run that crashes before afterAll).
  for (const tier of [...TEST_RETRY_TIERS, MECHANICS_LONG_TIER, MECHANICS_SHORT_TIER]) {
    await channel.assertQueue(tier.queue, {
      durable: false,
      messageTtl: tier.delayMs,
      deadLetterExchange: JOBS_EXCHANGE,
      deadLetterRoutingKey: FETCH_SOURCE_QUEUE,
    });
  }
});

afterEach(async () => {
  await stopConsumer();
  await purgeAll();
});

afterAll(async () => {
  // No manual row cleanup needed: this file's rows live in its own
  // isolated database (created in beforeAll above), dropped whole here.
  await testDb.teardown();

  expect(connectionErrors).toEqual([]);

  // Explicit belt-and-suspenders cleanup on top of `durable: false` above
  // - don't leave these test-only queues sitting in the broker (and the
  // management UI) between test runs even within one broker session that
  // never restarts.
  for (const tier of [...TEST_RETRY_TIERS, MECHANICS_LONG_TIER, MECHANICS_SHORT_TIER]) {
    await channel.deleteQueue(tier.queue).catch(() => {});
  }

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

  it("does not lose score.job when the publish fails after the job row is already inserted (B2 regression)", async () => {
    const searchId = await makeSearch();
    const externalId = `b2-${randomUUID()}`;
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([normalizedJob({ externalId })]),
    );
    // Attempt 1: ingest succeeds (row inserted), then this makes the
    // score.job publish throw. Before the fix, the worker decided what to
    // publish from `newlyInsertedJobIds` ("rows THIS call inserted") - on
    // attempt 2 the row is already there, that set is empty, and the loop
    // publishes nothing: the job is ingested but permanently never scored,
    // acked as a success. Publishing from `linkedJobIds` instead means
    // attempt 2 republishes it correctly.
    //
    // A dedicated channel, not the shared one: withFailingFirstPublish
    // wraps it in a Proxy, which is a different object reference than the
    // channel it wraps. ensureRetryReturnHandler's dedup (see
    // fetchSourceWorker.ts) keys off that reference, so registering
    // against a fresh Proxy on the SHARED channel would attach an extra,
    // permanent `return` listener to the real underlying channel - every
    // later test's unroutable-publish events would then be double-handled
    // (reproduced: it duplicated a later test's DLQ entry). Isolating the
    // proxy on its own channel avoids polluting shared state at all.
    const tempChannel = await connection.createConfirmChannel();
    const flakyChannel = withFailingFirstPublish(tempChannel, SCORE_JOB_ROUTING_KEY);

    try {
      await startFetchSourceWorker({
        channel: flakyChannel,
        db,
        sources: { [SOURCE_ID]: source },
        retryTiers: TEST_RETRY_TIERS,
        log: () => {},
      });

      publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

      await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 3000 });
      expect(source.calls).toBe(2);

      const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
      expect(rows).toHaveLength(1);
    } finally {
      await tempChannel.close().catch(() => {});
    }
  });

  it("a genuinely redelivered fetch.source message republishes score.job - the scoring worker is the dedupe boundary now, not this one", async () => {
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

    // A true redelivery: the exact same message body arrives again (e.g.
    // the ack didn't reach the broker before the worker restarted).
    publishFetchSource(message);
    await waitFor(async () => source.calls === 2);
    await waitFor(async () => (await queueCount(FETCH_SOURCE_QUEUE)) === 0);

    // By design (see the module doc comment on newlyInsertedJobIds vs
    // linkedJobIds), this publishes score.job a second time rather than
    // risk losing it - it is the scoring worker's own idempotency, not
    // this worker's job-insert bookkeeping, that keeps this from becoming
    // a second Claude call.
    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 2);

    // The DB layer's idempotency is unaffected either way: still one row.
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

    // Only one call - it never went through any retry tier at all.
    expect(source.calls).toBe(1);
    expect(await retryTierMessageCount(FETCH_SOURCE_RETRY_TIERS)).toBe(0);
    expect(await queueCount(FETCH_SOURCE_QUEUE)).toBe(0);
    expect(await queueCount(SCORE_JOB_QUEUE)).toBe(0);
    // No backoff was paid - dead-lettered essentially immediately.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("an adapter registered under a mismatched sourceId dead-letters immediately instead of writing an orphan row (B3 regression)", async () => {
    const searchId = await makeSearch();
    const externalId = `mismatch-${randomUUID()}`;
    // Registered under `wrongKey`, but the adapter's own dataSource is
    // SOURCE_ID - exactly the copy/paste bug the dispatch-point check
    // guards against.
    const wrongKey = `${SOURCE_ID}-alias`;
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([normalizedJob({ externalId })]),
    );

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [wrongKey]: source },
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: wrongKey, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 2000 });

    // The mismatch is caught at dispatch, before the adapter is ever
    // called - no wasted search call, and no orphan row.
    expect(source.calls).toBe(0);
    expect(await queueCount(SCORE_JOB_QUEUE)).toBe(0);
    expect(await retryTierMessageCount(FETCH_SOURCE_RETRY_TIERS)).toBe(0);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(0);
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
      retryTiers: TEST_RETRY_TIERS,
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 5000 });

    // Exactly maxAttempts calls - bounded, not unbounded.
    expect(source.calls).toBe(maxAttempts);

    // Give the (now-exhausted) retry path a moment to prove it stays quiet
    // - if attempts weren't actually bounded, more calls/messages would
    // keep appearing here.
    await new Promise((r) => setTimeout(r, 400));

    expect(source.calls).toBe(maxAttempts);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(1);
    expect(await queueCount(FETCH_SOURCE_QUEUE)).toBe(0);
    expect(await retryTierMessageCount(TEST_RETRY_TIERS)).toBe(0);
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
      retryTiers: TEST_RETRY_TIERS,
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 3000 });
    expect(source.calls).toBe(2);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(0);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Source-search deadline (ticket 491cd88). A source.search() call that
  // never settles must not wedge this worker forever under prefetch(1),
  // and must not silently vanish either — it has to go down the SAME
  // retry/DLQ path as any other retryable failure. `sourceSearchTimeoutMs`
  // is set tiny here (real default: DEFAULT_SOURCE_SEARCH_TIMEOUT_MS, 10
  // minutes) so these tests don't wait on production-scale timing.
  // -------------------------------------------------------------------------

  it("a source.search() that exceeds the deadline is retried — not left unacked forever — and can still succeed on the next attempt (deadline expiry regression)", async () => {
    const searchId = await makeSearch();
    const externalId = `deadline-recovers-${randomUUID()}`;
    let calls = 0;
    const source: JobSource = {
      dataSource: SOURCE_ID as Job["dataSource"],
      search: async () => {
        calls += 1;
        if (calls === 1) {
          // Simulates ticket 491cd88's exact failure mode: a search() call
          // that runs long enough to blow past the worker's deadline.
          // Deliberately never resolves on its own within this test — the
          // worker's OWN timeout has to be what ends this attempt, not the
          // source settling.
          return new Promise<SourceSearchResult>(() => {});
        }
        return okResult([normalizedJob({ externalId })]);
      },
    };

    const logs: string[] = [];
    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      retryTiers: TEST_RETRY_TIERS,
      sourceSearchTimeoutMs: 50,
      log: (m) => logs.push(m),
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    // This is the load-bearing assertion: the message goes down the RETRY
    // path, not vanishing. A message truly stuck unacked forever (the
    // pre-fix failure mode — before this ticket, nothing ever stopped
    // waiting on the hung search()) would never reach a second attempt at
    // all under prefetch(1); reaching score.job here is only possible if
    // the first (hung) delivery was explicitly failed, acked, and
    // requeued via a retry tier so a second delivery could be dispatched.
    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 5000 });
    expect(calls).toBe(2);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(0);

    // Confirms it was actually the DEADLINE that triggered the retry, not
    // some other failure path.
    expect(logs.some((l) => l.includes("source-search-timeout"))).toBe(true);
    expect(logs.some((l) => l.includes("did not complete within 50ms"))).toBe(true);

    const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
    expect(rows).toHaveLength(1);
  });

  it("a source.search() that ALWAYS exceeds the deadline ends up in the DLQ after bounded attempts, not stuck unacked forever", async () => {
    const searchId = await makeSearch();
    const maxAttempts = 2;
    let calls = 0;
    const source: JobSource = {
      dataSource: SOURCE_ID as Job["dataSource"],
      search: async () => {
        calls += 1;
        return new Promise<SourceSearchResult>(() => {});
      },
    };

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      maxAttempts,
      retryTiers: TEST_RETRY_TIERS,
      sourceSearchTimeoutMs: 50,
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 5000 });
    expect(calls).toBe(maxAttempts);

    // Give the (now-exhausted) retry path a moment to prove it stays quiet
    // — same pattern as the plain TransientSourceError exhaustion test
    // above — a real fix bounds this permanently, not just "eventually".
    await new Promise((r) => setTimeout(r, 400));

    expect(calls).toBe(maxAttempts);
    expect(await queueCount(FETCH_SOURCE_DLQ)).toBe(1);
    expect(await queueCount(FETCH_SOURCE_QUEUE)).toBe(0);
    expect(await retryTierMessageCount(TEST_RETRY_TIERS)).toBe(0);
  });

  it("uses RateLimitedError.retryAfterMs to pick a delay tier instead of guessing from attempt number (H3 regression)", async () => {
    const searchId = await makeSearch();
    const externalId = `h3-${randomUUID()}`;
    const attemptTimes: number[] = [];
    const source: JobSource = {
      dataSource: SOURCE_ID as Job["dataSource"],
      search: async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          // Attempt-number-based backoff would pick TEST_RETRY_TIERS[0]
          // (100ms, since nextAttempt=2). retryAfterMs=250 must instead
          // pick the smallest tier that can honor it: 300ms.
          throw new RateLimitedError("slow down", 250);
        }
        return okResult([normalizedJob({ externalId })]);
      },
    };

    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      retryTiers: TEST_RETRY_TIERS,
      log: () => {},
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 3000 });
    expect(attemptTimes).toHaveLength(2);

    const gapMs = attemptTimes[1]! - attemptTimes[0]!;
    expect(gapMs).toBeGreaterThanOrEqual(250);
    // Comfortably below the 900ms tier and the naive 100ms tier alike -
    // pins this to "picked 300ms", not just "picked something >= 250ms".
    expect(gapMs).toBeLessThan(700);
  });

  it("clamps to the longest tier (and logs that it did) when retryAfterMs exceeds every configured tier", async () => {
    const searchId = await makeSearch();
    const externalId = `clamp-${randomUUID()}`;
    const attemptTimes: number[] = [];
    const source: JobSource = {
      dataSource: SOURCE_ID as Job["dataSource"],
      search: async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          // Bigger than TEST_RETRY_TIERS' longest tier (900ms) - nothing
          // configured can honor this in full. Before the fix, this
          // (and every subsequent attempt asking for the same 5000ms)
          // would have silently clamped to the SHORTEST usable gap with
          // no record that it happened - here it must clamp to the
          // longest tier (900ms) and say so in the log.
          throw new RateLimitedError("slow down a lot", 5000);
        }
        return okResult([normalizedJob({ externalId })]);
      },
    };

    const logs: string[] = [];
    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      retryTiers: TEST_RETRY_TIERS,
      log: (m) => logs.push(m),
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 3000 });
    expect(attemptTimes).toHaveLength(2);

    const gapMs = attemptTimes[1]! - attemptTimes[0]!;
    // Landed on the longest available tier (900ms) - nowhere near
    // instant, and nowhere near the 5000ms actually requested either.
    expect(gapMs).toBeGreaterThanOrEqual(850);
    expect(gapMs).toBeLessThan(2000);

    expect(logs.some((l) => l.includes("CLAMPED"))).toBe(true);
  });

  it("a retry tier deleted while the worker is running dead-letters the message instead of losing it (mandatory/return regression)", async () => {
    const searchId = await makeSearch();
    const tier: RetryTier = {
      queue: `fetch.source.retry.test.deleteme-${randomUUID()}`,
      delayMs: 100,
    };
    await channel.assertQueue(tier.queue, {
      durable: false,
      messageTtl: tier.delayMs,
      deadLetterExchange: JOBS_EXCHANGE,
      deadLetterRoutingKey: FETCH_SOURCE_QUEUE,
    });

    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () => {
      throw new TransientSourceError("upstream is down");
    });

    // A dedicated channel: the `return` handler is registered (and its
    // `log` closure captured) once per channel, the first time
    // startFetchSourceWorker runs against it (see ensureRetryReturnHandler
    // in fetchSourceWorker.ts) - the shared `channel` already has one
    // attached from an earlier test in this file, bound to THAT test's
    // `log`, so asserting on this test's own `logs` array against the
    // shared channel would only ever see whatever the first test captured.
    // A fresh channel makes this test's own registration the first (and
    // only) one.
    const tempChannel = await connection.createConfirmChannel();
    const logs: string[] = [];

    try {
      await startFetchSourceWorker({
        channel: tempChannel,
        db,
        sources: { [SOURCE_ID]: source },
        retryTiers: [tier],
        log: (m) => logs.push(m),
      });

      // Simulate drift: the tier this worker validated against at startup
      // is gone by the time a message actually needs to retry into it -
      // deleted, renamed, whatever. startFetchSourceWorker's own
      // checkQueue() can't catch this; only mandatory+return (at the
      // sendToQueue call site) can.
      await channel.deleteQueue(tier.queue);

      publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

      await waitFor(async () => (await queueCount(FETCH_SOURCE_DLQ)) === 1, { timeoutMs: 3000 });

      // Only the one call - the "retry" never actually happened, it just
      // got redirected straight to the DLQ once it bounced.
      expect(source.calls).toBe(1);
      expect(logs.some((l) => l.includes("unroutable"))).toBe(true);
    } finally {
      await tempChannel.close().catch(() => {});
    }
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

  it("logs every skipped record's reason at the worker boundary, even when skipRate stays well under the alert threshold (F2 regression, ticket 491cd88)", async () => {
    const searchId = await makeSearch();
    // 9 successful jobs, 1 skip - skipRate 0.1, well under the default 0.5
    // highSkipRateThreshold. Deliberately modeled on the exact scenario
    // the review measured: a SmartRecruiters maxPostings truncation
    // record diluted into a large, otherwise-healthy-looking result
    // (1 truncation record against 1,000 successful jobs is skipRate
    // 0.001) - onHighSkipRate correctly does NOT fire for a skipRate this
    // low, so the log line below is the ONLY place this reaches.
    const jobsFound = Array.from({ length: 9 }, (_, i) =>
      normalizedJob({ externalId: `f2-ok-${randomUUID()}-${i}` }),
    );
    const truncationReason =
      'SmartRecruiters search for company "BigCo" was truncated: 5000 candidate postings ' +
      "were found but only 1000 of the shared maxPostings=1000 budget remained - 4000 " +
      "postings were NOT fetched (simulated for this test)";
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult(jobsFound, [{ externalId: undefined, reason: truncationReason }]),
    );

    const logs: string[] = [];
    const alerts: HighSkipRateInfo[] = [];
    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      onHighSkipRate: (info) => alerts.push(info),
      log: (m) => logs.push(m),
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 9);

    // Confirms the low-skipRate premise: the alert hook genuinely does not
    // fire here (that's correct behavior for the threshold, not a bug).
    expect(alerts).toHaveLength(0);

    // The load-bearing assertion: the truncation's own reason text reached
    // the log stream anyway, with enough context (source, search id) to
    // find it. Before this fix, `result.skipped` was read only for
    // `total`/`skipRate` and then discarded - `reason` never logged,
    // persisted, or returned anywhere - so a truncated result was
    // indistinguishable from a complete one everywhere in the running
    // system, machine and human alike.
    expect(logs.some((l) => l.includes(truncationReason))).toBe(true);
    expect(
      logs.some((l) => l.includes(`source=${SOURCE_ID}`) && l.includes(`search=${searchId}`)),
    ).toBe(true);
  });

  it("caps how many skipped-record reasons it logs per message, summarizing the rest by count instead of flooding the log (SKIPPED_LOG_LIMIT)", async () => {
    const searchId = await makeSearch();
    const manySkips = Array.from({ length: 25 }, (_, i) => ({
      externalId: `flood-${i}`,
      reason: `unmappable record ${i}`,
    }));
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () =>
      okResult([], manySkips),
    );

    const logs: string[] = [];
    activeConsumerTag = await startFetchSourceWorker({
      channel,
      db,
      sources: { [SOURCE_ID]: source },
      onHighSkipRate: () => {},
      log: (m) => logs.push(m),
    });

    publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

    await waitFor(async () => (await queueCount(FETCH_SOURCE_QUEUE)) === 0);

    const perRecordLines = logs.filter((l) => l.includes("skipped record:"));
    expect(perRecordLines).toHaveLength(20);
    expect(logs.some((l) => l.includes("...and 5 more skipped record(s)"))).toBe(true);
  });

  it("retry tiers expire independently - a short-tier message is not blocked behind a long-tier one (B1 regression)", async () => {
    // Regression-tests the RabbitMQ mechanics directly, bypassing the
    // worker: publish into the LONG tier first, then the SHORT tier -
    // under the old shared-queue-with-per-message-TTL design this is
    // exactly the ordering that produces head-of-line blocking (the long
    // message parked at the head prevents the short one behind it from
    // expiring). With one queue per tier and a queue-level TTL, expiry
    // order matches each tier's own publish order (FIFO) regardless of
    // what's happening in any other tier.
    channel.sendToQueue(MECHANICS_LONG_TIER.queue, Buffer.from("long"), { persistent: true });
    await channel.waitForConfirms();
    channel.sendToQueue(MECHANICS_SHORT_TIER.queue, Buffer.from("short"), { persistent: true });
    await channel.waitForConfirms();

    const releaseOrder: string[] = [];
    const { consumerTag } = await channel.consume(FETCH_SOURCE_QUEUE, (msg) => {
      if (!msg) return;
      releaseOrder.push(msg.content.toString());
      channel.ack(msg);
    });

    try {
      await waitFor(async () => releaseOrder.length === 2, { timeoutMs: 3000 });
    } finally {
      await channel.cancel(consumerTag);
    }

    expect(releaseOrder).toEqual(["short", "long"]);
  });

  it(
    "the real default retry tiers (FETCH_SOURCE_RETRY_TIERS, not overridden) honor their backoff " +
      "and are not blocked by an unrelated message parked in a longer tier (real-defaults regression)",
    async () => {
      const searchId = await makeSearch();
      const externalId = `real-tiers-${randomUUID()}`;

      // Seed the longest real production tier directly - simulating a
      // different message that's already several attempts in and is
      // currently waiting out an 8-second backoff. Nothing in this test
      // ever consumes it; it exists purely to prove it does NOT hold up
      // the unrelated retry below, the way a single shared retry queue
      // with a per-message TTL would have (B1).
      channel.sendToQueue(
        "fetch.source.retry.8s",
        Buffer.from(JSON.stringify({ searchId: "unrelated", sourceId: "unrelated", criteria: {} })),
        { persistent: true },
      );
      await channel.waitForConfirms();
      expect(await queueCount("fetch.source.retry.8s")).toBe(1);

      const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], (call) => {
        if (call < 2) throw new TransientSourceError("flaky upstream");
        return okResult([normalizedJob({ externalId })]);
      });

      // No `retryTiers` override here - this is the actual shipped
      // default (FETCH_SOURCE_RETRY_TIERS), not a fast test substitute.
      // Every other retry test in this file overrides backoff to
      // something fast, which is precisely the one configuration where
      // head-of-line blocking cannot occur - this test is the one that
      // exercises what actually ships.
      activeConsumerTag = await startFetchSourceWorker({
        channel,
        db,
        sources: { [SOURCE_ID]: source },
        log: () => {},
      });

      const start = Date.now();
      publishFetchSource({ searchId, sourceId: SOURCE_ID, criteria: {} });

      await waitFor(async () => (await queueCount(SCORE_JOB_QUEUE)) === 1, { timeoutMs: 4000 });
      const elapsedMs = Date.now() - start;

      expect(source.calls).toBe(2);
      // The real "fetch.source.retry.1s" tier's backoff was actually
      // honored (attempt 2 landed after roughly a second, not instantly)...
      expect(elapsedMs).toBeGreaterThanOrEqual(950);
      // ...and stayed close to it - nowhere near the 8 seconds the
      // unrelated message ahead of it (in a DIFFERENT tier queue) is
      // still waiting out.
      expect(elapsedMs).toBeLessThan(3000);

      // The unrelated long-tier message is still exactly where it was -
      // untouched and unexpired, on its own independent timeline. If the
      // two shared one queue with per-message TTL, releasing the short
      // retry this fast would have been impossible without also
      // releasing (or being blocked by) this one.
      expect(await queueCount("fetch.source.retry.8s")).toBe(1);

      const rows = await db.select().from(jobs).where(eq(jobs.externalId, externalId));
      expect(rows).toHaveLength(1);
    },
    8000,
  );

  it("startFetchSourceWorker fails fast at startup if a configured retry tier queue doesn't exist (H1 regression)", async () => {
    const tempChannel = await connection.createConfirmChannel();
    // checkQueue on a missing queue is a channel-level protocol error:
    // amqplib closes the channel AND emits 'error' on it. An EventEmitter
    // with no 'error' listener makes Node throw that as an uncaught
    // exception instead of just delivering it - this test triggers that
    // deliberately, so it needs its own listener to observe it via the
    // rejected promise instead of crashing the process.
    tempChannel.on("error", () => {});
    try {
      await expect(
        startFetchSourceWorker({
          channel: tempChannel,
          db,
          sources: {},
          retryTiers: [
            { queue: `fetch.source.retry.does-not-exist-${randomUUID()}`, delayMs: 100 },
          ],
          log: () => {},
        }),
      ).rejects.toThrow(/does not exist/);
    } finally {
      // amqplib closes the channel itself when checkQueue fails on a
      // missing queue - guard the cleanup close so a double-close doesn't
      // turn a passing test into a noisy one.
      await tempChannel.close().catch(() => {});
    }
  });

  it("a handler failure outside its own try/catch does not become an unhandled rejection, and closes the channel once nack also fails (H2 regression)", async () => {
    const searchId = await makeSearch();
    const source = new ScriptedSource(SOURCE_ID as Job["dataSource"], () => {
      throw new AuthFailedError("bad credentials"); // non-retryable -> hits channel.nack -> throws
    });

    // Isolated channel + connection-level consumer so this test's broken
    // `nack` can't affect any other test sharing the module-level channel.
    const tempChannel = await connection.createConfirmChannel();
    const brokenChannel = withBrokenNack(tempChannel);

    let channelClosed = false;
    tempChannel.on("close", () => {
      channelClosed = true;
    });

    const logs: string[] = [];
    let unhandled: unknown;
    const onUnhandledRejection = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await startFetchSourceWorker({
        channel: brokenChannel,
        db,
        sources: { [SOURCE_ID]: source },
        log: (m) => logs.push(m),
      });

      channel.publish(
        JOBS_EXCHANGE,
        FETCH_SOURCE_QUEUE,
        Buffer.from(JSON.stringify({ searchId, sourceId: SOURCE_ID, criteria: {} })),
        {
          persistent: true,
          contentType: "application/json",
        },
      );
      await channel.waitForConfirms();

      // withBrokenNack throws on every call, not just the first, so the
      // outer catch's own `channel.nack(msg, false, false)` retry (see
      // startFetchSourceWorker) fails too - it should fall through to
      // closing the channel itself, rather than leaving the message
      // unacked forever and wedging this prefetch(1) consumer.
      await waitFor(async () => logs.some((l) => l.includes("nack also failed")), {
        timeoutMs: 2000,
      });
      await waitFor(async () => channelClosed, { timeoutMs: 2000 });
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      // Already closed by the worker's own fallback by this point in the
      // normal case - this is just a backstop. Closing (a channel that
      // still had our broken-nack message outstanding) requeues it back
      // to fetch.source; the module-level purgeAll() in afterEach cleans
      // that up.
      await tempChannel.close().catch(() => {});
    }

    expect(unhandled).toBeUndefined();
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
