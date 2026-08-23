import type { Job } from "@app/shared";

/**
 * Everything a source contributes about a job, minus the database primary
 * key. `id` is assigned when a row is inserted (see RTK-08, the ingestion
 * worker, which is out of scope for this ticket) — a source adapter has no
 * business minting that. `dataSource` + `externalId` is the natural key a
 * source cares about, and it's exactly what backs the Postgres UNIQUE
 * constraint that makes ingestion idempotent
 * (apps/api/src/db/schema.ts: `unique().on(table.dataSource, table.externalId)`).
 */
export type NormalizedJob = Omit<Job, "id">;

/** Search inputs common to every source. Add fields here, not per-adapter,
 * so every adapter keeps taking the same shape. */
export type SearchCriteria = {
  keyword?: string;
  location?: string;
};

/**
 * A record the source returned that could not be safely normalized —
 * typically because one of Job's closed enums (`payType`, `commitment`,
 * `locationType`) has no unambiguous mapping from the source's value.
 * We surface these instead of guessing (ticket 831afc0); the caller
 * decides whether to log, alert, or drop them.
 */
export type SkippedRecord = {
  /** undefined only when the source record was too malformed to even
   * extract an id from. */
  externalId: string | undefined;
  reason: string;
};

export type SourceSearchResult = {
  jobs: NormalizedJob[];
  skipped: SkippedRecord[];
  /**
   * `skipped.length / (jobs.length + skipped.length)`, or `0` when the
   * source matched nothing at all. Exists so "found nothing" (a legitimate
   * empty search) can't be confused with "found things but couldn't map any
   * of them" (a mapper bug or an upstream schema change) — both otherwise
   * present to a caller as `jobs: []`. A worker should treat a high
   * `skipRate` on a non-empty result as a signal to alert, not just log.
   */
  skipRate: number;
  /**
   * Populated by sources that shard a single `search()` call into one HTTP
   * request per employer "token" (Greenhouse today, one request per board
   * token — see `GreenhouseSource`; the Ashby and SmartRecruiters adapters
   * in flight follow the same one-request-per-employer shape). Absent
   * (`undefined`) for sources that don't have this concept, e.g. USAJOBS'
   * single paginated query — callers must treat a missing/empty array as
   * "no per-token breakdown available", not as "zero employers configured".
   *
   * Exists for ticket b723fb9: without it, three genuinely different
   * outcomes are indistinguishable from a caller's point of view —
   *   - a configured token that doesn't resolve to a real board (404)
   *   - a real board with zero open postings right now
   *   - a real board with postings, none of which survived a caller's own
   *     filtering
   * — and a user staring at an empty result list has no way to tell a
   * broken config from a quiet market from a shortlist that's simply
   * strict. See `TokenOutcome`.
   */
  tokenOutcomes?: TokenOutcome[];
};

/** One employer/token's outcome within a sharded `search()` call. See
 * `SourceSearchResult.tokenOutcomes`. */
export type TokenStatus =
  /** The token itself does not resolve (e.g. HTTP 404) — a configuration
   * problem (typo, renamed/departed employer, wrong ATS guess), not a
   * signal about the job market. */
  | "not-found"
  /** The token resolves to a real board; it currently has zero postings. */
  | "empty"
  /** The token resolves to a real board with at least one posting. Says
   * nothing about whether any posting survives a caller's own filtering —
   * that is what `postingCount` (raw, pre-filter) is for; a caller that
   * also tracks post-filter survivors is expected to report the two
   * numbers side by side. */
  | "ok"
  /** The fetch for this token failed for a reason that is NOT "the token
   * doesn't exist" — a timeout, a network error, a 5xx, a per-request WAF
   * block (403), a rate limit (429), or — for a token `search()` never
   * got around to attempting because an earlier 429 stopped it from
   * issuing further requests this run — "not checked" (see `message`).
   * Distinct from "not-found": this token may well be a real, healthy
   * board; this run just couldn't confirm that. See
   * `GreenhouseSource#search`'s per-error-kind isolation policy for which
   * failures land here vs. abort the whole `search()` call. */
  | "error";

export type TokenOutcome = {
  /** The token/slug as configured — e.g. a Greenhouse board token. */
  token: string;
  status: TokenStatus;
  /** Raw posting count for this token, before any `SearchCriteria` or
   * caller-side `filter` narrowing. Always `0` for "not-found", "empty",
   * and "error". */
  postingCount: number;
  /**
   * The employer's own display name, as self-reported by the FIRST
   * posting in this token's response, when available. `undefined` for
   * "not-found" and "error" (nothing was successfully fetched) and
   * possible for "empty" (nothing to read a name from).
   *
   * WARNING, from ticket b723fb9's review: this is free text an employer
   * typed into a form field, not a stable key, and a caller that
   * correlates post-filter survivors back to a token by matching this
   * name against `NormalizedJob.company` (as `buildBoardCoverage` in
   * demo-match.ts does) can silently misattribute:
   *   - two different tokens can self-report the identical name (a
   *     double-count: both entries claim the same survivors)
   *   - the FIRST posting's name can differ from the name on the
   *     postings that actually matched (a board with mixed casing/legal-
   *     entity-suffix listings, e.g. "Acme" vs "Acme, Inc.") — the
   *     correlation then silently drops those survivors to zero
   *   - `undefined` here (missing `company_name` on the first item) drops
   *     every one of that token's survivors to zero, even if all of them
   *     have a `company` set
   * None of this fires against the 25 tokens configured today (verified:
   * `sum(survivedFilter) === filtered.length` holds), but it is a latent
   * hazard, not a guarantee — `buildBoardCoverage` asserts that invariant
   * at runtime and warns rather than trusting the correlation silently.
   */
  companyName: string | undefined;
  /** Present only when `status` is `"error"` — the underlying failure's
   * message, for a human deciding whether to retry. `undefined` for every
   * other status. */
  message: string | undefined;
  /**
   * How many of THIS token's own raw postings failed normalization and
   * landed in `SourceSearchResult.skipped`. Always `0` for "not-found",
   * "empty", and "error" (nothing was normalized).
   *
   * Exists because `SourceSearchResult.skipRate` is aggregated across
   * every configured token: at 4 boards, one board that failed to
   * normalize entirely gave a skipRate of ~0.25 — well above any sane
   * alert threshold. At 25 boards the identical single-board failure
   * dilutes to ~0.04, which reads as healthy. Widening the token list
   * (this ticket) makes that dilution worse, not better, so a per-token
   * count is what preserves the original signal `skipRate` exists for.
   */
  skippedCount: number;
};

/**
 * The interface every job source implements. This is the reference shape —
 * the next adapter (Washington State) should be able to satisfy it with the
 * same structure as `UsajobsSource`: a small config object (secrets +
 * optional overrides for testing), a `dataSource` tag matching
 * `Job["dataSource"]`, and a `search` method that fully paginates internally
 * and returns everything it found in one result.
 */
export interface JobSource {
  readonly dataSource: Job["dataSource"];
  search(criteria: SearchCriteria): Promise<SourceSearchResult>;
}

// ---------------------------------------------------------------------------
// Typed errors
//
// A caller (the ingestion worker) needs to make a retry decision from the
// error's *type*, not by pattern-matching a message string. Every subclass
// fixes its own `kind` and `retryable`, so callers can branch on whichever
// they prefer:
//
//   if (err instanceof RateLimitedError) { ... }
//   if (err instanceof SourceError && err.retryable) { ... }
// ---------------------------------------------------------------------------

export type SourceErrorKind =
  | "rate-limited"
  | "auth-failed"
  | "forbidden"
  | "transient"
  | "malformed-response"
  | "unexpected-status";

export abstract class SourceError extends Error {
  abstract readonly kind: SourceErrorKind;
  abstract readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** The source is throttling us (HTTP 429). Retry later — ideally after
 * `retryAfterMs` if the source told us how long to wait. */
export class RateLimitedError extends SourceError {
  readonly kind = "rate-limited";
  readonly retryable = true;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

/** The source told us, in a response it authenticated as its own (JSON body,
 * not a WAF page), that our credentials are invalid (HTTP 401). Retrying the
 * same request will never succeed — this needs a human to fix the API key or
 * user agent, not a retry loop. */
export class AuthFailedError extends SourceError {
  readonly kind = "auth-failed";
  readonly retryable = false;
}

/** HTTP 403. Deliberately *not* folded into `AuthFailedError`: for USAJOBS
 * specifically, 403 is what you get from Akamai (the WAF in front of the
 * real API) rejecting the request — e.g. on an unrecognized `User-Agent` —
 * and comes back as an HTML block page, not the API's own JSON error. That
 * is a different failure than the API itself telling us our key is bad, and
 * it is not reliably permanent (a WAF rule or fingerprint can change
 * request-to-request), so this defaults retryable rather than assuming it
 * will never succeed. Kept as its own kind rather than merged into
 * `transient` so a caller can alert on a run of 403s distinctly from a run
 * of 5xxs — a 403 storm usually means "fix the User-Agent format", a 5xx
 * storm means "the upstream is down". */
export class ForbiddenError extends SourceError {
  readonly kind = "forbidden";
  readonly retryable = true;
}

/** A network-level failure (timeout, DNS, connection reset) or a 5xx from
 * the source. Transient by nature — retry with backoff. */
export class TransientSourceError extends SourceError {
  readonly kind = "transient";
  readonly retryable = true;
}

/** The response came back 2xx but didn't match the shape we know how to
 * parse (bad JSON, missing expected fields). Retrying an identical request
 * will get the identical response — do not retry. */
export class MalformedResponseError extends SourceError {
  readonly kind = "malformed-response";
  readonly retryable = false;
}

/** Any non-2xx status we don't have a more specific classification for.
 * Treated as non-retryable by default since most such statuses (400, 404,
 * ...) indicate a request problem that won't fix itself on retry. */
export class UnexpectedStatusError extends SourceError {
  readonly kind = "unexpected-status";
  readonly retryable = false;
  readonly status: number;

  constructor(message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}
