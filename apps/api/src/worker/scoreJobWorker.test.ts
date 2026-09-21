import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import Anthropic, { type BadRequestError, type RateLimitError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  jobMatches,
  jobs,
  resumes,
  searchResults,
  searches,
  sourceDescriptors,
} from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import { SCORE_JOB_DLQ, SCORE_JOB_QUEUE, SCORE_JOB_RETRY_TIERS } from "../queue/topology.js";
import type { ScoredJob } from "../matching/scoring.js";
import {
  classifyScoringError,
  createScoreJobHandler,
  parseScoreJobMessage,
  InvalidMessageError,
  MissingResumeTextError,
} from "./scoreJobWorker.js";

loadEnvFile();

// ---------------------------------------------------------------------------
// This file mocks the AMQP channel entirely (a FakeChannel, below) rather
// than connecting to a real broker - unlike fetchSourceWorker.test.ts, which
// runs against a real RabbitMQ (not available in every sandbox this ticket
// runs in; see this ticket's own verification notes). The DB side is real
// Postgres (createTestDatabase - ticket c434a6e's per-file isolated
// database), matching every other DB-backed test file in this repo.
// ---------------------------------------------------------------------------

let testDb: TestDatabase;
let db: NodePgDatabase;

const SOURCE_ID = "greenhouse";

beforeAll(async () => {
  testDb = await createTestDatabase("score_job_worker_test");
  db = testDb.db;
  await db.insert(sourceDescriptors).values({ id: SOURCE_ID, displayName: "Greenhouse" });
});

afterAll(async () => testDb?.teardown());

// ---------------------------------------------------------------------------
// Fake ConfirmChannel - in-memory, no broker. Implements exactly the surface
// scoreJobWorker.ts's handler uses: ack/nack, sendToQueue + waitForConfirms
// (the retry publish path), and `on("return", ...)` registration (real
// EventEmitter, so ensureRetryReturnHandler's listener genuinely attaches
// and can be exercised by manually emitting "return").
// ---------------------------------------------------------------------------

class FakeChannel extends EventEmitter {
  sentToQueue: { queue: string; content: Buffer; options: Record<string, unknown> }[] = [];
  acked: ConsumeMessage[] = [];
  nacked: { msg: ConsumeMessage; requeue: boolean | undefined }[] = [];

  sendToQueue(queue: string, content: Buffer, options?: Record<string, unknown>): boolean {
    this.sentToQueue.push({ queue, content, options: options ?? {} });
    return true;
  }

  ack(msg: ConsumeMessage): void {
    this.acked.push(msg);
  }

  nack(msg: ConsumeMessage, _allUpTo?: boolean, requeue?: boolean): void {
    this.nacked.push({ msg, requeue });
  }

  async waitForConfirms(): Promise<void> {}

  async checkQueue(queue: string) {
    return { queue, messageCount: 0, consumerCount: 0 };
  }
}

function fakeChannel(): FakeChannel & ConfirmChannel {
  return new FakeChannel() as unknown as FakeChannel & ConfirmChannel;
}

function makeMessage(body: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
  return {
    content: Buffer.from(JSON.stringify(body)),
    fields: {
      routingKey: SCORE_JOB_QUEUE,
      exchange: "jobs",
      redelivered: false,
      consumerTag: "test-consumer",
      deliveryTag: 1,
    },
    properties: { headers, contentType: "application/json" },
  } as unknown as ConsumeMessage;
}

// ---------------------------------------------------------------------------
// DB fixtures
// ---------------------------------------------------------------------------

async function insertJob(overrides: Partial<typeof jobs.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(jobs).values({
    id,
    externalId: `ext-${id}`,
    dataSource: SOURCE_ID,
    title: "Widget Engineer",
    description: "Build widgets all day.",
    company: "Widget Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  });
  return id;
}

async function insertResume(text = "resume text"): Promise<string> {
  const id = randomUUID();
  await db.insert(resumes).values({
    id,
    resumeText: text,
    resumeHash: `hash-${id}`,
    resumeNickname: `Resume ${id.slice(0, 6)}`,
  });
  return id;
}

/** Creates a `searches` row for `resumeId` and links it to `jobId` via
 * `search_results` - the exact relational path scoreJobWorker.ts's
 * `resolveResumeIds` reads back. */
async function linkJobToResumeViaSearch(jobId: string, resumeId: string): Promise<void> {
  const searchId = randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId, searchedAt: new Date() });
  await db.insert(searchResults).values({ id: randomUUID(), searchId, jobId });
}

function scoredJob(overrides: Partial<ScoredJob> = {}): ScoredJob {
  return {
    matchScore: 82,
    rationale: "Strong overlap on the core stack.",
    levelFit: "well_matched",
    levelFitNote: "",
    strengths: ["TypeScript", "RabbitMQ"],
    gaps: ["Kubernetes"],
    ...overrides,
  };
}

function rateLimitError(retryAfterSeconds?: number): RateLimitError {
  const headers = new Headers();
  if (retryAfterSeconds !== undefined) headers.set("retry-after", String(retryAfterSeconds));
  return Anthropic.APIError.generate(
    429,
    { error: { type: "rate_limit_error", message: "rate limited" } },
    "rate limited",
    headers,
  ) as RateLimitError;
}

function badRequestError(): BadRequestError {
  return Anthropic.APIError.generate(
    400,
    { error: { type: "invalid_request_error", message: "bad request" } },
    "bad request",
    new Headers(),
  ) as BadRequestError;
}

// ---------------------------------------------------------------------------

describe("classifyScoringError", () => {
  it("treats RateLimitError, InternalServerError, and APIConnectionError as retryable", () => {
    expect(classifyScoringError(rateLimitError())).toEqual({
      retryable: true,
      kind: "rate-limited",
    });
    const overloaded = Anthropic.APIError.generate(529, {}, "overloaded", new Headers());
    expect(classifyScoringError(overloaded)).toEqual({
      retryable: true,
      kind: "api-overloaded-or-5xx",
    });
    const connErr = new Anthropic.APIConnectionError({ message: "network blip" });
    expect(classifyScoringError(connErr)).toEqual({ retryable: true, kind: "connection" });
  });

  it("treats BadRequestError/AuthenticationError/MissingResumeTextError as non-retryable", () => {
    expect(classifyScoringError(badRequestError())).toEqual({
      retryable: false,
      kind: "bad-request",
    });
    expect(classifyScoringError(new MissingResumeTextError("gone"))).toEqual({
      retryable: false,
      kind: "missing-resume",
    });
  });

  it("defaults unanticipated errors to retryable, same posture as fetchSourceWorker's classify()", () => {
    expect(classifyScoringError(new Error("no text block returned"))).toEqual({
      retryable: true,
      kind: "unknown",
    });
  });
});

describe("parseScoreJobMessage", () => {
  it("parses a valid message", () => {
    expect(parseScoreJobMessage(Buffer.from(JSON.stringify({ jobId: "abc" })))).toEqual({
      jobId: "abc",
    });
  });

  it("throws InvalidMessageError on bad JSON", () => {
    expect(() => parseScoreJobMessage(Buffer.from("not json"))).toThrow(InvalidMessageError);
  });

  it("throws InvalidMessageError on a missing jobId", () => {
    expect(() => parseScoreJobMessage(Buffer.from(JSON.stringify({})))).toThrow(
      InvalidMessageError,
    );
  });
});

describe("scoreJobWorker", () => {
  it("scores a single linked resume and persists a structured job_matches row", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scored = scoredJob({ matchScore: 91 });
    const scoreJob = vi.fn().mockResolvedValue(scored);
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).toHaveBeenCalledTimes(1);
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resumeId,
      jobId,
      matchScore: 91,
      rationale: scored.rationale,
      levelFit: "well_matched",
      strengths: scored.strengths,
      gaps: scored.gaps,
    });
  });

  it("resolves every resume linked to the job via search_results/searches and scores each", async () => {
    const jobId = await insertJob();
    const resumeA = await insertResume("resume A text");
    const resumeB = await insertResume("resume B text");
    await linkJobToResumeViaSearch(jobId, resumeA);
    await linkJobToResumeViaSearch(jobId, resumeB);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob());
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).toHaveBeenCalledTimes(2);
    const calledResumeTexts = scoreJob.mock.calls.map((c) => c[1]).sort();
    expect(calledResumeTexts).toEqual(["resume A text", "resume B text"]);

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId));
    expect(rows.map((r) => r.resumeId).sort()).toEqual([resumeA, resumeB].sort());
    expect(channel.acked).toHaveLength(1);
  });

  it("skips a (resumeId, jobId) pair that already has a job_matches row, without calling scoreJob for it", async () => {
    const jobId = await insertJob();
    const alreadyScoredResume = await insertResume("already scored resume");
    const needsScoreResume = await insertResume("needs score resume");
    await linkJobToResumeViaSearch(jobId, alreadyScoredResume);
    await linkJobToResumeViaSearch(jobId, needsScoreResume);
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId: alreadyScoredResume,
      jobId,
      matchScore: 55,
      rationale: "pre-existing",
      strengths: [],
      gaps: [],
    });

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob({ matchScore: 77 }));
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    // Only the resume without an existing row was scored.
    expect(scoreJob).toHaveBeenCalledTimes(1);
    expect(scoreJob.mock.calls[0][1]).toBe("needs score resume");

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId));
    expect(rows).toHaveLength(2);
    const preExisting = rows.find((r) => r.resumeId === alreadyScoredResume);
    expect(preExisting?.matchScore).toBe(55); // untouched, not overwritten
    const fresh = rows.find((r) => r.resumeId === needsScoreResume);
    expect(fresh?.matchScore).toBe(77);
    expect(channel.acked).toHaveLength(1);
  });

  it("acks (does nothing) when every linked resume is already scored", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore: 60,
      rationale: "already done",
      strengths: [],
      gaps: [],
    });

    const channel = fakeChannel();
    const scoreJob = vi.fn();
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).not.toHaveBeenCalled();
    expect(channel.acked).toHaveLength(1);
  });

  it("acks (nothing to do) when the job has no search_results link to any search", async () => {
    const jobId = await insertJob();

    const channel = fakeChannel();
    const scoreJob = vi.fn();
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).not.toHaveBeenCalled();
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
  });

  it("retries a retryable scoring failure via a retry tier, then dead-letters once attempts are exhausted", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockRejectedValue(rateLimitError());
    const handler = createScoreJobHandler({
      channel,
      db,
      scoreJob,
      maxAttempts: 2,
      log: () => {},
    });

    // Attempt 1: fails, retryable, attempt < maxAttempts -> requeued via a
    // retry tier, original message acked (retry copy takes responsibility).
    await handler(makeMessage({ jobId }));
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
    expect(channel.sentToQueue).toHaveLength(1);
    const firstRetry = channel.sentToQueue[0]!;
    expect(SCORE_JOB_RETRY_TIERS.some((t) => t.queue === firstRetry.queue)).toBe(true);
    const firstRetryHeaders = firstRetry.options.headers as Record<string, unknown>;
    expect(firstRetryHeaders["x-attempt"]).toBe(2);

    // No job_matches row yet - the only resume's call failed both times.
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId))).toHaveLength(0);

    // Attempt 2 (simulating the retry-tier queue's TTL redelivering the
    // message with the incremented x-attempt header): fails again,
    // attempt (2) >= maxAttempts (2) -> dead-lettered (nack, no requeue).
    await handler(makeMessage({ jobId }, firstRetryHeaders));
    expect(channel.acked).toHaveLength(1); // unchanged
    expect(channel.nacked).toHaveLength(1);
    expect(channel.nacked[0]!.requeue).toBe(false);

    expect(scoreJob).toHaveBeenCalledTimes(2);
  });

  it("honors a RateLimitError's Retry-After by picking the shortest tier that can hold it", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    // 20s: longer than the shortest tiers, well under the top tier.
    const scoreJob = vi.fn().mockRejectedValue(rateLimitError(20));
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(channel.sentToQueue).toHaveLength(1);
    const tierUsed = channel.sentToQueue[0]!.queue;
    const tier = SCORE_JOB_RETRY_TIERS.find((t) => t.queue === tierUsed);
    expect(tier).toBeDefined();
    expect(tier!.delayMs).toBeGreaterThanOrEqual(20_000);
  });

  it("persists successes and does not retry the message when the only failures are permanent", async () => {
    const jobId = await insertJob();
    const goodResume = await insertResume("good resume");
    const badResume = await insertResume("bad resume");
    await linkJobToResumeViaSearch(jobId, goodResume);
    await linkJobToResumeViaSearch(jobId, badResume);

    const channel = fakeChannel();
    // Two independent resumeIds for the same job: one call succeeds, the
    // other rejects with a non-retryable (permanent) Anthropic error - the
    // same classifyScoringError bucket MissingResumeTextError falls into.
    // A whole-message failure like this must not block the succeeding
    // resumeId's persisted score, and must not schedule a retry, since
    // nothing about resending the message would change a permanent
    // rejection.
    const scoreJob = vi.fn().mockImplementation(async (_job, resumeText: string) => {
      if (resumeText === "good resume") return scoredJob({ matchScore: 88 });
      throw badRequestError();
    });
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
    expect(channel.sentToQueue).toHaveLength(0); // no retry - permanent failure

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resumeId).toBe(goodResume);
    expect(rows[0]!.matchScore).toBe(88);
  });

  it("dead-letters immediately (no retry) on an invalid message body", async () => {
    const channel = fakeChannel();
    const scoreJob = vi.fn();
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    const badMessage = {
      content: Buffer.from("not json"),
      fields: {
        routingKey: SCORE_JOB_QUEUE,
        exchange: "jobs",
        redelivered: false,
        consumerTag: "test-consumer",
        deliveryTag: 1,
      },
      properties: { headers: {}, contentType: "application/json" },
    } as unknown as ConsumeMessage;
    await handler(badMessage);

    expect(scoreJob).not.toHaveBeenCalled();
    expect(channel.acked).toHaveLength(0);
    expect(channel.nacked).toHaveLength(1);
    expect(channel.nacked[0]!.requeue).toBe(false);
    expect(channel.sentToQueue).toHaveLength(0);
  });

  it("dead-letters immediately (no retry) when jobId names no jobs row", async () => {
    const channel = fakeChannel();
    const scoreJob = vi.fn();
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId: randomUUID() }));

    expect(scoreJob).not.toHaveBeenCalled();
    expect(channel.acked).toHaveLength(0);
    expect(channel.nacked).toHaveLength(1);
    expect(channel.nacked[0]!.requeue).toBe(false);
  });

  it("registers exactly one return-event handler per channel across repeated createScoreJobHandler calls", () => {
    const channel = fakeChannel();
    createScoreJobHandler({ channel, db, scoreJob: vi.fn(), log: () => {} });
    createScoreJobHandler({ channel, db, scoreJob: vi.fn(), log: () => {} });
    expect(channel.listenerCount("return")).toBe(1);
  });

  it("dead-letters an unroutable retry publish via the return handler", async () => {
    const channel = fakeChannel();
    createScoreJobHandler({ channel, db, scoreJob: vi.fn(), log: () => {} });

    const bounced = {
      fields: { routingKey: "score.job.retry.5s" },
      properties: { contentType: "application/json", headers: { "x-attempt": 2 } },
      content: Buffer.from(JSON.stringify({ jobId: "x" })),
    };
    channel.emit("return", bounced);

    expect(channel.sentToQueue).toHaveLength(1);
    expect(channel.sentToQueue[0]!.queue).toBe(SCORE_JOB_DLQ);
  });
});
