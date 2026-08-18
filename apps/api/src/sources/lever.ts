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

// ---------------------------------------------------------------------------
// Adapter for Lever's public Postings API
// (https://github.com/lever/postings-api), one HTTP call per configured
// company slug:
//
//   GET https://api.lever.co/v0/postings/{company}?mode=json
//
// Everything below was written against real captured responses from five
// live company boards — outreach (29 postings), wealthfront (23), palantir
// (309) all had open postings at the time of writing; plaid, clari,
// highspot, and lever's own board returned HTTP 200 with an empty `[]`
// (a real, legitimate "no open postings right now" board, not an error).
// Trimmed subsets of the outreach and palantir responses (fields untouched)
// are saved under __fixtures__/lever-real-response-outreach.json and
// __fixtures__/lever-real-response-palantir.json, chosen specifically to
// span the field variety this adapter needs to prove it handles: every
// `categories.commitment` value seen in the wild (Full-Time, Full-time,
// Contractor, Internship, Fixed-Term, Scholarship — note the inconsistent
// casing between companies), every `workplaceType` value (remote, hybrid,
// onsite), and a mix of postings with and without `salaryRange`. Per the
// standing instruction not to repeat USAJOBS' mistake of inventing
// fixtures/mappings from assumptions, every field below was read off these
// real responses, not guessed at.
//
// Three findings from that research shape the design here, each different
// from Greenhouse's equivalent:
//
// 1. The response body is a bare JSON array of postings — unlike
//    Greenhouse's `{ jobs: [...] }` envelope, there is no wrapper object.
//    Like Greenhouse, there is no pagination and no server-side
//    keyword/location query support: a company's *entire* board comes back
//    in one response, so `search()` filters client-side (see
//    `itemMatchesCriteria`).
//
// 2. Lever's posting objects carry NO company name field anywhere (checked
//    across all three non-empty real responses — outreach, wealthfront,
//    palantir — no `company`/`companyName`/equivalent key exists at any
//    level). Greenhouse's `company_name` has no Lever equivalent, so
//    `company` on the returned `Job` is the configured slug itself (the
//    same string used to build the request URL and the one that appears in
//    `hostedUrl`, e.g. "outreach" in
//    "https://jobs.lever.co/outreach/9a24e6ad-..."), not a value read out
//    of the posting.
//
// 3. Unlike Greenhouse, Lever's schema DOES carry employment-type and
//    work-arrangement data as genuinely structured fields, not free-text
//    prose to be parsed and guessed at:
//      - `categories.commitment` is a real field (e.g. "Full-Time",
//        "Contractor", "Internship", "Fixed-Term", "Scholarship" — all
//        observed on Palantir's real board alone). This is the first
//        source besides USAJOBS in this codebase that can supply
//        `commitment` from a structured field rather than leaving it
//        always undefined the way `greenhouse.ts` documents it must. Only
//        the values that map unambiguously onto Job's 3-value enum
//        ("full-time" | "part-time" | "contract") are mapped; see
//        `mapCommitment` for why "Internship"/"Fixed-Term"/"Scholarship"
//        are deliberately left undefined rather than forced into the
//        closest-sounding bucket.
//      - `workplaceType` is a top-level field whose values (`"remote"`,
//        `"onsite"`, `"hybrid"`) match Job's `locationType` enum exactly —
//        no metadata-question archaeology needed the way Greenhouse's
//        Airbnb-only "Workplace Type" custom question required.
//      - `salaryRange.interval` (when present) names the pay period
//        explicitly (every real posting observed uses
//        `"per-year-salary"`; no `"per-hour"` posting was found in any of
//        the three real, non-empty boards checked, but the field is a
//        structured enum-like string from Lever itself, not prose, so
//        `mapPayType` matches on it generically — see that function's doc
//        comment for the exact rule and its limits).
//
//    None of these three are guaranteed present on every posting (plenty of
//    real records have no `salaryRange` at all, for instance), and per the
//    project owner's decision recorded in packages/shared, that absence is
//    not a skip condition — `payType`/`commitment`/`locationType` are
//    optional on `Job` and simply come back `undefined` when Lever doesn't
//    supply (or this adapter can't unambiguously map) a value.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.lever.co/v0/postings";
const DEFAULT_TIMEOUT_MS = 15_000;

export type LeverConfig = {
  /** One company slug per board, e.g. `["outreach", "palantir"]` — the same
   * slug that appears in `https://jobs.lever.co/{slug}/...`. Each is
   * fetched as its own HTTP request; `search()` merges the results. */
  companies: string[];
  /** Override for testing; defaults to the real Lever Postings API host
   * (`https://api.lever.co/v0/postings`). A per-company request is built as
   * `${baseUrl}/${company}?mode=json`. */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

/**
 * Reads the configured company slugs from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Lever's public Postings API needs no credentials, so like
 * Greenhouse (and unlike USAJOBS) there is no key/secret to read.
 */
export function createLeverSourceFromEnv(env: NodeJS.ProcessEnv = process.env): LeverSource {
  const raw = env.LEVER_COMPANIES;
  const companies = (raw ?? "")
    .split(",")
    .map((company) => company.trim())
    .filter((company) => company.length > 0);
  if (companies.length === 0) {
    throw new Error(
      'LEVER_COMPANIES must be set to a comma-separated list of Lever company slugs (e.g. "outreach,palantir").',
    );
  }
  return new LeverSource({ companies });
}

export class LeverSource implements JobSource {
  readonly dataSource = "lever" as const;

  readonly #companies: string[];
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(config: LeverConfig) {
    if (config.companies.length === 0) {
      throw new Error("LeverSource requires at least one company slug.");
    }
    this.#companies = config.companies;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Sequential, not Promise.all — same reasoning as GreenhouseSource: a
    // shared, unauthenticated public API with no per-key rate limit to
    // spend in parallel, and a 429/5xx on one company shouldn't fire a
    // burst of simultaneous requests at the others.
    for (const company of this.#companies) {
      let postings: LeverPosting[];
      try {
        postings = await this.#fetchCompany(company);
      } catch (err) {
        // A 404 here means *this specific company slug* has no Lever board
        // at all (typo, never used Lever, moved off it) — a property of
        // the slug, not of the Lever API as a whole, and it will return the
        // identical 404 on every future request. Skip this company and keep
        // the jobs already collected from healthy ones, same as Greenhouse.
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          continue;
        }
        throw err;
      }

      for (const item of postings) {
        if (!itemMatchesCriteria(item, criteria)) continue;
        const result = normalizeItem(item, company);
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

  async #fetchCompany(company: string): Promise<LeverPosting[]> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(company)}`);
    // Without mode=json, Lever's postings endpoint serves an HTML careers
    // page instead of the JSON API response.
    url.searchParams.set("mode", "json");

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
          `Lever request for company "${company}" timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `Lever request for company "${company}" failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response, company);
  }
}

async function parseResponse(response: Response, company: string): Promise<LeverPosting[]> {
  if (response.status === 404) {
    // Real observed body: {"ok":false,"error":"Document not found"}. The
    // status code alone is enough to classify this; the body isn't parsed.
    throw new UnexpectedStatusError(
      `Lever company "${company}" has no board (HTTP 404) — check the company slug`,
      404,
    );
  }
  if (response.status === 401) {
    // Not observed against the real API in testing (it takes no
    // credentials), but classified for completeness, matching Greenhouse.
    throw new AuthFailedError(`Lever rejected the request for company "${company}" (HTTP 401)`);
  }
  if (response.status === 403) {
    // Also not observed in testing; kept distinct from AuthFailedError and
    // defaulting to retryable, same reasoning as GreenhouseSource — more
    // likely a transient edge/WAF block than Lever itself rejecting an
    // unauthenticated, public request.
    throw new ForbiddenError(`Request for Lever company "${company}" was blocked with HTTP 403`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Lever rate limit exceeded (HTTP 429) fetching company "${company}"`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Lever server error (HTTP ${response.status}) fetching company "${company}"`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Lever returned unexpected HTTP status ${response.status} for company "${company}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MalformedResponseError(`Lever response for company "${company}" was not valid JSON`, {
      cause: err,
    });
  }

  return parsePostingsShape(body, company);
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
// Lever response shape — only the fields this adapter reads. Verified
// against real captured responses; see this file's top-of-file comment.
// ---------------------------------------------------------------------------

type LeverCategories = {
  commitment?: string;
  location?: string;
  team?: string;
  department?: string;
  allLocations?: string[];
};

type LeverSalaryRange = {
  min?: number;
  max?: number;
  currency?: string;
  interval?: string;
};

type LeverPosting = {
  id?: string;
  text?: string;
  categories?: LeverCategories;
  /**
   * Plain-text posting body (see `descriptionPlain` vs `description` in
   * `normalizeItem`'s doc comment for why this, not the HTML `description`
   * field, is what this adapter uses).
   */
  descriptionPlain?: string;
  description?: string;
  hostedUrl?: string;
  applyUrl?: string;
  /** Epoch milliseconds. Confirmed by inspection (e.g. `1778685097596` on a
   * real Outreach posting decodes to a plausible 2026 date), unlike
   * Greenhouse's `first_published`, which is an ISO date *string*. */
  createdAt?: number;
  workplaceType?: string;
  salaryRange?: LeverSalaryRange;
};

function parsePostingsShape(body: unknown, company: string): LeverPosting[] {
  // Unlike Greenhouse's `{ jobs: [...] }` envelope, Lever's postings
  // endpoint returns a bare JSON array at the top level.
  if (!Array.isArray(body)) {
    throw new MalformedResponseError(
      `Lever response for company "${company}" did not match the expected shape (expected a JSON array)`,
    );
  }
  return body as LeverPosting[];
}

// ---------------------------------------------------------------------------
// Client-side filtering — like Greenhouse, Lever's postings endpoint has no
// server-side search; it always returns the company's entire board.
// `SearchCriteria` is applied here instead, against the raw item, before
// normalization.
// ---------------------------------------------------------------------------

function itemMatchesCriteria(item: LeverPosting, criteria: SearchCriteria): boolean {
  if (criteria.keyword) {
    const keyword = criteria.keyword.toLowerCase();
    const title = item.text?.toLowerCase() ?? "";
    const description = item.descriptionPlain?.toLowerCase() ?? "";
    if (!title.includes(keyword) && !description.includes(keyword)) return false;
  }
  if (criteria.location) {
    const location = criteria.location.toLowerCase();
    const itemLocation = item.categories?.location?.toLowerCase() ?? "";
    if (!itemLocation.includes(location)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(item: LeverPosting, company: string): NormalizeResult {
  // Lever's `id` is a UUID assigned when the posting is created. It is what
  // both `hostedUrl` and `applyUrl` key on (e.g.
  // "https://jobs.lever.co/outreach/9a24e6ad-3af2-4db0-a606-672946284b40"),
  // and it is what the single-posting detail endpoint
  // (`/v0/postings/{company}/{id}`) addresses directly — confirmed during
  // development by re-fetching a real board twice and observing the exact
  // same id list in the exact same order both times, then fetching one of
  // those ids through the single-posting endpoint and getting a 200. There
  // is no other candidate identifier on the record (no requisition number,
  // no separate internal id) — `id` is both the only option and, by the
  // same evidence Greenhouse's `id` was judged durable on, a durable one.
  const externalId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing id" };
  }

  const title = item.text;
  if (!title) {
    return { ok: false, externalId, reason: "missing text (title)" };
  }

  // Lever's posting objects carry no company name field anywhere (checked
  // across all real, non-empty responses used to build this adapter) — see
  // this file's top-of-file comment, finding 2. `company` is therefore the
  // configured slug this posting was fetched under, not a value read off
  // the record, so there is no "missing company" skip case the way
  // Greenhouse has one for `company_name`.

  const linkToApply = item.hostedUrl;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing hostedUrl" };
  }

  // Lever gives both `description` (HTML) and `descriptionPlain` (plain
  // text) for the same content, and `descriptionPlain` is what this adapter
  // uses. Two reasons, checked against real postings, not assumed:
  //   1. It's already plain text — no HTML entity-decoding/tag-stripping
  //      step is needed the way Greenhouse's `content` requires (see
  //      `htmlToPlainText` in greenhouse.ts). Using `description` here
  //      would mean re-implementing that same parser for no benefit, since
  //      Lever already did the stripping and hands back the result.
  //   2. Consistency with every other source's `description` field being
  //      plain text (USAJOBS' JobSummary, Greenhouse's stripped `content`),
  //      which matters because `description` feeds resume/job matching
  //      (`JobMatch` in packages/shared) — a matcher shouldn't have to
  //      special-case one source's HTML tags competing for token budget.
  // Known limitation, stated honestly: a full Lever posting page also has
  // `lists` (structured bullet sections — responsibilities, requirements)
  // and `additional` (closing/benefits text), neither folded in here.
  // `descriptionPlain` alone (confirmed against the real Outreach fixture)
  // already contains the substantive "About the company" + "About the
  // team"/"The role" narrative sections, but omits the bulleted
  // responsibilities/requirements lists and the closing/benefits section.
  // Pulling those in would mean writing a Lever-specific HTML-to-text pass
  // for `lists[].content` (the only place that content exists — there's no
  // plain-text sibling for it), which felt like scope beyond "pick a
  // description field" for this ticket; flagged here for a follow-up rather
  // than silently shipping a narrower field than what a human reading the
  // real job page would see.
  const description = item.descriptionPlain?.trim();
  if (!description) {
    return { ok: false, externalId, reason: "missing or empty descriptionPlain" };
  }

  const createdAt = item.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return {
      ok: false,
      externalId,
      reason: `missing or non-numeric createdAt "${String(createdAt)}"`,
    };
  }
  const postedAt = new Date(createdAt);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable createdAt "${createdAt}"` };
  }

  const location = item.categories?.location?.trim() || undefined;

  const payType = mapPayType(item);
  const commitment = mapCommitment(item);
  const locationType = mapLocationType(item);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable value) is not a skip condition, only a structural problem
  // is (missing id, missing title, missing hostedUrl, missing description,
  // missing/unparseable createdAt — all checked above).

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "lever",
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
 * Maps `categories.commitment` -> Job's 3-value enum
 * (`"full-time" | "part-time" | "contract"`), matching case-insensitively
 * since real data disagrees on casing between companies (Outreach uses
 * "Full-Time", Wealthfront and Palantir use "Full-time"). Only values that
 * unambiguously mean one of those three are mapped:
 *
 *   - "full-time" (any casing)  -> "full-time"
 *   - "part-time" (any casing)  -> "part-time"
 *   - "contractor"              -> "contract"
 *
 * Real values seen on Palantir's board that are deliberately left
 * unmapped (fall through to `undefined`): "Internship", "Fixed-Term",
 * "Scholarship". These are genuinely different employment relationships,
 * not synonyms for one of the three enum values, and forcing a guess
 * (e.g. "Fixed-Term" -> "contract", "Internship" -> "part-time") is exactly
 * the kind of unverified mapping this project's USAJOBS post-mortem warns
 * against — Lever having *more* categories than `Job.commitment` has slots
 * for is not a reason to collapse them incorrectly.
 */
function mapCommitment(item: LeverPosting): Job["commitment"] | undefined {
  const raw = item.categories?.commitment?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "full-time" || raw === "full time") return "full-time";
  if (raw === "part-time" || raw === "part time") return "part-time";
  if (raw === "contractor" || raw === "contract") return "contract";
  return undefined;
}

/**
 * Maps `workplaceType` directly onto Job's `locationType` enum — unlike
 * Greenhouse, which has no first-class field for this and only gets it
 * opportunistically from one company's custom metadata question, Lever's
 * `workplaceType` values (`"remote"`, `"onsite"`, `"hybrid"`) match the enum
 * exactly on every real posting observed (Outreach, Wealthfront, Palantir).
 * Still defensive against an unrecognized value rather than casting blindly,
 * in case Lever ever adds a value outside this set.
 */
function mapLocationType(item: LeverPosting): Job["locationType"] | undefined {
  const raw = item.workplaceType?.trim().toLowerCase();
  if (raw === "remote" || raw === "onsite" || raw === "hybrid") return raw;
  return undefined;
}

/**
 * Maps `salaryRange.interval` -> Job's `payType` (`"hourly" | "salary"`).
 * Every real posting with a `salaryRange` observed while building this
 * adapter (all on Outreach's board) used `interval: "per-year-salary"`; no
 * real `"per-hour"` (or any other interval) example turned up on any of the
 * three non-empty boards checked. Rather than hardcode a match against only
 * the one literal string actually observed, this matches generically on
 * whether the interval names an hourly or salaried period ("hour" vs
 * "salary" substring) — Lever's own naming convention for this field
 * consistently suffixes salaried intervals with "-salary" (its documented
 * postings-api schema lists per-year-salary, per-month-salary,
 * per-week-salary, and per-day-salary alongside per-hour), so this is
 * reading a structured, source-defined convention, not inferring meaning
 * from free text. Most postings have no `salaryRange` at all — that is not
 * a skip condition, it just leaves `payType` undefined, same as every other
 * unmappable-but-optional field here.
 */
function mapPayType(item: LeverPosting): Job["payType"] | undefined {
  const interval = item.salaryRange?.interval?.trim().toLowerCase();
  if (!interval) return undefined;
  if (interval.includes("hour")) return "hourly";
  if (interval.includes("salary")) return "salary";
  return undefined;
}
