import { randomUUID } from "node:crypto";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  jobMatchFailures,
  jobMatches,
  jobs as jobsTable,
  resumes,
  searchResults,
  searches,
} from "../db/schema.js";
import {
  estimateScoringCost,
  readUsageStats,
  recordUsageStats,
  toNormalizedJob,
  type JobDescriptionRow,
  type ScoreJobFn,
  type ScoredJob,
} from "../matching/index.js";
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
 *   1. selects every DISTINCT `(searches.id, searches.resume_id)` reachable
 *      from `jobId` via `search_results` (see `resolveSearchLinks` below) -
 *      the query shape is `SELECT DISTINCT searches.id, searches.resume_id
 *      FROM search_results JOIN searches ON search_results.search_id =
 *      searches.id WHERE search_results.job_id = $1`. The searchIds are
 *      carried only for the failure ledger (ticket 9a53485,
 *      `recordPermanentFailures`); steps 2 and 3 operate on the DISTINCT
 *      resumeIds behind them, since a score is per (resume, job) and one
 *      score serves every search for that resume;
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
 * SPEND GUARD (ticket b53c422 - closes the gap ticket 4065511 deliberately
 * left open, see the two paragraphs this replaces in git history):
 * `runDemoMatch`'s synchronous CLI path caps how many jobs get scored PER
 * RUN (`DEFAULT_SCORE_THRESHOLD`/`allowAboveThreshold`, matching/scoring.ts
 * and matching/pipeline.ts) and requires an explicit opt-in to exceed it. A
 * queue-driven worker consuming `score.job` indefinitely has no equivalent
 * "one run" to size a threshold against, so this file uses a different
 * mechanism entirely: `ScoringSpendGuard`, a LIFETIME-PER-PROCESS dollar
 * ceiling, checked with a real pre-call estimate (`estimateScoringCost`,
 * matching/usage-cost.ts) before every scoring attempt and reset only by
 * restarting the process. See `ScoringSpendGuard`'s own doc comment below
 * for the concrete numbers behind the default ceiling and why this
 * mechanism was chosen over a rolling time window or a per-message
 * threshold.
 *
 * USAGE STATS (ticket b53c422): every batch of successful scores from ONE
 * message is now recorded via `recordUsageStats` (matching/usage-cost.ts),
 * mirroring `runDemoMatch`'s own call site in matching/pipeline.ts - see the
 * `recordUsageStats` call in `createScoreJobHandler` below for why this is
 * ONE call per message (aggregating every resumeId scored, not one call per
 * resumeId) and why that grouping is what keeps it safe under this worker's
 * current single-process, `prefetch(1)` deployment.
 *
 * COMPLETION LEDGER (ticket 4f88339): this worker now also writes the
 * FAILURE half of the durable record a search's completion is derived
 * from. A `job_matches` row says "this (resume, job) pair is done"; a
 * `job_match_failures` row says "this pair will never be done". Without
 * the second, a dead-lettered `score.job` leaves nothing in Postgres at
 * all — the message body is `{jobId}`, with no searchId and no resumeId —
 * and the search that linked the job waits forever for a score that is
 * never coming. See `recordPermanentFailures` below for where the rows are
 * written and why the write is best-effort, and db/schema.ts's
 * `jobMatchFailures` for why the failures live in their own table rather
 * than as a status column on `job_matches` (short version: a failure row
 * in `job_matches` would satisfy the already-scored check in step 2 above
 * and permanently stop retrying a transiently-failed job).
 *
 * NOW WIRED TO RUN (ticket b53c422): `startScoreJobWorker` is called from a
 * real long-lived process by `run-score-job-worker.ts` in this same
 * directory - see that file's own doc comment (and README "Run the queue
 * workers") for how the real `channel`/`db`/`scoreJob` dependencies are
 * constructed and the correct (root-relative, NOT `package.json`'s
 * `worker:score-job` `pnpm --filter` form - see `USAGE_STATS_PATH`'s doc
 * comment below for why that matters) way to launch it. `fetchSourceWorker.ts`
 * gets the identical treatment via `run-fetch-source-worker.ts`, same ticket.
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

/** Same real usage-stats file `readUsageStats`/`recordUsageStats` already
 * read/write for the synchronous CLI path (`demo-match.ts`'s `main()`, via
 * `runDemoMatch`'s own `usageStatsPath` default in matching/pipeline.ts) and
 * for `rescore-existing-matches.ts`'s own `USAGE_STATS_PATH` -- a local
 * copy of the same string literal, not an import, matching this file's own
 * established "small frozen piece, not reached into" convention (see
 * `InvalidMessageError`'s doc comment above, and `rescore-existing-
 * matches.ts`'s doc comment on why it carries its own copy too). Reusing
 * the SAME path means this worker's spend-guard pre-call estimate, and the
 * `recordUsageStats` calls below, read from and write to the SAME corpus
 * every other real scoring path already shares -- exactly the point of
 * ticket b53c422's `recordUsageStats` wiring: this path's real volume must
 * feed the same average `estimateScoringCost` everywhere else depends on,
 * not a second, disconnected figure.
 *
 * CWD-RELATIVE, same as `demo-match.ts`/`rescore-existing-matches.ts`'s own
 * `prep/`-relative paths -- this worker MUST be launched with the repo root
 * as the working directory (`npx tsx apps/api/src/worker/run-score-job-
 * worker.ts` from root, README "Run the queue workers"), never via `pnpm
 * --filter @app/api worker:score-job` (cwd = `apps/api/`). Opus review,
 * ticket b53c422, F1: launching from the wrong cwd doesn't error -- it
 * silently writes/reads `apps/api/prep/scoring-usage-stats.json`, the exact
 * "second, disconnected figure" the paragraph above says this wiring exists
 * to prevent, and pins the spend guard to the less-conservative bootstrap
 * cost basis forever (measured is ~20.9% higher per call than bootstrap --
 * re-review correction: the prior draft of this comment had the direction
 * inverted, ~17% is how much LOWER bootstrap is than measured, not the
 * reverse; a guard that never sees real history under-estimates every call
 * by the ~20.9% figure). */
export const USAGE_STATS_PATH = "prep/scoring-usage-stats.json";

/**
 * `SCORING SPEND GUARD` (ticket b53c422): this worker consumes `score.job`
 * off a queue indefinitely, with no natural "one run" the way
 * `runDemoMatch`'s `DEFAULT_SCORE_THRESHOLD`/`allowAboveThreshold` assumes
 * (see this module's own doc comment, "SPEND GUARD"). Three shapes were on
 * the table (per the ticket): a rolling time-window cap, a lifetime-per-
 * process cap with restart-to-reset, or a pre-call `estimateScoringCost`
 * check. This combines the last two: `ScoringSpendGuard` tracks a running
 * total of PRE-CALL worst-case cost estimates (`estimateScoringCost(...)
 * .maxCostUsd`, the same genuine, code-enforced-`MAX_OUTPUT_TOKENS` ceiling
 * `checkSpendCeiling` in rescore-existing-matches.ts already trusts for an
 * identical purpose) against `ceilingUsd`, for the LIFETIME of this process
 * -- there is no time-based reset, only a restart, which starts a fresh
 * `ScoringSpendGuard` instance with `spentUsd` back at 0.
 *
 * WHY LIFETIME-PER-PROCESS OVER A ROLLING WINDOW: a rolling window (e.g.
 * "$X per hour") sounds like it would recover on its own, but it creates a
 * worse failure mode for the concrete scenario the ticket names -- a bug
 * publishing `score.job` messages in a tight loop. Under a rolling window,
 * once the window fills, the SAME message would be endlessly refused,
 * requeued, and refused again every time its retry backoff elapses,
 * forever (nothing about this worker's `maxAttempts`/DLQ machinery treats
 * "the window is still full" as a reason to stop retrying differently from
 * any other retryable failure -- it would just dead-letter after
 * `maxAttempts`, discarding real work that would have succeeded once the
 * window rolled over). A lifetime cap fails louder and more simply: once
 * tripped, every message genuinely needing a NEW scoring call dead-letters
 * (see `classifyScoringError`'s `spend-guard-exceeded` case below) after
 * the normal retry budget, leaving a clear, complete DLQ audit trail an
 * operator restarts the process and replays -- not a self-healing trickle
 * that can silently under- or over-recover depending on traffic timing.
 * "Just restart it" is an explicitly accepted manual safety valve for a
 * personal, single-operator project (the ticket's own words), which is
 * exactly what this project is.
 *
 * WHY $15 (`DEFAULT_LIFETIME_SPEND_CEILING_USD`): sized concretely against
 * this worker's own real numbers, not by analogy to anything else in the
 * codebase -- `rescore-existing-matches.ts`'s own `MAX_ESTIMATED_SPEND_USD`
 * is $5 (opus review, ticket b53c422, F2: an earlier draft of this comment
 * claimed the two numbers were the same deliberate ceiling reused across
 * the codebase; they are not, and never really were -- that file's $5 is
 * sized for ITS OWN unrelated constraint, an unmeasurable per-resume job
 * count for a manual CLI rerun, not a lifetime-per-process guard against a
 * runaway bug in a long-lived worker. Treat the two ceilings as
 * independent; don't re-derive a link between them from this comment).
 * Run live in this worktree (2026-09-21) via `estimateScoringCost` against
 * a synthetic single-job
 * batch shaped like this codebase's own real, previously-measured figures
 * (a 4,914-char resume -- the exact length `CACHE_READ_PRICE_MULTIPLIER`'s
 * doc comment in usage-cost.ts cites for the real `prep/resume.txt` -- and
 * a 6,000-char job description, `buildJobSuffix`'s own documented cap):
 *
 *   - "bootstrap" basis (no `prep/scoring-usage-stats.json` yet -- a fresh
 *     checkout, this sandbox's own state): `maxCostUsd` for ONE job is
 *     ~$0.0388, so $15 bounds roughly 387 worst-case scoring attempts
 *     before tripping.
 *   - "measured" basis (real historical per-call averages -- reused the
 *     same 3,874.5 in / 454.2 out tokens/call figures
 *     `rescore-existing-matches.ts`'s own `MAX_ESTIMATED_SPEND_USD` comment
 *     cites, with no cache history): `maxCostUsd` for ONE job is ~$0.0468,
 *     so $15 bounds roughly 320 worst-case scoring attempts.
 *
 * Either basis lands in the same 300-400 range -- comfortably above
 * `DEFAULT_SCORE_THRESHOLD` (200, the synchronous CLI path's own per-run
 * cap) so a single legitimate burst of activity (e.g. one large search
 * fanning out through this worker) does not itself trip the guard, while
 * still bounding a genuine runaway-bug's total lifetime exposure to
 * roughly $15. (Worth noting the criterion actively EXCLUDES
 * `MAX_ESTIMATED_SPEND_USD`'s $5: that would bound only ~107-129 calls,
 * below the 200-call floor this paragraph argues for -- another reason the
 * two ceilings aren't meant to match.) Not a claim that $15 is uniquely
 * correct -- like `MAX_ESTIMATED_SPEND_USD`, raise
 * `DEFAULT_LIFETIME_SPEND_CEILING_USD` deliberately, with a real reason, if
 * it proves too tight in practice.
 *
 * Deliberately OVER-attributes, never under: `tryReserve` books the
 * estimate BEFORE `scoreJob()` is ever called, and never gives it back --
 * not on a failed call (below its real cost, since nothing was actually
 * billed), not on a call that comes in cheaper than its worst-case
 * estimate (the common case, since `maxCostUsd` assumes every call maxes
 * out `MAX_OUTPUT_TOKENS`). That is the same "conservative, never a silent
 * underestimate" posture `CostEstimate.maxCostUsd`'s own doc comment
 * (usage-cost.ts) already commits to; a guard that could under-count a
 * real call's true cost would defeat the whole point of having one.
 *
 * THREAD-SAFETY NOTE: `tryReserve` is a plain synchronous read-then-write
 * on `spentUsd`, safe only because every call site in this file invokes it
 * SYNCHRONOUSLY (before the first `await`) inside the `.map()` that builds
 * `createScoreJobHandler`'s `Promise.all` -- see the call site below for
 * why that ordering, not this class, is what actually prevents two
 * concurrent reservations from racing each other within one message or
 * across messages under `prefetch(1)`.
 */
export const DEFAULT_LIFETIME_SPEND_CEILING_USD = 15;

/** The minimal spend-guard surface `createScoreJobHandler` actually calls -
 * an interface, not the concrete `ScoringSpendGuard` class, for the same
 * dependency-injection reason `ScoreJobWorkerOptions.scoreJob` is typed as
 * the `ScoreJobFn` function type rather than a class: a test can hand in a
 * tiny fake (e.g. "allow once, then always refuse") to hit a refusal
 * deterministically, without reconstructing real dollar-estimate
 * arithmetic just to cross a ceiling. `ScoringSpendGuard` below implements
 * this structurally (TypeScript needs no explicit `implements` for that),
 * and is what every real caller (`run-score-job-worker.ts`) actually
 * constructs and passes in. */
export type SpendGuard = {
  tryReserve(estimatedCostUsd: number): boolean;
};

export class ScoringSpendGuard implements SpendGuard {
  private spentUsd = 0;

  constructor(private readonly ceilingUsd: number = DEFAULT_LIFETIME_SPEND_CEILING_USD) {}

  /** Books `estimatedCostUsd` against the remaining lifetime budget and
   * returns `true` if doing so keeps the running total at or under
   * `ceilingUsd`; returns `false` (and books nothing) otherwise. See this
   * class's own doc comment for why the booking is never reversed. */
  tryReserve(estimatedCostUsd: number): boolean {
    if (this.spentUsd + estimatedCostUsd > this.ceilingUsd) return false;
    this.spentUsd += estimatedCostUsd;
    return true;
  }

  /** Total booked so far this process's lifetime -- exposed for logging and
   * tests, not for any decision this class doesn't already make itself. */
  get reservedUsd(): number {
    return this.spentUsd;
  }

  get ceiling(): number {
    return this.ceilingUsd;
  }
}

/** Thrown internally when `ScoringSpendGuard.tryReserve` refuses a scoring
 * attempt. Classified retryable (see `classifyScoringError` below) rather
 * than permanent: the DATA this message names hasn't changed, only THIS
 * PROCESS's remaining lifetime budget has run out, and a future attempt
 * (after an operator restarts the process, resetting the guard) could
 * genuinely still succeed -- unlike `MissingResumeTextError`, where no
 * restart changes the outcome. In practice a guard that's already tripped
 * stays tripped for the rest of this process's life, so a retried attempt
 * within the SAME process will keep failing identically until
 * `maxAttempts` is exhausted and the message dead-letters -- that bounded
 * churn (a handful of retries, no real spend, since the guard refuses
 * before any Claude call) is an accepted cost of reusing the existing
 * retry/DLQ machinery unchanged rather than adding a special-cased path
 * for this one failure kind. */
export class SpendGuardExceededError extends Error {}

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
 * `SpendGuardExceededError` (this file, below - `ScoringSpendGuard` refused
 * a scoring attempt) is classified RETRYABLE, unlike every other permanent
 * case above - see that class's own doc comment for why: the failure is
 * process-lifetime-scoped, not data-scoped, so a later attempt (after a
 * restart) could genuinely still succeed even though no attempt within
 * THIS process's remaining life ever will.
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
  if (err instanceof SpendGuardExceededError) {
    return { retryable: true, kind: "spend-guard-exceeded" };
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
  /** The lifetime-per-process spend ceiling (ticket b53c422) - see
   * `ScoringSpendGuard`'s own doc comment for the mechanism and the real
   * numbers behind its default. Defaults to a fresh
   * `new ScoringSpendGuard()` (i.e. `DEFAULT_LIFETIME_SPEND_CEILING_USD`).
   * Injectable, not just configurable-by-number, for the same reason
   * `scoreJob` itself is injected: tests need to force a refusal
   * deterministically (a guard constructed with a near-zero ceiling, or a
   * hand-written fake) without depending on real prompt-length arithmetic,
   * and a real long-lived process needs exactly ONE guard instance shared
   * across every message it ever handles, not a fresh one per message -
   * `startScoreJobWorker`'s caller is what owns that one shared instance
   * (see run-score-job-worker.ts). Typed as the narrow `SpendGuard`
   * interface, not the concrete `ScoringSpendGuard` class - see that
   * type's own doc comment for why. */
  spendGuard?: SpendGuard;
  /** Path `recordUsageStats` writes real usage to after every message with
   * at least one successful score, and `estimateScoringCost` reads from to
   * ground the spend guard's pre-call estimate in real historical
   * averages when they exist. Defaults to `USAGE_STATS_PATH` (this file,
   * above) - the SAME file `demo-match.ts`/`rescore-existing-matches.ts`
   * already share. Overridable so tests never touch the real file. */
  usageStatsPath?: string;
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

/** One (searchId, resumeId) pair per search that has linked `jobId`. */
type SearchLink = { searchId: string; resumeId: string };

/** Every search that has ever linked `jobId`, with the resume it is for,
 * via `search_results.job_id -> search_results.search_id -> searches.id ->
 * searches.resume_id` - see this module's own doc comment for why this
 * relational path (not a `resumeId` on the message itself) is how this
 * worker resolves who to score against. Returns `[]` (not an error) for a
 * jobId with no such link yet - see `handleScoreJobMessage`'s handling of
 * that case: nothing wrong happened, there's just nothing to do yet.
 *
 * WHY SEARCHES AND NOT JUST RESUMES (ticket 9a53485). Scoring itself is
 * still per-RESUME: a `job_matches` row is keyed by (resume, job) and one
 * score serves every search for that resume, so `resumeIdsOf` below
 * collapses these rows for the scoring loop. But `job_match_failures` is
 * keyed by (search, resume, job) now, and the failure this worker records
 * belongs to the searches that are actually waiting on this message - so
 * the searchIds have to come back too. Same single query either way; the
 * `DISTINCT` that used to be in the SQL just moved into `resumeIdsOf`. */
async function resolveSearchLinks(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  jobId: string,
): Promise<SearchLink[]> {
  return db
    .selectDistinct({ searchId: searches.id, resumeId: searches.resumeId })
    .from(searchResults)
    .innerJoin(searches, eq(searchResults.searchId, searches.id))
    .where(eq(searchResults.jobId, jobId));
}

/** The DISTINCT resumeIds behind a set of {@link SearchLink}s - two
 * searches for the same resume are one scoring job, not two. */
function resumeIdsOf(links: readonly SearchLink[]): string[] {
  return [...new Set(links.map((link) => link.resumeId))];
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
    spendGuard = new ScoringSpendGuard(),
    usageStatsPath = USAGE_STATS_PATH,
  } = options;

  ensureRetryReturnHandler(channel, log);

  /**
   * Records "we permanently gave up scoring this (resume, job) pair"
   * (ticket 4f88339, design c54b9e0 §4.3) — the durable twin of the DLQ
   * entry this message is about to become.
   *
   * WHY IT EXISTS: a dead-lettered `score.job` leaves no relational trace
   * (the body is `{jobId}`, with no searchId and no resumeId), so without
   * this row the search that linked the job waits for a `job_matches` row
   * that is never coming — the exact "hangs forever on a DLQ'd job"
   * failure the queue-driven completion design exists to prevent. This is
   * ADVISORY FOR COMPLETION ONLY: it lives in its own table precisely so
   * it never reaches the already-scored check above, which means a manual
   * republish from the DLQ still re-scores normally. See
   * `jobMatchFailures`' doc comment in db/schema.ts.
   *
   * `ON CONFLICT DO NOTHING` keeps the FIRST recorded cause, which is the
   * more useful one diagnostically (the original error, not the one from a
   * manual replay), and makes a redelivery a no-op rather than an error.
   *
   * ONE ROW PER (SEARCH, RESUME) PAIR, NOT PER RESUME (ticket 9a53485).
   * `job_match_failures` is scoped to a search now — see its doc comment in
   * db/schema.ts for the decision — so a failure that used to write one row
   * per failed resumeId writes one per SEARCH THAT LINKED THIS JOB for that
   * resumeId. `links` is the same `resolveSearchLinks` result the scoring
   * loop above already fetched; no extra query.
   *
   * WHICH SEARCHES, EXACTLY: every search that has linked the job at the
   * moment this message dies. That includes searches already terminal — a
   * redundant row on a settled search costs nothing and keeps the ledger
   * total — and, in principle, a SIBLING search with its own `score.job`
   * still in flight. Two live searches over one resume are already close to
   * unreachable (`POST /searches`' in-flight guard, routes/searches.ts,
   * 409s a second one until the first is terminal or has passed
   * `STALL_AFTER_MS`), and where it does happen it is the pre-existing
   * at-least-once race, not a new one: the derive prefers a `job_matches`
   * row over a failure row for the same pair, so if the sibling's own
   * attempt then succeeds the job reads as `scored`, not failed. What
   * CANNOT happen any more is the reverse — a search that has not linked
   * the job yet inheriting this verdict before it ever gets an attempt of
   * its own, which is the defect ticket 9a53485 fixed.
   *
   * Best-effort, then nack regardless — never lose a message to a
   * bookkeeping failure. The residual case (row not written AND message
   * dead-lettered) degrades to the staleness backstop in
   * `GET /searches/:id`.
   */
  async function recordPermanentFailures(
    jobId: string,
    attempt: number,
    links: readonly SearchLink[],
    failures: ReadonlyArray<{ resumeId: string; kind: string; errorMessage: string }>,
  ): Promise<void> {
    if (failures.length === 0) return;
    const byResumeId = new Map(failures.map((failure) => [failure.resumeId, failure]));
    const rows = links.flatMap((link) => {
      const failure = byResumeId.get(link.resumeId);
      if (!failure) return [];
      return [
        {
          id: randomUUID(),
          searchId: link.searchId,
          resumeId: failure.resumeId,
          jobId,
          kind: failure.kind,
          errorMessage: failure.errorMessage,
          attempts: attempt,
        },
      ];
    });
    // NOT reachable without a bug: `links` is read once per message and
    // every `failures` entry's resumeId came from it, so an empty `rows`
    // here would mean `failures` was empty too — already returned above.
    // Kept as a guard because an empty `.values([])` is a SQL error, and a
    // crash on the dead-letter path would be a much worse way to find out.
    if (rows.length === 0) return;
    try {
      await db
        .insert(jobMatchFailures)
        .values(rows)
        .onConflictDoNothing({
          target: [jobMatchFailures.searchId, jobMatchFailures.resumeId, jobMatchFailures.jobId],
        });
    } catch (err) {
      log(
        `[score.job] WARNING: could not record ${rows.length} job_match_failures row(s) for ` +
          `jobId ${jobId} (${err instanceof Error ? err.message : String(err)}) - the message ` +
          `still dead-letters; any search waiting on this job now depends on the staleness ` +
          `backstop in GET /searches/:id`,
      );
    }
  }

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

      // One row per SEARCH that linked this job (ticket 9a53485), not per
      // resume: scoring is still per-resume (`resumeIds` below collapses
      // them), but the failure ledger is search-scoped, so the searchIds
      // have to survive to `recordPermanentFailures`.
      const links = await resolveSearchLinks(db, message.jobId);
      const resumeIds = resumeIdsOf(links);
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

      // Read once per message, not once per resumeId - `readUsageStats` is
      // a file read, and every resumeId in this message shares the same
      // historical averages regardless of which resume text it happens to
      // carry (only the pre-call estimate below varies per resumeId, via
      // its own resumeText).
      const usageStats = readUsageStats(usageStatsPath);

      // Every resumeId's call is independent - a rate limit on one must
      // never take down a sibling resumeId's successful score. Settled
      // individually (not Promise.all) so a fulfilled call is never thrown
      // away because a DIFFERENT resumeId's call rejected; see this
      // module's own doc comment on how the message's own fate is decided
      // from what's left in `failed` below.
      //
      // SPEND GUARD (ticket b53c422): `spendGuard.tryReserve(...)` is
      // called SYNCHRONOUSLY inside this `.map()` callback, before the
      // first `await` in either branch below - `.map()` invokes every
      // callback synchronously to obtain its promise, and an `async`
      // function's body runs synchronously up to its first `await`. That
      // means every resumeId in THIS message reserves its estimate against
      // `spendGuard` in array order, with no interleaving from another
      // resumeId in this same message or from another message (this
      // worker runs under `prefetch(1)` by default - see
      // `startScoreJobWorker` - so no second message's handler begins
      // before this one's `await Promise.all(...)` below resolves). See
      // `ScoringSpendGuard`'s own doc comment for why this ordering is
      // what makes an otherwise-unsynchronized counter safe here.
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

          const costEstimate = estimateScoringCost([normalizedJob], resumeText, usageStats);
          if (!spendGuard.tryReserve(costEstimate.maxCostUsd)) {
            // Message deliberately doesn't reach into `spendGuard` for its
            // ceiling/reserved totals - `spendGuard` is the narrow
            // `SpendGuard` interface (tryReserve only), not the concrete
            // `ScoringSpendGuard` class, so those aren't guaranteed to
            // exist on whatever was injected (see `SpendGuard`'s own doc
            // comment). The estimate that triggered the refusal is real
            // and always available, which is what actually matters for
            // debugging a trip.
            const err = new SpendGuardExceededError(
              `spend guard refused: this resumeId's worst-case estimate ($${costEstimate.maxCostUsd.toFixed(4)}) ` +
                `would push this process's lifetime reservation over its ceiling - restart this worker ` +
                `process to reset the guard`,
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

        // USAGE STATS (ticket b53c422): ONE aggregated call per MESSAGE,
        // not one per resumeId - deliberately after the db.insert above
        // (same "never risk already-billed, already-persisted scores on a
        // best-effort write" ordering `runDemoMatch`'s own call site uses,
        // matching/pipeline.ts) and wrapped in try/catch for the identical
        // reason: a failure here (unwritable usageStatsPath, ENOSPC, ...)
        // must never take the just-persisted job_matches rows down with
        // it - the only consequence is the NEXT estimate falling back to
        // the bootstrap basis.
        //
        // CONCURRENCY (ticket b53c422, per the ticket's own question):
        // `recordUsageStats` is read-modify-write on a plain JSON file, no
        // locking. Aggregating every resumeId's usage from THIS message
        // into exactly one call keeps that read-modify-write from ever
        // racing ITSELF within a message (the risk a naive "call it once
        // per resumeId" version would have introduced, since the resumeIds
        // above are scored concurrently via Promise.all). Across MESSAGES,
        // this is safe today for the identical reason
        // `resolveSearchLinks`'s own already-scored check is safe today -
        // see this file's module doc comment and scoreJobWorker.ts's
        // established precedent on that idempotency race: under
        // `prefetch(1)` (`startScoreJobWorker`'s default) there is at most
        // one unacked message being handled by this process at a time, so
        // one message's `recordUsageStats` call always completes (or
        // fails) before the next message's handler begins - no concurrent
        // read-modify-write is possible YET. That stops being true the
        // moment either (a) this process is started with `prefetch > 1`,
        // or (b) a second worker PROCESS is ever run against the same
        // `usageStatsPath` (this codebase's own review history already
        // anticipates that happening eventually) - both would let two
        // read-modify-write cycles interleave and silently lose one
        // side's delta (a classic lost update: both read the same prior
        // total, both compute a new total from it, the second write wins
        // and the first's contribution vanishes). Not fixed here
        // (proportionate to this ticket's scope: this worker is deployed
        // as exactly one process at `prefetch(1)` today, per
        // run-score-job-worker.ts/package.json) - a real fix (a file
        // lock, or moving usage stats into Postgres where a transaction
        // can serialize the update) is real follow-up work for whenever a
        // second worker instance actually gets deployed, not before.
        const succeededWithUsage = succeeded.filter(
          (
            o,
          ): o is typeof o & {
            scored: typeof o.scored & { usage: NonNullable<ScoredJob["usage"]> };
          } => o.scored.usage !== undefined,
        );
        if (succeededWithUsage.length > 0) {
          try {
            recordUsageStats(usageStatsPath, {
              calls: succeededWithUsage.length,
              totalInputTokens: succeededWithUsage.reduce(
                (sum, o) => sum + o.scored.usage.inputTokens,
                0,
              ),
              totalOutputTokens: succeededWithUsage.reduce(
                (sum, o) => sum + o.scored.usage.outputTokens,
                0,
              ),
              totalCacheReadTokens: succeededWithUsage.reduce(
                (sum, o) => sum + (o.scored.usage.cacheReadTokens ?? 0),
                0,
              ),
              totalCacheCreationTokens: succeededWithUsage.reduce(
                (sum, o) => sum + (o.scored.usage.cacheCreationTokens ?? 0),
                0,
              ),
            });
          } catch (err) {
            log(
              `[score.job] WARNING: failed to record usage stats to "${usageStatsPath}" - the ` +
                `${succeededWithUsage.length} score(s) above are already persisted and unaffected; ` +
                `only the NEXT cost estimate will fall back to the bootstrap basis. ` +
                `(${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
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
        //
        // Terminal for every failed resumeId, so each gets its durable
        // failure row (ticket 4f88339) BEFORE the ack/nack below - written
        // on both sub-branches, because a search waiting on this pair
        // needs the row whether or not some OTHER resume's score
        // succeeded.
        await recordPermanentFailures(message.jobId, attempt, links, failed);
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
        // DELIBERATE REFINEMENT OF design c54b9e0 §4.3, which says to
        // record a row per STILL-RETRYABLE resumeId here. That would leak:
        // a message carrying one permanent failure (resume A) alongside
        // one retryable failure (resume B) never passes through the
        // all-permanent branch above, so on exhaustion A would
        // dead-letter with no durable record and A's search would wait on
        // it forever. Retries are exhausted, so the message is terminal
        // for EVERY resumeId that still has a failure - record all of
        // them. Resumes that succeeded got `job_matches` rows and
        // correctly get no failure row.
        //
        // This is also where ticket b53c422's spend guard lands (design
        // §10): `SpendGuardExceededError` classifies RETRYABLE, so a
        // refused job rides the normal retry budget and arrives here,
        // where it now becomes a `kind = "spend-guard-exceeded"` failure
        // row and dead-letters. Without that row, a budget-limited search
        // would hang indefinitely instead of resolving as "complete, N
        // deferred for budget".
        await recordPermanentFailures(message.jobId, attempt, links, failed);
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
