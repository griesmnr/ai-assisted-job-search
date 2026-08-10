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
  "rate-limited" | "auth-failed" | "transient" | "malformed-response" | "unexpected-status";

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

/** Our credentials were rejected (HTTP 401/403). Retrying the same request
 * will never succeed — this needs a human to fix the API key or user agent,
 * not a retry loop. */
export class AuthFailedError extends SourceError {
  readonly kind = "auth-failed";
  readonly retryable = false;
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
