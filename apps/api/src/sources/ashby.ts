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
// Adapter for Ashby's public Job Board API
// (https://developers.ashbyhq.com/docs/public-job-posting-api), one HTTP
// call per configured board name:
//
//   GET https://api.ashbyhq.com/posting-api/job-board/{boardName}?includeCompensation=true
//
// Everything below was written against real, live-captured responses from
// four boards named directly in this ticket (ramp, linear, notion, vanta —
// 393 real postings total as of 2026-08-21) plus a handful of additional
// boards fetched only to widen coverage before writing any mapping (coda,
// watershed, retool, mercury, gem, attentive, modernhealth, flexport,
// openphone, assemblyai, deel, hex, census — watershed and hex returned real
// postings, mercury and deel 200'd with a real, legitimate empty board, the
// rest 404'd). Trimmed subsets (fields untouched, only which postings were
// kept was trimmed) are saved under __fixtures__/ashby-real-response-ramp.json,
// __fixtures__/ashby-real-response-notion.json, and
// __fixtures__/ashby-real-response-mercury.json (a real, verbatim empty-board
// response: `{"jobs":[],"apiVersion":"1"}`). Per the standing instruction not
// to repeat USAJOBS' mistake of inventing fixtures/mappings from assumptions,
// every field below was read off real responses (cross-checked against
// Ashby's own docs at developers.ashbyhq.com), not guessed at.
//
// Findings that shape the design here:
//
// 1. UNLIKE Lever's bare array, but LIKE Greenhouse, the response body is a
//    JSON object: `{ jobs: [...], apiVersion: "1" }`. There is no pagination
//    and no server-side keyword/location query support — every board fetched
//    returned its entire posting set in one response (`jobs.length` matched
//    this ticket's pre-verified counts exactly: ramp 135, linear 32, notion
//    129, vanta 97-98 — vanta's count moved by one between two fetches made
//    minutes apart, confirming boards genuinely change over time, same
//    caveat as Lever's palantir count). So `search()` filters client-side,
//    same as the other two adapters — see `itemMatchesCriteria`.
//
// 2. THE HIDDEN FIELD (this ticket's explicit warning: "assume Ashby has its
//    own version of Lever's allLocations/lists and go looking for it" —
//    there are THREE, not one, and a first pass of this adapter caught the
//    first two and missed the third — see 2c, added after an adversarial
//    review, for what "go looking for it" actually requires: not stopping
//    once one hidden field is found):
//
//    a) `secondaryLocations` — Ashby's own docs confirm `location` is only
//       one representative location, same shape as Lever's finding 5. A
//       posting open to multiple locations carries the rest in
//       `secondaryLocations[].location`. Measured 2026-08-21 across all 393
//       real postings from the four ticket-named boards: 118 had 1+
//       `secondaryLocations` entries, and on every one checked, at least one
//       `secondaryLocations` entry named a place absent from `location`
//       itself (e.g. real Ramp posting 34413f8d-...: `location: "New York,
//       NY (HQ)"`, `secondaryLocations: ["Remote (Canada)", "Remote (US)",
//       "Miami, FL"]` — none of those three appear in `location`). Exactly
//       Lever's Taipei bug, so `itemLocations` (below) returns the union of
//       both, `location` first, same structure as Lever's fix.
//
//    b) Compensation is NOT absent the way it is on Greenhouse — it is
//       *gated behind a query parameter Ashby's docs document but the base
//       response never mentions*: `?includeCompensation=true`. Without it,
//       no posting in any response fetched here carries any
//       compensation/salary field under any name (confirmed: grepped for
//       "compensation"/"salary"/"pay" (case-insensitive substring) across
//       all 393 raw postings from the base endpoint — zero matches). WITH
//       it, `compensation` appears on every single posting (394/394 on a
//       re-fetch): 210 of those have an empty `compensationTiers` array
//       (comp genuinely not disclosed for that posting — not a bug, a real,
//       common state), but 184 have real structured tiers with `minValue`/
//       `maxValue`/`currencyCode`/`interval`/`compensationType` — see
//       `mapPayType`. This is the same class of finding as Greenhouse's
//       `content=true` (without it, descriptions come back empty) and
//       Lever's `mode=json` (without it, an HTML page instead of JSON) — an
//       easy-to-miss query parameter that silently withholds real data
//       rather than erroring, so a mapper written only against the bare
//       endpoint would report `payType` as always-undefined and never know
//       it was looking at a stripped-down response the whole time. This
//       adapter always requests `includeCompensation=true`.
//
//    c) CORRECTION, added after an adversarial review (2026-08-22): finding
//       2a above is real but incomplete. There is a THIRD sibling this
//       adapter's first pass never read at all: `address.postalAddress`
//       (present on the primary posting AND on every `secondaryLocations[]`
//       entry — its own structured `{addressLocality, addressRegion,
//       addressCountry}`, independent of that same entry's `location`
//       display string). `location`/`secondaryLocations[].location` are
//       display strings; `address.postalAddress` is the canonical
//       structured place data, and the two routinely disagree in coverage.
//       Verified live 2026-08-22, 399 postings across
//       ramp/linear/notion/vanta (boards changed size again since 2a's
//       2026-08-21 count of 393 — see finding 1's note on boards changing
//       over time): `address` is present on 399/399 postings. 309 of 399
//       have at least one address component naming a place absent from
//       every display-string location on that same posting — e.g. real Ramp
//       posting 34413f8d-...: `location: "New York, NY (HQ)"`, but
//       `address.postalAddress.addressLocality` is `"New York City"`, a
//       string that appears in no display-string location on the posting
//       at all. The practical cost of missing this: filtering only on
//       `location`/`secondaryLocations[].location` display strings returns
//       ZERO of 116 real "New York City" matches, zero of 182 real "USA"
//       matches, zero of 21 real "Ontario" matches, and only 65 of 141 real
//       "California" matches. `itemLocationSearchTerms` (below) folds
//       `address.postalAddress` components — primary and every secondary's
//       — into the location-filter haystack as a union with the
//       display-string locations from 2a, same "union, not replacement"
//       shape as Lever's `location`/`allLocations` fix, for the same
//       reason: each side has real coverage the other lacks (see that
//       function's own doc comment for the "CA"/"Remote" cases proving this).
//
//       Deliberately NOT folded into the stored `Job.location` display
//       string, though: the address data is measurably dirtier than the
//       display strings it would be joined with — real values include the
//       misspelling "San Fransisco" alongside correctly-spelled "San
//       Francisco" on other postings, "California " with a trailing space,
//       and "USA"/"United States"/"UK"/"United Kingdom" all coexisting as
//       values for the same two countries. Fine for a search haystack
//       (substring matching tolerates it, and present-but-dirty beats
//       silently absent); not something this adapter will put in front of a
//       user as the job's stored location. `itemLocations` (feeding
//       `Job.location`) is unchanged by this finding and still never reads
//       `address`.
//
// 3. `descriptionHtml` and `descriptionPlain` are BOTH present on every real
//    posting checked (393/393) — unlike Lever, which sometimes has an empty
//    `descriptionPlain` with content only in the HTML field. Measured
//    2026-08-21: comparing `descriptionPlain`'s words against
//    tag-stripped `descriptionHtml`'s words across all 393 postings found
//    zero postings where the HTML side had 5+ distinct words absent from the
//    plain side — the two carry equivalent content on every real posting
//    checked. So `descriptionPlain` (already plain text — no encode/strip
//    pass needed) is used directly, with a fallback to
//    `htmlToPlainText(item.descriptionHtml, { doubleEncoded: false })` only
//    for the case measured to be rare-to-nonexistent on this data (same
//    defensive shape as Lever's matchgroup fallback, kept for the same
//    reason: Lever's "no real posting does X" claim about an empty
//    descriptionPlain was wrong and had to be corrected with a real fixture
//    once found — this fallback exists so a future Ashby posting shaped like
//    that doesn't silently land in `skipped`).
//
//    `doubleEncoded: false` (single-encoded, like Lever, NOT double-encoded
//    like Greenhouse) was determined empirically, not assumed: real
//    `descriptionHtml` values contain literal, unescaped tags (`<p
//    style="...">`, `<li>`, ...) directly — 393/393 postings checked had at
//    least one real `<p`/`<div`/`<h`/`<ul`/`<li`/`<strong` substring, which
//    would be `&lt;p&gt;` etc. under Greenhouse-style double-encoding, not a
//    literal `<`. Five real postings additionally have a literal escaped
//    `&lt;`/`&gt;` sitting in ordinary body text ALONGSIDE those real
//    unescaped tags — e.g. real Ramp posting 94d79eed-...: "...onboard onto
//    Ramp in 60 days and &lt;2 calls" inside an `<li><p>` the encoder never
//    touched, and real Notion posting 05e14247-...: "You have &gt; 1 year
//    experience...". Both are captured in the ramp/notion fixtures
//    specifically to prove `doubleEncoded: false` end-to-end: getting this
//    backwards (as Lever's own N1 finding warns) would pre-decode those
//    literal entities into stray `<`/`>` characters that the tag-stripper
//    then treats as real tag delimiters, silently eating everything up to
//    the next real closing tag.
//
// 4. `employmentType` and `workplaceType` ARE genuine fixed, documented
//    enums here — unlike Lever's `categories.commitment`, which turned out
//    to be a free per-company string. Ashby's own docs
//    (developers.ashbyhq.com) enumerate `employmentType` as exactly
//    `"FullTime" | "PartTime" | "Intern" | "Contract" | "Temporary"` and
//    `workplaceType` as exactly `"OnSite" | "Remote" | "Hybrid"`. Real data
//    (393 postings) exercised four of the five `employmentType` values
//    (FullTime 384, Intern 4, Temporary 3, Contract 2 — no real "PartTime"
//    posting turned up on any of the six boards checked, so that branch is
//    real code backed by the documented enum, not by an observed example —
//    flagged honestly, same as Lever's untested "per-hour" `payType` branch)
//    and all three `workplaceType` values (Hybrid 221, Remote 105, OnSite
//    13) plus a fourth real state Ashby's docs don't mention: `workplaceType:
//    null` (54 of 393, all on notion/vanta — confirmed by inspecting the raw
//    key, not just a falsy check: the key is present with a literal JSON
//    `null`, not omitted). `mapLocationType`/`mapCommitment` both handle this
//    the same way absence is handled everywhere else in this project: no
//    guess, `undefined`.
//
// 5. Unlike Lever/Greenhouse, Ashby's posting objects carry no company name
//    field anywhere either (checked the same way as Lever's finding 2: every
//    key at every level of all 393 real postings, plus the response
//    envelope's own two keys, `jobs` and `apiVersion`) — `company` on the
//    returned `Job` is the configured board name, not a value read off the
//    record, same reasoning and same non-skip-condition as Lever.
//
// 6. `applyUrl` (goes straight to Ashby's hosted application form) is
//    preferred over `jobUrl` (goes to the posting's description page) for
//    `linkToApply`, matching the one other adapter that had this same
//    choice to make: USAJOBS explicitly prefers `ApplyURI` over the more
//    general `PositionURI` for the same field (see usajobs.ts). Both are
//    present on 393/393 real postings checked; `jobUrl` is used as a
//    fallback only, never observed to be needed.
//
// 7. Ashby's board-not-found behavior is a plain-text 404 ("Not Found", not
//    JSON) — confirmed against a real nonexistent board name. This ticket
//    requires that a nonexistent board be reported DISTINCTLY from a board
//    that genuinely has zero open postings (confirmed real and different:
//    mercury and deel both return HTTP 200 with a real, legitimate
//    `{"jobs":[],"apiVersion":"1"}` — a company on Ashby with nothing open
//    right now, not an error). Lever/Greenhouse's precedent for a 404'd
//    company is to `continue` silently, contributing nothing to either
//    `jobs` or `skipped` — which makes a search over only a 404'd board
//    return the exact same `{ jobs: [], skipped: [], skipRate: 0 }` shape as
//    a search over only a genuinely-empty board. That precedent does not
//    satisfy this ticket's distinctness requirement, so this adapter departs
//    from it deliberately: a 404 is recorded as a `SkippedRecord` (
//    `externalId: undefined`, reason naming the board and the 404) rather
//    than silently dropped. This keeps per-board failure isolation intact
//    (one bad board name still can't fail the whole search — see
//    `search()`) while making the two cases distinguishable through
//    `SourceSearchResult`: a zero-openings-board-only search reports
//    `skipRate: 0` with nothing in `skipped` at all; a nonexistent-board
//    search always adds a `SkippedRecord` whose `reason` names the board
//    and the 404.
//
//    CORRECTION (2026-08-22, adversarial review): an earlier version of this
//    finding claimed the nonexistent-board case "reports skipRate: 1",
//    stated without qualification. That is only true when the 404'd board
//    is the *only* board configured. Configure `["ramp", "typo-board"]` and
//    the real result is `skipRate: skipped.length / (jobs.length +
//    skipped.length)` — one board-level skip diluted by every one of the
//    healthy board's postings (e.g. 1 skip against ramp's 135+ real jobs
//    yields `skipRate` under 0.01, which `demo-match.ts` would render as
//    "0.01", visually indistinguishable from ordinary per-record noise).
//    The actual, reliable distinguishing signal — in every configuration,
//    not just the single-board one — is `skipped[].reason` naming the board
//    and the 404, not the numeric `skipRate`. See `types.ts`'s `skipRate`
//    doc comment for the related, more general point: a board-level skip
//    (one `SkippedRecord` regardless of how many postings that board would
//    have contributed) makes the denominator behind `skipRate` incoherent
//    in a way record-level skips don't, and a 404-only search returns
//    `jobs: []`, so a worker alerting only on "high skipRate on a
//    *non-empty* result" (`types.ts`'s own documented contract) would not
//    alert on it at all.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";
const DEFAULT_TIMEOUT_MS = 15_000;

export type AshbyConfig = {
  /** One board name per company, e.g. `["ramp", "notion"]` — the same name
   * that appears in `https://jobs.ashbyhq.com/{boardName}/...`. Each is
   * fetched as its own HTTP request; `search()` merges the results. */
  boardNames: string[];
  /** Override for testing; defaults to the real Ashby Job Board API host
   * (`https://api.ashbyhq.com/posting-api/job-board`). A per-board request is
   * built as `${baseUrl}/${boardName}?includeCompensation=true`. */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

/**
 * Reads the configured board names from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Ashby's public Job Board API needs no credentials, so like
 * Lever and Greenhouse (and unlike USAJOBS) there is no key/secret to read.
 */
export function createAshbySourceFromEnv(env: NodeJS.ProcessEnv = process.env): AshbySource {
  const raw = env.ASHBY_BOARD_NAMES;
  const boardNames = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (boardNames.length === 0) {
    throw new Error(
      'ASHBY_BOARD_NAMES must be set to a comma-separated list of Ashby job board names (e.g. "ramp,notion").',
    );
  }
  return new AshbySource({ boardNames });
}

export class AshbySource implements JobSource {
  readonly dataSource = "ashby" as const;

  readonly #boardNames: string[];
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(config: AshbyConfig) {
    if (config.boardNames.length === 0) {
      throw new Error("AshbySource requires at least one board name.");
    }
    this.#boardNames = config.boardNames;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Sequential, not Promise.all — same reasoning as Lever/Greenhouse: a
    // shared, unauthenticated public API with no per-key rate limit to
    // spend in parallel, and a 429/5xx on one board shouldn't fire a burst
    // of simultaneous requests at the others.
    for (const boardName of this.#boardNames) {
      let data: AshbyBoardResponse;
      try {
        data = await this.#fetchBoard(boardName);
      } catch (err) {
        // A 404 here means *this specific board name* doesn't exist (typo,
        // never used Ashby, moved off it). Unlike Lever/Greenhouse, this is
        // NOT silently skipped — see finding 7 in this file's top-of-file
        // comment for why: this ticket requires a nonexistent board be
        // reported distinctly from a board that genuinely has zero open
        // postings, and a `SkippedRecord` naming the 404 is the one channel
        // `SourceSearchResult` exposes for that. Still doesn't throw, so one
        // bad board name can't fail the whole search — the healthy boards'
        // jobs are still collected.
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          skipped.push({
            externalId: undefined,
            reason: `Ashby board "${boardName}" does not exist (HTTP 404) — check the board name`,
          });
          continue;
        }
        throw err;
      }

      for (const item of data.jobs) {
        const fullDescription = buildDescription(item);
        if (!itemMatchesCriteria(item, criteria, fullDescription)) continue;
        const result = normalizeItem(item, boardName, fullDescription);
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

  async #fetchBoard(boardName: string): Promise<AshbyBoardResponse> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(boardName)}`);
    // Without this, `compensation` is omitted from every posting entirely —
    // see finding 2b in this file's top-of-file comment. Not a required
    // parameter (the endpoint 200s fine without it), just a silently
    // stripped-down response, the same trap as Greenhouse's `content=true`.
    url.searchParams.set("includeCompensation", "true");

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
          `Ashby request for board "${boardName}" timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `Ashby request for board "${boardName}" failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response, boardName);
  }
}

async function parseResponse(response: Response, boardName: string): Promise<AshbyBoardResponse> {
  if (response.status === 404) {
    // Real observed body: plain text "Not Found", not JSON — confirmed
    // against a real nonexistent board name. Status code alone classifies
    // this; the body isn't parsed.
    throw new UnexpectedStatusError(
      `Ashby board "${boardName}" does not exist (HTTP 404) — check the board name`,
      404,
    );
  }
  if (response.status === 401) {
    // Not observed against the real API in testing (it takes no
    // credentials), but classified for completeness, matching Lever and
    // Greenhouse.
    throw new AuthFailedError(`Ashby rejected the request for board "${boardName}" (HTTP 401)`);
  }
  if (response.status === 403) {
    // Also not observed in testing; kept distinct from AuthFailedError and
    // defaulting to retryable, same reasoning as the other two adapters —
    // more likely a transient edge/WAF block than Ashby itself rejecting an
    // unauthenticated, public request.
    throw new ForbiddenError(`Request for Ashby board "${boardName}" was blocked with HTTP 403`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Ashby rate limit exceeded (HTTP 429) fetching board "${boardName}"`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Ashby server error (HTTP ${response.status}) fetching board "${boardName}"`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Ashby returned unexpected HTTP status ${response.status} for board "${boardName}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MalformedResponseError(`Ashby response for board "${boardName}" was not valid JSON`, {
      cause: err,
    });
  }

  return parseBoardResponseShape(body, boardName);
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
// Ashby response shape — only the fields this adapter reads. Verified
// against real captured responses and Ashby's own API docs; see this file's
// top-of-file comment.
// ---------------------------------------------------------------------------

/** `address.postalAddress`'s three components — see finding 2c. Any of the
 * three can be absent even when `address`/`postalAddress` itself is
 * present. */
type AshbyPostalAddress = {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
};

type AshbyAddress = {
  postalAddress?: AshbyPostalAddress;
};

type AshbySecondaryLocation = {
  location?: string;
  /** See finding 2c: each secondary location has its own structured
   * address, independent of (and sometimes disagreeing in coverage with)
   * its own `location` display string. */
  address?: AshbyAddress;
};

/** One compensation component within a tier — e.g. the "Salary" line, the
 * "Offers Equity" line, the "Offers Commission" line. Only present at all
 * when the request includes `includeCompensation=true` — see finding 2b. */
type AshbyCompensationComponent = {
  compensationType?: string;
  interval?: string;
};

type AshbyCompensationTier = {
  components?: AshbyCompensationComponent[];
};

type AshbyCompensation = {
  /** Real postings checked (2026-08-21, 394 across ramp/linear/notion/vanta
   * with `includeCompensation=true`) always have a `compensation` object,
   * but 210 of 394 have an empty `compensationTiers` array — comp genuinely
   * not disclosed for that posting, not a parsing failure. */
  compensationTiers?: AshbyCompensationTier[];
};

type AshbyJob = {
  id?: string;
  title?: string;
  employmentType?: string;
  location?: string;
  /** See finding 2a: a posting open to multiple locations carries the rest
   * here, and `location` is not guaranteed to be a member of this list. */
  secondaryLocations?: AshbySecondaryLocation[];
  /** See finding 2c: the structured sibling of `location`/`secondaryLocations`.
   * Used only to widen the location *search* haystack (`itemLocationSearchTerms`)
   * — never stored on `Job.location` (see that function's doc comment for why). */
  address?: AshbyAddress;
  publishedAt?: string;
  /** Documented enum `"OnSite" | "Remote" | "Hybrid"`, but real data
   * (2026-08-21) also has a fourth real state Ashby's docs don't mention:
   * a literal JSON `null` (54 of 393 real postings checked, all on
   * notion/vanta) — see finding 4. */
  workplaceType?: string | null;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: AshbyCompensation;
};

type AshbyBoardResponse = {
  jobs: AshbyJob[];
};

function parseBoardResponseShape(body: unknown, boardName: string): AshbyBoardResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("jobs" in body) ||
    !Array.isArray((body as Record<string, unknown>).jobs)
  ) {
    throw new MalformedResponseError(
      `Ashby response for board "${boardName}" did not match the expected shape (missing "jobs" array)`,
    );
  }
  return body as AshbyBoardResponse;
}

// ---------------------------------------------------------------------------
// Full-text assembly for `description` — see finding 3 in this file's
// top-of-file comment. `descriptionPlain` carries equivalent content to
// tag-stripped `descriptionHtml` on every real posting measured, so it's
// used directly (already plain text, no strip pass needed); the HTML
// fallback below is defensive, not required by any real posting seen so far
// — see Lever's matchgroup finding for why "never happens" claims about this
// shape have been wrong before.
// ---------------------------------------------------------------------------

function buildDescription(item: AshbyJob): string {
  const plain = item.descriptionPlain?.trim();
  if (plain) return plain;
  return item.descriptionHtml
    ? htmlToPlainText(item.descriptionHtml, { doubleEncoded: false })
    : "";
}

// ---------------------------------------------------------------------------
// `secondaryLocations` vs `location` — see finding 2a. `location` is one
// representative entry; `secondaryLocations` carries the rest of what a
// multi-location posting is actually open to. Both the location *search*
// haystack (`itemLocationSearchTerms`, below) and the stored `Job.location`
// display string use the union of `location` display strings, not `location`
// alone.
// ---------------------------------------------------------------------------

function itemLocations(item: AshbyJob): string[] {
  const primary = item.location?.trim();

  const secondary = validSecondaryLocations(item)
    .map((entry) => entry.location?.trim())
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  const combined = primary ? [primary, ...secondary] : secondary;
  return Array.from(new Set(combined));
}

function validSecondaryLocations(item: AshbyJob): AshbySecondaryLocation[] {
  // `secondaryLocations` is read off an unvalidated `as AshbyJob[]` cast
  // (see `parseBoardResponseShape`), so a malformed entry isn't ruled out
  // at the type level — guard the type, not just nullishness, same
  // discipline as Lever's `allLocations` handling.
  return (item.secondaryLocations ?? []).filter(
    (entry): entry is AshbySecondaryLocation => typeof entry === "object" && entry !== null,
  );
}

/**
 * Pulls `addressLocality`/`addressRegion`/`addressCountry` out of a
 * `postalAddress`, trimmed and with blanks dropped. Any of the three can be
 * absent even when `address`/`postalAddress` itself is present (e.g. a real
 * "Remote (Canada)" secondary location's address carries only
 * `addressCountry: "Canada"`, no locality or region at all).
 */
function postalAddressComponents(address: AshbyAddress | undefined): string[] {
  const postal = address?.postalAddress;
  if (!postal) return [];
  return [postal.addressLocality, postal.addressRegion, postal.addressCountry]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * See finding 2c. Location *search* terms only — this is deliberately NOT
 * what feeds the stored `Job.location` display string (that's still plain
 * `itemLocations`, unchanged). Returns the union of every display-string
 * location (`itemLocations`) and every structured `address.postalAddress`
 * component, from both the primary `address` and every
 * `secondaryLocations[].address`.
 *
 * Verified live (2026-08-22, 399 postings across ramp/linear/notion/vanta,
 * `includeCompensation=true` — this endpoint also always returns `address`,
 * no separate flag needed for it): 309 of 399 postings have at least one
 * `address` component (on the primary address or a secondary's) that names
 * a place absent from every `location`/`secondaryLocations[].location`
 * display string on that same posting — e.g. real Ramp posting
 * 34413f8d-...: `location: "New York, NY (HQ)"`, but its `address` resolves
 * to `addressLocality: "New York City"`, a string that never appears in any
 * display-string location on the posting. Filtering `location` display
 * strings alone therefore silently misses real matches:
 * `search({location:"New York City"})` returns 0 of 116 real matches with
 * display strings alone, `"USA"` returns 0 of 182, `"Ontario"` returns 0 of
 * 21, `"California"` returns 65 of 141 (address components catch the other
 * 76 — see the sibling case below for why display strings still matter
 * too). Exactly Lever's `allLocations` bug (a structured sibling carrying
 * coverage the display string lacks) wearing a different field name, on a
 * field this ticket explicitly asked to go looking for.
 *
 * This is a UNION, not a replacement, for the same reason Lever's `location`
 * ∪ `allLocations` fix was a union and not a swap to `allLocations` alone:
 * each side has real search coverage the other lacks, verified live
 * (2026-08-22, same 399 postings). The clearest single case: `"CA"` matches
 * 177 postings via the union, but only 173 via display strings alone and
 * only 154 via address components alone — the union's 177 is more than
 * EITHER side reaches by itself, so neither side is droppable. `"Remote"` is
 * the sharper one-sided case: 109 real matches, every one of them via a
 * display string (`"Remote (US)"`/`"Remote (Canada)"`-style location
 * names) and ZERO via address — `"Remote"` never appears in any real
 * `address.postalAddress` component (those name places, not work
 * arrangements: 34413f8d-...'s "Remote (US)" secondary resolves to bare
 * `{addressCountry: "United States"}`, no "Remote" qualifier at all) — so an
 * address-only implementation would silently drop every `"Remote"` search.
 *
 * The address data is measurably dirtier than the display-string data —
 * real values seen include the misspelling "San Fransisco" (alongside the
 * correctly-spelled "San Francisco" on other postings), "California " with
 * a trailing space, and "USA"/"United States"/"UK"/"United Kingdom" all
 * coexisting as country values for the same country. That's acceptable in a
 * search haystack (a substring match against "California" still finds
 * "California " once trimmed, and dirty-but-present beats absent), but per
 * the project owner's explicit instruction on this finding, it does NOT
 * belong in `Job.location`, the display string a user reads — trimming
 * whitespace is one thing, silently editorializing "San Fransisco" into
 * "San Francisco" for a stored, user-facing value is another, and this
 * adapter does neither: `itemLocations` (feeding `Job.location`) never
 * reads `address` at all.
 */
function itemLocationSearchTerms(item: AshbyJob): string[] {
  const displayTerms = itemLocations(item);
  const addressTerms = [
    ...postalAddressComponents(item.address),
    ...validSecondaryLocations(item).flatMap((entry) => postalAddressComponents(entry.address)),
  ];
  return Array.from(new Set([...displayTerms, ...addressTerms]));
}

// ---------------------------------------------------------------------------
// Client-side filtering — like Lever and Greenhouse, Ashby's board endpoint
// has no server-side search; it always returns the board's entire posting
// set. `SearchCriteria` is applied here instead, against the raw item (and
// its already-assembled full description), before normalization.
// ---------------------------------------------------------------------------

function itemMatchesCriteria(
  item: AshbyJob,
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
    // The full search haystack — display-string locations UNION structured
    // address components — see `itemLocationSearchTerms`'s doc comment
    // (finding 2c) for why display strings alone silently miss real
    // matches. Deliberately NOT `itemLocations` alone.
    const locations = itemLocationSearchTerms(item).map((entry) => entry.toLowerCase());
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
  item: AshbyJob,
  boardName: string,
  fullDescription: string,
): NormalizeResult {
  // Ashby's `id` is a UUID that appears in both `jobUrl` and `applyUrl` (e.g.
  // "https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245") and
  // is what the id-list re-fetch check below (see this ticket's report) used
  // to confirm the same board returns the same ids in the same order on
  // repeated requests. There is no other candidate identifier on the record.
  const externalId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing id" };
  }

  // 23 of 393 real titles checked (2026-08-21) have stray leading/trailing
  // whitespace (e.g. real Ramp posting 34413f8d-...: `" Security Engineer,
  // Cloud"`) — trimmed here rather than stored verbatim.
  const title = item.title?.trim();
  if (!title) {
    return { ok: false, externalId, reason: "missing title" };
  }

  // See finding 6: `applyUrl` (the direct application-form link) is
  // preferred over `jobUrl` (the posting's description page), matching
  // USAJOBS' precedent of preferring `ApplyURI` over `PositionURI`.
  const linkToApply = item.applyUrl ?? item.jobUrl;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing applyUrl and jobUrl" };
  }

  const description = fullDescription.trim();
  if (!description) {
    return {
      ok: false,
      externalId,
      reason:
        "missing description content (descriptionPlain and the descriptionHtml fallback were both empty)",
    };
  }

  const postedAtRaw = item.publishedAt;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing publishedAt" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable publishedAt "${postedAtRaw}"` };
  }

  // Ashby's posting objects carry no company name field anywhere (see
  // finding 5) — `company` is therefore the configured board name this
  // posting was fetched under, not a value read off the record, so there is
  // no "missing company" skip case the way Greenhouse has one.

  // The union of `location` and every `secondaryLocations` entry, not just
  // the one representative `location` — see finding 2a. Joined with "; "
  // for the same reason as Lever: individual entries can themselves contain
  // commas (e.g. a hypothetical "Toronto, ON" alongside other entries).
  const locations = itemLocations(item);
  const location = locations.length > 0 ? locations.join("; ") : undefined;

  const payType = mapPayType(item);
  const commitment = mapCommitment(item);
  const locationType = mapLocationType(item);

  // payType/commitment/locationType are optional on `Job`: absence (or an
  // un-mappable value) is not a skip condition, only a structural problem
  // is (missing id, missing title, missing applyUrl/jobUrl, missing
  // description, missing/unparseable publishedAt — all checked above).

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "ashby",
      title,
      description,
      company: boardName,
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
 * Maps `employmentType` -> Job's 3-value enum (`"full-time" | "part-time" |
 * "contract"`). Unlike Lever's `categories.commitment`, this IS a genuine
 * fixed enum: Ashby's own docs (developers.ashbyhq.com) document exactly
 * five values — `"FullTime"`, `"PartTime"`, `"Intern"`, `"Contract"`,
 * `"Temporary"` — and real data across six boards checked (ramp, linear,
 * notion, vanta, watershed, hex — 455 postings) never produced a value
 * outside that set. Real data exercised FullTime (384), Intern (4),
 * Temporary (3), and Contract (2); no real PartTime posting turned up on any
 * board checked, so that branch is backed by the documented enum, not by an
 * observed example — flagged honestly rather than dressed up as more
 * verified than it is (same disclosure Lever's untested "per-hour" payType
 * branch makes).
 *
 * `Intern` and `Temporary` are real, distinct employment relationships with
 * no unambiguous mapping onto Job's 3-value enum — left `undefined` rather
 * than guessed at, same reasoning as Lever's "Internship"/"Fixed-Term".
 */
function mapCommitment(item: AshbyJob): Job["commitment"] | undefined {
  const raw = item.employmentType?.trim().toLowerCase();
  if (raw === "fulltime") return "full-time";
  if (raw === "parttime") return "part-time";
  if (raw === "contract") return "contract";
  return undefined;
}

/**
 * Maps `workplaceType` directly onto Job's `locationType` enum. Also a
 * genuine fixed, documented enum (`"OnSite" | "Remote" | "Hybrid"`) whose
 * three non-null values match Job's enum exactly modulo casing. Real data
 * additionally has a fourth state the docs don't mention: `workplaceType:
 * null` (54 of 393 real postings checked, 2026-08-21, all on notion/vanta —
 * confirmed to be a literal JSON `null` on the key, not an omitted key).
 * Optional chaining on `item.workplaceType?.trim()` handles `null` the same
 * way it handles `undefined` — falls through to `undefined` below, no
 * guess, matching every other unmappable-but-optional field in this project.
 */
function mapLocationType(item: AshbyJob): Job["locationType"] | undefined {
  const raw = item.workplaceType?.trim().toLowerCase();
  if (raw === "remote") return "remote";
  if (raw === "hybrid") return "hybrid";
  if (raw === "onsite") return "onsite";
  return undefined;
}

/**
 * Maps `compensation.compensationTiers[].components[]` -> Job's `payType`
 * (`"hourly" | "salary"`). Only populated at all when the request includes
 * `includeCompensation=true` — see finding 2b. Real data (2026-08-21, 394
 * postings across ramp/linear/notion/vanta with that flag set) has each
 * component tagged with a `compensationType` (`"Salary"`, `"EquityCashValue"`,
 * `"EquityPercentage"`, `"Commission"`, `"Bonus"` — all five observed) and an
 * `interval` naming the pay period (`"1 YEAR"` on 418 components, `"NONE"`
 * on 75 equity/non-periodic ones, and exactly one real `"1 MONTH"` — a
 * Ramp internship's monthly stipend, real posting 67fadb77-...,
 * `{"compensationType":"Salary","interval":"1 MONTH", ...}`).
 *
 * This looks specifically for a `"Salary"`-typed component (skipping
 * Equity/Commission/Bonus, which aren't a pay-period classification the way
 * `payType` means it) and classifies by whether `interval` names an hourly
 * period. No real `"Salary"` component with an hourly interval turned up on
 * any board checked — every one seen was `"1 YEAR"` or the one `"1 MONTH"`
 * case, both mapped to `"salary"` (a monthly-paid internship stipend is
 * still salary, not an hourly wage) — so the `"hourly"` branch is real code
 * exercising the same honest-disclosure discipline as Lever's untested
 * per-hour branch, not a guess dressed up as verified.
 *
 * Multiple `compensationTiers` (e.g. one per hiring region) were observed on
 * 40 of 394 real postings; every one checked kept the same `compensationType`
 * across all its tiers (a job doesn't switch from salaried to hourly by
 * region), so scanning tiers in order and returning on the first `"Salary"`
 * component found is sufficient — this classifies the posting's pay
 * structure, not a specific number.
 *
 * A `compensation` object with an empty `compensationTiers` array (210 of
 * 394 real postings — compensation genuinely not disclosed) is not a skip
 * condition, same as every other optional field here: it just leaves
 * `payType` `undefined`.
 */
function mapPayType(item: AshbyJob): Job["payType"] | undefined {
  const tiers = item.compensation?.compensationTiers ?? [];
  for (const tier of tiers) {
    for (const component of tier.components ?? []) {
      // Case-insensitive, matching this file's own discipline everywhere
      // else (`mapCommitment`, `mapLocationType` both lowercase first): all
      // 399 real postings checked (2026-08-22) do use the exact-cased
      // "Salary", so this isn't a live bug, but an exact-case comparison
      // here would be the one place in this file departing from that
      // discipline in exchange for zero real benefit.
      if (component.compensationType?.trim().toLowerCase() !== "salary") continue;
      const interval = component.interval?.trim().toLowerCase() ?? "";
      return interval.includes("hour") ? "hourly" : "salary";
    }
  }
  return undefined;
}
