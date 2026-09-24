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
 * authorize is bounded by things in OTHER files, not by anything in this
 * one.
 *
 * WHAT BOUNDS IT, AMENDED (ticket 4f88339, adversarial review round 1, F1).
 * An earlier version of this comment said `runDemoMatch`'s per-run
 * `DEFAULT_SCORE_THRESHOLD` cap of 200 jobs "does not apply to the queue
 * path at all", on the reasoning that no single place sees a whole
 * queue-driven run. True about the SEARCH; false as a conclusion, and the
 * gap was expensive: `POST /searches/estimate` shows the caller a filtered,
 * `DEFAULT_SCORE_THRESHOLD`-capped number, so a queue path with no cap at
 * all could spend ~30x what the user was shown and consented to — the exact
 * defect ticket 59fdc52 review round 2 had already fixed once for the
 * estimate itself. The cap is now applied where a single place DOES see a
 * bounded slice of the run: `fetchSourceWorker` publishes `score.job`
 * messages only up to what is left of a budget of `DEFAULT_SCORE_THRESHOLD`
 * jobs SHARED ACROSS ALL OF ONE SEARCH'S SOURCES.
 *
 * AMENDED AGAIN (ticket c9c676d): that budget used to be per (search,
 * source) pair rather than per search, so the real worst case was
 * `num_sources x 200` — five configured adapters, 1,000 scored jobs, ~$22
 * actual against a 200-job estimate and against a $15 lifetime-per-process
 * spend ceiling that one search could therefore drain outright. Crucially
 * the overrun did NOT need the per-source cap to bind: five sources at 60
 * filtered jobs each publish 300 against a 200-job estimate while every one
 * of them sits at 30% of its own cap, and this codebase's own measured
 * survival numbers put an un-narrowed multi-source pool at ~250-310. It is
 * now a TRUE per-search cap, enforced with a SET-never-incremented claim
 * (`search_sources.published_job_count`) read and written under
 * `pg_advisory_xact_lock(hashtext(search_id))` — the same advisory-lock
 * pattern this file uses below for the in-flight guard, scoped to the search
 * instead of the resume. fetchSourceWorker.ts's "THE PER-SEARCH SCORING CAP"
 * section carries the arithmetic, the numbers above, and the invariant.
 * `scoreJobWorker`'s `ScoringSpendGuard` (a lifetime-per-process ceiling,
 * ticket b53c422) remains the last-resort backstop underneath it, not the
 * only one.
 *
 * CLOSED (ticket 45ea34c) — this paragraph used to flag the QUALITY FILTER
 * as a known gap in the queue path, and it is worth keeping the history:
 * the filter below (`compileFilter`) is a LOCAL, post-fetch filter that
 * `runDemoMatch` applies between fetching and scoring, and ticket 4f88339's
 * queue path shipped with no equivalent. `fetchSourceWorker` ingested
 * everything a source returned and published `score.job` for the first
 * `DEFAULT_SCORE_THRESHOLD` linked jobs IN RAW SOURCE ORDER, so the user's
 * stated criteria took effect only on `POST /searches/estimate` (still
 * synchronous) and the CLI. Live consequence, 2026-09-23: a search for a
 * specific Seattle staff-engineering title, estimated at 1 job, linked all
 * 6,418 Greenhouse postings and scored 200 unrelated sales roles.
 *
 * The fix: `POST /searches` now puts the caller's full `@app/shared`
 * `SearchCriteria` on every `fetch.source` message as `filterCriteria`
 * (SEPARATE from the narrowed, source-query-hint `criteria` field —
 * `buildFetchCriteria` below drops everything but titles, so the two cannot
 * share a slot), and the worker applies `compileFilter` to it before
 * ingesting. The wire format for the filter's three-way state — absent
 * `criteria` -> the CLI default filter, an explicit `criteria` ->
 * `compileFilter(criteria)`, an explicit `{}` -> permissive/dedupe-only —
 * is encoded as `object | null | absent`; see
 * `FetchSourceMessage.filterCriteria`'s doc comment for why `null` rather
 * than an omitted key carries "no criteria supplied". The scoring cap
 * (above) is orthogonal: it bounds HOW MANY jobs a run scores, this bounds
 * WHICH. Note what that orthogonality does NOT buy, since an earlier version
 * of this paragraph leaned on it (ticket c9c676d): filtering shrinks each
 * source's pool, so the cap binds less often per source — but the
 * estimate-vs-spend gap was never about the per-SOURCE cap binding, it was
 * about the per-SEARCH total, which filtering does not bound at all. That is
 * what the per-search cap now bounds.
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
 * caller opts out of filtering entirely. Since ticket 45ea34c this applies
 * on BOTH routes — the estimate compiles it here, and `POST /searches`
 * ships it to `fetchSourceWorker` on the message so the queue path compiles
 * the identical filter (see the CLOSED paragraph above).
 *
 * SKIPPING A SOURCE THE ESTIMATE JUST PROVED EMPTY (ticket 447e210). Until
 * this ticket, the estimate above and the real search below were two
 * completely independent live fetches — nothing carried the estimate's
 * per-source "this source yields zero jobs after filtering" outcome into
 * the real search that follows it moments later, so a source the estimate
 * just proved empty got queried live all over again. `zeroResultCache`
 * (matching/zeroResultCache.ts) is the short-lived, in-memory bridge: the
 * estimate handler RECORDS a zero for every `sourceOutcome` with
 * `survivedFilter === 0` (and `status !== "error"` — an error means "we
 * don't know," not "we know it's empty," and must never be cached as a
 * zero); `POST /searches` READS it per selected source, keyed on the EXACT
 * `(resumeId, criteria, sourceId)` triple, before deciding whether to
 * publish a `fetch.source` message for that source at all. A source hitting
 * the cache gets its `search_sources` row written `complete`/`linkedJobCount:
 * 0` directly, in the SAME insert that writes every other source's `pending`
 * row — so it can never be observed `pending` even by the very next poll.
 * See that module's own doc comment for why the cache is in-memory, why the
 * key is the whole criteria object rather than a hand-picked projection of
 * it, and why the reuse window is 5 minutes specifically.
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
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
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
import { ZeroResultEstimateCache } from "../matching/zeroResultCache.js";
import { createAmqpFetchSourcePublisher, type PublishFetchSourceFn } from "../queue/publisher.js";
import { compileExcludedForMissingWorkArrangement, compileFilter } from "../sources/criteria.js";
import { buildSourceSelection } from "../sources/registry.js";
// `SCORE_THRESHOLD_CAPPED_KIND` is a VALUE import, not a type one (ticket
// c9c676d): the completion derive below filters `job_match_failures.kind` on
// it, so the writer and the reader of that string must be the same constant.
// No cycle — fetchSourceWorker imports nothing from this file — and no new
// runtime dependency, since this module already imports the AMQP publisher.
import {
  SCORE_THRESHOLD_CAPPED_KIND,
  type FetchSourceMessage,
} from "../worker/fetchSourceWorker.js";
import type { JobSource, SearchCriteria as SourceFetchCriteria } from "../sources/types.js";

const searchCriteriaSchema = {
  type: "object",
  properties: {
    titleInclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    titleExclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    nearLocations: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    // Ticket 410e1a2. Listed here because `additionalProperties: false` above
    // is enforced (not merely stripped -- see the round-3/F1 test in
    // searches.test.ts), so a field the schema does not name is a 400, not a
    // silently-ignored flag: the checkbox would fail the whole search rather
    // than quietly do nothing.
    expandMetroAreas: { type: "boolean" },
    remoteOk: { type: "boolean" },
    // Ticket 807561c: `@app/shared`'s `SearchCriteria.commitmentIn` (added by
    // ticket 18c9f18, and already wired all the way through
    // `compileFilter`/the web UI's checkboxes) was never added HERE, so
    // `additionalProperties: false` below rejected every request that set
    // it with a 400 naming `commitmentIn` -- live-reproduced, checking any
    // of the UI's Full-time/Part-time/Contract filters broke the search
    // outright. The enum mirrors `Job["commitment"]` (packages/shared)
    // exactly, the same way this schema mirrors every other
    // `SearchCriteria` field's shape/rigor.
    commitmentIn: {
      type: "array",
      items: { type: "string", enum: ["full-time", "part-time", "contract"] },
      maxItems: 3,
    },
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
 * It is NOT sufficient for LOCAL filtering, and must never be repurposed as
 * such (ticket 45ea34c): this function deliberately keeps only title
 * phrases, so `titleExclude`, `nearLocations`, `remoteOk` and
 * `commitmentIn` are gone by the time the result leaves here. The worker
 * gets the caller's untranslated `@app/shared` criteria in a SEPARATE
 * message field (`filterCriteria`) for exactly that reason.
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

/**
 * "Is there a search for this resume that still counts as live?" — the
 * `searches`-row half of the in-flight guard (design c54b9e0 §4.4).
 *
 * Extracted (ticket 4f88339 review round 1, F2) because the guard is now
 * evaluated TWICE per request against exactly the same predicate: once as a
 * cheap pre-check outside the transaction, and once inside the
 * advisory-locked transaction where it is actually enforced. Two hand-
 * written copies of a four-clause predicate would drift, and a drift here
 * is silent — the two layers would simply disagree about what "live" means
 * and the guard would develop a hole nobody could see by reading either
 * copy.
 *
 * Each clause carries its own weight (see the call site's comment for the
 * full story): `status = 'running'` is what keeps a `POST /searches/estimate`
 * row — which `runDemoMatch` marks `complete` — from wedging the resume;
 * `completed_at IS NULL` respects the completion latch; and the
 * `searched_at` window is what stops one stalled search from 409-ing a
 * resume forever.
 */
function liveSearchPredicate(resumeId: string) {
  return and(
    eq(searchesTable.resumeId, resumeId),
    eq(searchesTable.status, "running"),
    isNull(searchesTable.completedAt),
    gt(searchesTable.searchedAt, new Date(Date.now() - STALL_AFTER_MS)),
  );
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
  /**
   * GENUINE scoring failures only — a `job_match_failures` row whose `kind`
   * is anything but `SCORE_THRESHOLD_CAPPED_KIND` (ticket c9c676d). Narrowed
   * from "every failure row"; see `cappedForBudget`.
   */
  permanentlyFailed: number;
  /**
   * Linked jobs the fetch worker never sent for scoring because the search's
   * shared scoring budget was already spent —
   * `job_match_failures.kind = SCORE_THRESHOLD_CAPPED_KIND`. Counted
   * separately from `permanentlyFailed` because it is not a failure, and
   * because reporting it as one made a budget-bounded run indistinguishable
   * from an outage in the API response.
   */
  cappedForBudget: number;
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
  /**
   * The estimate-to-search zero-result bridge (ticket 447e210 — see this
   * file's own doc comment section "SKIPPING A SOURCE THE ESTIMATE JUST
   * PROVED EMPTY" and `zeroResultCache.ts`). Defaults to a fresh, process-
   * local instance — evaluated once, at the single real call site
   * (`index.ts`'s `buildApp`), so production gets one instance that lives
   * for the process's lifetime, exactly like `createAmqpFetchSourcePublisher()`
   * above. Overridable so a test can inject an instance with a controllable
   * clock (to exercise window expiry without a real sleep) or share one
   * instance across two `buildApp` calls that must see each other's writes.
   */
  zeroResultCache: ZeroResultEstimateCache = new ZeroResultEstimateCache(),
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
   * `search_id`; `job_matches (resume_id, job_id)` is a direct lookup with
   * `resume_id` constant from the `searches` row, and
   * `job_match_failures (search_id, resume_id, job_id)` (ticket 9a53485)
   * leads on `search_id`, which is constant for the search being derived —
   * strictly better served than the `(resume_id, job_id)` key it replaced.
   * No new index is needed for this — worth saying out loud so nobody
   * "optimizes" by adding redundant ones.
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
        // TWO FILTERS WHERE THERE USED TO BE ONE (ticket c9c676d).
        // `job_match_failures` rows are written for two unrelated reasons —
        // scoring was attempted and permanently failed, or scoring was
        // deliberately never attempted because the search's shared budget was
        // spent (fetchSourceWorker's `SCORE_THRESHOLD_CAPPED_KIND`) — and
        // counting them together reported a run that merely hit its cost cap
        // as though it had suffered an outage. The `kind` column has carried
        // the distinction durably on every row since ticket 4f88339; these
        // two `filter` clauses are what finally read it.
        //
        // Deliberately split HERE rather than in a second query: same join,
        // same scan, one extra aggregate. The `${jobMatches.id} is null`
        // conjunct is preserved on both — a job with BOTH a score and a
        // failure row (reachable: a capped job that a redelivered `score.job`
        // later scored anyway) counts as `scored` and nothing else, exactly
        // as before.
        permanentlyFailed:
          sql<number>`count(*) filter (where ${jobMatches.id} is null and ${jobMatchFailures.id} is not null and ${jobMatchFailures.kind} <> ${SCORE_THRESHOLD_CAPPED_KIND})`.mapWith(
            Number,
          ),
        cappedForBudget:
          sql<number>`count(*) filter (where ${jobMatches.id} is null and ${jobMatchFailures.id} is not null and ${jobMatchFailures.kind} = ${SCORE_THRESHOLD_CAPPED_KIND})`.mapWith(
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
      // SCOPED TO THIS SEARCH (ticket 9a53485). The `searchId` conjunct is
      // the whole fix: without it this join matched any failure row for the
      // same (resume, job), so a job an EARLIER search had capped or
      // permanently failed was already non-outstanding here — counted into
      // this search's `cappedForBudget`/`permanentlyFailed` and able to
      // latch it terminal before its own freshly-published `score.job` had
      // resolved. Both writers stamp `search_id` now; see
      // `jobMatchFailures`' doc comment in db/schema.ts for the decision.
      //
      // `resumeId` stays in the predicate even though `searchId` implies it
      // (the column is denormalized off `searches.resume_id`): it keeps
      // this join symmetric with the `job_matches` one above, and the
      // unique index is on exactly these three columns.
      .leftJoin(
        jobMatchFailures,
        and(
          eq(jobMatchFailures.searchId, searchResults.searchId),
          eq(jobMatchFailures.jobId, searchResults.jobId),
          eq(jobMatchFailures.resumeId, searchesTable.resumeId),
        ),
      )
      .where(eq(searchResults.searchId, searchId));

    const counts = aggregates[0] ?? {
      linked: 0,
      scored: 0,
      permanentlyFailed: 0,
      cappedForBudget: 0,
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
      cappedForBudget: counts.cappedForBudget,
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
   *
   * BUDGET-CAPPED JOBS ARE NOT PART OF THIS TEST (ticket c9c676d).
   * `derived.permanentlyFailed` is now genuine failures only, so the total-
   * scoring-failure carve-out below reads the number it always meant to.
   * The old, conflated count could in principle have called a search
   * `"failed"` for hitting its own cost cap — precisely the "outage dressed
   * as a finished search" mistake in reverse, a successful search dressed as
   * an outage. `cappedForBudget` is deliberately absent from this function:
   * "we scored as many as you paid for" is a completion, not a failure.
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
      // Same search-scoped predicate as `deriveSearchState`'s join above
      // (ticket 9a53485) — these two must agree on what "outstanding"
      // means, or the stalled branch would enumerate a different set of
      // jobIds than the count that declared the search stalled.
      .leftJoin(
        jobMatchFailures,
        and(
          eq(jobMatchFailures.searchId, searchResults.searchId),
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
      cappedForBudget: derived.cappedForBudget,
      linked: derived.linked,
      sources: derived.sources,
      completedAt: completedAt.toISOString(),
      // GENUINE FAILURES ONLY (ticket c9c676d) — `cappedForBudget` is
      // deliberately not in this disjunction. See the field's own doc
      // comment in @app/shared for the full argument; the short version is
      // that a search which scored exactly the 200 jobs its estimate priced
      // is a successful search, and marking it `degraded` would burn the
      // one signal the UI has for searches where something really did break.
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

      // Ticket 447e210: record every source this estimate just proved a
      // dead end (0 jobs survived `filter`) so a real search for the same
      // (resumeId, criteria, sourceId, selection) starting soon after can
      // skip re-querying it live. `status !== "error"` is load-bearing, not
      // decoration: "error" means this source's `search()` call itself
      // rejected — the estimate LEARNED NOTHING about whether it has
      // postings — and caching that as "zero jobs" would tell a real search
      // to skip a source we have no actual evidence is empty, defeating the
      // whole "the UI shows that source as unavailable, and the other
      // sources still return" behavior CLAUDE.md asks for by silently
      // turning a transient error into a fabricated success.
      // `selectedSourceIds` is this ESTIMATE's own full selection (opus
      // review round 1, F2) -- required because `outcome.survivedFilter`
      // reflects filtering against the UNION of every source selected
      // here, cross-source dedupe included, not this one source in
      // isolation. A zero recorded under this selection must not be
      // replayed for a search with a different one.
      const estimateSourceIds = resolved.sources.map((source) => source.dataSource);
      for (const outcome of result.sourceOutcomes) {
        if (outcome.status !== "error" && outcome.survivedFilter === 0) {
          zeroResultCache.record({
            resumeId,
            sourceId: outcome.dataSource,
            criteria,
            selectedSourceIds: estimateSourceIds,
          });
        }
      }

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
      // THIS BLOCK IS THE PRE-CHECK, NOT THE GUARD (ticket 4f88339 review
      // round 1, F2). It is what runs the DERIVE — the expensive,
      // two-query "has this search actually finished?" question, which
      // must not run while holding a lock — and what answers the common,
      // uncontended case without paying for a transaction at all. The
      // atomic check-and-insert that actually makes the guard hold under
      // concurrency is the advisory-locked transaction further down; read
      // its comment before changing anything here, because the two halves
      // are one mechanism.
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
        .where(liveSearchPredicate(resumeId))
        .orderBy(desc(searchesTable.searchedAt))
        .limit(1);
      const liveSearchId = liveRows[0]?.id;
      // Set only when the pre-check found a live-looking row and PROVED it
      // terminal. The guarded re-check inside the transaction below has no
      // derive of its own (see its comment for why), so it has to be told
      // which row this request already adjudicated — otherwise a
      // best-effort `latchTerminal` that failed would leave a genuinely
      // finished search 409-ing this request, a regression on today's
      // behaviour.
      let settledSearchId: string | undefined;
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
        settledSearchId = liveSearchId;
      }

      // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
      // db/seed.ts. `runDemoMatch` does the same thing for the same
      // reason: `search_sources.source_descriptor_id` has an FK to
      // `source_descriptors`, which would reject the insert below on a
      // database that has never run a search.
      //
      // Deliberately OUTSIDE the guarded transaction below: it is unrelated
      // to this resume, and doing it while holding the advisory lock would
      // make every concurrent request for the same resume wait on it for no
      // reason.
      await seedSourceDescriptors(db);

      // Ticket 447e210: which of THIS request's sources does the
      // zero-result cache say were just proven a dead end for this EXACT
      // (resumeId, criteria, sourceId, selection) combination? A pure
      // in-memory read, no DB
      // involved, so it costs nothing to compute here and reuse below —
      // once to decide each source's INITIAL `search_sources` row (a cache
      // hit is written `complete` from the start, never `pending`), and
      // once to decide which sources actually get a `fetch.source` message.
      // `selectedSourceIds` is THIS search's own full selection (opus
      // review round 1, F2) -- a zero only counts if it was recorded under
      // this EXACT selection; a search with a different source selection
      // (even a subset or superset) always misses and falls through to a
      // real fetch. See `ZeroResultCacheKey`'s doc comment for why.
      const searchSourceIds = resolved.sources.map((source) => source.dataSource);
      const cachedZeroSourceIds = new Set(
        resolved.sources
          .filter((source) =>
            zeroResultCache.hasZeroResult({
              resumeId,
              sourceId: source.dataSource,
              criteria,
              selectedSourceIds: searchSourceIds,
            }),
          )
          .map((source) => source.dataSource),
      );

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
      //
      // AND — ticket 4f88339, adversarial review round 1, F2 — this
      // transaction is now also where the IN-FLIGHT GUARD IS ACTUALLY
      // ENFORCED. The check above is a fast pre-check, not the guard: it is
      // one `await` and the insert is another, with a real gap in between,
      // so two concurrent `POST /searches` for the same resume both passed
      // the SELECT (neither can see the other's uncommitted INSERT), both
      // got 202, both created a `searches` row, and both fanned out a full
      // set of `fetch.source` messages — double the spend the caller
      // authorized. The review reproduced this against a live `buildApp`
      // with `Promise.all`. It is the same double-click defect ticket
      // 59fdc52 review round 3 F2 fixed for the old in-memory `Map`
      // version, reintroduced by making the guard durable without making it
      // atomic.
      //
      // `pg_advisory_xact_lock` serializes the re-check and the insert per
      // resume: the second request BLOCKS inside its own transaction until
      // the first commits, then re-reads and sees the committed row. The
      // lock is transaction-scoped, so it is released by COMMIT or ROLLBACK
      // with nothing to leak — no unlock call to forget, no stuck lock if
      // this handler throws.
      //
      // WHY A LOCK AND NOT A PARTIAL UNIQUE INDEX on
      // `searches (resume_id) WHERE status = 'running' AND completed_at IS
      // NULL`, which was the other candidate: that index would be WRONG for
      // this schema, in three separate ways this route already depends on.
      // (1) A stalled search stays `running` with `completed_at` NULL
      // forever — the staleness window (`STALL_AFTER_MS`) exists precisely
      // so such a row stops blocking — but the index has no notion of
      // `searched_at` and would reject the replacement search outright,
      // permanently wedging that resume. That is the exact bug 59fdc52
      // round 3 F2 fixed. (2) `runDemoMatch` (the CLI, and
      // `POST /searches/estimate`) inserts a `running` row and only later
      // sets it `complete`, so two concurrent estimates for one resume
      // would start 500-ing on a constraint violation. (3) It constrains a
      // condition the app treats as advisory, whereas the lock constrains
      // the CODE PATH, which is what actually needed serializing.
      //
      // `hashtext` is an internal-but-long-stable Postgres function
      // returning int4; collisions between two different resumeIds are
      // possible and cost only brief serialization between two unrelated
      // searches — never a wrong answer, since the re-check inside the lock
      // filters on `resume_id` itself.
      const conflictingSearchId = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${resumeId}))`);

        // The re-check is PURE SQL — deliberately no `deriveSearchState`
        // here, for two reasons. First, correctness: a row that a
        // concurrent racer committed microseconds ago is always
        // `running`/unlatched/fresh and always has pending sources, so
        // there is nothing for a derive to discover; and any row that was
        // ALREADY terminal was found, derived and latched by the pre-check
        // above (or is named by `settledSearchId`). Second, and more
        // important: `deriveSearchState` runs on `db`, which would check
        // out a SECOND pooled connection while this transaction holds the
        // lock — under enough concurrent requests for one resume, every
        // connection in the pool ends up blocked on the lock and the holder
        // deadlocks waiting for a connection that will never free. Nothing
        // inside this transaction may touch `db`.
        const racerRows = await tx
          .select({ id: searchesTable.id })
          .from(searchesTable)
          .where(
            settledSearchId === undefined
              ? liveSearchPredicate(resumeId)
              : and(liveSearchPredicate(resumeId), ne(searchesTable.id, settledSearchId)),
          )
          .orderBy(desc(searchesTable.searchedAt))
          .limit(1);
        const racerId = racerRows[0]?.id;
        if (racerId !== undefined) return racerId;

        await tx
          .insert(searchesTable)
          .values({ id: searchId, resumeId, searchedAt: new Date(), status: "running" });
        await tx.insert(searchSources).values(
          resolved.sources.map((source) => {
            const base = { id: randomUUID(), searchId, sourceDescriptorId: source.dataSource };
            // Ticket 447e210: a cache hit is written COMPLETE in this same
            // insert — never `pending` first and flipped later — so no poll
            // of GET /searches/:id, however soon after this 202, can ever
            // observe it any other way. `linkedJobCount: 0` mirrors EXACTLY
            // what fetchSourceWorker's own success-path ledger write sets
            // (see that file's "SUCCESS-PATH LEDGER WRITE" comment) for a
            // live fetch that happened to link zero jobs — this is that same
            // terminal state, reached without a live fetch. `publishedJobCount`
            // is deliberately left NULL rather than set to 0: a real
            // zero-linked fetch runs `adjudicateScoringBudget` and stamps it
            // 0 explicitly, but the scoring-cap arithmetic (fetchSourceWorker
            // module doc comment, "THE PER-SEARCH SCORING CAP") reads a NULL
            // claim as 0 too, so the two are behaviorally identical and there
            // is nothing here for a sibling source to be misled by.
            return cachedZeroSourceIds.has(source.dataSource)
              ? { ...base, status: "complete" as const, linkedJobCount: 0 }
              : { ...base, status: "pending" as const };
          }),
        );
        return undefined;
      });

      if (conflictingSearchId !== undefined) {
        // Same shape and same status code as the pre-check's 409 — a
        // caller can never tell (and has no reason to care) which of the
        // two layers refused it.
        return reply.code(409).send({
          error: `A search is already running for this resume.`,
          searchId: conflictingSearchId,
        });
      }

      // Ticket 447e210: no `fetch.source` message at all for a cached-zero
      // source — its `search_sources` row is already terminal (written
      // above), so publishing one would just relitigate a question this
      // process already has the answer to.
      const sourcesToFetch = resolved.sources.filter(
        (source) => !cachedZeroSourceIds.has(source.dataSource),
      );

      const fetchCriteria = buildFetchCriteria(criteria);
      const messages: FetchSourceMessage[] = sourcesToFetch.map((source) => ({
        searchId,
        sourceId: source.dataSource,
        criteria: fetchCriteria,
        // Ticket 45ea34c: the caller's FULL criteria ride alongside the
        // narrowed fetch-level hint above, so `fetchSourceWorker` can apply
        // `compileFilter(criteria)` — the identical filter the estimate
        // route applies two handlers up — before ingesting or scoring
        // anything. `?? null` is load-bearing and not a style choice:
        // `JSON.stringify` drops an `undefined`-valued key, so sending
        // `criteria` bare would make "the caller supplied no criteria"
        // (which must mean the CLI default filter, exactly as it does for
        // the estimate) indistinguishable on the wire from a pre-45ea34c
        // publisher that knows nothing about the field. See
        // `FetchSourceMessage.filterCriteria` for the full three-way
        // mapping.
        filterCriteria: criteria ?? null,
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

      // Compares against `resolved.sources.length`, NOT `messages.length`
      // (opus review round 1, ticket 447e210, F1): once the zero-result
      // cache can serve some sources without publishing a message for
      // them at all, `messages` no longer covers every source in this
      // search, so `failures.length === messages.length` stops meaning
      // "every source failed" the moment even one source is cache-served.
      // Reproduced: a 2-source search where source A is cache-served and
      // source B's publish genuinely fails — the old check saw
      // `failures.length === messages.length` (1 === 1) and 502'd the
      // whole search as a total outage, even though A had already
      // terminated `complete`/0 correctly. `resolved.sources.length` is
      // the right denominator in every case: it equals `messages.length`
      // exactly when nothing was cache-served (today's existing,
      // unchanged behavior), and is always >= it otherwise, so a genuine
      // total outage (nothing published, nothing cached, every source
      // failed) still 502s while a partial cache-hit no longer can.
      if (resolved.sources.length > 0 && failures.length === resolved.sources.length) {
        await markSearchFailed(searchId);
        return reply.code(502).send({
          error:
            `Could not dispatch this search: none of its ${resolved.sources.length} source(s) ` +
            `could be started. Is RabbitMQ running and has setupTopology() been run?`,
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
      // Split the same way as the terminal member (ticket c9c676d): one
      // number must not mean two different things in two members of one
      // union, and a capped job is visible mid-flight — the fetch worker
      // adjudicates the budget as each source lands, not at the end.
      permanentlyFailed: derived.permanentlyFailed,
      cappedForBudget: derived.cappedForBudget,
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
