/**
 * A short-lived, in-memory, process-local record of "this source yielded
 * zero jobs passing the filter" for one EXACT (resume, criteria, source)
 * combination (ticket 447e210).
 *
 * WHY THIS EXISTS. `POST /searches/estimate` and `POST /searches` were two
 * completely independent live fetches — nothing carried the estimate's
 * per-source "this source is a dead end for this exact query" result into
 * the real search that follows it moments later, so a source the estimate
 * had just proved empty got queried live all over again during the real
 * search, for an answer the process already had. This cache is the thing
 * that carries it: `POST /searches/estimate` (routes/searches.ts) RECORDS a
 * zero here whenever one of `runDemoMatch`'s `sourceOutcomes` reports a
 * source with `survivedFilter === 0` (and `status !== "error"` — see
 * `hasZeroResult`'s doc comment for why an error is deliberately NOT a zero);
 * `POST /searches` READS it, per source, before deciding whether to publish
 * a `fetch.source` message for that source at all.
 *
 * WHY IN-MEMORY, NOT A TABLE. This is a pure optimization: a miss (process
 * restart, a second API instance, an evicted entry) costs nothing but a
 * live fetch that would have happened anyway — the exact fetch this ticket
 * exists to sometimes skip, not a fetch that must never happen. There is no
 * correctness property resting on this surviving past the process, and this
 * app runs one API process against one database (CLAUDE.md's stack table).
 * A durable table would need a migration, a cleanup job for expired rows,
 * and a query on the hot path of `POST /searches` for a signal that is only
 * ever useful for a few minutes after it's written — real machinery bought
 * for a case with no correctness stake in surviving a restart.
 *
 * WHY THE KEY IS THE ENTIRE REQUEST-LEVEL CRITERIA OBJECT, NOT A NARROWED
 * PROJECTION OF IT. The one hard requirement from the ticket is that ANY
 * difference — a different title chip, a toggled checkbox — must be a cache
 * MISS, never a stale hit. Keying on a hand-picked subset of
 * `SearchCriteria`'s fields would require this cache to independently track
 * every field `compileFilter` (sources/criteria.ts) ever reads, and a future
 * field added to `SearchCriteria` without a matching update here would
 * silently start serving stale zeros for whatever it doesn't cover. Keying
 * on the whole object side-steps that: it can never drift from what the two
 * routes actually received, because it never looks past "did the caller
 * send an identical object."
 *
 * THE SAME EXACTNESS APPLIES TO SOURCE SELECTION, NOT JUST CRITERIA (opus
 * review round 1, F2, added after this cache's first draft shipped without
 * it). `criteria` alone is not the whole query: `runDemoMatch`'s `filter`
 * runs against the UNION of every SELECTED source's jobs and ends in a
 * cross-source dedupe, so a source's `survivedFilter === 0` can be an
 * artifact of which OTHER sources were selected alongside it in that same
 * estimate, not a property of that source in isolation. `ZeroResultCacheKey`
 * therefore also carries `selectedSourceIds` — the full, exact source
 * selection the estimate or search ran with — and a zero is only ever
 * replayed for a request with the IDENTICAL selection, never a subset,
 * superset, or different one. See `ZeroResultCacheKey`'s own doc comment for
 * the concrete failure case this closes.
 */
import type { SearchCriteria } from "@app/shared";

/** What identifies one cache entry — the exact combination the ticket
 * requires: which resume, which source, the caller's FULL, unmodified
 * criteria object (`undefined` when the request omitted `criteria`
 * entirely — see `canonicalize`, which treats that the same as an explicit
 * `{}` would be treated DIFFERENTLY: an omitted `criteria` and an explicit
 * `{}` are NOT the same request and must not collide as the same key), AND
 * `selectedSourceIds` — every source id included in the SAME estimate or
 * search run as `sourceId` (order-independent; see `toCacheKey`).
 *
 * `selectedSourceIds` is load-bearing, not decoration (opus review round 1,
 * F2). `runDemoMatch`'s `filter` runs against the UNION of every selected
 * source's jobs and ends in a cross-source `${company}|${title}` dedupe
 * (criteria.ts) — so a source's `survivedFilter === 0` in one estimate is
 * NOT purely a property of `(resumeId, sourceId, criteria)` alone, it can
 * also be an artifact of which OTHER sources were selected alongside it
 * (a cross-posted job counted against a different source in the same
 * union). The queue path (`fetchSourceWorker.ts`) dedupes PER SOURCE, not
 * across the whole selection, so that same source, searched ALONE or with
 * a different selection, can genuinely have real jobs survive the filter.
 * A zero recorded under one source selection must only ever be reused by
 * a request with the IDENTICAL selection — never a subset, superset, or
 * different selection entirely. */
export type ZeroResultCacheKey = {
  resumeId: string;
  sourceId: string;
  criteria: SearchCriteria | undefined;
  selectedSourceIds: readonly string[];
};

/**
 * How long a recorded zero-result estimate stays eligible to make a real
 * search skip that source's live fetch.
 *
 * FIVE MINUTES, AND WHY THAT NUMBER, NOT LONGER OR SHORTER. The UI flow this
 * cache exists for is: the caller estimates a search, glances at the
 * resulting number, and clicks "Search" — Nicole's own framing of the
 * feature request was exactly this round trip. That gap is normally seconds,
 * generously tens of seconds if she pauses to re-read the number or tweak a
 * checkbox once or twice first — never minutes, because there is nothing to
 * do with an estimate BUT act on it or abandon it. Two failure directions,
 * weighed against that real usage pattern:
 *
 *   - TOO SHORT (say, 30 seconds) buys almost nothing: it would miss the
 *     exact case Nicole described live if she pauses even briefly — reads
 *     the estimate, thinks about it, then clicks — turning "why bother
 *     re-querying a source we just proved empty" back into exactly that.
 *   - TOO LONG (say, an hour) reuses a signal about live job-board state
 *     well past the point it can be trusted. Job postings open and close on
 *     the order of hours to days in practice (nothing in this app has ever
 *     measured a job board's postings churning meaningfully inside single-
 *     digit minutes), but "well past the point it can be trusted" does not
 *     require a measured churn rate to be a real concern — it only requires
 *     that SOME nonzero amount of time makes reuse dishonest, and an hour is
 *     unambiguously past what the described usage pattern ever needs.
 *
 * 5 minutes covers the described usage pattern (and then some, for a caller
 * who edits a couple of checkboxes before clicking search — each edit is
 * itself a NEW cache key, per `canonicalize` below, so it never wrongly
 * reuses a stale criteria's zero) while staying an order of magnitude under
 * any plausible "the postings could genuinely be different by now" window.
 * It is a judgment call, not a measurement — there is no historical churn
 * data for this app's configured sources to calibrate against — stated here
 * so a future revision has the actual tradeoff to argue with, not just a
 * bare number.
 *
 * Deliberately UNRELATED to `STALL_AFTER_MS` (routes/searches.ts, 45
 * minutes): that number bounds how long a genuinely in-flight, queue-driven
 * search may legitimately still be running before it's reported stalled.
 * This number bounds how long a FINISHED, synchronous estimate's per-source
 * verdict stays worth trusting. Different questions, coincidentally
 * addressed in the same file family — conflating them would be wrong in
 * both directions (a stalled-search window is far too long to trust a
 * cached zero; a caching window is far too short to mean anything about a
 * queue-driven run still executing).
 */
export const ZERO_RESULT_REUSE_WINDOW_MS = 5 * 60 * 1000;

type Entry = { expiresAt: number };

/**
 * Recursively sorts object keys so two criteria objects that are
 * structurally identical but were built/serialized with keys in a different
 * order hash to the same cache key. Array ELEMENT order is deliberately left
 * untouched: `titleInclude: ["a", "b"]` and `titleInclude: ["b", "a"]` stay
 * distinct keys. That's a conservative choice, not a proven-necessary one —
 * nothing in `compileFilter` treats title-phrase order as meaningful today —
 * but the ticket's own bar is "any difference is a miss, never a stale hit",
 * and erring toward more cache MISSES than the minimum necessary is exactly
 * the safe direction to err in: a miss costs one live fetch that would have
 * happened anyway, while a wrongly-collapsed hit would be silently wrong.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

function toCacheKey(key: ZeroResultCacheKey): string {
  // `criteria: undefined` -> JSON.stringify would drop the key entirely if
  // this were nested one level up, which is exactly the "undefined key
  // dropped by JSON.stringify" hazard `FetchSourceMessage.filterCriteria`'s
  // own doc comment (fetchSourceWorker.ts) already warns about elsewhere in
  // this codebase. Made explicit here as a real `null` so "no criteria in
  // the request" and "an explicit empty {}" can never collide.
  //
  // `selectedSourceIds` is sorted before joining -- unlike `criteria`'s
  // array fields (title/location phrase order is preserved deliberately,
  // see `canonicalize`), source SELECTION is a set: `["a","b"]` and
  // `["b","a"]` are the same request, and treating them as different keys
  // would just be a lower hit rate for no safety benefit, since nothing
  // about which id came first in the array affects `runDemoMatch`'s
  // cross-source union/dedupe.
  return JSON.stringify({
    resumeId: key.resumeId,
    sourceId: key.sourceId,
    criteria: key.criteria === undefined ? null : canonicalize(key.criteria),
    selectedSourceIds: [...key.selectedSourceIds].sort(),
  });
}

/**
 * The cache itself. One instance is shared across every request via
 * `registerSearchRoutes`'s default parameter (searches.ts) — a fresh
 * instance per process, exactly the "does not need to survive a restart"
 * property this module's own doc comment argues for.
 *
 * NO EVICTION SWEEP. Entries are tiny (one string key, one number) and this
 * is a single-user app with a search cadence measured in searches per
 * session, not per second — even a process left running for weeks would
 * accumulate at most a few thousand stale entries, which is not a real
 * memory concern. `hasZeroResult` opportunistically deletes an entry the
 * moment it's found expired, which is the cheap, sufficient cleanup for this
 * app's actual scale; a background sweep would be real machinery bought for
 * a problem this app doesn't have. Revisit if this ever runs multi-tenant.
 */
export class ZeroResultEstimateCache {
  readonly #entries = new Map<string, Entry>();
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(options?: { windowMs?: number; now?: () => number }) {
    this.#windowMs = options?.windowMs ?? ZERO_RESULT_REUSE_WINDOW_MS;
    this.#now = options?.now ?? Date.now;
  }

  /** Records that `key`'s source returned zero jobs passing the filter,
   * eligible for reuse until `windowMs` (constructor option, default
   * `ZERO_RESULT_REUSE_WINDOW_MS`) from now. A later `record` for the same
   * key simply overwrites the expiry — there is no count to accumulate and
   * nothing about a repeat estimate makes the earlier one more or less
   * trustworthy. */
  record(key: ZeroResultCacheKey): void {
    this.#entries.set(toCacheKey(key), { expiresAt: this.#now() + this.#windowMs });
  }

  /**
   * True when `key` has an unexpired recorded zero. Deliberately narrow:
   * this answers "is there a recent zero-result estimate for this EXACT
   * combination", never "is there a recent estimate at all" — a caller with
   * a nonzero-result estimate on file gets no special treatment here (out of
   * this ticket's scope by design — see git-bug 447e210's Context: "don't
   * try to cache/replay the actual job set an estimate found").
   */
  hasZeroResult(key: ZeroResultCacheKey): boolean {
    const cacheKey = toCacheKey(key);
    const entry = this.#entries.get(cacheKey);
    if (!entry) return false;
    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(cacheKey);
      return false;
    }
    return true;
  }
}
