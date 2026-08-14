import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { ingestJobsForSearch } from "../ingest/ingestJobs.js";
import { SourceError, type JobSource, type SearchCriteria } from "../sources/types.js";

/**
 * The fetch.source worker: consumes one message per (search, source) pair,
 * calls the matching adapter, persists whatever it found idempotently
 * (ingestJobsForSearch, ticket 6bf2196), and publishes one score.job
 * message per job that was newly inserted - never for a job this or an
 * earlier search already ingested, since that job was already scored.
 *
 * Message shapes (JSON bodies on the "jobs" exchange):
 *
 *   fetch.source: { searchId: string; sourceId: string; criteria: SearchCriteria }
 *     - sourceId is a Job["dataSource"] value ("usajobs", "wa-state", ...)
 *       and is how this worker dispatches to the right adapter.
 *
 *   score.job: { jobId: string }
 *     - one per newly-ingested job. The scoring worker (RTK-10, out of
 *       scope here) is responsible for its own idempotency on redelivery.
 *
 * Retry/DLQ: see topology.ts for the queue wiring this relies on
 * (fetch.source -> fetch.source.retry -> back to fetch.source, or ->
 * fetch.source.dlq). This module owns the *decision* of which path a
 * failure takes; topology.ts owns the broker-side plumbing that makes the
 * decision effective.
 */

export const JOBS_EXCHANGE = "jobs";
export const FETCH_SOURCE_QUEUE = "fetch.source";
export const FETCH_SOURCE_RETRY_QUEUE = "fetch.source.retry";
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

export type HighSkipRateInfo = {
  searchId: string;
  sourceId: string;
  skipRate: number;
  jobCount: number;
  skippedCount: number;
};

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
  /** Backoff, in ms, before the Nth attempt (N >= 2) is redelivered.
   * Defaults to exponential (1s, 2s, 4s, ...). Overridable so tests don't
   * have to wait on real-world backoff. */
  backoffMs?: (attempt: number) => number;
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

function defaultBackoffMs(attempt: number): number {
  // Backoff before attempt N (N >= 2): 1s, 2s, 4s, 8s, ... Generous enough
  // to ride out a rate-limit window; bounded by maxAttempts so "back off
  // and retry" can never become "retry forever".
  return 1000 * 2 ** (attempt - 2);
}

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
    backoffMs = defaultBackoffMs,
    highSkipRateThreshold = 0.5,
    onHighSkipRate = defaultOnHighSkipRate,
    log = (message: string) => console.error(message),
  } = options;

  return async function handleFetchSourceMessage(msg: ConsumeMessage): Promise<void> {
    const attempt = getAttempt(msg);

    try {
      const message = parseFetchSourceMessage(msg.content);

      const source = sources[message.sourceId];
      if (!source) {
        throw new UnknownSourceError(`no adapter registered for sourceId "${message.sourceId}"`);
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

      const { newlyInsertedJobIds } = await ingestJobsForSearch(
        db,
        message.searchId,
        message.sourceId,
        result.jobs,
      );

      for (const jobId of newlyInsertedJobIds) {
        const payload: ScoreJobMessage = { jobId };
        channel.publish(
          JOBS_EXCHANGE,
          SCORE_JOB_ROUTING_KEY,
          Buffer.from(JSON.stringify(payload)),
          { persistent: true, contentType: "application/json" },
        );
      }
      if (newlyInsertedJobIds.length > 0) {
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
      const delayMs = backoffMs(nextAttempt);
      log(
        `[fetch.source] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} ` +
          `- retrying (attempt ${nextAttempt}) in ${delayMs}ms`,
      );

      channel.sendToQueue(FETCH_SOURCE_RETRY_QUEUE, msg.content, {
        persistent: true,
        contentType: msg.properties.contentType,
        expiration: String(Math.max(0, Math.trunc(delayMs))),
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

/** Starts consuming fetch.source with the given options. Returns the
 * consumer tag so a caller can `channel.cancel(tag)` to stop (used by
 * tests to tear down cleanly between cases sharing one queue). */
export async function startFetchSourceWorker(
  options: FetchSourceWorkerOptions,
  consumeOptions?: { prefetch?: number },
): Promise<string> {
  const handler = createFetchSourceHandler(options);
  await options.channel.prefetch(consumeOptions?.prefetch ?? 1);
  const { consumerTag } = await options.channel.consume(FETCH_SOURCE_QUEUE, (msg) => {
    if (!msg) return; // consumer was cancelled server-side
    void handler(msg);
  });
  return consumerTag;
}
