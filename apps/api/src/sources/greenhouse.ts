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
// Adapter for the Greenhouse Job Board API
// (https://developers.greenhouse.io/job-board.html), one HTTP call per
// configured board token:
//
//   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true
//
// Everything below was written against real captured responses from nine
// live company boards (stripe, airbnb, figma, discord, robinhood, coinbase,
// asana, webflow, gitlab — ~1,500 postings total; two are trimmed and saved
// under __fixtures__/, the rest were used only to cross-check field
// presence before writing a single mapping, per the standing instruction
// not to repeat USAJOBS' mistake of inventing fixtures from assumptions).
// Two findings from that research drive most of the design choices here:
//
// 1. UNLIKE USAJOBS, this endpoint is per-company and unfiltered: it always
//    returns a company's *entire* board in one response (`meta.total` always
//    equals `jobs.length` in every response observed; there is no page
//    param and no server-side keyword/location query support). So
//    `search()` fetches every configured token in full and filters
//    client-side — see `itemMatchesCriteria`.
//
// 2. Greenhouse's public schema carries NO compensation data (payType) and
//    NO employment-type data (commitment) whatsoever — not as a structured
//    field, not as board-specific `metadata`, at either the list or the
//    single-job detail endpoint. This was verified, not assumed: every job
//    object's key set was inspected across all nine boards, and every
//    board's custom `metadata` question names were enumerated (things like
//    "Cost Center", "Careers Page: Team", internal recruiting-ops fields —
//    never pay or employment type). A minority of postings do state a pay
//    figure as free-form prose inside `content` (state pay-transparency
//    disclosures), but that is not a reliable, unambiguous, machine-parsable
//    signal the way USAJOBS' `RateIntervalCode` is — phrasing varies
//    per-company, may be an "On Target Earnings" figure (base + variable,
//    not a clean salary), and false-positives are easy (one real posting's
//    prose mentions a "Compensation team" with no pay figure attached at
//    all). Parsing prose to force a closed-enum answer is exactly the kind
//    of guess that made the USAJOBS adapter map zero real jobs while its
//    tests stayed green — so this adapter never does it. `mapPayType` and
//    `mapCommitment` always return `undefined`, and every real record ends
//    up in `skipped` as a result. That is not a coding gap — it is the
//    accurate, verified shape of what this API offers. See this file's
//    test suite for the actual skip rate against real data, and the
//    implementation ticket's final report for the recommendation this
//    implies for `Job`'s schema.
//
// `locationType` fares slightly better: one of the nine boards (Airbnb)
// asks a custom metadata question named exactly "Workplace Type" with
// answers "Remote" / "Hybrid" / "Onsite" — see `mapLocationType`. This is
// not part of Greenhouse's standard schema (the other eight boards checked
// have no such field, under any name), so it is applied opportunistically
// and does not rescue the overall skip rate on its own, since payType and
// commitment are unconditionally unmappable regardless.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://boards-api.greenhouse.io/v1/boards";
const DEFAULT_TIMEOUT_MS = 15_000;

export type GreenhouseConfig = {
  /** One board token per company, e.g. `["stripe", "airbnb"]`. Each is
   * fetched as its own HTTP request; `search()` merges the results. */
  boardTokens: string[];
  /** Override for testing; defaults to the real Greenhouse Job Board API
   * host (`https://boards-api.greenhouse.io/v1/boards`). A per-token
   * request is built as `${baseUrl}/${token}/jobs?content=true`. */
  baseUrl?: string;
  /** Override for testing; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

/**
 * Reads the configured board tokens from the environment. Throws
 * synchronously if none are configured — a startup misconfiguration, not
 * something a caller should retry, so it is a plain `Error`, not a
 * `SourceError`. Greenhouse's public Job Board API needs no credentials, so
 * unlike `createUsajobsSourceFromEnv` there is no key/secret to read.
 */
export function createGreenhouseSourceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GreenhouseSource {
  const raw = env.GREENHOUSE_BOARD_TOKENS;
  const boardTokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (boardTokens.length === 0) {
    throw new Error(
      'GREENHOUSE_BOARD_TOKENS must be set to a comma-separated list of Greenhouse board tokens (e.g. "stripe,airbnb").',
    );
  }
  return new GreenhouseSource({ boardTokens });
}

export class GreenhouseSource implements JobSource {
  readonly dataSource = "greenhouse" as const;

  readonly #boardTokens: string[];
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;

  constructor(config: GreenhouseConfig) {
    if (config.boardTokens.length === 0) {
      throw new Error("GreenhouseSource requires at least one board token.");
    }
    this.#boardTokens = config.boardTokens;
    this.#baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetchImpl = config.fetchImpl ?? fetch;
    this.#requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(criteria: SearchCriteria): Promise<SourceSearchResult> {
    const jobs: NormalizedJob[] = [];
    const skipped: SkippedRecord[] = [];

    // Sequential, not Promise.all: keeps this well-behaved against an
    // unauthenticated public API shared by every Greenhouse consumer (no
    // per-key rate limit to spend in parallel), and keeps a 429/5xx on one
    // token from firing a burst of simultaneous requests at the others.
    for (const token of this.#boardTokens) {
      let data: GreenhouseBoardResponse;
      try {
        data = await this.#fetchBoard(token);
      } catch (err) {
        // A 404 here means *this specific board token* doesn't exist
        // (typo, renamed company, board taken down) — it is a property of
        // the token, not of the Greenhouse API as a whole, and it will
        // return the identical 404 on every future request (permanent,
        // matching UnexpectedStatusError's non-retryable default). Unlike
        // a 429/5xx/network failure — which likely affects every token
        // equally and is a reason to stop and surface the error — one bad
        // token among many configured ones shouldn't discard the jobs
        // already collected from the healthy boards. So: skip this token
        // and keep going, rather than aborting the whole search().
        if (err instanceof UnexpectedStatusError && err.status === 404) {
          continue;
        }
        throw err;
      }

      for (const item of data.jobs) {
        if (!itemMatchesCriteria(item, criteria)) continue;
        const result = normalizeItem(item);
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

  async #fetchBoard(token: string): Promise<GreenhouseBoardResponse> {
    const url = new URL(`${this.#baseUrl}/${encodeURIComponent(token)}/jobs`);
    // Without `content=true` the response omits the job description
    // entirely — every record would then fail normalization on "missing
    // content", the same failure mode USAJOBS hit by omitting Fields=Full.
    url.searchParams.set("content", "true");

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
          `Greenhouse request for board "${token}" timed out after ${this.#requestTimeoutMs}ms`,
          { cause: err },
        );
      }
      throw new TransientSourceError(
        `Greenhouse request for board "${token}" failed (network error)`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    return parseResponse(response, token);
  }
}

async function parseResponse(response: Response, token: string): Promise<GreenhouseBoardResponse> {
  if (response.status === 404) {
    throw new UnexpectedStatusError(
      `Greenhouse board "${token}" does not exist (HTTP 404) — check the board token`,
      404,
    );
  }
  if (response.status === 401) {
    // Not observed against the real API in testing (it takes no
    // credentials), but classified for completeness in case Greenhouse
    // ever fronts this endpoint with an auth requirement.
    throw new AuthFailedError(`Greenhouse rejected the request for board "${token}" (HTTP 401)`);
  }
  if (response.status === 403) {
    // Also not observed in testing. Kept distinct from AuthFailedError and
    // defaulting to retryable per ForbiddenError's contract, since a 403
    // here is more likely a transient edge/WAF block than Greenhouse
    // itself rejecting an unauthenticated, public request.
    throw new ForbiddenError(`Request for Greenhouse board "${token}" was blocked with HTTP 403`);
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw new RateLimitedError(
      `Greenhouse rate limit exceeded (HTTP 429) fetching board "${token}"`,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    throw new TransientSourceError(
      `Greenhouse server error (HTTP ${response.status}) fetching board "${token}"`,
    );
  }
  if (!response.ok) {
    throw new UnexpectedStatusError(
      `Greenhouse returned unexpected HTTP status ${response.status} for board "${token}"`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new MalformedResponseError(
      `Greenhouse response for board "${token}" was not valid JSON`,
      { cause: err },
    );
  }

  return parseBoardResponseShape(body, token);
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
// Greenhouse response shape — only the fields this adapter reads. Verified
// against real captured responses; see this file's top-of-file comment.
// ---------------------------------------------------------------------------

type GreenhouseMetadataEntry = {
  name?: string;
  value?: unknown;
  value_type?: string;
};

type GreenhouseJob = {
  id?: number;
  title?: string;
  company_name?: string;
  absolute_url?: string;
  /**
   * HTML, but double entity-encoded: Greenhouse entity-encodes the *entire*
   * HTML string for JSON transport (so real markup like `<div>` arrives as
   * the literal text `&lt;div&gt;`), on top of the standard HTML entities
   * already present in that markup (`&amp;`, `&nbsp;`, ...) — e.g. a
   * non-breaking space inside the original HTML round-trips as the literal
   * text `&amp;nbsp;`. Confirmed on every board checked. See
   * `htmlToPlainText`.
   */
  content?: string;
  location?: { name?: string };
  first_published?: string;
  metadata?: GreenhouseMetadataEntry[] | null;
};

type GreenhouseBoardResponse = {
  jobs: GreenhouseJob[];
};

function parseBoardResponseShape(body: unknown, token: string): GreenhouseBoardResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("jobs" in body) ||
    !Array.isArray((body as Record<string, unknown>).jobs)
  ) {
    throw new MalformedResponseError(
      `Greenhouse response for board "${token}" did not match the expected shape (missing "jobs" array)`,
    );
  }
  return body as GreenhouseBoardResponse;
}

// ---------------------------------------------------------------------------
// Client-side filtering — Greenhouse's board endpoint has no server-side
// search; it always returns the company's entire board (`meta.total` always
// equals `jobs.length` in every response observed — there is no pagination
// either). `SearchCriteria` is applied here instead, against the raw item,
// before normalization.
// ---------------------------------------------------------------------------

function itemMatchesCriteria(item: GreenhouseJob, criteria: SearchCriteria): boolean {
  if (criteria.keyword) {
    const keyword = criteria.keyword.toLowerCase();
    const title = item.title?.toLowerCase() ?? "";
    const content = item.content?.toLowerCase() ?? "";
    if (!title.includes(keyword) && !content.includes(keyword)) return false;
  }
  if (criteria.location) {
    const location = criteria.location.toLowerCase();
    const itemLocation = item.location?.name?.toLowerCase() ?? "";
    if (!itemLocation.includes(location)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-record normalization
// ---------------------------------------------------------------------------

type NormalizeResult =
  { ok: true; job: NormalizedJob } | { ok: false; externalId: string | undefined; reason: string };

function normalizeItem(item: GreenhouseJob): NormalizeResult {
  // Greenhouse's `id` is the identifier the platform itself uses to
  // address a specific posting — it appears in the job's canonical
  // `absolute_url` (as `?gh_jid={id}` on most boards) and is what the
  // single-job detail endpoint
  // (`/v1/boards/{token}/jobs/{id}`) keys on. It is stable across repeated
  // fetches of the same still-open posting (verified by re-requesting the
  // same job by id in separate calls during development — see this
  // ticket's report for the exact commands run). It is *not*
  // `requisition_id`: that is a company-assigned req number
  // (e.g. "R-107329", or literally "See Opening ID" on some Stripe
  // postings, or "ONE" reused across unrelated Airbnb postings in the real
  // fixture) — human-chosen, frequently duplicated across postings, and
  // sometimes not even a real identifier. `internal_job_id` is a
  // Greenhouse-internal id not exposed anywhere in the public-facing URL or
  // documented as durable, so `id` is preferred as the one Greenhouse's own
  // linking scheme treats as the durable, public identifier for a posting.
  const externalId = item.id !== undefined && item.id !== null ? String(item.id) : undefined;
  if (!externalId) {
    return { ok: false, externalId: undefined, reason: "missing id" };
  }

  const title = item.title;
  if (!title) {
    return { ok: false, externalId, reason: "missing title" };
  }

  const company = item.company_name;
  if (!company) {
    return { ok: false, externalId, reason: "missing company_name" };
  }

  const linkToApply = item.absolute_url;
  if (!linkToApply) {
    return { ok: false, externalId, reason: "missing absolute_url" };
  }

  const rawContent = item.content;
  if (!rawContent) {
    return { ok: false, externalId, reason: "missing content" };
  }
  const description = htmlToPlainText(rawContent);
  if (!description) {
    return {
      ok: false,
      externalId,
      reason: "content produced no text after stripping HTML markup",
    };
  }

  const postedAtRaw = item.first_published;
  if (!postedAtRaw) {
    return { ok: false, externalId, reason: "missing first_published" };
  }
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) {
    return { ok: false, externalId, reason: `unparseable first_published date "${postedAtRaw}"` };
  }

  const location = item.location?.name?.trim() || undefined;

  const payType = mapPayType(item);
  const commitment = mapCommitment(item);
  const locationType = mapLocationType(item);

  // Collect *every* unmappable enum into one reason rather than stopping at
  // the first (as USAJOBS' normalizeItem does) — given how consistently
  // payType/commitment are absent here, a single "cannot determine
  // payType" reason on every skipped record would bury whether commitment
  // and locationType were also unmappable, which matters for diagnosing
  // whether the skip rate is a bug or (as verified here) the honest shape
  // of Greenhouse's data.
  const enumFailures: string[] = [];
  if (!payType) enumFailures.push("payType (Greenhouse exposes no compensation data)");
  if (!commitment) enumFailures.push("commitment (Greenhouse exposes no employment-type data)");
  if (!locationType) {
    enumFailures.push(
      'locationType (no "Workplace Type" metadata question on this board, or an unrecognized answer)',
    );
  }
  if (enumFailures.length > 0 || !payType || !commitment || !locationType) {
    // The `enumFailures.length > 0` check above is what actually decides
    // this branch; the three `!payType`/`!commitment`/`!locationType`
    // clauses are redundant at runtime (they can only be true when
    // `enumFailures` is already non-empty) but are what lets TypeScript
    // narrow all three from `X | undefined` to `X` below — the two arrays
    // (`enumFailures` and these three variables) aren't visibly correlated
    // to the type checker otherwise.
    return { ok: false, externalId, reason: `cannot determine ${enumFailures.join("; ")}` };
  }

  return {
    ok: true,
    job: {
      externalId,
      dataSource: "greenhouse",
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
 * Always `undefined`. Greenhouse's public Job Board API carries no
 * compensation field, structured or otherwise — verified against real
 * responses from nine boards (~1,500 postings): no job object at the list
 * or single-job detail endpoint has a pay/salary/wage/compensation field,
 * and no board's custom `metadata` questions encode it either. Some
 * postings state a figure in `content` as prose (pay-transparency
 * disclosures), but parsing that would be guessing at a closed enum from
 * free text with no consistent format across companies — exactly what this
 * project's post-mortem on the USAJOBS adapter says not to do. Kept as a
 * named function (rather than inlined `undefined`) so this reasoning has
 * one obvious place to live, and so a future change only has to edit here.
 */
function mapPayType(_item: GreenhouseJob): Job["payType"] | undefined {
  return undefined;
}

/**
 * Always `undefined`, for the same reason as `mapPayType`: no board
 * exposes an employment-type (full-time/part-time/contract) field under
 * any name, structured or metadata. `content` prose occasionally uses the
 * word "full-time" in passing (e.g. inside a pay-disclosure sentence like
 * "the OTE for this full-time position is..."), but that is not a
 * dedicated field and is not reliably present or absent — not a basis for
 * a closed-enum answer.
 */
function mapCommitment(_item: GreenhouseJob): Job["commitment"] | undefined {
  return undefined;
}

/**
 * Greenhouse has no first-class remote/onsite/hybrid field — `location` is
 * free text (e.g. "SF, NYC, SEA, CHI"). One real board (Airbnb) asks a
 * custom metadata question named exactly "Workplace Type" with answers
 * "Remote" / "Hybrid" / "Onsite" (verified against a real captured
 * response, `__fixtures__/greenhouse-real-response-airbnb.json`). That is
 * not part of Greenhouse's standard schema — it's a per-company custom
 * field the other eight boards checked (Stripe, Figma, Discord, Robinhood,
 * Coinbase, Asana, Webflow, GitLab) do not have under any name — so this
 * only ever maps a fraction of postings, opportunistically, for companies
 * that happen to ask this exact question with these exact answers.
 * Matching is case-insensitive and tolerates "on-site"/"on site" spacing;
 * anything else (a differently-named metadata question, a free-text
 * answer, or no metadata at all) falls through to `undefined`.
 */
function mapLocationType(item: GreenhouseJob): Job["locationType"] | undefined {
  const entry = item.metadata?.find(
    (m) => typeof m.name === "string" && m.name.trim().toLowerCase() === "workplace type",
  );
  if (!entry || typeof entry.value !== "string") return undefined;

  const value = entry.value.trim().toLowerCase();
  if (value === "remote") return "remote";
  if (value === "hybrid") return "hybrid";
  if (value === "onsite" || value === "on-site" || value === "on site") return "onsite";
  return undefined;
}

// ---------------------------------------------------------------------------
// HTML handling for `content` -> `description`.
//
// Decision: decode + strip down to plain text, rather than storing the raw
// (doubly entity-encoded) HTML as-is. Two reasons:
//
//   1. Storing it as-is would be actively broken, not just messy: any
//      consumer that renders `description` as plain text (logs, a plain
//      <textarea>, an LLM prompt for matching against a resume) would show
//      the user literal "&lt;div&gt;...&lt;/div&gt;" markup, because the
//      encoding is two layers deep (see `GreenhouseJob.content`'s doc
//      comment) — it isn't even valid HTML to hand to an HTML renderer
//      without a decode step first.
//   2. Every other source's `description` (USAJOBS' JobSummary) is plain
//      text. Keeping that consistent across `JobSource` implementations
//      matters here specifically because `description` is meant to feed
//      resume/job matching (see `JobMatch` in packages/shared) — a matcher
//      built against plain USAJOBS summaries shouldn't have to also handle
//      raw HTML tags competing for token budget/embedding space only for
//      Greenhouse postings.
//
// This is a lightweight regex-based decode+strip, not a full HTML parser
// (no such dependency is present in this workspace, and job-board HTML is
// simple markup — headings/paragraphs/lists — not a case that needs one).
// It preserves paragraph/list-item breaks as newlines so the result reads
// as text, not a single run-on line.
// ---------------------------------------------------------------------------

const BLOCK_BOUNDARY_TAGS = /<\/(?:p|div|li|ul|ol|h[1-6])\s*>|<br\s*\/?>/gi;
const ANY_TAG = /<[^>]*>/g;
const NUMERIC_DEC_ENTITY = /&#(\d+);/g;
const NUMERIC_HEX_ENTITY = /&#x([0-9a-fA-F]+);/g;

/** Decodes one layer of HTML entity encoding. `&amp;` is handled last so it
 * doesn't re-trigger the other replacements (standard unescape ordering —
 * avoids turning an intentional literal `&amp;lt;` into `<` instead of the
 * literal text `&lt;` it represents). */
function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(NUMERIC_DEC_ENTITY, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(NUMERIC_HEX_ENTITY, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

/**
 * Exported (unlike USAJOBS' private mapping helpers) specifically so it can
 * be unit-tested directly against real fixture content: no real Greenhouse
 * record has ever made it through `normalizeItem` to a `NormalizedJob`
 * (see this file's top-of-file comment), so `description` is otherwise
 * unobservable from `search()`'s output — there is no other way to prove
 * this function does what it claims against real data.
 */
export function htmlToPlainText(raw: string): string {
  // Layer 1: undo Greenhouse's whole-string entity-encoding to recover the
  // real HTML markup (`&lt;div&gt;` -> `<div>`).
  const html = decodeHtmlEntities(raw);
  // Turn block-level boundaries into line breaks before stripping tags, so
  // paragraphs/list items don't get smashed into one continuous line.
  const withBreaks = html.replace(BLOCK_BOUNDARY_TAGS, "\n");
  const stripped = withBreaks.replace(ANY_TAG, "");
  // Layer 2: the markup's own ordinary HTML entities (`&amp;`, `&nbsp;`,
  // ...) are still literal text at this point — decode them into the
  // actual characters they represent.
  const plainText = decodeHtmlEntities(stripped);

  return plainText
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}
