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
 * Source-search deadline (ticket 491cd88): `source.search()` runs under
 * `channel.prefetch(1)` (see `startFetchSourceWorker`) with no timeout of
 * its own — a delivery stays unacked, and this consumer processes nothing
 * else, for as long as `search()` takes. A source slow enough (measured:
 * SmartRecruiters against a large board) can run past RabbitMQ's own
 * consumer ack timeout, which force-closes the CHANNEL rather than failing
 * the message.
 *
 * CORRECTION (adversarial review, ticket 491cd88, F4) — this comment
 * previously said the force-close "takes every other unacked delivery on
 * that channel down with it." Under `prefetch(1)` there is at most ONE
 * unacked delivery at a time, so "every other" is zero — that phrasing
 * overstated the harm. The real harm is what `startFetchSourceWorker`'s
 * own comment already describes correctly for a different failure mode
 * (an unhandled rejection leaving a message unacked): the channel closing
 * kills the consumer registration that lives on it, and this worker goes
 * DEAF — no exception is thrown anywhere in this process, "connection up,
 * consumer registered, no errors thrown" (that comment's own words) still
 * reads healthy from the outside, but nothing is being delivered anymore.
 * What comes back looks like a dropped connection, not a slow source, and
 * (absent a supervisor that notices and restarts the process) recovers
 * only if something reconnects the channel and re-registers the consumer.
 * `withDeadline` below races `source.search()` against
 * `sourceSearchTimeoutMs` (default `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`, see
 * its own doc comment for how that value relates to the broker's actual
 * timeout) and, on expiry, throws `SourceSearchTimeoutError` — which
 * `classify()` treats as an ordinary retryable failure, riding the exact
 * same backoff-then-DLQ path as a `TransientSourceError`, so the channel
 * never has a reason to hit that 30-minute limit in the first place.
 *
 * What this does NOT fix: a timed-out message is still redelivered from
 * the top, and `source.search()` has no notion of resuming partway through
 * — a retried attempt repeats the ENTIRE fetch, same as it always has.
 * This deadline does not make that redo-from-scratch cost go away; nothing
 * in this ticket adds checkpointing. What it changes is what happens
 * around that repeat: before this, the failure mode was an *implicit*
 * broker-side channel drop — outside this worker's own attempt counting,
 * arriving with none of `pickRetryTier`'s deliberate backoff (a
 * broker-requeued message goes straight back onto `fetch.source`, not
 * through a retry tier), and risking the deaf-consumer wedge described
 * above. After this, the same slow-source condition is an *explicit*
 * failure this worker recognizes, backs off, bounds to `maxAttempts`
 * attempts, and eventually dead-letters — the identical, accounted-for
 * path every other retryable failure already takes. Paired with
 * `maxPostings` (smartrecruiters.ts), which bounds what one attempt's
 * "from scratch" actually costs, the net effect is that a slow source now
 * fails predictably and boundedly instead of unpredictably and, in the
 * worst case, without limit. It is a faster, safer failure — not a
 * cheaper one. (It does, however, mean a chronically slow/hung source now
 * burns up to `maxAttempts x sourceSearchTimeoutMs` — at the defaults,
 * 4 x 10min = 40 minutes — of this single `prefetch(1)` consumer's time
 * before dead-lettering, worse in wall-clock than the ~12 minutes-then-
 * channel-drop it replaces. Defensible: bounded and accounted-for beats
 * unpredictable, but see `SourceSearchTimeoutError`'s doc comment for why
 * NOT every one of those attempts is necessarily doing useful work, and
 * whether a hung-forever source deserves the full retry budget is worth
 * revisiting.)
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

/** Caps how many individual `SkippedRecord.reason` lines this worker logs
 * per message (see the "log skip reasons" block in the handler below,
 * ticket 491cd88 F2). Not unbounded: some adapters can legitimately
 * return hundreds of per-record skips in one `result.skipped`, and
 * logging every one of those on every message would flood whatever this
 * worker's `log` hook writes to. 20 is enough to see a real pattern (or
 * the one truncation record a capped SmartRecruiters search produces)
 * without turning a single message into a wall of log lines; anything
 * past the cap is summarized as a count instead of dropped silently. */
const SKIPPED_LOG_LIMIT = 20;

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

/** `source.search()` did not settle within `sourceSearchTimeoutMs` (see
 * `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`). Thrown by THIS WORKER, not by the
 * adapter - `JobSource#search` has no cancellation signal in its
 * interface, so the original call is simply abandoned, not stopped; it
 * keeps running as an ORPHAN in the background, and whatever it
 * eventually resolves or rejects with is discarded.
 *
 * CORRECTION (adversarial review, ticket 491cd88, F3) — this comment used
 * to wave that orphan away as "bounded, in practice, by whatever
 * per-request timeout the adapter itself uses internally." That is an
 * ASSUMPTION ABOUT ADAPTERS, not something `withDeadline` enforces - and
 * this deadline is deliberately generic, wrapping every dispatched
 * source, not only ones with a well-behaved internal timeout. Measured
 * directly against the real SmartRecruitersSource (a probe forcing the
 * deadline to fire mid-fetch): at the moment the deadline expired, 85
 * detail requests had been issued; 1,500ms later, 400 had been issued -
 * 315 MORE went out after this worker had already given up on the call
 * and moved on to retrying/dead-lettering the message. Peak concurrent
 * in-flight requests briefly went from the adapter's configured 5 to 10,
 * when the RETRY's own 5 concurrent requests overlapped the still-running
 * orphan's - which contradicts smartrecruiters.ts's own declared,
 * measured invariant ("peak in-flight verified at exactly 5") and was
 * undocumented anywhere before this note.
 *
 * For SmartRecruiters specifically this stays bounded: its detail
 * fan-out is a finite loop with its own 15s-per-request timeout
 * (`requestTimeoutMs`), so at most one orphaned attempt can ever overlap
 * one live attempt before the orphan finishes settling on its own. That
 * is a property of THIS adapter's own internal timeout, not of
 * `withDeadline` - a source whose underlying calls can hang indefinitely
 * (no internal timeout, or a bug that leaves a promise permanently
 * pending) has NOTHING here stopping its orphans from accumulating: every
 * timed-out attempt on every retried message leaves one more orphan
 * running forever, so a chronically slow queue can retain up to
 * `maxAttempts` orphans PER MESSAGE still in flight - O(maxAttempts x
 * queued messages), not O(maxAttempts) - none of them ever cancelled,
 * all of them still holding whatever connections/memory they acquired.
 * The real fix is threading an `AbortSignal` through `JobSource#search`
 * so a timeout can actually stop the call, not just stop waiting on it;
 * that's a breaking interface change across all five adapters and gets
 * its own ticket.
 *
 * Retryable: nothing here proves the source can never finish, only that
 * it didn't finish in time, the same posture `TransientSourceError`
 * takes - but this is deliberately NOT a `SourceError` subclass, since
 * the source itself reported nothing; this is a worker-imposed policy on
 * top of a source that may otherwise be healthy. See the module doc
 * comment's "Source-search deadline" section for why this exists and what
 * it does and does not fix about repeated work on retry. */
export class SourceSearchTimeoutError extends Error {}

/**
 * How long one `source.search()` call is allowed to run before this
 * worker gives up on it explicitly, rather than letting RabbitMQ's own
 * consumer ack timeout force-close the channel out from under it.
 *
 * Not guessed: this project's `docker-compose.yml` sets no
 * `consumer_timeout` (no `rabbitmq.conf` is mounted into the `rabbitmq`
 * service either), so the broker - `rabbitmq:3.13.7-management` - runs on
 * its own documented default, 30 minutes (1,800,000ms;
 * https://www.rabbitmq.com/docs/3.13/consumers). Past that, under
 * `prefetch(1)` (see `startFetchSourceWorker`) there is at most one
 * unacked delivery to begin with, but the broker still force-closes the
 * CHANNEL with a 406 PRECONDITION_FAILED - killing the consumer
 * registration that lives on it and leaving this worker deaf (see the
 * module doc comment's "Source-search deadline" section for the corrected
 * description of that harm) - which is precisely the failure ticket
 * 491cd88 measured against a real SmartRecruiters board (BoschGroup: ~12
 * minutes for a real search, ~2.5 hours at the adapter's own configured
 * pagination ceiling before its `maxPostings` cap existed).
 *
 * Set well under that 30-minute limit, not up against it, for two reasons:
 * (1) `source.search()` is not the only work holding this delivery
 * unacked - `ingestJobsForSearch` and the score.job publish/confirm that
 * follow it (see `createFetchSourceHandler`) run AFTER `search()` returns,
 * inside the SAME unacked window, and need their own headroom; (2) margin
 * for scheduler/network jitter on top of the deadline timer itself. 10
 * minutes leaves 3x headroom under the broker's limit for that. It is
 * still generous per search: at SmartRecruiters' own measured rate
 * (0.148s/posting at `detailConcurrency: 5` - see smartrecruiters.ts),
 * 10 minutes bounds roughly 4,000 total detail fetches, well above what a
 * `maxPostings`-capped company search needs (smartrecruiters.ts's default
 * cap is sized to finish in ~148s on its own).
 *
 * Deliberately generic, not SmartRecruiters-specific: this wraps
 * `source.search()` for every dispatched source (see `sources` on
 * `FetchSourceWorkerOptions`), not just SmartRecruiters - any adapter
 * could in principle hang or run long enough to reproduce the same
 * channel-drop failure mode; SmartRecruiters is the adapter that surfaced
 * it, not the only one this protects.
 */
export const DEFAULT_SOURCE_SEARCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Races `promise` against a `timeoutMs` timer, rejecting with
 * `SourceSearchTimeoutError` if the timer wins. Does not, and cannot,
 * cancel `promise` - see `SourceSearchTimeoutError`'s doc comment. Safe
 * against an unhandled rejection from the "losing" promise: `Promise.race`
 * attaches its own `.then`/`.catch` to every promise passed to it,
 * including ones whose outcome it ends up discarding, so a later
 * rejection from `promise` after the timer has already won is still a
 * "handled" rejection as far as Node is concerned. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, describe: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SourceSearchTimeoutError(`${describe} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  /** How long a single `source.search()` call is allowed to run before
   * this worker fails it explicitly (`SourceSearchTimeoutError`, retried
   * like any other transient failure) instead of letting RabbitMQ's own
   * consumer ack timeout drop the channel out from under it. Defaults to
   * `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`; see that constant's doc comment
   * for how the default was chosen and the module doc comment's
   * "Source-search deadline" section for what this does and doesn't fix. */
  sourceSearchTimeoutMs?: number;
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
  if (err instanceof SourceSearchTimeoutError) {
    // Retryable, same posture as TransientSourceError - see this class's
    // own doc comment for why it's a distinct kind rather than folded into
    // "unknown" below.
    return { retryable: true, kind: "source-search-timeout" };
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
    sourceSearchTimeoutMs = DEFAULT_SOURCE_SEARCH_TIMEOUT_MS,
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

      const result = await withDeadline(
        source.search(message.criteria),
        sourceSearchTimeoutMs,
        `source.search() for sourceId "${message.sourceId}" (search "${message.searchId}")`,
      );

      // Log every SkippedRecord.reason at this worker boundary (ticket
      // 491cd88, F2). Without this, `skipped[].reason` - the ONLY place a
      // truncated/partial result (SmartRecruiters' `maxPostings`, an
      // unrecognized company identifier, a malformed record, ...) says so
      // in human-readable form - reaches nowhere: it isn't logged,
      // persisted, or returned to `ingestJobsForSearch`'s caller, and
      // `skipRate` alone doesn't reliably surface it either (a single
      // truncation record diluted into a large `jobs` count can read as a
      // healthy, unremarkable skipRate well under `highSkipRateThreshold`
      // - e.g. 1 truncation record against 1,000 successfully-fetched
      // jobs is skipRate 0.001). This is a minimum fix, not the complete
      // one: it makes the reason text greppable in whatever this worker's
      // `log` hook writes to, not a structured, machine-readable signal a
      // caller could branch on without regexing prose - that's a separate,
      // larger change (a discriminator on `SkippedRecord` itself, touching
      // `types.ts` and all five adapters) tracked as its own ticket.
      if (result.skipped.length > 0) {
        const toLog = result.skipped.slice(0, SKIPPED_LOG_LIMIT);
        for (const skip of toLog) {
          log(
            `[fetch.source] skipped record: source=${message.sourceId} ` +
              `search=${message.searchId} externalId=${skip.externalId ?? "(none)"} ` +
              `reason=${skip.reason}`,
          );
        }
        const remaining = result.skipped.length - toLog.length;
        if (remaining > 0) {
          log(
            `[fetch.source] ...and ${remaining} more skipped record(s) for ` +
              `source=${message.sourceId} search=${message.searchId} not individually logged ` +
              `(capped at ${SKIPPED_LOG_LIMIT} per message - see SKIPPED_LOG_LIMIT).`,
          );
        }
      }

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
