import type { Job } from "@app/shared";
import {
  AuthFailedError,
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
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    let page = 1;
    let seen = 0;

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

    return { jobs, skipped };
  }

  async #fetchPage(criteria: SearchCriteria, page: number): Promise<UsajobsSearchResponse> {
    const url = new URL(this.#baseUrl);
    if (criteria.keyword) url.searchParams.set("Keyword", criteria.keyword);
    if (criteria.location) url.searchParams.set("LocationName", criteria.location);
    url.searchParams.set("ResultsPerPage", String(this.#resultsPerPage));
    url.searchParams.set("Page", String(page));

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
  if (response.status === 401 || response.status === 403) {
    throw new AuthFailedError(
      `USAJOBS rejected our credentials (HTTP ${response.status}). Check USAJOBS_API_KEY and USAJOBS_USER_AGENT.`,
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
  RateIntervalCode?: string;
};

type UsajobsSchedule = {
  Name?: string;
};

type UsajobsDetails = {
  JobSummary?: string;
  QualificationSummary?: string;
  /** "Yes" | "No" in USAJOBS' actual payload — a string, not a bool. */
  TeleworkEligible?: string;
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
    const code = d.PositionRemuneration?.[0]?.RateIntervalCode ?? "(none)";
    return {
      ok: false,
      externalId,
      reason: `cannot determine payType from RateIntervalCode "${code}"`,
    };
  }

  const commitment = mapCommitment(d.PositionSchedule);
  if (!commitment) {
    const name = d.PositionSchedule?.[0]?.Name ?? "(none)";
    return {
      ok: false,
      externalId,
      reason: `cannot determine commitment from PositionSchedule "${name}"`,
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
 * (Per Day, Biweekly, Per Case, Without Compensation, ...) genuinely could
 * be either "hourly" or "salary" depending on the position, and Job#payType
 * has no third option — so we surface it as unmappable instead of guessing.
 */
function mapPayType(remuneration: UsajobsRemuneration[] | undefined): Job["payType"] | undefined {
  const code = remuneration?.[0]?.RateIntervalCode;
  if (code === "Per Year") return "salary";
  if (code === "Per Hour") return "hourly";
  return undefined;
}

/**
 * USAJOBS' PositionSchedule.Name has values beyond a clean full/part split
 * (e.g. "Intermittent", "Multiple Schedules", "Shift Work") — those are
 * left unmapped rather than guessed. USAJOBS postings are federal
 * *employment*, never a contractor engagement, so "contract" is never
 * produced by this adapter.
 */
function mapCommitment(schedule: UsajobsSchedule[] | undefined): Job["commitment"] | undefined {
  const name = schedule?.[0]?.Name;
  if (name === "Full-time") return "full-time";
  if (name === "Part-time") return "part-time";
  return undefined;
}

/**
 * USAJOBS has no single clean tri-state remote/onsite/hybrid field. We
 * combine the two closest signals: `RemoteIndicator` (added to the API to
 * flag fully remote postings) and `TeleworkEligible` (whether the position
 * allows some telework). Any position where telework eligibility can't be
 * read is left unmapped rather than defaulted to "onsite".
 */
function mapLocationType(details: UsajobsDetails | undefined): Job["locationType"] | undefined {
  if (details?.RemoteIndicator === true) return "remote";
  if (details?.RemoteIndicator === false && details.TeleworkEligible === "Yes") return "hybrid";
  if (details?.RemoteIndicator === false && details.TeleworkEligible === "No") return "onsite";
  return undefined;
}
