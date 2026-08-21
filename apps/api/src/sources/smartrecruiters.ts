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
} from "./types.js";

// ---------------------------------------------------------------------------
// Adapter for the SmartRecruiters public Posting API
// (https://developers.smartrecruiters.com/docs/job-postings), fourth ATS
// ecosystem after Greenhouse, Lever, and Ashby. Skews large-enterprise
// (BoschGroup alone: ~4,780 open postings), which complements the
// startup/mid-market boards the other three adapters cover.
//
//   GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=N&offset=M
//   GET https://api.smartrecruiters.com/v1/companies/{companyId}/postings/{id}
//
// No auth on either endpoint. Everything below was verified against live
// responses on 2026-08-21 (see this file's report for the exact commands);
// trimmed real fixtures are under __fixtures__/smartrecruiters-real-response-*.
//
// ---------------------------------------------------------------------------
// FINDING 1 — the 200-with-zero-results trap (the reason this ticket exists)
// ---------------------------------------------------------------------------
//
// `GET .../companies/{companyId}/postings` returns HTTP 200 with
// `{"totalFound":0,"content":[]}` for BOTH a real company with no current
// openings AND a company identifier SmartRecruiters has never heard of.
// Verified live: BoschGroup (real, totalFound 4,780+) vs six guessed
// identifiers — Ubisoft, IKEA, Publicis, McDonalds, Skechers, and a string
// of deliberately-nonsense slugs (Zzxxqqfakebrand, RandomCompanyXYZ123,
// TotallyBogusXYZ123) — all returned byte-identical 200/0 envelopes. No
// header, no response field, nothing in the postings API itself
// distinguishes them.
//
// A real, separate signal DOES exist, just not on the postings API: every
// SmartRecruiters customer has a public careers microsite reachable at
//
//   GET https://careers.smartrecruiters.com/{companyId}    (redirect: manual)
//
// A real company either serves its careers page directly from that host
// (HTTP 200 — verified: Visa, McKesson, Bureau Veritas, Sixt, Nike, and —
// contrary to this ticket's own framing — Twilio, whose
// careers.smartrecruiters.com/Twilio page is a genuine, fully-rendered
// "Careers at Twilio" page even though its postings totalFound is
// currently 0; Twilio turned out to be a real customer with a real hiring
// freeze, not a guessed identifier, which is itself a live demonstration
// of exactly the distinction this adapter exists to make) or 302-redirects
// to its own custom domain (verified: BoschGroup -> https://jobs.bosch.com/en).
// An unrecognized identifier instead 302-redirects to the bare
// SmartRecruiters marketing homepage:
//
//   Location: https://jobs.smartrecruiters.com
//
// exactly and only that URL (no path, no query string) — verified
// identical across Ubisoft, IKEA, Publicis, McDonalds, Skechers, and every
// nonsense slug tried, never once observed for a real customer even when
// that customer's own postings total is 0. See `#checkCompanyValidity`.
//
// This check costs one extra HTTP request, but only in the ambiguous case:
// it is skipped entirely for any company whose first postings page comes
// back with totalFound > 0, since a non-empty result already proves the
// identifier is real. It only fires when the postings API alone can't tell
// broken from empty — which is exactly the situation this ticket says must
// never be resolved by silently returning `[]`.
//
// ---------------------------------------------------------------------------
// FINDING 2 — the list endpoint carries NO description text, at all, ever
// ---------------------------------------------------------------------------
//
// This is a harder failure mode than Greenhouse's (which needs
// `?content=true` to include `content`) or Lever's (which includes full
// text unconditionally): SmartRecruiters' `/postings` list endpoint does
// not expose a description field under ANY parameter combination tried —
// `fields=jobAd`, `fields=jobAd(sections)`, `expand=jobAd`, `include=jobAd`,
// explicit `fields=...` allowlists — every single one returned the exact
// same 17-key summary shape (id, name, company, location, typeOfEmployment,
// customField, releasedDate, ref, refNumber, ...), never `jobAd`. The full
// job ad — including `postingUrl`, the human-facing apply link — exists
// ONLY on the single-posting detail endpoint:
//
//   GET .../companies/{companyId}/postings/{id}
//
// So unlike every other adapter in this project, `description` (and
// `linkToApply`) cannot be filled from the list response at all; a detail
// fetch is mandatory for every posting this adapter returns, not an
// optional enrichment. See `#fetchDetail` and "cost" below.
//
// ---------------------------------------------------------------------------
// FINDING 3 — `qualifications`, the sibling field a naive mapper drops
// ---------------------------------------------------------------------------
//
// A detail response's `jobAd.sections` carries up to five keys:
// `companyDescription`, `jobDescription`, `qualifications`,
// `additionalInformation`, and an optional `videos` (a list of YouTube
// URLs, not text — deliberately excluded). A mapper that reads only
// `jobDescription` — the section whose name most resembles "the
// description" — silently drops `qualifications`, which is where the
// actual requirements live (verified on a real posting,
// __fixtures__/smartrecruiters-real-response-bosch-detail-ai-research-scientist.json:
// "Ph.D. in Computer Science", "Python, C++", "CVPR, ICCV, ECCV" all live
// ONLY in `qualifications`, nowhere in `jobDescription`). This is the same
// class of bug as Lever's `lists` miss — a "requirements" section that
// looks like extra color copy but is actually load-bearing for resume
// matching. `buildDescription` folds all four text sections in, not just
// one; see this file's test suite for a demonstration that a
// `jobDescription`-only implementation fails the exact assertion a full
// implementation passes.
//
// ---------------------------------------------------------------------------
// FINDING 4 — structured fields that ARE trustworthy, and the one that isn't
// ---------------------------------------------------------------------------
//
// - `location.remote` / `location.hybrid` are genuine booleans, present on
//   every real posting checked (200+ postings across BoschGroup and Sixt,
//   2026-08-21) — never missing, never any other type. `remote: true` ->
//   "remote", `hybrid: true` -> "hybrid" (with a `hybridDescription` string
//   sibling on real records, e.g. "Teletrabalho: 3x/semana" — not stored,
//   since `Job.locationType` is a closed enum, but confirms the boolean is
//   deliberately set, not a stray default), both false -> "onsite". See
//   `mapLocationType`.
//
//   CAVEAT, not swept under the rug: one real posting
//   (__fixtures__/smartrecruiters-real-response-bosch-detail-communications-assistant.json)
//   has `location.hybrid: false` while its `additionalInformation` prose
//   states "Modelo de trabalho: Híbrido (2x por semana)" (work model:
//   hybrid, 2x/week) — the structured field and the free text disagree on
//   this one record. Per this project's standing rule against parsing
//   prose into a closed enum (see greenhouse.ts), the structured boolean is
//   trusted and the prose is not parsed — `mapLocationType` returns
//   "onsite" for this record, which may itself be a data-entry mistake on
//   Bosch's side, not this adapter's. Flagged here rather than hidden so a
//   future reviewer isn't the one who has to rediscover it.
//
// - `typeOfEmployment.id` maps cleanly onto `commitment`: observed values
//   "permanent" (SmartRecruiters' own `label` for this is literally
//   "Full-time" — not this adapter's inference), "part-time", "contract",
//   and "intern" (left `undefined` — "internship" isn't one of `commitment`'s
//   three values, same reasoning Lever's `mapCommitment` uses). Checked
//   across BoschGroup + Sixt, 2026-08-21; per Lever's `mapCommitment` scar
//   tissue, this is not asserted to be an exhaustive cross-company enum —
//   SmartRecruiters customers may configure other values this adapter
//   hasn't seen, which fall through to `undefined` rather than a guess.
//
// - `payType` has no reliable source and is always `undefined`, same
//   conclusion and same reasoning as Greenhouse: the only compensation-
//   adjacent field is a `customField` entry labeled "Global Salary Level"
//   whose values ("Experienced/ Middle Tariff") are an internal grading
//   tier, not hourly-vs-salary. Actual pay figures do appear as prose in
//   `additionalInformation` on some US postings (e.g. "$165,000 - $185,000"
//   in the AI Research Scientist fixture) but, like Greenhouse's
//   pay-transparency prose, there is no consistent machine-parsable format
//   across companies — not a basis for a closed-enum answer.
//
// ---------------------------------------------------------------------------
// FINDING 5 — no Lever-style multi-location sibling; a per-record cost
// finding instead
// ---------------------------------------------------------------------------
//
// Checked for a `locations`/`allLocations`-equivalent array on both the
// list and detail shapes (all keys enumerated across 100+ real postings) —
// none exists. Every posting has exactly one `location` object with a
// single `fullLocation` string. So unlike Lever, there is no second
// location field this adapter could silently miss.
//
// What SmartRecruiters has instead of a second dropped *field* is a
// dropped *cost*: because description requires a per-posting detail fetch
// (Finding 2), a full board sync is N+1 requests, not 1. Measured live
// 2026-08-21 against BoschGroup: 10 sequential detail fetches took 6.25s
// (~625ms/request, latency-dominated); 30 concurrent fetches (20 workers)
// took 1.62s with zero 429s or errors. No `Retry-After`/rate-limit header
// was ever observed at that concurrency. Extrapolated (not further
// measured at full scale): 4,782 sequential detail fetches would take
// roughly 50 minutes for BoschGroup alone. This adapter fetches detail
// for every summary a company returns — filtering `criteria.keyword`
// against only `name`/summary fields and skipping the detail fetch for
// non-matches would be faster, but Finding 3 already proved a keyword
// living only in `qualifications` is invisible at the summary level (a
// live check: `q=SharePoint` server-side search, and title/summary-only
// filtering, both silently missed a real posting whose only "SharePoint"
// mention was inside `qualifications` — see the report for this ticket).
// Skipping detail fetches to save time would reintroduce exactly the
// silent-miss failure this project's post-mortems exist to prevent, so
// `search()` always fetches detail for every summary and filters against
// the fully assembled text, same discipline as Greenhouse/Lever, at
// SmartRecruiters' higher (but bounded and measured, not guessed) cost.
// `criteria.location`, unlike `criteria.keyword`, has no such hidden-field
// risk (Finding 5's own conclusion: location is never split across a
// second field) so it IS safe to apply before the detail fetch, and doing
// so measurably cuts the number of detail requests for a location-scoped
// search. See `#searchCompany`.
//
// Per-record and per-company failure isolation, and bounded concurrency for
// the detail-fetch fan-out, are implemented directly in this file; see
// `mapWithConcurrency`, `#searchCompany`, and `search()`.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.smartrecruiters.com/v1/companies";
const DEFAULT_CAREERS_BASE_URL = "https://careers.smartrecruiters.com";
const DEFAULT_TIMEOUT_MS = 15_000;
/** SmartRecruiters caps `limit` at 100 regardless of what's requested —
 * verified live (asked for 1000 and 10000, both echoed back `limit: 100`
 * and returned exactly 100 records). */
const MAX_PAGE_SIZE = 100;
/** Safety valve against an infinite pagination loop, matching
 * usajobs.ts's `DEFAULT_MAX_PAGES` reasoning: comfortably above any
 * realistic board size (BoschGroup's ~4,780 postings / 100 per page is 48
 * pages) even if `totalFound` drifts upward mid-fetch as new postings land. */
const DEFAULT_MAX_PAGES = 500;
/** How many per-posting detail requests to run at once. Verified live
 * (2026-08-21): 30 concurrent detail fetches against BoschGroup completed
 * with zero 429s or errors. Kept well below that observed-safe ceiling —
 * this is a shared, unauthenticated public API, and every other adapter in
 * this project (Greenhouse, Lever) deliberately stays conservative against
 * exactly that kind of API rather than spending whatever headroom a single
 * measurement happened to show. */
const DEFAULT_DETAIL_CONCURRENCY = 5;

/** The exact, verified redirect target SmartRecruiters sends unrecognized
 * `careers.smartrecruiters.com/{companyId}` requests to. See Finding 1. */
const UNRECOGNIZED_COMPANY_REDIRECT = "https://jobs.smartrecruiters.com";

export type SmartRecruitersConfig = {
  /** One SmartRecruiters company identifier per configured employer, e.g.
   * `["BoschGroup"]` — the same identifier that appears in
   * `https://careers.smartrecruiters.com/{companyId}` and in the postings
   * API path. Each is fetched independently; `search()` merges the results
   * and isolates one company's failure from the others (see `search()`). */
  companies: string[];
  /** Override for testing; defaults to the real SmartRecruiters Posting API
   * host (`https://api.smartrecruiters.com/v1/companies`). */
  baseUrl?: string;
  /** Override for testing; defaults to the real SmartRecruiters careers
   * microsite host, used only to disambiguate an unrecognized company
   * identifier from a real company with zero current openings (Finding 1). */
  careersBaseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Postings-list page size; capped at `MAX_PAGE_SIZE` regardless of what's
   * passed, matching the real API's own cap. */
  pageSize?: number;
  maxPages?: number;
  /** How many per-posting detail requests to run concurrently. See
   * `DEFAULT_DETAIL_CONCURRENCY`'s doc comment for the measurement behind
   * the default. */
  detailConcurrency?: number;
};

/**
 * Reads the configured company identifiers from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. SmartRecruiters' public Posting API needs no credentials,
 * so like Greenhouse and Lever (and unlike USAJOBS) there is no key/secret
 * to read.
 */
export function createSmartRecruitersSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SmartRecruitersSource {
  const raw = env.SMARTRECRUITERS_COMPANIES;
  const companies = (raw ?? "")
    .split(",")
    .map((company) => company.trim())
    .filter((company) => company.length > 0);
  if (companies.length === 0) {
    throw new Error(
      'SMARTRECRUITERS_COMPANIES must be set to a comma-separated list of SmartRecruiters company identifiers (e.g. "BoschGroup").',
    );
  }
  return new SmartRecruitersSource({ companies });
}

export class SmartRecruitersSource implements JobSource {
  readonly dataSource = "smartrecruiters" as const;

  readonly #companies: string[];
  readonly #baseUrl: string;
  readonly #careersBaseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #detailConcurrency: number;

  constructor(config: SmartRecruitersConfig) {
    if (config.companies.length === 0) {
      throw new Error("SmartRecruitersSource requires at least one company identifier.");
    }
    this.#companies = config.companies;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#careersBaseUrl = config.careersBaseUrl ?? DEFAULT_CAREERS_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#pageSize = Math.min(config.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    this.#maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
    this.#detailConcurrency = config.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Per-company isolation, and broader than Greenhouse/Lever's "only a
    // 404 is isolated, everything else aborts the whole search" — a
    // deliberate difference, not an oversight. Those two adapters make
    // exactly one request per company, so a non-404 failure there
    // (429/5xx/timeout/malformed) plausibly affects every configured
    // company equally and is worth surfacing by aborting immediately. This
    // adapter makes potentially thousands of requests per company (Finding
    // 2/5), which is proportionally far more surface for a single
    // company's transient hiccup — and the ticket for this adapter calls
    // out per-company isolation as its own acceptance criterion, separate
    // from the identity-verification one. So here, ANY failure while
    // processing one company (list-page fetch, validity check, or the
    // detail fan-out) is caught, recorded, and the loop moves on to the
    // next company rather than discarding every other company's results.
    for (const company of this.#companies) {
      try {
        const result = await this.#searchCompany(company, criteria);
        jobs.push(...result.jobs);
        skipped.push(...result.skipped);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        skipped.push({
          externalId: undefined,
          reason: `SmartRecruiters search failed for company "${company}": ${message}`,
        });
      }
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;

    return { jobs, skipped, skipRate };
  }

  async #searchCompany(
    company: string,
    criteria: SearchCriteria,
  ): Promise<{ jobs: NormalizedJob[]; skipped: SkippedRecord[] }> {
    const firstPage = await this.#fetchPostingsPage(company, 0);

    if (firstPage.totalFound === 0) {
      // The 200-with-zero-results trap (Finding 1). Only pay for the
      // disambiguating request when the postings API itself is ambiguous —
      // a non-empty result already proves the identifier is real, so this
      // branch is the ONLY place `#checkCompanyValidity` is ever called.
      const validity = await this.#checkCompanyValidity(company);
      if (validity.status === "invalid") {
        return {
          jobs: [],
          skipped: [
            {
              externalId: undefined,
              reason: `SmartRecruiters company identifier "${company}" is not recognized (careers.smartrecruiters.com/${company} redirects to the generic SmartRecruiters homepage, not a company careers page or a company-specific domain) — this looks like a typo'd or defunct identifier, not a company with zero current openings`,
            },
          ],
        };
      }
      if (validity.status === "unknown") {
        // Honesty over convenience: we could not positively confirm this
        // identifier is real, so this is NOT reported as a legitimate empty
        // board (that would be silently trusting an inconclusive check).
        // Per this ticket's explicit instruction, when the distinguishing
        // signal can't be read, that gets surfaced rather than papered
        // over as if the check had succeeded.
        return {
          jobs: [],
          skipped: [
            {
              externalId: undefined,
              reason: `SmartRecruiters company identifier "${company}" returned zero postings, and its validity could not be confirmed (${validity.reason}) — treat this result with suspicion, not as a confirmed empty board`,
            },
          ],
        };
      }
      // validity.status === "valid": a real company that currently has no
      // open postings. A legitimate empty result, same as a Greenhouse or
      // Lever board with `jobs: []` — not a skip.
      return { jobs: [], skipped: [] };
    }

    // Non-empty result: the identifier is proven real by having actual
    // postings. Collect every summary across all pages.
    const summaries: SmartRecruitersPostingSummary[] = [...firstPage.content];
    let offset = firstPage.content.length;
    let page = 1;
    let latestTotal = firstPage.totalFound;
    while (
      summaries.length > 0 &&
      offset < latestTotal &&
      firstPage.content.length > 0 &&
      page < this.#maxPages
    ) {
      const next = await this.#fetchPostingsPage(company, offset);
      if (next.content.length === 0) break;
      summaries.push(...next.content);
      offset += next.content.length;
      // Boards genuinely change size mid-fetch (see lever.ts's precedent
      // note on this) — re-read totalFound each page rather than trusting
      // the first page's count for the whole loop.
      latestTotal = next.totalFound;
      page += 1;
    }

    // criteria.location is safe to apply here, before the detail fetch:
    // Finding 5 found no second location field anywhere on this API (no
    // Lever-style `allLocations`), so nothing is at risk of being missed by
    // filtering on the summary's own `location` now rather than after
    // fetching full detail. criteria.keyword is NOT applied here — Finding
    // 3 proved real requirements text (and therefore real keyword matches)
    // exists only in `qualifications`, which the summary shape never
    // carries at all.
    const candidates = criteria.location
      ? summaries.filter((s) => summaryMatchesLocation(s, criteria.location as string))
      : summaries;

    const results = await mapWithConcurrency(candidates, this.#detailConcurrency, (summary) =>
      this.#fetchAndNormalize(company, summary, criteria),
    );

    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];
    for (const result of results) {
      if (result.kind === "job") jobs.push(result.job);
      else if (result.kind === "skip") skipped.push(result.record);
      // result.kind === "filtered-out": not a skip, just didn't match
      // criteria.keyword — same semantics as Greenhouse/Lever's client-side
      // filtering, which never counts a non-match as a mapping failure.
    }

    return { jobs, skipped };
  }

  /**
   * Fetches full detail for one posting and either normalizes it into a
   * `Job`, records why it was skipped, or reports it as filtered out by
   * `criteria.keyword`. Never throws — every failure mode (detail fetch
   * error, structural mapping failure) is caught here and turned into a
   * per-record result, so one bad posting can never take down the rest of
   * a company's search, however many thousands of postings that company has.
   */
  async #fetchAndNormalize(
    company: string,
    summary: SmartRecruitersPostingSummary,
    criteria: SearchCriteria,
  ): Promise<
    | { kind: "job"; job: NormalizedJob }
    | { kind: "skip"; record: SkippedRecord }
    | { kind: "filtered-out" }
  > {
    const externalId =
      typeof summary.id === "string" && summary.id.length > 0 ? summary.id : undefined;

    let detail: SmartRecruitersPostingDetail;
    try {
      detail = await this.#fetchDetail(company, summary.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "skip",
        record: {
          externalId,
          reason: `failed to fetch full posting detail (needed for description and apply link): ${message}`,
        },
      };
    }

    const fullDescription = buildDescription(detail);

    if (criteria.keyword) {
      const keyword = criteria.keyword.toLowerCase();
      const title = summary.name?.toLowerCase() ?? "";
      if (!title.includes(keyword) && !fullDescription.toLowerCase().includes(keyword)) {
        return { kind: "filtered-out" };
      }
    }

    const result = normalizeItem(summary, detail, company, fullDescription);
    if (result.ok) return { kind: "job", job: result.job };
    return { kind: "skip", record: { externalId: result.externalId, reason: result.reason } };
  }

  async #fetchPostingsPage(company: string, offset: number): Promise<SmartRecruitersPostingsPage> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(company)}/postings`);
    url.searchParams.set("limit", String(this.#pageSize));
    url.searchParams.set("offset", String(offset));

    const response = await this.#request(url, `postings list for company "${company}"`);
    return parsePostingsPageShape(
      await parseJsonBody(response, `postings list for company "${company}"`),
      company,
    );
  }

  async #fetchDetail(company: string, id: string): Promise<SmartRecruitersPostingDetail> {
    const url = new URL(
      `${this.#baseUrl}/${encodeURIComponent(company)}/postings/${encodeURIComponent(id)}`,
    );
    const response = await this.#request(url, `posting detail "${id}" for company "${company}"`);
    return parsePostingDetailShape(
      await parseJsonBody(response, `posting detail "${id}" for company "${company}"`),
      company,
      id,
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
          `SmartRecruiters request for ${describe} timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `SmartRecruiters request for ${describe} failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    classifyErrorStatus(response, describe);
    return response;
  }

  /**
   * The disambiguating check from Finding 1. Only ever called when a
   * company's postings search came back with `totalFound: 0` — see
   * `#searchCompany`.
   */
  async #checkCompanyValidity(
    company: string,
  ): Promise<{ status: "valid" } | { status: "invalid" } | { status: "unknown"; reason: string }> {
    const url = `${this.#careersBaseUrl}/${encodeURIComponent(company)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        // Manual, not "follow": the real careers.smartrecruiters.com/{id}
        // response for BOTH a valid company on SmartRecruiters' own hosted
        // domain (200) and an invalid one (302 -> the generic homepage,
        // also ultimately 200 once followed) end up at a 200 status if
        // redirects are followed — the distinguishing signal is the FIRST
        // hop's status/Location header, not the final page. See Finding 1.
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "unknown", reason: `career-site check failed: ${message}` };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 200 && response.status < 300) {
      return { status: "valid" };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")?.trim().replace(/\/$/, "");
      if (location === UNRECOGNIZED_COMPANY_REDIRECT) {
        return { status: "invalid" };
      }
      // Redirects somewhere else entirely (a company's own custom domain,
      // e.g. jobs.bosch.com) -> a real, verified customer.
      return { status: "valid" };
    }
    return {
      status: "unknown",
      reason: `career-site check returned unexpected HTTP status ${response.status}`,
    };
  }
}

function classifyErrorStatus(response: Response, describe: string): void {
  if (response.status === 404) {
    throw new UnexpectedStatusError(`SmartRecruiters returned HTTP 404 for ${describe}`, 404);
  }
  if (response.status === 401) {
    // Not observed against the real API (it takes no credentials), but
    // classified for completeness, matching every other adapter here.
    throw new AuthFailedError(`SmartRecruiters rejected the request for ${describe} (HTTP 401)`);
  }
  if (response.status === 403) {
    throw new ForbiddenError(`Request for ${describe} was blocked with HTTP 403`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `SmartRecruiters rate limit exceeded (HTTP 429) for ${describe}`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `SmartRecruiters server error (HTTP ${response.status}) for ${describe}`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `SmartRecruiters returned unexpected HTTP status ${response.status} for ${describe}`,
      response.status,
    );
  }
}

async function parseJsonBody(response: Response, describe: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    throw new MalformedResponseError(
      `SmartRecruiters response for ${describe} was not valid JSON`,
      {
        cause: err,
      },
    );
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
// Bounded concurrency for the per-posting detail fan-out (Finding 2/5). No
// dependency in this workspace does this already (checked apps/api's
// package.json), so a small worker-pool helper lives here rather than
// pulling in a new package for one function.
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
// SmartRecruiters response shapes — only the fields this adapter reads.
// Verified against real captured responses; see this file's top-of-file
// comment and __fixtures__/smartrecruiters-real-response-*.
// ---------------------------------------------------------------------------

type SmartRecruitersLocation = {
  city?: string;
  region?: string;
  country?: string;
  fullLocation?: string;
  remote?: boolean;
  hybrid?: boolean;
  hybridDescription?: string;
};

type SmartRecruitersTypeOfEmployment = {
  id?: string;
  label?: string;
};

type SmartRecruitersPostingSummary = {
  id: string;
  name?: string;
  company?: { identifier?: string; name?: string };
  location?: SmartRecruitersLocation;
  typeOfEmployment?: SmartRecruitersTypeOfEmployment;
  releasedDate?: string;
};

type SmartRecruitersPostingsPage = {
  offset: number;
  limit: number;
  totalFound: number;
  content: SmartRecruitersPostingSummary[];
};

type SmartRecruitersJobAdSection = {
  title?: string;
  text?: string;
};

type SmartRecruitersPostingDetail = {
  id?: string;
  name?: string;
  company?: { identifier?: string; name?: string };
  location?: SmartRecruitersLocation;
  typeOfEmployment?: SmartRecruitersTypeOfEmployment;
  releasedDate?: string;
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: {
      companyDescription?: SmartRecruitersJobAdSection;
      jobDescription?: SmartRecruitersJobAdSection;
      qualifications?: SmartRecruitersJobAdSection;
      additionalInformation?: SmartRecruitersJobAdSection;
      // `videos` also lives here on some real postings
      // (__fixtures__/smartrecruiters-real-response-bosch-detail-remote.json)
      // but carries `urls: string[]`, not text — deliberately not typed or
      // read here; see Finding 3.
    };
  };
};

function parsePostingsPageShape(body: unknown, company: string): SmartRecruitersPostingsPage {
  if (
    typeof body !== "object" ||
    body === null ||
    !("content" in body) ||
    !Array.isArray((body as Record<string, unknown>).content) ||
    !("totalFound" in body) ||
    typeof (body as Record<string, unknown>).totalFound !== "number"
  ) {
    throw new MalformedResponseError(
      `SmartRecruiters postings list response for company "${company}" did not match the expected shape (missing "content" array or numeric "totalFound")`,
    );
  }
  return body as SmartRecruitersPostingsPage;
}

function parsePostingDetailShape(
  body: unknown,
  company: string,
  id: string,
): SmartRecruitersPostingDetail {
  if (typeof body !== "object" || body === null) {
    throw new MalformedResponseError(
      `SmartRecruiters posting detail response for "${id}" (company "${company}") was not a JSON object`,
    );
  }
  return body as SmartRecruitersPostingDetail;
}

// ---------------------------------------------------------------------------
// Client-side location filtering, applied BEFORE the detail fetch. Safe to
// do so per Finding 5 (no second location field exists anywhere on this
// API to silently miss) — unlike keyword filtering, which must wait for the
// full assembled description (Finding 3).
// ---------------------------------------------------------------------------

function summaryMatchesLocation(summary: SmartRecruitersPostingSummary, location: string): boolean {
  const needle = location.toLowerCase();
  const haystack = summary.location?.fullLocation?.toLowerCase() ?? "";
  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Full-text assembly for `description` — see Finding 3. All four real text
// sections are folded in, in reading order, each individually stripped of
// HTML via the shared `htmlToPlainText` (./html.ts). SmartRecruiters'
// `jobAd.sections.*.text` markup is single-encoded ordinary HTML (real
// `<p>`/`<ul>`/`<strong>` tags directly, with only the markup's own
// entities encoded — e.g. `&#xa0;` for a non-breaking space) — confirmed
// against every real detail fixture captured for this adapter — so this
// uses `doubleEncoded: false` (the shared helper's default), the same
// pipeline as Lever and unlike Greenhouse's doubly-encoded `content`.
// ---------------------------------------------------------------------------

function buildDescription(detail: SmartRecruitersPostingDetail): string {
  const sections = detail.jobAd?.sections;
  if (!sections) return "";

  const parts: string[] = [];
  for (const section of [
    sections.companyDescription,
    sections.jobDescription,
    sections.qualifications,
    sections.additionalInformation,
  ]) {
    if (!section?.text) continue;
    const body = htmlToPlainText(section.text);
    if (!body) continue;
    const heading = section.title?.trim();
    parts.push(heading ? `${heading}\n${body}` : body);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(
  summary: SmartRecruitersPostingSummary,
  detail: SmartRecruitersPostingDetail,
  company: string,
  fullDescription: string,
): NormalizeResult {
  // SmartRecruiters' `id` is the platform identifier used to address a
  // specific posting — it's what both the detail endpoint and the postings
  // list key on, and (per real fixtures captured for this adapter) it is
  // stable between a posting's appearance in the list and in its own
  // detail response. `refNumber` (e.g. "REF294553D") is the company's own
  // human-assigned requisition code, not a SmartRecruiters-durable id —
  // same distinction Greenhouse draws between `id` and `requisition_id`.
  const externalId =
    typeof summary.id === "string" && summary.id.length > 0 ? summary.id : undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing id" };
  }

  const title = (detail.name ?? summary.name)?.trim();
  if (!title) {
    return { ok: false, externalId, reason: "missing name (title)" };
  }

  const company_ = (detail.company?.name ?? summary.company?.name)?.trim();
  if (!company_) {
    return { ok: false, externalId, reason: "missing company.name" };
  }

  // Full description is required — Finding 2: a posting that genuinely has
  // nothing in any of the four `jobAd.sections` text fields has nothing to
  // offer a resume matcher and is correctly a skip, not an empty string.
  const description = fullDescription.trim();
  if (!description) {
    return {
      ok: false,
      externalId,
      reason:
        "no text in jobAd.sections (companyDescription/jobDescription/qualifications/additionalInformation all empty or missing)",
    };
  }

  // `postingUrl` only exists on the detail response, not the summary
  // (Finding 2) — the human-facing careers-site link, preferred over
  // `applyUrl` (which appends an `?oga=true` tracking parameter) for the
  // same reason Greenhouse/Lever prefer their plain posting-page URL over
  // any tracking-tagged variant.
  const linkToApply = detail.postingUrl;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing postingUrl on posting detail" };
  }

  const postedAtRaw = detail.releasedDate ?? summary.releasedDate;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing releasedDate" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable releasedDate "${postedAtRaw}"` };
  }

  const location = (detail.location ?? summary.location)?.fullLocation?.trim() || undefined;
  const payType = mapPayType();
  const commitment = mapCommitment(detail.typeOfEmployment ?? summary.typeOfEmployment);
  const locationType = mapLocationType(detail.location ?? summary.location);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable value) is not a skip condition, only a structural problem
  // is (missing id, missing name, missing company, missing description,
  // missing postingUrl, missing/unparseable releasedDate — all checked
  // above). Same convention as every other adapter in this project.

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "smartrecruiters",
      title,
      description,
      company: company_,
      payType,
      commitment,
      locationType,
      location,
      linkToApply,
      postedAt,
    },
  };
}

/**
 * Always `undefined`. See Finding 4: SmartRecruiters carries no reliable
 * compensation field — `customField`'s "Global Salary Level" is an internal
 * grading tier, not hourly-vs-salary, and prose pay figures in
 * `additionalInformation` (verified present on some real US postings) have
 * no consistent cross-company format, same conclusion Greenhouse's
 * `mapPayType` reaches for the same reason. Kept as a named function
 * (rather than inlined `undefined`) so this reasoning has one place to
 * live, matching greenhouse.ts's convention.
 */
function mapPayType(): Job["payType"] | undefined {
  return undefined;
}

/**
 * Maps `typeOfEmployment.id` -> `commitment`. See Finding 4: observed
 * values across BoschGroup + Sixt (2026-08-21) are "permanent" (whose own
 * `label` SmartRecruiters sends is literally "Full-time"), "part-time",
 * "contract", and "intern". Only the first three map onto `commitment`'s
 * three enum values; "intern" is a genuinely different employment
 * relationship (same reasoning Lever's `mapCommitment` applies to
 * "Internship"), left `undefined` rather than forced into the nearest
 * bucket. Not asserted to be an exhaustive list of every value a
 * SmartRecruiters customer could configure — matched by exact id rather
 * than guessed at, so an unseen value safely falls through to `undefined`
 * instead of being misclassified.
 */
function mapCommitment(
  typeOfEmployment: SmartRecruitersTypeOfEmployment | undefined,
): Job["commitment"] | undefined {
  const id = typeOfEmployment?.id?.trim().toLowerCase();
  if (id === "permanent") return "full-time";
  if (id === "part-time") return "part-time";
  if (id === "contract") return "contract";
  return undefined;
}

/**
 * Maps `location.remote`/`location.hybrid` -> `locationType`. See Finding
 * 4: both are genuine booleans, present on every real posting checked
 * (200+ postings across two companies, 2026-08-21), never missing. `remote:
 * true` wins if both are somehow true (not observed on any real record, but
 * "remote" is the stronger claim); otherwise `hybrid: true` -> "hybrid";
 * both false -> "onsite" — an explicit, present boolean pair saying "not
 * remote, not hybrid" is a real (if occasionally supplier-erred, see
 * Finding 4's caveat) claim of on-site work, not an absence of information
 * the way a genuinely missing field would be. If a future posting is found
 * with `location` missing entirely, or `remote`/`hybrid` absent or a
 * non-boolean type, this returns `undefined` rather than guessing.
 */
function mapLocationType(
  location: SmartRecruitersLocation | undefined,
): Job["locationType"] | undefined {
  if (!location) return undefined;
  if (typeof location.remote !== "boolean" || typeof location.hybrid !== "boolean")
    return undefined;
  if (location.remote) return "remote";
  if (location.hybrid) return "hybrid";
  return "onsite";
}
