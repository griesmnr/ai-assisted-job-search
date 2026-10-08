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
// Ticket 78f48df, REVISED after opus re-review round 2 (F1, BLOCKING): an
// earlier version of this file capped title-mode searches at a fixed 5
// PAGES (125 postings). That cap is a regression against `main`, not an
// improvement -- re-review measured it live against real non-software
// professions, and this file's own re-measurement (2026-10-07/2026-10-08,
// using the real `compileFilter`, not an approximation) confirmed it:
//
//   chip               PositionTitle total  real compileFilter matches  deepest matched rank
//   Registered Nurse                  723                          215                    278
//   Program Analyst                 1,344                          147                    399
//
// Both deepest-matched ranks are past 125, so the old fixed page cap
// SILENTLY DROPPED 115 of a nurse's 215 real federal title matches (only
// 100 rank <= 125) and 73 of an analyst's 147 (only 74 rank <= 125) -- the
// ticket's own defect class (real postings that exist and are never
// fetched), reintroduced by the fix meant to cure it, on the one source
// that serves non-software users at all. Jay's resume only survived the
// old cap because his real matches happen to rank inside the first 125
// across SOME chip in his set (relying on cross-chip redundancy, not on
// matches genuinely living on page 1 -- see `#fetchPage`'s doc comment for
// the corrected claim about where Jay's matches actually rank).
//
// Re-review also established the actual cost model, which changes what the
// right fix is:
//
//   - Results are RELEVANCE-RANKED, with a stable, repeatable order.
//     Default order is byte-identical to `SortField=Relevance&
//     SortDirection=Desc`; the same page requested twice back-to-back
//     returns identical ids; the first 25 results are identical whether
//     `ResultsPerPage` is 25 or 500. This is what makes an early stop
//     principled rather than a guess: once genuine matches stop appearing,
//     later pages are reliably worse, not randomly interspersed.
//   - `ResultsPerPage` is NOT capped at 25. 500 and 1,000 both work in a
//     single response (measured; USAJOBS caps the RETURNED count at the
//     query's own `SearchResultCountAll` once that's below the requested
//     page size, it doesn't error). A single 500-per-page request does the
//     work of 20 requests at the old default.
//   - Fetch volume costs BANDWIDTH ONLY. `fetchSourceWorker` runs
//     `compileFilter` before `ingestJobsForSearch`, so a larger raw fetch
//     costs zero extra DB writes and zero extra scoring calls -- the only
//     thing a looser bound spends is HTTP request time. Given that, a page
//     cap trading real matches away to save HTTP calls is the wrong side of
//     the trade, which is exactly what the old fixed cap did.
//
// THE FIX: two independent changes, both measured, neither a guess.
//
// 1. `TITLE_SEARCH_RESULTS_PER_PAGE` (below) raises the per-request page
//    size for title-mode searches only, so a dense profession like
//    "Program Analyst" (1,344 total) completes in 3 requests instead of 54.
//
// 2. A RELEVANCE-AWARE STOP (in `#searchOne`) replaces the page-count cap:
//    keep paging while a page still contains at least one title holding
//    EVERY normalized word of the phrase (the same words actually sent to
//    `PositionTitle` -- see `#fetchPage`); stop once `TITLE_SEARCH_EMPTY_
//    PAGE_GRACE` consecutive pages hold none. Measured at
//    `ResultsPerPage=250`: both "Registered Nurse" and "Program Analyst"
//    complete via NATURAL termination well before the stop could trigger,
//    recovering every real match with zero lost. The stop only ever fires on
//    genuinely noise-dominated chips (Jay's "Technical Information
//    Specialist" and friends), where every page checked beyond the stop point
//    was independently confirmed to hold no qualifying title either.
//
//    WHY 250 AND NOT 500, measured in re-review 2026-10-08. 500 works and is
//    lossless, but it is slow and heavy: `Fields=Full` at 500 takes ~25s for
//    the BODY alone (headers arrive in ~600ms either way), and one real
//    "Contract Specialist" search took 157.8s with peak RSS 151MB. At 250 the
//    same chip took 46.5s with peak RSS 125MB -- 3.4x faster, half the
//    volume -- found the SAME 47 matches, and the stop still fired on page 3.
//    Two further reasons 250 is the better operating point: a mid-body socket
//    drop (this file documents hitting `UND_ERR_SOCKET` on 2 of 3 runs) now
//    costs a 250-posting page rather than a 500-posting one, and
//    `KEYWORD_SEARCH_CONCURRENCY = 3` means up to three bodies parse at once.
//    Safety margin DOES shrink, and re-review D3 was right to flag the
//    earlier wording ("unchanged in the way that matters") as overstating it:
//    the earliest possible stop moves from rank 1,000 to rank 500, so margin
//    over the deepest genuine match ever measured (rank 307, across seven
//    chips over three rounds) halves from ~3.3x to ~1.6x. Accepted, with the
//    reason stated rather than implied: no chip measured has ever shown a
//    genuine match REAPPEARING after an empty page, which is the only
//    distribution that a smaller page punishes. 250 was re-derived as lossless
//    from the round-2 full-scan rank data rather than assumed -- Contract
//    Specialist (deepest match rank 79), Human Resources Specialist (169) and
//    Supervisory Program Analyst (117) all stop at page 3 = 750 fetched,
//    keeping 47 / 96 / 15 matches with none lost, and Registered Nurse (724
//    total, deepest 307) still terminates naturally.
//
// End-to-end re-measurement (live, 2026-10-07/2026-10-08 -- see
// `#searchOne`'s doc comment for Jay's corrected before/after): lossless
// for "Registered Nurse" (215/215 matched, before and after) and "Program
// Analyst" (147/147), while still bounding the pure-noise blowup chips in
// Jay's own set ("Technical Documentation Specialist" stops after 2 pages /
// 1,000 postings instead of paginating its full 2,074).
//
// The stop is a HEURISTIC, not a proof: it is lossless everywhere it has
// been measured, but a chip whose only genuine matches rank beyond TWO full
// 500-item empty pages past the last hit would still lose them. No such
// case has been found in any phrase measured for this ticket -- including
// the two adversarial-review supplied specifically to break it. The
// general `#maxPages`/`DEFAULT_MAX_PAGES` safety valve still applies
// underneath this as the hard backstop against a runaway loop (now reached
// far later in absolute postings, since each page is bigger) -- see
// `#searchOne`.
const TITLE_SEARCH_RESULTS_PER_PAGE = 250;
// See the big comment above. Both professions measured for this ticket,
// including the two adversarial review supplied specifically to find a
// counterexample (Registered Nurse, Program Analyst), needed ZERO grace at
// all -- both complete via natural pagination termination before the stop
// could ever fire. 2 (not 1) keeps a full page of measured margin beyond
// every empty-page observation made for this ticket (no case ever showed a
// real match reappearing after an empty page), at the cost of at most one
// extra 500-item request for a chip whose signal is already exhausted --
// cheap, per the bandwidth-only cost model above.
const TITLE_SEARCH_EMPTY_PAGE_GRACE = 2;

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
   * responses -- see the `successCount === 0` rethrow below for why a
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
    // `successCount === 0` check below).
    let firstIsolatedError: unknown;
    // Real successes only -- NOT `jobs.length` after merging (a phrase that
    // genuinely matched zero postings still counts as a success here, and
    // must, or the total-outage check below would misfire on a healthy
    // phrase that simply found nothing). Opus re-review (c419a12, round 2):
    // an earlier version of this gated on `jobs.length === 0` post-merge,
    // which is a strictly broader condition than "nothing succeeded" -- it
    // also fires when one phrase legitimately matches zero postings while
    // another phrase fails, incorrectly rejecting a call that had one real
    // success.
    let successCount = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (rateLimitedByPhrase !== undefined || abortError !== undefined) return;
        const i = nextIndex;
        if (i >= phrases.length) return;
        // Claim happens synchronously, before any `await` below -- no two
        // workers can ever claim the same index, regardless of concurrency.
        nextIndex = i + 1;
        const phrase = phrases[i]!;

        // Re-review D1/E1/E2: a phrase with no token holding 2+ alphanumeric
        // characters is unsearchable by title (see `normalizeForTitleSearch`).
        // Sending it in any form downloads thousands of postings for zero
        // genuine matches with no early stop available. Record why and claim
        // the next phrase without issuing a request.
        //
        // Deliberately does NOT touch `successCount`. Nothing succeeded, but
        // nothing failed either, and the total-outage rethrow below
        // additionally requires `firstIsolatedError`, so an all-unsearchable
        // search returns a normal, fully-explained empty result rather than
        // throwing. Re-review E3 verified both directions through the real
        // class: ["C", "R"] returns (jobs 0, skipped 2, skipRate 1), while
        // ["C", <phrase that throws TransientSourceError>] THROWS -- correct,
        // because the only real query failed and an unsearchable phrase is no
        // evidence USAJOBS is up. Incrementing `successCount` here would make
        // that second case return an empty "ok", which is exactly the defect
        // class ticket c419a12's B1 fix exists to prevent. E3's own test pins
        // it; without that test the mutant survives all 61 others.
        //
        // This IS a behaviour change for mixed searches versus the previous
        // revision, which sent the unsearchable phrase, usually got a 200, and
        // set `successCount = 1` -- so a mixed search returned partial results
        // where it now throws and `CompositeSource` marks the source errored.
        // The new behaviour is the correct one, but it changes what the UI
        // shows for that case, which is worth knowing rather than discovering.
        if (normalizeForTitleSearch(phrase) === undefined) {
          resultsByIndex[i] = {
            jobs: [],
            skipped: [
              {
                externalId: undefined,
                reason:
                  `USAJOBS cannot search title phrase "${phrase}": no word in it holds 2 or ` +
                  `more alphanumeric characters, and USAJOBS matches PositionTitle words with ` +
                  `OR after dropping non-alphanumerics, so such a query returns thousands of ` +
                  `unrelated postings with no early stop possible (measured 2026-10-08: ` +
                  `"C" -> 3,674, "C#" -> 3,674 identically, "R" -> 2,137, "A" -> 5,037). ` +
                  `Not attempted.`,
              },
            ],
            skipRate: 1,
          };
          continue;
        }

        try {
          // asTitleSearch: true -- see the PositionTitle semantics comment
          // on #fetchPage below for why title chips go through this
          // parameter now, not Keyword.
          resultsByIndex[i] = await this.#searchOne(
            { ...criteria, keyword: phrase },
            { asTitleSearch: true },
          );
          successCount++;
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

    // Total-outage case: literally zero phrases succeeded -- every phrase
    // either isolated-failed or was never attempted (rate-limit gap-fill).
    // Gated on `successCount`, NOT `jobs.length`: a phrase that genuinely
    // matched zero postings still counts as a success, so `jobs.length ===
    // 0` would incorrectly reject a call where one phrase legitimately
    // found nothing while a DIFFERENT phrase failed -- that call has a real
    // success in it and must return normally with the failure recorded as
    // a skip, not be thrown away. `firstIsolatedError` is only set when at
    // least one phrase actually threw one of the isolated kinds, so a
    // legitimate all-phrases-matched-nothing search (no error ever thrown)
    // still returns normally below.
    if (successCount === 0 && firstIsolatedError !== undefined) {
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

  /**
   * `opts.asTitleSearch` (default `false`) selects which USAJOBS query
   * parameter `criteria.keyword` is sent on, and the page size used -- see
   * `#fetchPage`'s doc comment for the measured reasoning. Only
   * `#searchMultipleKeywords` (title chips) passes `true`; a caller
   * supplying a plain `criteria.keyword` directly (no `criteria.keywords`
   * array) gets the default full-text `Keyword` behavior, the default page
   * size, and the general `#maxPages` ceiling -- all unchanged from before
   * this ticket, and the relevance-aware early stop below never runs for
   * it.
   *
   * That last guarantee is itself a fix (ticket 78f48df, opus re-review
   * round 2, F3, must-fix): an earlier version of this method computed its
   * title-mode early-stop warning from `effectiveMaxPages`/`criteria.
   * keyword` UNCONDITIONALLY, before checking `asTitleSearch` at all. A
   * plain, keyword-less `search({})` call (reachable in production: a user
   * clears every title chip) legitimately walks all the way to the general
   * `#maxPages` (200) on a large unrestricted pool, and that path logged a
   * title-search-flavored warning naming `phrase "undefined"` and pointing
   * an operator at `TITLE_SEARCH_EMPTY_PAGE_GRACE` for a limit that was
   * actually `DEFAULT_MAX_PAGES`. Below, the entire early-stop block is
   * gated on `asTitleSearch` first, so the non-title path is byte-for-byte
   * what it was before this ticket touched the file: silent at `#maxPages`,
   * exactly as `main` has always been.
   *
   * JAY'S CASE, END TO END, CORRECTED (opus re-review round 2, F2) -- live,
   * same 10 real chips, both sides measured against the actual real
   * `createUsajobsSourceFromEnv().search()` call and the actual
   * `compileFilter`, not an approximation:
   *
   *   BEFORE (2026-10-07, unmodified `main`, Keyword):
   *     3,419 distinct postings fetched (134 skipped, 3,553 raw) / 6 matched
   *     (no location), 1 matched (Seattle). An earlier version of this
   *     comment claimed 497 fetched -- that number did not reproduce on
   *     re-measurement and was a one-off artifact of USAJOBS' pool/ranking
   *     shifting mid-fetch, not a real baseline; 3,419 is in the same range
   *     as the ticket's own originally-reported 4,255 (daily churn, not a
   *     contradiction), and is the number this file now stands behind.
   *
   *   AFTER (2026-10-08, this file, PositionTitle + the relevance-aware
   *   stop above): 2,278 distinct postings fetched (46 skipped) / 7 matched
   *     (no location -- one MORE than before: "Writer-Editor" @ Department
   *     of State, a real title match `Keyword` structurally could not
   *     find), 1 matched (Seattle).
   *
   * Ratio: ~570:1 before, ~325:1 after -- better, not worse, and gained a
   * real match besides. An earlier version of this comment also claimed
   * "every genuine hit across Jay's ten chips landed on page 1" -- re-
   * review scored every chip's own relevance-ordered list through the real
   * `compileFilter` and found genuine matches as deep as rank 264 within a
   * single chip's results. The accurate claim is narrower: every matched
   * posting was reachable within the first `TITLE_SEARCH_RESULTS_PER_PAGE`
   * results via AT LEAST ONE of Jay's ten chips -- survived by CROSS-CHIP
   * REDUNDANCY plus relevance ranking, not because matches genuinely live
   * on page 1 of every chip that finds them. That is exactly why a per-
   * phrase page cap was unsafe for a single-chip search in the first place
   * (see `TITLE_SEARCH_RESULTS_PER_PAGE`'s doc comment, and "Registered
   * Nurse"/"Program Analyst" there for the single-chip professions that
   * actually broke it).
   */
  async #searchOne(
    criteria: SearchCriteria,
    opts?: { asTitleSearch?: boolean },
  ): Promise<SourceSearchResult> {
    const asTitleSearch = opts?.asTitleSearch ?? false;
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Only meaningful in title mode -- see TITLE_SEARCH_EMPTY_PAGE_GRACE's
    // doc comment for the full reasoning behind this stop. Computed from
    // the SAME normalized phrase #fetchPage actually sends as
    // PositionTitle, so this checks against what was genuinely searched
    // for, not the raw, unnormalized chip text.
    const titleWords = asTitleSearch && criteria.keyword ? titleSearchWords(criteria.keyword) : [];
    let consecutiveEmptyPages = 0;

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
      const data = await this.#fetchPage(criteria, page, asTitleSearch);
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

      // Ticket 78f48df: relevance-aware early stop, TITLE MODE ONLY (see
      // F3 above and TITLE_SEARCH_EMPTY_PAGE_GRACE's doc comment). Gated on
      // `asTitleSearch` AND `hasMore` first -- never runs for a plain
      // Keyword search, and never runs on a page that was already the
      // natural last page (nothing would be saved by "stopping early" one
      // page before the loop was going to end anyway, and nothing should
      // be confused with the general #maxPages backstop below).
      let stoppedForNoSignal = false;
      if (asTitleSearch && titleWords.length > 0 && hasMore) {
        const pageHasGenuineMatch = items.some((item) =>
          titleHasAllWords(item.MatchedObjectDescriptor?.PositionTitle, titleWords),
        );
        if (pageHasGenuineMatch) {
          consecutiveEmptyPages = 0;
        } else {
          consecutiveEmptyPages += 1;
        }
        if (consecutiveEmptyPages >= TITLE_SEARCH_EMPTY_PAGE_GRACE) {
          stoppedForNoSignal = true;
          // Ticket 16c824a's rule applies here too: an early stop that
          // trades real postings for fewer requests must be visible, not
          // silent, even though (per measurement) it is not expected to
          // cost a real match.
          console.warn(
            `USAJOBS: title search for phrase "${criteria.keyword}" stopped early after page ` +
              `${page} (${seen} of ${totalCount} total PositionTitle matches fetched) -- the last ` +
              `${TITLE_SEARCH_EMPTY_PAGE_GRACE} consecutive pages held no title containing every ` +
              `word of the phrase. Measurement for ticket 78f48df found this reliably means the ` +
              `rest is noise from PositionTitle's OR-of-words semantics (see #fetchPage's doc ` +
              `comment), not real signal -- but see TITLE_SEARCH_EMPTY_PAGE_GRACE's doc comment ` +
              `for the heuristic's limits.`,
          );
        }
      }

      if (!hasMore || stoppedForNoSignal || page >= this.#maxPages) {
        break;
      }
      page += 1;
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;

    return { jobs, skipped, skipRate };
  }

  /**
   * TICKET 78f48df, measured live against the real API 2026-10-07 (see
   * `apps/api/src/scripts/probe-positiontitle-semantics.ts`, run then
   * deleted -- the durable record is this comment, per this repo's
   * claims-carry-their-measurement standard):
   *
   *   Keyword=Technical Writer                 ->    5
   *   PositionTitle=Technical Writer            ->   40
   *   PositionTitle=Technical Information Specialist -> 2149
   *
   * `PositionTitle` IS NOT a phrase or substring match. It is TOKEN-BASED
   * and ORs every word in the query against the title field:
   *
   *   PositionTitle=Technical             ->   37
   *   PositionTitle=Writer                ->    7
   *   PositionTitle=Technical Writer      ->   40   (~37+7, minus overlap)
   *   PositionTitle=Writer Technical      ->   40   (word order is irrelevant)
   *   PositionTitle="Technical Writer"    ->    0   (quoting is NOT exact-
   *                                                   phrase syntax -- it
   *                                                   breaks the query)
   *   PositionTitle=Technical Information Specialist -> 2149, of which the
   *       sampled titles ("VISUAL INFORMATION SPECIALIST", "ADMINISTRATIVE/
   *       TECHNICAL SPECIALIST", "IT SPECIALIST (INFOSEC)") show the count
   *       is dominated by the single generic word "Specialist" (2051 alone)
   *       OR'd in, not by anything resembling the 3-word phrase.
   *
   * This means a multi-word chip with one common role-word (e.g.
   * "Specialist", "Manager", "Developer") fetches thousands of titles that
   * merely share that one word, most of them irrelevant. This is NOT the
   * same failure mode `Keyword` had (full-text matching duties/
   * qualifications instead of the title) -- it is real title-field
   * matching, just permissive (OR, not AND) on multi-word titles. See
   * `TITLE_SEARCH_RESULTS_PER_PAGE`/`TITLE_SEARCH_EMPTY_PAGE_GRACE`'s doc
   * comment above for how fetch VOLUME is bounded without truncating real
   * matches (a fixed page cap tried first was a measured regression --
   * opus re-review round 2, F1 -- against real non-software professions
   * like "Registered Nurse" and "Program Analyst").
   *
   * CORRECTED CLAIM (opus re-review round 2, F2): an earlier version of
   * this comment claimed "every genuine hit across Jay's ten chips landed
   * on page 1." Re-review scored every chip's full relevance-ordered list
   * through the real `compileFilter` and found genuine matches at ranks as
   * deep as 264 within a single chip's own results. The accurate claim is
   * narrower: every matched posting was reachable within the first
   * `ResultsPerPage` results via AT LEAST ONE of Jay's ten chips -- the old
   * fixed cap survived on CROSS-CHIP REDUNDANCY plus relevance ranking,
   * not because matches genuinely live on page 1 of every chip that finds
   * them. That distinction is exactly why a fixed page cap is unsafe for a
   * single-chip search (one real profession, one chip, no redundancy to
   * fall back on) even though it happened not to cost Jay's ten-chip case
   * anything observable.
   *
   * CORRECTED BASELINE (opus re-review round 2, F2): an earlier version of
   * this comment also claimed the OLD `Keyword`-only code fetched 497
   * distinct postings for Jay's case. That number does not reproduce --
   * re-measured live 2026-10-07 against unmodified `main`: 3,419 distinct
   * postings fetched (134 skipped, 3,553 raw pre-outer-dedup) for the same
   * 6 matched. The 497 figure was a one-off measurement artifact (this
   * ticket's own live API calls are not perfectly reproducible run to run
   * -- USAJOBS' pool and ranking shift during a single fetch), not a real
   * baseline; 3,419/6 (~570:1) is the real "before," in the same range as
   * the ticket's own originally-reported 4,255-fetched/1-matched case
   * (daily churn, not a contradiction). The real win this ticket produces
   * is therefore substantially BIGGER than first claimed -- see
   * `#searchOne`'s doc comment for the corrected end-to-end numbers.
   *
   * Also measured: a token containing a hyphen, slash, plus sign, or
   * underscore is DROPPED ENTIRELY by `PositionTitle`'s tokenizer --
   *   PositionTitle=Writer-Editor | Writer/Editor | Writer+Editor | Writer_Editor -> 0 (all four)
   *   PositionTitle=Writer Editor (space -- all words survive)                    -> 7
   * -- see `normalizeForTitleSearch`'s doc comment for the full mechanism,
   * the "Technical Writer-Editor -> exactly Technical alone" proof, and
   * the known C++ -> "C" imprecision this normalization accepts.
   *
   * ACCEPTANCE CRITERION TABLE (opus re-review round 2, F6 -- chips of 1
   * through 4 words, both parameters, live, 2026-10-08):
   *
   *   chip (words)                                    Keyword  PositionTitle
   *   Writer (1)                                           19              7
   *   Technical Writer (2)                                  5             40
   *   Lead Technical Writer (3)                              1            410
   *   Senior Technical Documentation Specialist (4)        31          2,198
   *
   * NOTE THE ONE-WORD CASE INVERTS THE HEADLINE: at one word,
   * `PositionTitle` (7) returns FEWER than `Keyword` (19) -- the OR-of-
   * words mechanism that over-matches a multi-word phrase has nothing to
   * OR when there's only one word, so it falls back to a plain word match,
   * narrower than `Keyword`'s full-text search for that one word. This
   * matters because ticket 16738f4 is what makes a one-word chip a shape
   * this app actually produces now; the 2-4 word rows are where
   * `PositionTitle`'s real win (and its OR-blowup risk, see
   * `TITLE_SEARCH_RESULTS_PER_PAGE`'s doc comment) both live.
   *
   * DECISION on `Keyword`'s role (ticket scope: "decide whether Keyword
   * retains any role"): it keeps exactly its current meaning -- a single
   * free-text term, sent as-is to USAJOBS' full-text search -- for any
   * caller that sets `criteria.keyword` directly (not via `criteria.
   * keywords`/title chips). No real caller does that for USAJOBS today
   * (`routes/searches.ts`'s `buildFetchCriteria` only ever produces
   * `keywords` or `{}`), but the field is part of the shared, adapter-
   * generic `SearchCriteria` shape (types.ts) and existing tests exercise
   * it directly, so changing its meaning here would be an unrelated,
   * unrequested behavior change for a hypothetical future caller. A
   * fallback-to-Keyword-when-PositionTitle-returns-nothing was considered
   * and REJECTED: the ticket flags it as an option, not a requirement, and
   * adding it would risk silently reintroducing the exact defect this
   * ticket fixes (an empty title search quietly broadening into the
   * unfocused full-text fetch that produced the original 4,255-fetched/
   * 1-matched case) -- better to show a real empty title result than to
   * guess our way back into the old failure mode.
   */
  async #fetchPage(
    criteria: SearchCriteria,
    page: number,
    asTitleSearch: boolean,
  ): Promise<UsajobsSearchResponse> {
    const url = new URL(this.#baseUrl);
    if (criteria.keyword) {
      if (asTitleSearch) {
        // See measurement above (`normalizeForTitleSearch`'s doc comment
        // carries the full mechanism): a token containing -, /, +, or _ is
        // dropped entirely by PositionTitle's tokenizer, so each is
        // normalized to a space to keep its words alive as separate tokens.
        // `?? criteria.keyword` is defensive only -- the title fan-out skips an
        // unsearchable phrase before it ever reaches a request (see
        // `normalizeForTitleSearch` case (b)).
        url.searchParams.set(
          "PositionTitle",
          normalizeForTitleSearch(criteria.keyword) ?? criteria.keyword,
        );
      } else {
        url.searchParams.set("Keyword", criteria.keyword);
      }
    }
    if (criteria.location) url.searchParams.set("LocationName", criteria.location);
    // Ticket 78f48df: title-mode searches request a much bigger page (see
    // TITLE_SEARCH_RESULTS_PER_PAGE's doc comment -- measured live that
    // USAJOBS accepts at least 1,000 per page) so a dense profession like
    // "Program Analyst" (1,344 real title matches) completes in 3 requests
    // instead of 54. The plain, non-title path is unaffected.
    const resultsPerPage = asTitleSearch ? TITLE_SEARCH_RESULTS_PER_PAGE : this.#resultsPerPage;
    url.searchParams.set("ResultsPerPage", String(resultsPerPage));
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

/**
 * Ticket 78f48df, opus re-review round 2 (F4, should-fix): normalizes a
 * title-mode search phrase before it is sent as `PositionTitle`. Measured
 * live 2026-10-07: a token containing any of `-`, `/`, `+`, or `_` is
 * DROPPED ENTIRELY by USAJOBS' tokenizer -- not matched oddly, just
 * removed from the query as if it were never typed --
 *
 *   PositionTitle=Technical Writer-Editor  ->   37   (EXACTLY "Technical"
 *                                                      alone -- the whole
 *                                                      "Writer-Editor"
 *                                                      token vanishes)
 *   PositionTitle=Writer-Editor  ->  0    PositionTitle=Writer/Editor -> 0
 *   PositionTitle=Writer+Editor  ->  0    PositionTitle=Writer_Editor -> 0
 *   PositionTitle=Writer Editor (space, all words survive)         ->  7
 *
 * An earlier version of this fix normalized only the hyphen. Round-2
 * review found the identical failure mode on `/`, `+`, and `_` and the
 * same one-line fix for all four: a hand-typed "Writer/Editor" chip was
 * silently going from 3 fetched under the OLD `Keyword` code to 0 under
 * this ticket's `PositionTitle` fix -- a real regression this now closes.
 *
 * HISTORY, kept because the wrong version of this note shipped twice and
 * the correction is the useful part. An earlier revision said "C++"
 * normalizes to a single-character token "C", and that "C" is bounded by
 * the same relevance-aware stop every other broad chip is. Both halves were
 * wrong, and the second was dangerously wrong:
 *
 *   - "C++" no longer normalizes to "C" at all. A token must hold 2+
 *     ALPHANUMERIC characters to be sent (re-review R2, then E2), so "C++"
 *     keeps no token and the phrase is skipped outright -- no request issued.
 *   - The stop can NEVER fire for a single-letter word, so "C" was never
 *     bounded. Re-review D2 proved this through the real class: for phrase
 *     "C++" against pages titled "Civil Engineer", the stop never fired and
 *     the search ran to `maxPages` (50 requests). `titleSearchWords` splits
 *     on `/[^a-z0-9]+/`, so the word list is ["c"] -- a substring nearly
 *     every title contains. That unboundedness is the whole reason such a
 *     phrase is now skipped rather than sent in any form.
 *
 * A third wrong version is worth recording for the same reason: the fix
 * BETWEEN those two split degenerate phrases into "carries punctuation, so
 * send it verbatim for a cheap 0" and "purely alphanumeric, so skip it".
 * Re-review E1 measured the first half false in general (`C++ 3` -> 405,
 * `a-b 7` -> 12), and E2 found `C#` slipping through the character-count
 * filter entirely while measuring identically to a bare `C` (3,674). Both
 * collapse into the single alphanumeric-count rule now in place.
 *
 * "C++", "C#" and ".NET" remain shapes `criteria.ts` explicitly supports
 * downstream (ticket 59fdc52 N5's word-boundary handling for a phrase that
 * starts or ends on a non-word character) -- this only changes what reaches
 * that filter, not what it keeps.
 *
 * Periods are deliberately NOT in this set: not measured, and a period is
 * exactly the character `.NET`'s own leading edge depends on for
 * `criteria.ts`'s word-boundary logic -- normalizing it without measuring
 * what USAJOBS actually does with it risks trading one unverified
 * regression for another.
 */
function normalizeForTitleSearch(phrase: string): string | undefined {
  // Two rules, and re-review E1/E2 collapsed them into ONE after an earlier
  // version of this fix needed two cases and still leaked a bad shape through.
  //
  // The rule: a token is worth sending only if it holds 2 or more ALPHANUMERIC
  // characters. Count alphanumerics, not raw length -- that is the whole fix,
  // and it is the correct unit because USAJOBS' own tokenizer is what decides,
  // and it drops non-alphanumerics before matching. Measured 2026-10-08:
  //
  //   PositionTitle=C   -> 3,674     PositionTitle=C#  -> 3,674  (identical:
  //   PositionTitle=R   -> 2,137                                  `#` dropped
  //   PositionTitle=A   -> 5,037                                  server-side)
  //   PositionTitle=Engineer -> 471
  //
  // Counting raw length let `C#` through: 2 characters long, so it survived a
  // `word.length > 1` filter, but only ONE alphanumeric, so USAJOBS answers it
  // exactly as it answers a bare `C` -- 3,674 postings, ~15 requests at
  // 250/page, ~85MB, zero genuine matches, and NO early stop possible because
  // `titleSearchWords` splits on /[^a-z0-9]+/ and gets the word list ["c"],
  // a substring nearly every title contains. `F#` is the same shape. A bare
  // `C#` chip is considerably more plausible than a bare `C`: it is a
  // mainstream language name, and ticket 5ba5cca's incident was exactly
  // bolted-on technology names reaching chips.
  //
  // What the rule does to each shape, measured:
  //
  //   Writer/Editor  -> "Writer Editor"  (both tokens survive -- F4's fix,
  //                                       separators still normalize to space:
  //                                       Writer-Editor | Writer/Editor |
  //                                       Writer+Editor | Writer_Editor all
  //                                       return 0, Writer Editor returns 7)
  //   C++ Engineer   -> "Engineer" (471, not {c, engineer} at ~4,000)
  //   C# Developer   -> "Developer" (the C# token carries one alphanumeric,
  //                                  so it is dropped as the noise it is)
  //   .NET           -> ".NET"  (NET is 3 alphanumerics -- survives. Periods
  //                              are deliberately NOT normalized to space:
  //                              unmeasured, and the leading period is what
  //                              `criteria.ts`'s word-boundary logic depends
  //                              on downstream, ticket 59fdc52 N5)
  //   C++ | C# | F# | C | R | a-b | c/c | C++ 3  -> undefined (unsearchable)
  //
  // `undefined` means UNSEARCHABLE BY TITLE: no token gives USAJOBS anything
  // to match on, so the caller skips the phrase with a reason and issues no
  // request at all. An earlier version instead sent such a phrase verbatim,
  // on the rationale that USAJOBS answers it with 0 for one cheap request.
  // Re-review E1 measured that rationale false in general: it holds for `C++`
  // (0), `a-b` (0) and `c/c` (0), but `C++ 3` normalizes to empty the same way
  // and returns 405, and `a-b 7` returns 12 -- a surviving bare digit is a
  // real OR branch. Skipping is correct for all of them and cheaper than all
  // of them.
  //
  // HONEST LIMIT, stated because it is a prediction and not a measurement:
  // skipping asserts that such a phrase WOULD match nothing useful, rather
  // than asking USAJOBS. That is sound reasoning -- a phrase with no token
  // holding two alphanumerics gives the server nothing with substance to
  // match -- and it is measured true for every shape above as of 2026-10-08.
  // It is not a guarantee about future USAJOBS behaviour.
  //
  // Dropping a short token can never COST a match, and this is provable, not
  // merely plausible (re-review Q3, measured 2026-10-08: `Engineer 3` -> 873
  // vs `Engineer` -> 471; `Tier 1 Analyst` -> 712 vs `Tier Analyst` -> 562;
  // `Writer 1` -> 159 vs `Writer` -> 7, so the digit really is its own OR
  // branch). With OR semantics, dropping a token while at least one survives
  // NARROWS the server's result set to titles matching the remaining tokens --
  // and any posting `compileFilter` keeps contains EVERY word of the chip,
  // hence every surviving word, so it is still inside the narrower set. The
  // client-side stop moves the safe way too: the predicate then needs only
  // "writer" instead of "writer" AND "1", so it fires LATER, never earlier.
  // One disclosed edge: a posting reachable only through a `titleSynonyms`
  // variant of the DROPPED token (chip "Writer 1" matching a real title
  // "Author 1" via the "1" branch rather than via {writer}) can be lost. Not
  // measured in the wild; narrow enough to accept, too narrow to leave unsaid.
  //
  // Note the deliberate asymmetry with `criteria.ts`, whose own word-boundary
  // matching DOES support `C++`/`.NET`/`C#` shapes (ticket 59fdc52 N5). The
  // local filter can afford a one-alphanumeric token; a remote OR-semantics
  // query cannot. This only changes what reaches that filter, not what it
  // keeps.
  const kept = phrase
    .replace(/[-/+_]/g, " ")
    .split(/\s+/)
    .filter((word) => word.replace(/[^a-z0-9]/gi, "").length > 1);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * The distinct, lowercased words of a title-mode phrase, AFTER the same
 * normalization `#fetchPage` sends to `PositionTitle` -- used only by
 * `#searchOne`'s relevance-aware early stop (see
 * `TITLE_SEARCH_EMPTY_PAGE_GRACE`'s doc comment) to judge whether a page
 * still contains a title that genuinely matches every word of the phrase,
 * not merely one word OR'd in by `PositionTitle`'s own semantics. This
 * never goes out over the network -- it's a client-side read of a page
 * USAJOBS already returned, not a second query.
 */
function titleSearchWords(phrase: string): string[] {
  // `?? phrase` is defensive only: an unsearchable phrase (see
  // `normalizeForTitleSearch` case (b)) is skipped by `#searchMultipleKeywords`
  // before any request is issued, so the stop predicate is never built for one.
  return (normalizeForTitleSearch(phrase) ?? phrase)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * True if `title` contains EVERY word in `words` as a plain,
 * case-insensitive substring. Deliberately NOT `compileFilter`'s
 * word-boundary/synonym matcher (`criteria.ts`) -- that remains the single
 * source of truth for which postings the app actually keeps; this is a
 * much cruder, adapter-local heuristic used only to decide when PAGING can
 * stop, never what gets kept. A false positive here just costs one extra
 * page fetched for nothing; a false negative risks stopping before real
 * signal is exhausted -- `TITLE_SEARCH_EMPTY_PAGE_GRACE`'s margin is what
 * guards against that, not this function's precision.
 */
function titleHasAllWords(title: string | undefined, words: string[]): boolean {
  if (!title || words.length === 0) return false;
  const lower = title.toLowerCase();
  return words.every((w) => lower.includes(w));
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
