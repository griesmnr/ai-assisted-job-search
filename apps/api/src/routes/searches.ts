/**
 * Estimate a search, start a search, and poll a search's status
 * (tickets 59fdc52, 4f88339).
 *
 * THE MONEY INVARIANT, AMENDED (ticket 4f88339). This file used to be the
 * one place in the REST surface that actually SPENT variable money:
 * `POST /searches` called `runDemoMatch` inline, which fetched every
 * source and made one real Claude call per job, in this process. It no
 * longer does. `POST /searches` now records the search durably and
 * publishes one `fetch.source` message per selected source; the fetching
 * happens in `fetchSourceWorker`, and every Claude call happens in
 * `scoreJobWorker`, both separate processes.
 *
 * The invariant that matters did not go away, it MOVED ONE LEVEL UP: this
 * route no longer spends money, it AUTHORIZES spending that a worker
 * performs. The original decision ("no endpoint may spend variable money
 * without the caller explicitly asking it to") still holds exactly as
 * written — nothing is published unless the caller asked for this resume
 * against these sources — and one consequence is worth stating plainly,
 * because it is easy to lose: the spend a single `POST /searches` can
 * authorize is now bounded by `scoreJobWorker`'s own lifetime spend guard
 * (`ScoringSpendGuard`, ticket b53c422), not by anything in this file.
 * `runDemoMatch`'s per-run `DEFAULT_SCORE_THRESHOLD` cap of 200 jobs does
 * not apply to the queue path at all: no single place sees a whole
 * queue-driven run, so there is nowhere for a per-run cap to live.
 *
 * KNOWN GAP, FLAGGED DELIBERATELY (ticket 4f88339 — needs its own
 * follow-up ticket, do not assume it is handled somewhere else): the
 * QUALITY FILTER below (`compileFilter`) is a LOCAL, post-fetch filter
 * that `runDemoMatch` applied between fetching and scoring. The queue path
 * has no equivalent — `fetchSourceWorker` ingests everything a source
 * returns and publishes a `score.job` for every linked job — so the
 * filter currently only takes effect on `POST /searches/estimate` (still
 * synchronous) and the CLI. Design c54b9e0, which this ticket implements,
 * does not address it. Carrying the caller's filter criteria on the
 * `fetch.source` message and applying it before ingest is the obvious fix,
 * but it needs a real decision about the wire format for the filter's
 * three-way state (no `criteria` field at all -> the CLI default filter;
 * an explicit `criteria` -> `compileFilter(criteria)`; an explicit `{}`
 * -> no filtering), which is why it is not improvised here.
 *
 * Amended (ticket 39b4a48): `POST /resumes` also makes one real, small,
 * BOUNDED Claude call per genuinely-new resume (title-keyword inference,
 * resume-title-inference.ts) — deliberately automatic, not gated behind a
 * separate confirm, per Nicole's own explicit design. The distinction that
 * keeps this consistent with the rule above: that call's cost is fixed and
 * small regardless of input, and it is cached per resume via the existing
 * content-addressed find-or-create.
 *
 * `POST /searches/estimate` is STILL SYNCHRONOUS, deliberately (design
 * c54b9e0 §9). It spends no Claude money, it must return a number in one
 * HTTP response, and making it async would mean building completion
 * detection for a free operation — this exact problem, for no benefit. It
 * shares the fetch/ingest path via `runDemoMatch`'s `estimateOnly` option
 * and never touches `getScoreJob` at all: it passes a scorer that throws
 * if ever called, as an assertion that `estimateOnly` really did stop
 * before scoring. See `runDemoMatch`'s `markSearchComplete` and the
 * in-flight guard's own comment for why its `searches` row MUST stay
 * terminal.
 *
 * QUALITY FILTER (review round 2 — read before touching `filter`): both
 * routes compile a `SearchCriteria` (packages/shared) into a filter via
 * `compileFilter` (sources/criteria.ts). Round 1 shipped no filter at all
 * on the (correct) premise that `filterSoftwareEngineeringJobs`'s regexes
 * hardcode Nicole's own title/location criteria — but deleting a quality
 * control is not the same act as making it configurable, and round 1
 * measured nothing. Live consequence: an unfiltered run against the real
 * Greenhouse pool (6,230 postings) scores `slice(0, 200)` in board-token
 * order — 200 Samsara postings alphabetical by title, 5 of them software
 * engineering roles, 195 things like "Accountant II" and "Account
 * Executive, Commercial". `compileFilter(criteria)` (when `criteria` is
 * present in the request body) or `compileFilter(undefined)` (when it's
 * absent — which reproduces the CLI's filter EXACTLY, see criteria.ts) is
 * what a caller gets by default; passing an explicit empty `{}` is how a
 * caller opts out of filtering entirely. See the KNOWN GAP above for where
 * this does and does not currently apply.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  EstimateSearchResponse,
  SearchCriteria,
  SearchSourceState,
  SearchStatusResponse,
  SkippedSource,
  StartSearchResponse,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { runDemoMatch, type ScoreJobFn } from "../matching/index.js";
import {
  jobMatchFailures,
  jobMatches,
  resumes,
  searchResults,
  searchSources,
  searches as searchesTable,
} from "../db/schema.js";
import { seedSourceDescriptors } from "../db/seed.js";
import { createAmqpFetchSourcePublisher, type PublishFetchSourceFn } from "../queue/publisher.js";
import { compileExcludedForMissingWorkArrangement, compileFilter } from "../sources/criteria.js";
import { buildSourceSelection } from "../sources/registry.js";
import type { FetchSourceMessage } from "../worker/fetchSourceWorker.js";
import type { JobSource, SearchCriteria as SourceFetchCriteria } from "../sources/types.js";

const searchCriteriaSchema = {
  type: "object",
  properties: {
    titleInclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    titleExclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    nearLocations: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    remoteOk: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const searchBodySchema = {
  type: "object",
  required: ["resumeId", "sourceIds"],
  properties: {
    resumeId: { type: "string", minLength: 1 },
    // uniqueItems (not a hand-rolled duplicate check): AJV rejects a
    // request with a repeated sourceId as a clean 400 before the handler
    // ever runs, rather than the handler having to detect it and build a
    // synthetic "skipped" entry — round 1's version of that synthetic
    // entry reported `skippedSources[0].id` as the literal string
    // "usajobs,usajobs" (every duplicate id joined together), which is
    // exactly the kind of malformed-looking-like-data bug a schema-level
    // check avoids by construction. It also underwrites
    // `search_sources`' new `unique(search_id, source_descriptor_id)`
    // constraint (ticket 4f88339): a duplicate sourceId can never reach
    // the insert that would violate it.
    sourceIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
    criteria: searchCriteriaSchema,
  },
  additionalProperties: false,
} as const;

type SearchBody = { resumeId: string; sourceIds: string[]; criteria?: SearchCriteria };

/**
 * How long a `running` search stays eligible to block a new search for the
 * same resume, and how long it takes before a still-outstanding search is
 * reported as STALLED (design c54b9e0 §6.5).
 *
 * 45 minutes, and the number is derived rather than picked: a single
 * `fetch.source` message can legitimately burn
 * `DEFAULT_SOURCE_SEARCH_TIMEOUT_MS` (10 minutes) x `maxAttempts` (4) = 40
 * minutes of retries before dead-lettering — fetchSourceWorker.ts's own
 * doc comment works through that arithmetic in detail. Anything at or
 * under 40 minutes would declare a legitimately slow source stalled while
 * it is still working. 45 leaves a small margin over that worst case
 * without being so long that a genuinely wedged search blocks the resume
 * for an unreasonable time.
 *
 * WHAT IT IS FOR: exactly one residual stall exists in this design — the
 * DB marker write failed AND the message dead-lettered anyway (both
 * workers' failure-path writes are best-effort by design, so the message
 * is never held hostage to a bookkeeping failure). That leaves a search
 * with nothing left to settle it. This window is what stops that from
 * being permanent: it releases the in-flight guard so the resume can be
 * searched again, and it makes `GET /searches/:id` say so out loud
 * (`stalledSince`, plus the outstanding jobIds). REPORT, DO NOT AUTO-HEAL
 * — republishing from the DLQ is an operator action, and a good follow-up
 * ticket, not something a poll should trigger.
 */
export const STALL_AFTER_MS = 45 * 60 * 1000;

/**
 * Ticket d1fc9e2: builds the FETCH-level criteria (`sources/types.ts`'s
 * `SearchCriteria` — `keyword(s)`/`location`) from the caller's LOCAL
 * filter criteria (`@app/shared`'s `SearchCriteria` — `titleInclude`/etc),
 * so USAJOBS's own search actually narrows by title instead of fetching
 * an unfiltered, pagination-capped sample of everything currently open
 * (measured live, 2026-09-08: 10,000 total open postings, a 5,000-post
 * fetch cap, no way to know which half of the 10,000 a keyword-less fetch
 * happens to land on). Every other configured source ignores this object
 * entirely (see `sources/types.ts`'s `SearchCriteria.keywords` doc
 * comment) — it is inert, not harmful, for them.
 *
 * This is the object that now goes ON THE WIRE, as the `criteria` field of
 * every `fetch.source` message (ticket 4f88339) — it was already exactly
 * the shape `FetchSourceMessage` carries, which is why no translation
 * layer was needed.
 *
 * Deliberately omitted when `titleInclude` is empty/absent: that already
 * means "no title restriction, search every title" (ticket 39b4a48's
 * explicit no-silent-default rule) — sending a keyword in that case would
 * silently narrow a search the caller asked to leave unrestricted.
 *
 * Ticket c419a12, N7: chips are trimmed and blank ones dropped BEFORE that
 * emptiness check, not after. `criteria.titleInclude` reaching here as
 * `[""]` (or `["  "]`) used to survive the `.length > 0` check (one
 * element, non-empty array) and get sent straight through as
 * `keywords: [""]` — which `UsajobsSource#search` (usajobs.ts) treats as
 * one real phrase, spreads into `{ ...criteria, keyword: "" }`, and
 * `#fetchPage`'s `if (criteria.keyword)` then treats as falsy, silently
 * falling back to a full unkeyworded fetch — the exact pre-ticket-d1fc9e2
 * pathology (a keywordless, pagination-capped sample of the whole board)
 * this criteria-plumbing exists to prevent. Not reachable from the current
 * UI (chips are add-button-gated on non-empty trimmed text), so this was
 * never a live regression — closed anyway since the fix is one line and
 * the failure mode is silent by nature.
 */
function buildFetchCriteria(criteria: SearchCriteria | undefined): SourceFetchCriteria {
  const titlePhrases = criteria?.titleInclude
    ?.map((title) => title.trim())
    .filter((title) => title.length > 0);
  if (titlePhrases && titlePhrases.length > 0) {
    return { keywords: titlePhrases };
  }
  return {};
}

function tempOutputPath(searchId: string): string {
  // Deliberately NOT prep/match-results.json — that file holds the owner's
  // live results and a search triggered through this API must never
  // overwrite it. os.tmpdir() keeps every API-triggered run's throwaway
  // JSON dump (runDemoMatch always writes one) entirely outside the repo.
  return path.join(os.tmpdir(), `rest-api-search-${searchId}.json`);
}

const NEVER_SCORE: ScoreJobFn = () => {
  throw new Error(
    "searches/estimate: scoreJob was called, but estimateOnly should have stopped before any " +
      "scoring call. This would be a real, unexpected Claude spend — treat it as a bug.",
  );
};

/**
 * The completion derive (design c54b9e0 §5.2) — the whole of "is this
 * search done?", computed as a SET DIFFERENCE over durable rows rather
 * than tracked by a counter.
 *
 * Nothing in this design increments anything, and that is the single
 * strongest property it has: under at-least-once delivery, a redelivered
 * message re-runs the same work and re-writes the same rows, so a message
 * delivered five times produces the identical relational state as one
 * delivered once. `linked_job_count` is SET from `linkedJobIds.length`;
 * every count below is a `count(*) FILTER` over rows whose existence is
 * guarded by a unique constraint. A counter design would have had to add a
 * per-(search, job) dedupe ledger to be safe — at which point the ledger
 * IS the design, minus the counter.
 */
type DerivedSearchState = {
  sources: SearchSourceState[];
  /** No `search_sources` row is still `pending`. */
  sourcesSettled: boolean;
  linked: number;
  scored: number;
  permanentlyFailed: number;
  outstanding: number;
  isTerminal: boolean;
  /** True only when every source of a search that linked nothing failed —
   * "the search could not be run at all", as opposed to "it ran and found
   * nothing". */
  allSourcesFailed: boolean;
};

export function registerSearchRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  getScoreJob: () => ScoreJobFn,
  /**
   * Defaults to the real `buildSourceSelection` (real `createXSourceFromEnv`
   * adapters). Overridable so route tests can inject `FakeSource`s instead —
   * exactly the pattern `demo-match.test.ts` already uses for
   * `runDemoMatch` itself — without ever hitting a real job-board API or
   * requiring real source credentials to be configured in the test
   * environment.
   */
  resolveSourceIds: (
    sourceIds: string[],
  ) => ReturnType<typeof buildSourceSelection> = buildSourceSelection,
  /**
   * How `POST /searches` hands `fetch.source` messages to RabbitMQ
   * (ticket 4f88339). Same injection pattern as `resolveSourceIds` above
   * and for the same reason: route tests assert what WOULD have been
   * published, against a fake, with no live broker. The real default is
   * lazy — it connects on the first `POST /searches`, never at boot — so
   * every other route keeps working on a machine with no RabbitMQ running.
   */
  publishFetchSource: PublishFetchSourceFn = createAmqpFetchSourcePublisher(),
): void {
  async function loadResumeText(resumeId: string): Promise<string | undefined> {
    const rows = await db
      .select({ resumeText: resumes.resumeText })
      .from(resumes)
      .where(eq(resumes.id, resumeId))
      .limit(1);
    return rows[0]?.resumeText;
  }

  function resolveSources(
    sourceIds: string[],
  ):
    | { ok: true; sources: JobSource[]; skipped: SkippedSource[] }
    | { ok: false; skipped: SkippedSource[] } {
    const { sources, skipped } = resolveSourceIds(sourceIds);
    if (sources.length === 0) return { ok: false, skipped };
    return { ok: true, sources, skipped };
  }

  /** Best-effort: if this fails, the run's actual outcome is already
   * either persisted or simply unmarked — a failed marker write must never
   * throw out of the path that is already handling a real failure and mask
   * the original error. */
  async function markSearchFailed(searchId: string): Promise<void> {
    try {
      await db
        .update(searchesTable)
        .set({ status: "failed" })
        .where(eq(searchesTable.id, searchId));
    } catch (err) {
      app.log.error({ err, searchId }, "failed to mark searches.status = 'failed'");
    }
  }

  /**
   * Two small queries, both served by indexes that already exist:
   * `search_sources (search_id, source_descriptor_id)` leads on
   * `search_id`; `search_results (search_id, job_id)` leads on
   * `search_id`; `job_matches (resume_id, job_id)` and
   * `job_match_failures (resume_id, job_id)` are direct lookups with
   * `resume_id` constant from the `searches` row. No new index is needed
   * for this — worth saying out loud so nobody "optimizes" by adding
   * redundant ones.
   */
  async function deriveSearchState(searchId: string): Promise<DerivedSearchState> {
    const sourceRows = await db
      .select({
        sourceId: searchSources.sourceDescriptorId,
        status: searchSources.status,
        linkedJobCount: searchSources.linkedJobCount,
        errorKind: searchSources.errorKind,
        errorMessage: searchSources.errorMessage,
      })
      .from(searchSources)
      .where(eq(searchSources.searchId, searchId));

    const sources: SearchSourceState[] = sourceRows.map((row) => ({
      sourceId: row.sourceId,
      status: row.status,
      linkedJobCount: row.linkedJobCount,
      ...(row.errorKind !== null ? { errorKind: row.errorKind } : {}),
      ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    }));

    const aggregates = await db
      .select({
        linked: sql<number>`count(*)`.mapWith(Number),
        scored: sql<number>`count(*) filter (where ${jobMatches.id} is not null)`.mapWith(Number),
        permanentlyFailed:
          sql<number>`count(*) filter (where ${jobMatches.id} is null and ${jobMatchFailures.id} is not null)`.mapWith(
            Number,
          ),
        outstanding:
          sql<number>`count(*) filter (where ${jobMatches.id} is null and ${jobMatchFailures.id} is null)`.mapWith(
            Number,
          ),
      })
      .from(searchResults)
      .innerJoin(searchesTable, eq(searchesTable.id, searchResults.searchId))
      .leftJoin(
        jobMatches,
        and(
          eq(jobMatches.jobId, searchResults.jobId),
          eq(jobMatches.resumeId, searchesTable.resumeId),
        ),
      )
      .leftJoin(
        jobMatchFailures,
        and(
          eq(jobMatchFailures.jobId, searchResults.jobId),
          eq(jobMatchFailures.resumeId, searchesTable.resumeId),
        ),
      )
      .where(eq(searchResults.searchId, searchId));

    const counts = aggregates[0] ?? {
      linked: 0,
      scored: 0,
      permanentlyFailed: 0,
      outstanding: 0,
    };

    // THE SAME VACUOUS-TRUTH TRAP, ONE LEVEL UP — and it is not
    // hypothetical: `[].every(...)` is TRUE, so a search with no
    // `search_sources` rows at all would read as "every source is
    // settled", and with no linked jobs either it would latch as complete
    // the first time anyone polled it. A queue-driven search always has at
    // least one source row (the route writes the search and its sources in
    // one transaction), so `sources.length > 0` costs nothing there; what
    // it protects is the pre-migration row that has no ledger, which must
    // be reported honestly as `incomplete`, never silently completed.
    //
    // THE `sourcesSettled` CONJUNCT IS NOT DECORATION (design c54b9e0 §2).
    // Without it, a search that has just been created — zero
    // `search_results` rows — satisfies "every linked job is scored"
    // VACUOUSLY and reads as complete before it has done anything. It is
    // also what makes `outstanding === 0` SOUND: once no source is
    // pending, nothing is publishing further `score.job` messages for this
    // search, so `search_results` is frozen and the set difference is
    // final. There is a test that asserts this specific bug directly.
    const sourcesSettled =
      sources.length > 0 && sources.every((source) => source.status !== "pending");
    const allSourcesFailed =
      sources.length > 0 && sources.every((source) => source.status === "failed");

    return {
      sources,
      sourcesSettled,
      linked: counts.linked,
      scored: counts.scored,
      permanentlyFailed: counts.permanentlyFailed,
      outstanding: counts.outstanding,
      isTerminal: sourcesSettled && counts.outstanding === 0,
      allSourcesFailed,
    };
  }

  /**
   * Partial-failure semantics (design c54b9e0 §8), evaluated rather than
   * assumed.
   *
   * The default is that a permanently-failed job is a REPORTABLE OUTCOME,
   * not a blocker: one posting out of 180 that could not be scored must
   * not block showing the other 179, which mirrors CLAUDE.md's stated DLQ
   * philosophy for sources ("the UI shows that source as unavailable, and
   * the other sources still return") one level down.
   *
   * The carve-out is real and not a formality. Source failures are
   * genuinely INDEPENDENT — USAJOBS being down says nothing about Lever.
   * Scoring failures usually are NOT: `AuthenticationError`,
   * `PermissionDeniedError`, `NotFoundError` (a retired model id) and an
   * exhausted spend guard are SYSTEMIC and fail every job identically.
   * Reporting "complete, 0 of 180 scored, 180 failures" as a normal
   * completion would be technically true and practically a lie — the user
   * asked for a ranked list and got an outage dressed as a finished
   * search. `runDemoMatch` already encodes exactly this judgement in
   * `isTotalScoringFailure` (`failed > 0 && newlyScored === 0`); this
   * honours that precedent rather than quietly dropping it on the way to
   * the queue.
   *
   * Deliberately NO percentage threshold between the two. A 50%-failure
   * run is a real, partial, usable result and the honest report is
   * "complete, 90 scored, 90 failed" with the counts on screen; inventing
   * a "mostly failed" middle state would be a number nobody measured.
   */
  function terminalStatusFor(derived: DerivedSearchState): "complete" | "failed" {
    if (derived.linked === 0) {
      // Nothing was linked. That is a real, empty, successful search
      // UNLESS no source ever succeeded, in which case the search did not
      // run at all and saying "complete, 0 results" would be a lie.
      return derived.allSourcesFailed ? "failed" : "complete";
    }
    if (derived.scored === 0 && derived.permanentlyFailed > 0) return "failed";
    return "complete";
  }

  /**
   * Opportunistic, monotonic latch (design c54b9e0 §3.3/§5.2). Safe to
   * race: `WHERE completed_at IS NULL` means the first writer wins and
   * every later one no-ops, so two concurrent polls cannot disagree.
   *
   * DEVIATION FROM THE DESIGN, STATED: §5.2 latches `status = 'complete'`
   * unconditionally. This latches the DERIVED terminal status instead, so
   * a total scoring failure leaves `searches.status = 'failed'` rather
   * than a row that claims `'complete'` while every read of it reports
   * `"failed"` (§8). Same write, same idempotency, one less contradiction
   * in the database.
   */
  async function latchTerminal(searchId: string, status: "complete" | "failed"): Promise<Date> {
    const completedAt = new Date();
    try {
      await db
        .update(searchesTable)
        .set({ status, completedAt })
        .where(and(eq(searchesTable.id, searchId), isNull(searchesTable.completedAt)));
    } catch (err) {
      // Best-effort, exactly like markSearchFailed: the derive is the
      // source of truth and re-runs on the next poll, so a failed latch
      // costs one skipped fast path, never a wrong answer.
      app.log.error({ err, searchId }, "failed to latch searches.completed_at");
    }
    return completedAt;
  }

  /** The outstanding jobIds behind a stalled search — enumerated ONLY in
   * the stalled branch, because that is the only time anyone needs to go
   * find them in the DLQ by hand. A healthy pending search can have
   * hundreds outstanding and has no use for the list. */
  async function outstandingJobIdsFor(searchId: string): Promise<string[]> {
    const rows = await db
      .select({ jobId: searchResults.jobId })
      .from(searchResults)
      .innerJoin(searchesTable, eq(searchesTable.id, searchResults.searchId))
      .leftJoin(
        jobMatches,
        and(
          eq(jobMatches.jobId, searchResults.jobId),
          eq(jobMatches.resumeId, searchesTable.resumeId),
        ),
      )
      .leftJoin(
        jobMatchFailures,
        and(
          eq(jobMatchFailures.jobId, searchResults.jobId),
          eq(jobMatchFailures.resumeId, searchesTable.resumeId),
        ),
      )
      .where(
        and(
          eq(searchResults.searchId, searchId),
          isNull(jobMatches.id),
          isNull(jobMatchFailures.id),
        ),
      );
    return rows.map((row) => row.jobId);
  }

  /** Builds the terminal response for a search whose details ARE
   * derivable (i.e. one this design's ledger covers). Shared by the
   * `completed_at`-latched fast path and the first poll that observes a
   * running search reach terminal. */
  function terminalResponse(
    searchId: string,
    resumeId: string,
    derived: DerivedSearchState,
    status: "complete" | "failed",
    completedAt: Date,
  ): SearchStatusResponse {
    if (status === "failed") {
      return {
        searchId,
        resumeId,
        status: "failed",
        error:
          derived.linked === 0
            ? "Every source this search selected failed; nothing could be fetched."
            : `Total scoring failure: none of this search's ${derived.linked} job(s) could be ` +
              `scored (${derived.permanentlyFailed} permanently failed). This is usually a ` +
              `systemic problem — an expired API key, a retired model id, or an exhausted ` +
              `spend guard — not a property of the jobs.`,
      };
    }
    return {
      searchId,
      resumeId,
      status: "complete",
      scored: derived.scored,
      permanentlyFailed: derived.permanentlyFailed,
      linked: derived.linked,
      sources: derived.sources,
      completedAt: completedAt.toISOString(),
      degraded: derived.permanentlyFailed > 0,
    };
  }

  app.post<{ Body: SearchBody }>(
    "/searches/estimate",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds, criteria } = request.body;
      const resumeText = await loadResumeText(resumeId);
      if (resumeText === undefined) {
        return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
      }

      const resolved = resolveSources(sourceIds);
      if (!resolved.ok) {
        return reply.code(400).send({
          error: "None of the requested sourceIds could be used.",
          skippedSources: resolved.skipped,
        });
      }

      const result = await runDemoMatch({
        db,
        sources: resolved.sources,
        resumeText,
        criteria: buildFetchCriteria(criteria),
        scoreJob: NEVER_SCORE,
        filter: compileFilter(criteria),
        excludedForMissingWorkArrangement: compileExcludedForMissingWorkArrangement(criteria),
        estimateOnly: true,
        outputPath: tempOutputPath(`estimate-${randomUUID()}`),
      });

      // No `searchId` in this response (ticket 59fdc52 review round 2):
      // this run's `searches` row is not something a caller can honestly
      // poll — `runDemoMatch` marks it `'complete'` immediately and it has
      // no queue-driven ledger behind it, so `GET /searches/:id` would
      // report `complete-details-unavailable` for a search that scored
      // nothing. Simplest correct fix: don't hand out an id there's no
      // honest way to poll.
      const response: EstimateSearchResponse = {
        resumeId,
        costEstimate: result.costEstimate,
        candidatesNeedingScore: result.candidatesNeedingScore,
        scoreThreshold: result.scoreThreshold,
        cappedCount: result.cappedCount,
        alreadyScored: result.skipped,
        sourceOutcomes: result.sourceOutcomes,
        skippedSources: resolved.skipped,
      };
      return reply.send(response);
    },
  );

  app.post<{ Body: SearchBody }>(
    "/searches",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds, criteria } = request.body;
      const resumeText = await loadResumeText(resumeId);
      if (resumeText === undefined) {
        return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
      }

      const resolved = resolveSources(sourceIds);
      if (!resolved.ok) {
        return reply.code(400).send({
          error: "None of the requested sourceIds could be used.",
          skippedSources: resolved.skipped,
        });
      }

      // Ticket 59fdc52 review round 3, F2 (blocking, live-verified):
      // `getScoreJob()` is resolved HERE, before any state is written.
      // Production's factory is `() => makeClaudeScorer(new Anthropic())`
      // (index.ts), and `new Anthropic()` throws SYNCHRONOUSLY when
      // `ANTHROPIC_API_KEY` is unset — a real, supported state (every
      // read-only route and even `POST /searches/estimate` must keep
      // working without billing credentials configured). The original
      // defect was calling it AFTER the in-flight guard had already
      // marked this resume, with nothing left to release it: every later
      // `POST /searches` for that resume 409'd forever.
      //
      // KEPT DELIBERATELY EVEN THOUGH THIS ROUTE NO LONGER SCORES (ticket
      // 4f88339). The route still AUTHORIZES the spend that
      // `scoreJobWorker` performs, and refusing early is better than
      // publishing N messages that every scoring worker will then
      // permanently fail on — with a `job_match_failures` row each and a
      // DLQ entry each — for a reason we could have detected in one
      // synchronous call here. The value is discarded; it is the throw
      // that matters.
      try {
        getScoreJob();
      } catch (err) {
        return reply.code(500).send({
          error: `Cannot start a search: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // THE IN-FLIGHT GUARD IS NOW DURABLE (design c54b9e0 §4.4). It used
      // to be an in-memory `Map<resumeId, searchId>` released by
      // `.finally()` on the `runDemoMatch` promise. There is no promise
      // any more — nothing would ever release it — so it has to be a
      // query. Guards per resumeId, not globally: two DIFFERENT resumes
      // searching at once is fine and unrelated.
      //
      // The `searched_at` window is what stops one stalled search from
      // 409-ing a resume forever, which is the exact class of bug ticket
      // 59fdc52 review round 3 F2 found in the in-memory version.
      //
      // The `status = 'running'` predicate is also what keeps
      // `POST /searches/estimate` from wedging this: an estimate run
      // inserts a REAL `searches` row (and real `search_sources` rows,
      // all still `pending`, since nothing ever fetches for them), and
      // under a naive derive that row would be non-terminal forever and
      // 409 every subsequent real search for that resume. It does not,
      // because `runDemoMatch` sets `status = 'complete'` on it. Do not
      // "simplify" this predicate away — there is a regression test for
      // exactly this.
      const liveRows = await db
        .select({ id: searchesTable.id })
        .from(searchesTable)
        .where(
          and(
            eq(searchesTable.resumeId, resumeId),
            eq(searchesTable.status, "running"),
            isNull(searchesTable.completedAt),
            gt(searchesTable.searchedAt, new Date(Date.now() - STALL_AFTER_MS)),
          ),
        )
        .orderBy(desc(searchesTable.searchedAt))
        .limit(1);
      const liveSearchId = liveRows[0]?.id;
      if (liveSearchId !== undefined) {
        const derived = await deriveSearchState(liveSearchId);
        if (!derived.isTerminal) {
          return reply.code(409).send({
            error: `A search is already running for this resume.`,
            searchId: liveSearchId,
          });
        }
        // It finished and nobody has polled it since. Latch it now rather
        // than leaving a terminal row looking live to the next request.
        await latchTerminal(liveSearchId, terminalStatusFor(derived));
      }

      // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
      // db/seed.ts. `runDemoMatch` does the same thing for the same
      // reason: `search_sources.source_descriptor_id` has an FK to
      // `source_descriptors`, which would reject the insert below on a
      // database that has never run a search.
      await seedSourceDescriptors(db);

      const searchId = randomUUID();

      // DB-THEN-PUBLISH, AND THIS ORDERING IS LOAD-BEARING (design
      // c54b9e0 §4.1). If we published first, a worker could consume
      // `fetch.source` before the `searches` row exists;
      // `ingestJobsForSearch` would then violate the
      // `search_results.search_id -> searches.id` FK, the message would
      // classify as a retryable "unknown" failure, and we would burn the
      // whole retry budget racing our own commit. The chosen order's
      // failure mode is the benign one: a committed search with a source
      // row that never got a message — which the dispatch-failure branch
      // below marks `failed` immediately, and which the staleness
      // backstop catches even if that branch itself fails.
      //
      // One transaction, so a search row can never exist without its
      // source rows (which would make it permanently, vacuously
      // "complete": no pending sources, no linked jobs).
      await db.transaction(async (tx) => {
        await tx
          .insert(searchesTable)
          .values({ id: searchId, resumeId, searchedAt: new Date(), status: "running" });
        await tx.insert(searchSources).values(
          resolved.sources.map((source) => ({
            id: randomUUID(),
            searchId,
            sourceDescriptorId: source.dataSource,
            status: "pending" as const,
          })),
        );
      });

      const fetchCriteria = buildFetchCriteria(criteria);
      const messages: FetchSourceMessage[] = resolved.sources.map((source) => ({
        searchId,
        sourceId: source.dataSource,
        criteria: fetchCriteria,
      }));

      let failures: Awaited<ReturnType<PublishFetchSourceFn>>;
      try {
        failures = await publishFetchSource(messages);
      } catch (err) {
        // The publisher could not even connect. Every source failed to
        // dispatch — same outcome as N individual failures, reported the
        // same way.
        const error = err instanceof Error ? err.message : String(err);
        failures = messages.map((message) => ({ sourceId: message.sourceId, error }));
      }

      for (const failure of failures) {
        try {
          await db
            .update(searchSources)
            .set({
              status: "failed",
              errorKind: "dispatch-failed",
              errorMessage: failure.error,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(searchSources.searchId, searchId),
                eq(searchSources.sourceDescriptorId, failure.sourceId),
              ),
            );
        } catch (err) {
          // Best-effort, like every other failure-path marker write in
          // this design: the staleness backstop is what catches a source
          // whose marker never landed. Never throw here — the response
          // below still has to tell the caller what happened.
          app.log.error(
            { err, searchId, sourceId: failure.sourceId },
            "failed to mark search_sources.status = 'failed' after a dispatch failure",
          );
        }
      }

      if (failures.length === messages.length) {
        await markSearchFailed(searchId);
        return reply.code(502).send({
          error:
            `Could not dispatch this search: none of its ${messages.length} source message(s) ` +
            `could be published. Is RabbitMQ running and has setupTopology() been run?`,
          searchId,
          skippedSources: resolved.skipped,
        });
      }

      const response: StartSearchResponse = {
        searchId,
        status: "pending",
        skippedSources: resolved.skipped,
      };
      return reply.code(202).send(response);
    },
  );

  app.get<{ Params: { id: string } }>("/searches/:id", async (request, reply) => {
    const searchId = request.params.id;

    const rows = await db
      .select({
        id: searchesTable.id,
        resumeId: searchesTable.resumeId,
        status: searchesTable.status,
        searchedAt: searchesTable.searchedAt,
        completedAt: searchesTable.completedAt,
      })
      .from(searchesTable)
      .where(eq(searchesTable.id, searchId))
      .limit(1);
    if (rows.length === 0) {
      return reply.code(404).send({ error: `No search with id "${searchId}".` });
    }
    const row = rows[0]!;

    // ALREADY LATCHED -> this search's details are derivable, so answer
    // richly and identically on every subsequent poll.
    //
    // DEVIATION FROM THE DESIGN, STATED (c54b9e0 §3.3 describes
    // `completed_at` as "a one-row fast path that skips the aggregate
    // query"): it cannot be, and the design contradicts itself here. §5.3
    // requires the `complete` member to carry `scored`,
    // `permanentlyFailed`, `linked` and `sources[]` — all of which ARE
    // the aggregate. There is nothing to skip to. What `completed_at`
    // does buy, and what it is used for here, is the DISTINCTION the read
    // path actually needs: a row with the latch set has a queue-driven
    // ledger behind it and can be answered in full; a row without one
    // (CLI, estimate, pre-migration) cannot, and must keep getting ticket
    // 59fdc52's honest `complete-details-unavailable`.
    if (row.completedAt !== null) {
      const derived = await deriveSearchState(searchId);
      const response = terminalResponse(
        row.id,
        row.resumeId,
        derived,
        // Trust the latched status over a re-derive: `§6.2`'s one narrow
        // race (a redelivered fetch linking a NEW job after the latch)
        // would otherwise flip a completed search back to non-terminal
        // and report it as `complete` with an outstanding job. The latch
        // is the decision; the derive only supplies its numbers.
        row.status === "failed" ? "failed" : "complete",
        row.completedAt,
      );
      return reply.send(response);
    }

    if (row.status === "failed") {
      // Authoritative and unchanged (ticket 59fdc52): the search could not
      // be dispatched at all.
      const response: SearchStatusResponse = {
        searchId: row.id,
        resumeId: row.resumeId,
        status: "failed",
      };
      return reply.send(response);
    }

    if (row.status === "complete") {
      // Terminal, but with no queue-driven ledger behind it: a CLI
      // (`runDemoMatch`) row, a `POST /searches/estimate` row, or a row
      // from before this migration. Answered exactly the way ticket
      // 59fdc52 made it answer. Deleting this member would regress that.
      const response: SearchStatusResponse = {
        searchId: row.id,
        resumeId: row.resumeId,
        status: "complete-details-unavailable",
        note:
          "This search finished outside the queue-driven path (a CLI run, an estimate, or a " +
          "run from before per-source tracking existed), so per-source and per-job details " +
          "aren't available. Its results are in the database — see GET /resumes/:id/results.",
      };
      return reply.send(response);
    }

    const derived = await deriveSearchState(searchId);

    if (derived.sources.length === 0) {
      // A `running` row with NO `search_sources` rows at all. Not
      // reachable for a queue-driven search (the route writes both in one
      // transaction) — this is a pre-migration row, or one whose process
      // died between the two inserts under the old code. There is nothing
      // to derive from, so say so honestly rather than reporting a
      // vacuously-pending search that will never move.
      const response: SearchStatusResponse = {
        searchId: row.id,
        resumeId: row.resumeId,
        status: "incomplete",
        note:
          "This search's completion marker was never set and it has no per-source tracking " +
          "rows to derive progress from — it may still be running elsewhere, or it may have " +
          "died before finishing. Results scored so far, if any, are in the database — see " +
          "GET /resumes/:id/results.",
      };
      return reply.send(response);
    }

    if (derived.isTerminal) {
      const status = terminalStatusFor(derived);
      const completedAt = await latchTerminal(searchId, status);
      return reply.send(terminalResponse(row.id, row.resumeId, derived, status, completedAt));
    }

    const stalled = row.searchedAt.getTime() < Date.now() - STALL_AFTER_MS;
    const response: SearchStatusResponse = {
      searchId: row.id,
      resumeId: row.resumeId,
      status: "pending",
      scoredSoFar: derived.scored,
      linked: derived.linked,
      permanentlyFailed: derived.permanentlyFailed,
      sourcesSettled: derived.sourcesSettled,
      sources: derived.sources,
      ...(stalled
        ? {
            stalledSince: row.searchedAt.toISOString(),
            outstandingJobIds: await outstandingJobIdsFor(searchId),
          }
        : {}),
    };
    return reply.send(response);
  });
}
