import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobs, searchResults } from "../db/schema.js";
import type { NormalizedJob } from "../sources/types.js";

export type IngestResult = {
  /**
   * Every job now linked to this search - both jobs inserted by this call
   * and jobs that already existed from a previous search/source and are
   * simply being (re-)linked here.
   */
  linkedJobIds: string[];
  /**
   * The subset of `linkedJobIds` that did NOT exist before this call. This
   * is what a caller should publish `score.job` for - a job already in the
   * database was already scored by whichever search ingested it first, and
   * re-publishing would pay for a duplicate LLM call (ticket 6bf2196).
   */
  newlyInsertedJobIds: string[];
};

/**
 * Idempotently persists a source's search results and links them to the
 * search that produced them.
 *
 * Idempotency has two independent layers, because a redelivered
 * `fetch.source` message re-runs this whole function from scratch:
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
 */
export async function ingestJobsForSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  searchId: string,
  dataSource: string,
  normalizedJobs: NormalizedJob[],
): Promise<IngestResult> {
  if (normalizedJobs.length === 0) {
    return { linkedJobIds: [], newlyInsertedJobIds: [] };
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

  const toInsert = uniqueJobs.map((job) => ({ ...job, id: randomUUID() }));

  const inserted = await db
    .insert(jobs)
    .values(toInsert)
    .onConflictDoNothing({ target: [jobs.dataSource, jobs.externalId] })
    .returning({ id: jobs.id, externalId: jobs.externalId });

  const insertedExternalIds = new Set(inserted.map((row) => row.externalId));

  // Look up authoritative ids for the whole batch, including rows that
  // already existed (and so were silently skipped above) - pre-existing
  // jobs still need to be linked to this search.
  const rows = await db
    .select({ id: jobs.id, externalId: jobs.externalId })
    .from(jobs)
    .where(and(eq(jobs.dataSource, dataSource), inArray(jobs.externalId, allExternalIds)));

  const idByExternalId = new Map(rows.map((row) => [row.externalId, row.id]));

  const linkedJobIds: string[] = [];
  const newlyInsertedJobIds: string[] = [];
  for (const externalId of allExternalIds) {
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
      // a success. Throwing turns it back into a visible failure.
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

  if (linkedJobIds.length > 0) {
    await db
      .insert(searchResults)
      .values(linkedJobIds.map((jobId) => ({ id: randomUUID(), searchId, jobId })))
      .onConflictDoNothing({ target: [searchResults.searchId, searchResults.jobId] });
  }

  return { linkedJobIds, newlyInsertedJobIds };
}
