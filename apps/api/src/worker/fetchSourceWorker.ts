import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ingestJobsForSearch } from "../ingest/ingestJobs.js";
import {
  RateLimitedError,
  SourceError,
  type JobSource,
  type SearchCriteria,
} from "../sources/types.js";
import { FETCH_SOURCE_DLQ, FETCH_SOURCE_RETRY_TIERS } from "../queue/topology.js";

/**
 * The fetch.source worker: consumes one message per (search, source) pair,
 * calls the matching adapter, persists whatever it found idempotently
 * (ingestJobsForSearch, ticket 6bf2196), and publishes one score.job
 * message per job now linked to the search - new or already known.
 *
 * Message shapes (JSON bodies on the "jobs" exchange):
 *
 *   fetch.source: { searchId: string; sourceId: string; criteria: SearchCriteria }
 *     - sourceId is a Job["dataSource"] value ("usajobs", "wa-state", ...)
 *       and is how this worker dispatches to the right adapter.
 *
 *   score.job: { jobId: string }
 *     - one per job linked to this search. NOT filtered to "rows this call
 *       happened to insert" (see the note on `newlyInsertedJobIds` below) -
 *       the scoring worker (RTK-10, out of scope here) owns deduping
 *       repeated score.job messages for a job it already scored.
 *
 * Retry/DLQ: see topology.ts for the queue wiring this relies on
 * (fetch.source -> one of the fetch.source.retry.* tiers -> back to
 * fetch.source, or -> fetch.source.dlq). This module owns the *decision*
 * of which path a failure takes; topology.ts owns the broker-side plumbing
 * that makes the decision effective.
 *
 * On `newlyInsertedJobIds` vs `linkedJobIds`: ingestJobsForSearch reports
 * both - the DB layer's distinction between "rows this call inserted" and
 * "every job this call linked to the search" is correct and useful. What
 * was wrong (caught in review) was USING `newlyInsertedJobIds` to decide
 * which jobs need a score.job message. Those two ideas only coincide on a
 * message's first, uninterrupted attempt. The moment a message is retried
 * - which is the entire reason the retry path exists - they diverge: if
 * attempt 1 inserts the job row and then fails (a publish error, a crash,
 * a dropped connection) *before* its score.job goes out, attempt 2 finds
 * the row already there, `newlyInsertedJobIds` comes back empty, and a
 * job that was never actually scored silently never gets a score.job
 * message either - total, silent loss, with the message acked as a
 * success. Publishing over `linkedJobIds` instead means a retried attempt
 * always re-publishes score.job for every job it found, at the cost of a
 * harmless duplicate message on the (rarer) case where the *entire*
 * attempt - insert *and* publish - already succeeded and only the ack was
 * lost. At-least-once delivery over score.job, with the scoring worker
 * responsible for not scoring the same job twice, is a better trade than
 * silently dropping jobs that need scoring.
 */

export const JOBS_EXCHANGE = "jobs";
export const FETCH_SOURCE_QUEUE = "fetch.source";
export const SCORE_JOB_ROUTING_KEY = "score.job";

/** RabbitMQ does not count delivery attempts for you - this header is how
 * the worker tracks it across a retry's dead-letter round trip. Absent on
 * a message's first delivery (it came straight from whatever published to
 * the "jobs" exchange, which knows nothing about retries), which is
 * treated as attempt 1. */
const ATTEMPT_HEADER = "x-attempt";

export type FetchSourceMessage = {
  searchId: string;
  sourceId: string;
  criteria: SearchCriteria;
};

export type ScoreJobMessage = {
  jobId: string;
};

/** The message body didn't parse as JSON or didn't match FetchSourceMessage.
 * Retrying will parse it identically and fail identically - not a
 * SourceError (nothing from a source adapter is involved yet), but the
 * same "give up immediately" logic applies. */
export class InvalidMessageError extends Error {}

/** sourceId named an adapter this worker process doesn't have registered.
 * A config/deploy problem, not a transient one - retrying won't add the
 * adapter. */
export class UnknownSourceError extends Error {}

/** The adapter registered under `sourceId` reports a different
 * `JobSource["dataSource"]` than the key it's registered under (e.g. a
 * copy/paste bug wiring `sources["wa-state"] = usajobsSource`). Ingesting
 * under this mismatch writes rows tagged with the adapter's *own*
 * dataSource while querying/linking under the message's `sourceId` -
 * `ingestJobsForSearch` would insert a job, then fail to find it again
 * under the wrong dataSource, link nothing, and (before this check
 * existed) that "nothing to link" silently looked like an empty search
 * rather than a config bug. Retrying changes nothing about the
 * registration, so this is not retryable. */
export class SourceMismatchError extends Error {}

export type HighSkipRateInfo = {
  searchId: string;
  sourceId: string;
  skipRate: number;
  jobCount: number;
  skippedCount: number;
};

export type RetryTier = { readonly queue: string; readonly delayMs: number };

export type FetchSourceWorkerOptions = {
  channel: ConfirmChannel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /** Adapter registry, keyed by Job["dataSource"] / sourceId. A `Partial`
   * because a worker process may not have every source's credentials
   * configured; dispatching to a missing one is an UnknownSourceError, not
   * a crash. */
  sources: Partial<Record<string, JobSource>>;
  /** Total delivery attempts (including the first) before giving up and
   * dead-lettering a retryable failure. 3-5 per ticket 568cc5f; defaults to
   * 4. */
  maxAttempts?: number;
  /** Backoff delay tiers, ordered shortest to longest, one durable queue
   * per tier. Defaults to `FETCH_SOURCE_RETRY_TIERS` from topology.ts (the
   * queues `setupTopology()` actually declares). Overridable so tests can
   * use short-lived tiers instead of waiting on real-world backoff -
   * whatever is passed here MUST already exist as a queue wired the same
   * way topology.ts wires its tiers (queue-level TTL, dead-letter back to
   * "jobs"/"fetch.source"), which `startFetchSourceWorker` checks at
   * startup (see below) rather than discovering it per-message. */
  retryTiers?: ReadonlyArray<RetryTier>;
  /** skipRate at or above this, on a non-empty result, is treated as a
   * mapper-bug/upstream-schema-change signal rather than a quiet success.
   * Defaults to 0.5. */
  highSkipRateThreshold?: number;
  /** Called (in addition to processing whatever jobs *did* map) when a
   * result's skipRate crosses highSkipRateThreshold. Defaults to a loud
   * console.error so this is never silent; inject a real alerting hook in
   * production. */
  onHighSkipRate?: (info: HighSkipRateInfo) => void;
  /** Structured-ish logging hook for retry/dead-letter decisions. Defaults
   * to console.error. */
  log?: (message: string) => void;
};

function defaultOnHighSkipRate(info: HighSkipRateInfo): void {
  console.error(
    `[fetch.source] HIGH SKIP RATE: source=${info.sourceId} search=${info.searchId} ` +
      `${info.skippedCount}/${info.jobCount + info.skippedCount} records unmapped ` +
      `(skipRate=${info.skipRate.toFixed(2)}). This usually means a mapper bug or an ` +
      `upstream schema change, not an empty search - investigate, don't ignore.`,
  );
}

export function parseFetchSourceMessage(content: Buffer): FetchSourceMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch (err) {
    throw new InvalidMessageError("fetch.source message body was not valid JSON", {
      cause: err,
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidMessageError("fetch.source message body was not a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.searchId !== "string" || body.searchId.length === 0) {
    throw new InvalidMessageError('fetch.source message missing string field "searchId"');
  }
  if (typeof body.sourceId !== "string" || body.sourceId.length === 0) {
    throw new InvalidMessageError('fetch.source message missing string field "sourceId"');
  }
  if (typeof body.criteria !== "object" || body.criteria === null) {
    throw new InvalidMessageError('fetch.source message missing object field "criteria"');
  }

  return {
    searchId: body.searchId,
    sourceId: body.sourceId,
    criteria: body.criteria as SearchCriteria,
  };
}

type Classification = { retryable: boolean; kind: string };

function classify(err: unknown): Classification {
  if (err instanceof SourceError) {
    return { retryable: err.retryable, kind: err.kind };
  }
  if (err instanceof InvalidMessageError) {
    return { retryable: false, kind: "invalid-message" };
  }
  if (err instanceof UnknownSourceError) {
    return { retryable: false, kind: "unknown-source" };
  }
  if (err instanceof SourceMismatchError) {
    return { retryable: false, kind: "source-mismatch" };
  }
  // Anything else (DB connection blip, a bug we didn't anticipate, ...) is
  // *not* assumed permanent - unlike SourceError's non-retryable kinds, we
  // have no evidence a retry is futile. But it still rides the same
  // bounded retry-then-DLQ path as everything else, so an unanticipated
  // failure mode can never spin forever the way an unconditional
  // requeue-on-any-error would.
  return { retryable: true, kind: "unknown" };
}

function getAttempt(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.[ATTEMPT_HEADER];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Picks which retry tier a message should go into next. When the failure
 * told us how long to wait (`RateLimitedError.retryAfterMs`), honor that -
 * use the shortest tier whose delay is at least that long, so the message
 * doesn't come back before the source's own rate-limit window has passed
 * (returning too early just spends an attempt on a guaranteed second 429).
 * If the source asked for longer than the longest configured tier can
 * hold, this clamps to the longest tier anyway rather than dropping the
 * message or inventing an unbounded wait - `clamped` on the return value
 * tells the caller that happened, so it can log it instead of silently
 * under-waiting. Otherwise (no `desiredDelayMs`) falls back to picking by
 * attempt number: attempt 2 -> tiers[0], attempt 3 -> tiers[1], etc.,
 * clamped to the last tier if `maxAttempts` asks for more attempts than
 * there are tiers (reusing the longest backoff rather than erroring).
 *
 * Both lookup strategies assume `tiers` is ordered shortest to longest
 * delay - sorted defensively here so a caller passing them out of order
 * (or an unordered literal) gets correct behavior instead of a silent
 * wrong pick from `Array.prototype.find`. */
export function pickRetryTier(
  tiers: ReadonlyArray<RetryTier>,
  nextAttempt: number,
  desiredDelayMs?: number,
): { tier: RetryTier; clamped: boolean } {
  if (tiers.length === 0) {
    throw new Error("pickRetryTier: no retry tiers configured");
  }
  const sorted = [...tiers].sort((a, b) => a.delayMs - b.delayMs);
  const longest = sorted[sorted.length - 1]!;

  if (desiredDelayMs !== undefined) {
    const byDesired = sorted.find((tier) => tier.delayMs >= desiredDelayMs);
    if (byDesired) return { tier: byDesired, clamped: false };
    return { tier: longest, clamped: true };
  }
  const index = Math.min(Math.max(0, nextAttempt - 2), sorted.length - 1);
  return { tier: sorted[index]!, clamped: false };
}

// Marks a channel as already having the `return` handler below attached,
// so calling createFetchSourceHandler/startFetchSourceWorker more than
// once against the same channel (every test in this file does, sharing
// one channel across many `it`s) registers the listener exactly once.
// Without this, N registrations would each independently dead-letter the
// same returned message, producing N duplicate fetch.source.dlq entries
// for one lost retry.
//
// A property tagged directly on the channel object, not a module-level
// `WeakSet<ConfirmChannel>` keyed by reference: a `WeakSet` breaks the
// moment a caller passes a *wrapped* channel (a logging/tracing/retry
// decorator - `new Proxy(channel, {...})` - is a normal pattern, and
// tests in this file do exactly that). A Proxy is a different object
// reference from the channel it wraps, so a WeakSet would consider it
// "not yet registered" every time, silently accumulating one extra
// permanent listener on the real underlying channel per distinct wrapper
// - reproduced: a test wrapping the shared channel duplicated a later
// test's DLQ entry. Reading/writing a property through an unintercepted
// Proxy trap forwards to the real target by default, so tagging the
// channel itself survives wrapping in a way a reference-keyed collection
// cannot.
const RETURN_HANDLER_ATTACHED = Symbol.for("fetchSourceWorker.retryReturnHandlerAttached");

/** Wires up the channel-level safety net for an unroutable retry publish
 * (see the `mandatory: true` comment at the sendToQueue call site below):
 * dead-letters whatever bounced back, with a log line explaining why,
 * instead of leaving it to vanish. */
function ensureRetryReturnHandler(channel: ConfirmChannel, log: (message: string) => void): void {
  const tagged = channel as ConfirmChannel & { [RETURN_HANDLER_ATTACHED]?: true };
  if (tagged[RETURN_HANDLER_ATTACHED]) return;
  tagged[RETURN_HANDLER_ATTACHED] = true;

  channel.on("return", (returned) => {
    log(
      `[fetch.source] retry publish to "${returned.fields.routingKey}" was unroutable ` +
        `(queue missing or renamed after startup?) - dead-lettering into ${FETCH_SOURCE_DLQ} instead`,
    );
    channel.sendToQueue(FETCH_SOURCE_DLQ, returned.content, {
      persistent: true,
      contentType: returned.properties.contentType,
      headers: returned.properties.headers,
    });
  });
}

/**
 * Builds the per-message handler. Exported separately from the `consume()`
 * wiring so tests can invoke it directly against a real (or fake) channel
 * and message without needing a running consumer loop.
 */
export function createFetchSourceHandler(options: FetchSourceWorkerOptions) {
  const {
    channel,
    db,
    sources,
    maxAttempts = 4,
    retryTiers = FETCH_SOURCE_RETRY_TIERS,
    highSkipRateThreshold = 0.5,
    onHighSkipRate = defaultOnHighSkipRate,
    log = (message: string) => console.error(message),
  } = options;

  ensureRetryReturnHandler(channel, log);

  return async function handleFetchSourceMessage(msg: ConsumeMessage): Promise<void> {
    const attempt = getAttempt(msg);

    try {
      const message = parseFetchSourceMessage(msg.content);

      const source = sources[message.sourceId];
      if (!source) {
        throw new UnknownSourceError(`no adapter registered for sourceId "${message.sourceId}"`);
      }
      if (source.dataSource !== message.sourceId) {
        throw new SourceMismatchError(
          `adapter registered for sourceId "${message.sourceId}" reports ` +
            `dataSource "${source.dataSource}" - refusing to ingest under a mismatched natural key`,
        );
      }

      const result = await source.search(message.criteria);

      const total = result.jobs.length + result.skipped.length;
      if (total > 0 && result.skipRate >= highSkipRateThreshold) {
        onHighSkipRate({
          searchId: message.searchId,
          sourceId: message.sourceId,
          skipRate: result.skipRate,
          jobCount: result.jobs.length,
          skippedCount: result.skipped.length,
        });
      }

      const { linkedJobIds } = await ingestJobsForSearch(
        db,
        message.searchId,
        message.sourceId,
        result.jobs,
      );

      // Publish for every job linked to this search, not just the ones
      // this particular call inserted - see the module doc comment above
      // for why. The scoring worker is responsible for not double-scoring
      // a job it's seen a score.job message for before.
      for (const jobId of linkedJobIds) {
        const payload: ScoreJobMessage = { jobId };
        channel.publish(
          JOBS_EXCHANGE,
          SCORE_JOB_ROUTING_KEY,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            contentType: "application/json",
          },
        );
      }
      if (linkedJobIds.length > 0) {
        await channel.waitForConfirms();
      }

      channel.ack(msg);
    } catch (err) {
      const { retryable, kind } = classify(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (!retryable) {
        log(
          `[fetch.source] non-retryable error (${kind}) on attempt ${attempt} - ` +
            `dead-lettering immediately without consuming a retry: ${errorMessage}`,
        );
        channel.nack(msg, false, false);
        return;
      }

      if (attempt >= maxAttempts) {
        log(
          `[fetch.source] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} ` +
            `- retries exhausted, dead-lettering`,
        );
        channel.nack(msg, false, false);
        return;
      }

      const nextAttempt = attempt + 1;
      const desiredDelayMs =
        err instanceof RateLimitedError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : undefined;
      const { tier, clamped } = pickRetryTier(retryTiers, nextAttempt, desiredDelayMs);
      log(
        `[fetch.source] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} ` +
          `- retrying (attempt ${nextAttempt}) via ${tier.queue} (${tier.delayMs}ms)` +
          (desiredDelayMs !== undefined ? ` [source requested ${desiredDelayMs}ms]` : "") +
          (clamped
            ? ` [CLAMPED: requested delay exceeds the longest configured retry tier - ` +
              `retrying sooner than the source asked for]`
            : ""),
      );

      // No per-message `expiration` here - the tier queue's own
      // queue-level TTL (see topology.ts / FETCH_SOURCE_RETRY_TIERS) is
      // what times the backoff out, precisely so messages with different
      // delays never share a queue and block each other's expiry.
      //
      // `mandatory: true` + the `channel.on("return", ...)` handler
      // registered in `createFetchSourceHandler` below: sendToQueue is
      // "publish to the default exchange, routing key = queue name" under
      // the hood, so if `tier.queue` doesn't exist - deleted, renamed, or
      // drifted from what `startFetchSourceWorker` validated at startup -
      // this would otherwise succeed silently (no consumer, no binding,
      // nothing to complain), `waitForConfirms` would resolve anyway, and
      // the message below would get acked having genuinely gone nowhere.
      // `mandatory` makes an unroutable publish come back as a `return`
      // event instead, which the handler dead-letters into
      // fetch.source.dlq rather than losing it.
      channel.sendToQueue(tier.queue, msg.content, {
        persistent: true,
        mandatory: true,
        contentType: msg.properties.contentType,
        headers: { ...msg.properties.headers, [ATTEMPT_HEADER]: nextAttempt },
      });
      await channel.waitForConfirms();
      // The original delivery is now fully handled - we've taken
      // responsibility for it by scheduling the retry copy - so it's
      // acked, not left unacked or nacked-with-requeue (which would race
      // the retry copy and could process the same attempt twice).
      channel.ack(msg);
    }
  };
}

/**
 * Starts consuming fetch.source with the given options. Returns the
 * consumer tag so a caller can `channel.cancel(tag)` to stop (used by
 * tests to tear down cleanly between cases sharing one queue).
 *
 * Two independent layers guard against a retryable failure's
 * `sendToQueue` into a tier queue silently going nowhere:
 *
 * 1. Fails fast here, before consuming a single message, if any
 *    configured retry tier queue doesn't exist yet (`channel.checkQueue`
 *    rejects - and closes the channel - when the queue is missing). This
 *    catches the common case (topology not set up before the worker
 *    starts) at boot, loudly, instead of at the first retry.
 * 2. It does NOT catch a tier queue that existed at startup and was
 *    later deleted, renamed, or otherwise drifted out from under a
 *    long-running worker - `sendToQueue` doesn't re-check existence per
 *    call. That's what `mandatory: true` on the retry publish (see
 *    `createFetchSourceHandler`) plus the `channel.on("return", ...)`
 *    handler it registers are for: an unroutable retry publish comes back
 *    as a `return` event instead of vanishing, and gets dead-lettered
 *    into fetch.source.dlq with a log line explaining why, rather than
 *    the worker acking the original message having genuinely done
 *    nothing with it.
 */
export async function startFetchSourceWorker(
  options: FetchSourceWorkerOptions,
  consumeOptions?: { prefetch?: number },
): Promise<string> {
  const retryTiers = options.retryTiers ?? FETCH_SOURCE_RETRY_TIERS;
  for (const tier of retryTiers) {
    try {
      await options.channel.checkQueue(tier.queue);
    } catch (err) {
      throw new Error(
        `startFetchSourceWorker: retry tier queue "${tier.queue}" does not exist - ` +
          `run setupTopology() (or declare it identically) before starting the worker`,
        { cause: err },
      );
    }
  }

  const handler = createFetchSourceHandler(options);
  const log = options.log ?? ((m: string) => console.error(m));
  await options.channel.prefetch(consumeOptions?.prefetch ?? 1);
  const { consumerTag } = await options.channel.consume(FETCH_SOURCE_QUEUE, (msg) => {
    if (!msg) return; // consumer was cancelled server-side
    handler(msg).catch((err: unknown) => {
      // The handler's own try/catch already turns adapter/DB/publish
      // failures into a nack or a scheduled retry - reaching here means
      // something failed *after* that decision was made (e.g. the channel
      // itself closed mid-flight, so even the ack/nack call threw) or a
      // bug nobody anticipated. Either way this promise would otherwise
      // reject unhandled: Node terminates the process on an unhandled
      // rejection by default, which would take down every other in-flight
      // message with it over one broker hiccup.
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[fetch.source] handler failed outside its own error handling: ${message} - ` +
          `attempting to dead-letter the message directly`,
      );

      try {
        // Simply logging and moving on, as an earlier version of this
        // code did, leaves the message unacked forever. Under
        // `prefetch(1)` that's not "one message lost" - it PERMANENTLY
        // WEDGES this consumer: RabbitMQ won't deliver a second message
        // to a consumer that hasn't acked its first, so the whole worker
        // silently stops making progress while everything about it
        // (connection up, consumer registered, no errors thrown) still
        // reports healthy. Try once more to get the message off this
        // channel via a direct nack straight to the DLQ.
        options.channel.nack(msg, false, false);
      } catch (nackErr) {
        // Even the nack failed - the channel itself is almost certainly
        // the problem (nack is a synchronous local call; this is the
        // realistic way it throws). Closing it is what actually
        // unwedges things: amqplib requeues whatever was left unacked on
        // a channel when it closes, and a supervisor restarting this
        // worker on a fresh connection/channel is a far better outcome
        // than a consumer that stays "up" and silently stops progressing.
        const nackMessage = nackErr instanceof Error ? nackErr.message : String(nackErr);
        log(
          `[fetch.source] nack also failed (${nackMessage}) - closing the channel so the ` +
            `message isn't held unacked forever and a supervisor can restart this worker`,
        );
        options.channel.close().catch(() => {});
      }
    });
  });
  return consumerTag;
}
