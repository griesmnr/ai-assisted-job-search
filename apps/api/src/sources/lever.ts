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
// Adapter for Lever's public Postings API
// (https://github.com/lever/postings-api), one HTTP call per configured
// company slug:
//
//   GET https://api.lever.co/v0/postings/{company}?mode=json
//
// Everything below was written against real captured responses. First pass:
// outreach (29 postings), wealthfront (23), palantir (309) all had open
// postings; plaid, clari, highspot, and lever's own board returned HTTP 200
// with an empty `[]` (a real, legitimate "no open postings right now"
// board, not an error). A second pass, prompted by an adversarial review
// that found the first pass's `description` and `categories.commitment`
// claims didn't hold up, added anchorage (36) and immutable (6) and
// re-verified counts (palantir's board had shrunk to 307 by then — these
// boards genuinely change over time; re-fetch before trusting a stale
// count). Trimmed subsets of the outreach and palantir responses (fields
// untouched) are saved under __fixtures__/lever-real-response-outreach.json
// and __fixtures__/lever-real-response-palantir.json. Per the standing
// instruction not to repeat USAJOBS' mistake of inventing fixtures/mappings
// from assumptions, every field below was read off real responses, not
// guessed at — including the second time, when the first pass's own
// assumptions turned out to need correcting.
//
// Findings that shape the design here, each different from Greenhouse's
// equivalent:
//
// 1. The response body is a bare JSON array of postings — unlike
//    Greenhouse's `{ jobs: [...] }` envelope, there is no wrapper object.
//    Like Greenhouse, there is no pagination and no server-side
//    keyword/location query support: a company's *entire* board comes back
//    in one response, so `search()` filters client-side (see
//    `itemMatchesCriteria`).
//
// 2. Lever's posting objects carry NO company name field anywhere (checked
//    across every real response used to build this adapter — no
//    `company`/`companyName`/equivalent key exists at any level).
//    Greenhouse's `company_name` has no Lever equivalent, so `company` on
//    the returned `Job` is the configured slug itself (the same string used
//    to build the request URL and the one that appears in `hostedUrl`, e.g.
//    "outreach" in "https://jobs.lever.co/outreach/9a24e6ad-..."), not a
//    value read out of the posting.
//
// 3. A real Lever posting's full text is NOT just `descriptionPlain`. The
//    first version of this adapter used `descriptionPlain` alone and
//    dropped `lists` (Lever's own README: "Extra lists (such as
//    requirements, benefits, etc.) from the job posting") and
//    `additionalPlain`. Measured on re-check: `descriptionPlain` alone
//    discarded 69-74% of a posting's real text, and on the majority of
//    postings checked, the *requirements* — the part of a job posting most
//    load-bearing for resume matching — existed ONLY in `lists` (e.g.
//    Palantir's sections are literally titled "What We Require" and "What
//    We Value"). Both `lists[].content` (HTML, no plain-text sibling field
//    — stripped here via the shared `htmlToPlainText` from ./html.ts) and
//    `additionalPlain` (already plain text) are now folded into
//    `description`; see `buildDescription`. `itemMatchesCriteria` searches
//    this same fuller text, not just `descriptionPlain`, so keyword
//    filtering doesn't miss skills that only appear in a requirements list.
//    A second-round correction to this same finding: `descriptionPlain` can
//    itself be empty on a real posting (measured 2026-08-19: 1 of 1,088
//    live postings checked had empty `descriptionPlain`, empty
//    `additionalPlain`, AND empty `lists` — a Match Group/Tinder posting
//    whose entire text lived in the HTML `description` field instead), so
//    `buildDescription` falls back to `htmlToPlainText(item.description)`
//    when `descriptionPlain` is empty. See __fixtures__/
//    lever-real-response-matchgroup.json.
//
// 4. Unlike Greenhouse, Lever's schema DOES carry employment-type and
//    work-arrangement data as genuinely structured fields, not free-text
//    prose to be parsed and guessed at — but `categories.commitment`
//    specifically is NOT a fixed cross-platform enum the way it first
//    looked from one board. See `mapCommitment`'s doc comment for the full
//    correction: it's a per-company-configurable category, evidenced by
//    compound company-specific values like "Full-Time - Remote" and "Full
//    Time Permanent" that bake other axes directly into the same string.
//      - `workplaceType` IS a genuine fixed enum: a top-level field whose
//        values (`"remote"`, `"onsite"`, `"hybrid"`) match Job's
//        `locationType` enum exactly — no metadata-question archaeology
//        needed the way Greenhouse's Airbnb-only "Workplace Type" custom
//        question required. (Lever's own README additionally documents an
//        `"on-site"` hyphenated spelling that never showed up in any real
//        response checked here; `mapLocationType` normalizes hyphens/spaces
//        so either spelling maps correctly regardless.)
//      - `salaryRange.interval` (when present) names the pay period — see
//        `mapPayType`'s doc comment for exactly what is and isn't verified
//        about its value space.
//
//    None of `payType`/`commitment`/`locationType` are guaranteed present
//    on every posting (plenty of real records have no `salaryRange` at
//    all, for instance), and per the project owner's decision recorded in
//    packages/shared, that absence is not a skip condition — they're
//    optional on `Job` and simply come back `undefined` when Lever doesn't
//    supply (or this adapter can't unambiguously map) a value.
//
// 5. `categories.location` is only ONE of a posting's locations, not
//    necessarily all of them. A posting open to multiple locations (or
//    listing a region alongside specific cities within it) carries the
//    full set in `categories.allLocations`, with `categories.location`
//    holding just one representative entry — measured 2026-08-19 on a real
//    Binance board, 250 of 276 postings had 2+ `allLocations` entries, and
//    on 140 of those, a specific city ("Taiwan, Taipei") existed ONLY in
//    `allLocations`, never in `location` — a client-side `location: "Taipei"`
//    search against `categories.location` alone silently missed 86% of the
//    board's genuinely open Taipei roles. `itemLocations` (below) reads
//    BOTH and returns their union: `location` is NOT reliably a member of
//    `allLocations` (a real Binance posting has `location: "Portland, OR"`
//    and `allLocations: ["Taiwan, Taipei", "Hong Kong"]` — Portland isn't
//    in that list at all), so preferring `allLocations` alone whenever it's
//    non-empty — an earlier version of this function did exactly that —
//    silently dropped `location` on that shape and turned a working
//    "Portland" search into zero results, a regression against the
//    pre-finding-5 code that always read `location`. Both
//    `itemMatchesCriteria`'s location filter and the `Job.location` this
//    adapter stores now use the union — see
//    __fixtures__/lever-real-response-binance.json for the real records
//    this was built against.
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
        const fullDescription = buildDescription(item);
        if (!itemMatchesCriteria(item, criteria, fullDescription)) continue;
        const result = normalizeItem(item, company, fullDescription);
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

/**
 * One "extra list" section — Lever's own README: "Extra lists (such as
 * requirements, benefits, etc.) from the job posting." `text` is the
 * section heading (e.g. "What We Require"); `content` is HTML with no
 * plain-text sibling field, unlike `descriptionPlain`/`additionalPlain`.
 */
type LeverList = {
  text?: string;
  content?: string;
};

type LeverPosting = {
  id?: string;
  text?: string;
  categories?: LeverCategories;
  /**
   * Plain-text posting body (see `descriptionPlain` vs `description` in
   * `buildDescription`'s doc comment for why this, not the HTML
   * `description` field, is what this adapter uses).
   */
  descriptionPlain?: string;
  description?: string;
  /** See `LeverList`. Real postings checked here carry 1-5 of these,
   * typically headed "Responsibilities"/"Requirements"/"Benefits" or
   * company-specific equivalents (Palantir: "What We Require", "What We
   * Value"). */
  lists?: LeverList[];
  /** Plain-text closing section (benefits, EEO statement, hashtags/req
   * codes). Sibling of HTML `additional`, which this adapter doesn't read
   * for the same reason it prefers `descriptionPlain` over `description`. */
  additionalPlain?: string;
  additional?: string;
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
// Full-text assembly for `description` — see this file's top-of-file
// comment, finding 3, for why `descriptionPlain` alone isn't enough: it
// discards `lists` (the requirements/benefits sections — Lever's own
// README: "Extra lists (such as requirements, benefits, etc.) from the job
// posting") and `additionalPlain` (closing/benefits text), and on most real
// postings checked, the requirements exist ONLY in `lists`.
//
// `description` (HTML) is normally NOT used for the intro, for the same
// reason as before: `descriptionPlain` is already plain text, so no
// entity-decoding/tag-stripping is needed there at all — EXCEPT when
// `descriptionPlain` is itself empty, which real postings do sometimes do.
// Measured 2026-08-19 across the 1,088 live postings gathered while fixing
// N2/N3 below: 17 had an empty `descriptionPlain`; 16 of those still had
// real content in `lists`, but 1 (Match Group / Tinder, posting
// dcc0335f-d4bf-4919-bfab-490e8b3913f5, "Senior Software Engineer, Machine
// Learning Infrastructure") had `descriptionPlain: ""`, `additionalPlain:
// ""`, and `lists: []` — genuinely nothing to assemble from the plain-text
// fields, while its HTML `description` field carried the full ~8KB posting.
// That real record is captured in
// __fixtures__/lever-real-response-matchgroup.json specifically to cover
// this case. So the intro falls back to `htmlToPlainText(item.description)`
// (default `doubleEncoded: false` — correct for Lever's single-encoded
// markup) whenever `descriptionPlain` comes back empty or missing.
//
// A prior version of this comment claimed a record like this "never" occurs
// in real data. That claim was false and has been corrected here with a
// measurement and a date. When a comment asserts "no real posting does X,"
// it needs a measurement and a date behind it or it isn't a claim this
// project makes.
//
// `lists[].content` has no plain-text sibling at all (unlike
// `descriptionPlain`/`description`), so it's stripped unconditionally via
// the shared `htmlToPlainText` (./html.ts) with `doubleEncoded: false`
// (Lever's markup is single-encoded, unlike Greenhouse's; see that file's
// doc comment for why the distinction matters and would silently corrupt
// content if gotten backwards).
//
// Sections are joined in reading order — intro, then each list (heading
// line followed by its stripped body), then the closing `additionalPlain`
// — with a blank line between sections so the result reads as a normal
// multi-paragraph document, not a run-on wall of text.
// ---------------------------------------------------------------------------

function buildDescription(item: LeverPosting): string {
  const sections: string[] = [];

  const intro =
    item.descriptionPlain?.trim() || (item.description ? htmlToPlainText(item.description) : "");
  if (intro) sections.push(intro);

  for (const list of item.lists ?? []) {
    const body = list.content ? htmlToPlainText(list.content) : "";
    if (!body) continue;
    const heading = list.text?.trim();
    sections.push(heading ? `${heading}\n${body}` : body);
  }

  const additional = item.additionalPlain?.trim();
  if (additional) sections.push(additional);

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// `categories.allLocations` vs `categories.location` — see this file's
// top-of-file comment, finding 5. `location` is one representative entry;
// `allLocations` is the full set a multi-location (or region-plus-cities)
// posting is actually open to. Both filtering and the stored `Job.location`
// use this, not `categories.location` alone.
// ---------------------------------------------------------------------------

function itemLocations(item: LeverPosting): string[] {
  // `location` is NOT guaranteed to be one of the entries in
  // `allLocations` — a real Binance posting has `location: "Portland, OR"`
  // and `allLocations: ["Taiwan, Taipei", "Hong Kong"]`, neither containing
  // the other. Returning only `allLocations` when it's non-empty (an
  // earlier version of this function did exactly that) silently dropped
  // "Portland" — a regression versus the pre-N2 code, which always read
  // `location`. So this returns the union of both, `location` first, deduped.
  const single = item.categories?.location?.trim();

  const all = (item.categories?.allLocations ?? [])
    // Optional chaining on `entry?.trim()` guards only null/undefined, not
    // a wrong type: a non-string entry (the raw response is an unvalidated
    // `as LeverPosting[]` cast — see `parsePostingsShape` — so a
    // malformed/non-conforming API response isn't ruled out at the type
    // level) would throw `entry.trim is not a function` and take down the
    // whole board fetch. Filtering on `typeof entry === "string"` first
    // guards the type, not just nullishness.
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const combined = single ? [single, ...all] : all;
  return Array.from(new Set(combined));
}

// ---------------------------------------------------------------------------
// Client-side filtering — like Greenhouse, Lever's postings endpoint has no
// server-side search; it always returns the company's entire board.
// `SearchCriteria` is applied here instead, against the raw item (and its
// already-assembled full description, so a keyword that only appears in a
// `lists` requirements section — e.g. a specific language or framework
// named nowhere in `descriptionPlain` — still matches), before
// normalization.
// ---------------------------------------------------------------------------

function itemMatchesCriteria(
  item: LeverPosting,
  criteria: SearchCriteria,
  fullDescription: string,
): boolean {
  if (criteria.keyword) {
    const keyword = criteria.keyword.toLowerCase();
    const title = item.text?.toLowerCase() ?? "";
    const description = fullDescription.toLowerCase();
    if (!title.includes(keyword) && !description.includes(keyword)) return false;
  }
  if (criteria.location) {
    const location = criteria.location.toLowerCase();
    // Matches if ANY of the posting's locations (the union of
    // categories.location and every categories.allLocations entry) contains
    // the search term -- see `itemLocations` and finding 5 above for why
    // checking only `categories.location` under-matches real multi-location
    // postings, and why `allLocations` alone isn't a safe replacement for it.
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

function normalizeItem(
  item: LeverPosting,
  company: string,
  fullDescription: string,
): NormalizeResult {
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

  // `fullDescription` is `buildDescription(item)`'s output — intro
  // (`descriptionPlain`, falling back to the stripped HTML `description`
  // when `descriptionPlain` is itself empty) + every `lists` section
  // (heading + stripped content) + `additionalPlain`, computed once per
  // item and passed in from `search()` so `itemMatchesCriteria` filters
  // against the exact same text that ends up stored. See
  // `buildDescription`'s doc comment for why the intro alone isn't enough,
  // and for the one real record (measured 2026-08-19) that has nothing in
  // any of `descriptionPlain`/`lists`/`additionalPlain` and depends on that
  // HTML fallback. A record fails normalization here only if the combined
  // text — including that fallback — still comes back completely empty,
  // which is rare but does happen on real data; it is not asserted to be
  // impossible.
  const description = fullDescription.trim();
  if (!description) {
    return {
      ok: false,
      externalId,
      reason:
        "missing description content (descriptionPlain, the HTML description fallback, lists, and additionalPlain were all empty)",
    };
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

  // The union of categories.location and every categories.allLocations
  // entry, not just one representative entry — see finding 5 at the top of
  // this file. Joined with "; " rather than ", " because individual entries
  // are themselves frequently comma-containing city names (e.g. real data:
  // "Taiwan, Taipei"), which a plain comma-join would make indistinguishable
  // from separate entries.
  const locations = itemLocations(item);
  const location = locations.length > 0 ? locations.join("; ") : undefined;

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
 * (`"full-time" | "part-time" | "contract"`).
 *
 * CORRECTION (this comment previously overclaimed): an earlier version of
 * this adapter, built against a single board, stated its fixture spanned
 * "every `categories.commitment` value seen in the wild." That was false,
 * and the *category of mistake* matters as much as the specific values
 * missed: `categories.commitment` is not a fixed, cross-platform Lever
 * enum at all — it's a category each company configures for itself in
 * their own Lever admin panel, the same way Greenhouse boards each define
 * their own custom metadata questions. Re-checking across five boards
 * (outreach, palantir, wealthfront, anchorage, immutable — 401 real
 * postings) surfaced company-specific compound values that don't exist on
 * any single board alone: "Full-Time - Remote", "Full-Time - Hybrid", and
 * "Full Time Permanent" (Anchorage bakes `workplaceType`-like and
 * permanence information directly into the commitment string). A separate
 * review pass over a different set of boards found still more real values
 * this adapter had never seen: "Permanent", "Short Term", "Fixed Term"
 * (space, not hyphen — a distinct raw string from "Fixed-Term"),
 * "Full Time Contractor", "Apprenticeship", and "Contract". Given it's a
 * per-company free-configuration field, no fixed list can honestly be
 * called exhaustive — an as-yet-unseen company can configure any string it
 * wants. What follows is not "every value"; it's the matching rule this
 * adapter actually applies, and why it's robust to values not yet seen.
 *
 * Because the field is evidently composed from independent tokens rather
 * than being one flat enum, this matches by substring/word rather than by
 * exact equality (an earlier, exact-match version of this function would
 * have left "Full-Time - Remote" and "Full Time Permanent" undefined even
 * though both unambiguously say full-time):
 *
 *   - contains "contractor" or the word "contract"  -> "contract"
 *     (checked FIRST: "Full Time Contractor" is unambiguously a
 *     contractor arrangement — the more specific signal — even though the
 *     same string also contains "full time")
 *   - else contains "part-time"/"part time"         -> "part-time"
 *   - else contains "full-time"/"full time"         -> "full-time"
 *   - anything else                                 -> `undefined`
 *
 * Deliberately left `undefined` rather than guessed at: "Permanent"/"Fixed
 * Term"/"Fixed-Term"/"Short Term" (a permanence axis, orthogonal to
 * full-time/part-time/contract — a role can be full-time AND fixed-term),
 * "Internship", "Scholarship", "Apprenticeship" (genuinely different
 * employment relationships, not synonyms for any of the three enum
 * values). Forcing any of these into the nearest-sounding bucket is
 * exactly the kind of unverified mapping this project's USAJOBS
 * post-mortem warns against.
 */
function mapCommitment(item: LeverPosting): Job["commitment"] | undefined {
  const raw = item.categories?.commitment?.trim().toLowerCase();
  if (!raw) return undefined;
  if (/\bcontractor\b/.test(raw) || /\bcontract\b/.test(raw)) return "contract";
  if (/\bpart[\s-]time\b/.test(raw)) return "part-time";
  if (/\bfull[\s-]time\b/.test(raw)) return "full-time";
  return undefined;
}

/**
 * Maps `workplaceType` directly onto Job's `locationType` enum — unlike
 * Greenhouse, which has no first-class field for this and only gets it
 * opportunistically from one company's custom metadata question, Lever's
 * `workplaceType` values (`"remote"`, `"onsite"`, `"hybrid"`) match the enum
 * exactly on every real posting observed (five boards checked: outreach,
 * wealthfront, palantir, anchorage, immutable). Every real occurrence of
 * the onsite value seen was the unhyphenated `"onsite"`, but Lever's own
 * postings-api README documents `"on-site"` (hyphenated) as the field's
 * value for that case — since the two disagree and this adapter has only
 * directly observed one of them, both spellings (and the unhyphenated
 * "on site") are normalized to `"onsite"` rather than trusting either
 * source alone. Still falls through to `undefined` for anything else,
 * rather than casting blindly, in case Lever adds a value outside this set.
 */
function mapLocationType(item: LeverPosting): Job["locationType"] | undefined {
  const raw = item.workplaceType?.trim().toLowerCase().replace(/[\s-]/g, "");
  if (raw === "remote" || raw === "onsite" || raw === "hybrid") return raw;
  return undefined;
}

/**
 * Maps `salaryRange.interval` -> Job's `payType` (`"hourly" | "salary"`).
 * Every real posting with a `salaryRange` observed while building this
 * adapter used `interval: "per-year-salary"` (seen on Outreach's board); no
 * real `"per-hour"` (or any other interval) example turned up on any board
 * checked. Lever's postings-api README documents the *existence* of
 * `salaryRange.interval` but does not enumerate its possible values, so the
 * rest of this is inference from the one real value seen, not a cited
 * source — flagged honestly rather than dressed up as more verified than it
 * is. Rather than hardcode a match against only that one literal string,
 * this checks for an "hour" substring before falling back to a "salary"
 * substring: if Lever ever does send an interval naming an hourly rate
 * (e.g. a hypothetical "per-hour"), this still classifies it correctly
 * without having seen it; anything matching neither substring — including a
 * value this reasoning turns out to be wrong about — safely falls through
 * to `undefined` rather than a wrong guess. Most postings have no
 * `salaryRange` at all — that is not a skip condition, it just leaves
 * `payType` undefined, same as every other unmappable-but-optional field
 * here.
 */
function mapPayType(item: LeverPosting): Job["payType"] | undefined {
  const interval = item.salaryRange?.interval?.trim().toLowerCase();
  if (!interval) return undefined;
  if (interval.includes("hour")) return "hourly";
  if (interval.includes("salary")) return "salary";
  return undefined;
}
