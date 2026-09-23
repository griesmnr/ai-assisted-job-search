import type { Job } from "@app/shared";
import { htmlToPlainText } from "./html.js";
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
  type TokenOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Adapter for Rippling's public ATS Job Board API (ticket a14e3e7), fifth
// ATS ecosystem after Greenhouse, Lever, Ashby, and SmartRecruiters:
//
//   GET https://api.rippling.com/platform/api/ats/v1/board/{board_slug}/jobs
//   GET https://api.rippling.com/platform/api/ats/v1/board/{board_slug}/jobs/{uuid}
//
// No auth on either endpoint. Everything below was verified live 2026-09-23
// (see this ticket's own report for the exact commands); real captured
// responses, trimmed, are committed under
// __fixtures__/rippling-real-response-*.
//
// ---------------------------------------------------------------------------
// FINDING 1 — the list endpoint has NO description field, at all, ever, and
// is keyed one row per (job, location) pair, not one row per job
// ---------------------------------------------------------------------------
//
// `GET .../board/{slug}/jobs` returns a bare JSON array (no envelope, no
// pagination — see Finding 5) of summaries shaped
// `{ uuid, name, department: {id,label}, url, workLocation: {id,label} }`.
// No `description`, no `company`/`companyName`, no `employmentType`, no pay
// data — verified across all 612 rows of the real `rippling` board's own
// response (`__fixtures__/rippling-real-response-rippling-list.json` is a
// trimmed subset). Full text, company name, employment type, and pay
// figures exist only on the per-posting detail endpoint, so — same as
// SmartRecruiters (see smartrecruiters.ts, Finding 2/5) — a detail fetch is
// mandatory for every posting this adapter returns, not an optional
// enrichment. `#fetchDetail`, `buildDescription`, and the bounded
// concurrency + budget below exist for exactly this reason.
//
// The bigger surprise: a job posted to multiple work locations does NOT
// appear once with a list of locations — it appears ONCE PER LOCATION, as
// separate array elements sharing the identical `uuid`. Verified live
// against the real `rippling` board: 612 raw rows, only 328 DISTINCT
// `uuid`s (`python3` dedup check, 2026-09-23) — 123 jobs appear more than
// once, one ("Accounting Manager") appears 5 times, one other job appears
// 20 times. `__fixtures__/rippling-real-response-rippling-list.json`
// deliberately keeps all 5 rows for the Accounting Manager job (uuid
// `19ae5b34-...`) so this is exercised against real data, not asserted
// against a hand-built fixture. Failing to dedupe by `uuid` here would not
// just inflate a raw posting count (a cosmetic problem) — it would insert
// the same posting into `jobs` multiple times under the identical
// `dataSource`/`externalId` pair, which is exactly the natural key
// `types.ts`'s own doc comment says ingestion's UNIQUE constraint idempotency
// depends on (see `NormalizedJob`'s doc comment in types.ts). `#groupByUuid`
// does this dedup at the list-parsing stage, before anything downstream ever
// sees a duplicate uuid.
//
// ---------------------------------------------------------------------------
// FINDING 2 — the per-posting detail response has its OWN, richer location
// field, which can genuinely disagree with what any single list row shows
// ---------------------------------------------------------------------------
//
// The detail endpoint's `workLocations` is an array of location label
// strings covering EVERY location that job is posted to — e.g. the same
// Accounting Manager posting's detail response lists
// `["Seattle, WA", "San Francisco, CA", "New York, NY", "Austin, TX",
// "Remote (United States)"]`, five entries, matching the five distinct
// `workLocation.label`s collected across that uuid's five list rows
// (verified: `__fixtures__/rippling-real-response-rippling-detail-
// accounting-manager.json`). So unlike a truly hidden second field (Lever's
// `lists`, SmartRecruiters' `qualifications`), this one IS derivable from
// the list response alone (by aggregating every row sharing a uuid) — no
// extra request is needed just to learn a posting's full location set,
// which is why `criteria.location` is safe to apply at the list-grouping
// stage (`#groupByUuid`'s aggregated `locationLabels`), before the detail
// fetch, matching SmartRecruiters' Finding 5 reasoning for the same
// optimization. `normalizeItem` still prefers the DETAIL response's
// `workLocations` when a detail was actually fetched (it's the more
// authoritative, single-source-of-truth field), falling back to the
// list-aggregated labels only if detail parsing somehow omits it.
//
// A job's locations are frequently a MIX of remote and in-person postings
// for the same role (verified live: 23 of 328 real jobs on the `rippling`
// board mix a "Remote (...)"-prefixed label with at least one plain city —
// e.g. Accounting Manager itself, four cities plus "Remote (United
// States)"). Per this project's standing rule against forcing a closed enum
// from ambiguous data (see greenhouse.ts's `mapPayType`/`mapCommitment`),
// `mapLocationType` returns `undefined` for a posting whose locations don't
// unanimously classify as the same kind (all-remote, all-hybrid, or
// all-onsite) — not a guess at whichever kind happens to be listed first.
// See `mapLocationType`'s own doc comment for the exact classification rule
// and its measured real-data split (275 all-onsite, 26 all-remote, 4
// all-hybrid, 23 genuinely mixed, out of 328).
//
// ---------------------------------------------------------------------------
// FINDING 3 — query params `searchTerm`/`workLocation`/`department` are
// REAL (not a JS-rendered-docs fiction) but too narrow to drive this
// adapter's own SearchCriteria semantics — verified live, not used
// ---------------------------------------------------------------------------
//
// All three params measurably change the response (verified live,
// 2026-09-23, against the real `rippling` board):
//   - `?searchTerm=engineer` narrows 612 rows to 182, every one of whose
//     `name` contains "engineer".
//   - `?searchTerm=benefits` returns 19 rows, all titled around "Benefits".
//   - `?searchTerm=python` and `?searchTerm=bachelor` — terms virtually
//     certain to appear in real job DESCRIPTIONS but not routinely in
//     TITLES — both return ZERO rows, even though the `rippling` board
//     unquestionably has Python-mentioning, bachelor's-degree-requiring
//     postings (spot-checked against real detail fixtures). This proves
//     `searchTerm` matches `name` only, not the full posting text.
//   - `?workLocation=Austin,%20TX` (URL-encoded, exact label) returns 2
//     rows; `?workLocation=Austin` (no state, no exact match) returns ZERO
//     — this param requires an exact `workLocation.label`/`.id` string, not
//     a substring, so a caller can't use it with a free-text location like
//     this project's own `SearchCriteria.location`.
//
// So per this ticket's own instruction ("if they don't work as expected,
// don't use them, just fetch everything and filter client-side"):
// `searchTerm` is real but TITLE-ONLY — using it to prefilter
// `criteria.keyword` would silently miss a keyword that exists only in the
// description, the exact failure class smartrecruiters.ts's Finding 3 named
// "this project's own recurring bug class." `workLocation` is real but
// EXACT-MATCH-ONLY — unusable for a substring `criteria.location` without
// first knowing the board's own location-label vocabulary. Neither is used
// by `search()`; every board's full, unfiltered list is always fetched and
// filtering happens client-side against real fetched data (location at the
// list-grouping stage per Finding 2, keyword after the detail fetch per
// Finding 4 below) — same discipline as every other adapter in this
// project.
//
// ---------------------------------------------------------------------------
// FINDING 4 — full-text assembly, HTML encoding, and why keyword filtering
// waits for the detail fetch
// ---------------------------------------------------------------------------
//
// A posting detail's `description` is `{ company: string, role: string }`,
// both single-encoded ordinary HTML (real `<div>`/`<p>`/`<strong>` tags
// directly, only the markup's own entities encoded — confirmed on every
// real detail fixture: `&amp;` present, zero literal `&lt;`/`&gt;`
// anywhere), same pipeline as Lever/SmartRecruiters, `doubleEncoded: false`.
// `company` is generic "About Rippling"-style boilerplate, IDENTICAL across
// every posting on a given board (verified: byte-identical company section
// text across five different real Rippling detail fixtures) — not
// posting-specific, but still real text Rippling itself shows the
// applicant, so it's folded in rather than discarded; `role` is the
// requisition-specific text (responsibilities, requirements, sometimes a
// pay disclosure) and is the load-bearing half for resume matching. Because
// `role` exists ONLY on the detail response (Finding 1), `criteria.keyword`
// cannot be evaluated until after the detail fetch — matching against
// `name` alone (the only field the list/summary view has) would silently
// miss any keyword that lives only in the requirements text, the same
// mistake Finding 3 above already rules out for `searchTerm`. See
// `#fetchAndNormalize` and this file's test suite for a demonstration that
// a naive implementation reading only one of the two description sections
// fails an assertion the full `buildDescription` passes.
//
// ---------------------------------------------------------------------------
// FINDING 5 — no pagination; structured fields that map cleanly
// ---------------------------------------------------------------------------
//
// The list endpoint returns a company's entire board in one response — no
// `page`/`cursor`/`limit` param changes the result shape, no `Link` or
// `X-Total-Count` response header, and the real `rippling` board's own 612
// rows all arrived in a single request with no truncation. Verified live,
// not assumed.
//
// `employmentType.label` (verified: the confusingly-named field carries the
// MACHINE-READABLE code — `SALARIED_FT`/`HOURLY_FT`/`CONTRACTOR`/`TEMP`,
// all four seen on real postings — while `employmentType.id` carries the
// HUMAN-READABLE string, e.g. "Salaried, full-time"; the opposite of every
// other id/label pair this API returns, including its own sibling
// `department` object) maps cleanly onto both `payType` (`SALARIED_FT` ->
// "salary", `HOURLY_FT` -> "hourly") and `commitment` (`SALARIED_FT`/
// `HOURLY_FT` -> "full-time", `CONTRACTOR` -> "contract"). `TEMP` (a
// temp/intern relationship) maps to neither — same reasoning Lever's and
// SmartRecruiters' `mapCommitment` already apply to "Internship"/"intern".
// An employment type value not seen during this adapter's development
// safely falls through to `undefined` rather than being guessed at.
//
// `payRangeDetails` (an array of `{location, currency, frequency,
// rangeStart, rangeEnd, isRemote}`) carries real numeric compensation on
// some postings, but `Job.payType` is a closed hourly/salary ENUM, not a
// number — there is nowhere on `Job` to put an actual range, so this field
// is read only insofar as `employmentType.label` already gives a more
// direct hourly/salary signal; the numbers themselves are not stored,
// consistent with how every other adapter in this project treats
// compensation it can't represent (see greenhouse.ts's `mapPayType` doc
// comment).
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.rippling.com/platform/api/ats/v1/board";
const DEFAULT_TIMEOUT_MS = 15_000;

/** How many per-posting detail requests to run at once, across every
 * configured board combined. Verified live (2026-09-23): 8 sequential
 * detail fetches against the real `rippling` board averaged ~0.2s/request;
 * a follow-up batch of 12 requests at concurrency 5 completed with zero
 * errors or 429s (though with more request-to-request jitter, 0.2s-1.4s,
 * consistent with ordinary network variance rather than throttling). Kept
 * at the same conservative value SmartRecruiters uses for the identical
 * per-posting-detail-fetch shape, rather than pushing to whatever ceiling a
 * small sample happened to tolerate. */
const DEFAULT_DETAIL_CONCURRENCY = 5;

/**
 * Caps the total number of per-posting detail requests issued across this
 * adapter instance's ENTIRE `search()` call, shared across every configured
 * board — same reasoning as SmartRecruiters' `DEFAULT_MAX_POSTINGS` (see
 * that file's doc comment for why a per-board cap doesn't compose with a
 * whole-`search()` worker deadline). Unlike SmartRecruiters, this budget
 * only ever bounds the DETAIL fan-out, never list pagination: Finding 5
 * established there is no list pagination here at all (one request per
 * board, always), so there is no equivalent of SmartRecruiters' "a
 * zero-budget company still pays full list-pagination cost" gap to close —
 * every configured board's list is always fetched in full regardless of
 * remaining budget, which is also what lets `search()` still report an
 * accurate "not-found"/"empty"/"ok" `TokenOutcome` for a board whose detail
 * fetches were entirely cut by the budget (see `search()`).
 *
 * 1,000 is comfortably above the real `rippling` board's own 328 distinct
 * jobs (the largest board measured during this adapter's development) while
 * keeping the whole-search cost bounded: at the measured ~0.2s/request and
 * `DEFAULT_DETAIL_CONCURRENCY` 5, 1,000 detail fetches is on the order of
 * 40s, not minutes.
 */
const DEFAULT_MAX_POSTINGS = 1_000;

export type RipplingConfig = {
  /** One Rippling job-board slug per employer, e.g. `["rippling",
   * "carbon-health"]` — the same slug that appears in
   * `https://ats.rippling.com/{slug}/jobs` and in the board API path. Each
   * is fetched as its own list request; `search()` merges the results and
   * isolates one board's failure from the others (see `search()`). */
  boardSlugs: string[];
  /** Override for testing; defaults to the real Rippling board API host
   * (`https://api.rippling.com/platform/api/ats/v1/board`). */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** How many per-posting detail requests to run concurrently, across every
   * configured board combined. See `DEFAULT_DETAIL_CONCURRENCY`'s doc
   * comment for the measurement behind the default. */
  detailConcurrency?: number;
  /** Caps the total number of per-posting detail requests issued across
   * this adapter instance's ENTIRE `search()` call, shared across every
   * configured board. See `DEFAULT_MAX_POSTINGS`'s doc comment. Must be a
   * finite number >= 0; anything else (unset, `NaN`, a negative value)
   * falls back to `DEFAULT_MAX_POSTINGS` rather than silently disabling the
   * cap — same config-validation discipline as SmartRecruiters'
   * `maxPostings` (see that file's constructor for the concrete failure
   * this guards against: `candidates.length > NaN` is `false` for every
   * possible length, which would otherwise disable the cap on a typo). */
  maxPostings?: number;
};

/**
 * Reads the configured board slugs from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Rippling's public board API needs no credentials, so like
 * Greenhouse/Lever/Ashby/SmartRecruiters (and unlike USAJOBS) there is no
 * key/secret to read.
 */
export function createRipplingSourceFromEnv(env: NodeJS.ProcessEnv = process.env): RipplingSource {
  const raw = env.RIPPLING_COMPANIES;
  const boardSlugs = (raw ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
  if (boardSlugs.length === 0) {
    throw new Error(
      'RIPPLING_COMPANIES must be set to a comma-separated list of Rippling board slugs (e.g. "rippling,carbon-health").',
    );
  }
  return new RipplingSource({ boardSlugs });
}

/** One deduplicated job from a board's list response — see Finding 1. */
type ListCandidate = {
  uuid: string;
  /** The `name` from the FIRST list row this uuid appeared in. Real data
   * (Finding 1) never showed a differing `name` across a duplicated uuid's
   * rows, but `normalizeItem` prefers the detail response's own `name`
   * regardless once fetched — this is only used if detail parsing somehow
   * omits it. */
  name: string | undefined;
  /** Every distinct `workLocation.label` seen across this uuid's rows, in
   * first-seen order — see Finding 2. Used for `criteria.location`
   * filtering before the detail fetch, and as a fallback for
   * `mapLocationType`/`location` if the detail response is missing
   * `workLocations`. */
  locationLabels: string[];
  /** The `url` from the FIRST list row this uuid appeared in — fallback for
   * `linkToApply` if the detail response is missing `url`. */
  url: string | undefined;
};

export class RipplingSource implements JobSource {
  readonly dataSource = "rippling" as const;

  readonly #boardSlugs: string[];
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #detailConcurrency: number;
  readonly #maxPostings: number;

  constructor(config: RipplingConfig) {
    if (config.boardSlugs.length === 0) {
      throw new Error("RipplingSource requires at least one board slug.");
    }
    this.#boardSlugs = config.boardSlugs;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#detailConcurrency = config.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
    // Same "??  only substitutes on null/undefined, not on nonsense" guard
    // SmartRecruiters' constructor uses for its own maxPostings — see that
    // file's doc comment (F5 fix) for the concrete NaN/negative failure
    // this closes.
    this.#maxPostings =
      typeof config.maxPostings === "number" &&
      Number.isFinite(config.maxPostings) &&
      config.maxPostings >= 0
        ? config.maxPostings
        : DEFAULT_MAX_POSTINGS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];
    const tokenOutcomesByIndex: (TokenOutcome | undefined)[] = new Array(this.#boardSlugs.length);

    // -----------------------------------------------------------------
    // Phase A: fetch every configured board's list, ALWAYS — one request
    // per board, always issued regardless of the detail-fetch budget below
    // (Finding 5: unlike SmartRecruiters, there is no list pagination cost
    // to short-circuit here). This is also what lets a board whose detail
    // fetches get entirely cut by `#maxPostings` still be reported as a
    // real "ok" board with a real (pre-filter) posting count, rather than
    // silently looking identical to "not-found".
    // -----------------------------------------------------------------
    type PendingBoard = { index: number; boardSlug: string; candidates: ListCandidate[] };
    const pendingBoards: PendingBoard[] = [];

    for (let i = 0; i < this.#boardSlugs.length; i++) {
      const boardSlug = this.#boardSlugs[i]!;
      let raw: RipplingJobSummary[];
      try {
        raw = await this.#fetchList(boardSlug);
      } catch (err) {
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          tokenOutcomesByIndex[i] = {
            token: boardSlug,
            status: "not-found",
            postingCount: 0,
            companyName: undefined,
            message: undefined,
            skippedCount: 0,
          };
          continue;
        }
        // Any other list-fetch failure (transient/forbidden/rate-limited/
        // malformed/unexpected status) is isolated to this board, not
        // fatal to the whole search — this adapter makes potentially
        // hundreds of requests per board (Finding 1's mandatory detail
        // fetch), proportionally far more surface for one board's own
        // hiccup than a single-request-per-board adapter like Ashby has,
        // same reasoning SmartRecruiters' search() gives for its own
        // broader per-company isolation.
        const message = err instanceof Error ? err.message : String(err);
        tokenOutcomesByIndex[i] = {
          token: boardSlug,
          status: "error",
          postingCount: 0,
          companyName: undefined,
          message,
          skippedCount: 0,
        };
        continue;
      }

      const grouped = groupByUuid(raw);
      if (grouped.length === 0) {
        tokenOutcomesByIndex[i] = {
          token: boardSlug,
          status: "empty",
          postingCount: 0,
          companyName: undefined,
          message: undefined,
          skippedCount: 0,
        };
        continue;
      }

      // criteria.location is safe to apply here, before the detail fetch —
      // Finding 2: the full location set for a uuid is already fully known
      // from the list response's own duplicated rows, nothing is at risk of
      // being silently missed by filtering now. criteria.keyword is NOT
      // applied here — Finding 4: real requirement text (and therefore real
      // keyword matches) can live only in the detail response's `role`
      // section, invisible at the list level.
      const candidates = criteria.location
        ? grouped.filter((c) => candidateMatchesLocation(c, criteria.location as string))
        : grouped;

      // postingCount on the eventual TokenOutcome is the RAW (pre-filter)
      // count per that type's own doc comment — recorded from `grouped`,
      // not `candidates`, finalized once phase B knows companyName/skips.
      pendingBoards.push({ index: i, boardSlug, candidates });
      // Stash the raw count now; finalized in phase C below.
      tokenOutcomesByIndex[i] = {
        token: boardSlug,
        status: "ok",
        postingCount: grouped.length,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      };
    }

    // -----------------------------------------------------------------
    // Phase B: flatten every surviving (post-location-filter) candidate
    // across every board into one pool, apply the shared maxPostings
    // budget, then fan out detail fetches at bounded concurrency. A
    // truncated pool is reported as a single skip naming the cut, never as
    // a silently short result — same principle as SmartRecruiters'
    // maxPostings (see that file's DEFAULT_MAX_POSTINGS doc comment for why
    // "truncated indistinguishable from complete" is this project's own
    // recurring failure shape).
    // -----------------------------------------------------------------
    type FlatCandidate = { boardIndex: number; boardSlug: string; candidate: ListCandidate };
    const flat: FlatCandidate[] = [];
    for (const board of pendingBoards) {
      for (const candidate of board.candidates) {
        flat.push({ boardIndex: board.index, boardSlug: board.boardSlug, candidate });
      }
    }

    const truncated = flat.length > this.#maxPostings;
    const bounded = truncated ? flat.slice(0, this.#maxPostings) : flat;
    if (truncated) {
      const omitted = flat.length - bounded.length;
      skipped.push({
        externalId: undefined,
        reason:
          `Rippling search was truncated: ${flat.length} candidate postings were found (after ` +
          `location filtering, across all ${this.#boardSlugs.length} configured board(s)) but the ` +
          `shared maxPostings=${this.#maxPostings} budget for this ENTIRE search() call only ` +
          `covers ${bounded.length} — ${omitted} posting${omitted === 1 ? " was" : "s were"} NOT ` +
          `fetched and ${omitted === 1 ? "is" : "are"} missing from this result. This is a partial ` +
          `result, not a complete set of boards — every configured board's raw posting count is ` +
          `still accurate (see each board's TokenOutcome), only the detail fetch (and therefore the ` +
          `returned jobs) was capped.`,
      });
    }

    const perBoardSkippedCount = new Map<number, number>();
    const perBoardCompanyName = new Map<number, string | undefined>();

    const results = await mapWithConcurrency(bounded, this.#detailConcurrency, (entry) =>
      this.#fetchAndNormalize(entry.boardSlug, entry.candidate, criteria),
    );

    for (let i = 0; i < results.length; i++) {
      const entry = bounded[i]!;
      const result = results[i]!;
      if (result.kind === "job") {
        jobs.push(result.job);
        if (!perBoardCompanyName.has(entry.boardIndex)) {
          perBoardCompanyName.set(entry.boardIndex, result.job.company);
        }
      } else if (result.kind === "skip") {
        skipped.push(result.record);
        perBoardSkippedCount.set(
          entry.boardIndex,
          (perBoardSkippedCount.get(entry.boardIndex) ?? 0) + 1,
        );
      }
      // result.kind === "filtered-out": not a skip, just didn't match
      // criteria.keyword — same semantics as every other adapter's
      // client-side keyword filtering.
    }

    // -----------------------------------------------------------------
    // Phase C: finalize each board's TokenOutcome with what phase B learned
    // (companyName, skippedCount). "not-found"/"empty"/"error" outcomes from
    // phase A are untouched — nothing in phase B applies to a board that
    // never contributed a candidate.
    // -----------------------------------------------------------------
    for (const board of pendingBoards) {
      const existing = tokenOutcomesByIndex[board.index];
      if (!existing) continue;
      tokenOutcomesByIndex[board.index] = {
        ...existing,
        companyName: perBoardCompanyName.get(board.index),
        skippedCount: perBoardSkippedCount.get(board.index) ?? 0,
      };
    }

    const tokenOutcomes = tokenOutcomesByIndex.filter((o): o is TokenOutcome => o !== undefined);

    const totalRecords = jobs.length + skipped.length;
    const skipRate = totalRecords === 0 ? 0 : skipped.length / totalRecords;

    return { jobs, skipped, skipRate, tokenOutcomes };
  }

  /**
   * Fetches full detail for one posting and either normalizes it into a
   * `Job`, records why it was skipped, or reports it as filtered out by
   * `criteria.keyword`. Never throws — every failure mode (network error,
   * a 404 on a posting that vanished between the list and detail fetch,
   * malformed JSON, a structurally invalid record) is caught here and
   * turned into a per-record result, so one bad posting can never take down
   * the rest of a board's search — same discipline as
   * SmartRecruiters' `#fetchAndNormalize` (see that file's doc comment for
   * the two real bugs its own try/catch boundary was widened to close:
   * this one is written with both already in mind, `externalId` declared
   * before the try and assigned inside it with a guard so even a hostile
   * `candidate` can't escape this function unhandled).
   */
  async #fetchAndNormalize(
    boardSlug: string,
    candidate: ListCandidate,
    criteria: SearchCriteria,
  ): Promise<
    | { kind: "job"; job: NormalizedJob }
    | { kind: "skip"; record: SkippedRecord }
    | { kind: "filtered-out" }
  > {
    let externalId: string | undefined;
    try {
      externalId =
        typeof candidate?.uuid === "string" && candidate.uuid.length > 0
          ? candidate.uuid
          : undefined;
      const detail = await this.#fetchDetail(boardSlug, candidate.uuid);
      const fullDescription = buildDescription(detail);

      if (criteria.keyword) {
        const keyword = criteria.keyword.toLowerCase();
        const title = (
          asTrimmedString(detail.name) ??
          asTrimmedString(candidate.name) ??
          ""
        ).toLowerCase();
        if (!title.includes(keyword) && !fullDescription.toLowerCase().includes(keyword)) {
          return { kind: "filtered-out" };
        }
      }

      const result = normalizeItem(candidate, detail, fullDescription);
      if (result.ok) return { kind: "job", job: result.job };
      return { kind: "skip", record: { externalId: result.externalId, reason: result.reason } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "skip",
        record: {
          externalId,
          reason: `failed to fetch or normalize full posting detail (board "${boardSlug}"): ${message}`,
        },
      };
    }
  }

  async #fetchList(boardSlug: string): Promise<RipplingJobSummary[]> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(boardSlug)}/jobs`);
    const response = await this.#request(url, `board "${boardSlug}" job list`);
    return parseListShape(
      await parseJsonBody(response, `board "${boardSlug}" job list`),
      boardSlug,
    );
  }

  async #fetchDetail(boardSlug: string, uuid: string): Promise<RipplingJobDetail> {
    const url = new URL(
      `${this.#baseUrl}/${encodeURIComponent(boardSlug)}/jobs/${encodeURIComponent(uuid)}`,
    );
    const response = await this.#request(url, `posting detail "${uuid}" (board "${boardSlug}")`);
    return parseDetailShape(
      await parseJsonBody(response, `posting detail "${uuid}" (board "${boardSlug}")`),
      boardSlug,
      uuid,
    );
  }

  async #request(url: URL, describe: string): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TransientSourceError(
          `Rippling request for ${describe} timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(`Rippling request for ${describe} failed (network error)`, {
        cause: err,
      });
    } finally {
      clearTimeout(timeout);
    }

    classifyErrorStatus(response, describe);
    return response;
  }
}

function classifyErrorStatus(response: Response, describe: string): void {
  if (response.status === 404) {
    // Real observed body for an unrecognized board:
    // {"error_code":"RESOURCE_NOT_FOUND","message":"Job Board not found","resource":null}
    // — verified live, 2026-09-23
    // (__fixtures__/rippling-real-response-unknown-board-404.json). Status
    // code alone classifies this; the caller decides what a 404 means for
    // its own endpoint (board-not-found for the list, vanished-posting for
    // a detail fetch — see `search()` and `#fetchAndNormalize`).
    throw new UnexpectedStatusError(`Rippling returned HTTP 404 for ${describe}`, 404);
  }
  if (response.status === 401) {
    // Not observed against the real API (it takes no credentials), but
    // classified for completeness, matching every other adapter here.
    throw new AuthFailedError(`Rippling rejected the request for ${describe} (HTTP 401)`);
  }
  if (response.status === 403) {
    throw new ForbiddenError(`Request for ${describe} was blocked with HTTP 403`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Rippling rate limit exceeded (HTTP 429) for ${describe}`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Rippling server error (HTTP ${response.status}) for ${describe}`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Rippling returned unexpected HTTP status ${response.status} for ${describe}`,
      response.status,
    );
  }
}

async function parseJsonBody(response: Response, describe: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    throw new MalformedResponseError(`Rippling response for ${describe} was not valid JSON`, {
      cause: err,
    });
  }
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
// Bounded concurrency for the per-posting detail fan-out (Finding 1),
// identical shape to SmartRecruiters' own `mapWithConcurrency` — kept as a
// local copy rather than imported from smartrecruiters.ts, matching this
// project's convention that each adapter is self-contained apart from the
// shared `types.ts`/`html.ts`.
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Rippling response shapes — only the fields this adapter reads. Verified
// against real captured responses; see this file's top-of-file comment and
// __fixtures__/rippling-real-response-*.
// ---------------------------------------------------------------------------

type RipplingLabeled = { id?: string; label?: string };

type RipplingJobSummary = {
  uuid?: string;
  name?: string;
  department?: RipplingLabeled;
  url?: string;
  workLocation?: RipplingLabeled;
};

type RipplingPayRangeDetail = {
  location?: string;
  currency?: string;
  frequency?: string;
  rangeStart?: number;
  rangeEnd?: number;
  isRemote?: boolean;
};

type RipplingJobDetail = {
  uuid?: string;
  name?: string;
  companyName?: string;
  url?: string;
  createdOn?: string;
  /** NOTE the id/label swap vs every other `RipplingLabeled`-shaped field on
   * this API (`department`, `workLocation`): here `label` carries the
   * MACHINE code (`SALARIED_FT`, `HOURLY_FT`, `CONTRACTOR`, `TEMP`) and
   * `id` carries the human string ("Salaried, full-time") — verified
   * against real data, not a typo in this adapter. See Finding 5. */
  employmentType?: RipplingLabeled;
  workLocations?: string[];
  description?: { company?: string; role?: string };
  payRangeDetails?: RipplingPayRangeDetail[];
};

function parseListShape(body: unknown, boardSlug: string): RipplingJobSummary[] {
  if (!Array.isArray(body)) {
    throw new MalformedResponseError(
      `Rippling job list for board "${boardSlug}" did not match the expected shape (expected a bare JSON array)`,
    );
  }
  return body as RipplingJobSummary[];
}

function parseDetailShape(body: unknown, boardSlug: string, uuid: string): RipplingJobDetail {
  if (typeof body !== "object" || body === null) {
    throw new MalformedResponseError(
      `Rippling posting detail response for "${uuid}" (board "${boardSlug}") was not a JSON object`,
    );
  }
  return body as RipplingJobDetail;
}

// ---------------------------------------------------------------------------
// List-level grouping — see Finding 1. A malformed/hostile row (a `null` in
// the array, a non-string `uuid`) is simply skipped from grouping rather
// than thrown: `parseListShape` only validates that the body IS an array,
// never that its elements are well-formed, same discipline SmartRecruiters'
// `parsePostingsPageShape` doc comment explains — a malformed row silently
// contributing nothing to `grouped` is acceptable here (unlike dropping a
// row inside the per-record pipeline, which SmartRecruiters' comment warns
// against) because a row with no usable `uuid` was never going to produce a
// distinct, addressable job anyway; there's no `SkippedRecord` to lose since
// nothing about this row was ever going to become one.
// ---------------------------------------------------------------------------

function groupByUuid(rows: RipplingJobSummary[]): ListCandidate[] {
  const order: string[] = [];
  const byUuid = new Map<string, ListCandidate>();

  for (const row of rows) {
    const uuid = typeof row?.uuid === "string" && row.uuid.length > 0 ? row.uuid : undefined;
    if (!uuid) continue;

    const label =
      typeof row.workLocation?.label === "string" && row.workLocation.label.trim().length > 0
        ? row.workLocation.label.trim()
        : undefined;

    let existing = byUuid.get(uuid);
    if (!existing) {
      existing = {
        uuid,
        name: asTrimmedString(row.name),
        locationLabels: [],
        url: asTrimmedString(row.url),
      };
      byUuid.set(uuid, existing);
      order.push(uuid);
    }
    if (label && !existing.locationLabels.includes(label)) {
      existing.locationLabels.push(label);
    }
  }

  return order.map((uuid) => byUuid.get(uuid)!);
}

/** Case-insensitive substring match against ANY of a candidate's aggregated
 * location labels — see Finding 2 for why the full set is already known at
 * this stage, safe to filter before the detail fetch. */
function candidateMatchesLocation(candidate: ListCandidate, location: string): boolean {
  const needle = location.toLowerCase();
  return candidate.locationLabels.some((label) => label.toLowerCase().includes(needle));
}

/** Returns `value` trimmed if it's a non-empty string, `undefined`
 * otherwise — including when `value` isn't a string at all. Optional
 * chaining alone only guards null/undefined, not a wrong runtime type; same
 * reasoning SmartRecruiters' `asTrimmedString` doc comment gives. */
function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Full-text assembly for `description` — see Finding 4. Both real sections
// are folded in (company boilerplate first, then the posting-specific role
// text, matching the reading order a real applicant sees the two blurbs in
// on Rippling's own hosted careers page), each individually stripped of
// HTML via the shared `htmlToPlainText` with `doubleEncoded: false` (real,
// single-encoded HTML — verified, see Finding 4).
// ---------------------------------------------------------------------------

function buildDescription(detail: RipplingJobDetail): string {
  const parts: string[] = [];
  const company = detail.description?.company;
  const role = detail.description?.role;
  if (typeof company === "string" && company.trim().length > 0) {
    const text = htmlToPlainText(company);
    if (text) parts.push(text);
  }
  if (typeof role === "string" && role.trim().length > 0) {
    const text = htmlToPlainText(role);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(
  candidate: ListCandidate,
  detail: RipplingJobDetail,
  fullDescription: string,
): NormalizeResult {
  // Rippling's `uuid` is the platform identifier used to address a specific
  // posting — it's what both the detail endpoint and the list response key
  // on, and (per real fixtures captured for this adapter) it is stable
  // between a posting's appearance in the list and in its own detail
  // response, and stable across the multiple list rows a multi-location
  // posting produces (Finding 1).
  const externalId = asTrimmedString(detail.uuid) ?? asTrimmedString(candidate.uuid) ?? undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing uuid" };
  }

  const title = asTrimmedString(detail.name) ?? asTrimmedString(candidate.name);
  if (!title) {
    return { ok: false, externalId, reason: "missing name (title)" };
  }

  const company = asTrimmedString(detail.companyName);
  if (!company) {
    return { ok: false, externalId, reason: "missing companyName on posting detail" };
  }

  const description = fullDescription.trim();
  if (!description) {
    return {
      ok: false,
      externalId,
      reason: "no text in description.company or description.role (posting detail)",
    };
  }

  const linkToApply = asTrimmedString(detail.url) ?? candidate.url;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing url on posting detail" };
  }

  const postedAtRaw = detail.createdOn;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing createdOn on posting detail" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable createdOn "${postedAtRaw}"` };
  }

  const locations = resolveLocations(detail, candidate);
  const location = locations.length > 0 ? locations.join(", ") : undefined;
  const payType = mapPayType(detail.employmentType);
  const commitment = mapCommitment(detail.employmentType);
  const locationType = mapLocationType(locations);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable/ambiguous value) is not a skip condition, only a structural
  // problem is (missing uuid, name, companyName, description, url, or
  // createdOn — all checked above). Same convention as every other adapter
  // in this project.

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "rippling",
      title,
      description,
      company,
      payType,
      commitment,
      locationType,
      location,
      linkToApply,
      postedAt,
    },
  };
}

/** The detail response's `workLocations` is preferred (the more
 * authoritative, single-source-of-truth field — see Finding 2); falls back
 * to the list-aggregated `locationLabels` only if the detail response is
 * missing or empty on this field. */
function resolveLocations(detail: RipplingJobDetail, candidate: ListCandidate): string[] {
  const fromDetail = Array.isArray(detail.workLocations)
    ? detail.workLocations.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
    : [];
  return fromDetail.length > 0 ? fromDetail : candidate.locationLabels;
}

/**
 * Maps `employmentType.label` (the MACHINE code — see the id/label-swap
 * note on `RipplingJobDetail`) -> `payType`. `SALARIED_FT` -> "salary",
 * `HOURLY_FT` -> "hourly". `CONTRACTOR` and `TEMP` map to neither — a
 * contractor's/temp's actual pay structure isn't stated by this field, and
 * `payRangeDetails`' own `frequency` was only ever observed as "YEAR" on
 * real postings checked during this adapter's development (never "HOUR"),
 * so it adds no further signal here. See Finding 5.
 */
function mapPayType(employmentType: RipplingLabeled | undefined): Job["payType"] | undefined {
  const code = asTrimmedString(employmentType?.label);
  if (code === "SALARIED_FT") return "salary";
  if (code === "HOURLY_FT") return "hourly";
  return undefined;
}

/**
 * Maps `employmentType.label` -> `commitment`. `SALARIED_FT`/`HOURLY_FT`
 * both -> "full-time" (both real values observed only ever paired with a
 * full-time relationship on postings checked during development — Rippling
 * exposes no separate part-time code among the four values seen).
 * `CONTRACTOR` -> "contract". `TEMP` (temporary/intern) maps to neither —
 * same reasoning Lever's and SmartRecruiters' `mapCommitment` apply to an
 * internship relationship: it isn't one of `commitment`'s three values, and
 * forcing it into the nearest bucket would misrepresent it. Not asserted to
 * be an exhaustive list of every value a Rippling customer could configure;
 * an unseen value safely falls through to `undefined`. See Finding 5.
 */
function mapCommitment(employmentType: RipplingLabeled | undefined): Job["commitment"] | undefined {
  const code = asTrimmedString(employmentType?.label);
  if (code === "SALARIED_FT" || code === "HOURLY_FT") return "full-time";
  if (code === "CONTRACTOR") return "contract";
  return undefined;
}

/**
 * Classifies a posting's resolved location list (Finding 2) into
 * `locationType`. Each label is classified individually by prefix — a label
 * starting with "remote" (case-insensitive) is "remote", one starting with
 * "hybrid" is "hybrid", anything else (a plain city/region string) is
 * "onsite" — then the posting's overall `locationType` is that ONE kind
 * only if every label agrees; a posting with no locations, or whose labels
 * disagree (e.g. "Austin, TX" alongside "Remote (United States)" — a real,
 * common shape: a role open to either in-person or fully-remote
 * candidates), returns `undefined` rather than guessing which kind
 * "counts". Measured against the real `rippling` board's 328 distinct jobs
 * (2026-09-23): 275 unanimously onsite, 26 unanimously remote, 4
 * unanimously hybrid, 23 genuinely mixed (this function's `undefined`
 * case) — mixed postings are a real, non-negligible ~7% of the board, not
 * an edge case worth forcing a guess for. Per this project's standing rule
 * against forcing a closed enum from ambiguous data (see greenhouse.ts's
 * `mapPayType`), that ambiguity is reported honestly as "not stated" rather
 * than resolved by picking whichever label happened to be aggregated first.
 */
function mapLocationType(locations: string[]): Job["locationType"] | undefined {
  if (locations.length === 0) return undefined;

  const kinds = new Set(
    locations.map((label): "remote" | "hybrid" | "onsite" => {
      const lower = label.toLowerCase();
      if (lower.startsWith("remote")) return "remote";
      if (lower.startsWith("hybrid")) return "hybrid";
      return "onsite";
    }),
  );

  if (kinds.size !== 1) return undefined;
  const [only] = kinds;
  return only;
}
