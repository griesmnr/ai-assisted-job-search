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
// Adapter for Recruitee's public Careers Site API (docs.recruitee.com), one
// HTTP call per configured company subdomain:
//
//   GET https://{company}.recruitee.com/api/offers/
//
// No auth (Recruitee's own API reference declares `"security": []` for this
// endpoint). Everything below was verified against real, live responses on
// 2026-09-23 -- see this file's report for the exact commands run; trimmed
// real fixtures are under __fixtures__/recruitee-real-response-*.json. The
// same host also accepts candidate submissions (POST) -- this adapter only
// ever issues GET requests.
//
// ---------------------------------------------------------------------------
// FINDING 1 -- pagination: there isn't any
// ---------------------------------------------------------------------------
//
// Recruitee's own API reference (docs.recruitee.com/reference/offers) lists
// every field on the response and offer objects; none of them is a
// page/total/limit/offset. Confirmed live: a real 8-posting nmbrs response is
// a single ~160KB payload with no pagination metadata anywhere in the
// envelope (`{"offers": [...]}`, nothing else at the top level). `search()`
// therefore fetches each configured company in exactly one request, same
// shape as Greenhouse/Lever/Ashby, not SmartRecruiters' paginated list.
//
// ---------------------------------------------------------------------------
// FINDING 2 -- unknown company vs. a real company with zero postings: this
// endpoint already tells the two apart, unlike SmartRecruiters
// ---------------------------------------------------------------------------
//
// Verified live 2026-09-23:
//   - a non-customer subdomain (this-company-definitely-does-not-exist-12345)
//     returns `404 {"error":"Not Found"}`.
//   - a real tenant with nothing currently open (tellent, Recruitee's own
//     parent company) returns `200 {"offers":[]}` -- byte-identical to the
//     real captured response, saved verbatim at
//     __fixtures__/recruitee-real-response-tellent.json.
// These are a clean status-code split, not a same-200 trap the way
// SmartRecruiters' `{"totalFound":0,"content":[]}` is (see smartrecruiters.ts
// Finding 1) -- no second disambiguating request is needed here. A 404 is
// recorded as a `SkippedRecord` naming the company and the 404 (same
// precedent as ashby.ts Finding 7, for the same reason: this ticket requires
// the two cases distinguishable through `SourceSearchResult`, and silently
// `continue`-ing past a 404 the way greenhouse.ts/lever.ts do would make a
// 404-only search return the exact same `{jobs: [], skipped: [], skipRate:
// 0}` shape as a genuinely quiet real tenant).
//
// ---------------------------------------------------------------------------
// FINDING 3 -- the subdomain-squatting trap: a 200 with real-looking JSON is
// not proof the tenant is the company its subdomain names
// ---------------------------------------------------------------------------
//
// Discovered while building the employer list below, NOT something this
// adapter defends against at runtime (there is no reliable machine-readable
// signal that distinguishes it from a real tenant -- see below) -- but
// documented here because it cost real wasted verification time and the next
// person widening RECRUITEE_COMPANIES needs to know to check for it.
// `https://personio.recruitee.com/api/offers/` and
// `https://multiplier.recruitee.com/api/offers/` BOTH return HTTP 200 with a
// single well-formed offer -- but `personio`'s offer has `company_name: "FD
// Sandbox"` and `title: "API Job - Berlin - Musterstr 1, 10111"`, and
// `multiplier`'s has `title: "Senior Marketer (Sample)"`. Neither is the real
// company those subdomains are named after (Personio, the HR-tech unicorn;
// Multiplier, the global payroll/EOR platform) -- these are demo/sandbox
// tenants that happen to have claimed those subdomains, with fabricated
// single-posting sample data. A naive verification pass that only checks
// "does `/api/offers/` 200?" would silently add two fake employers to the
// list below. Both were caught and excluded by reading `company_name`/
// `title` on the returned offer(s), not just the HTTP status -- every company
// actually kept in RECRUITEE_COMPANIES below was cross-checked this way (see
// that env var's own comment in .env.example for the full verification
// method).
//
// ---------------------------------------------------------------------------
// FINDING 4 -- the hidden location sibling (this ticket's own warning:
// history says every one of these adapters has one)
// ---------------------------------------------------------------------------
//
// `location` (singular) is a derived DISPLAY string -- sometimes not even a
// place name at all: a real Channable posting ("Account Executive - North
// America", __fixtures__/recruitee-real-response-channable.json, id
// 2694685) has `remote: true` and `location: "Remote job"`, literal text,
// while its structured `locations` array names the real city
// (`New York City, New York, United States`). `locations` (plural) is the
// structured sibling -- an array of full location objects, present on every
// real posting checked, sometimes carrying MULTIPLE entries `location` never
// mentions: three real bunq postings each list `location: "Amsterdam,
// Noord-Holland, Netherlands"` but `locations` names Amsterdam, Istanbul,
// AND Sofia (__fixtures__/recruitee-real-response-bunq.json, id 2642872) --
// the exact same class of bug as Lever's `allLocations`, Ashby's
// `secondaryLocations`, and Ashby's own `address.postalAddress` (finding 2c
// in ashby.ts). Both sides have real, non-overlapping search coverage:
// `location`'s "Remote job" case has no equivalent anywhere in `locations`
// (no entry says "remote"), and `locations`' Istanbul/Sofia entries have no
// equivalent in `location`'s single Amsterdam-only string. `itemLocations`
// (below) returns the union, `location` first, matching that precedent's
// "union, not replacement" shape.
//
// ---------------------------------------------------------------------------
// FINDING 5 -- `highlight`, the third description sibling a two-field mapper
// drops
// ---------------------------------------------------------------------------
//
// Recruitee offers carry not two but THREE free-text fields:  `highlight`,
// `description`, `requirements`. Content splits across them unpredictably --
// not a fixed "intro vs. requirements" pattern a mapper could rely on
// without checking. Two real, live-verified cases prove this, in OPPOSITE
// directions:
//   - TOPIC Software Development's "Senior Software Engineer" posting
//     (__fixtures__/recruitee-real-response-topicsoftwaredevelopment.json,
//     id 2713866) has real content in `highlight` -- "Technically
//     challenging projects, personal development, teamwork, software design
//     & development, innovation, high-tech, permanent contract, hybrid
//     working." The leading phrase, "Technically challenging projects", is
//     UNIQUE to `highlight` -- checked by substring search, absent from both
//     `description` and `requirements` on this same posting (the sentence's
//     trailing "hybrid working" is NOT unique -- it coincidentally also
//     appears inside `requirements`' own "flexible hours, and hybrid
//     working" line; this file's test suite deliberately asserts on the
//     leading phrase for exactly this reason, not the whole sentence). A
//     mapper that only reads `description`+`requirements` (the two fields
//     every other adapter in this project's history has needed) would
//     silently drop the unique part, exactly SmartRecruiters'
//     `additionalInformation` miss (Finding 3 in smartrecruiters.ts)
//     wearing a different field name.
//   - Channable's "Python Software Engineer - Product team" posting
//     (__fixtures__/recruitee-real-response-channable.json, id 2548164) has
//     its real engineering-skills text ("strictly typed Python (3.14), SQL,
//     Postgres, GCS, mypy, asyncio, aiohttp, pytest, Sentry, Grafana,
//     Redis") inside `description`, while `requirements` on that SAME
//     posting carries company/culture/benefits copy, not a "requirements"
//     section at all -- the field NAMES do not reliably predict which field
//     holds technical requirements text, so both still have to be read in
//     full regardless of which one "sounds like" the right one for a given
//     posting.
// `buildDescription` (below) concatenates all three, in that order
// (highlight first, as the shortest/most summary-like of the three, then the
// two longer fields), separated by blank lines.
//
// ---------------------------------------------------------------------------
// FINDING 6 -- work arrangement: real data is not mutually exclusive
// ---------------------------------------------------------------------------
//
// `remote` / `hybrid` / `on_site` are booleans, structurally like
// SmartRecruiters' `location.remote`/`location.hybrid` (smartrecruiters.ts
// Finding 4) -- but UNLIKE that field, real Recruitee data is not reliably
// one-true-of-three. Checked across every real posting fetched while
// building this adapter (65 postings, 8 companies): 54 hybrid-only, 8
// onsite-only, 1 remote-only, and 2 genuinely ambiguous real postings with
// BOTH `hybrid: true` AND `on_site: true` simultaneously (`remote: false`) --
// two real bunq postings ("Copywriting Intern", "KYC Analyst (User
// Verification)", __fixtures__/recruitee-real-response-bunq.json, id
// 2071367 for the latter). No unambiguous mapping exists for "hybrid AND
// onsite are both asserted true" -- picking either one would be a guess
// dressed up as read data, the exact thing this project's post-mortems say
// not to do. `mapLocationType` (below) requires EXACTLY one of the three
// flags to be true; zero-true or two-or-more-true both map to `undefined`.
//
// ---------------------------------------------------------------------------
// FINDING 7 -- payType: a genuinely trustworthy field, unlike Greenhouse's
// total absence or SmartRecruiters' internal-grading-tier proxy
// ---------------------------------------------------------------------------
//
// `salary.period` (`"hour"` / `"month"` / `"year"`, real values observed) is
// a direct, structured pay-cadence field -- closer to Ashby's
// `compensation.compensationTiers[].interval` than to anything Greenhouse or
// SmartRecruiters expose. Verified live: real vandebron postings state
// `{"min":"15.75","period":"hour","currency":"EUR"}` (an hourly-paid
// customer-service role) alongside other real postings stating
// `{"min":"2730","period":"month","currency":"EUR"}` -- both genuine,
// company-set values, not guessed. `mapPayType` maps `"hour"` -> `"hourly"`,
// `"month"`/`"year"` -> `"salary"`. Notably, `period` is sometimes present
// with `min`/`max` BOTH `null` (real nmbrs/bunq/vitestro postings state a pay
// CADENCE -- "this role pays monthly" -- without disclosing a figure) --
// `mapPayType` still reads `period` in that case, same reasoning as Ashby's
// `compensationTiers` entries that carry a `compensationType` with no amount
// attached (ashby.ts Finding 2b/mapPayType): the field classifies HOW the
// job pays, not what it pays, and `Job.payType` only ever asks the former.
//
// ---------------------------------------------------------------------------
// FINDING 8 -- commitment: a documented-adjacent enum, not exhaustively
// verified
// ---------------------------------------------------------------------------
//
// `employment_type_code` real values observed across 65 postings, 8
// companies: `"fulltime"`, `"fulltime_permanent"`, `"fulltime_fixed_term"`
// (all -> `"full-time"`), `"parttime_fixed_term"` (-> `"part-time"`), and
// `"internship"` (-> `undefined`, same reasoning as every other adapter's
// "Intern"/"Internship" case: not one of `commitment`'s three values). No
// real `"contract"`-prefixed value turned up on any of the 8 companies
// checked here -- flagged honestly rather than asserted as a verified
// mapping, same disclosure this project's other untested-enum-branch
// comments make (see ashby.ts's untested PartTime branch, lever.ts's
// untested per-hour payType branch).
//
// ---------------------------------------------------------------------------
// FINDING 9 -- HTML encoding and other structural fields
// ---------------------------------------------------------------------------
//
// Single-encoded, like Lever/Ashby (`doubleEncoded: false`), NOT
// double-encoded like Greenhouse: real `description`/`requirements`/
// `highlight` values contain literal unescaped tags (`<p style="...">`,
// `<ul>`, `<li>`) directly, confirmed across every fixture. A real Vitestro
// posting (id 2708084, requirements section, not saved as a fixture here --
// see this file's test suite for the exact excerpt reproduced verbatim in a
// synthetic record) additionally has a literal escaped `&gt;` sitting in
// ordinary body text ("&gt;5 years working experience...") right next to
// real unescaped tags, the same end-to-end proof shape Ashby's N1-derived
// test uses.
//
// `company_name` is present on every real offer checked (unlike Ashby, which
// has none at all) -- used directly, no fallback to the configured
// subdomain needed (matches Greenhouse's precedent, not Ashby's).
// `careers_apply_url` (the direct apply-flow link, `.../c/new`) is preferred
// over `careers_url` (the posting's own page), matching Ashby's
// applyUrl-over-jobUrl and USAJOBS' ApplyURI-over-PositionURI precedent.
// `id` (numeric) is the externalId -- stable, always present, and is what
// Recruitee's own API keys single-offer lookups on (`slug` is used in the
// public URL instead, but is not guaranteed unique the way `id` is).
// `published_at` (`"2026-09-17 15:34:42 UTC"`) parses correctly with the
// native `Date` constructor -- verified directly, not assumed.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;

export type RecruiteeConfig = {
  /** One subdomain per company, e.g. `["nmbrs", "bunq"]` -- the same string
   * that appears in `https://{company}.recruitee.com`. Each is fetched as
   * its own HTTP request; `search()` merges the results and isolates one
   * company's failure from the others. */
  companies: string[];
  /** Override for testing; defaults to building
   * `https://{company}.recruitee.com/api/offers/`. Unlike every other
   * adapter in this project, Recruitee's host itself varies per company
   * (not just the path), so this is a URL-builder function rather than a
   * fixed base URL string. */
  buildUrl?: (company: string) => string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

function defaultBuildUrl(company: string): string {
  return `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`;
}

/**
 * Reads the configured company subdomains from the environment. Throws
 * synchronously if none are configured -- a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Recruitee's public Careers Site API needs no credentials,
 * so like Greenhouse/Lever/Ashby/SmartRecruiters (and unlike USAJOBS) there
 * is no key/secret to read.
 */
export function createRecruiteeSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RecruiteeSource {
  const raw = env.RECRUITEE_COMPANIES;
  const companies = (raw ?? "")
    .split(",")
    .map((company) => company.trim())
    .filter((company) => company.length > 0);
  if (companies.length === 0) {
    throw new Error(
      'RECRUITEE_COMPANIES must be set to a comma-separated list of Recruitee company subdomains (e.g. "nmbrs,bunq").',
    );
  }
  return new RecruiteeSource({ companies });
}

export class RecruiteeSource implements JobSource {
  readonly dataSource = "recruitee" as const;

  readonly #companies: string[];
  readonly #buildUrl: (company: string) => string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(config: RecruiteeConfig) {
    if (config.companies.length === 0) {
      throw new Error("RecruiteeSource requires at least one company subdomain.");
    }
    this.#companies = config.companies;
    this.#buildUrl = config.buildUrl ?? defaultBuildUrl;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Sequential, not concurrent -- same reasoning as Lever/Ashby: a shared,
    // unauthenticated public API with no per-key rate limit to spend in
    // parallel, and a small (single-digit) configured company count that
    // doesn't need Greenhouse's bounded-concurrency-pool treatment.
    for (const company of this.#companies) {
      let data: RecruiteeOffersResponse;
      try {
        data = await this.#fetchCompany(company);
      } catch (err) {
        // Finding 2: a 404 means this specific subdomain doesn't resolve to
        // a Recruitee tenant at all (typo, never used Recruitee, moved off
        // it) -- distinct from a real tenant with zero current postings
        // (which 200s with `{"offers":[]}` and is handled by the ordinary
        // empty-array path below, not this catch). Recorded as a
        // `SkippedRecord` rather than silently dropped, matching ashby.ts
        // Finding 7's precedent, so the two cases stay distinguishable
        // through `SourceSearchResult` even when other companies are
        // configured too. Still doesn't throw, so one bad subdomain can't
        // fail the whole search.
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          skipped.push({
            externalId: undefined,
            reason: `Recruitee company "${company}" does not exist (HTTP 404) -- check the subdomain`,
          });
          continue;
        }
        throw err;
      }

      for (const item of data.offers) {
        const fullDescription = buildDescription(item);
        if (!itemMatchesCriteria(item, criteria, fullDescription)) continue;
        const result = normalizeItem(item, fullDescription);
        if (result.ok) {
          jobs.push(result.job);
        } else {
          skipped.push({ externalId: result.externalId, reason: result.reason });
        }
      }
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;

    return { jobs, skipped, skipRate };
  }

  async #fetchCompany(company: string): Promise<RecruiteeOffersResponse> {
    const url = this.#buildUrl(company);

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
          `Recruitee request for company "${company}" timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `Recruitee request for company "${company}" failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response, company);
  }
}

async function parseResponse(
  response: Response,
  company: string,
): Promise<RecruiteeOffersResponse> {
  if (response.status === 404) {
    // Real observed body: `{"error":"Not Found"}` -- see Finding 2. Status
    // code alone classifies this; the body isn't parsed.
    throw new UnexpectedStatusError(
      `Recruitee company "${company}" does not exist (HTTP 404) -- check the subdomain`,
      404,
    );
  }
  if (response.status === 401) {
    // Not observed against the real API in testing (it takes no
    // credentials), but classified for completeness, matching every other
    // adapter here.
    throw new AuthFailedError(`Recruitee rejected the request for company "${company}" (HTTP 401)`);
  }
  if (response.status === 403) {
    // Also not observed in testing; kept distinct from AuthFailedError and
    // defaulting to retryable, same reasoning as the other adapters -- more
    // likely a transient edge/WAF block than Recruitee itself rejecting an
    // unauthenticated, public request.
    throw new ForbiddenError(
      `Request for Recruitee company "${company}" was blocked with HTTP 403`,
    );
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Recruitee rate limit exceeded (HTTP 429) fetching company "${company}"`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Recruitee server error (HTTP ${response.status}) fetching company "${company}"`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Recruitee returned unexpected HTTP status ${response.status} for company "${company}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MalformedResponseError(
      `Recruitee response for company "${company}" was not valid JSON`,
      { cause: err },
    );
  }

  return parseOffersResponseShape(body, company);
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
// Recruitee response shape -- only the fields this adapter reads. Verified
// against real captured responses and docs.recruitee.com/reference/offers;
// see this file's top-of-file comment.
// ---------------------------------------------------------------------------

type RecruiteeSalary = {
  min?: string | number | null;
  max?: string | number | null;
  period?: string | null;
  currency?: string | null;
};

/** One entry in the structured `locations` array -- see Finding 4. */
type RecruiteeLocationEntry = {
  name?: string;
  city?: string;
  state?: string;
  country?: string;
};

type RecruiteeOffer = {
  id?: number;
  title?: string;
  company_name?: string;
  /** The derived, singular display string -- see Finding 4. Sometimes
   * literal non-place text like `"Remote job"`. */
  location?: string;
  /** The structured sibling of `location` -- see Finding 4. */
  locations?: RecruiteeLocationEntry[];
  description?: string;
  requirements?: string;
  /** See Finding 5: a third free-text field, sometimes the ONLY place real
   * content lives. */
  highlight?: string;
  employment_type_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  salary?: RecruiteeSalary;
  careers_apply_url?: string;
  careers_url?: string;
  published_at?: string;
};

type RecruiteeOffersResponse = {
  offers: RecruiteeOffer[];
};

function parseOffersResponseShape(body: unknown, company: string): RecruiteeOffersResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("offers" in body) ||
    !Array.isArray((body as Record<string, unknown>).offers)
  ) {
    throw new MalformedResponseError(
      `Recruitee response for company "${company}" did not match the expected shape (missing "offers" array)`,
    );
  }
  return body as RecruiteeOffersResponse;
}

// ---------------------------------------------------------------------------
// Full-text assembly for `description` -- see Finding 5. All three real text
// fields are folded in; none is assumed to be a strict subset of another.
// ---------------------------------------------------------------------------

function buildDescription(item: RecruiteeOffer): string {
  return [item.highlight, item.description, item.requirements]
    .map((raw) => (raw ? htmlToPlainText(raw, { doubleEncoded: false }) : ""))
    .filter((text) => text.length > 0)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// `location` vs `locations` -- see Finding 4. Both the location *search*
// haystack and the stored `Job.location` display string use the union of
// `location` (primary) and every `locations[]` entry, same "union, not
// replacement" shape as Ashby's `itemLocations`.
// ---------------------------------------------------------------------------

function formatLocationEntry(entry: RecruiteeLocationEntry): string | undefined {
  const parts = [entry.city, entry.state, entry.country]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (parts.length > 0) return parts.join(", ");
  const name = entry.name?.trim();
  return name && name.length > 0 ? name : undefined;
}

function itemLocations(item: RecruiteeOffer): string[] {
  const primary = item.location?.trim();

  const secondary = (item.locations ?? [])
    // `locations` is read off an unvalidated `as RecruiteeOffer[]` cast (see
    // `parseOffersResponseShape`), so a malformed entry isn't ruled out at
    // the type level -- guard the type, not just nullishness, same
    // discipline as Ashby's `validSecondaryLocations`.
    .filter((entry): entry is RecruiteeLocationEntry => typeof entry === "object" && entry !== null)
    .map(formatLocationEntry)
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  const combined = primary ? [primary, ...secondary] : secondary;
  return Array.from(new Set(combined));
}

// ---------------------------------------------------------------------------
// Client-side filtering -- like every other adapter here except
// SmartRecruiters, Recruitee's offers endpoint has no server-side search; it
// always returns the company's entire current posting set. `SearchCriteria`
// is applied here instead, against the raw item and its already-assembled
// full description.
// ---------------------------------------------------------------------------

function itemMatchesCriteria(
  item: RecruiteeOffer,
  criteria: SearchCriteria,
  fullDescription: string,
): boolean {
  if (criteria.keyword) {
    const keyword = criteria.keyword.toLowerCase();
    const title = item.title?.toLowerCase() ?? "";
    const description = fullDescription.toLowerCase();
    if (!title.includes(keyword) && !description.includes(keyword)) return false;
  }
  if (criteria.location) {
    const location = criteria.location.toLowerCase();
    const locations = itemLocations(item).map((entry) => entry.toLowerCase());
    if (!locations.some((entry) => entry.includes(location))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(item: RecruiteeOffer, fullDescription: string): NormalizeResult {
  // Recruitee's numeric `id` is the identifier the platform itself uses to
  // key a single offer -- stable and always present on every real posting
  // checked (65 postings, 8 companies). `slug` appears in the public URL
  // instead, but is not documented or verified to be globally unique the
  // way `id` is, so `id` is preferred, same reasoning as Greenhouse's `id`
  // vs `requisition_id` choice.
  const externalId =
    typeof item.id === "number" && Number.isFinite(item.id) ? String(item.id) : undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing id" };
  }

  const title = item.title?.trim();
  if (!title) {
    return { ok: false, externalId, reason: "missing title" };
  }

  // See Finding 9: `company_name` is present on every real offer checked --
  // used directly, no fallback to the configured subdomain needed.
  const company = item.company_name?.trim();
  if (!company) {
    return { ok: false, externalId, reason: "missing company_name" };
  }

  // See Finding 9: `careers_apply_url` (the direct apply-flow link) is
  // preferred over `careers_url` (the posting's own page).
  const linkToApply = item.careers_apply_url ?? item.careers_url;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing careers_apply_url and careers_url" };
  }

  const description = fullDescription.trim();
  if (!description) {
    return {
      ok: false,
      externalId,
      reason:
        "missing description content (highlight, description, and requirements were all empty)",
    };
  }

  const postedAtRaw = item.published_at;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing published_at" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable published_at "${postedAtRaw}"` };
  }

  const locations = itemLocations(item);
  const location = locations.length > 0 ? locations.join("; ") : undefined;

  const payType = mapPayType(item);
  const commitment = mapCommitment(item);
  const locationType = mapLocationType(item);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable/ambiguous value) is not a skip condition, only a structural
  // problem is (missing id, missing title, missing company_name, missing
  // careers_apply_url/careers_url, missing description, missing/unparseable
  // published_at -- all checked above).

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "recruitee",
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

/**
 * Maps `employment_type_code` -> Job's 3-value `commitment` enum. See
 * Finding 8: only `"fulltime"`/`"fulltime_permanent"`/`"fulltime_fixed_term"`
 * and `"parttime_fixed_term"` were observed on real data; `"internship"` has
 * no unambiguous mapping onto the 3-value enum (same reasoning as every
 * other adapter's Intern/Internship case) and falls through to `undefined`,
 * same as any unrecognized code.
 */
function mapCommitment(item: RecruiteeOffer): Job["commitment"] | undefined {
  const raw = item.employment_type_code?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.startsWith("fulltime")) return "full-time";
  if (raw.startsWith("parttime")) return "part-time";
  return undefined;
}

/**
 * Maps `remote`/`hybrid`/`on_site` -> Job's `locationType` enum. See
 * Finding 6: real data is NOT reliably one-true-of-three -- two real bunq
 * postings assert both `hybrid` and `on_site` simultaneously. Requires
 * EXACTLY one flag true; zero or multiple true both map to `undefined`
 * rather than picking a winner by arbitrary priority.
 */
function mapLocationType(item: RecruiteeOffer): Job["locationType"] | undefined {
  const flags = [item.remote === true, item.hybrid === true, item.on_site === true];
  if (flags.filter(Boolean).length !== 1) return undefined;
  if (item.remote === true) return "remote";
  if (item.hybrid === true) return "hybrid";
  return "onsite";
}

/**
 * Maps `salary.period` -> Job's `payType` enum (`"hourly" | "salary"`). See
 * Finding 7: real values observed are `"hour"`, `"month"`, `"year"`. Read
 * regardless of whether `salary.min`/`salary.max` carry an actual figure --
 * `period` alone states how the role pays, which is all `payType` asks.
 */
function mapPayType(item: RecruiteeOffer): Job["payType"] | undefined {
  const period = item.salary?.period?.trim().toLowerCase();
  if (!period) return undefined;
  if (period === "hour") return "hourly";
  if (period === "month" || period === "year") return "salary";
  return undefined;
}
