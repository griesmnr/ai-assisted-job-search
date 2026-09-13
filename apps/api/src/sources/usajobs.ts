import type { Job } from "@app/shared";
import {
  AuthFailedError,
  ForbiddenError,
  MalformedResponseError,
  RateLimitedError,
  TransientSourceError,
  UnexpectedStatusError,
  type JobSource,
  type NormalizedJob,
  type SearchCriteria,
  type SkippedRecord,
  type SourceSearchResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://data.usajobs.gov/api/search";
const DEFAULT_RESULTS_PER_PAGE = 25;
// Safety valve against an infinite loop if USAJOBS ever returns a
// SearchResultCountAll that we can never catch up to (e.g. it changes
// between pages because new postings land mid-fetch). Comfortably above
// any single realistic search's result count at the default page size.
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
// Ticket d1fc9e2: `criteria.keywords` runs one fully-paginated search PER
// phrase (USAJOBS's Keyword param has no OR operator -- see
// `SearchCriteria.keywords`'s doc comment in types.ts). Capped rather than
// searching every title chip a user has (routes/searches.ts allows up to
// 20).
//
// opus review, F1 (fixed from an original 5): a per-phrase search is NOT
// "a full re-paginated USAJOBS fetch" in the sense the ticket's first
// draft feared -- it's bounded by THAT PHRASE's own real result count,
// not by `MAX_PAGES`'s 200-page ceiling. Live-measured via
// `scripts/verify-usajobs-keyword-coverage.ts` (re-run that script for
// today's numbers, since real per-phrase counts change daily): a 5-phrase
// run of realistic titles totaled under 100 requests, well under the OLD
// no-keyword path's 200 requests for a worse (unfocused) result -- unless
// a phrase's own real total is itself large (a broad phrase like
// "information technology" alone can approach the 200-page cap; see
// ticket c419a12's note on this). 10 covers the realistic range with room
// to spare:
// `resume-title-inference.ts` prompts for "3-6" titles, and a user can add
// a handful more chips by hand -- 5 was already silently dropping the
// common 6-chip case, which review F1 flagged as a real regression
// against ticket 16c824a's own rule that a cap must "never [bind]
// silently." This file has no injected logger (see `#searchMultipleKeywords`
// below for how binding is now surfaced instead), so raising the cap
// itself is the primary mitigation -- 10 real searches is still bounded,
// still far cheaper than the old unkeyworded fetch, and covers virtually
// every real chip count this app actually produces.
const MAX_KEYWORD_SEARCHES = 10;
// Moderate, not full, parallelism for the same reason ticket b681d18 chose
// 5 (not unbounded) for Greenhouse's board fan-out: each of these is a
// fully-paginated multi-request fetch against a single external API,
// heavier per-item than Greenhouse's one-request-per-board, so a lower
// concurrency here is the conservative choice pending real measurement.
const KEYWORD_SEARCH_CONCURRENCY = 3;

export type UsajobsConfig = {
  /** From `USAJOBS_API_KEY`. Sent as the `Authorization-Key` header. */
  apiKey: string;
  /** From `USAJOBS_USER_AGENT` — must be the email address registered with
   * USAJOBS. Sent as the `User-Agent` header. */
  userAgent: string;
  /** Override for testing; defaults to the real USAJOBS Search API. */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  resultsPerPage?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
};

/**
 * Reads USAJOBS credentials from the environment. Throws synchronously if
 * either is missing — this is a startup misconfiguration, not something a
 * caller should retry, so it is a plain `Error`, not a `SourceError`.
 *
 * Never logs `env`; only the two keys we need are read out of it.
 */
export function createUsajobsSourceFromEnv(env: NodeJS.ProcessEnv = process.env): UsajobsSource {
  const apiKey = env.USAJOBS_API_KEY;
  const userAgent = env.USAJOBS_USER_AGENT;
  if (!apiKey || !userAgent) {
    throw new Error(
      "USAJOBS_API_KEY and USAJOBS_USER_AGENT must both be set. " +
        "USAJOBS_USER_AGENT must be the email address registered with USAJOBS.",
    );
  }
  return new UsajobsSource({ apiKey, userAgent });
}

/**
 * Adapter for the USAJOBS public Search API
 * (https://developer.usajobs.gov/api-reference/get-search).
 *
 * Reference implementation of `JobSource` — copy this shape for the next
 * source. The pieces worth keeping: credentials + overrides in the
 * constructor's config object (never read from `process.env` inside the
 * class itself — that's `createXFromEnv`'s job, which keeps the class
 * testable without env mutation); `search()` fully paginates and returns
 * one combined result; per-record mapping failures are collected into
 * `skipped` rather than aborting the whole page; HTTP status is classified
 * into typed errors before the body is even parsed.
 */
export class UsajobsSource implements JobSource {
  readonly dataSource = "usajobs" as const;

  // Real private fields (not TS `private`) so credentials can't leak via
  // `console.log(source)`, `JSON.stringify(source)`, or a `for...in` loop —
  // all of which would still see a TS-`private` field.
  readonly #apiKey: string;
  readonly #userAgent: string;
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #resultsPerPage: number;
  readonly #maxPages: number;
  readonly #requestTimeoutMs: number;

  constructor(config: UsajobsConfig) {
    this.#apiKey = config.apiKey;
    this.#userAgent = config.userAgent;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#resultsPerPage = config.resultsPerPage ?? DEFAULT_RESULTS_PER_PAGE;
    this.#maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    // Ticket d1fc9e2: `keywords` (multiple phrases, "ANY of these") takes
    // priority over the plain single `keyword` when both are somehow
    // present -- a caller providing `keywords` has already expressed the
    // more specific intent.
    if (criteria.keywords && criteria.keywords.length > 0) {
      return this.#searchMultipleKeywords(criteria, criteria.keywords);
    }
    return this.#searchOne(criteria);
  }

  /**
   * Runs one fully-independent, fully-paginated search per phrase (bounded
   * concurrency, bounded phrase count -- see `MAX_KEYWORD_SEARCHES`/
   * `KEYWORD_SEARCH_CONCURRENCY`'s doc comments), then merges the results.
   *
   * Deduped by `externalId`: the SAME real posting can and does match more
   * than one phrase (e.g. a "Senior Software Engineer" role matches both
   * "software engineer" and "senior engineer"). Ingestion is already safe
   * without this -- `ingestJobs.ts` dedupes by `externalId` within a
   * batch on its own, specifically as a guard against exactly this kind
   * of pathological adapter response (see its own comment) -- so this
   * dedup is NOT protecting the ingestion pipeline from a crash or a
   * write conflict (an earlier version of this comment overclaimed that
   * it was; opus review F2). It's here so `jobs.length` (and the derived
   * `skipRate` below) reports the true number of DISTINCT postings this
   * adapter found, not an inflated count double-billing the same job
   * once per phrase that happened to match it -- a cleaner, more honest
   * result for any caller inspecting this adapter's own numbers, ahead
   * of whatever ingestion does with them later.
   *
   * Ticket c419a12: per-phrase failure isolation, matching Greenhouse's own
   * isolate-some/abort-others split (greenhouse.ts's `#search`) rather than
   * SmartRecruiters' catch-everything shape -- the real acceptance
   * criterion (see the ticket body, `git-bug bug show c419a12`) is
   * narrower than "return something useful no matter what fails": "one
   * phrase's TRANSIENT failure no longer discards other phrases' completed
   * results." Note "transient" -- a phrase's `TransientSourceError`,
   * `ForbiddenError` (transient WAF edge behavior, see that type's doc
   * comment), or `RateLimitedError` says nothing about whether some OTHER
   * phrase's independent request is broken too, so isolating those three
   * as a `SkippedRecord` naming the failed phrase and moving on is the
   * right degrade. `AuthFailedError`, `MalformedResponseError`, and any
   * unmapped/unexpected kind (e.g. `UnexpectedStatusError`) are different:
   * they mean either our own credentials/request are broken or USAJOBS
   * sent back something we don't know how to read at all, in a way that
   * says nothing good about the OTHER phrases either (in practice, they'll
   * fail identically, since every phrase hits the same API with the same
   * credentials) -- for those, `#searchMultipleKeywords` sets `abortError`
   * and lets the whole call reject once every worker has stopped, exactly
   * like Greenhouse's `abortError` mechanism. See the isolate/abort split
   * in the worker's catch block below for the exact boundary (opus review
   * on this ticket's first draft, B1: an earlier version of this fix
   * isolated EVERY error kind, including auth failures and malformed
   * responses -- see the `jobs.length === 0` rethrow below for why a
   * TOTAL outage made up entirely of isolated failures must still surface
   * as a real error too, not as an all-empty "0 jobs found" result).
   *
   * Before this fix (the original d1fc9e2 regression), ANY phrase throwing
   * discarded every OTHER phrase's already-completed results (opus review
   * F4 on ticket d1fc9e2, confirmed live: a reviewer's own verification
   * run hit a real transient USAJOBS socket drop mid-fetch and lost
   * multiple already-completed phrases as a result). `CompositeSource`
   * (composite.ts) only sets a source's `status: "error"` when the
   * search() PROMISE REJECTS -- so with the isolate/abort split above, a
   * genuinely fatal per-phrase failure (or a total outage across every
   * phrase) still rejects and still reaches `CompositeSource` as a real
   * failure, exactly as it did before per-phrase isolation existed; only a
   * TRANSIENT failure on a strict subset of phrases now degrades USAJOBS
   * one phrase at a time instead of discarding the whole call.
   *
   * Shared stop flag, mirroring Greenhouse's `rateLimitedBy` (ticket
   * b681d18): a `RateLimitedError` on any phrase sets `rateLimitedByPhrase`,
   * which every worker checks before claiming its NEXT phrase -- no new
   * phrase search is started once USAJOBS has told us to back off. Scoped
   * to rate-limiting ONLY, not every error kind, deliberately: a single
   * phrase's `TransientSourceError` (timeout, network blip, or -- see the
   * N5 fix below -- a socket drop mid-parse) or `ForbiddenError` (transient
   * WAF edge behavior per that type's own doc comment) says nothing about
   * whether the NEXT phrase's independent request will fail the same way,
   * so aborting the rest on one of those would throw away likely-successful
   * work for no real benefit. A 429, by contrast, is USAJOBS explicitly
   * telling us to stop, and every phrase shares the same rate limit bucket
   * (one API key) -- continuing to fire off new requests after that is
   * pure waste, exactly the case Greenhouse's flag exists for. Phrases
   * already claimed by a worker before the flag was set are allowed to
   * finish naturally (their outcome is genuine information), matching
   * Greenhouse's own documented semantics.
   *
   * Ticket 16c824a's rule ("[a cap] is reported explicitly, every single
   * time it binds -- never silent") applies to `MAX_KEYWORD_SEARCHES`
   * too (opus review F1) -- this file has no injected logger to route a
   * structured event through, so a plain `console.warn` is the
   * proportionate signal: real, visible in server logs, not silent,
   * without a wider type change to `SourceSearchResult` (used uniformly
   * by every adapter) to thread a "capped" flag all the way to the UI.
   */
  async #searchMultipleKeywords(
    criteria: SearchCriteria,
    keywords: string[],
  ): Promise<SourceSearchResult> {
    const phrases = keywords.slice(0, MAX_KEYWORD_SEARCHES);
    if (keywords.length > MAX_KEYWORD_SEARCHES) {
      console.warn(
        `USAJOBS: ${keywords.length} title keywords given, only searching the first ` +
          `${MAX_KEYWORD_SEARCHES} (MAX_KEYWORD_SEARCHES) -- dropped: ` +
          `${keywords.slice(MAX_KEYWORD_SEARCHES).join(", ")}`,
      );
    }
    const resultsByIndex: (SourceSearchResult | undefined)[] = new Array(phrases.length);
    let nextIndex = 0;
    let rateLimitedByPhrase: string | undefined;
    // Greenhouse's `abortError` (greenhouse.ts), same semantics: set only by
    // an error kind severe enough to fail the WHOLE call (see the isolate-
    // vs-abort split in the big doc comment above), checked by every worker
    // before claiming its next phrase, and rethrown unconditionally after
    // `Promise.all` below -- even if some phrases already succeeded. A
    // genuinely fatal, non-transient failure for one phrase should not be
    // hidden behind other phrases' partial results.
    let abortError: unknown;
    // The first ISOLATED (per-phrase-skip) failure seen, kept only so that
    // if literally nothing succeeds -- every phrase either isolated-failed
    // or was never attempted -- search() can rethrow a real error instead
    // of silently returning an all-empty, all-skipped success (see the
    // `jobs.length === 0` check below).
    let firstIsolatedError: unknown;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (rateLimitedByPhrase !== undefined || abortError !== undefined) return;
        const i = nextIndex;
        if (i >= phrases.length) return;
        // Claim happens synchronously, before any `await` below -- no two
        // workers can ever claim the same index, regardless of concurrency.
        nextIndex = i + 1;
        const phrase = phrases[i]!;

        try {
          resultsByIndex[i] = await this.#searchOne({ ...criteria, keyword: phrase });
        } catch (err) {
          if (
            err instanceof TransientSourceError ||
            err instanceof ForbiddenError ||
            err instanceof RateLimitedError
          ) {
            // Mirrors Greenhouse's tokenOutcomes formatting: a
            // RateLimitedError carries its `retryAfterMs` as a separate
            // field, not in `message` itself (see types.ts) -- surface it
            // here too, since it's the one piece of information most useful
            // to whoever reads this skip.
            const message = err instanceof Error ? err.message : String(err);
            const detail =
              err instanceof RateLimitedError && err.retryAfterMs !== undefined
                ? `${message} (retry after ${err.retryAfterMs}ms)`
                : message;
            resultsByIndex[i] = {
              jobs: [],
              skipped: [
                {
                  externalId: undefined,
                  reason: `USAJOBS search for title phrase "${phrase}" failed: ${detail}`,
                },
              ],
              skipRate: 1,
            };
            firstIsolatedError ??= err;
            if (err instanceof RateLimitedError) {
              rateLimitedByPhrase ??= phrase;
            }
            continue;
          }
          // AuthFailedError, MalformedResponseError, or any unmapped/
          // unexpected error kind (e.g. an UnexpectedStatusError) --
          // abort-worthy. Record which error wins (first one observed) and
          // stop THIS worker; other in-flight workers stop claiming new
          // work on their next loop iteration, matching Greenhouse's
          // `abortError` mechanism exactly.
          abortError ??= err;
          return;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(KEYWORD_SEARCH_CONCURRENCY, phrases.length) }, () => worker()),
    );

    if (abortError !== undefined) throw abortError;

    // Every phrase a worker never got around to claiming before the
    // rate-limit stop flag was set -- recorded individually, matching
    // Greenhouse's "not checked" per-token outcome, rather than silently
    // vanishing from the merged result.
    if (rateLimitedByPhrase !== undefined) {
      for (let i = 0; i < phrases.length; i++) {
        if (resultsByIndex[i] !== undefined) continue;
        resultsByIndex[i] = {
          jobs: [],
          skipped: [
            {
              externalId: undefined,
              reason:
                `USAJOBS search for title phrase "${phrases[i]}" was not attempted -- search() ` +
                `stopped issuing new phrase searches after phrase "${rateLimitedByPhrase}" was ` +
                `rate-limited (HTTP 429)`,
            },
          ],
          skipRate: 1,
        };
      }
    }

    // Deduped by externalId -- opus review F3: the OLD version deduped
    // `jobs` but pushed every sub-search's `skipped` unconditionally,
    // so the SAME unmappable posting matching N phrases counted N times
    // toward `skipRate`, which can spuriously trip
    // `fetchSourceWorker.ts`'s high-skip-rate mapper-bug alert. Skipped
    // records lack a stable identity field as clean as `NormalizedJob`'s
    // `externalId` in the general case, but `SkippedRecord.externalId`
    // (when present) is the same real id a job would have had, so
    // dedup on it exactly like `jobs` below; a record with no
    // extractable id (`externalId: undefined`) can't collide with
    // itself this way and is kept as-is.
    //
    // Re-review F3-followup (N1): jobs and skips are collected in TWO
    // separate passes, jobs first, deliberately NOT sharing one
    // seen-ids set built incrementally phrase-by-phrase. A single
    // shared set built in one pass over `resultsByIndex` in order made
    // the outcome depend on which phrase happened to run first: if
    // phrase A's copy of a posting was unmappable and got added to the
    // set before phrase B's mappable copy of the SAME posting was seen,
    // the real job from B was silently dropped as "already seen" --
    // losing a genuine job AND still reporting it as skipped. A job,
    // once found anywhere, must always win over a skip for the same
    // posting, regardless of fetch order -- so all jobs are deduped and
    // collected first, and only THEN are skips filtered against the
    // now-complete set of job ids (plus their own separate dedup set).
    // Every index is populated by this point: the worker loop above sets
    // `resultsByIndex[i]` (success or caught-error placeholder) for every
    // phrase it claims, and the rate-limit gap-fill loop above covers every
    // phrase no worker got to claim at all. Filtered with a type guard
    // (matching Greenhouse's `tokenOutcomes` filter in greenhouse.ts) rather
    // than a bare `!` non-null assertion, so a future refactor that leaves a
    // gap can't silently produce a runtime TypeError here.
    const results = resultsByIndex.filter((r): r is SourceSearchResult => r !== undefined);
    const jobs: NormalizedJob[] = [];
    const seenJobIds = new Set<string>();
    for (const result of results) {
      for (const job of result.jobs) {
        if (seenJobIds.has(job.externalId)) continue;
        seenJobIds.add(job.externalId);
        jobs.push(job);
      }
    }

    // Total-outage case: every phrase either isolated-failed or was never
    // attempted (rate-limit gap-fill) -- nothing succeeded at all. Returning
    // normally here would report this as `jobs: []`/`status: "empty"`,
    // indistinguishable from a search that genuinely matched zero postings.
    // `firstIsolatedError` is only set when at least one phrase actually
    // threw one of the isolated kinds, so a legitimate all-phrases-matched-
    // nothing search (no error ever thrown) still returns normally below.
    if (jobs.length === 0 && firstIsolatedError !== undefined) {
      throw firstIsolatedError;
    }

    const skipped: SkippedRecord[] = [];
    const seenSkipIds = new Set<string>();
    for (const result of results) {
      for (const skip of result.skipped) {
        if (skip.externalId !== undefined) {
          if (seenJobIds.has(skip.externalId)) continue;
          if (seenSkipIds.has(skip.externalId)) continue;
          seenSkipIds.add(skip.externalId);
        }
        skipped.push(skip);
      }
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;
    return { jobs, skipped, skipRate };
  }

  async #searchOne(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    let page = 1;
    let seen = 0;

    // KNOWN LIMITATION (tracked as a follow-up, not fixed here): if
    // #fetchPage throws on page N, everything normalized from pages
    // 1..N-1 is discarded along with it, since nothing is returned until
    // the loop exits normally. A RateLimitedError on a late page therefore
    // re-fetches from page 1 on the caller's retry, which both wastes work
    // and worsens the exact throttling that triggered the error. Fixing
    // this means either returning partial results alongside the error or
    // making the caller resumable from a page number - deferred so as not
    // to change this ticket's return-type contract underneath the worker
    // ticket (RTK-08) that will actually call this.
    for (;;) {
      const data = await this.#fetchPage(criteria, page);
      const items = data.SearchResult.SearchResultItems;
      const totalCount = data.SearchResult.SearchResultCountAll;

      for (const item of items) {
        const result = normalizeItem(item);
        if (result.ok) {
          jobs.push(result.job);
        } else {
          skipped.push({ externalId: result.externalId, reason: result.reason });
        }
      }

      seen += items.length;

      const hasMore = items.length > 0 && seen < totalCount;
      if (!hasMore || page >= this.#maxPages) {
        break;
      }
      page += 1;
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;

    return { jobs, skipped, skipRate };
  }

  async #fetchPage(criteria: SearchCriteria, page: number): Promise<UsajobsSearchResponse> {
    const url = new URL(this.#baseUrl);
    if (criteria.keyword) url.searchParams.set("Keyword", criteria.keyword);
    if (criteria.location) url.searchParams.set("LocationName", criteria.location);
    url.searchParams.set("ResultsPerPage", String(this.#resultsPerPage));
    url.searchParams.set("Page", String(page));
    // Min (the default) omits UserArea.Details entirely, which is where
    // JobSummary/TeleworkEligible/RemoteIndicator live — without this,
    // every record fails normalization and search() returns zero jobs no
    // matter how the mapping functions below are written.
    url.searchParams.set("Fields", "Full");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        headers: {
          "Authorization-Key": this.#apiKey,
          "User-Agent": this.#userAgent,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TransientSourceError(
          `USAJOBS request timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError("USAJOBS request failed (network error)", { cause: err });
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response);
  }
}

async function parseResponse(response: Response): Promise<UsajobsSearchResponse> {
  if (response.status === 401) {
    throw new AuthFailedError(
      "USAJOBS rejected our credentials (HTTP 401). Check USAJOBS_API_KEY and USAJOBS_USER_AGENT.",
    );
  }
  if (response.status === 403) {
    // USAJOBS sits behind Akamai. A 403 here is typically Akamai blocking
    // the request (e.g. on an unrecognized User-Agent) before it ever
    // reaches the USAJOBS API, not the API itself rejecting our key — that
    // comes back as a 401 with a JSON body. See ForbiddenError's doc comment.
    throw new ForbiddenError(
      "Request was blocked with HTTP 403 (likely Akamai/WAF, not a USAJOBS auth rejection — check USAJOBS_USER_AGENT is a plausible User-Agent string).",
    );
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError("USAJOBS rate limit exceeded (HTTP 429)", retryAfterMs);
  }
  if (response.status >= 500) {
    throw new TransientSourceError(`USAJOBS server error (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `USAJOBS returned unexpected HTTP status ${response.status}`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    // Ticket c419a12, N5: a socket drop mid-parse (the connection is
    // terminated while the body is still streaming in) throws from
    // `response.json()` exactly the same way a genuinely malformed JSON
    // payload does -- both are just "the promise rejected here" from this
    // catch block's point of view. But they are not the same failure: a
    // socket drop is a transient network condition (the same request,
    // retried, has every reason to succeed) where malformed JSON is the
    // source's own, permanent bug (the identical request would produce the
    // identical broken body again). Observed for real, repeatedly, during
    // this project's own live verification runs (2 of 3 runs of
    // scripts/verify-usajobs-keyword-coverage.ts): undici raises this as a
    // `TypeError` with message `"terminated"`, `.cause.code ===
    // "UND_ERR_SOCKET"` -- see `isConnectionTerminatedError`. This
    // classification is what `#searchMultipleKeywords`'s isolate-vs-abort
    // split (see its doc comment, and the B1 fix on this same ticket)
    // actually keys off of, so misclassifying it matters concretely, not
    // just semantically: `TransientSourceError` is one of the ISOLATED
    // kinds, so a socket drop on one phrase becomes a single skipped
    // phrase and the OTHER phrases' work still returns; `MalformedResponseError`
    // is ABORT-worthy, so misclassifying a socket drop as one would fail
    // the entire multi-phrase call over what was really just one flaky
    // connection -- especially costly now that `#searchMultipleKeywords`
    // issues far more requests per user search than the old single-keyword
    // path did, so this fires often. And in the total-outage case (every
    // phrase hits a socket drop), correct classification is also what lets
    // `#searchMultipleKeywords`'s all-phrases-failed rethrow (see that
    // check) surface a `TransientSourceError` rather than a
    // `MalformedResponseError` -- which is what lets a caller's retry
    // logic (fetchSourceWorker.ts's `classify()`) actually recognize this
    // as retryable and recover it, instead of writing it off as a
    // permanent, non-retryable failure.
    if (isConnectionTerminatedError(err)) {
      throw new TransientSourceError(
        "USAJOBS connection was terminated while reading the response body (socket drop) — retryable",
        { cause: err },
      );
    }
    throw new MalformedResponseError("USAJOBS response was not valid JSON", { cause: err });
  }

  return parseSearchResponseShape(body);
}

/**
 * Detects the undici "connection terminated mid-body" failure (ticket
 * c419a12, N5) — see `parseResponse`'s catch block for the full reasoning.
 * Checked two ways, either sufficient on its own, since either individual
 * signal has been observed live: the exact message undici raises
 * (`"terminated"`) and the underlying socket error code it wraps as
 * `.cause` (`UND_ERR_SOCKET`). Deliberately narrow — this must only catch
 * a genuine connection drop, never a real malformed-JSON bug, or a source
 * data problem would start being silently retried forever instead of
 * surfaced.
 */
function isConnectionTerminatedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.message === "terminated") return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object" && "code" in cause) {
    return (cause as { code?: unknown }).code === "UND_ERR_SOCKET";
  }
  return false;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

// ---------------------------------------------------------------------------
// USAJOBS response shape — only the fields this adapter reads. USAJOBS'
// actual payload has many more fields (UserArea.Details alone has ~30); we
// deliberately type only what we consume.
// ---------------------------------------------------------------------------

type UsajobsSearchResponse = {
  SearchResult: {
    SearchResultCountAll: number;
    SearchResultItems: UsajobsSearchResultItem[];
  };
};

type UsajobsRemuneration = {
  /**
   * The machine-readable pay basis code, e.g. `"PA"` (Per Annum/Year),
   * `"PH"` (Per Hour). `Description` is the human-readable sibling (e.g.
   * `"Per Year"`) — verified against a live captured response
   * (`__fixtures__/usajobs-real-response.json`). Note `"PW"` is Piece Work,
   * not Per Week — do not add it as a hourly/salary alias.
   */
  RateIntervalCode?: string;
  Description?: string;
};

type UsajobsSchedule = {
  /**
   * Unreliable in practice: observed as `""` on some real records and
   * `"Full Time"` (space, capital T) on others in the same response, so it
   * cannot be matched as a fixed literal. `Code` is the reliable field
   * (`"1"` = Full-time, `"2"` = Part-time per USAJOBS' schedule code list)
   * — match on `Code` first and treat `Name` only as a loose fallback.
   */
  Name?: string;
  Code?: string;
};

type UsajobsDetails = {
  JobSummary?: string;
  QualificationSummary?: string;
  /** Boolean in USAJOBS' actual payload — verified against a live captured
   * response. (An earlier version of this adapter assumed "Yes"/"No"
   * strings; that was wrong and silently made every record unmappable.) */
  TeleworkEligible?: boolean;
  RemoteIndicator?: boolean;
};

type UsajobsSearchResultItem = {
  MatchedObjectId?: string;
  MatchedObjectDescriptor?: {
    PositionTitle?: string;
    PositionURI?: string;
    ApplyURI?: string[];
    OrganizationName?: string;
    DepartmentName?: string;
    PositionLocationDisplay?: string;
    PositionRemuneration?: UsajobsRemuneration[];
    PositionSchedule?: UsajobsSchedule[];
    PublicationStartDate?: string;
    PositionStartDate?: string;
    UserArea?: {
      Details?: UsajobsDetails;
    };
  };
};

function parseSearchResponseShape(body: unknown): UsajobsSearchResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("SearchResult" in body) ||
    typeof (body as Record<string, unknown>).SearchResult !== "object" ||
    (body as Record<string, unknown>).SearchResult === null
  ) {
    throw new MalformedResponseError(
      "USAJOBS response did not match the expected shape (missing SearchResult)",
    );
  }

  const searchResult = (body as { SearchResult: Record<string, unknown> }).SearchResult;
  if (!Array.isArray(searchResult.SearchResultItems)) {
    throw new MalformedResponseError(
      "USAJOBS response did not match the expected shape (SearchResult.SearchResultItems is not an array)",
    );
  }
  if (typeof searchResult.SearchResultCountAll !== "number") {
    throw new MalformedResponseError(
      "USAJOBS response did not match the expected shape (SearchResult.SearchResultCountAll is not a number)",
    );
  }

  return body as UsajobsSearchResponse;
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(item: UsajobsSearchResultItem): NormalizeResult {
  // USAJOBS' own permalink for a posting is
  // https://www.usajobs.gov/job/{MatchedObjectId} — this is the durable
  // identifier USAJOBS itself uses to address a specific announcement, so
  // it is what we key on for (dataSource, externalId) stability. It is
  // *not* PositionID (the agency's human-readable announcement number,
  // e.g. "ST-12345-25-AB"): agencies reuse announcement numbers across
  // reposted or amended vacancies, which would violate our uniqueness
  // assumption. MatchedObjectId is unique per announcement instance and
  // does not change on repeated fetches of the same still-open posting.
  const externalId = item.MatchedObjectId;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing MatchedObjectId" };
  }

  const d = item.MatchedObjectDescriptor;
  if (!d) {
    return { ok: false, externalId, reason: "missing MatchedObjectDescriptor" };
  }

  const title = d.PositionTitle;
  if (!title) {
    return { ok: false, externalId, reason: "missing PositionTitle" };
  }

  const company = d.OrganizationName ?? d.DepartmentName;
  if (!company) {
    return { ok: false, externalId, reason: "missing OrganizationName and DepartmentName" };
  }

  const description = d.UserArea?.Details?.JobSummary || d.UserArea?.Details?.QualificationSummary;
  if (!description) {
    return {
      ok: false,
      externalId,
      reason: "no description text available (UserArea.Details.JobSummary/QualificationSummary)",
    };
  }

  const linkToApply = d.ApplyURI?.[0] || d.PositionURI;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing ApplyURI and PositionURI" };
  }

  const postedAtRaw = d.PublicationStartDate ?? d.PositionStartDate;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing PublicationStartDate and PositionStartDate" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable posted date "${postedAtRaw}"` };
  }

  const payType = mapPayType(d.PositionRemuneration);
  if (!payType) {
    const entry = d.PositionRemuneration?.[0];
    return {
      ok: false,
      externalId,
      reason: `cannot determine payType from RateIntervalCode "${entry?.RateIntervalCode ?? "(none)"}" (Description "${entry?.Description ?? "(none)"}")`,
    };
  }

  const commitment = mapCommitment(d.PositionSchedule);
  if (!commitment) {
    const entry = d.PositionSchedule?.[0];
    return {
      ok: false,
      externalId,
      reason: `cannot determine commitment from PositionSchedule Code "${entry?.Code ?? "(none)"}" (Name "${entry?.Name ?? "(none)"}")`,
    };
  }

  const locationType = mapLocationType(d.UserArea?.Details);
  if (!locationType) {
    return {
      ok: false,
      externalId,
      reason:
        "cannot determine locationType (UserArea.Details.RemoteIndicator/TeleworkEligible absent or ambiguous)",
    };
  }

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "usajobs",
      title,
      description,
      company,
      payType,
      commitment,
      locationType,
      location: d.PositionLocationDisplay,
      linkToApply,
      postedAt,
    },
  };
}

/**
 * Only USAJOBS' two unambiguous annual/hourly codes map. Everything else
 * (Per Day, Biweekly, Piece Work, Without Compensation, ...) genuinely could
 * be either "hourly" or "salary" depending on the position, and Job#payType
 * has no third option — so we surface it as unmappable instead of guessing.
 *
 * Matches on `RateIntervalCode` (machine-readable, e.g. `"PA"`) first, and
 * falls back to the human-readable `Description` sibling (e.g. `"Per
 * Year"`) only if the code isn't one we recognize — some records may use a
 * code we haven't seen but still spell out an unambiguous description.
 */
function mapPayType(remuneration: UsajobsRemuneration[] | undefined): Job["payType"] | undefined {
  const entry = remuneration?.[0];
  if (!entry) return undefined;

  if (entry.RateIntervalCode === "PA") return "salary";
  if (entry.RateIntervalCode === "PH") return "hourly";

  if (entry.Description === "Per Year") return "salary";
  if (entry.Description === "Per Hour") return "hourly";

  return undefined;
}

/**
 * `PositionSchedule.Name` is unreliable in practice — observed empty on
 * some real records and inconsistently cased/spaced on others in the same
 * response — so it cannot be matched as a fixed literal. `Code` is the
 * reliable field (`"1"` = Full-time, `"2"` = Part-time); `Name` is only
 * used as a loose fallback when `Code` is absent or unrecognized. Codes
 * beyond full/part-time (e.g. "4" Intermittent, "6" Multiple Schedules)
 * are left unmapped rather than guessed. USAJOBS postings are federal
 * *employment*, never a contractor engagement, so "contract" is never
 * produced by this adapter.
 */
function mapCommitment(schedule: UsajobsSchedule[] | undefined): Job["commitment"] | undefined {
  const entry = schedule?.[0];
  if (!entry) return undefined;

  if (entry.Code === "1") return "full-time";
  if (entry.Code === "2") return "part-time";

  const name = entry.Name?.trim().toLowerCase();
  if (name === "full-time" || name === "full time") return "full-time";
  if (name === "part-time" || name === "part time") return "part-time";

  return undefined;
}

/**
 * USAJOBS has no single clean tri-state remote/onsite/hybrid field. We
 * combine the two closest signals, both booleans: `RemoteIndicator` (flags
 * fully remote postings) and `TeleworkEligible` (whether the position
 * allows some telework). Presence is checked explicitly first — a missing
 * signal must fall out through one clearly-named branch, not by silently
 * failing to match three separate strict-equality checks.
 */
function mapLocationType(details: UsajobsDetails | undefined): Job["locationType"] | undefined {
  if (details === undefined) return undefined;

  const { RemoteIndicator, TeleworkEligible } = details;
  if (RemoteIndicator === undefined || TeleworkEligible === undefined) return undefined;

  if (RemoteIndicator) return "remote";
  if (TeleworkEligible) return "hybrid";
  return "onsite";
}
