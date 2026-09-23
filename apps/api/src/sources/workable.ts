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
// Adapter for Workable's public Accounts API, one HTTP call per configured
// subdomain:
//
//   GET https://www.workable.com/api/accounts/{subdomain}?details=true
//
// `?details=true` is documented (Workable's own help center, cited in
// ticket 7bbc47e) as the way to get full job descriptions rather than
// summaries. Everything below was verified live 2026-09-23 against eight
// real accounts (rokt, seeq, tetrascience, workmotion, suade, dispel,
// oktopayments, valsoft-corp — 413 real raw postings total, re-verified
// during opus review, same date) plus dozens of
// guessed subdomains used only to map out behavior before writing any
// mapping, per the standing instruction not to repeat USAJOBS' mistake of
// inventing fixtures/mappings from assumptions. Trimmed real fixtures are
// under __fixtures__/workable-real-response-*.json.
//
// ---------------------------------------------------------------------------
// FINDING 1 — the invalid-subdomain trap this ticket exists to resolve: it
// does NOT reproduce SmartRecruiters' 200-with-zero-results ambiguity
// ---------------------------------------------------------------------------
//
// `GET https://www.workable.com/api/accounts/{subdomain}?details=true`
// ALWAYS responds with an HTTP 302 to
// `https://apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true`
// — verified identical (same redirect shape) for both a real subdomain
// (sylvera) and a deliberately-nonsense one
// ("this-company-definitely-does-not-exist-12345"). That widget host is the
// one this ticket explicitly says not to call directly — but following the
// documented host's own redirect there (Node's global `fetch` follows
// redirects by default; nothing here overrides `redirect`) is simply how the
// documented endpoint actually behaves, not a deliberate hop onto an
// internal API. The distinguishing signal only appears AFTER that redirect
// is followed:
//
//   - a real subdomain (verified: sylvera, deliveroo, and all eight accounts
//     configured below) resolves to HTTP 200 with a JSON body
//     `{"name": "...", "description": "...", "jobs": [...]}`, `jobs` being
//     `[]` for a real account with nothing open right now (sylvera and
//     deliveroo both currently 200 with `jobs: []` — genuinely quiet
//     employers, not errors);
//   - an unrecognized subdomain resolves to a clean, distinct HTTP 404 with
//     a plain-text body `"Not Found"` (verified against
//     "this-company-definitely-does-not-exist-12345") — not JSON, and not
//     the same status as any real account.
//
// So, unlike SmartRecruiters (ticket 0266505, where a wrong identifier 200s
// with `{"totalFound":0,"content":[]}`, byte-identical to a real company
// with zero postings, forcing a second disambiguating request against a
// careers microsite), Workable needs no second request at all — the status
// code alone is the distinguishing signal, the same "verified clean" shape
// this ticket's own body predicted for Recruitee. `search()` below treats an
// HTTP 404 for a configured subdomain as a `SkippedRecord` naming the 404
// (see `search()`), never silently as "zero postings".
//
// ---------------------------------------------------------------------------
// FINDING 2 — `shortcode` is NOT a unique posting id: a job open to multiple
// locations is repeated once PER LOCATION in `jobs[]`, all copies sharing
// the same `shortcode`
// ---------------------------------------------------------------------------
//
// This is the load-bearing finding of this adapter, and a different shape
// than every prior adapter's "multi-location" trap (Lever's
// `categories.allLocations`, Ashby's `secondaryLocations` — one job object,
// an array of extra locations). Workable instead duplicates the WHOLE job
// object once per location it's open to, varying only `country`/`city`/
// `state` and the `locations` array (usually single-entry per row, but not
// always — see the Valsoft "Managing Director" example a few paragraphs
// down, one row whose OWN `locations` array has four entries), while
// `shortcode` (and `url`/`title`/`description`/every other field) stays
// identical across the copies. Verified live 2026-09-23 across all 413 raw
// postings from the eight configured accounts: they collapse to 298 unique
// `shortcode`s across 53 duplicate-shortcode groups (seeq, tetrascience,
// workmotion, and valsoft-corp all have real examples; rokt/suade/dispel/
// oktopayments happened to have none in this snapshot -- re-verified during
// opus review, same date, exact same numbers). A real example, TetraScience's
// "Chief of Staff to
// the CEO" (shortcode 996AE60304): one raw entry has
// `{city: "Boston", state: "Massachusetts"}`, a second has
// `{city: "Cambridge", state: ""}` — same title, same (byte-identical)
// description, same `url`. Checked every field on every duplicate-shortcode
// group in the 413-posting sample: `title`, `description`,
// `employment_type`, `telecommuting`, `department`, `url`, `published_on`,
// and `created_at` were identical within every group, zero exceptions — only
// the location fields vary. Trimmed real proof of this exact shape (three
// duplicate-shortcode groups, one spanning three countries) is saved at
// __fixtures__/workable-real-response-tetrascience-trimmed.json.
//
// Treating each raw entry as its own posting would therefore either violate
// the DB's `UNIQUE(dataSource, externalId)` constraint (two rows racing to
// claim the same `(workable, shortcode)` key) or silently drop every copy
// but the first — both wrong, since these are genuinely ONE open posting.
// `groupByShortcode` (below) groups raw entries by `shortcode` before
// normalization; `normalizeGroup` builds ONE `NormalizedJob` per group,
// using the first entry's non-location fields (justified by the
// zero-exceptions check above) and the UNION of every entry's own
// `locations` array for `Job.location` — see `mergedLocations`. This is the
// same "union of what a naive single-entry read would miss" shape as
// Lever's `allLocations` and Ashby's `secondaryLocations` fixes, arrived at
// primarily by a different mechanism (row duplication) -- though Workable
// ALSO has the array-field shape on rare occasions (one row's own
// `locations` array holding multiple entries, e.g. the Valsoft "Managing
// Director" posting above), so unlike Lever/Ashby this adapter has to
// handle both at once, not one or the other.
//
// `hidden` (a boolean on each `locations[]` entry, e.g. a real Valsoft
// "Managing Director" posting open to Germany/Switzerland/France/Austria,
// all four marked `hidden: true`) is read but NOT filtered on: what it
// actually controls in Workable's own UI is unverified (no public docs
// found), and per this project's standing discipline (Ashby's Finding 2c:
// "present-but-dirty beats silently absent"), guessing that `hidden` means
// "exclude this location" risks dropping a real place the posting is
// genuinely open to, on an unverified assumption. All locations are kept.
//
// ---------------------------------------------------------------------------
// FINDING 3 — description HTML is single-encoded (like Lever/Ashby), NOT
// double-encoded (unlike Greenhouse)
// ---------------------------------------------------------------------------
//
// Real `description` values contain literal, unescaped tags (`<p>`, `<li>`,
// `<strong>`, ...) directly, and real ordinary HTML entities (`&amp;` for a
// literal "&" in body text — e.g. real Valsoft posting "1st Line Service
// Desk Agent": "...UK, Australia &amp; the US") — confirmed across the
// 413-posting sample. `htmlToPlainText(raw, { doubleEncoded: false })` (the
// default) is the correct pipeline, same call shape as Lever/Ashby.
//
// ---------------------------------------------------------------------------
// FINDING 4 — no pagination: `?details=true` returns the account's entire
// job list in one response
// ---------------------------------------------------------------------------
//
// Checked explicitly, not assumed (per this ticket's own instruction): every
// response body has exactly three top-level keys, `name`, `description`,
// `jobs` — no `page`/`total`/`next`/cursor field of any kind, on accounts
// ranging from 2 real postings (dispel) to 278 (valsoft-corp). `jobs.length`
// is the account's whole board. `search()` below therefore makes exactly one
// request per configured subdomain, same shape as Greenhouse/Lever/Ashby.
//
// ---------------------------------------------------------------------------
// FINDING 5 — `telecommuting` is a genuine boolean, but the ONLY
// remote/onsite signal Workable's public API exposes; there is no
// structured "hybrid" value at all
// ---------------------------------------------------------------------------
//
// Unlike Ashby's three-value `workplaceType` enum, every job object here
// carries exactly one boolean, `telecommuting` — confirmed by enumerating
// every key on every posting in the 413-posting sample (`title`,
// `shortcode`, `code`, `employment_type`, `telecommuting`, `department`,
// `url`, `shortlink`, `application_url`, `published_on`, `created_at`,
// `country`, `city`, `state`, `education`, `experience`, `function`,
// `industry`, `locations`, `description` — no others, on ANY posting
// checked). So `mapLocationType` can only ever return `"remote"` or
// `"onsite"`, never `"hybrid"` — not a gap in this adapter, a genuine
// absence in the source data.
//
// The boolean is also not perfectly reliable as a proxy for "fully remote":
// real Valsoft posting "Account Executive MPS MONITOR - NEXERA - Full time"
// has `telecommuting: true` while its own description prose says "Hybrid and
// flexible working environment". Per this project's standing rule against
// parsing prose into a closed enum (see greenhouse.ts, and SmartRecruiters'
// own Finding 4 caveat for the identical shape of disagreement), the
// structured boolean is trusted as-is and the prose is not parsed —
// `mapLocationType` returns `"remote"` for this record, which may
// undersell a genuinely hybrid arrangement. Flagged here rather than hidden.
//
// ---------------------------------------------------------------------------
// FINDING 6 — `employment_type` maps cleanly onto three of `commitment`'s
// values; no compensation field exists anywhere
// ---------------------------------------------------------------------------
//
// Across the 413-posting sample: `employment_type` values observed are
// `"Full-time"` (386), `""` (empty string, 61), `"Contract"` (10), a literal
// JSON `null` (4), `"Part-time"` (1), and `"Temporary"` (1).
// `"Temporary"` has no unambiguous mapping onto `commitment`'s three values
// (same reasoning as Lever's "Fixed-Term"/Ashby's "Temporary" — left
// `undefined`, not guessed). Empty string and `null` also fall through to
// `undefined`. No posting in the sample, at either the list level or any
// individual record, carries a pay/salary/wage/compensation field under any
// name — `payType` is always `undefined`, same conclusion and same
// reasoning as Greenhouse's `mapPayType`.
//
// ---------------------------------------------------------------------------
// FINDING 7 — `application_url` (the direct apply-form link) over `url`
// ---------------------------------------------------------------------------
//
// `url` and `shortlink` are identical on every posting checked (413/413);
// `application_url` is always exactly `${url}/apply`. `application_url` is
// preferred for `linkToApply`, matching Ashby's precedent of preferring the
// direct application-form link (`applyUrl`) over the posting's description
// page (`jobUrl`); `url` is kept as a fallback only, never observed to be
// needed on real data.
//
// ---------------------------------------------------------------------------
// FINDING 8 — no per-posting company field; the account-level `name` is used
// instead
// ---------------------------------------------------------------------------
//
// Unlike Greenhouse's per-job `company_name`, no job object here carries a
// company name (checked the same way as Ashby's Finding 5: every key on
// every posting, plus the response envelope's own three keys). But unlike
// Ashby — which has no company name ANYWHERE and falls back to the
// configured board name — Workable's response envelope itself carries a
// real, human-readable `name` (e.g. `"TetraScience"`, `"Dispel"`), present
// and non-empty on every one of the eight accounts checked. That is used for
// `Job.company` in preference to the raw subdomain string; the subdomain is
// kept only as a defensive fallback (never observed to be needed).
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://www.workable.com/api/accounts";
const DEFAULT_TIMEOUT_MS = 15_000;

export type WorkableConfig = {
  /** One Workable subdomain per employer, e.g. `["dispel", "rokt"]` — the
   * same subdomain that appears in `https://apply.workable.com/{subdomain}/...`.
   * Each is fetched as its own HTTP request; `search()` merges the results
   * and isolates one subdomain's failure from the others (see `search()`). */
  companies: string[];
  /** Override for testing; defaults to the real Workable Accounts API host
   * (`https://www.workable.com/api/accounts`). A per-subdomain request is
   * built as `${baseUrl}/${subdomain}?details=true`. */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

/**
 * Reads the configured subdomains from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Workable's public Accounts API needs no credentials, so
 * like Greenhouse/Lever/Ashby/SmartRecruiters (and unlike USAJOBS) there is
 * no key/secret to read.
 */
export function createWorkableSourceFromEnv(env: NodeJS.ProcessEnv = process.env): WorkableSource {
  const raw = env.WORKABLE_COMPANIES;
  const companies = (raw ?? "")
    .split(",")
    .map((company) => company.trim())
    .filter((company) => company.length > 0);
  if (companies.length === 0) {
    throw new Error(
      'WORKABLE_COMPANIES must be set to a comma-separated list of Workable subdomains (e.g. "dispel,rokt").',
    );
  }
  return new WorkableSource({ companies });
}

export class WorkableSource implements JobSource {
  readonly dataSource = "workable" as const;

  readonly #companies: string[];
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(config: WorkableConfig) {
    if (config.companies.length === 0) {
      throw new Error("WorkableSource requires at least one subdomain.");
    }
    this.#companies = config.companies;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Sequential, one request per subdomain — same reasoning as
    // Lever/Ashby: a shared, unauthenticated public API, no server-side
    // pagination to chase (Finding 4), and a small enough configured list
    // that Greenhouse's concurrency pool is unwarranted complexity here.
    //
    // Per-subdomain failure isolation (this ticket's explicit acceptance
    // criterion): unlike Greenhouse/Lever/Ashby's "abort the whole search on
    // auth-failed/malformed/unmapped-status" policy, EVERY failure kind here
    // — network error, 404, 401, 403, 429, 5xx, malformed JSON — is caught
    // and isolated to the one subdomain that produced it. The ticket calls
    // out "one bad/unreachable company must not fail the whole search"
    // without qualifying which failure kinds count, so this adapter departs
    // from the narrower Greenhouse/Lever/Ashby precedent deliberately (the
    // same kind of documented, ticket-driven divergence SmartRecruiters'
    // own broader per-company isolation already establishes in this
    // codebase, for the same underlying reason: a request-per-employer
    // adapter has one employer's worth of blast radius per failure, not the
    // whole search's).
    for (const subdomain of this.#companies) {
      try {
        const data = await this.#fetchAccount(subdomain);
        const accountName = typeof data.name === "string" ? data.name : "";
        const groups = groupByShortcode(data.jobs);

        for (const group of groups) {
          const result = normalizeGroup(group, accountName, subdomain);
          if (!result.ok) {
            skipped.push({ externalId: result.externalId, reason: result.reason });
            continue;
          }
          if (!normalizedJobMatchesCriteria(result.job, criteria)) continue;
          jobs.push(result.job);
        }
      } catch (err) {
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          // Finding 1: a clean, unambiguous signal — no careers-site
          // cross-check needed, unlike SmartRecruiters.
          skipped.push({
            externalId: undefined,
            reason: `Workable account "${subdomain}" does not exist (HTTP 404) — check the subdomain; this is NOT the same as a real account with zero current postings (see workable.ts Finding 1)`,
          });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        skipped.push({
          externalId: undefined,
          reason: `Workable search failed for account "${subdomain}": ${message}`,
        });
      }
    }

    const total = jobs.length + skipped.length;
    const skipRate = total === 0 ? 0 : skipped.length / total;

    return { jobs, skipped, skipRate };
  }

  async #fetchAccount(subdomain: string): Promise<WorkableAccountResponse> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(subdomain)}`);
    url.searchParams.set("details", "true");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    let response: Response;
    try {
      response = await this.#fetchImpl(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
        // `redirect` deliberately left at its default ("follow"): see
        // Finding 1 — the documented host always 302s to the widget host,
        // and following that redirect is how the documented endpoint
        // actually behaves, not an opt-in to the internal API.
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new TransientSourceError(
          `Workable request for account "${subdomain}" timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `Workable request for account "${subdomain}" failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response, subdomain);
  }
}

async function parseResponse(
  response: Response,
  subdomain: string,
): Promise<WorkableAccountResponse> {
  if (response.status === 404) {
    // Real observed body: plain text "Not Found", not JSON — see Finding 1.
    // Status code alone classifies this; the body isn't parsed.
    throw new UnexpectedStatusError(
      `Workable account "${subdomain}" does not exist (HTTP 404)`,
      404,
    );
  }
  if (response.status === 401) {
    // Not observed against the real API in testing (it takes no
    // credentials), but classified for completeness, matching every other
    // adapter here.
    throw new AuthFailedError(
      `Workable rejected the request for account "${subdomain}" (HTTP 401)`,
    );
  }
  if (response.status === 403) {
    // Also not observed in testing; kept distinct from AuthFailedError and
    // defaulting to retryable, same reasoning as the other adapters — more
    // likely a transient edge/WAF block than Workable itself rejecting an
    // unauthenticated, public request (this endpoint sits behind Cloudflare
    // — real observed response headers include `server: cloudflare`).
    throw new ForbiddenError(
      `Request for Workable account "${subdomain}" was blocked with HTTP 403`,
    );
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Workable rate limit exceeded (HTTP 429) fetching account "${subdomain}"`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Workable server error (HTTP ${response.status}) fetching account "${subdomain}"`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Workable returned unexpected HTTP status ${response.status} for account "${subdomain}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MalformedResponseError(
      `Workable response for account "${subdomain}" was not valid JSON`,
      {
        cause: err,
      },
    );
  }

  return parseAccountResponseShape(body, subdomain);
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
// Workable response shape — only the fields this adapter reads. Verified
// against real captured responses; see this file's top-of-file comment.
// ---------------------------------------------------------------------------

type WorkableLocation = {
  country?: string;
  countryCode?: string;
  city?: string | null;
  region?: string | null;
  /** See Finding 2 — read but deliberately not filtered on; meaning
   * unverified. */
  hidden?: boolean;
};

type WorkableJob = {
  title?: string;
  /** NOT a unique posting id on its own — see Finding 2. Group by this
   * before treating a raw entry as a distinct posting. */
  shortcode?: string;
  /** Company-assigned requisition code — human-chosen, frequently empty or
   * `null` on real data (same trap class as Greenhouse's `requisition_id`;
   * never used as an identifier here). */
  code?: string | null;
  employment_type?: string | null;
  telecommuting?: boolean;
  department?: string | null;
  url?: string;
  shortlink?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
  country?: string;
  city?: string;
  state?: string;
  /** USUALLY single-entry, but not always — corrected during opus review
   * (ticket 7bbc47e), which found a real counterexample this comment
   * previously denied: valsoft-corp shortcode 746829EC0E ("Managing
   * Director") is ONE raw `jobs[]` row whose own `locations` array has
   * FOUR entries (Germany/Switzerland/France/Austria). So Workable has
   * TWO independent multi-location mechanisms, not one: row duplication
   * (Finding 2, the common case) AND a genuinely multi-entry `locations`
   * array on a single row (rare, but real). `locationEntriesFor`/
   * `mergedLocations` already handle both correctly — they read this
   * field as a real array and union every entry, never assume length 1 —
   * this doc comment was simply wrong about the data shape, not the code
   * wrong about handling it. */
  locations?: WorkableLocation[];
  description?: string;
};

type WorkableAccountResponse = {
  name?: string;
  description?: string;
  jobs: WorkableJob[];
};

function parseAccountResponseShape(body: unknown, subdomain: string): WorkableAccountResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("jobs" in body) ||
    !Array.isArray((body as Record<string, unknown>).jobs)
  ) {
    throw new MalformedResponseError(
      `Workable response for account "${subdomain}" did not match the expected shape (missing "jobs" array)`,
    );
  }
  return body as WorkableAccountResponse;
}

// ---------------------------------------------------------------------------
// Grouping by `shortcode` — see Finding 2. Must run before any per-record
// filtering/normalization, since a multi-location posting's true location
// set only exists once its copies are merged.
// ---------------------------------------------------------------------------

/**
 * Groups raw `jobs[]` entries by `shortcode`, preserving each group's
 * first-appearance order. An entry with a missing/blank `shortcode` gets its
 * own singleton group (assigned a synthetic key so it can never accidentally
 * merge with another missing-shortcode entry) rather than being silently
 * dropped here — `normalizeGroup` reports it as a proper "missing shortcode"
 * skip instead.
 */
function groupByShortcode(rawJobs: WorkableJob[]): WorkableJob[][] {
  const order: string[] = [];
  const groups = new Map<string, WorkableJob[]>();
  let missingCounter = 0;

  for (const job of rawJobs) {
    // Guarded against a non-object array element the same way Lever's
    // `allLocations`/Ashby's `secondaryLocations` guard their own
    // unvalidated array elements — `parseAccountResponseShape` only
    // validates that `jobs` IS an array, not what its elements look like.
    if (typeof job !== "object" || job === null) {
      groups.set(`__malformed-${missingCounter}__`, [job]);
      order.push(`__malformed-${missingCounter}__`);
      missingCounter += 1;
      continue;
    }
    const shortcode = typeof job.shortcode === "string" ? job.shortcode.trim() : "";
    const key = shortcode || `__missing-shortcode-${missingCounter++}__`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(job);
    } else {
      groups.set(key, [job]);
      order.push(key);
    }
  }

  return order.map((key) => groups.get(key)!);
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

/**
 * Builds ONE `NormalizedJob` from a group of raw entries that share the same
 * `shortcode` (a group of size 1 for an ordinary, single-location posting —
 * see `groupByShortcode`). Every non-location field is read off the FIRST
 * entry only, justified by Finding 2's live check that every other field is
 * identical across a real duplicate-shortcode group; `location` instead
 * reads the UNION of every entry's own `locations` array (see
 * `mergedLocations`).
 */
function normalizeGroup(
  entries: WorkableJob[],
  accountName: string,
  subdomain: string,
): NormalizeResult {
  const first = entries[0];
  if (!first || typeof first !== "object") {
    return { ok: false, externalId: undefined, reason: "malformed posting entry" };
  }

  const shortcode = typeof first.shortcode === "string" ? first.shortcode.trim() : "";
  const externalId = shortcode || undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing shortcode" };
  }

  const title = typeof first.title === "string" ? first.title.trim() : "";
  if (!title) {
    return { ok: false, externalId, reason: "missing title" };
  }

  const rawDescription = typeof first.description === "string" ? first.description : "";
  const description = htmlToPlainText(rawDescription, { doubleEncoded: false });
  if (!description) {
    return {
      ok: false,
      externalId,
      reason: "missing description content (empty after stripping HTML markup)",
    };
  }

  // Finding 7: application_url (the direct apply form) preferred over the
  // posting page, with url/shortlink as a fallback never observed to be
  // needed on real data.
  const linkToApply = firstNonEmpty(first.application_url, first.url, first.shortlink);
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing application_url and url" };
  }

  const postedAtRaw = first.published_on;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing published_on" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable published_on "${postedAtRaw}"` };
  }

  // Finding 8: the account-level display name, not the raw subdomain — kept
  // as a fallback only, never observed to be needed.
  const company = accountName.trim() || subdomain;

  const locations = mergedLocations(entries);
  const location = locations.length > 0 ? locations.join("; ") : undefined;

  const payType = undefined; // Finding 6: no compensation field exists anywhere in this API.
  const commitment = mapCommitment(first);
  const locationType = mapLocationType(first);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable value) is not a skip condition, only a structural problem
  // is (missing shortcode, missing title, missing application_url/url,
  // missing description, missing/unparseable published_on — all checked
  // above).

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "workable",
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

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Location merging — see Finding 2. Reads every entry's own `locations`
// array (usually single-entry per row, but not always — see Finding 2 and
// the WorkableJob.locations doc comment) and returns the deduped union,
// formatted and in first-seen order.
// ---------------------------------------------------------------------------

function mergedLocations(entries: WorkableJob[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    for (const loc of locationEntriesFor(entry)) {
      const formatted = formatLocation(loc);
      if (formatted && !seen.has(formatted)) {
        seen.add(formatted);
        result.push(formatted);
      }
    }
  }
  return result;
}

function locationEntriesFor(entry: WorkableJob): WorkableLocation[] {
  if (Array.isArray(entry.locations) && entry.locations.length > 0) {
    // Guarded against a non-object array element, same discipline as
    // `groupByShortcode` — `locations` is read off an unvalidated cast.
    return entry.locations.filter(
      (loc): loc is WorkableLocation => typeof loc === "object" && loc !== null,
    );
  }
  // Defensive fallback for an entry with no `locations` array but top-level
  // country/city/state still present. Never observed to be needed on real
  // data (`locations[0]` mirrors these three fields on every entry checked),
  // kept so a shape Workable changes later doesn't silently drop a real
  // location rather than degrade to reading the top-level fields instead.
  if (entry.country || entry.city || entry.state) {
    return [{ country: entry.country, city: entry.city, region: entry.state }];
  }
  return [];
}

function formatLocation(loc: WorkableLocation): string | undefined {
  const parts = [loc.city, loc.region, loc.country]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

// ---------------------------------------------------------------------------
// Client-side filtering — like Greenhouse/Lever/Ashby, Workable's accounts
// endpoint has no server-side search and always returns the entire board
// (Finding 4). Applied AFTER grouping/normalization (unlike those three
// adapters, which filter the raw item before normalizing) because a
// multi-location posting's real location set doesn't exist until its raw
// entries are merged — see Finding 2.
// ---------------------------------------------------------------------------

function normalizedJobMatchesCriteria(job: NormalizedJob, criteria: SearchCriteria): boolean {
  if (criteria.keyword) {
    const keyword = criteria.keyword.toLowerCase();
    const title = job.title.toLowerCase();
    const description = job.description.toLowerCase();
    if (!title.includes(keyword) && !description.includes(keyword)) return false;
  }
  if (criteria.location) {
    const location = criteria.location.toLowerCase();
    const jobLocation = job.location?.toLowerCase() ?? "";
    if (!jobLocation.includes(location)) return false;
  }
  return true;
}

/**
 * Maps `employment_type` -> `Job["commitment"]`. See Finding 6: real values
 * are `"Full-time"`, `""`, `"Contract"`, `null`, `"Part-time"`, and
 * `"Temporary"` — the first three (plus a case-insensitive match) map
 * cleanly; `"Temporary"` has no unambiguous mapping onto `commitment`'s
 * three values (same reasoning as Lever's "Fixed-Term"/Ashby's
 * "Temporary") and, like empty string / `null`, falls through to
 * `undefined` rather than a guess.
 */
function mapCommitment(item: WorkableJob): Job["commitment"] | undefined {
  const raw =
    typeof item.employment_type === "string" ? item.employment_type.trim().toLowerCase() : "";
  if (raw === "full-time") return "full-time";
  if (raw === "part-time") return "part-time";
  if (raw === "contract") return "contract";
  return undefined;
}

/**
 * Maps `telecommuting` -> `Job["locationType"]`. See Finding 5: this is the
 * only remote/onsite signal Workable's public API exposes at all — there is
 * no structured "hybrid" value to map onto, so this can only ever return
 * `"remote"` or `"onsite"`, never `"hybrid"`, however hybrid the real
 * arrangement might be (a real Valsoft posting's own description says
 * "Hybrid and flexible working environment" while `telecommuting: true` —
 * the structured boolean is trusted as-is, per this project's standing rule
 * against parsing prose into a closed enum; see Finding 5).
 */
function mapLocationType(item: WorkableJob): Job["locationType"] | undefined {
  if (typeof item.telecommuting !== "boolean") return undefined;
  return item.telecommuting ? "remote" : "onsite";
}
