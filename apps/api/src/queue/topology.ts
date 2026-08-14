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
 * `RateLimitedError.retryAfterMs`, by that instead). Each tier's
 * `deadLetterExchange`/`deadLetterRoutingKey` sends an expired message back
 * to the "jobs" exchange under the "fetch.source" routing key - i.e. back
 * into the work queue below for another attempt - the same DLX mechanism
 * used everywhere else in this file, just pointed at a work queue instead
 * of a dead-letter queue.
 */
export const FETCH_SOURCE_RETRY_TIERS: ReadonlyArray<{
  readonly queue: string;
  readonly delayMs: number;
}> = [
  { queue: "fetch.source.retry.1s", delayMs: 1_000 },
  { queue: "fetch.source.retry.2s", delayMs: 2_000 },
  { queue: "fetch.source.retry.4s", delayMs: 4_000 },
  { queue: "fetch.source.retry.8s", delayMs: 8_000 },
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
  await channel.assertQueue("fetch.source.dlq", { durable: true });
  await channel.bindQueue("fetch.source.dlq", "jobs.dlx", "fetch.source");

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

  await channel.assertQueue("score.job", {
    durable: true,
    deadLetterExchange: "jobs.dlx",
    deadLetterRoutingKey: "score.job",
  });

  await channel.bindQueue("score.job", "jobs", "score.job");

  await channel.assertQueue("score.job.dlq", { durable: true });
  await channel.bindQueue("score.job.dlq", "jobs.dlx", "score.job");

  return { connection, channel };
}
