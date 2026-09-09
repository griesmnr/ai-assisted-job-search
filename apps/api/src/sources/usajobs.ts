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
// not by `MAX_PAGES`'s 200-page ceiling. Live-measured, 2026-09-09: a
// 5-phrase run made ~49 total requests (4+17+23+2+3) against the SAME
// USAJOBS API the OLD no-keyword path made 200 requests to for a worse
// (unfocused) result. 10 covers the realistic range with room to spare:
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
   * If any sub-search throws, the whole call throws -- the same contract
   * `#searchOne`/`search()` already had for a single keyword. Real,
   * disclosed gap (opus review F4, not fixed here -- filed as ticket
   * c419a12 for real per-phrase isolation matching SmartRecruiters'/
   * Greenhouse's own precedent, tickets b723fb9/491cd88): unlike those
   * adapters, one phrase's transient failure currently discards every
   * OTHER phrase's already-completed results. `CompositeSource`
   * (composite.ts) still isolates USAJOBS's total failure from the
   * other configured sources, so this degrades USAJOBS to "failed" for
   * this run rather than failing the whole search -- the blast radius is
   * contained, just not as gracefully as it could be.
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
    const resultsByIndex: SourceSearchResult[] = new Array(phrases.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex;
        if (i >= phrases.length) return;
        nextIndex = i + 1;
        resultsByIndex[i] = await this.#searchOne({ ...criteria, keyword: phrases[i] });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(KEYWORD_SEARCH_CONCURRENCY, phrases.length) }, () => worker()),
    );

    // Deduped by externalId -- opus review F3: the OLD version deduped
    // `jobs` but pushed every sub-search's `skipped` unconditionally,
    // so the SAME unmappable posting matching N phrases counted N times
    // toward `skipRate`, which can spuriously trip
    // `fetchSourceWorker.ts`'s high-skip-rate mapper-bug alert. Skipped
    // records lack a stable identity field as clean as `NormalizedJob`'s
    // `externalId` in the general case, but `SkippedRecord.externalId`
    // (when present) is the same real id a job would have had, so
    // dedup on it exactly like `jobs` above; a record with no
    // extractable id (`externalId: undefined`) can't collide with
    // itself this way and is kept as-is.
    const seenExternalIds = new Set<string>();
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];
    for (const result of resultsByIndex) {
      for (const job of result.jobs) {
        if (seenExternalIds.has(job.externalId)) continue;
        seenExternalIds.add(job.externalId);
        jobs.push(job);
      }
      for (const skip of result.skipped) {
        if (skip.externalId !== undefined && seenExternalIds.has(skip.externalId)) continue;
        if (skip.externalId !== undefined) seenExternalIds.add(skip.externalId);
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
    throw new MalformedResponseError("USAJOBS response was not valid JSON", { cause: err });
  }

  return parseSearchResponseShape(body);
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
