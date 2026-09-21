import { randomUUID } from "node:crypto";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobMatches, jobs as jobsTable, resumes, searchResults, searches } from "../db/schema.js";
import { toNormalizedJob, type JobDescriptionRow } from "../matching/pipeline.js";
import type { ScoreJobFn, ScoredJob } from "../matching/scoring.js";
import { pickRetryTier, type RetryTier, type ScoreJobMessage } from "./fetchSourceWorker.js";
import { SCORE_JOB_DLQ, SCORE_JOB_QUEUE, SCORE_JOB_RETRY_TIERS } from "../queue/topology.js";

/**
 * The score.job worker: consumes one message per job (`{ jobId: string }` -
 * `ScoreJobMessage`, defined in fetchSourceWorker.ts and reused here rather
 * than redefined, so producer and consumer can never drift on the wire
 * shape), scores it against every resume that has ever searched it up, and
 * persists the result to `job_matches` (ticket 4065511).
 *
 * THE DESIGN GAP THIS FILE EXISTS TO CLOSE: `ScoreJobMessage` carries only a
 * `jobId`, not a `resumeId` - but `job_matches` rows are keyed
 * `(resume_id, job_id)` (db/schema.ts - `unique().on(table.resumeId,
 * table.jobId)`) and scoring is inherently resume-specific. The relational
 * path from `jobId` back to the resume(s) it should be scored against is
 * `search_results.job_id -> search_results.search_id -> searches.id ->
 * searches.resume_id`. A single job can be linked to MULTIPLE searches -
 * and therefore multiple resumes - over time (two different resumes both
 * turn up the same posting; fetchSourceWorker.ts's own doc comment on its
 * score.job publish site is explicit about this: "Publish for every job
 * linked to this search... The scoring worker is responsible for not
 * double-scoring a job it's seen a score.job message for before."). So on
 * `{ jobId }`, this worker:
 *
 *   1. selects every DISTINCT `searches.resume_id` reachable from `jobId`
 *      via `search_results` (see `resolveResumeIds` below) - the query
 *      shape is `SELECT DISTINCT searches.resume_id FROM search_results
 *      JOIN searches ON search_results.search_id = searches.id WHERE
 *      search_results.job_id = $1`;
 *   2. for each such resumeId, checks whether a `job_matches` row for
 *      `(resumeId, jobId)` already exists and skips it if so - the same
 *      "don't re-pay for an already-scored pair" rule
 *      `runDemoMatch`/`getOrCreateResumeId`'s sibling logic in
 *      matching/pipeline.ts already enforces for the synchronous CLI path,
 *      just inverted: that path holds ONE resumeId and finds many jobIds
 *      needing a score; this worker holds ONE jobId and finds many
 *      resumeIds needing a score;
 *   3. scores and persists whatever's left. The `unique(resume_id, job_id)`
 *      constraint (`onConflictDoNothing` below) is the idempotency
 *      BACKSTOP for a redelivered message racing itself - not the primary
 *      mechanism, which is the already-scored check in step 2: checking
 *      first means a redelivery that already succeeded doesn't spend a
 *      real Claude call just to have the insert no-op afterward.
 *
 * RETRY/DLQ - mirrors fetchSourceWorker.ts's established shape
 * (classify-then-retry-or-DLQ, an `x-attempt` header, per-tier durable
 * queues dead-lettering back to the work queue, a `mandatory`-publish +
 * `channel.on("return", ...)` safety net for a tier queue that's gone
 * missing since startup) with one real difference this file's error surface
 * forces: A SINGLE `score.job` message can name MULTIPLE resumeIds needing
 * a score (see above), and those calls are independent - one Claude call
 * hitting a rate limit while a sibling call for a different resume
 * succeeds is a normal, expected outcome, not a whole-message failure.
 * `handleScoreJobMessage` scores every needed resumeId with
 * `Promise.allSettled`-style isolation (each resumeId's `scoreJob()` call is
 * individually try/caught inside the `Promise.all` in
 * `createScoreJobHandler` below, so one rejecting never discards a sibling's
 * fulfilled result), persists every success unconditionally, and only THEN
 * decides the message's own fate from what's left over:
 *
 *   - no failures at all (or every failure was PERMANENT - see
 *     `classifyScoringError`, e.g. a resumeId whose `resumes` row is gone)
 *     -> ack. A permanent per-resume failure is logged loudly but does not
 *     hold the message hostage: nothing about retrying the WHOLE message
 *     would fix a resume row that doesn't exist, and every resumeId that
 *     COULD be scored already was.
 *   - at least one failure was RETRYABLE (rate limit, transient network/5xx
 *     - see `classifyScoringError`) and attempts remain -> requeue the
 *     WHOLE message via a retry tier (same `pickRetryTier` fetchSourceWorker
 *     uses over `SCORE_JOB_RETRY_TIERS`, topology.ts). The already-scored
 *     check in step 2 above means a requeued attempt only re-does the
 *     resumeIds that didn't succeed last time - the successes already
 *     persisted are found already-scored and skipped, not re-billed.
 *   - at least one failure was retryable and attempts are exhausted ->
 *     dead-letter into `SCORE_JOB_DLQ`, same as fetchSourceWorker.ts.
 *
 * See `classifyScoringError` for how an Anthropic SDK error is sorted into
 * retryable vs. not, and topology.ts's `SCORE_JOB_RETRY_TIERS` doc comment
 * for why this file's backoff tier delays are chosen differently from
 * `FETCH_SOURCE_RETRY_TIERS` (short version: the Anthropic SDK already
 * retries a request internally, with its own backoff, before ever
 * rejecting into this worker - a failure reaching `classifyScoringError` at
 * all means a SUSTAINED condition survived that inner retry budget, so this
 * ladder starts at 5s, not fetch.source's 1s).
 *
 * SPEND GUARD - DELIBERATELY NOT BUILT HERE (ticket 4065511 scope, per the
 * PM): `runDemoMatch`'s synchronous CLI path caps how many jobs get scored
 * per run (`DEFAULT_SCORE_THRESHOLD`/`allowAboveThreshold`, matching/
 * scoring.ts and matching/pipeline.ts) and requires an explicit opt-in to
 * exceed it. This worker, consuming `score.job` off a queue indefinitely,
 * has NO equivalent ceiling - every message that names a resumeId needing a
 * score results in a real, billed Claude call with nothing capping how many
 * happen per unit time or in total. That is a real, open gap, not an
 * oversight this file is unaware of - it is out of this ticket's scope
 * because this worker is not wired to run against real traffic yet (see the
 * "OUT OF SCOPE" note below), but it must be resolved, or explicitly
 * accepted, before it ever is.
 *
 * NOT WIRED TO RUN (ticket 4065511 scope, per the PM): this file exports
 * `createScoreJobHandler`/`startScoreJobWorker` - the worker module and its
 * entry point - but nothing in this codebase yet calls `startScoreJobWorker`
 * from a running process (no package.json script, no docker-compose service
 * entry). `fetchSourceWorker.ts` has this identical gap today; closing it
 * for BOTH workers at once, alongside switching `routes/searches.ts` to
 * publish `fetch.source` instead of calling `runDemoMatch` synchronously, is
 * a deliberately separate, later ticket in this same epic.
 */

/** The message body didn't parse as JSON or didn't match `ScoreJobMessage`.
 * Retrying will parse it identically and fail identically - not retryable.
 * A local copy of the same shape fetchSourceWorker.ts's own
 * `InvalidMessageError` takes, not an import: keeping this worker's error
 * surface self-contained means it can be split into its own service later
 * without carrying an import from a sibling worker module along for the
 * ride. */
export class InvalidMessageError extends Error {}

/** `message.jobId` names no row in the `jobs` table. Not retryable - the
 * jobId came from a `fetch.source`-published message that (per that
 * worker's own doc comment) is only ever emitted for a job
 * `ingestJobsForSearch` just linked, so a missing row here means the job
 * was deleted out from under this message, not a timing race that a retry
 * would resolve. */
export class UnknownJobError extends Error {}

/**
 * Reads how long an Anthropic `RateLimitError` asked us to wait, from its
 * `Retry-After` response header (seconds, or an HTTP-date - same two shapes
 * `greenhouse.ts`/`lever.ts`/`ashby.ts`/`usajobs.ts`/`smartrecruiters.ts`'s
 * own `parseRetryAfter` already handles for job-board 429s; copied here
 * rather than imported for the same "small, frozen, self-contained piece"
 * reason those five files each carry their own copy instead of reaching
 * into one another). Returns `undefined` when there's no header, the header
 * doesn't parse, or `err` isn't an Anthropic API error with headers at all
 * (e.g. `InternalServerError`/`APIConnectionError` don't reliably carry a
 * useful `Retry-After`).
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  // `Number("")` and `Number("  ")` are both `0`, not `NaN` -- an empty or
  // whitespace header must not read as "wait exactly 0ms" (indistinguishable
  // from a real, deliberate 0-second Retry-After). Opus review note (ticket
  // 4065511): harmless today (0 just picks the shortest configured tier),
  // but worth guarding explicitly rather than relying on that coincidence.
  if (!header || header.trim() === "") return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function retryAfterMsFromError(err: unknown): number | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined;
  const headers = err.headers;
  if (!headers) return undefined;
  // Opus review fix (ticket 4065511): prefer `retry-after-ms` over
  // `retry-after` when both are present, matching the Anthropic SDK's own
  // internal `retryRequest` precedent (client.js) -- a non-standard but
  // more precise header the SDK proactively supports. `retry-after` (the
  // standard seconds-or-HTTP-date header) remains the fallback.
  const msHeader = headers.get("retry-after-ms");
  if (msHeader && msHeader.trim() !== "") {
    const ms = Number(msHeader);
    if (!Number.isNaN(ms)) return ms;
  }
  return parseRetryAfterMs(headers.get("retry-after"));
}

type ScoringClassification = { retryable: boolean; kind: string };

/**
 * Sorts a `scoreJob()` rejection into retryable vs. not, mirroring
 * fetchSourceWorker.ts's `classify()` in spirit (same two-bucket shape, same
 * "genuinely unanticipated errors default retryable, not assumed
 * permanent" posture for the fallback case) but built against the Anthropic
 * SDK's OWN typed exception hierarchy (`@anthropic-ai/sdk`'s `core/error.js`
 * - `APIError.generate` maps HTTP status -> class: 400 `BadRequestError`,
 * 401 `AuthenticationError`, 403 `PermissionDeniedError`, 404
 * `NotFoundError`, 409 `ConflictError`, 422 `UnprocessableEntityError`, 429
 * `RateLimitError`, everything >= 500 (including 529 "overloaded" - there is
 * no dedicated 529 class) `InternalServerError`) rather than this
 * codebase's own `SourceError` hierarchy - a Claude scoring call and a job-
 * board fetch fail through two genuinely different client libraries with
 * two genuinely different typed-error surfaces, so a shared classifier
 * would have to fork internally anyway.
 *
 * Retryable: `RateLimitError` (429 - a sustained rate limit; see
 * `retryAfterMsFromError`), `InternalServerError` (>=500, including 529
 * overloaded), `APIConnectionError` (network failure before any response -
 * `APIConnectionTimeoutError` is a subclass and matches here too). All
 * three represent conditions that plausibly resolve on their own; per the
 * `claude-api` skill's own `error-codes.md`, Anthropic's documented fix for
 * both 429 and 529 is literally "retry with exponential backoff."
 *
 * Not retryable: `BadRequestError` (400 - a malformed request; nothing
 * about our request changes between attempts), `AuthenticationError` (401 -
 * bad/missing API key; a human problem, not a transient one),
 * `PermissionDeniedError` (403 - the key lacks access to this model/
 * feature), `NotFoundError` (404 - e.g. a typo'd model id), `ConflictError`
 * (409), `UnprocessableEntityError` (422). `MissingResumeTextError` (this
 * file, below - a resumeId with no `resumes` row) is also permanent: retrying
 * won't make a deleted resume reappear.
 *
 * Anything else - a base `APIError` this list doesn't name specifically
 * (Anthropic could add a new 4xx this SDK version has no subclass for), or a
 * non-Anthropic error entirely (e.g. `makeClaudeScorer`'s own
 * `JSON.parse`/"no text block returned" failures, which surface as plain
 * `Error`s, not typed Anthropic errors) - defaults retryable, same
 * "unanticipated failure modes are not assumed permanent, but still ride
 * the bounded retry-then-DLQ path, never spin forever" reasoning
 * fetchSourceWorker.ts's own `classify()` doc comment gives for its
 * identical fallback.
 */
export function classifyScoringError(err: unknown): ScoringClassification {
  if (err instanceof MissingResumeTextError) {
    return { retryable: false, kind: "missing-resume" };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { retryable: true, kind: "rate-limited" };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { retryable: true, kind: "api-overloaded-or-5xx" };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { retryable: true, kind: "connection" };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { retryable: false, kind: "bad-request" };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { retryable: false, kind: "auth-failed" };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { retryable: false, kind: "forbidden" };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { retryable: false, kind: "not-found" };
  }
  if (err instanceof Anthropic.ConflictError) {
    return { retryable: false, kind: "conflict" };
  }
  if (err instanceof Anthropic.UnprocessableEntityError) {
    return { retryable: false, kind: "unprocessable" };
  }
  if (err instanceof Anthropic.APIError) {
    // Opus review fix (ticket 4065511, F1): this branch previously returned
    // retryable: false, contradicting this function's own doc comment two
    // lines above ("Anything else ... defaults retryable") and
    // fetchSourceWorker.ts's identical-fallback precedent. Verified against
    // the installed SDK: `APIError.generate(408, ...)` produces a base
    // APIError with no subclass (the SDK's own internal `shouldRetry` DOES
    // retry 408/409/429/5xx), and `APIUserAbortError` is also `instanceof
    // APIError` with `status: undefined` -- both were being permanently
    // dropped by the old `false` here. No status in this SDK version's
    // named subclasses (RateLimitError/InternalServerError/BadRequestError/
    // AuthenticationError/PermissionDeniedError/NotFoundError/ConflictError/
    // UnprocessableEntityError, all handled above) reaches this branch, so
    // "unnamed APIError" and "not an Anthropic error at all" collapse into
    // the same reasoning: no evidence a retry is futile.
    return { retryable: true, kind: `api-error-${err.status ?? "unknown"}` };
  }
  // Anything not an Anthropic SDK error at all (a JSON.parse failure inside
  // makeClaudeScorer, a DB blip surfacing through the same promise, ...) -
  // no evidence a retry is futile, so this defaults retryable rather than
  // permanent. See this function's own doc comment.
  return { retryable: true, kind: "unknown" };
}

/** `resumeId` (found via `search_results`/`searches`) names no row in the
 * `resumes` table. Permanent, per-resumeId - see `classifyScoringError`. */
export class MissingResumeTextError extends Error {}

export function parseScoreJobMessage(content: Buffer): ScoreJobMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch (err) {
    throw new InvalidMessageError("score.job message body was not valid JSON", { cause: err });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidMessageError("score.job message body was not a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.jobId !== "string" || body.jobId.length === 0) {
    throw new InvalidMessageError('score.job message missing string field "jobId"');
  }
  return { jobId: body.jobId };
}

/** See fetchSourceWorker.ts's identical `ATTEMPT_HEADER`/`getAttempt` - a
 * local copy, not an import, for the same self-containment reason
 * `InvalidMessageError` above is a local copy. */
const ATTEMPT_HEADER = "x-attempt";

function getAttempt(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.[ATTEMPT_HEADER];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Marks a channel as already having the `return` handler below attached -
 * see fetchSourceWorker.ts's identical `RETURN_HANDLER_ATTACHED` for the
 * full reasoning (idempotent registration across repeated
 * `createScoreJobHandler` calls sharing one channel, survives a
 * logging/tracing Proxy wrapper). A DISTINCT `Symbol.for` key from that
 * file's own tag: this worker and fetchSourceWorker.ts are expected to
 * eventually share one channel in the same process (both consume off the
 * same "jobs" exchange's queues), and each needs its OWN `return` handler
 * registered exactly once - a shared tag would make the second worker to
 * register see "already attached" and silently skip wiring its own
 * dead-letter safety net. */
const RETURN_HANDLER_ATTACHED = Symbol.for("scoreJobWorker.retryReturnHandlerAttached");

function ensureRetryReturnHandler(channel: ConfirmChannel, log: (message: string) => void): void {
  const tagged = channel as ConfirmChannel & { [RETURN_HANDLER_ATTACHED]?: true };
  if (tagged[RETURN_HANDLER_ATTACHED]) return;
  tagged[RETURN_HANDLER_ATTACHED] = true;

  channel.on("return", (returned) => {
    log(
      `[score.job] retry publish to "${returned.fields.routingKey}" was unroutable ` +
        `(queue missing or renamed after startup?) - dead-lettering into ${SCORE_JOB_DLQ} instead`,
    );
    channel.sendToQueue(SCORE_JOB_DLQ, returned.content, {
      persistent: true,
      contentType: returned.properties.contentType,
      headers: returned.properties.headers,
    });
  });
}

export type ScoreJobWorkerOptions = {
  channel: ConfirmChannel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /**
   * The real scoring call - `makeClaudeScorer(anthropic)` from
   * matching/scoring.ts in production, where `anthropic` is constructed the
   * same env-based way every other caller in this codebase does
   * (`new Anthropic()` - see demo-match.ts's `main()`, index.ts's
   * `cachedAnthropic`). Injected, not constructed inside this file, for the
   * same reason `FetchSourceWorkerOptions.sources` is injected rather than
   * built here: constructing an `Anthropic` client requires
   * `ANTHROPIC_API_KEY` to be set, and this module must stay importable (and
   * unit-testable with a fake `ScoreJobFn`, no network, no API key) without
   * that requirement.
   */
  scoreJob: ScoreJobFn;
  /** Total delivery attempts (including the first) before giving up and
   * dead-lettering a message with a remaining retryable failure. Defaults
   * to 4, matching `FetchSourceWorkerOptions.maxAttempts`'s own default. */
  maxAttempts?: number;
  /** Backoff delay tiers, ordered shortest to longest, one durable queue
   * per tier. Defaults to `SCORE_JOB_RETRY_TIERS` from topology.ts.
   * Overridable so tests can use short-lived tiers instead of waiting on
   * real-world backoff - see `FetchSourceWorkerOptions.retryTiers`'s
   * identical doc comment for the "must already exist as a queue wired the
   * same way" contract this mirrors. */
  retryTiers?: ReadonlyArray<RetryTier>;
  /** Structured-ish logging hook for retry/dead-letter decisions and
   * permanent per-resume failures. Defaults to console.error. */
  log?: (message: string) => void;
};

type ResumeScoreOutcome =
  | { resumeId: string; status: "scored"; scored: ScoredJob }
  | {
      resumeId: string;
      status: "failed";
      retryable: boolean;
      kind: string;
      errorMessage: string;
      retryAfterMs?: number;
    };

/** Every DISTINCT resumeId that has ever searched up `jobId`, via
 * `search_results.job_id -> search_results.search_id -> searches.id ->
 * searches.resume_id` - see this module's own doc comment for why this
 * relational path (not a `resumeId` on the message itself) is how this
 * worker resolves who to score against. Returns `[]` (not an error) for a
 * jobId with no such link yet - see `handleScoreJobMessage`'s handling of
 * that case: nothing wrong happened, there's just nothing to do yet. */
async function resolveResumeIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  jobId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ resumeId: searches.resumeId })
    .from(searchResults)
    .innerJoin(searches, eq(searchResults.searchId, searches.id))
    .where(eq(searchResults.jobId, jobId));
  return rows.map((r) => r.resumeId);
}

/**
 * Builds the per-message handler. Exported separately from the `consume()`
 * wiring (`startScoreJobWorker` below) so tests can invoke it directly
 * against a real (or fake) channel and message, exactly mirroring
 * fetchSourceWorker.ts's `createFetchSourceHandler`/`startFetchSourceWorker`
 * split.
 */
export function createScoreJobHandler(options: ScoreJobWorkerOptions) {
  const {
    channel,
    db,
    scoreJob,
    maxAttempts = 4,
    retryTiers = SCORE_JOB_RETRY_TIERS,
    log = (message: string) => console.error(message),
  } = options;

  ensureRetryReturnHandler(channel, log);

  return async function handleScoreJobMessage(msg: ConsumeMessage): Promise<void> {
    const attempt = getAttempt(msg);

    try {
      const message = parseScoreJobMessage(msg.content);

      const jobRows = await db
        .select({
          externalId: jobsTable.externalId,
          dataSource: jobsTable.dataSource,
          title: jobsTable.title,
          description: jobsTable.description,
          company: jobsTable.company,
          payType: jobsTable.payType,
          commitment: jobsTable.commitment,
          locationType: jobsTable.locationType,
          location: jobsTable.location,
          linkToApply: jobsTable.linkToApply,
          postedAt: jobsTable.postedAt,
        })
        .from(jobsTable)
        .where(eq(jobsTable.id, message.jobId))
        .limit(1);
      // Explicit `JobDescriptionRow` annotation (not just relying on
      // inference) documents that this select's column list is exactly the
      // shape `toNormalizedJob` (matching/pipeline.ts) expects - see this
      // module's own doc comment on reusing that function rather than
      // writing a second row->NormalizedJob mapper.
      const jobRow: JobDescriptionRow | undefined = jobRows[0];
      if (!jobRow) {
        throw new UnknownJobError(`no jobs row found for jobId "${message.jobId}"`);
      }
      const normalizedJob = toNormalizedJob(jobRow);

      const resumeIds = await resolveResumeIds(db, message.jobId);
      if (resumeIds.length === 0) {
        // Nothing wrong happened - this job simply has no search_results
        // link yet (or the search it came from was itself since removed).
        // Retrying would find the same nothing; ack and move on.
        log(
          `[score.job] jobId ${message.jobId}: no search_results link to any search found - ` +
            `nothing to score, acking`,
        );
        channel.ack(msg);
        return;
      }

      // Score only what has no job_matches row yet for this (resumeId,
      // jobId) pair - the whole point of checking BEFORE calling scoreJob,
      // not just relying on the unique constraint to reject a duplicate
      // insert: a redelivered message must not re-spend a real Claude call
      // on a pair it already scored. See this module's own doc comment.
      const alreadyScoredRows = await db
        .select({ resumeId: jobMatches.resumeId })
        .from(jobMatches)
        .where(and(eq(jobMatches.jobId, message.jobId), inArray(jobMatches.resumeId, resumeIds)));
      const alreadyScored = new Set(alreadyScoredRows.map((r) => r.resumeId));
      const needsScoreResumeIds = resumeIds.filter((id) => !alreadyScored.has(id));

      if (needsScoreResumeIds.length === 0) {
        log(
          `[score.job] jobId ${message.jobId}: all ${resumeIds.length} linked resume(s) already ` +
            `scored - acking`,
        );
        channel.ack(msg);
        return;
      }

      const resumeRows = await db
        .select({ id: resumes.id, resumeText: resumes.resumeText })
        .from(resumes)
        .where(inArray(resumes.id, needsScoreResumeIds));
      const resumeTextById = new Map(resumeRows.map((r) => [r.id, r.resumeText]));

      // Every resumeId's call is independent - a rate limit on one must
      // never take down a sibling resumeId's successful score. Settled
      // individually (not Promise.all) so a fulfilled call is never thrown
      // away because a DIFFERENT resumeId's call rejected; see this
      // module's own doc comment on how the message's own fate is decided
      // from what's left in `failed` below.
      const outcomes: ResumeScoreOutcome[] = await Promise.all(
        needsScoreResumeIds.map(async (resumeId): Promise<ResumeScoreOutcome> => {
          const resumeText = resumeTextById.get(resumeId);
          if (resumeText === undefined) {
            const err = new MissingResumeTextError(
              `no resumes row found for resumeId "${resumeId}" (linked via search_results/searches)`,
            );
            const { retryable, kind } = classifyScoringError(err);
            return { resumeId, status: "failed", retryable, kind, errorMessage: err.message };
          }
          try {
            const scored = await scoreJob(normalizedJob, resumeText);
            return { resumeId, status: "scored", scored };
          } catch (err) {
            const { retryable, kind } = classifyScoringError(err);
            return {
              resumeId,
              status: "failed",
              retryable,
              kind,
              errorMessage: err instanceof Error ? err.message : String(err),
              retryAfterMs: retryAfterMsFromError(err),
            };
          }
        }),
      );

      const succeeded = outcomes.filter(
        (o): o is Extract<ResumeScoreOutcome, { status: "scored" }> => o.status === "scored",
      );
      if (succeeded.length > 0) {
        // onConflictDoNothing as defense-in-depth, not the primary
        // mechanism - see this module's doc comment on why the
        // already-scored check above runs FIRST. Two concurrent
        // deliveries of the same message (or this message racing a manual
        // rescore) both computing a score for the same pair simply no-ops
        // the loser instead of erroring.
        await db
          .insert(jobMatches)
          .values(
            succeeded.map((o) => ({
              id: randomUUID(),
              resumeId: o.resumeId,
              jobId: message.jobId,
              matchScore: o.scored.matchScore,
              rationale: o.scored.rationale,
              levelFit: o.scored.levelFit ?? null,
              levelFitNote: o.scored.levelFitNote ?? null,
              strengths: o.scored.strengths,
              gaps: o.scored.gaps,
            })),
          )
          .onConflictDoNothing({ target: [jobMatches.resumeId, jobMatches.jobId] });
      }

      const failed = outcomes.filter(
        (o): o is Extract<ResumeScoreOutcome, { status: "failed" }> => o.status === "failed",
      );
      if (failed.length === 0) {
        channel.ack(msg);
        return;
      }

      for (const f of failed) {
        log(
          `[score.job] jobId ${message.jobId} resumeId ${f.resumeId}: ` +
            `${f.retryable ? "retryable" : "PERMANENT"} failure (${f.kind}): ${f.errorMessage}`,
        );
      }

      const retryableFailures = failed.filter((f) => f.retryable);
      if (retryableFailures.length === 0) {
        // Every failure is permanent - see classifyScoringError. Nothing
        // about retrying the WHOLE message fixes a permanent per-resume
        // failure, and every resumeId that COULD be scored already was
        // (persisted above).
        if (succeeded.length > 0) {
          // Partial success: at least one resumeId's score is already
          // persisted, so this message has produced everything it ever
          // will. Ack is correct here - a DLQ entry would just be noise
          // about resumeIds that were never going to score.
          log(
            `[score.job] jobId ${message.jobId}: ${failed.length} permanent failure(s), ` +
              `${succeeded.length} scored - acking (nothing left to retry)`,
          );
          channel.ack(msg);
          return;
        }
        // Opus review fix (ticket 4065511, F2): zero successes AND every
        // failure permanent used to ack unconditionally here, which is
        // correct for a genuinely per-resume-only failure
        // (MissingResumeTextError) but silently DROPS a systemic one -
        // AuthenticationError (expired/revoked API key), PermissionDeniedError,
        // NotFoundError (e.g. a retired model id after a version bump) all
        // classify permanent too, and none of them are specific to this
        // resumeId: every message the worker processes after the outage
        // starts would hit the identical wall, ack, and vanish - the queue
        // drains with zero job_matches rows and zero record ANYWHERE that
        // this jobId was ever consumed, so nothing can even be found to
        // republish once the outage is fixed. fetchSourceWorker.ts
        // dead-letters every permanent failure unconditionally (line ~664)
        // specifically so the DLQ stays the audit trail of discarded work;
        // this worker was the only one that didn't. Nack to the DLQ instead
        // - it costs nothing when the failure really was resume-specific
        // (the DLQ entry is just inert evidence a resume text was missing),
        // and it's the only thing that makes a systemic outage visible and
        // replayable instead of silent.
        log(
          `[score.job] jobId ${message.jobId}: ${failed.length} permanent failure(s), ` +
            `0 scored - dead-lettering (no successful score to preserve, and acking here would ` +
            `discard this jobId with no record if the failure turns out to be systemic)`,
        );
        channel.nack(msg, false, false);
        return;
      }

      if (attempt >= maxAttempts) {
        log(
          `[score.job] jobId ${message.jobId}: attempt ${attempt}/${maxAttempts}, ` +
            `${retryableFailures.length} retryable failure(s) remain - retries exhausted, ` +
            `dead-lettering (${succeeded.length} already-scored resume(s) stay persisted)`,
        );
        channel.nack(msg, false, false);
        return;
      }

      const nextAttempt = attempt + 1;
      // When more than one retryable failure carries its own
      // Retry-After, honor the LONGEST one - retrying before the slowest
      // source's own window has passed just spends an attempt on a
      // guaranteed second failure for that resumeId. Mirrors
      // fetchSourceWorker's single-failure desiredDelayMs, generalized to
      // "the max across every retryable failure this attempt produced."
      const desiredDelays = retryableFailures
        .map((f) => f.retryAfterMs)
        .filter((v): v is number => v !== undefined);
      const desiredDelayMs = desiredDelays.length > 0 ? Math.max(...desiredDelays) : undefined;
      const { tier, clamped } = pickRetryTier(retryTiers, nextAttempt, desiredDelayMs);
      log(
        `[score.job] jobId ${message.jobId}: attempt ${attempt}/${maxAttempts}, ` +
          `${retryableFailures.length} retryable failure(s) - retrying (attempt ${nextAttempt}) ` +
          `via ${tier.queue} (${tier.delayMs}ms)` +
          (desiredDelayMs !== undefined ? ` [requested ${desiredDelayMs}ms]` : "") +
          (clamped ? ` [CLAMPED: requested delay exceeds the longest configured retry tier]` : ""),
      );

      // No per-message `expiration` - see topology.ts's SCORE_JOB_RETRY_TIERS
      // doc comment (same queue-level-TTL reasoning FETCH_SOURCE_RETRY_TIERS
      // uses). `mandatory: true` + the `channel.on("return", ...)` handler
      // registered above: an unroutable retry publish (tier queue deleted/
      // renamed since startup) comes back as a `return` event instead of
      // vanishing, and gets dead-lettered into SCORE_JOB_DLQ.
      channel.sendToQueue(tier.queue, msg.content, {
        persistent: true,
        mandatory: true,
        contentType: msg.properties.contentType,
        headers: { ...msg.properties.headers, [ATTEMPT_HEADER]: nextAttempt },
      });
      await channel.waitForConfirms();
      // The original delivery is fully handled - a retry copy has been
      // scheduled - so it's acked, not left unacked or nacked-with-requeue
      // (which would race the retry copy).
      channel.ack(msg);
    } catch (err) {
      const retryable = !(err instanceof InvalidMessageError || err instanceof UnknownJobError);
      const kind =
        err instanceof InvalidMessageError
          ? "invalid-message"
          : err instanceof UnknownJobError
            ? "unknown-job"
            : "unknown";
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (!retryable) {
        log(
          `[score.job] non-retryable error (${kind}) on attempt ${attempt} - dead-lettering ` +
            `immediately without consuming a retry: ${errorMessage}`,
        );
        channel.nack(msg, false, false);
        return;
      }

      if (attempt >= maxAttempts) {
        log(
          `[score.job] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} - ` +
            `retries exhausted, dead-lettering`,
        );
        channel.nack(msg, false, false);
        return;
      }

      const nextAttempt = attempt + 1;
      const { tier, clamped } = pickRetryTier(retryTiers, nextAttempt);
      log(
        `[score.job] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} - ` +
          `retrying (attempt ${nextAttempt}) via ${tier.queue} (${tier.delayMs}ms)` +
          (clamped ? ` [CLAMPED]` : ""),
      );
      channel.sendToQueue(tier.queue, msg.content, {
        persistent: true,
        mandatory: true,
        contentType: msg.properties.contentType,
        headers: { ...msg.properties.headers, [ATTEMPT_HEADER]: nextAttempt },
      });
      await channel.waitForConfirms();
      channel.ack(msg);
    }
  };
}

/**
 * Starts consuming `score.job` with the given options. Returns the consumer
 * tag so a caller can `channel.cancel(tag)` to stop. Mirrors
 * `startFetchSourceWorker` exactly: fails fast at startup if a configured
 * retry tier queue doesn't exist yet, then wires the same
 * unhandled-rejection safety net around the per-message handler so a bug
 * this worker didn't anticipate can never leave a message unacked forever
 * under `prefetch(1)` (which would silently wedge the whole consumer - see
 * `startFetchSourceWorker`'s own doc comment for the full reasoning, which
 * applies here unchanged).
 *
 * NOT CALLED FROM ANYWHERE IN THIS CODEBASE YET - see this module's own doc
 * comment, "NOT WIRED TO RUN".
 */
export async function startScoreJobWorker(
  options: ScoreJobWorkerOptions,
  consumeOptions?: { prefetch?: number },
): Promise<string> {
  const retryTiers = options.retryTiers ?? SCORE_JOB_RETRY_TIERS;
  for (const tier of retryTiers) {
    try {
      await options.channel.checkQueue(tier.queue);
    } catch (err) {
      throw new Error(
        `startScoreJobWorker: retry tier queue "${tier.queue}" does not exist - run ` +
          `setupTopology() (or declare it identically) before starting the worker`,
        { cause: err },
      );
    }
  }

  const handler = createScoreJobHandler(options);
  const log = options.log ?? ((m: string) => console.error(m));
  await options.channel.prefetch(consumeOptions?.prefetch ?? 1);
  const { consumerTag } = await options.channel.consume(SCORE_JOB_QUEUE, (msg) => {
    if (!msg) return; // consumer was cancelled server-side
    handler(msg).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[score.job] handler failed outside its own error handling: ${message} - attempting to ` +
          `dead-letter the message directly`,
      );
      try {
        options.channel.nack(msg, false, false);
      } catch (nackErr) {
        const nackMessage = nackErr instanceof Error ? nackErr.message : String(nackErr);
        log(
          `[score.job] nack also failed (${nackMessage}) - closing the channel so the message ` +
            `isn't held unacked forever and a supervisor can restart this worker`,
        );
        options.channel.close().catch(() => {});
      }
    });
  });
  return consumerTag;
}
