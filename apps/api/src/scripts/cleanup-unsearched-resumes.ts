/**
 * Reusable personal cleanup tool (ticket 25eac27) -- Nicole: "please make
 * me a small script that deletes resumes that haven't searched yet...
 * that's my way of cleaning up my own personal junk... I might use it
 * again though, so don't keep, like maybe save it and keep it far...
 * deletes every resume in my database that doesn't already have jobs
 * scored associated to it."
 *
 * CRITERION, PRECISELY: a resume is a deletion candidate if it has ZERO
 * `job_matches` rows -- not "zero searches". A resume whose search
 * genuinely ran and scored nothing (every job filtered out, or every
 * scoring attempt failed -- `job_match_failures` rows with no
 * corresponding `job_matches`) is a candidate exactly like one that was
 * never searched at all. That's Nicole's own final, more precise wording
 * ("doesn't already have jobs scored") -- "scored" is the bar, not
 * "attempted". Unlike ticket 12fd73d's sibling script (a ONE-OFF against
 * a known-safe TAGGED subset of test-fixture rows), this one is meant to
 * be run repeatedly against Nicole's real, legitimate resumes on a plain
 * business rule -- kept in the repo for that reason, not deleted after
 * one use.
 *
 * EXCLUSION: a resume with a currently LIVE search (opus review, ticket
 * 25eac27, required F2). Searches in this app are asynchronous and can
 * run for minutes -- `POST /searches` (routes/searches.ts) inserts a
 * `searches` row at `status: "running"` well before the first
 * `job_matches` row for it ever lands, and `runDemoMatch` only flips it
 * to `complete` at the very end (matching/pipeline.ts). Without this
 * exclusion, a resume Nicole is actively searching with RIGHT NOW -- zero
 * matches yet purely because scoring hasn't finished -- reads as
 * identical to genuine junk. `LIVE_SEARCH_STALL_MS` and the four-clause
 * condition below are a deliberate COPY of `liveSearchPredicate`
 * (routes/searches.ts) -- not an import, because that module also pulls
 * in the RabbitMQ publisher and the rest of the route's import graph,
 * which a "small script" has no business dragging in just for one
 * predicate. That file's own doc comment warns that two hand-written
 * copies of this predicate can drift silently; the risk here is lower
 * than the case that comment is about (a stale copy here makes this
 * cleanup script over- or under-cautious, not a live correctness hole in
 * the app's own in-flight guard), but if `STALL_AFTER_MS` or
 * `liveSearchPredicate`'s clauses ever change there, update the copy
 * below too.
 *
 * WHY THE --live PATH RE-DERIVES CANDIDATES INSIDE ITS OWN TRANSACTION,
 * AND LOCKS THEM (opus review, ticket 25eac27, required F1 -- see that
 * finding for the full incident: the FIRST version of this script
 * DELETED `job_matches` rows for its candidates as its own first
 * dependent-delete step, on the theory that this was harmless
 * "defense-in-depth" since candidates have zero matches by construction.
 * Proven, empirically, to be the opposite: with no `onDelete: cascade`
 * anywhere in this schema, that delete is what converts a race -- a
 * concurrent search scoring a job against one of these exact resumes,
 * in the gap between deciding what to delete and deleting it -- from a
 * SAFE, LOUD failure (the later `DELETE FROM resumes` would hit a real
 * FK violation and roll the whole transaction back, since the fresh
 * match would still be there) into SILENT, PERMANENT data loss (the
 * match gets deleted right alongside the resume it just proved wasn't
 * junk after all). Ticket 12fd73d's sibling script gets away with the
 * simpler "read once, then delete" shape because its tagged rows are
 * inert test fixtures nothing in real app usage ever writes a NEW
 * `job_matches` row against. This script's candidates are Nicole's real
 * resumes, which her own concurrent app usage genuinely can be scoring
 * against at the moment she runs this.
 *
 * The actual fix, in order, all inside ONE transaction:
 *   1. Find "zero job_matches" candidates (as ticket 12fd73d's sibling
 *      script does), then exclude any with a live search (see above).
 *   2. `SELECT ... FOR UPDATE` on exactly those candidate `resumes` rows.
 *      Postgres requires a `FOR KEY SHARE` lock on a referenced parent
 *      row before a child `INSERT` can commit against it (this is how it
 *      enforces referential integrity concurrently) -- `FOR UPDATE`
 *      conflicts with `FOR KEY SHARE`, so from the instant this
 *      statement returns, no OTHER transaction can insert a new
 *      `job_matches` OR `searches` row against any of these specific
 *      resumes until THIS transaction commits or rolls back (both
 *      `job_matches.resume_id` and `searches.resume_id` are FKs to
 *      `resumes.id`, so both kinds of insert need the same FOR KEY SHARE
 *      this blocks). Verified directly: a concurrent session's INSERT
 *      against a locked candidate blocks and only proceeds after this
 *      transaction ends.
 *   3. RE-CHECK **both** exclusion conditions for exactly those now-
 *      locked ids -- `job_matches` AND live-search (opus review round 2,
 *      required F3: the FIRST version of this fix only re-checked
 *      `job_matches`, leaving the live-search exclusion itself racy in
 *      the SAME way F1 was -- a `POST /searches` insert that hadn't
 *      committed yet when step 1's unlocked read ran left a resume
 *      looking like plain junk, and this transaction's own `FOR UPDATE`
 *      then blocked on that poster's FOR KEY SHARE and proceeded the
 *      instant it committed, acting on stale, pre-commit information).
 *      This closes the gap step 2 alone does not: something could have
 *      landed in the window BEFORE the lock was acquired (step 1 is a
 *      plain, unlocked read). Anything that shows up in either re-check
 *      is dropped from the deletion set -- proof, not assumption, that
 *      it's still genuinely safe to delete.
 *   4. Delete. `job_matches` is deliberately NOT one of the dependent
 *      deletes anymore (it was the original bug) -- every surviving
 *      candidate is now PROVEN to have zero matches and no live search,
 *      and the lock held since step 2 guarantees neither can appear
 *      before this transaction commits.
 *
 * SAFETY GATE, same shape as ticket 12fd73d's sibling script otherwise:
 *
 *   - DRY RUN is the default. No flags prints exactly which resumes
 *     qualify and how many dependent rows exist, then stops -- nothing
 *     is written, and nothing is locked (a lock only matters immediately
 *     before a delete).
 *   - `--live` is required to actually delete. Any OTHER argument is a
 *     hard error.
 *   - Prints the resolved POSTGRES_HOST/PORT/DB/USER (never the
 *     password) and the total-vs-matching resume count before touching
 *     anything, same reasoning as 12fd73d's own F2: a wrong-database
 *     mistake must be visible up front, not indistinguishable from
 *     "already clean".
 *   - Deletes go in strict child-before-parent FK order (see db/
 *     schema.ts): job_match_failures and handoffs (direct `resume_id`
 *     FK), then search_sources and search_results (via the matched
 *     resumes' `searches` rows), then searches, then resumes itself.
 *     `user_job_statuses.resume_id` is set to NULL, never deleted --
 *     same reasoning as ticket 12fd73d's own required fix: schema.ts
 *     documents that column as existing precisely so a real "I applied
 *     to this job" fact survives an unidentifiable resume.
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database -- this
 * never runs in CI or in the sandbox this ticket was implemented in,
 * which has no access to your real data):
 *
 *   npx tsx apps/api/src/scripts/cleanup-unsearched-resumes.ts          # DRY RUN
 *   npx tsx apps/api/src/scripts/cleanup-unsearched-resumes.ts --live   # actually deletes
 */
import { pathToFileURL } from "node:url";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  handoffs,
  jobMatches,
  jobMatchFailures,
  resumes,
  searches,
  searchResults,
  searchSources,
  userJobStatuses,
} from "../db/schema.js";
import { loadEnvFile } from "../load-env.js";

loadEnvFile();

/** Must match `STALL_AFTER_MS` in `../routes/searches.ts` exactly -- see
 * the module doc comment above for why this is a deliberate copy, not an
 * import. */
const LIVE_SEARCH_STALL_MS = 45 * 60 * 1000;

export type ParsedArgs = { live: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
  const unknown = argv.filter((a) => a !== "--live");
  if (unknown.length > 0) {
    throw new Error(
      `Unrecognized argument(s): ${unknown.join(", ")}. Known flags are --live (actually deletes; ` +
        "omit for a dry run).",
    );
  }
  return { live: argv.includes("--live") };
}

function connectDb(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
}

export type ResumeSummary = { id: string; resumeNickname: string; createdAt: Date };

/**
 * Every resume with ZERO `job_matches` rows -- a `LEFT JOIN` filtered to
 * `jobMatches.id IS NULL` rather than `notInArray(resumes.id, <subquery>)`:
 * a resume WITH at least one match produces only non-NULL-joined rows (one
 * per match), all excluded by the `WHERE`, so this can never emit a
 * duplicate row for a matched resume and needs no `DISTINCT`/`GROUP BY`.
 *
 * Deliberately does NOT also exclude live searches -- see
 * `findCleanupCandidates` below, which composes this with that exclusion.
 * Kept separate (and separately tested) so "has this resume ever been
 * scored" and "is a search for it live right now" stay two independently
 * verifiable questions.
 */
export async function findResumesWithNoScoredJobs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<ResumeSummary[]> {
  return db
    .select({
      id: resumes.id,
      resumeNickname: resumes.resumeNickname,
      createdAt: resumes.createdAt,
    })
    .from(resumes)
    .leftJoin(jobMatches, eq(jobMatches.resumeId, resumes.id))
    .where(isNull(jobMatches.id));
}

/**
 * Which of `resumeIds` have a currently LIVE search -- a deliberate copy
 * of `liveSearchPredicate` (routes/searches.ts), widened from one
 * resumeId to a batch via `inArray`. See the module doc comment for why
 * this is a copy, not an import, and what each of the four clauses
 * guards against.
 */
export async function findResumeIdsWithLiveSearch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeIds: string[],
): Promise<Set<string>> {
  if (resumeIds.length === 0) return new Set();
  const rows = await db
    .select({ resumeId: searches.resumeId })
    .from(searches)
    .where(
      and(
        inArray(searches.resumeId, resumeIds),
        eq(searches.status, "running"),
        isNull(searches.completedAt),
        gt(searches.searchedAt, new Date(Date.now() - LIVE_SEARCH_STALL_MS)),
      ),
    );
  return new Set(rows.map((r) => r.resumeId));
}

/**
 * The actual cleanup-candidate set: zero `job_matches`, AND no live
 * search. Used identically for the dry-run report and as the LIVE path's
 * first, unlocked read (which the transaction then re-verifies under a
 * lock -- see the module doc comment's numbered steps 2-3).
 */
export async function findCleanupCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<ResumeSummary[]> {
  const unscored = await findResumesWithNoScoredJobs(db);
  const liveSearchIds = await findResumeIdsWithLiveSearch(
    db,
    unscored.map((r) => r.id),
  );
  return unscored.filter((r) => !liveSearchIds.has(r.id));
}

export async function countTotalResumes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<number> {
  const rows = await db.select({ id: resumes.id }).from(resumes);
  return rows.length;
}

/** Dependent-row counts for reporting. `job_matches` is always 0 for a
 * genuine candidate (that's the whole selection criterion) -- kept in
 * the returned shape anyway so the printed report has a place to show
 * "0" explicitly rather than silently omitting the row, and so a caller
 * inspecting the object doesn't have to special-case a missing key. */
export async function countDependents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeIds: string[],
): Promise<Record<string, number>> {
  if (resumeIds.length === 0) {
    return {
      job_match_failures: 0,
      user_job_statuses: 0,
      handoffs: 0,
      job_matches: 0,
      search_sources: 0,
      search_results: 0,
      searches: 0,
    };
  }
  const searchIdRows = await db
    .select({ id: searches.id })
    .from(searches)
    .where(inArray(searches.resumeId, resumeIds));
  const searchIds = searchIdRows.map((r) => r.id);

  // Sequential, not Promise.all: `db` here is backed by a single
  // `pg.Client` (see `connectDb()`/`main()` below), not a `Pool` --
  // concurrent queries on one client are not real concurrency
  // (node-postgres just queues them), and pg's own deprecation warning
  // says that queueing is going away in pg@9.
  const failures = await db
    .select()
    .from(jobMatchFailures)
    .where(inArray(jobMatchFailures.resumeId, resumeIds));
  const statuses = await db
    .select()
    .from(userJobStatuses)
    .where(inArray(userJobStatuses.resumeId, resumeIds));
  const offs = await db.select().from(handoffs).where(inArray(handoffs.resumeId, resumeIds));
  const matches = await db.select().from(jobMatches).where(inArray(jobMatches.resumeId, resumeIds));
  const sources =
    searchIds.length > 0
      ? await db.select().from(searchSources).where(inArray(searchSources.searchId, searchIds))
      : [];
  const results =
    searchIds.length > 0
      ? await db.select().from(searchResults).where(inArray(searchResults.searchId, searchIds))
      : [];

  return {
    job_match_failures: failures.length,
    user_job_statuses: statuses.length,
    handoffs: offs.length,
    job_matches: matches.length,
    search_sources: sources.length,
    search_results: results.length,
    searches: searchIds.length,
  };
}

export type CleanupResult = {
  candidates: ResumeSummary[];
  totalResumeCount: number;
  counts: Record<string, number>;
  deleted: boolean;
};

/**
 * The whole find/count/conditionally-delete decision, as one directly
 * testable function -- same "`live: false` is the entire safety
 * guarantee, so it needs its own direct test" reasoning as ticket
 * 12fd73d's sibling script.
 */
export async function runCleanup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  opts: { live: boolean },
): Promise<CleanupResult> {
  if (!opts.live) {
    const candidates = await findCleanupCandidates(db);
    const totalResumeCount = await countTotalResumes(db);
    const counts = await countDependents(
      db,
      candidates.map((r) => r.id),
    );
    return { candidates, totalResumeCount, counts, deleted: false };
  }

  // Purely informational for the printed report -- not used to decide
  // WHAT gets deleted (see below).
  const totalResumeCount = await countTotalResumes(db);

  return db.transaction(async (tx) => {
    // Step 1 (module doc comment): unlocked read, same query the dry run
    // uses.
    const firstPass = await findCleanupCandidates(tx);
    if (firstPass.length === 0) {
      return {
        candidates: [],
        totalResumeCount,
        counts: await countDependents(tx, []),
        deleted: false,
      };
    }
    const firstPassIds = firstPass.map((r) => r.id);

    // Step 2: lock exactly these resumes. From here on, no OTHER
    // transaction can insert a `job_matches` OR `searches` row against
    // any of them until this transaction ends (see module doc comment
    // for the FOR-KEY-SHARE-vs-FOR-UPDATE mechanism this relies on).
    await tx
      .select({ id: resumes.id })
      .from(resumes)
      .where(inArray(resumes.id, firstPassIds))
      .for("update");

    // Step 3: re-check BOTH exclusion conditions, now that the lock is
    // held, closing the gap step 2 alone doesn't -- something landing in
    // the window BEFORE the lock was acquired. Anything that shows up
    // here is proof this candidate is no longer genuinely safe to
    // delete; it's dropped.
    //
    // Opus review round 2 (required F3): the FIRST version of this fix
    // re-checked job_matches only, leaving the live-search exclusion
    // itself racy in exactly the class of bug F1 was -- proven with a
    // real second connection: `POST /searches` inserts its `searches`
    // row (taking a FOR KEY SHARE lock on the resume) in a transaction
    // that hasn't committed yet when step 1's unlocked read runs, so the
    // resume looks like plain junk (no live search, no matches) at that
    // moment. This transaction's `FOR UPDATE` then BLOCKS on the
    // poster's FOR KEY SHARE (making the race MORE reliably hit, not
    // less) and proceeds the instant the poster commits -- acting on
    // now-stale, pre-commit information unless the live-search check is
    // ALSO re-run here, under the same lock that makes job_matches's
    // re-check trustworthy.
    const stillUnscored = await tx
      .select({ resumeId: jobMatches.resumeId })
      .from(jobMatches)
      .where(inArray(jobMatches.resumeId, firstPassIds));
    const nowScored = new Set(stillUnscored.map((r) => r.resumeId));
    const nowLiveSearch = await findResumeIdsWithLiveSearch(tx, firstPassIds);
    const candidates = firstPass.filter((r) => !nowScored.has(r.id) && !nowLiveSearch.has(r.id));

    if (candidates.length === 0) {
      return {
        candidates: [],
        totalResumeCount,
        counts: await countDependents(tx, []),
        deleted: false,
      };
    }

    const resumeIds = candidates.map((r) => r.id);
    const searchIdRows = await tx
      .select({ id: searches.id })
      .from(searches)
      .where(inArray(searches.resumeId, resumeIds));
    const searchIds = searchIdRows.map((r) => r.id);

    // Counted here, not before the lock+recheck above -- these are the
    // real numbers about to be deleted, for the confirmed-safe set only.
    const counts = await countDependents(tx, resumeIds);

    // Step 4: delete. job_matches is deliberately NOT here -- see the
    // module doc comment's incident history for exactly why that used to
    // be a bug, not defense-in-depth.
    await tx.delete(jobMatchFailures).where(inArray(jobMatchFailures.resumeId, resumeIds));
    await tx
      .update(userJobStatuses)
      .set({ resumeId: null })
      .where(inArray(userJobStatuses.resumeId, resumeIds));
    await tx.delete(handoffs).where(inArray(handoffs.resumeId, resumeIds));
    if (searchIds.length > 0) {
      // Defense against job_match_failures.resume_id/search_id ever
      // skewing (documented as denormalized, not enforced by a CHECK
      // constraint) -- same reasoning as ticket 12fd73d's own required F4.
      await tx.delete(jobMatchFailures).where(inArray(jobMatchFailures.searchId, searchIds));
      await tx.delete(searchSources).where(inArray(searchSources.searchId, searchIds));
      await tx.delete(searchResults).where(inArray(searchResults.searchId, searchIds));
    }
    await tx.delete(searches).where(inArray(searches.resumeId, resumeIds));
    await tx.delete(resumes).where(inArray(resumes.id, resumeIds));

    return { candidates, totalResumeCount, counts, deleted: true };
  });
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { live } = parsed;

  console.log(
    `cleanup-unsearched-resumes: ${
      live ? "LIVE RUN -- this WILL delete rows" : "DRY RUN -- nothing will be deleted"
    }`,
  );
  // Printed BEFORE any query, same reasoning as ticket 12fd73d's own
  // required F2: a wrong-database mistake (most likely a missing .env
  // falling through to whatever's already in the shell's environment --
  // load-env.ts swallows ENOENT by design) must be visible up front, not
  // indistinguishable from "already clean".
  console.log(
    `Connecting to postgres://${process.env.POSTGRES_USER ?? "(unset)"}@` +
      `${process.env.POSTGRES_HOST ?? "(unset)"}:${process.env.POSTGRES_PORT ?? "(unset)"}/` +
      `${process.env.POSTGRES_DB ?? "(unset)"}`,
  );

  const client = connectDb();
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `Failed to connect to the database: ${err instanceof Error ? err.message : String(err)} -- ` +
        "check POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB in your .env " +
        "and that Postgres is actually running.",
    );
    process.exitCode = 1;
    return;
  }
  const db = drizzle(client);

  try {
    const result = await runCleanup(db, { live });
    const { candidates, totalResumeCount, counts } = result;

    console.log(
      `\nFound ${candidates.length} of ${totalResumeCount} total resume(s) with no scored jobs ` +
        "(and no currently-live search):",
    );
    for (const r of candidates) {
      console.log(`  ${r.id}  "${r.resumeNickname}"  created ${r.createdAt.toISOString()}`);
    }
    if (candidates.length > 0) {
      // Migration 0010 backfilled every pre-existing row's created_at to
      // the single instant THAT migration ran (schema.ts's
      // resumes.createdAt doc comment) -- an old, never-migrated-forward
      // row could show a recent-looking date here.
      console.log(
        "  (created dates above may be migration 0010's one-time backfill instant, not each " +
          "row's real original creation time -- see schema.ts's resumes.createdAt doc comment)",
      );
    }

    if (candidates.length === 0) {
      console.log("\nNothing to clean up.");
      return;
    }

    console.log(`\nDependent rows ${live ? "deleted" : "that would also be deleted"}:`);
    for (const [table, count] of Object.entries(counts)) {
      if (table === "user_job_statuses") continue;
      console.log(`  ${table}: ${count}`);
    }
    console.log(
      `  (plus ${counts.user_job_statuses} user_job_statuses row(s) KEPT -- only their resume_id ` +
        'is set to NULL, so any real "I applied" fact survives)',
    );

    if (!live) {
      console.log(
        "\nDry run: stopping here. Nothing was deleted. Re-run with --live to actually delete.",
      );
      return;
    }

    console.log(
      `\nDeleted ${candidates.length} resume(s) with no scored jobs and all their dependent rows.`,
    );
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
