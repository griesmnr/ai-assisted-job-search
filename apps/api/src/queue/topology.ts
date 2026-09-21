import amqp from "amqplib";

/**
 * Backoff delay tiers for retrying a failed `fetch.source` message. Each
 * tier is its own durable queue with a *queue-level* `x-message-ttl`
 * (`messageTtl` below) - deliberately not a single shared queue with a
 * per-message `expiration`.
 *
 * The reason: RabbitMQ (classic queues) only evaluates TTL expiry at the
 * HEAD of a queue. If one shared queue held messages with different
 * per-message TTLs, a message with a *long* TTL sitting at the head blocks
 * every *shorter*-TTL message queued behind it - they cannot expire (and so
 * cannot be redelivered) until the long one at the head finally does, at
 * which point they all release at once. That turns "back off and retry
 * gradually" into "wait, then thundering-herd retry against a source that
 * was already struggling" - the opposite of the intended behavior. An
 * earlier version of this file used exactly that (shared-queue,
 * per-message `expiration`) pattern and the comment here confidently
 * described it as working; it was reproduced not to.
 *
 * A uniform queue-level TTL sidesteps this: every message in a given tier
 * has the *same* TTL, so head-of-queue expiry order matches publish order
 * (FIFO) and nothing blocks anything else. The worker (fetchSourceWorker.ts)
 * picks which tier to republish into based on the message's attempt number
 * (and, when the source told us how long to wait via
 * `RateLimitedError.retryAfterMs`, by that instead - see `pickRetryTier`).
 * Each tier's `deadLetterExchange`/`deadLetterRoutingKey` sends an expired
 * message back to the "jobs" exchange under the "fetch.source" routing key
 * - i.e. back into the work queue below for another attempt - the same DLX
 * mechanism used everywhere else in this file, just pointed at a work
 * queue instead of a dead-letter queue.
 *
 * The 60s top tier exists specifically for `RateLimitedError.retryAfterMs`:
 * USAJOBS (this project's primary source) can and does hand back a
 * `Retry-After` in that range on a 429. Without a tier that can actually
 * hold that long, `pickRetryTier` would have nothing >= the requested delay
 * to pick and would clamp down to 8s - retrying three times inside the
 * source's own rate-limit window, getting 429'd every time, and
 * dead-lettering a message the source would have accepted fine a minute
 * later. attempt-number-based escalation (no RateLimitedError involved)
 * still only reaches this tier if `maxAttempts` is configured to allow a
 * 5th attempt; the default (4) never does.
 */
export const FETCH_SOURCE_RETRY_TIERS: ReadonlyArray<{
  readonly queue: string;
  readonly delayMs: number;
}> = [
  { queue: "fetch.source.retry.1s", delayMs: 1_000 },
  { queue: "fetch.source.retry.2s", delayMs: 2_000 },
  { queue: "fetch.source.retry.4s", delayMs: 4_000 },
  { queue: "fetch.source.retry.8s", delayMs: 8_000 },
  { queue: "fetch.source.retry.60s", delayMs: 60_000 },
];

/** The dead-letter queue a permanently-failed (or unroutable-retry)
 * `fetch.source` message ends up in. Exported so the worker's `return`
 * handler (see fetchSourceWorker.ts) can dead-letter a retry publish that
 * bounced off a missing tier queue without hardcoding the name twice. */
export const FETCH_SOURCE_DLQ = "fetch.source.dlq";

/** The `score.job` work queue's own name, exported (ticket 4065511) so
 * scoreJobWorker.ts never hardcodes it a second time - mirrors
 * `FETCH_SOURCE_QUEUE` (fetchSourceWorker.ts), just declared on this side
 * since, unlike that constant, nothing about it is fetch.source-specific. */
export const SCORE_JOB_QUEUE = "score.job";

/** The dead-letter queue a permanently-failed (or unroutable-retry)
 * `score.job` message ends up in - same role as `FETCH_SOURCE_DLQ` above,
 * for the scoring worker (ticket 4065511). */
export const SCORE_JOB_DLQ = "score.job.dlq";

/**
 * Backoff delay tiers for retrying a failed `score.job` message - the
 * `score.job` analogue of `FETCH_SOURCE_RETRY_TIERS` above. Same queue-per-
 * tier mechanism for the same reason (see that constant's doc comment for
 * why a uniform queue-level TTL is used instead of a shared queue with a
 * per-message `expiration` - head-of-queue-only TTL expiry means a long
 * delay at the head of a shared queue would block every shorter delay
 * queued behind it). `scoreJobWorker.ts` picks a tier by attempt number (or,
 * when an Anthropic `RateLimitError` carries a `Retry-After` header, by that
 * instead - see that file's `retryAfterMsFromError`), via the SAME
 * `pickRetryTier` fetchSourceWorker.ts exports and this file's own tiers
 * already use - reused directly rather than re-implemented, since nothing
 * about tier *selection* is fetch.source-specific.
 *
 * DELAYS CHOSEN DIFFERENTLY FROM `FETCH_SOURCE_RETRY_TIERS`, not copied
 * verbatim, for one concrete reason: by the time `scoreJobWorker.ts`'s own
 * `classify()` ever sees a retryable error, the Anthropic TypeScript SDK has
 * ALREADY retried the same request internally, with its own exponential
 * backoff, up to `maxRetries` (default 2 - retries 408/409/429/5xx and
 * connection errors; see the `claude-api` skill's `error-codes.md`) before
 * ever rejecting into this worker's `try` block. A `fetch.source` message
 * has no equivalent inner retry layer - `JobSource#search` either succeeds
 * or throws on the first real attempt - so `FETCH_SOURCE_RETRY_TIERS`'
 * shortest tier (1s) is a reasonable FIRST backoff for that message. For
 * `score.job`, a failure reaching this worker's own retry logic means a
 * SUSTAINED condition survived the SDK's own retry budget already - a 1s
 * requeue would, in the common case, just re-hit the same still-active rate
 * limit or still-down endpoint a few seconds sooner than the SDK's own last
 * internal attempt did. Starting the ladder at 5s (not 1s) reflects that:
 * there is no version of "the SDK just failed twice in the last few
 * seconds" that a 1s wait plausibly resolves.
 *
 * NOT a measured decision - this ticket makes no live Claude calls (same
 * "no fresh measurement" position `scoring.ts`'s `TYPICAL_OUTPUT_CHARS_PER_JOB`
 * update takes for an analogous reason), so there is no real corpus of
 * observed `Retry-After` values or sustained-rate-limit durations for THIS
 * app's own call volume to size these against. Anthropic's documented
 * behavior (`error-codes.md` in the `claude-api` skill: "Fix: Retry with
 * exponential backoff" for both 429 and 529) doesn't hand back a concrete
 * number either. 5s/15s/45s/120s is a reasoned starting ladder - roughly
 * 3x per tier, four tiers - not a measured one: revisit with real
 * `Retry-After` / sustained-condition data once this worker is actually
 * wired to run against production traffic (see the scoring worker's own
 * ticket 4065511 report for the still-open spend-guard gap this shares a
 * "not yet exercised against real traffic" status with).
 *
 * The top (120s) tier exists for the same reason `FETCH_SOURCE_RETRY_TIERS`'
 * 60s tier does: so `pickRetryTier`'s `desiredDelayMs` path (driven by a
 * real `Retry-After` header, when Anthropic sends one) has somewhere to
 * land other than clamping down to 45s and burning an attempt on a
 * near-certain repeat 429. The default `maxAttempts` (4, matching
 * fetchSourceWorker.ts's own default) reaches at most the 45s tier via
 * plain attempt-number escalation (attempt 2 -> 5s, attempt 3 -> 15s,
 * attempt 4 -> 45s) - the 120s tier is reached only when a real
 * `Retry-After` asks for it, exactly like fetch.source's 60s tier.
 */
export const SCORE_JOB_RETRY_TIERS: ReadonlyArray<{
  readonly queue: string;
  readonly delayMs: number;
}> = [
  { queue: "score.job.retry.5s", delayMs: 5_000 },
  { queue: "score.job.retry.15s", delayMs: 15_000 },
  { queue: "score.job.retry.45s", delayMs: 45_000 },
  { queue: "score.job.retry.120s", delayMs: 120_000 },
];

export async function setupTopology() {
  const url = `amqp://${process.env.RABBITMQ_DEFAULT_USER}:${process.env.RABBITMQ_DEFAULT_PASS}@${process.env.RABBITMQ_HOST}:${process.env.RABBITMQ_PORT}`;

  const connection = await amqp.connect(url);
  const channel = await connection.createConfirmChannel();

  //the exchange every producer publishes to.
  await channel.assertExchange("jobs", "direct", { durable: true });

  //the dead letter exchange failures get republished to.
  await channel.assertExchange("jobs.dlx", "direct", { durable: true });

  //the work queue - note what its wired to on failure
  await channel.assertQueue("fetch.source", {
    durable: true,
    deadLetterExchange: "jobs.dlx",
    deadLetterRoutingKey: "fetch.source",
  });

  //the binding: exchange -> queue, for this routing key.
  await channel.bindQueue("fetch.source", "jobs", "fetch.source");

  // the dead letter queue
  await channel.assertQueue(FETCH_SOURCE_DLQ, { durable: true });
  await channel.bindQueue(FETCH_SOURCE_DLQ, "jobs.dlx", "fetch.source");

  // the retry tiers - backoff, not failure. See FETCH_SOURCE_RETRY_TIERS'
  // doc comment above for why this is one queue per delay rather than one
  // shared queue with a per-message TTL. None of these are bound to "jobs"
  // - they are never delivered by a normal consume, only ever reached via
  // the worker explicitly publishing into one, and left via TTL expiry
  // dead-lettering back to "fetch.source" above. The worker tracks the
  // attempt count itself (RabbitMQ has no built-in counter) via an
  // `x-attempt` message header and gives up - nack(msg, false, false) into
  // fetch.source.dlq above - once it's exhausted.
  for (const tier of FETCH_SOURCE_RETRY_TIERS) {
    await channel.assertQueue(tier.queue, {
      durable: true,
      messageTtl: tier.delayMs,
      deadLetterExchange: "jobs",
      deadLetterRoutingKey: "fetch.source",
    });
  }

  await channel.assertQueue(SCORE_JOB_QUEUE, {
    durable: true,
    deadLetterExchange: "jobs.dlx",
    deadLetterRoutingKey: SCORE_JOB_QUEUE,
  });

  await channel.bindQueue(SCORE_JOB_QUEUE, "jobs", SCORE_JOB_QUEUE);

  await channel.assertQueue(SCORE_JOB_DLQ, { durable: true });
  await channel.bindQueue(SCORE_JOB_DLQ, "jobs.dlx", SCORE_JOB_QUEUE);

  // The score.job retry tiers - same role as the fetch.source tiers above
  // (backoff, not failure; see SCORE_JOB_RETRY_TIERS' doc comment for why
  // the delays differ from FETCH_SOURCE_RETRY_TIERS). Not bound to "jobs" -
  // reached only via scoreJobWorker.ts explicitly publishing into one, and
  // left via TTL expiry dead-lettering back to SCORE_JOB_QUEUE above.
  for (const tier of SCORE_JOB_RETRY_TIERS) {
    await channel.assertQueue(tier.queue, {
      durable: true,
      messageTtl: tier.delayMs,
      deadLetterExchange: "jobs",
      deadLetterRoutingKey: SCORE_JOB_QUEUE,
    });
  }

  return { connection, channel };
}
