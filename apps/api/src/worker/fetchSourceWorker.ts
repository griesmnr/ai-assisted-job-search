import { randomUUID } from "node:crypto";
import type { Job, SearchCriteria as FilterCriteria } from "@app/shared";
import type { ConfirmChannel, ConsumeMessage } from "amqplib";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobMatchFailures, searchSources, searches } from "../db/schema.js";
import { describeCrossSourceMerge, ingestJobsForSearch } from "../ingest/ingestJobs.js";
import { DEFAULT_SCORE_THRESHOLD } from "../matching/index.js";
import { compileFilter } from "../sources/criteria.js";
import {
  RateLimitedError,
  SourceError,
  type JobSource,
  type SearchCriteria,
} from "../sources/types.js";
import { FETCH_SOURCE_DLQ, FETCH_SOURCE_RETRY_TIERS } from "../queue/topology.js";

/**
 * The fetch.source worker: consumes one message per (search, source) pair,
 * calls the matching adapter, persists whatever it found idempotently
 * (ingestJobsForSearch, ticket 6bf2196), and publishes one score.job
 * message per job now linked to the search - new or already known - up to
 * whatever is left of the SEARCH-WIDE budget of `DEFAULT_SCORE_THRESHOLD`
 * jobs shared across all of that search's sources (see "THE PER-SEARCH
 * SCORING CAP" below; ingestion itself stays uncapped).
 *
 * Message shapes (JSON bodies on the "jobs" exchange):
 *
 *   fetch.source: { searchId: string; sourceId: string; criteria: SearchCriteria;
 *                   filterCriteria?: @app/shared SearchCriteria | null }
 *     - sourceId is a Job["dataSource"] value ("usajobs", "wa-state", ...)
 *       and is how this worker dispatches to the right adapter.
 *     - `criteria` and `filterCriteria` are two DIFFERENT types that happen
 *       to share a name — see `FetchSourceMessage` below, which spells out
 *       why both are on the wire and why conflating them loses information.
 *
 *   score.job: { jobId: string }
 *     - one per job linked to this search, capped at
 *       `DEFAULT_SCORE_THRESHOLD` per SEARCH (shared across its sources,
 *       see `adjudicateScoringBudget`). NOT filtered
 *       to "rows this call happened to insert" (see the note on
 *       `newlyInsertedJobIds` below) - the scoring worker (RTK-10, out of
 *       scope here) owns deduping repeated score.job messages for a job it
 *       already scored.
 *
 * COMPLETION LEDGER (ticket 4f88339): this worker also owns the per-source
 * half of the record `GET /searches/:id` derives completion from. Three
 * writes, all to the `search_sources` row addressed by (searchId,
 * sourceId): `complete` + `linkedJobCount` on success, `failed` +
 * `errorKind`/`errorMessage` on either terminal failure path, and nothing
 * at all on the retry path (a message riding a backoff tier is still
 * legitimately pending). This is what tells a poller "still waiting on 2
 * of 5 sources" apart from "this really is done", and it is what makes a
 * dead-lettered source PRODUCT-VISIBLE rather than merely logged —
 * CLAUDE.md's "the UI shows that source as unavailable, and the other
 * sources still return". Retry/DLQ behaviour itself is unchanged.
 *
 * Retry/DLQ: see topology.ts for the queue wiring this relies on
 * (fetch.source -> one of the fetch.source.retry.* tiers -> back to
 * fetch.source, or -> fetch.source.dlq). This module owns the *decision*
 * of which path a failure takes; topology.ts owns the broker-side plumbing
 * that makes the decision effective.
 *
 * Source-search deadline (ticket 491cd88): `source.search()` runs under
 * `channel.prefetch(1)` (see `startFetchSourceWorker`) with no timeout of
 * its own — a delivery stays unacked, and this consumer processes nothing
 * else, for as long as `search()` takes. A source slow enough (measured:
 * SmartRecruiters against a large board) can run past RabbitMQ's own
 * consumer ack timeout, which force-closes the CHANNEL rather than failing
 * the message.
 *
 * CORRECTION (adversarial review, ticket 491cd88, F4) — this comment
 * previously said the force-close "takes every other unacked delivery on
 * that channel down with it." Under `prefetch(1)` there is at most ONE
 * unacked delivery at a time, so "every other" is zero — that phrasing
 * overstated the harm. The real harm is what `startFetchSourceWorker`'s
 * own comment already describes correctly for a different failure mode
 * (an unhandled rejection leaving a message unacked): the channel closing
 * kills the consumer registration that lives on it, and this worker goes
 * DEAF — no exception is thrown anywhere in this process, "connection up,
 * consumer registered, no errors thrown" (that comment's own words) still
 * reads healthy from the outside, but nothing is being delivered anymore.
 * What comes back looks like a dropped connection, not a slow source, and
 * (absent a supervisor that notices and restarts the process) recovers
 * only if something reconnects the channel and re-registers the consumer.
 * `withDeadline` below races `source.search()` against
 * `sourceSearchTimeoutMs` (default `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`, see
 * its own doc comment for how that value relates to the broker's actual
 * timeout) and, on expiry, throws `SourceSearchTimeoutError` — which
 * `classify()` treats as an ordinary retryable failure, riding the exact
 * same backoff-then-DLQ path as a `TransientSourceError`, so the channel
 * never has a reason to hit that 30-minute limit in the first place.
 *
 * What this does NOT fix: a timed-out message is still redelivered from
 * the top, and `source.search()` has no notion of resuming partway through
 * — a retried attempt repeats the ENTIRE fetch, same as it always has.
 * This deadline does not make that redo-from-scratch cost go away; nothing
 * in this ticket adds checkpointing. What it changes is what happens
 * around that repeat: before this, the failure mode was an *implicit*
 * broker-side channel drop — outside this worker's own attempt counting,
 * arriving with none of `pickRetryTier`'s deliberate backoff (a
 * broker-requeued message goes straight back onto `fetch.source`, not
 * through a retry tier), and risking the deaf-consumer wedge described
 * above. After this, the same slow-source condition is an *explicit*
 * failure this worker recognizes, backs off, bounds to `maxAttempts`
 * attempts, and eventually dead-letters — the identical, accounted-for
 * path every other retryable failure already takes. Paired with
 * `maxPostings` (smartrecruiters.ts), which bounds what one attempt's
 * "from scratch" actually costs, the net effect is that a slow source now
 * fails predictably and boundedly instead of unpredictably and, in the
 * worst case, without limit. It is a faster, safer failure — not a
 * cheaper one.
 *
 * The real cost, stated plainly (adversarial review round 2, ticket
 * 491cd88, required fix 3 — the version of this paragraph before this
 * round only described the hung message's OWN fate, which understated
 * what it costs everyone else): a chronically slow/hung source burns up
 * to `maxAttempts x sourceSearchTimeoutMs` — at the defaults, 4 x 10min =
 * 40 minutes — before dead-lettering, worse in wall-clock than the ~12
 * minutes-then-channel-drop it replaces. Two things that number leaves out:
 *
 * (a) Under `prefetch(1)` (see `startFetchSourceWorker`), this consumer
 * holds exactly one unacked delivery at a time. For the full 40 minutes,
 * NO OTHER user's `fetch.source` message is delivered on this consumer -
 * this is not just the hung message's own cost, it is HEAD-OF-LINE
 * BLOCKING of every other, unrelated search queued behind it. A single
 * chronically-hung source degrades service for every user whose search
 * happens to fan out through the same consumer while it's stuck, not just
 * the one search that hit the bad source.
 *
 * (b) The retry backoff tiers (`FETCH_SOURCE_RETRY_TIERS`, topology.ts —
 * roughly 1s/2s/4s) give essentially zero relief here. They were sized
 * for fast-failing conditions - 429s, connection blips - three orders of
 * magnitude smaller than a 10-minute detection latency. The real sequence
 * for a permanently-hung source is ~40 minutes of near-continuous queue
 * stall, interrupted by about 7 seconds of backoff breathing room total
 * across all four attempts. The backoff tiers are not doing meaningful
 * work in this failure mode.
 *
 * Defensible as a first cut - bounded and accounted-for beats
 * unpredictable and unbounded - but this is worse for other users than
 * the single-message framing above suggests, and worth weighing against
 * that cost, not just against the message's own wall-clock fate. See
 * `SourceSearchTimeoutError`'s doc comment for why NOT every one of those
 * attempts is necessarily doing useful work, and whether a hung-forever
 * source deserves the full retry budget - or a dedicated, faster-timeout
 * queue so it stops blocking healthy searches - is worth revisiting.
 *
 * On `newlyInsertedJobIds` vs `linkedJobIds`: ingestJobsForSearch reports
 * both - the DB layer's distinction between "rows this call inserted" and
 * "every job this call linked to the search" is correct and useful. What
 * was wrong (caught in review) was USING `newlyInsertedJobIds` to decide
 * which jobs need a score.job message. Those two ideas only coincide on a
 * message's first, uninterrupted attempt. The moment a message is retried
 * - which is the entire reason the retry path exists - they diverge: if
 * attempt 1 inserts the job row and then fails (a publish error, a crash,
 * a dropped connection) *before* its score.job goes out, attempt 2 finds
 * the row already there, `newlyInsertedJobIds` comes back empty, and a
 * job that was never actually scored silently never gets a score.job
 * message either - total, silent loss, with the message acked as a
 * success. Publishing over `linkedJobIds` instead means a retried attempt
 * always re-publishes score.job for every job it found, at the cost of a
 * harmless duplicate message on the (rarer) case where the *entire*
 * attempt - insert *and* publish - already succeeded and only the ack was
 * lost. At-least-once delivery over score.job, with the scoring worker
 * responsible for not scoring the same job twice, is a better trade than
 * silently dropping jobs that need scoring.
 *
 * THE PER-SEARCH SCORING CAP (ticket 4f88339 review round 1 F1 for the
 * original per-SOURCE version; ticket c9c676d for the per-SEARCH one that
 * replaced it — read this before removing or loosening `adjudicateScoringBudget`
 * below).
 *
 * WHAT WENT WRONG WITHOUT ANY CAP. `POST /searches/estimate` shows the caller
 * a number that is both FILTERED (`compileFilter(criteria)`) and CAPPED
 * (`DEFAULT_SCORE_THRESHOLD`, 200 — matching/pipeline.ts applies it to
 * `needsScoreIds` before pricing anything). That number is what the user
 * reads and implicitly authorizes by clicking "Run search". The queue path
 * ticket 4f88339 introduced had NEITHER: it published one `score.job` per job
 * a source returned, unbounded. The only remaining backstop was
 * `scoreJobWorker`'s `ScoringSpendGuard` — a LIFETIME-PER-PROCESS ceiling
 * ($15, `DEFAULT_LIFETIME_SPEND_CEILING_USD`, ticket b53c422), not a
 * per-run one — so one large search could drain it and every later search
 * in that process would produce nothing but refused, dead-lettered
 * messages until someone restarted the worker. That is ticket 59fdc52
 * review round 2's ~30x estimate-vs-spend defect (see matching/pipeline.ts
 * around the `overThreshold`/`toScoreIds` slice, which documents the 30x)
 * reintroduced one layer down.
 *
 * WHY THE PER-SOURCE VERSION WAS NOT ENOUGH — the measurement that decided
 * ticket c9c676d, recomputed 2026-09-23 AFTER the quality filter landed
 * (45ea34c), not inherited from before it.
 *
 * The per-source cap bounded spend at `Σ_sources min(200, filtered_s)`.
 * The estimate is `min(200, |dedup(∪_sources filtered_s)|)`. Those two
 * expressions diverge WHENEVER THE UNION EXCEEDS 200, and — this is the
 * part that made "filtering shrank the pool, so the cap rarely binds now"
 * a false comfort — the divergence DOES NOT REQUIRE THE PER-SOURCE CAP TO
 * BIND AT ALL. Five sources returning 60 filtered jobs each are each an
 * unremarkable 30% of their own cap and still publish 300 `score.job`
 * messages against an estimate that says 200.
 *
 * That is not a hypothetical shape. This codebase's own recorded numbers
 * (`DEFAULT_SCORE_THRESHOLD`'s doc comment, matching/scoring.ts): 129
 * survivors from Greenhouse alone, a ~2% survival rate through the filter,
 * and "a four-source pool lands around 250". `sources/registry.ts` ships
 * FIVE configured adapters (usajobs, greenhouse, lever, ashby,
 * smartrecruiters), so the default, un-narrowed search — the CLI default
 * filter, the one a user gets by not typing criteria — was already expected
 * to publish ~250-310 `score.job` messages against a 200-job estimate, with
 * no single source anywhere near its own cap. The absolute worst case stayed
 * `5 x 200 = 1,000`.
 *
 * In money, using `scoreJobWorker`'s own live per-job figures (measured in
 * this repo 2026-09-21: ~$0.0388 worst-case on the bootstrap basis, ~$0.0468
 * on the measured basis) and the 2026-09-23 live smoke test (9 real scores
 * for ~$0.20, i.e. ~$0.022/job actual):
 *
 *   - Estimate shown to the user, always: 200 jobs → ~$4.40 actual /
 *     ~$7.76-$9.36 worst case.
 *   - Typical un-narrowed real spend under the per-source cap: ~250-310
 *     jobs → ~$5.50-$6.80 actual. A 1.25-1.55x overrun.
 *   - Worst case under the per-source cap: 1,000 jobs → ~$22 actual,
 *     ~$38.80-$46.80 worst case. A 5x overrun, and 1.5-3.1x the ENTIRE $15
 *     lifetime-per-process spend ceiling — so a single broad search could
 *     drain `ScoringSpendGuard` outright and leave every later search in
 *     that worker process producing nothing but refused, dead-lettered
 *     messages until an operator restarted it.
 *
 * The last line is what made this worth a real fix rather than a clearer
 * comment: the failure mode is not "the user overpaid a bit", it is "one
 * search bricks the scoring worker for every subsequent search".
 *
 * WHAT THE CAP IS NOW. A TRUE PER-SEARCH cap: across every source of one
 * search, and across every redelivery of every one of their messages, at
 * most `DEFAULT_SCORE_THRESHOLD` distinct jobs ever receive a `score.job`
 * message. That is exactly the bound `POST /searches/estimate` prices, so
 * the estimate is now an upper bound on real spend rather than a fifth of it.
 *
 * HOW, WITHOUT THE TWO MECHANISMS 4f88339 REJECTED. That ticket rejected
 * (a) a running counter — not idempotent, since a redelivered message
 * re-increments — and (b) a live cross-worker query — racy, since two
 * workers can both read-then-publish past the cap. Both objections are
 * about the same missing ingredient: a durable, SET-never-incremented claim
 * plus serialization. This has both.
 *
 *   - The claim is `search_sources.published_job_count` (schema.ts): how
 *     many `score.job` messages THIS (search, source) pair has published.
 *     SET, never incremented — the identical idempotency posture
 *     `linked_job_count` next to it already has, so a redelivery overwrites
 *     it with the same value instead of doubling it.
 *   - The serialization is `pg_advisory_xact_lock(hashtext(search_id))`,
 *     scoped PER SEARCH. Exactly the pattern `routes/searches.ts` already
 *     uses (hashed by `resume_id`) for the in-flight-search guard, and for
 *     the same reason: a read-then-write that must not interleave.
 *     Transaction-scoped, so COMMIT/ROLLBACK releases it with nothing to
 *     leak. Different searches never contend; `hashtext` collisions between
 *     two unrelated searches cost brief serialization, never a wrong answer,
 *     because the query inside the lock filters on `search_id` itself.
 *
 * THE ARITHMETIC, AND THE INVARIANT IT MAINTAINS. Under the lock, a source
 * reads every `published_job_count` for its search, sums the OTHER sources'
 * (NULL → 0: a source that has not adjudicated yet reserves nothing), and
 * takes what is left:
 *
 *     remaining = max(0, 200 - claimedByOtherSources)
 *     allowance = max(previousClaimOfThisSource, remaining)   // monotone
 *     published = min(linkedJobIds.length, allowance)
 *
 * The `max(previousClaim, ...)` is load-bearing, not defensive. Without it
 * a redelivery whose siblings have since claimed budget would compute a
 * SMALLER allowance and "un-publish" jobs it already sent — writing capped
 * rows for jobs that are already being scored, and letting the set of jobs
 * that ever received a `score.job` drift above 200 across a search's
 * lifetime even though no single instant exceeded it. With it, each
 * source's published set is a MONOTONE, non-shrinking prefix of a
 * deterministically-ordered list, so "how many jobs did this search ever
 * send for scoring" equals `Σ published_job_count`, which the invariant
 * below bounds directly.
 *
 * INVARIANT: `Σ_sources published_job_count ≤ DEFAULT_SCORE_THRESHOLD`,
 * maintained at every adjudication. Proof is one case split on the `max`.
 * If `remaining` wins, then `published + claimedByOtherSources ≤ 200` by
 * construction. If `previousClaim` wins, the sum is unchanged from the last
 * adjudication, which satisfied the invariant by induction. Base case: every
 * claim is NULL/0. The lock is what makes "claimedByOtherSources" a value
 * nobody can invalidate between the read and the write.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make the estimate EXACT,
 * and the residual gap is one-directional in ROLES scored — real runs score
 * fewer distinct roles than estimated, never more. Opus review, ticket
 * c9c676d: this does NOT mean real DOLLARS can never exceed the estimate.
 * The cross-source dedupe gap below (fewer distinct roles, but per-source
 * rather than per-union) means a role cross-posted to N boards can be
 * scored N times here against 1 time in the estimate — more Claude calls,
 * more real spend, for fewer distinct roles. Bounded well under the $15
 * lifetime ScoringSpendGuard regardless (200 jobs total per search caps
 * this at ~$4.40-$9.36), which is the catastrophic failure mode this
 * ticket exists to kill — but "never above" was true only for role count,
 * not dollars, and the two were conflated in this sentence before the fix:
 *
 *   - Cross-source dedupe. `compileFilter` dedupes on `${company}|${title}`;
 *     the estimate dedupes the UNION, this worker sees one source per
 *     message and dedupes per source (see "ONE KNOWN DIFFERENCE FROM THE
 *     CLI" below). A role cross-posted to two boards can consume two slots
 *     of the 200 here and one in the estimate, so the real run scores FEWER
 *     distinct roles than estimated, never more.
 *   - Already-scored jobs are free in the estimate (`candidatesNeedingScore`
 *     excludes them) but still consume a slot here, because this worker does
 *     not know which jobs `scoreJobWorker` will find already scored.
 *     Again: fewer real Claude calls than priced, never more.
 *   - First-come, first-served between sources. Whichever source adjudicates
 *     first takes what it needs; a source that adjudicates once the budget
 *     is spent scores nothing and reports all of its jobs as
 *     `SCORE_THRESHOLD_CAPPED_KIND`. That is a deliberate choice of
 *     simplicity over fairness — an even N-way split would starve a source
 *     that legitimately found 3 jobs to make room for one that found 3,000 —
 *     and it is why the cap binding is now VISIBLE in the API response
 *     (`cappedForBudget`, @app/shared) rather than silently indistinguishable
 *     from a scoring failure.
 *
 * WHY THE SLICE IS DETERMINISTIC, AND WHY THAT MATTERS. This whole file is
 * built on "a redelivery re-runs the same work and writes the same rows".
 * `ingestJobsForSearch` returns `linkedJobIds` in a stable order — verified
 * by reading it, not assumed: it builds a `Map` keyed by `externalId` from
 * `normalizedJobs` (insertion-ordered), takes `[...map.values()]`, and
 * pushes onto `linkedJobIds` in exactly that order. So for a given
 * `result.jobs` the first N ids are the SAME first N ids on every
 * redelivery, and a retried attempt republishes precisely the set it
 * published before. (If the SOURCE itself returns postings in a different
 * order on a later attempt, a different subset can be capped — harmless:
 * score.job is already at-least-once, the failure rows below are
 * `ON CONFLICT DO NOTHING`, and the completion derive prefers a
 * `job_matches` row over a `job_match_failures` row for the same pair.)
 *
 * WHY THE CAPPED JOBS GET A `job_match_failures` ROW, AND WHY THE LEDGER'S
 * `linkedJobCount` DOES NOT CHANGE. `ingestJobsForSearch` runs BEFORE the
 * cap and links everything — every capped job has a real `search_results`
 * row. Capping only the publish loop would therefore create a NEW and worse
 * bug than the one being fixed: the completion derive
 * (`sourcesSettled && outstanding === 0`, routes/searches.ts) counts a job
 * as outstanding while it has neither a `job_matches` nor a
 * `job_match_failures` row for the search itself (for the search's resume,
 * before ticket 9a53485) — and a job that was
 * never sent a `score.job` will never get either, so the search would hang
 * pending FOREVER. Two ways out were available; this takes the one that
 * keeps ingestion honest:
 *
 *   - NOT chosen: cap before ingest, so the extra jobs are never linked.
 *     That would make `search_results` a lie about what the source returned
 *     and would break `DEFAULT_SCORE_THRESHOLD`'s own stated contract
 *     ("INGESTION has no truncation-by-order cap at all, full stop" —
 *     matching/scoring.ts). The CLI path caps SCORING, never ingestion, and
 *     this path must match it.
 *   - CHOSEN: link everything, publish the first N, and write a
 *     `job_match_failures` row (kind `SCORE_THRESHOLD_CAPPED_KIND`) for the
 *     rest. That table already means exactly "we are not going to produce a
 *     score for this (resume, job) pair", which is precisely true here, and
 *     it is ADVISORY FOR COMPLETION ONLY — it never gates scoring (see its
 *     doc comment in db/schema.ts), so republishing a capped job later
 *     scores it normally. `linked_job_count` stays the TRUE number of jobs
 *     this source linked, because that is what the derive and the UI mean
 *     by it; capping it there would desynchronize the ledger from
 *     `search_results` for no gain.
 *
 * CLOSED (ticket c9c676d) — this used to read "the one honest wart: a capped
 * job is reported to the caller as `permanentlyFailed`/`degraded`, alongside
 * genuine scoring failures, which overstates how badly the search went". It
 * no longer is: `deriveSearchState` (routes/searches.ts) now splits the
 * `job_match_failures` count on `kind = SCORE_THRESHOLD_CAPPED_KIND`, and
 * `GET /searches/:id` reports the two separately (`cappedForBudget` vs
 * `permanentlyFailed`), with `degraded` keyed to genuine failures only. That
 * matters more now, not less: a per-SEARCH cap caps strictly more jobs than
 * the per-SOURCE one it replaced, so an honest presentation of "not scored
 * because the budget ran out" is what keeps the tighter cap from reading as
 * a fleet of new failures.
 *
 * THE QUALITY FILTER (ticket 45ea34c — read this before moving the
 * `compileFilter` call in the handler).
 *
 * WHAT WENT WRONG WITHOUT IT. None of the five source adapters does
 * meaningful server-side title/location filtering (routes/searches.ts's own
 * header: "every one of these adapters has no (or only partial) server-side
 * query support"), so until this ticket the user's stated criteria took
 * effect ONLY on the synchronous paths — the CLI's `runDemoMatch`, which
 * applies `compileFilter(criteria)` between fetching and scoring, and
 * `POST /searches/estimate`, which shares that path. The queue path had no
 * equivalent: it ingested every posting a source returned and published
 * `score.job` for the first `DEFAULT_SCORE_THRESHOLD` of them IN RAW BOARD
 * ORDER. Confirmed live 2026-09-23 (git-bug 45ea34c): a search for
 * titleInclude ["Staff Software Engineer"] / nearLocations ["Seattle, WA"]
 * — estimated at 1 job — linked all 6,418 Greenhouse postings and scored
 * 200 mostly-unrelated roles (Account Executive, sales, ...). The cap
 * bounds HOW MANY jobs a run scores; this filter is what decides WHICH.
 *
 * WHERE IT IS APPLIED, AND WHY THERE. On `result.jobs`, BEFORE
 * `ingestJobsForSearch` — the exact position `runDemoMatch` uses (its
 * `filter(found)` runs before its own ingest loop), so the two paths agree
 * on what a search contains, not merely on what it scores. Consequences,
 * stated plainly because they are load-bearing:
 *
 *   - `search_results` and `search_sources.linkedJobCount` only ever hold
 *     jobs that actually match the user's criteria. That is the CLI's
 *     established meaning of those rows, and matching it is the whole point.
 *   - This is NOT in tension with `DEFAULT_SCORE_THRESHOLD`'s "ingestion has
 *     no truncation-by-order cap at all" contract (matching/scoring.ts), and
 *     the distinction matters: that contract forbids dropping jobs by
 *     ARBITRARY POSITION in board order — which is exactly what the "NOT
 *     chosen: cap before ingest" option under the cap section above would
 *     have done. Dropping jobs the caller's own criteria reject is not
 *     truncation; it is the criteria doing their job, and the CLI has always
 *     done it at this point.
 *   - Filtering AFTER ingest was considered and rejected: a job that fails
 *     the user's filter was never part of this search, so recording it as a
 *     `search_results` row and then a `job_match_failures` row would invent a
 *     "failure" category for something that never failed, and un-ingesting an
 *     already-published row is a materially worse data-integrity story than
 *     never creating one.
 *   - The cap now applies to an already-relevant pool rather than a whole raw
 *     board, so it should rarely bind on a normal search at all.
 *
 * ONE KNOWN DIFFERENCE FROM THE CLI, deliberate and structural: `compileFilter`
 * also dedupes on `${company}|${title}`. `runDemoMatch` filters the UNION of
 * every source's jobs, so its dedupe collapses a cross-posted opening across
 * sources; this worker sees exactly one source per message, so its dedupe is
 * PER SOURCE. Making it per-search would need cross-worker coordination for
 * the same reasons a per-search scoring cap does (see the cap section above).
 * Duplicates across sources were already deduped one layer down anyway —
 * `ingestJobsForSearch` upserts on (dataSource, externalId) — this only means
 * the same role cross-posted to two boards can still be linked twice.
 *
 * `compileExcludedForMissingWorkArrangement` (sources/criteria.ts) is
 * deliberately NOT computed here. It is pure telemetry feeding
 * `SourceOutcome.excludedForMissingWorkArrangement`, and the queue path has no
 * `SourceOutcome`: its durable read contract is `SearchSourceState`, which
 * @app/shared's own doc comment says is deliberately thinner ("no
 * boardCoverage, no skipRate, no survivedFilter ... persisting the richer
 * per-source telemetry is real follow-up work, deliberately not smuggled in
 * here"). Computing it would produce a number with nowhere to go, and for any
 * EXPLICIT criteria it is identically zero by construction (that function
 * returns `() => []` for anything but `undefined`). If the richer per-source
 * telemetry is ever persisted, this is the line it gets computed on.
 */

export const JOBS_EXCHANGE = "jobs";
export const FETCH_SOURCE_QUEUE = "fetch.source";
export const SCORE_JOB_ROUTING_KEY = "score.job";

/** RabbitMQ does not count delivery attempts for you - this header is how
 * the worker tracks it across a retry's dead-letter round trip. Absent on
 * a message's first delivery (it came straight from whatever published to
 * the "jobs" exchange, which knows nothing about retries), which is
 * treated as attempt 1. */
const ATTEMPT_HEADER = "x-attempt";

/** Caps how many individual `SkippedRecord.reason` lines this worker logs
 * per message (see the "log skip reasons" block in the handler below,
 * ticket 491cd88 F2). Not unbounded: some adapters can legitimately
 * return hundreds of per-record skips in one `result.skipped`, and
 * logging every one of those on every message would flood whatever this
 * worker's `log` hook writes to. 20 is enough to see a real pattern (or
 * the one truncation record a capped SmartRecruiters search produces)
 * without turning a single message into a wall of log lines; anything
 * past the cap is summarized as a count instead of dropped silently. */
const SKIPPED_LOG_LIMIT = 20;

/**
 * `job_match_failures.kind` written for a job this worker linked but
 * deliberately did not send a `score.job` for, because the search's scoring
 * budget was already spent (see the module doc comment's "THE PER-SEARCH
 * SCORING CAP" section). Exported so tests — and the read path that presents
 * "deferred by the spend cap" differently from "scoring genuinely failed" —
 * can name it instead of retyping the string.
 *
 * Distinct from every `kind` `scoreJobWorker`'s `classifyScoringError()`
 * produces ("auth-failed", "rate-limited", "spend-guard-exceeded", ...) on
 * purpose: those record a job whose scoring was ATTEMPTED and failed; this
 * records one that was never attempted at all.
 *
 * READ BY `routes/searches.ts` (ticket c9c676d): `deriveSearchState` filters
 * the `job_match_failures` aggregate on exactly this string to split
 * `cappedForBudget` out of `permanentlyFailed`, and `degraded` keys off the
 * latter only. The string is therefore part of the API contract now, not just
 * a diagnostic — changing its value without a migration would silently
 * reclassify every historical capped row as a genuine failure.
 */
export const SCORE_THRESHOLD_CAPPED_KIND = "score-threshold-capped";

/**
 * How many `job_match_failures` rows go into one INSERT when the cap binds.
 *
 * Not tuning for tuning's sake: a single unfiltered source (SmartRecruiters
 * lists 4,771 postings for ONE company — see `DEFAULT_SCORE_THRESHOLD`'s
 * doc comment) can leave thousands of jobs past the cap, and each row binds
 * 7 parameters (6 before ticket 9a53485 added `search_id`). Postgres's wire
 * protocol caps a single statement at 65,535 bound parameters, so an
 * unchunked insert of ~9,400 capped jobs would fail outright — and it would
 * fail on the SUCCESS path, turning a search that worked into a
 * retried-then-dead-lettered one. 500 rows (3,500 parameters) is far inside
 * the limit with room for the row shape to grow.
 */
const CAPPED_FAILURE_INSERT_CHUNK = 500;

/**
 * The transaction handle drizzle hands a `db.transaction()` callback.
 * Derived from `NodePgDatabase` rather than imported from a deep
 * `drizzle-orm/pg-core` path so it cannot drift from whatever `db` actually
 * is here (the worker is constructed with `NodePgDatabase<any>`, and
 * `tx.select`/`tx.insert`/`tx.update`/`tx.execute` are the only surface
 * `adjudicateScoringBudget` and `recordCappedJobs` use).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = Parameters<Parameters<NodePgDatabase<any>["transaction"]>[0]>[0];

/**
 * What `adjudicateScoringBudget` decided, for the caller to act on and log.
 * Every field is a number the log line needs to make the decision
 * intelligible — "this source published 40 of the 300 it linked" is not an
 * explanation until you know its siblings had already claimed 160.
 */
type BudgetAdjudication = {
  /** The prefix of `linkedJobIds` that gets a `score.job` message. */
  toPublishJobIds: string[];
  /** The rest — already recorded as `SCORE_THRESHOLD_CAPPED_KIND` rows. */
  cappedJobIds: string[];
  /** `Σ published_job_count` over this search's OTHER sources, read under
   * the lock. NULL claims (sources that have not adjudicated) count 0. */
  claimedByOtherSources: number;
  /** This source's own claim before this adjudication: 0 on a first
   * attempt, the previously-published count on a redelivery. */
  previousClaim: number;
  /** `max(previousClaim, DEFAULT_SCORE_THRESHOLD - claimedByOtherSources)` —
   * how many jobs this source was allowed to publish. */
  allowance: number;
  /** False when this (search, source) pair has no `search_sources` row to
   * record the claim on. See `adjudicateScoringBudget` for when that can
   * happen and why it degrades rather than throws. */
  hasLedgerRow: boolean;
};

export type FetchSourceMessage = {
  searchId: string;
  sourceId: string;
  /**
   * FETCH-level criteria: `sources/types.ts`'s `SearchCriteria`
   * (`keyword`/`keywords`/`location`), handed straight to
   * `source.search()`. This is a QUERY HINT for the source's own API, and
   * an imprecise one — most adapters act on little or none of it (see that
   * type's own doc comments). It is NOT, and never was, sufficient to
   * enforce what the user asked for.
   */
  criteria: SearchCriteria;
  /**
   * LOCAL, post-fetch filter criteria: `@app/shared`'s `SearchCriteria`
   * (`titleInclude`/`titleExclude`/`nearLocations`/`remoteOk`/
   * `commitmentIn`), compiled by `compileFilter` (sources/criteria.ts) and
   * applied to `result.jobs` before ingestion. Ticket 45ea34c.
   *
   * SEPARATE FROM `criteria` ABOVE ON PURPOSE. The two are different types
   * that share a name, and they answer different questions: `criteria` asks
   * a source to narrow its own result set (best-effort, mostly ignored),
   * while this decides which postings are actually part of this search.
   * `routes/searches.ts`'s `buildFetchCriteria` narrows the rich shape down
   * to `{ keywords: [...] }` for the adapter call — `titleExclude`,
   * `nearLocations`, `remoteOk` and `commitmentIn` do not survive that
   * translation — so reusing one field for both would silently throw away
   * exactly the information `compileFilter` needs.
   *
   * THE WIRE FORMAT FOR `compileFilter`'S THREE-WAY STATE (the decision
   * ticket 45ea34c's scope asked for, made explicit rather than implied):
   *
   *   - an OBJECT -> `compileFilter(thatObject)`. An explicit `{}` is a real
   *     if maximally permissive criteria object (no title/location/commitment
   *     restriction, company|title dedupe only) — identical to what
   *     `POST /searches/estimate` does with an explicit `{}` body.
   *   - `null` -> `compileFilter(undefined)`, i.e. the CLI DEFAULT filter
   *     (`filterSoftwareEngineeringJobs`). `null`, not "field omitted",
   *     because JSON.stringify DROPS an `undefined`-valued key, so "the
   *     caller supplied no criteria" and "the publisher predates this field"
   *     would otherwise be the same bytes on the wire and could not be told
   *     apart. `routes/searches.ts` therefore sends an explicit `null` when
   *     the request body has no `criteria`.
   *   - ABSENT -> no filtering at all, plus a loud log line naming the
   *     message. Reachable only from a publisher that predates this field or
   *     hand-rolls a message (the route always sets it), and the two
   *     candidate meanings for absence are both wrong in a way worth
   *     avoiding: silently applying the CLI's opinionated software-engineering
   *     filter would change what an old message means without anyone asking,
   *     and rejecting the message outright would dead-letter work that is
   *     otherwise perfectly valid. Passing it through unfiltered and SAYING SO
   *     is the one option that neither invents intent nor destroys the
   *     message.
   */
  filterCriteria?: FilterCriteria | null;
};

export type ScoreJobMessage = {
  jobId: string;
};

/** The message body didn't parse as JSON or didn't match FetchSourceMessage.
 * Retrying will parse it identically and fail identically - not a
 * SourceError (nothing from a source adapter is involved yet), but the
 * same "give up immediately" logic applies. */
export class InvalidMessageError extends Error {}

/** sourceId named an adapter this worker process doesn't have registered.
 * A config/deploy problem, not a transient one - retrying won't add the
 * adapter. */
export class UnknownSourceError extends Error {}

/** The adapter registered under `sourceId` reports a different
 * `JobSource["dataSource"]` than the key it's registered under (e.g. a
 * copy/paste bug wiring `sources["wa-state"] = usajobsSource`). Ingesting
 * under this mismatch writes rows tagged with the adapter's *own*
 * dataSource while querying/linking under the message's `sourceId` -
 * `ingestJobsForSearch` would insert a job, then fail to find it again
 * under the wrong dataSource, link nothing, and (before this check
 * existed) that "nothing to link" silently looked like an empty search
 * rather than a config bug. Retrying changes nothing about the
 * registration, so this is not retryable. */
export class SourceMismatchError extends Error {}

/** `source.search()` did not settle within `sourceSearchTimeoutMs` (see
 * `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`). Thrown by THIS WORKER, not by the
 * adapter - `JobSource#search` has no cancellation signal in its
 * interface, so the original call is simply abandoned, not stopped; it
 * keeps running as an ORPHAN in the background, and whatever it
 * eventually resolves or rejects with is discarded.
 *
 * CORRECTION (adversarial review, ticket 491cd88, F3) — this comment used
 * to wave that orphan away as "bounded, in practice, by whatever
 * per-request timeout the adapter itself uses internally." That is an
 * ASSUMPTION ABOUT ADAPTERS, not something `withDeadline` enforces - and
 * this deadline is deliberately generic, wrapping every dispatched
 * source, not only ones with a well-behaved internal timeout. Measured
 * directly against the real SmartRecruitersSource (a probe forcing the
 * deadline to fire mid-fetch), existing unverified claim now dated for
 * the first time (adversarial review round 2, ticket 491cd88, required
 * fix 2) rather than re-measured this round — verified-live date 2026-09-02
 * is when the date was added, not when the probe was re-run: at the moment
 * the deadline expired, 85 detail requests had been issued; 1,500ms later,
 * 400 had been issued - 315 MORE went out after this worker had already
 * given up on the call and moved on to retrying/dead-lettering the
 * message. Peak concurrent in-flight requests briefly went from the
 * adapter's configured 5 to 10, when the RETRY's own 5 concurrent requests
 * overlapped the still-running orphan's.
 *
 * CORRECTION (adversarial review round 2, ticket 491cd88, required fix 2)
 * — the previous version of this comment claimed that peak-of-10 violated
 * "smartrecruiters.ts's own declared, measured invariant ('peak in-flight
 * verified at exactly 5')." That quote does not exist anywhere in
 * smartrecruiters.ts (grepped to confirm) - it was fabricated. What
 * `DEFAULT_DETAIL_CONCURRENCY`'s doc comment in smartrecruiters.ts
 * actually declares is the opposite posture: "30 concurrent detail
 * fetches against BoschGroup completed with zero 429s or errors. Kept
 * well below that observed-safe ceiling." A transient peak of 10 violates
 * nothing - it is comfortably inside that file's own measured-safe
 * ceiling of 30. The orphan-overlap finding above is still real and still
 * worth documenting (it is genuine extra load nobody had accounted for
 * before this ticket), it just is not a broken invariant - it is a
 * documented deviation from the steady-state concurrency of 5, well
 * inside the real measured-safe ceiling.
 *
 * For SmartRecruiters specifically this stays bounded: its detail
 * fan-out is a finite loop with its own 15s-per-request timeout
 * (`requestTimeoutMs`), so at most one orphaned attempt can ever overlap
 * one live attempt before the orphan finishes settling on its own. That
 * is a property of THIS adapter's own internal timeout, not of
 * `withDeadline` - a source whose underlying calls can hang indefinitely
 * (no internal timeout, or a bug that leaves a promise permanently
 * pending) has NOTHING here stopping its orphans from accumulating: every
 * timed-out attempt on every retried message leaves one more orphan
 * running forever, so a chronically slow queue can retain up to
 * `maxAttempts` orphans PER MESSAGE still in flight - O(maxAttempts x
 * queued messages), not O(maxAttempts) - none of them ever cancelled,
 * all of them still holding whatever connections/memory they acquired.
 * The real fix is threading an `AbortSignal` through `JobSource#search`
 * so a timeout can actually stop the call, not just stop waiting on it;
 * that's a breaking interface change across all five adapters and gets
 * its own ticket.
 *
 * Retryable: nothing here proves the source can never finish, only that
 * it didn't finish in time, the same posture `TransientSourceError`
 * takes - but this is deliberately NOT a `SourceError` subclass, since
 * the source itself reported nothing; this is a worker-imposed policy on
 * top of a source that may otherwise be healthy. See the module doc
 * comment's "Source-search deadline" section for why this exists and what
 * it does and does not fix about repeated work on retry. */
export class SourceSearchTimeoutError extends Error {}

/**
 * How long one `source.search()` call is allowed to run before this
 * worker gives up on it explicitly, rather than letting RabbitMQ's own
 * consumer ack timeout force-close the channel out from under it.
 *
 * Not guessed: this project's `docker-compose.yml` sets no
 * `consumer_timeout` (no `rabbitmq.conf` is mounted into the `rabbitmq`
 * service either), so the broker - `rabbitmq:3.13.7-management` - runs on
 * its own documented default, 30 minutes (1,800,000ms;
 * https://www.rabbitmq.com/docs/3.13/consumers). Past that, under
 * `prefetch(1)` (see `startFetchSourceWorker`) there is at most one
 * unacked delivery to begin with, but the broker still force-closes the
 * CHANNEL with a 406 PRECONDITION_FAILED - killing the consumer
 * registration that lives on it and leaving this worker deaf (see the
 * module doc comment's "Source-search deadline" section for the corrected
 * description of that harm) - which is precisely the failure ticket
 * 491cd88 measured against a real SmartRecruiters board (BoschGroup: ~12
 * minutes for a real search, ~2.5 hours at the adapter's own configured
 * pagination ceiling before its `maxPostings` cap existed).
 *
 * Set well under that 30-minute limit, not up against it, for two reasons:
 * (1) `source.search()` is not the only work holding this delivery
 * unacked - `ingestJobsForSearch` and the score.job publish/confirm that
 * follow it (see `createFetchSourceHandler`) run AFTER `search()` returns,
 * inside the SAME unacked window, and need their own headroom; (2) margin
 * for scheduler/network jitter on top of the deadline timer itself. 10
 * minutes leaves 3x headroom under the broker's limit for that. It is
 * still generous per search: at SmartRecruiters' own measured rate
 * (0.148s/posting at `detailConcurrency: 5` - see smartrecruiters.ts),
 * 10 minutes bounds roughly 4,000 total detail fetches, well above what a
 * `maxPostings`-capped company search needs (smartrecruiters.ts's default
 * cap is sized to finish in ~148s on its own).
 *
 * Deliberately generic, not SmartRecruiters-specific: this wraps
 * `source.search()` for every dispatched source (see `sources` on
 * `FetchSourceWorkerOptions`), not just SmartRecruiters - any adapter
 * could in principle hang or run long enough to reproduce the same
 * channel-drop failure mode; SmartRecruiters is the adapter that surfaced
 * it, not the only one this protects.
 */
export const DEFAULT_SOURCE_SEARCH_TIMEOUT_MS = 10 * 60 * 1000;

/** Races `promise` against a `timeoutMs` timer, rejecting with
 * `SourceSearchTimeoutError` if the timer wins. Does not, and cannot,
 * cancel `promise` - see `SourceSearchTimeoutError`'s doc comment. Safe
 * against an unhandled rejection from the "losing" promise: `Promise.race`
 * attaches its own `.then`/`.catch` to every promise passed to it,
 * including ones whose outcome it ends up discarding, so a later
 * rejection from `promise` after the timer has already won is still a
 * "handled" rejection as far as Node is concerned. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, describe: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SourceSearchTimeoutError(`${describe} did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type HighSkipRateInfo = {
  searchId: string;
  sourceId: string;
  skipRate: number;
  jobCount: number;
  skippedCount: number;
};

export type RetryTier = { readonly queue: string; readonly delayMs: number };

export type FetchSourceWorkerOptions = {
  channel: ConfirmChannel;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /** Adapter registry, keyed by Job["dataSource"] / sourceId. A `Partial`
   * because a worker process may not have every source's credentials
   * configured; dispatching to a missing one is an UnknownSourceError, not
   * a crash. */
  sources: Partial<Record<string, JobSource>>;
  /** Total delivery attempts (including the first) before giving up and
   * dead-lettering a retryable failure. 3-5 per ticket 568cc5f; defaults to
   * 4. */
  maxAttempts?: number;
  /** Backoff delay tiers, ordered shortest to longest, one durable queue
   * per tier. Defaults to `FETCH_SOURCE_RETRY_TIERS` from topology.ts (the
   * queues `setupTopology()` actually declares). Overridable so tests can
   * use short-lived tiers instead of waiting on real-world backoff -
   * whatever is passed here MUST already exist as a queue wired the same
   * way topology.ts wires its tiers (queue-level TTL, dead-letter back to
   * "jobs"/"fetch.source"), which `startFetchSourceWorker` checks at
   * startup (see below) rather than discovering it per-message. */
  retryTiers?: ReadonlyArray<RetryTier>;
  /** How long a single `source.search()` call is allowed to run before
   * this worker fails it explicitly (`SourceSearchTimeoutError`, retried
   * like any other transient failure) instead of letting RabbitMQ's own
   * consumer ack timeout drop the channel out from under it. Defaults to
   * `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS`; see that constant's doc comment
   * for how the default was chosen and the module doc comment's
   * "Source-search deadline" section for what this does and doesn't fix. */
  sourceSearchTimeoutMs?: number;
  /** skipRate at or above this, on a non-empty result, is treated as a
   * mapper-bug/upstream-schema-change signal rather than a quiet success.
   * Defaults to 0.5. */
  highSkipRateThreshold?: number;
  /** Called (in addition to processing whatever jobs *did* map) when a
   * result's skipRate crosses highSkipRateThreshold. Defaults to a loud
   * console.error so this is never silent; inject a real alerting hook in
   * production. */
  onHighSkipRate?: (info: HighSkipRateInfo) => void;
  /** Structured-ish logging hook for retry/dead-letter decisions. Defaults
   * to console.error. */
  log?: (message: string) => void;
};

function defaultOnHighSkipRate(info: HighSkipRateInfo): void {
  console.error(
    `[fetch.source] HIGH SKIP RATE: source=${info.sourceId} search=${info.searchId} ` +
      `${info.skippedCount}/${info.jobCount + info.skippedCount} records unmapped ` +
      `(skipRate=${info.skipRate.toFixed(2)}). This usually means a mapper bug or an ` +
      `upstream schema change, not an empty search - investigate, don't ignore.`,
  );
}

/** The closed set `Job["commitment"]` allows. Duplicated here (three
 * literals) rather than exported from @app/shared because it is a TYPE
 * there, with no runtime value to import — and a validator has to compare
 * against real strings. */
const COMMITMENT_VALUES: ReadonlyArray<NonNullable<Job["commitment"]>> = [
  "full-time",
  "part-time",
  "contract",
];

function parseStringArrayField(
  criteria: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const raw = criteria[field];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    throw new InvalidMessageError(
      `fetch.source message field "filterCriteria.${field}" must be an array of strings`,
    );
  }
  return raw as string[];
}

/**
 * Validates and normalizes `FetchSourceMessage.filterCriteria`. See that
 * field's doc comment for what each of the three return values means
 * (`undefined` = absent, `null` = CLI default, an object = explicit
 * criteria).
 *
 * Rebuilds the object field by field rather than casting the parsed body,
 * so a malformed payload becomes an `InvalidMessageError` — which
 * `classify()` already treats as non-retryable, dead-lettering with a real
 * message — instead of reaching `compileFilter` and throwing something
 * unclassified from inside `makePhraseMatcher` (`.map` on a non-array,
 * `.replace` on a number) on every redelivery. Unknown keys are dropped,
 * not rejected: a newer publisher adding a field must not dead-letter every
 * message a not-yet-redeployed worker sees.
 *
 * Deliberately validates TYPES ONLY, not semantics. An empty-string phrase,
 * for instance, is passed through untouched even though `compileFilter`
 * turns it into a match-everything matcher — because `POST /searches/estimate`
 * passes the request body's criteria to the very same `compileFilter`
 * without trimming or rejecting it either, and "identical filtering to the
 * estimate" (this ticket's first acceptance criterion) means identical
 * including the warts. `commitmentIn` is the one exception, and only
 * because its failure mode is silent and total: an unrecognized value there
 * makes a non-empty restriction that NOTHING can satisfy, so every posting
 * is excluded and the search legitimately returns nothing with no error
 * anywhere. Worth a loud rejection.
 */
function parseFilterCriteria(body: Record<string, unknown>): FilterCriteria | null | undefined {
  const raw = body.filterCriteria;
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidMessageError(
      'fetch.source message field "filterCriteria" must be an object, null, or absent',
    );
  }

  const criteria = raw as Record<string, unknown>;
  const titleInclude = parseStringArrayField(criteria, "titleInclude");
  const titleExclude = parseStringArrayField(criteria, "titleExclude");
  const nearLocations = parseStringArrayField(criteria, "nearLocations");

  const remoteOkRaw = criteria.remoteOk;
  if (remoteOkRaw !== undefined && typeof remoteOkRaw !== "boolean") {
    throw new InvalidMessageError(
      'fetch.source message field "filterCriteria.remoteOk" must be a boolean',
    );
  }

  // Ticket 410e1a2. Parsed here, not just accepted by the route's schema:
  // this is the LAST hop before `compileFilter`, and a field this function
  // does not copy into its return value is silently dropped -- the user
  // would check the box, the request would 200, and the search would run
  // strict anyway.
  const expandMetroAreasRaw = criteria.expandMetroAreas;
  if (expandMetroAreasRaw !== undefined && typeof expandMetroAreasRaw !== "boolean") {
    throw new InvalidMessageError(
      'fetch.source message field "filterCriteria.expandMetroAreas" must be a boolean',
    );
  }

  const commitmentRaw = parseStringArrayField(criteria, "commitmentIn");
  if (commitmentRaw !== undefined) {
    const unknown = commitmentRaw.filter(
      (value) => !(COMMITMENT_VALUES as readonly string[]).includes(value),
    );
    if (unknown.length > 0) {
      throw new InvalidMessageError(
        `fetch.source message field "filterCriteria.commitmentIn" has unrecognized value(s) ` +
          `${unknown.map((v) => JSON.stringify(v)).join(", ")} - allowed: ` +
          `${COMMITMENT_VALUES.join(", ")}`,
      );
    }
  }

  return {
    ...(titleInclude !== undefined ? { titleInclude } : {}),
    ...(titleExclude !== undefined ? { titleExclude } : {}),
    ...(nearLocations !== undefined ? { nearLocations } : {}),
    ...(expandMetroAreasRaw !== undefined ? { expandMetroAreas: expandMetroAreasRaw } : {}),
    ...(remoteOkRaw !== undefined ? { remoteOk: remoteOkRaw } : {}),
    ...(commitmentRaw !== undefined
      ? { commitmentIn: commitmentRaw as NonNullable<Job["commitment"]>[] }
      : {}),
  };
}

export function parseFetchSourceMessage(content: Buffer): FetchSourceMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch (err) {
    throw new InvalidMessageError("fetch.source message body was not valid JSON", {
      cause: err,
    });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidMessageError("fetch.source message body was not a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  if (typeof body.searchId !== "string" || body.searchId.length === 0) {
    throw new InvalidMessageError('fetch.source message missing string field "searchId"');
  }
  if (typeof body.sourceId !== "string" || body.sourceId.length === 0) {
    throw new InvalidMessageError('fetch.source message missing string field "sourceId"');
  }
  if (typeof body.criteria !== "object" || body.criteria === null) {
    throw new InvalidMessageError('fetch.source message missing object field "criteria"');
  }

  const filterCriteria = parseFilterCriteria(body);

  return {
    searchId: body.searchId,
    sourceId: body.sourceId,
    criteria: body.criteria as SearchCriteria,
    // Spread, not `filterCriteria: filterCriteria`: the ABSENT case has to
    // stay absent (`"filterCriteria" in message === false`), because that
    // is what the handler below distinguishes from an explicit `null`.
    ...(filterCriteria !== undefined ? { filterCriteria } : {}),
  };
}

type Classification = { retryable: boolean; kind: string };

function classify(err: unknown): Classification {
  if (err instanceof SourceError) {
    return { retryable: err.retryable, kind: err.kind };
  }
  if (err instanceof InvalidMessageError) {
    return { retryable: false, kind: "invalid-message" };
  }
  if (err instanceof UnknownSourceError) {
    return { retryable: false, kind: "unknown-source" };
  }
  if (err instanceof SourceMismatchError) {
    return { retryable: false, kind: "source-mismatch" };
  }
  if (err instanceof SourceSearchTimeoutError) {
    // Retryable, same posture as TransientSourceError - see this class's
    // own doc comment for why it's a distinct kind rather than folded into
    // "unknown" below.
    return { retryable: true, kind: "source-search-timeout" };
  }
  // Anything else (DB connection blip, a bug we didn't anticipate, ...) is
  // *not* assumed permanent - unlike SourceError's non-retryable kinds, we
  // have no evidence a retry is futile. But it still rides the same
  // bounded retry-then-DLQ path as everything else, so an unanticipated
  // failure mode can never spin forever the way an unconditional
  // requeue-on-any-error would.
  return { retryable: true, kind: "unknown" };
}

function getAttempt(msg: ConsumeMessage): number {
  const raw = msg.properties.headers?.[ATTEMPT_HEADER];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Picks which retry tier a message should go into next. When the failure
 * told us how long to wait (`RateLimitedError.retryAfterMs`), honor that -
 * use the shortest tier whose delay is at least that long, so the message
 * doesn't come back before the source's own rate-limit window has passed
 * (returning too early just spends an attempt on a guaranteed second 429).
 * If the source asked for longer than the longest configured tier can
 * hold, this clamps to the longest tier anyway rather than dropping the
 * message or inventing an unbounded wait - `clamped` on the return value
 * tells the caller that happened, so it can log it instead of silently
 * under-waiting. Otherwise (no `desiredDelayMs`) falls back to picking by
 * attempt number: attempt 2 -> tiers[0], attempt 3 -> tiers[1], etc.,
 * clamped to the last tier if `maxAttempts` asks for more attempts than
 * there are tiers (reusing the longest backoff rather than erroring).
 *
 * Both lookup strategies assume `tiers` is ordered shortest to longest
 * delay - sorted defensively here so a caller passing them out of order
 * (or an unordered literal) gets correct behavior instead of a silent
 * wrong pick from `Array.prototype.find`. */
export function pickRetryTier(
  tiers: ReadonlyArray<RetryTier>,
  nextAttempt: number,
  desiredDelayMs?: number,
): { tier: RetryTier; clamped: boolean } {
  if (tiers.length === 0) {
    throw new Error("pickRetryTier: no retry tiers configured");
  }
  const sorted = [...tiers].sort((a, b) => a.delayMs - b.delayMs);
  const longest = sorted[sorted.length - 1]!;

  if (desiredDelayMs !== undefined) {
    const byDesired = sorted.find((tier) => tier.delayMs >= desiredDelayMs);
    if (byDesired) return { tier: byDesired, clamped: false };
    return { tier: longest, clamped: true };
  }
  const index = Math.min(Math.max(0, nextAttempt - 2), sorted.length - 1);
  return { tier: sorted[index]!, clamped: false };
}

// Marks a channel as already having the `return` handler below attached,
// so calling createFetchSourceHandler/startFetchSourceWorker more than
// once against the same channel (every test in this file does, sharing
// one channel across many `it`s) registers the listener exactly once.
// Without this, N registrations would each independently dead-letter the
// same returned message, producing N duplicate fetch.source.dlq entries
// for one lost retry.
//
// A property tagged directly on the channel object, not a module-level
// `WeakSet<ConfirmChannel>` keyed by reference: a `WeakSet` breaks the
// moment a caller passes a *wrapped* channel (a logging/tracing/retry
// decorator - `new Proxy(channel, {...})` - is a normal pattern, and
// tests in this file do exactly that). A Proxy is a different object
// reference from the channel it wraps, so a WeakSet would consider it
// "not yet registered" every time, silently accumulating one extra
// permanent listener on the real underlying channel per distinct wrapper
// - reproduced: a test wrapping the shared channel duplicated a later
// test's DLQ entry. Reading/writing a property through an unintercepted
// Proxy trap forwards to the real target by default, so tagging the
// channel itself survives wrapping in a way a reference-keyed collection
// cannot.
const RETURN_HANDLER_ATTACHED = Symbol.for("fetchSourceWorker.retryReturnHandlerAttached");

/** Wires up the channel-level safety net for an unroutable retry publish
 * (see the `mandatory: true` comment at the sendToQueue call site below):
 * dead-letters whatever bounced back, with a log line explaining why,
 * instead of leaving it to vanish. */
function ensureRetryReturnHandler(channel: ConfirmChannel, log: (message: string) => void): void {
  const tagged = channel as ConfirmChannel & { [RETURN_HANDLER_ATTACHED]?: true };
  if (tagged[RETURN_HANDLER_ATTACHED]) return;
  tagged[RETURN_HANDLER_ATTACHED] = true;

  channel.on("return", (returned) => {
    log(
      `[fetch.source] retry publish to "${returned.fields.routingKey}" was unroutable ` +
        `(queue missing or renamed after startup?) - dead-lettering into ${FETCH_SOURCE_DLQ} instead`,
    );
    channel.sendToQueue(FETCH_SOURCE_DLQ, returned.content, {
      persistent: true,
      contentType: returned.properties.contentType,
      headers: returned.properties.headers,
    });
  });
}

/**
 * Builds the per-message handler. Exported separately from the `consume()`
 * wiring so tests can invoke it directly against a real (or fake) channel
 * and message without needing a running consumer loop.
 */
export function createFetchSourceHandler(options: FetchSourceWorkerOptions) {
  const {
    channel,
    db,
    sources,
    maxAttempts = 4,
    retryTiers = FETCH_SOURCE_RETRY_TIERS,
    sourceSearchTimeoutMs = DEFAULT_SOURCE_SEARCH_TIMEOUT_MS,
    highSkipRateThreshold = 0.5,
    onHighSkipRate = defaultOnHighSkipRate,
    log = (message: string) => console.error(message),
  } = options;

  ensureRetryReturnHandler(channel, log);

  /**
   * Marks this (search, source) pair permanently failed (ticket 4f88339,
   * design c54b9e0 §4.2). Called immediately before a `nack` to the DLQ on
   * BOTH terminal paths — non-retryable, and retries-exhausted.
   *
   * WHY THIS IS BEST-EFFORT, UNLIKE THE SUCCESS-PATH WRITE BELOW: the
   * message must dead-letter regardless. Letting a bookkeeping failure
   * throw here would either lose the nack entirely or hold a doomed
   * message hostage, and neither is better than degrading to the staleness
   * backstop (`STALL_AFTER_MS`, routes/searches.ts), which exists for
   * exactly this residual case. Mirrors `markSearchFailed`'s own
   * best-effort posture in routes/searches.ts.
   */
  async function markSourceFailed(
    message: FetchSourceMessage,
    kind: string,
    errorMessage: string,
  ): Promise<void> {
    try {
      await db
        .update(searchSources)
        .set({ status: "failed", errorKind: kind, errorMessage, updatedAt: new Date() })
        .where(
          and(
            eq(searchSources.searchId, message.searchId),
            eq(searchSources.sourceDescriptorId, message.sourceId),
          ),
        );
    } catch (err) {
      log(
        `[fetch.source] WARNING: could not mark search_sources failed for search=` +
          `${message.searchId} source=${message.sourceId} (${err instanceof Error ? err.message : String(err)}) ` +
          `- the message still dead-letters; this search now depends on the staleness backstop ` +
          `in GET /searches/:id to stop waiting on it`,
      );
    }
  }

  /**
   * Records every job this fetch LINKED but deliberately did NOT send a
   * `score.job` for, because the search's shared scoring budget was already
   * spent (ticket 4f88339 review round 1 F1; per-SEARCH since ticket
   * c9c676d — the module doc comment's "THE PER-SEARCH SCORING CAP" section
   * explains the whole decision).
   *
   * NOT best-effort, unlike `markSourceFailed` above, and the asymmetry is
   * the point. `markSourceFailed` is swallowed because the message must
   * dead-letter regardless and the staleness backstop covers a lost marker.
   * This one is on the SUCCESS path, and losing it is not a cosmetic gap:
   * without these rows the capped jobs sit in `search_results` with no
   * `job_matches` row for the search's resume and no `job_match_failures`
   * row for the search itself,
   * which the completion derive counts as outstanding — forever, because
   * nothing will ever score or fail them. So a failure here throws into the
   * handler's catch and the message is RETRIED, exactly like the
   * success-path ledger write below and for the same reason: re-running the
   * fetch is wasteful but correct, and a stalled search is not.
   *
   * Idempotent under redelivery: `ON CONFLICT (search_id, resume_id,
   * job_id) DO NOTHING`, mirroring `scoreJobWorker`'s own insert into this
   * table. The `search_id` in that key is ticket 9a53485's — before it, a
   * job this search capped could be a row an EARLIER search had already
   * written, so this insert silently no-opped and the later search kept the
   * earlier one's verdict instead of recording its own.
   *
   * Takes `tx`, not `db` (ticket c9c676d): these rows are what make this
   * source's budget claim readable by its siblings ("linked but capped" is
   * how a sibling knows a row is NOT consuming budget), so they must commit
   * atomically with the `published_job_count` write in the same
   * advisory-locked transaction. `adjudicateScoringBudget` is the only
   * caller, and routes/searches.ts's own advisory-lock comment explains why
   * nothing inside a locked transaction may reach for the pool-backed `db`
   * handle: it would check out a second connection while holding the lock.
   */
  async function recordCappedJobs(
    tx: Tx,
    message: FetchSourceMessage,
    cappedJobIds: string[],
    attempt: number,
  ): Promise<void> {
    // This message's body is `{searchId, sourceId, criteria}`: it carries
    // the searchId `job_match_failures` is keyed by (ticket 9a53485) but no
    // resumeId, and the table denormalizes the resume so the completion
    // derive's two LEFT JOINs stay symmetric. One small lookup, taken only
    // when the cap actually binds, so the common (under-cap) path pays
    // nothing for it.
    const searchRows = await tx
      .select({ resumeId: searches.resumeId })
      .from(searches)
      .where(eq(searches.id, message.searchId))
      .limit(1);
    const resumeId = searchRows[0]?.resumeId;
    if (resumeId === undefined) {
      // Should be impossible: `ingestJobsForSearch` just wrote
      // `search_results` rows whose `search_id` FK points at this row.
      // Throwing (rather than silently skipping) sends this down the retry
      // path and, if it persists, dead-letters with a real message —
      // silently skipping would leave the capped jobs outstanding forever,
      // which is the exact hang this function exists to prevent.
      throw new Error(
        `fetch.source: no searches row for searchId "${message.searchId}" while recording ` +
          `${cappedJobIds.length} score-threshold-capped job(s). The search was deleted ` +
          `mid-fetch, or the FK from search_results is not what it claims to be.`,
      );
    }

    const errorMessage =
      `Not scored: this search's shared scoring budget of ${DEFAULT_SCORE_THRESHOLD} job(s) ` +
      `(DEFAULT_SCORE_THRESHOLD, the same number POST /searches/estimate prices) was already ` +
      `spent across its sources when this source's ${cappedJobIds.length} remaining job(s) were ` +
      `adjudicated. Scoring was never attempted for this job — republish a score.job for it ` +
      `(and delete this row) to score it.`;

    for (let i = 0; i < cappedJobIds.length; i += CAPPED_FAILURE_INSERT_CHUNK) {
      const chunk = cappedJobIds.slice(i, i + CAPPED_FAILURE_INSERT_CHUNK);
      await tx
        .insert(jobMatchFailures)
        .values(
          chunk.map((jobId) => ({
            id: randomUUID(),
            searchId: message.searchId,
            resumeId,
            jobId,
            kind: SCORE_THRESHOLD_CAPPED_KIND,
            errorMessage,
            attempts: attempt,
          })),
        )
        .onConflictDoNothing({
          target: [jobMatchFailures.searchId, jobMatchFailures.resumeId, jobMatchFailures.jobId],
        });
    }
  }

  /**
   * THE PER-SEARCH SCORING CAP, enforced (ticket c9c676d). Decides — under
   * `pg_advisory_xact_lock(hashtext(search_id))`, so that sibling sources of
   * the same search cannot interleave — how many of this source's linked
   * jobs may be sent for scoring, writes the `job_match_failures` rows for
   * the ones that may not, and durably records this source's claim on the
   * budget. See the module doc comment's "THE PER-SEARCH SCORING CAP"
   * section for the arithmetic, the monotonicity argument, and the
   * `Σ published_job_count ≤ DEFAULT_SCORE_THRESHOLD` invariant.
   *
   * ONE TRANSACTION, TWO WRITES THAT MUST NOT SPLIT: the capped rows and
   * the `published_job_count` stamp are two halves of one statement about
   * this source ("I claimed N, and these are the ones I gave up on"). A
   * sibling that saw one without the other would either double-spend the
   * budget or permanently orphan the capped jobs, so they commit together or
   * not at all — and the whole thing is inside the lock, which is what makes
   * the read of every sibling's claim a value nobody can invalidate before
   * this source's own claim lands.
   *
   * ORDERED BEFORE THE `score.job` PUBLISHES, not after. The previous
   * per-source version recorded capped jobs after publishing; that ordering
   * existed only to keep capped jobs from looking outstanding while the
   * source read `complete`, which this ordering satisfies strictly better.
   * What it buys instead is the important direction of the crash window: if
   * this commits and the publish then fails, the redelivery re-adjudicates,
   * finds its own `previousClaim` already recorded, and republishes exactly
   * the same prefix. If it were the other way round, a crash between the
   * publish and the claim would let a sibling spend the same budget again.
   *
   * NOT best-effort: a throw here goes to the handler's catch and retries,
   * for the same reason `recordCappedJobs` does.
   */
  async function adjudicateScoringBudget(
    message: FetchSourceMessage,
    linkedJobIds: string[],
    attempt: number,
  ): Promise<BudgetAdjudication> {
    return db.transaction(async (tx) => {
      // Scoped to the SEARCH, not the resume (routes/searches.ts's in-flight
      // guard hashes `resume_id` for its own, unrelated question). Two
      // different searches never serialize against each other; a `hashtext`
      // collision between two unrelated searches costs brief serialization
      // and nothing else, because every query below filters on `search_id`.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${message.searchId}))`);

      const claimRows = await tx
        .select({
          sourceId: searchSources.sourceDescriptorId,
          publishedJobCount: searchSources.publishedJobCount,
        })
        .from(searchSources)
        .where(eq(searchSources.searchId, message.searchId));

      let claimedByOtherSources = 0;
      let previousClaim = 0;
      let hasLedgerRow = false;
      for (const row of claimRows) {
        // NULL = "has not adjudicated yet" = claims nothing. Optimistic on
        // purpose, and safe only because of the lock: whoever adjudicates
        // first takes what is left and commits before the next one reads.
        const claim = row.publishedJobCount ?? 0;
        if (row.sourceId === message.sourceId) {
          previousClaim = claim;
          hasLedgerRow = true;
        } else {
          claimedByOtherSources += claim;
        }
      }

      const remaining = Math.max(0, DEFAULT_SCORE_THRESHOLD - claimedByOtherSources);
      // `max(previousClaim, ...)` is what makes a source's published set
      // MONOTONE across redeliveries — see the module doc comment. Without
      // it a redelivery could "un-publish" jobs already in flight.
      const allowance = Math.max(previousClaim, remaining);
      const toPublishJobIds = linkedJobIds.slice(0, allowance);
      const cappedJobIds = linkedJobIds.slice(allowance);

      if (cappedJobIds.length > 0) {
        await recordCappedJobs(tx, message, cappedJobIds, attempt);
      }

      // `max` again, for the case where a redelivery's source returned FEWER
      // postings than the attempt that set `previousClaim`: those earlier
      // jobs really were published, so the claim must not shrink and hand a
      // sibling budget that is already spent.
      const claim = Math.max(previousClaim, toPublishJobIds.length);
      if (hasLedgerRow) {
        await tx
          .update(searchSources)
          .set({ publishedJobCount: claim, updatedAt: new Date() })
          .where(
            and(
              eq(searchSources.searchId, message.searchId),
              eq(searchSources.sourceDescriptorId, message.sourceId),
            ),
          );
      }
      // No `search_sources` row for this (search, source) pair at all —
      // not reachable for a search `POST /searches` started (it writes the
      // search and its source rows in one transaction), only for a
      // hand-published message. The budget still bounds this message (the
      // arithmetic above ran), it just cannot be recorded for siblings to
      // read, which degrades to the old per-source behaviour for that one
      // message rather than failing the fetch outright. The success-path
      // ledger write below has the same property for the same reason.

      return {
        toPublishJobIds,
        cappedJobIds,
        claimedByOtherSources,
        previousClaim,
        allowance,
        hasLedgerRow,
      };
    });
  }

  return async function handleFetchSourceMessage(msg: ConsumeMessage): Promise<void> {
    const attempt = getAttempt(msg);
    // Hoisted out of the try so the catch below can address the
    // `search_sources` row by its natural key. Still `undefined` when the
    // body itself didn't parse — an `InvalidMessageError` names no
    // (search, source) pair, so there is nothing to mark.
    let parsed: FetchSourceMessage | undefined;

    try {
      const message = parseFetchSourceMessage(msg.content);
      parsed = message;

      const source = sources[message.sourceId];
      if (!source) {
        throw new UnknownSourceError(`no adapter registered for sourceId "${message.sourceId}"`);
      }
      if (source.dataSource !== message.sourceId) {
        throw new SourceMismatchError(
          `adapter registered for sourceId "${message.sourceId}" reports ` +
            `dataSource "${source.dataSource}" - refusing to ingest under a mismatched natural key`,
        );
      }

      const result = await withDeadline(
        source.search(message.criteria),
        sourceSearchTimeoutMs,
        `source.search() for sourceId "${message.sourceId}" (search "${message.searchId}")`,
      );

      // Log every SkippedRecord.reason at this worker boundary (ticket
      // 491cd88, F2). Without this, `skipped[].reason` - the ONLY place a
      // truncated/partial result (SmartRecruiters' `maxPostings`, an
      // unrecognized company identifier, a malformed record, ...) says so
      // in human-readable form - reaches nowhere: it isn't logged,
      // persisted, or returned to `ingestJobsForSearch`'s caller, and
      // `skipRate` alone doesn't reliably surface it either (a single
      // truncation record diluted into a large `jobs` count can read as a
      // healthy, unremarkable skipRate well under `highSkipRateThreshold`
      // - e.g. 1 truncation record against 1,000 successfully-fetched
      // jobs is skipRate 0.001). This is a minimum fix, not the complete
      // one: it makes the reason text greppable in whatever this worker's
      // `log` hook writes to, not a structured, machine-readable signal a
      // caller could branch on without regexing prose - that's a separate,
      // larger change (a discriminator on `SkippedRecord` itself, touching
      // `types.ts` and all five adapters) tracked as its own ticket.
      if (result.skipped.length > 0) {
        const toLog = result.skipped.slice(0, SKIPPED_LOG_LIMIT);
        for (const skip of toLog) {
          log(
            `[fetch.source] skipped record: source=${message.sourceId} ` +
              `search=${message.searchId} externalId=${skip.externalId ?? "(none)"} ` +
              `reason=${skip.reason}`,
          );
        }
        const remaining = result.skipped.length - toLog.length;
        if (remaining > 0) {
          log(
            `[fetch.source] ...and ${remaining} more skipped record(s) for ` +
              `source=${message.sourceId} search=${message.searchId} not individually logged ` +
              `(capped at ${SKIPPED_LOG_LIMIT} per message - see SKIPPED_LOG_LIMIT).`,
          );
        }
      }

      const total = result.jobs.length + result.skipped.length;
      if (total > 0 && result.skipRate >= highSkipRateThreshold) {
        onHighSkipRate({
          searchId: message.searchId,
          sourceId: message.sourceId,
          skipRate: result.skipRate,
          jobCount: result.jobs.length,
          skippedCount: result.skipped.length,
        });
      }

      // THE QUALITY FILTER (ticket 45ea34c). Applied to `result.jobs`
      // BEFORE ingestion, which is exactly where `runDemoMatch` applies it
      // (`filter(found)`, matching/pipeline.ts) and therefore where
      // `POST /searches/estimate` applies it too. See the module doc
      // comment's "THE QUALITY FILTER" section for why this point and not
      // post-ingest, and `FetchSourceMessage.filterCriteria` for the wire
      // format's three-way state.
      let jobsToIngest = result.jobs;
      if (message.filterCriteria === undefined) {
        log(
          `[fetch.source] NO FILTER CRITERIA ON MESSAGE: source=${message.sourceId} ` +
            `search=${message.searchId} - this message carries no "filterCriteria" field at all, ` +
            `so all ${result.jobs.length} posting(s) this source returned are being ingested and ` +
            `scored unfiltered. A message published by POST /searches always carries the field ` +
            `(explicitly null when the caller supplied no criteria); this one did not, so it came ` +
            `from a publisher that predates ticket 45ea34c or hand-rolled the body.`,
        );
      } else {
        // `null` means "the caller supplied no criteria", which
        // `compileFilter(undefined)` turns into the CLI default filter -
        // the same three-way mapping POST /searches/estimate gets by
        // passing an absent request-body field straight through.
        jobsToIngest = compileFilter(message.filterCriteria ?? undefined)(result.jobs);
        const removed = result.jobs.length - jobsToIngest.length;
        if (removed > 0) {
          log(
            `[fetch.source] quality filter: source=${message.sourceId} ` +
              `search=${message.searchId} kept ${jobsToIngest.length} of ${result.jobs.length} ` +
              `posting(s) (${removed} did not match this search's criteria and are neither ` +
              `linked nor scored).`,
          );
        }
      }

      const { linkedJobIds, crossSourceMerges } = await ingestJobsForSearch(
        db,
        message.searchId,
        message.sourceId,
        jobsToIngest,
      );

      // Ticket 78d31b7 review F2b. A cross-source merge means a posting
      // this source returned was deliberately NOT stored and will never
      // appear in this search's results — the right outcome when the two
      // really are one job, and an invisible deletion when they are not.
      // Normally zero lines (a live check on 2026-09-23 found no
      // cross-source collisions at all across 2,304 jobs), so this is not
      // log noise; when it does fire it is the only record that a posting
      // was dropped. Logged per merge rather than as a count, because the
      // useful question after a suspicious result is "which posting, and
      // how confident was it" — see `describeCrossSourceMerge`.
      for (const merge of crossSourceMerges) {
        log(
          `[fetch.source] source=${message.sourceId} search=${message.searchId} ` +
            describeCrossSourceMerge(merge),
        );
      }

      // THE PER-SEARCH SCORING CAP (ticket 4f88339 review round 1 F1;
      // per-SEARCH since ticket c9c676d). Everything above this line linked
      // EVERY job that MATCHED THIS SEARCH'S CRITERIA (ticket 45ea34c) —
      // ingestion is still uncapped in the sense `DEFAULT_SCORE_THRESHOLD`'s
      // own doc comment promises: nothing is dropped by its position in
      // board order. What is capped is SPENDING: across ALL of this search's
      // sources, at most `DEFAULT_SCORE_THRESHOLD` jobs get a `score.job`
      // message — the same constant, applied to the same question and at the
      // same (per-search) scope, that the CLI path and
      // `POST /searches/estimate` already use. The slice is a deterministic
      // prefix of a deterministically-ordered list and the allowance is
      // monotone, so a redelivery republishes exactly the same set. See the
      // module doc comment for the arithmetic and the invariant.
      const budget = await adjudicateScoringBudget(message, linkedJobIds, attempt);
      const { toPublishJobIds, cappedJobIds } = budget;

      // Publish for every job linked to this search (up to the cap), not
      // just the ones this particular call inserted - see the module doc
      // comment above for why. The scoring worker is responsible for not
      // double-scoring a job it's seen a score.job message for before.
      for (const jobId of toPublishJobIds) {
        const payload: ScoreJobMessage = { jobId };
        channel.publish(
          JOBS_EXCHANGE,
          SCORE_JOB_ROUTING_KEY,
          Buffer.from(JSON.stringify(payload)),
          {
            persistent: true,
            contentType: "application/json",
          },
        );
      }
      if (toPublishJobIds.length > 0) {
        await channel.waitForConfirms();
      }

      // The capped rows themselves were already committed, inside the
      // advisory-locked transaction, BEFORE these publishes — see
      // `adjudicateScoringBudget` for why that ordering is the safe one.
      // What is left here is saying so out loud, with the numbers that
      // explain WHY the cap bound for this particular source: "we linked
      // 300 and published 40" is only intelligible alongside "our siblings
      // had already claimed 160 of the search's 200".
      if (cappedJobIds.length > 0) {
        log(
          `[fetch.source] SCORING CAP BOUND: source=${message.sourceId} ` +
            `search=${message.searchId} linked ${linkedJobIds.length} job(s); the search's ` +
            `shared budget is ${DEFAULT_SCORE_THRESHOLD} (DEFAULT_SCORE_THRESHOLD) and other ` +
            `sources had already claimed ${budget.claimedByOtherSources}, so this source ` +
            `published score.job for ${toPublishJobIds.length} and recorded the remaining ` +
            `${cappedJobIds.length} as "${SCORE_THRESHOLD_CAPPED_KIND}" so the search can still ` +
            `reach a terminal state. Those jobs are ingested and linked — they were not scored, ` +
            `not lost, and GET /searches/:id reports them as cappedForBudget rather than as ` +
            `scoring failures.`,
        );
      }
      if (!budget.hasLedgerRow) {
        log(
          `[fetch.source] NO search_sources ROW for search=${message.searchId} ` +
            `source=${message.sourceId}: this source's claim on the search's shared scoring ` +
            `budget could not be recorded, so sibling sources cannot see it and the cap degrades ` +
            `to per-source for this message. Only reachable for a hand-published fetch.source ` +
            `message — POST /searches always writes the search and its source rows together.`,
        );
      }

      // SUCCESS-PATH LEDGER WRITE (ticket 4f88339, design c54b9e0 §4.2).
      // Placed here — after the score.job publishes are confirmed,
      // immediately before the ack — deliberately:
      //
      // (a) NOT swallowed. If this UPDATE throws it falls into the catch
      //     below and the message is RETRIED. Re-running the whole fetch
      //     is wasteful but correct (everything downstream is idempotent),
      //     and the alternative — acking with the row left `pending` — is
      //     a permanent stall for that search.
      // (b) As late as possible. The one race this design names rather
      //     than hides (§6.2) is a worker marking `complete` and then
      //     dying before its ack: the redelivery re-fetches and could link
      //     a NEW job to a search a poll has meanwhile reported complete.
      //     Nothing is lost or double-billed when that happens (the
      //     results endpoint reads `job_matches` directly), and keeping
      //     this write adjacent to the ack makes the window microseconds
      //     wide. The airtight fix is a transactional outbox, rejected as
      //     disproportionate for a single-user app.
      //
      // SET, never incremented: a redelivered message writes the same (or
      // a superset) `linkedJobCount`, so at-least-once delivery cannot
      // inflate it.
      await db
        .update(searchSources)
        .set({
          status: "complete",
          linkedJobCount: linkedJobIds.length,
          errorKind: null,
          errorMessage: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(searchSources.searchId, message.searchId),
            eq(searchSources.sourceDescriptorId, message.sourceId),
          ),
        );

      channel.ack(msg);
    } catch (err) {
      const { retryable, kind } = classify(err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (!retryable) {
        log(
          `[fetch.source] non-retryable error (${kind}) on attempt ${attempt} - ` +
            `dead-lettering immediately without consuming a retry: ${errorMessage}`,
        );
        if (parsed) await markSourceFailed(parsed, kind, errorMessage);
        channel.nack(msg, false, false);
        return;
      }

      if (attempt >= maxAttempts) {
        log(
          `[fetch.source] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} ` +
            `- retries exhausted, dead-lettering`,
        );
        if (parsed) await markSourceFailed(parsed, kind, errorMessage);
        channel.nack(msg, false, false);
        return;
      }

      // RETRY PATH: no write. The source is still `pending`, which is the
      // truth — a message riding a backoff tier is legitimately
      // outstanding, and marking it either way here would be a lie the
      // completion derive would act on.

      const nextAttempt = attempt + 1;
      const desiredDelayMs =
        err instanceof RateLimitedError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : undefined;
      const { tier, clamped } = pickRetryTier(retryTiers, nextAttempt, desiredDelayMs);
      log(
        `[fetch.source] attempt ${attempt}/${maxAttempts} failed (${kind}): ${errorMessage} ` +
          `- retrying (attempt ${nextAttempt}) via ${tier.queue} (${tier.delayMs}ms)` +
          (desiredDelayMs !== undefined ? ` [source requested ${desiredDelayMs}ms]` : "") +
          (clamped
            ? ` [CLAMPED: requested delay exceeds the longest configured retry tier - ` +
              `retrying sooner than the source asked for]`
            : ""),
      );

      // No per-message `expiration` here - the tier queue's own
      // queue-level TTL (see topology.ts / FETCH_SOURCE_RETRY_TIERS) is
      // what times the backoff out, precisely so messages with different
      // delays never share a queue and block each other's expiry.
      //
      // `mandatory: true` + the `channel.on("return", ...)` handler
      // registered in `createFetchSourceHandler` below: sendToQueue is
      // "publish to the default exchange, routing key = queue name" under
      // the hood, so if `tier.queue` doesn't exist - deleted, renamed, or
      // drifted from what `startFetchSourceWorker` validated at startup -
      // this would otherwise succeed silently (no consumer, no binding,
      // nothing to complain), `waitForConfirms` would resolve anyway, and
      // the message below would get acked having genuinely gone nowhere.
      // `mandatory` makes an unroutable publish come back as a `return`
      // event instead, which the handler dead-letters into
      // fetch.source.dlq rather than losing it.
      channel.sendToQueue(tier.queue, msg.content, {
        persistent: true,
        mandatory: true,
        contentType: msg.properties.contentType,
        headers: { ...msg.properties.headers, [ATTEMPT_HEADER]: nextAttempt },
      });
      await channel.waitForConfirms();
      // The original delivery is now fully handled - we've taken
      // responsibility for it by scheduling the retry copy - so it's
      // acked, not left unacked or nacked-with-requeue (which would race
      // the retry copy and could process the same attempt twice).
      channel.ack(msg);
    }
  };
}

/**
 * Starts consuming fetch.source with the given options. Returns the
 * consumer tag so a caller can `channel.cancel(tag)` to stop (used by
 * tests to tear down cleanly between cases sharing one queue).
 *
 * Two independent layers guard against a retryable failure's
 * `sendToQueue` into a tier queue silently going nowhere:
 *
 * 1. Fails fast here, before consuming a single message, if any
 *    configured retry tier queue doesn't exist yet (`channel.checkQueue`
 *    rejects - and closes the channel - when the queue is missing). This
 *    catches the common case (topology not set up before the worker
 *    starts) at boot, loudly, instead of at the first retry.
 * 2. It does NOT catch a tier queue that existed at startup and was
 *    later deleted, renamed, or otherwise drifted out from under a
 *    long-running worker - `sendToQueue` doesn't re-check existence per
 *    call. That's what `mandatory: true` on the retry publish (see
 *    `createFetchSourceHandler`) plus the `channel.on("return", ...)`
 *    handler it registers are for: an unroutable retry publish comes back
 *    as a `return` event instead of vanishing, and gets dead-lettered
 *    into fetch.source.dlq with a log line explaining why, rather than
 *    the worker acking the original message having genuinely done
 *    nothing with it.
 */
export async function startFetchSourceWorker(
  options: FetchSourceWorkerOptions,
  consumeOptions?: { prefetch?: number },
): Promise<string> {
  const retryTiers = options.retryTiers ?? FETCH_SOURCE_RETRY_TIERS;
  for (const tier of retryTiers) {
    try {
      await options.channel.checkQueue(tier.queue);
    } catch (err) {
      throw new Error(
        `startFetchSourceWorker: retry tier queue "${tier.queue}" does not exist - ` +
          `run setupTopology() (or declare it identically) before starting the worker`,
        { cause: err },
      );
    }
  }

  const handler = createFetchSourceHandler(options);
  const log = options.log ?? ((m: string) => console.error(m));
  await options.channel.prefetch(consumeOptions?.prefetch ?? 1);
  const { consumerTag } = await options.channel.consume(FETCH_SOURCE_QUEUE, (msg) => {
    if (!msg) return; // consumer was cancelled server-side
    handler(msg).catch((err: unknown) => {
      // The handler's own try/catch already turns adapter/DB/publish
      // failures into a nack or a scheduled retry - reaching here means
      // something failed *after* that decision was made (e.g. the channel
      // itself closed mid-flight, so even the ack/nack call threw) or a
      // bug nobody anticipated. Either way this promise would otherwise
      // reject unhandled: Node terminates the process on an unhandled
      // rejection by default, which would take down every other in-flight
      // message with it over one broker hiccup.
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[fetch.source] handler failed outside its own error handling: ${message} - ` +
          `attempting to dead-letter the message directly`,
      );

      try {
        // Simply logging and moving on, as an earlier version of this
        // code did, leaves the message unacked forever. Under
        // `prefetch(1)` that's not "one message lost" - it PERMANENTLY
        // WEDGES this consumer: RabbitMQ won't deliver a second message
        // to a consumer that hasn't acked its first, so the whole worker
        // silently stops making progress while everything about it
        // (connection up, consumer registered, no errors thrown) still
        // reports healthy. Try once more to get the message off this
        // channel via a direct nack straight to the DLQ.
        options.channel.nack(msg, false, false);
      } catch (nackErr) {
        // Even the nack failed - the channel itself is almost certainly
        // the problem (nack is a synchronous local call; this is the
        // realistic way it throws). Closing it is what actually
        // unwedges things: amqplib requeues whatever was left unacked on
        // a channel when it closes, and a supervisor restarting this
        // worker on a fresh connection/channel is a far better outcome
        // than a consumer that stays "up" and silently stops progressing.
        const nackMessage = nackErr instanceof Error ? nackErr.message : String(nackErr);
        log(
          `[fetch.source] nack also failed (${nackMessage}) - closing the channel so the ` +
            `message isn't held unacked forever and a supervisor can restart this worker`,
        );
        options.channel.close().catch(() => {});
      }
    });
  });
  return consumerTag;
}
