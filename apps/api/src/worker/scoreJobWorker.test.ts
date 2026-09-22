import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import Anthropic, { type BadRequestError, type RateLimitError } from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { estimateScoringCost, toNormalizedJob } from "../matching/index.js";
import type { ScoredJob } from "../matching/scoring.js";
import {
  classifyScoringError,
  createScoreJobHandler,
  parseScoreJobMessage,
  InvalidMessageError,
  MissingResumeTextError,
  ScoringSpendGuard,
  SpendGuardExceededError,
  DEFAULT_LIFETIME_SPEND_CEILING_USD,
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

/** `ScoredJob.usage` fixture - `scoredJob()` above deliberately omits this
 * (matching every OTHER existing test in this file, which never touch the
 * spend guard/usage-stats wiring), so tests that need it opt in explicitly. */
function usageFixture(overrides: Partial<NonNullable<ScoredJob["usage"]>> = {}) {
  return {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  };
}

/** A throwaway path under the OS temp dir, unique per call - used so
 * usage-stats tests below never read or write the real
 * `prep/scoring-usage-stats.json` this repo's other scoring paths share. */
function tempUsageStatsPath(): string {
  return path.join(os.tmpdir(), `score-job-worker-test-usage-stats-${randomUUID()}.json`);
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

  // Opus review fix (ticket 4065511, F1): the base-APIError branch used to
  // return retryable: false, contradicting this function's own doc comment
  // and silently permanently-classifying any status this SDK version has no
  // named subclass for -- concretely, 408 Request Timeout (which the SDK's
  // OWN internal shouldRetry() treats as transient) and APIUserAbortError
  // (instanceof APIError, status undefined). Mutation-verified: reverting
  // the F1 fix left this test the only one that failed, out of the full
  // suite.
  it("treats an unnamed APIError status (e.g. 408) and APIUserAbortError as retryable, matching this function's own doc comment", () => {
    const timeout = Anthropic.APIError.generate(408, {}, "request timeout", new Headers());
    expect(classifyScoringError(timeout)).toEqual({ retryable: true, kind: "api-error-408" });

    const aborted = new Anthropic.APIUserAbortError({ message: "aborted" });
    expect(classifyScoringError(aborted)).toEqual({
      retryable: true,
      kind: "api-error-unknown",
    });
  });

  // Ticket b53c422: unlike every other permanent failure kind above,
  // SpendGuardExceededError is classified RETRYABLE - see that class's own
  // doc comment for why (process-lifetime-scoped, not data-scoped; a
  // restart genuinely can make a later attempt succeed).
  it("treats SpendGuardExceededError as retryable, unlike every other permanent failure kind", () => {
    expect(classifyScoringError(new SpendGuardExceededError("ceiling exceeded"))).toEqual({
      retryable: true,
      kind: "spend-guard-exceeded",
    });
  });
});

describe("ScoringSpendGuard", () => {
  it("defaults to DEFAULT_LIFETIME_SPEND_CEILING_USD and reports it via .ceiling", () => {
    const guard = new ScoringSpendGuard();
    expect(guard.ceiling).toBe(DEFAULT_LIFETIME_SPEND_CEILING_USD);
    expect(guard.reservedUsd).toBe(0);
  });

  it("allows a reservation strictly under the ceiling and books it", () => {
    const guard = new ScoringSpendGuard(1.0);
    expect(guard.tryReserve(0.4)).toBe(true);
    expect(guard.reservedUsd).toBeCloseTo(0.4);
  });

  it("allows a reservation that lands exactly ON the ceiling", () => {
    const guard = new ScoringSpendGuard(1.0);
    expect(guard.tryReserve(1.0)).toBe(true);
    expect(guard.reservedUsd).toBeCloseTo(1.0);
  });

  it("refuses a reservation that would push the running total past the ceiling, and books nothing", () => {
    const guard = new ScoringSpendGuard(1.0);
    expect(guard.tryReserve(1.01)).toBe(false);
    expect(guard.reservedUsd).toBe(0); // nothing booked on refusal
  });

  it("accumulates across calls and refuses only once the running total would cross the ceiling", () => {
    const guard = new ScoringSpendGuard(1.0);
    expect(guard.tryReserve(0.5)).toBe(true);
    expect(guard.tryReserve(0.5)).toBe(true); // exactly at the ceiling now
    expect(guard.reservedUsd).toBeCloseTo(1.0);
    expect(guard.tryReserve(0.01)).toBe(false); // any more tips it over
    expect(guard.reservedUsd).toBeCloseTo(1.0); // unchanged by the refusal

    // The ceiling never resets on its own (no time-based window) - a
    // smaller amount that would have fit at the start still doesn't fit
    // now, because nothing gives budget back short of a new instance
    // (i.e. a process restart). See this class's own doc comment.
    expect(guard.tryReserve(0.001)).toBe(false);
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

  // Opus review fix (ticket 4065511, F2): previously, ZERO successes plus
  // every failure permanent still acked -- correct for a genuinely
  // per-resume-only failure, but a silent data-loss path for a SYSTEMIC one
  // (an expired API key, a retired model id): every message hitting the
  // same outage would ack and vanish, draining the whole queue with no
  // job_matches rows and no DLQ record of which jobIds were ever consumed.
  // fetchSourceWorker.ts dead-letters every permanent failure
  // unconditionally; this pins the same behavior here, scoped to the
  // zero-success case (a partial success still acks -- see the test above).
  it("dead-letters (does not ack) when every failure is permanent AND nothing was scored, so a systemic outage stays visible", async () => {
    const jobId = await insertJob();
    const badResumeA = await insertResume("bad resume A");
    const badResumeB = await insertResume("bad resume B");
    await linkJobToResumeViaSearch(jobId, badResumeA);
    await linkJobToResumeViaSearch(jobId, badResumeB);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockRejectedValue(badRequestError());
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(channel.acked).toHaveLength(0);
    expect(channel.nacked).toHaveLength(1);
    expect(channel.nacked[0]!.requeue).toBe(false); // straight to score.job.dlq
    expect(channel.sentToQueue).toHaveLength(0); // not a retry - permanent

    const rows = await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId));
    expect(rows).toHaveLength(0);
  });

  // Opus review recommendation (ticket 4065511, F3): the three-way mixed
  // case (one resume succeeds, one hits a permanent failure, one hits a
  // retryable failure) was implemented but had no direct test. Verifies:
  // the message still retries (the retryable failure keeps it alive), the
  // successful resume's score is persisted immediately rather than held
  // hostage by the other two resumes' fates, and a redelivery does not
  // re-score (re-bill) the already-persisted resume.
  it("on a mixed outcome (one success, one permanent failure, one retryable failure), persists the success immediately, retries the message, and does not re-score the already-persisted resume on redelivery", async () => {
    const jobId = await insertJob();
    const goodResume = await insertResume("good resume");
    const permanentlyBadResume = await insertResume("permanently bad resume");
    const rateLimitedResume = await insertResume("rate limited resume");
    await linkJobToResumeViaSearch(jobId, goodResume);
    await linkJobToResumeViaSearch(jobId, permanentlyBadResume);
    await linkJobToResumeViaSearch(jobId, rateLimitedResume);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockImplementation(async (_job, resumeText: string) => {
      if (resumeText === "good resume") return scoredJob({ matchScore: 77 });
      if (resumeText === "permanently bad resume") throw badRequestError();
      throw rateLimitError();
    });
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    // At least one retryable failure remains -> a retry copy is published
    // to a retry-tier queue and the ORIGINAL message is acked immediately
    // (the retry-tier copy, not an AMQP-level requeue, takes responsibility
    // from here - same pattern as the existing "retries a retryable
    // scoring failure via a retry tier" test above).
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
    expect(channel.sentToQueue).toHaveLength(1);

    // The success is persisted immediately -- not held back by the other
    // two resumes' fates.
    const rowsAfterFirstAttempt = await db
      .select()
      .from(jobMatches)
      .where(eq(jobMatches.jobId, jobId));
    expect(rowsAfterFirstAttempt).toHaveLength(1);
    expect(rowsAfterFirstAttempt[0]!.resumeId).toBe(goodResume);

    // Redelivery (simulated: call the handler again with the same jobId,
    // attempt incremented via the retry-tier publish's headers): the
    // already-scored resume must be skipped, not re-billed.
    const [republished] = channel.sentToQueue;
    scoreJob.mockClear();
    await handler(makeMessage({ jobId }, republished!.options.headers as Record<string, unknown>));

    const scoredResumeTexts = scoreJob.mock.calls.map((call) => call[1]);
    expect(scoredResumeTexts).not.toContain("good resume");
    expect(scoredResumeTexts).toEqual(
      expect.arrayContaining(["permanently bad resume", "rate limited resume"]),
    );
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

// ---------------------------------------------------------------------------
// Spend guard (ticket b53c422). See ScoringSpendGuard's own doc comment
// (scoreJobWorker.ts) for the mechanism; these tests exercise it wired
// through the real handler, not just the class in isolation (covered
// separately above).
// ---------------------------------------------------------------------------

describe("scoreJobWorker spend guard", () => {
  it("refuses a scoring attempt the guard rejects: scoreJob is never called, no job_matches row is written, and the message is retried (not silently scored)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob());
    const spendGuard = { tryReserve: vi.fn().mockReturnValue(false) };
    const handler = createScoreJobHandler({ channel, db, scoreJob, spendGuard, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(spendGuard.tryReserve).toHaveBeenCalledTimes(1);
    expect(scoreJob).not.toHaveBeenCalled(); // refused BEFORE any real call
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId))).toHaveLength(0);

    // spend-guard-exceeded is retryable (see classifyScoringError) -> the
    // whole message is requeued via a retry tier, original acked, same
    // path any other retryable failure takes.
    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
    expect(channel.sentToQueue).toHaveLength(1);
    expect(SCORE_JOB_RETRY_TIERS.some((t) => t.queue === channel.sentToQueue[0]!.queue)).toBe(true);
  });

  it("eventually dead-letters once retries are exhausted if the guard stays tripped for the process's whole life (no self-recovery without a restart)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob());
    // A real ScoringSpendGuard with a ceiling of 0 - refuses forever, same
    // as a lifetime guard that was already exhausted before this message
    // arrived. Demonstrates the REAL class (not just a fake), wired
    // through the real estimateScoringCost pre-call check inside the
    // handler, genuinely refuses a real batch.
    const spendGuard = new ScoringSpendGuard(0);
    const handler = createScoreJobHandler({
      channel,
      db,
      scoreJob,
      spendGuard,
      maxAttempts: 2,
      log: () => {},
    });

    await handler(makeMessage({ jobId }));
    expect(channel.acked).toHaveLength(1);
    expect(channel.sentToQueue).toHaveLength(1);
    const headers = channel.sentToQueue[0]!.options.headers as Record<string, unknown>;

    await handler(makeMessage({ jobId }, headers));
    expect(channel.nacked).toHaveLength(1); // dead-lettered, attempts exhausted
    expect(channel.nacked[0]!.requeue).toBe(false);

    expect(scoreJob).not.toHaveBeenCalled(); // never once, across either attempt
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId))).toHaveLength(0);
  });

  it("with a real ScoringSpendGuard at a near-zero ceiling, a real (unmocked) cost estimate for a real job/resume pair is refused - demonstrating the refuse boundary with genuine estimateScoringCost math, not a mocked guard", async () => {
    const jobId = await insertJob({
      description: "B".repeat(6000), // a large, realistic posting - see this job's own DEFAULT_LIFETIME_SPEND_CEILING_USD doc comment for why 6,000 chars is used to size the default ceiling
    });
    const resumeId = await insertResume("A".repeat(4914)); // matches this codebase's own real prep/resume.txt length (see usage-cost.ts)
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob());
    // $0.000001 - certainly below ANY real per-job maxCostUsd (measured in
    // the tens of cents at most - see ScoringSpendGuard's own doc comment).
    const spendGuard = new ScoringSpendGuard(0.000001);
    const handler = createScoreJobHandler({ channel, db, scoreJob, spendGuard, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).not.toHaveBeenCalled();
    expect(channel.sentToQueue).toHaveLength(1); // retried, not silently dropped
  });

  // Opus review, ticket b53c422, F3: nothing previously tested the ONE
  // property this whole class exists for -- that spend ACCUMULATES across
  // separate messages within one process's lifetime, not just within a
  // single handler() call. Mutation-verified during review: moving the
  // `new ScoringSpendGuard()` construction from createScoreJobHandler's
  // options into the per-message handler body (i.e. a fresh guard every
  // message -> no lifetime tracking at all) left every OTHER spend-guard
  // test passing, because none of them shared one guard instance across
  // two separate handler() invocations.
  it("accumulates spend across separate messages sharing one guard instance -- a second message can be refused purely because of what a PRIOR message already spent", async () => {
    const resumeText = "resume text"; // matches insertResume()'s own default
    const normalizedJob = toNormalizedJob({
      externalId: "ext-baseline",
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
    }); // exactly insertJob()'s own default fields, below
    const singleCallCostUsd = estimateScoringCost(
      [normalizedJob],
      resumeText,
      undefined,
    ).maxCostUsd;

    // Sized so ONE call's real cost fits comfortably, but TWO calls of
    // roughly the same size (both messages below use insertJob()'s
    // identical default fields) cannot both fit.
    const ceilingUsd = singleCallCostUsd * 1.5;
    const spendGuard = new ScoringSpendGuard(ceilingUsd);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob());
    const handler = createScoreJobHandler({ channel, db, scoreJob, spendGuard, log: () => {} });

    // Message 1: a real scoring attempt that fits under the ceiling on its
    // own and books singleCallCostUsd against the SAME guard instance.
    const jobId1 = await insertJob();
    const resumeId1 = await insertResume(resumeText);
    await linkJobToResumeViaSearch(jobId1, resumeId1);
    await handler(makeMessage({ jobId: jobId1 }));

    expect(scoreJob).toHaveBeenCalledTimes(1);
    expect(channel.acked).toHaveLength(1);
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId1))).toHaveLength(1);
    expect(spendGuard.reservedUsd).toBeCloseTo(singleCallCostUsd, 6);

    // Message 2: a DIFFERENT job/resume pair (so this isn't the
    // already-scored skip, it's a genuine new scoring attempt) of the same
    // realistic size. Refused purely because message 1 already spent
    // against the shared guard -- proving the guard's state survives
    // across handler() calls, not just within one.
    const jobId2 = await insertJob();
    const resumeId2 = await insertResume(resumeText);
    await linkJobToResumeViaSearch(jobId2, resumeId2);
    await handler(makeMessage({ jobId: jobId2 }));

    expect(scoreJob).toHaveBeenCalledTimes(1); // still just the one call from message 1
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId2))).toHaveLength(0);
    expect(channel.sentToQueue).toHaveLength(1); // message 2 retried, not silently dropped
  });

  it("a normal small job/resume pair against the DEFAULT ceiling is allowed through untouched (the allow side of the boundary)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob({ matchScore: 70 }));
    // No spendGuard passed - exercises createScoreJobHandler's own default
    // (`new ScoringSpendGuard()`, i.e. DEFAULT_LIFETIME_SPEND_CEILING_USD),
    // the same default every real deployment gets unless
    // run-score-job-worker.ts is changed.
    const handler = createScoreJobHandler({ channel, db, scoreJob, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(scoreJob).toHaveBeenCalledTimes(1);
    expect(channel.acked).toHaveLength(1);
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// recordUsageStats wiring (ticket b53c422).
// ---------------------------------------------------------------------------

describe("scoreJobWorker recordUsageStats wiring", () => {
  let usageStatsPath: string;

  beforeEach(() => {
    usageStatsPath = tempUsageStatsPath();
  });

  afterEach(() => {
    fs.rmSync(usageStatsPath, { force: true });
  });

  it("records real usage to usageStatsPath after a successful scoring call", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi
      .fn()
      .mockResolvedValue(
        scoredJob({ usage: usageFixture({ inputTokens: 1234, outputTokens: 321 }) }),
      );
    const handler = createScoreJobHandler({ channel, db, scoreJob, usageStatsPath, log: () => {} });

    expect(fs.existsSync(usageStatsPath)).toBe(false);
    await handler(makeMessage({ jobId }));

    expect(fs.existsSync(usageStatsPath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(usageStatsPath, "utf8"));
    expect(written).toMatchObject({ calls: 1, totalInputTokens: 1234, totalOutputTokens: 321 });
  });

  it("aggregates every resumeId's usage from ONE message into a single write, correctly summed", async () => {
    const jobId = await insertJob();
    const resumeA = await insertResume("resume A text");
    const resumeB = await insertResume("resume B text");
    await linkJobToResumeViaSearch(jobId, resumeA);
    await linkJobToResumeViaSearch(jobId, resumeB);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockImplementation(async (_job, resumeText: string) =>
      scoredJob({
        usage:
          resumeText === "resume A text"
            ? usageFixture({ inputTokens: 100, outputTokens: 10 })
            : usageFixture({ inputTokens: 200, outputTokens: 20 }),
      }),
    );
    const handler = createScoreJobHandler({ channel, db, scoreJob, usageStatsPath, log: () => {} });

    await handler(makeMessage({ jobId }));

    const written = JSON.parse(fs.readFileSync(usageStatsPath, "utf8"));
    expect(written.calls).toBe(2);
    expect(written.totalInputTokens).toBe(300);
    expect(written.totalOutputTokens).toBe(30);
  });

  it("never writes usageStatsPath when the scorer's ScoredJob carries no usage (a fake/test scorer)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob()); // no usage field
    const handler = createScoreJobHandler({ channel, db, scoreJob, usageStatsPath, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(fs.existsSync(usageStatsPath)).toBe(false);
  });

  it("never writes usageStatsPath when every scoring call fails (nothing succeeded)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockRejectedValue(badRequestError());
    const handler = createScoreJobHandler({ channel, db, scoreJob, usageStatsPath, log: () => {} });

    await handler(makeMessage({ jobId }));

    expect(fs.existsSync(usageStatsPath)).toBe(false);
  });

  it("a recordUsageStats write failure never blocks the message ack or discards the already-persisted job_matches row (best-effort, matching runDemoMatch's own precedent)", async () => {
    const jobId = await insertJob();
    const resumeId = await insertResume();
    await linkJobToResumeViaSearch(jobId, resumeId);

    const channel = fakeChannel();
    const scoreJob = vi.fn().mockResolvedValue(scoredJob({ usage: usageFixture() }));
    // A path whose parent directory does not exist - fs.writeFileSync
    // throws ENOENT, exercising recordUsageStats's own try/catch inside
    // the handler.
    const unwritablePath = path.join(
      os.tmpdir(),
      `score-job-worker-test-does-not-exist-${randomUUID()}`,
      "usage-stats.json",
    );
    const handler = createScoreJobHandler({
      channel,
      db,
      scoreJob,
      usageStatsPath: unwritablePath,
      log: () => {},
    });

    await handler(makeMessage({ jobId }));

    expect(channel.acked).toHaveLength(1);
    expect(channel.nacked).toHaveLength(0);
    expect(await db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId))).toHaveLength(1);
  });
});
