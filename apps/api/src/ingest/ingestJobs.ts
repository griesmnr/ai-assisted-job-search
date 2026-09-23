import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobs, searchResults } from "../db/schema.js";
import type { NormalizedJob } from "../sources/types.js";
import { findCrossSourceDuplicates } from "./crossSourceDuplicates.js";

/**
 * How many `jobs` rows go into one INSERT statement.
 *
 * `jobs` has 12 columns, so an unchunked insert of N rows binds 12*N
 * parameters — Postgres's wire protocol caps a single statement at 65,535
 * bound parameters, so the real per-statement ceiling is 65,535 / 12 ≈
 * 5,461 rows. Reachable in practice, not theoretical: SmartRecruiters has
 * already returned 4,771 postings for a single company (ticket 3067e2c) —
 * close enough to the ceiling that source growth trips it, and past it the
 * whole `fetch.source` message failed outright with a raw Postgres error.
 * 500 rows (6,000 parameters) is far inside the limit with room for the row
 * shape to grow, matching the chunk size ticket 4f88339 chose for
 * `job_match_failures`.
 */
const JOBS_INSERT_CHUNK = 500;

/**
 * How many `search_results` rows go into one INSERT statement.
 *
 * `search_results` only has 3 columns (65,535 / 3 ≈ 21,845 rows before
 * hitting the same bound-parameter limit as `jobs` above), so this insert
 * can't hit the ceiling at today's realistic source sizes. Chunked anyway,
 * at the same 500-row size, so this insert doesn't quietly become the next
 * ticket-3067e2c the day either the row shape grows or a source's result
 * count does.
 */
const SEARCH_RESULTS_INSERT_CHUNK = 500;

/**
 * One cross-source merge that ACTUALLY HAPPENED in this call (ticket
 * 78d31b7, review F2b) — not a candidate considered, one applied.
 *
 * Exists because a merge is, by this feature's own design, silent and
 * permanent: nothing in the UI says "we collapsed two postings", so a WRONG
 * merge hides a real opening from the user with no trace. `textSimilarity.
 * ts` is explicit that the check can be fooled by a heavily-templated
 * employer (see its threshold doc comment, which measures a realistic pair
 * that does merge at 0.65). The minimum acceptable answer to "this is
 * silent and permanent" is that it is at least OBSERVABLE, so both callers
 * log every one of these. Whether the log is enough, or whether the UI
 * should eventually surface "also posted on X", is a product decision this
 * ticket deliberately leaves out of scope.
 */
export type CrossSourceMerge = {
  /** The source being ingested under — the posting that was NOT inserted. */
  incomingDataSource: string;
  /** That posting's id within `incomingDataSource`. It has no `jobs.id`,
   * because no row was created for it; this plus `incomingDataSource` is the
   * only handle on the posting that was dropped. */
  incomingExternalId: string;
  /** The pre-existing `jobs.id` it was merged into. */
  existingJobId: string;
  /** Which source had contributed that row. */
  existingDataSource: string;
  /** Company and title as the INCOMING posting stated them. Gate 1 is an
   * exact match after normalization, so the existing row's differ at most in
   * case and whitespace. */
  company: string;
  title: string;
  /** The measured description similarity that cleared the threshold — the
   * single number that says how confident the merge was. */
  similarity: number;
};

/** A one-line, greppable rendering of a merge, so both callers report it
 * identically. Names both sides and the score, per review F2b. */
export function describeCrossSourceMerge(merge: CrossSourceMerge): string {
  return (
    `cross-source duplicate merged: "${merge.title}" at "${merge.company}" from ` +
    `${merge.incomingDataSource}:${merge.incomingExternalId} was NOT inserted — it matched ` +
    `existing job ${merge.existingJobId} (${merge.existingDataSource}) with ` +
    `similarity=${merge.similarity.toFixed(3)}. Only the existing row is linked and scored.`
  );
}

export type IngestResult = {
  /**
   * Every job now linked to this search - jobs inserted by this call, jobs
   * that already existed from a previous search/source and are simply being
   * (re-)linked here, and (ticket 78d31b7) jobs another source already
   * contributed that a posting in this batch was found to be a duplicate
   * of. Distinct: no id appears twice, including across those three cases.
   *
   * In batch order, matching `normalizedJobs` after per-externalId
   * deduplication - `fetchSourceWorker`'s deterministic scoring-budget
   * slice depends on that.
   */
  linkedJobIds: string[];
  /**
   * The subset of `linkedJobIds` that did NOT exist before this call. This
   * is what a caller should publish `score.job` for - a job already in the
   * database was already scored by whichever search ingested it first, and
   * re-publishing would pay for a duplicate LLM call (ticket 6bf2196).
   */
  newlyInsertedJobIds: string[];
  /**
   * Every cross-source merge this call applied, in batch order (ticket
   * 78d31b7, review F2b). Empty in the overwhelmingly common case — a live
   * check on 2026-09-23 found zero cross-source collisions across 2,304
   * jobs. Callers are expected to LOG these; see `CrossSourceMerge`.
   */
  crossSourceMerges: CrossSourceMerge[];
};

/**
 * Idempotently persists a source's search results and links them to the
 * search that produced them.
 *
 * Idempotency has two independent layers, because a redelivered
 * `fetch.source` message re-runs this whole function from scratch:
 *
 * 0. CROSS-SOURCE DUPLICATES (ticket 78d31b7) - an earlier, additional
 *    check layered IN FRONT of layer 1, not a replacement for it. Before
 *    inserting anything, `findCrossSourceDuplicates` asks whether some
 *    posting in this batch is the same real job as a row another source
 *    already contributed (same company + title + location exactly, plus a
 *    local description-similarity check - see crossSourceDuplicates.ts for
 *    the two-gate design and why the first gate is exact rather than
 *    fuzzy). A posting that matches is NOT inserted: it resolves to the
 *    EXISTING row's id and flows through the rest of this function exactly
 *    as an already-present posting does - one `jobs` row instead of two,
 *    one `search_results` link instead of two, one row in the ranked
 *    results instead of two, and out of `newlyInsertedJobIds`. Layer 1
 *    below is untouched and still does all the work for the same-source
 *    case.
 *
 *    WHAT THAT DOES AND DOESN'T GUARANTEE ABOUT SCORING, stated precisely
 *    because the two callers differ. `runDemoMatch` (matching/pipeline.ts)
 *    scores over the linked ids, so a merged posting costs exactly one
 *    Claude call instead of two - the saving is direct there. The queue
 *    path deliberately publishes `score.job` over `linkedJobIds`, NOT
 *    `newlyInsertedJobIds` (see fetchSourceWorker.ts's own doc comment on
 *    why: using the latter silently drops jobs when an attempt is
 *    retried), so a merged posting does still get a `score.job` message
 *    from the second source. It is deduped one layer down, by
 *    `scoreJobWorker`'s already-scored check against `job_matches` - the
 *    same at-least-once-plus-idempotent-consumer arrangement every other
 *    re-linked job already relies on. What this layer removes in that path
 *    is the duplicate ROW and the duplicate RESULT, not the duplicate
 *    message.
 *
 * 1. `jobs` - upsert via `ON CONFLICT (data_source, external_id) DO
 *    NOTHING`, keyed on the unique constraint already on the table. Two
 *    calls that both contain the same posting produce exactly one row.
 *    `RETURNING` on an `ON CONFLICT DO NOTHING` insert reports only the
 *    rows Postgres actually inserted (conflicting rows return nothing), so
 *    that set doubles as "the newly ingested jobs" with no extra query.
 * 2. `search_results` - upsert via `ON CONFLICT (search_id, job_id) DO
 *    NOTHING`, keyed on the unique constraint added alongside this worker
 *    (migration 0001). Re-linking the same (search, job) pair on a
 *    redelivery is a no-op instead of a duplicate row.
 *
 * Every job in `normalizedJobs` - new or pre-existing - gets linked to
 * `searchId`; only the newly-inserted ones are reported back for scoring.
 *
 * The whole thing runs inside one `db.transaction()`. Without it, the
 * defensive throw a few lines down (an invariant violation that "should be
 * impossible") would still leave behind whatever the earlier `insert(jobs)`
 * in this same call had already committed - a real row in the database
 * with nothing linking it to any search, created by a call the caller
 * (correctly) treated as having failed. A transaction makes the whole
 * function atomic: either every job in this batch ends up inserted *and*
 * linked, or none of it is committed at all.
 */
export async function ingestJobsForSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  searchId: string,
  dataSource: string,
  normalizedJobs: NormalizedJob[],
): Promise<IngestResult> {
  if (normalizedJobs.length === 0) {
    return { linkedJobIds: [], newlyInsertedJobIds: [], crossSourceMerges: [] };
  }

  // Dedupe by externalId within this one batch. A single search response
  // should never contain the same posting twice, but a single INSERT
  // statement with two rows sharing a conflict target behaves oddly in
  // Postgres (ON CONFLICT can't handle a row conflicting with another row
  // in the same statement), so guard against a pathological adapter
  // response rather than let that surface as a confusing DB error.
  const byExternalId = new Map<string, NormalizedJob>();
  for (const job of normalizedJobs) {
    byExternalId.set(job.externalId, job);
  }
  const uniqueJobs = [...byExternalId.values()];
  const allExternalIds = uniqueJobs.map((job) => job.externalId);

  return db.transaction(async (tx) => {
    // Layer 0 (ticket 78d31b7). Runs first and inside this same
    // transaction, so it sees every row committed before this call and
    // nothing half-written by it. Postings it matches are dropped from the
    // insert set entirely and resolved to the existing row below.
    const crossSourceMatches = await findCrossSourceDuplicates(tx, dataSource, uniqueJobs);

    const toInsert = uniqueJobs
      .filter((job) => !crossSourceMatches.has(job.externalId))
      .map((job) => ({ ...job, id: randomUUID() }));

    const inserted: { id: string; externalId: string }[] = [];
    for (let i = 0; i < toInsert.length; i += JOBS_INSERT_CHUNK) {
      const chunk = toInsert.slice(i, i + JOBS_INSERT_CHUNK);
      const insertedChunk = await tx
        .insert(jobs)
        .values(chunk)
        .onConflictDoNothing({ target: [jobs.dataSource, jobs.externalId] })
        .returning({ id: jobs.id, externalId: jobs.externalId });
      inserted.push(...insertedChunk);
    }

    const insertedExternalIds = new Set(inserted.map((row) => row.externalId));

    // Look up authoritative ids for the whole batch, including rows that
    // already existed (and so were silently skipped above) - pre-existing
    // jobs still need to be linked to this search.
    //
    // Deliberately NOT chunked like the insert above: this is one statement
    // binding allExternalIds.length + 1 params (the +1 is `dataSource`), so
    // its own ceiling is 65,535 - 1 = 65,534 externalIds per call - about
    // 13x SmartRecruiters' largest observed response (4,771, ticket 3067e2c)
    // and well past JOBS_INSERT_CHUNK's 500-row insert chunks ever
    // accumulating that many distinct ids in one call. Chunking this too is
    // possible but not required to satisfy this ticket's acceptance
    // criteria; if a source ever approaches 65,534 postings in one search,
    // this is the next ceiling to chunk.
    //
    // Scoped to the externalIds actually headed for `jobs` under this
    // dataSource (ticket 78d31b7). AN OPTIMIZATION, NOT A CORRECTNESS
    // REQUIREMENT — an earlier version of this comment claimed the filter
    // was load-bearing ("looking it up here would find nothing and trip the
    // throw below"), and the adversarial review checked: it isn't. The loop
    // below `continue`s on a cross-source match BEFORE it ever consults
    // `idByExternalId`, so a merged externalId is never looked up and can
    // never reach the throw. Removing the filter leaves every targeted test
    // passing. What it buys is real but modest: fewer bound parameters and
    // no wasted index probes for postings we already know have no row under
    // this source. Keep it; just don't mistake it for the thing that makes
    // the merge path correct.
    const externalIdsToResolve = allExternalIds.filter((id) => !crossSourceMatches.has(id));
    const rows =
      externalIdsToResolve.length === 0
        ? []
        : await tx
            .select({ id: jobs.id, externalId: jobs.externalId })
            .from(jobs)
            .where(
              and(eq(jobs.dataSource, dataSource), inArray(jobs.externalId, externalIdsToResolve)),
            );

    const idByExternalId = new Map(rows.map((row) => [row.externalId, row.id]));

    const linkedJobIds: string[] = [];
    const newlyInsertedJobIds: string[] = [];
    const crossSourceMerges: CrossSourceMerge[] = [];
    for (const externalId of allExternalIds) {
      const crossSourceMatch = crossSourceMatches.get(externalId);
      if (crossSourceMatch) {
        // Same real job, already contributed by another source. Link this
        // search to THAT row and report nothing new - the identical
        // treatment an exact (dataSource, externalId) repeat gets, reached
        // by a different match path. Deliberately not added to
        // `newlyInsertedJobIds`: this job is not new, and the CLI scoring
        // path reuses the score already paid for rather than buying a
        // second one (ticket 6bf2196). See the layer-0 section of this
        // function's doc comment for exactly what that does and does not
        // guarantee on the queue path.
        linkedJobIds.push(crossSourceMatch.existingJobId);
        // Reported back so the caller can log it (review F2b). Recorded
        // HERE, at the point the merge is actually applied, rather than
        // from `crossSourceMatches` wholesale — those are findings, these
        // are the ones that changed what got written.
        const merged = byExternalId.get(externalId);
        if (merged) {
          crossSourceMerges.push({
            incomingDataSource: dataSource,
            incomingExternalId: externalId,
            existingJobId: crossSourceMatch.existingJobId,
            existingDataSource: crossSourceMatch.existingDataSource,
            company: merged.company,
            title: merged.title,
            similarity: crossSourceMatch.similarity,
          });
        }
        continue;
      }
      const id = idByExternalId.get(externalId);
      if (!id) {
        // Should be impossible: every externalId in this batch was either
        // just inserted above or already present under `dataSource`. Seeing
        // one missing here almost always means the caller's `dataSource`
        // argument doesn't match the `dataSource` actually stamped on the
        // NormalizedJob objects it's ingesting (e.g. a worker dispatching a
        // message under one sourceId to an adapter registered under a
        // different one) - the select filtered on the wrong data_source and
        // silently found nothing. Silently skipping that job used to be the
        // behavior here; that's exactly what let a sourceId/adapter mismatch
        // insert an orphaned row, link nothing, and still ack the message as
        // a success. Throwing turns it back into a visible failure - and
        // being inside the transaction, also rolls back the insert(s)
        // above instead of leaving an orphan row committed.
        throw new Error(
          `ingestJobsForSearch: no jobs row found for dataSource="${dataSource}" ` +
            `externalId="${externalId}" immediately after upserting it. This should be ` +
            `impossible unless the caller's dataSource doesn't match the dataSource on the ` +
            `NormalizedJob objects being ingested - check the sourceId/adapter dispatch.`,
        );
      }
      linkedJobIds.push(id);
      if (insertedExternalIds.has(externalId)) {
        newlyInsertedJobIds.push(id);
      }
    }

    for (let i = 0; i < linkedJobIds.length; i += SEARCH_RESULTS_INSERT_CHUNK) {
      const chunk = linkedJobIds.slice(i, i + SEARCH_RESULTS_INSERT_CHUNK);
      await tx
        .insert(searchResults)
        .values(chunk.map((jobId) => ({ id: randomUUID(), searchId, jobId })))
        .onConflictDoNothing({ target: [searchResults.searchId, searchResults.jobId] });
    }

    return { linkedJobIds, newlyInsertedJobIds, crossSourceMerges };
  });
}
