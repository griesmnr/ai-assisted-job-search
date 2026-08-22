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
   *
   * An adapter that fetches multiple upstream collections in one `search()`
   * call (e.g. one HTTP request per configured board/company/token) may
   * contribute a `SkippedRecord` for a whole failed collection, not just for
   * one unmappable posting (see ashby.ts's handling of a nonexistent board
   * name). That board-level skip is diluted into the same denominator as
   * every record-level skip from every other configured collection, so
   * `skipRate` alone won't reliably surface it in a multi-collection search
   * — `skipped[].reason` is the channel that does.
   */
  skipRate: number;
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
