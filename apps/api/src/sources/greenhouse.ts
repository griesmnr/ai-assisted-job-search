import type { Job } from "@app/shared";
import { htmlToPlainText as sharedHtmlToPlainText } from "./html.js";
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
  type TokenOutcome,
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
//    tests stayed green — so this adapter never does it: `mapPayType` and
//    `mapCommitment` always return `undefined`.
//
//    That used to mean every real record ended up in `skipped`, back when
//    `payType`/`commitment`/`locationType` were required fields on `Job`
//    and an absent enum was treated as a normalization failure. The project
//    owner has since made those three fields optional on `Job` (see
//    packages/shared/src/index.ts) specifically because of this finding —
//    "not stated" is the honest representation of a posting that doesn't
//    state it, and requiring a guess would mean either inventing data or
//    dropping this source entirely. So absence of payType/commitment is no
//    longer a skip condition: it just means those fields come back
//    `undefined` on an otherwise normally-returned job. See this file's
//    test suite for the measured skip rate against real data (0.0 for both
//    captured fixtures) and the implementation ticket's final report for
//    the full history of that decision.
//
// `locationType` fares slightly better: one of the nine boards (Airbnb)
// asks a custom metadata question named exactly "Workplace Type" with
// answers "Remote" / "Hybrid" / "Onsite" — see `mapLocationType`. This is
// not part of Greenhouse's standard schema (the other eight boards checked
// have no such field, under any name), so it is applied opportunistically
// and, like payType/commitment, its absence elsewhere is not a skip
// condition either — it simply leaves `locationType` undefined for boards
// that don't ask an equivalent question.
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
    const total = this.#boardTokens.length;
    // Indexed, not pushed-to: workers below complete in COMPLETION order,
    // not the original board-token order (that's the whole point of
    // concurrency). Writing each outcome to its origin index and filtering
    // at the end (below) restores the original `this.#boardTokens` order
    // in the returned `tokenOutcomes` regardless of which token's fetch
    // happened to resolve first -- preserving the exact ordered-output
    // contract every existing caller/test already depends on.
    const tokenOutcomesByIndex: (TokenOutcome | undefined)[] = new Array(total);

    // ---------------------------------------------------------------------
    // Per-error-kind isolation policy (ticket b723fb9, review round 2),
    // now run through a bounded-concurrency pool (ticket b681d18) instead
    // of strictly one request at a time. Nicole, told the real tradeoff
    // (meaningfully faster against real measured 5-8s/board timings on the
    // 25-token list, small increase in rate-limit risk vs. hammering a
    // shared unauthenticated public API): "yes, moderate parallelism
    // (~5 at once)". CONCURRENCY below is that choice, not a full
    // Promise.all across all 25 -- that full-parallel shape was the one
    // explicitly rejected.
    //
    // Four outcomes for a single token's fetch, each handled differently:
    //
    //   - 404 (UnexpectedStatusError, status 404): ISOLATED, worker moves
    //     to the next queued token. A property of the token (typo, renamed
    //     company, never existed) — permanent, will 404 identically
    //     forever. No reason to let it discard jobs already collected from
    //     healthy boards.
    //
    //   - TransientSourceError (timeout, network failure, 5xx): ISOLATED,
    //     worker moves on. A property of THIS request, not the whole
    //     batch — real captured timings on the widened 25-token list
    //     showed boards taking 5-8 real seconds against a 15s timeout, so
    //     a single slow/flaky board is a meaningfully more likely event at
    //     25 tokens than it was at 4. A retry of the exact same request
    //     may well succeed.
    //
    //   - ForbiddenError (403): ISOLATED, worker moves on. Per this file's
    //     own `parseResponse` doc comment and `ForbiddenError`'s doc
    //     comment in types.ts, a 403 here is treated as a transient
    //     edge/WAF block ("not reliably permanent... a WAF rule or
    //     fingerprint can change request-to-request"), not a systemic
    //     rejection.
    //
    //   - RateLimitedError (429): ISOLATED for the token itself, but ALSO
    //     sets a shared `rateLimitedBy` flag that every worker checks
    //     before claiming its NEXT token — no worker starts a NEW request
    //     once any worker has seen a 429. This is the one behavior that
    //     genuinely changes shape under concurrency: with CONCURRENCY
    //     workers already in flight when a 429 lands, up to
    //     CONCURRENCY - 1 OTHER requests may already be running and are
    //     allowed to complete naturally (their real per-token outcomes are
    //     genuine information, not discarded) — this can never have been
    //     true of the old strictly-sequential version, where a 429 was
    //     detected before any later request had been issued at all. What's
    //     preserved exactly: no request is ever issued for a token that
    //     hadn't already been claimed by a worker at the moment the 429
    //     was observed, and everything collected before that point is
    //     still returned, never thrown away.
    //
    //   - AuthFailedError (401), MalformedResponseError, any other
    //     UnexpectedStatusError (e.g. 400): ABORT — the whole search()
    //     eventually rejects. Under concurrency this can no longer happen
    //     the INSTANT the error is seen (other in-flight workers finish
    //     their own current request first — there is no cheap way to
    //     cancel an in-flight `fetch` without also risking discarding a
    //     response that was about to succeed), but the end state is
    //     identical: once every worker has stopped, if any worker ever hit
    //     one of these three, search() throws that error and nothing from
    //     this call is returned, exactly as before.
    // ---------------------------------------------------------------------
    const CONCURRENCY = 5;
    let nextIndex = 0;
    let rateLimitedBy: string | undefined;
    let abortError: unknown;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (rateLimitedBy !== undefined || abortError !== undefined) return;
        const i = nextIndex;
        if (i >= total) return;
        // Claim happens synchronously, before any `await` below — no two
        // workers can ever claim the same index, regardless of how many
        // run concurrently.
        nextIndex = i + 1;
        const token = this.#boardTokens[i]!;

        let data: GreenhouseBoardResponse;
        try {
          data = await this.#fetchBoard(token);
        } catch (err) {
          if (err instanceof UnexpectedStatusError && err.status === 404) {
            tokenOutcomesByIndex[i] = {
              token,
              status: "not-found",
              postingCount: 0,
              companyName: undefined,
              message: undefined,
              skippedCount: 0,
            };
            continue;
          }
          if (err instanceof TransientSourceError || err instanceof ForbiddenError) {
            tokenOutcomesByIndex[i] = {
              token,
              status: "error",
              postingCount: 0,
              companyName: undefined,
              message: err.message,
              skippedCount: 0,
            };
            continue;
          }
          if (err instanceof RateLimitedError) {
            tokenOutcomesByIndex[i] = {
              token,
              status: "error",
              postingCount: 0,
              companyName: undefined,
              message:
                err.retryAfterMs !== undefined
                  ? `${err.message} (retry after ${err.retryAfterMs}ms)`
                  : err.message,
              skippedCount: 0,
            };
            rateLimitedBy ??= token;
            continue;
          }
          // AuthFailedError, MalformedResponseError, or an unmapped
          // UnexpectedStatusError -- abort-worthy. Record which error wins
          // (first one observed) and stop this worker; other in-flight
          // workers will stop claiming new work on their next iteration.
          abortError ??= err;
          return;
        }

        let tokenSkippedCount = 0;
        for (const item of data.jobs) {
          if (!itemMatchesCriteria(item, criteria)) continue;
          const result = normalizeItem(item);
          if (result.ok) {
            jobs.push(result.job);
          } else {
            skipped.push({ externalId: result.externalId, reason: result.reason });
            tokenSkippedCount++;
          }
        }

        // Recorded before criteria filtering: `postingCount` (and the
        // "empty" vs "ok" status it drives) describes the board itself,
        // not what a particular search narrowed it down to — see the doc
        // comment on `TokenOutcome`. `companyName` is read off the FIRST
        // raw record only — see the WARNING on `TokenOutcome.companyName`
        // for why a caller must not treat this as a stable per-token key.
        tokenOutcomesByIndex[i] = {
          token,
          status: data.jobs.length === 0 ? "empty" : "ok",
          postingCount: data.jobs.length,
          companyName: data.jobs[0]?.company_name,
          message: undefined,
          skippedCount: tokenSkippedCount,
        };
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()));

    if (abortError !== undefined) throw abortError;

    if (rateLimitedBy !== undefined) {
      // Every index a worker never got to claim before the flag was set.
      // Recorded individually (not as one aggregate outcome) so
      // `describeBoardOutcome` can render each one's line the same way it
      // renders every other token.
      for (let i = 0; i < total; i++) {
        if (tokenOutcomesByIndex[i] !== undefined) continue;
        tokenOutcomesByIndex[i] = {
          token: this.#boardTokens[i]!,
          status: "error",
          postingCount: 0,
          companyName: undefined,
          message: `not checked — search() stopped issuing requests after board "${rateLimitedBy}" was rate-limited (HTTP 429)`,
          skippedCount: 0,
        };
      }
    }

    const tokenOutcomes = tokenOutcomesByIndex.filter((o): o is TokenOutcome => o !== undefined);

    const totalRecords = jobs.length + skipped.length;
    const skipRate = totalRecords === 0 ? 0 : skipped.length / totalRecords;

    return { jobs, skipped, skipRate, tokenOutcomes };
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

  // payType and commitment are optional on `Job` as of the decision recorded
  // in packages/shared: Greenhouse's board API carries neither for any
  // posting, and "not stated" is the honest representation of a posting that
  // doesn't state it. Absence is no longer a reason to skip a record — it
  // just means the field comes back undefined.
  //
  // locationType is optional too, for the same reason — most Greenhouse
  // boards ask no equivalent of Airbnb's custom "Workplace Type" question.
  // No enum is a skip condition here anymore; a record only fails
  // normalization if something structural is wrong (missing id, unparseable
  // date), which is what `skipped` should mean.

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
// The actual decode+strip pipeline lives in ./html.ts, shared with
// lever.ts (which needs the same tag-stripping for `lists[].content`, but
// with `doubleEncoded: false` — see that file's doc comment for why the two
// sources need different pipelines, not just different call sites).
// ---------------------------------------------------------------------------

/**
 * Exported (unlike USAJOBS' private mapping helpers) specifically so it can
 * be unit-tested directly against real fixture content, independent of
 * whatever `normalizeItem` does with `payType`/`commitment`/`locationType` —
 * decoupling this test from the mapping decisions that live elsewhere in
 * this file keeps it stable regardless of which fields `Job` requires. Thin
 * wrapper over the shared `htmlToPlainText` fixing `doubleEncoded: true`,
 * Greenhouse's real (verified) encoding.
 */
export function htmlToPlainText(raw: string): string {
  return sharedHtmlToPlainText(raw, { doubleEncoded: true });
}
