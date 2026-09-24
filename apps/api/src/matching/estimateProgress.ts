/**
 * A short-lived, in-memory, per-request progress record for
 * `POST /searches/estimate` (ticket bf2dd0a).
 *
 * WHY THIS EXISTS. `POST /searches/estimate` is deliberately synchronous
 * (design c54b9e0 §9, and routes/searches.ts's own module doc comment) — it
 * spends no Claude money, it must return the final number in one HTTP
 * response, and making it async just to report progress would mean building
 * completion detection for a free operation, the exact thing that design
 * decision explicitly rejects. But the wait itself is real: Greenhouse alone
 * fetches 25 board tokens 5-at-a-time with up to a 15s timeout each, and a
 * caller staring at a bare spinner for a minute-plus can't tell "still
 * working" from "hung" — Nicole, live, after watching an estimate sit for 3+
 * minutes: "I don't know if I sent you on any of this."
 *
 * THE FIX: an ADDITIONAL, OPTIONAL side channel, not a replacement for the
 * blocking call. The frontend mints a request id BEFORE firing
 * `POST /searches/estimate` and sends it along as `estimateRequestId`; the
 * route calls `start()` with that id and this run's full source list the
 * moment it knows them (before `runDemoMatch` is even called), and
 * `CompositeSource`'s per-source settle hook (`onSourceSettled`, threaded
 * through `runDemoMatch` — see that option's doc comment in pipeline.ts)
 * calls `markSourceSettled()` the instant each source's own fetch resolves,
 * not when the whole fan-out finishes. The frontend polls
 * `GET /searches/estimate/:requestId/progress` on its own timer WHILE the
 * blocking POST is still in flight — a plain read of this map, nothing more.
 * The POST call's own completion contract is completely unchanged by any of
 * this: it still returns the final `EstimateSearchResponse` synchronously,
 * in one response, exactly as before this ticket. A caller that never sends
 * `estimateRequestId` costs this module nothing — `markSourceSettled` on an
 * id nobody `start()`-ed is a silent no-op (see its own comment).
 *
 * WHY IN-MEMORY, NOT A TABLE OR A QUEUE — the same reasoning as
 * `zeroResultCache.ts` (ticket 447e210), which this module deliberately
 * mirrors in shape and doc-comment style. A miss (process restart, an
 * expired/evicted entry, two API instances) costs nothing but a caller
 * seeing a bare spinner instead of a number — the exact, harmless fallback
 * this ticket started from, not a correctness gap. Nothing about pricing or
 * spend reads this map; it is pure bookkeeping for a progress bar. A durable
 * table or a queue would be real machinery bought for a signal that only
 * ever needs to survive a few minutes on one process — this app's whole
 * stack is one API process, one database (CLAUDE.md's stack table).
 *
 * WHY POLLING, NOT SSE — both were explicitly on the table (ticket bf2dd0a's
 * own Notes). Polling wins here because this app ALREADY polls
 * `GET /searches/:id` for the real, async search path (design c54b9e0 §6),
 * so a second, near-identical poll loop for the synchronous estimate path
 * reuses a pattern the frontend and this codebase's reviewers already
 * understand, rather than introducing the one and only streaming connection
 * in the app for a single lightweight progress bar. Fastify has no built-in
 * SSE primitive here, so SSE would mean hand-rolling chunked-response
 * keep-alives, reconnect handling, and a still-separate need to garbage-
 * collect abandoned streams — strictly more moving parts than a `Map` a
 * plain `GET` reads, for a value that changes maybe 4-8 times (one per
 * configured source) over the life of one estimate. A 1-2 second poll
 * interval is imperceptible against a wait already measured in tens of
 * seconds to minutes.
 *
 * LIFECYCLE / CLEANUP. `start()` overwrites any existing entry for the same
 * id — a caller retrying with a reused id just gets a fresh record, no leak.
 * An entry is dropped once it is older than `PROGRESS_RETENTION_MS`.
 *
 * UNLIKE `ZeroResultEstimateCache.hasZeroResult`'s opportunistic
 * expire-on-read, that alone is NOT sufficient here and this module does
 * NOT rely on it exclusively (an earlier version of this comment claimed it
 * did — wrong: `zeroResultCache.ts`'s keys are canonicalized CRITERIA, which
 * genuinely repeat across estimates, so a later read re-touches and evicts
 * an old entry for free. This module's keys are `crypto.randomUUID()` — by
 * construction they never repeat, so an abandoned or already-fully-polled
 * id is NEVER read again and expire-on-read alone would let it sit in the
 * map for the rest of the process's life). `start()` therefore ALSO sweeps
 * every expired entry (not just this call's own id) each time it runs —
 * cheap, since this app's real cadence is a handful of estimates per
 * session, and it is the only method guaranteed to run once per estimate
 * regardless of whether anyone ever polls. `get()` keeps its own
 * expire-on-read too, for the ordinary case of a poll landing after
 * `PROGRESS_RETENTION_MS` on an id nothing else has touched since.
 * `PROGRESS_RETENTION_MS` is deliberately LONGER than any real estimate
 * should ever take — it exists only so a frontend poll landing just after
 * the POST resolves still sees the final `done: true` snapshot instead of a
 * 404, not to serve a long-lived read; an estimate genuinely still running
 * past it has bigger problems than a stale progress record.
 */

const PENDING = "pending" as const;
const DONE = "done" as const;

export type EstimateSourceProgress = {
  sourceId: string;
  status: typeof PENDING | typeof DONE;
};

export type EstimateProgressSnapshot = {
  requestId: string;
  total: number;
  completed: number;
  sources: EstimateSourceProgress[];
  /** True once every source this run started has settled (fetched
   * successfully or failed — `CompositeSource` reports both as "settled",
   * see its own `search()` doc comment). The blocking POST finishes at
   * essentially the same instant this flips true — scoring never happens on
   * the estimate path — but a poller can stop the instant it sees this
   * rather than waiting on the POST's own round trip. */
  done: boolean;
};

/**
 * How long a progress record stays readable after `start()` created it, and
 * how long `start()`'s own sweep (see the module doc comment's LIFECYCLE
 * section for why a sweep exists at all) lets an unpolled entry survive
 * before removing it regardless of whether anyone ever reads it. Ten
 * minutes — an order of magnitude past any estimate this app has ever
 * measured (the ticket's own worst case is "a couple of slow boards can eat
 * a minute-plus"), chosen the same judgment-call way
 * `ZERO_RESULT_REUSE_WINDOW_MS` was: generous enough that a poll landing
 * moments after the POST resolves never 404s, short enough that even an
 * abandoned, never-polled id is bounded to one process-lifetime-scale
 * window rather than living forever.
 */
export const PROGRESS_RETENTION_MS = 10 * 60 * 1000;

type Entry = {
  createdAt: number;
  /** Insertion order preserved (a `Map` iterates in insertion order) so the
   * snapshot's `sources[]` lists sources in the same order the run started
   * them, stable across repeated polls of the same id. */
  sources: Map<string, typeof PENDING | typeof DONE>;
};

/**
 * The tracker itself. One instance is shared across every request via
 * `registerSearchRoutes`'s default parameter (routes/searches.ts) — a fresh
 * instance per process, exactly like `ZeroResultEstimateCache`.
 */
export class EstimateProgressTracker {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(options?: { now?: () => number }) {
    this.#now = options?.now ?? Date.now;
  }

  /** Test-support surface only -- lets a test prove `start()`'s sweep
   * actually removed a stale entry from the underlying map, rather than
   * observing only `get()`'s own expire-on-read (which would return
   * `undefined` for an expired id either way, and so can't by itself
   * distinguish "swept proactively" from "never swept, just always lazily
   * re-checked"). Not used by any production code path. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Registers a new progress record for `requestId`, one entry per
   * `sourceIds` (this run's own resolved source list — every configured
   * source, not just the ones that end up succeeding), all starting
   * `"pending"`. Called once per `POST /searches/estimate` request that
   * supplies an `estimateRequestId`, before `runDemoMatch` is invoked, so a
   * poll landing the instant after the POST is received already sees a real
   * (all-pending) snapshot rather than a 404.
   */
  start(requestId: string, sourceIds: readonly string[]): void {
    const now = this.#now();
    // Sweeps every expired entry, not just this call's own id -- see the
    // module doc comment's LIFECYCLE section for why `get()`'s
    // expire-on-read alone doesn't bound this map's size: this method's
    // keys never repeat, so an id nobody ever polls again would otherwise
    // sit here for the rest of the process's life. Cheap at this app's real
    // scale (a handful of estimates per session), and `start()` is the one
    // call guaranteed to run once per estimate regardless of polling.
    for (const [id, entry] of this.#entries) {
      if (now - entry.createdAt > PROGRESS_RETENTION_MS) this.#entries.delete(id);
    }
    const sources = new Map<string, typeof PENDING | typeof DONE>();
    for (const sourceId of sourceIds) sources.set(sourceId, PENDING);
    this.#entries.set(requestId, { createdAt: now, sources });
  }

  /**
   * Marks one source of `requestId`'s run as settled. A silent no-op when
   * `requestId` names no tracked run (the estimate was called with no
   * `estimateRequestId`, or the record already expired) or when `sourceId`
   * isn't one of that run's own sources — deliberately never throws: this is
   * pure bookkeeping for a progress bar, and a caller (`CompositeSource` via
   * `runDemoMatch`) must never have its actual fetch/estimate work fail
   * because a progress update landed late or against a stale id.
   *
   * The `sources.has(sourceId)` check is load-bearing, not decoration (opus
   * review round 1): `Map#set` on an absent key INSERTS rather than no-ops,
   * so without this check a settle notification for a source `start()` never
   * registered for this id — e.g. two callers reusing the same client-minted
   * `requestId` for overlapping estimates — would silently inflate `total`
   * for the FIRST run's poller mid-flight instead of being the no-op this
   * method's own doc comment already promised.
   */
  markSourceSettled(requestId: string, sourceId: string): void {
    const entry = this.#entries.get(requestId);
    if (entry?.sources.has(sourceId)) entry.sources.set(sourceId, DONE);
  }

  /**
   * Reads back the current snapshot for `requestId`, or `undefined` when
   * there is no live record — never started, already past
   * `PROGRESS_RETENTION_MS`, or (opportunistically, on this same call)
   * expired and dropped. `GET /searches/estimate/:requestId/progress`
   * (routes/searches.ts) answers 404 on `undefined`: this is a side channel,
   * so "nothing to report" is an entirely normal, expected outcome for a
   * caller that never sent (or already finished polling) an estimate.
   */
  get(requestId: string): EstimateProgressSnapshot | undefined {
    const entry = this.#entries.get(requestId);
    if (!entry) return undefined;
    if (this.#now() - entry.createdAt > PROGRESS_RETENTION_MS) {
      this.#entries.delete(requestId);
      return undefined;
    }
    const sources: EstimateSourceProgress[] = [...entry.sources].map(([sourceId, status]) => ({
      sourceId,
      status,
    }));
    const completed = sources.filter((s) => s.status === DONE).length;
    return {
      requestId,
      total: sources.length,
      completed,
      sources,
      done: sources.length > 0 && completed === sources.length,
    };
  }
}
