/**
 * Reusable personal cleanup tool (ticket 25eac27) -- Nicole: "please make
 * me a small script that deletes resumes that haven't searched yet...
 * that's my way of cleaning up my own personal junk... I might use it
 * again though, so don't keep, like maybe save it and keep it far...
 * deletes every resume in my database that doesn't already have jobs
 * scored associated to it."
 *
 * CRITERION, PRECISELY: a resume is deleted if it has ZERO `job_matches`
 * rows -- not "zero searches". A resume whose search genuinely ran and
 * scored nothing (every job filtered out, or every scoring attempt
 * failed -- `job_match_failures` rows with no corresponding
 * `job_matches`) is deleted by this script exactly like one that was
 * never searched at all. That's Nicole's own final, more precise wording
 * ("doesn't already have jobs scored") -- "scored" is the bar, not
 * "attempted". Unlike ticket 12fd73d's sibling script (a ONE-OFF against
 * a known-safe TAGGED subset of test-fixture rows), this one is meant to
 * be run repeatedly against Nicole's real, legitimate resumes on a plain
 * business rule -- kept in the repo for that reason, not deleted after
 * one use.
 *
 * WHY THE --live PATH RE-DERIVES CANDIDATES INSIDE ITS OWN TRANSACTION,
 * RATHER THAN REUSING A DRY-RUN'S EARLIER READ (the sibling script's
 * simpler shape): that script's tagged rows are inert -- nothing in
 * normal app usage ever writes a NEW `job_matches` row for a resume
 * text-tagged as a test fixture. This script's candidates are real
 * resumes Nicole's own app usage could plausibly be touching AT THE SAME
 * TIME she runs this (a search she started in another tab still
 * scoring). Trusting a "found 3 unsearched resumes" read from moments
 * (or a `--live` re-run) earlier risks deleting a resume a job just got
 * scored against, in the gap. Re-deriving fresh, inside the SAME
 * transaction that then deletes, closes that gap down to the width of
 * one DB round-trip instead of "however long it takes a human to read
 * dry-run output and decide to re-run with --live" -- not a perfect
 * guarantee against a write landing in that exact instant (that would
 * need `SELECT ... FOR UPDATE` or `SERIALIZABLE` isolation, real
 * machinery this "small script" doesn't warrant), but a real, cheap
 * reduction of the actual risk. Documented here as a known, accepted
 * residual rather than silently assumed away.
 *
 * SAFETY GATE, same shape as ticket 12fd73d's sibling script:
 *
 *   - DRY RUN is the default. No flags prints exactly which resumes have
 *     no scored jobs and how many dependent rows exist, then stops --
 *     nothing is written. This read is separate from -- and, per the
 *     paragraph above, NOT reused by -- the `--live` path's own fresh
 *     read.
 *   - `--live` is required to actually delete. Any OTHER argument is a
 *     hard error.
 *   - Prints the resolved POSTGRES_HOST/PORT/DB/USER (never the
 *     password) and the total-vs-matching resume count before touching
 *     anything, same reasoning as 12fd73d's own F2: a wrong-database
 *     mistake must be visible up front, not indistinguishable from
 *     "already clean".
 *   - Deletes go in strict child-before-parent FK order (see db/
 *     schema.ts): job_match_failures and handoffs and job_matches
 *     (direct `resume_id` FK; job_matches is always empty for these ids
 *     by definition, included anyway for structural symmetry and
 *     defense-in-depth against the exact race the paragraph above
 *     describes), then search_sources and search_results (via the
 *     matched resumes' `searches` rows), then searches, then resumes
 *     itself. `user_job_statuses.resume_id` is set to NULL, never
 *     deleted -- same reasoning as ticket 12fd73d's own required fix:
 *     schema.ts documents that column as existing precisely so a real
 *     "I applied to this job" fact survives an unidentifiable resume.
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database -- this
 * never runs in CI or in the sandbox this ticket was implemented in,
 * which has no access to your real data):
 *
 *   npx tsx apps/api/src/scripts/cleanup-unsearched-resumes.ts          # DRY RUN
 *   npx tsx apps/api/src/scripts/cleanup-unsearched-resumes.ts --live   # actually deletes
 */
import { pathToFileURL } from "node:url";
import { eq, inArray, isNull } from "drizzle-orm";
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

export async function countTotalResumes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<number> {
  const rows = await db.select({ id: resumes.id }).from(resumes);
  return rows.length;
}

/** Dependent-row counts for the DRY-RUN report only -- see the module doc
 * comment for why the `--live` path recomputes this itself, inline,
 * inside its own transaction, rather than sharing this function. */
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
    const candidates = await findResumesWithNoScoredJobs(db);
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
    // Re-derived FRESH, inside this transaction, immediately before
    // deleting -- see the module doc comment for why this does NOT reuse
    // a dry run's earlier read.
    const candidates = await tx
      .select({
        id: resumes.id,
        resumeNickname: resumes.resumeNickname,
        createdAt: resumes.createdAt,
      })
      .from(resumes)
      .leftJoin(jobMatches, eq(jobMatches.resumeId, resumes.id))
      .where(isNull(jobMatches.id));

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

    // Counted BEFORE deleting -- these are the real numbers reported as
    // "deleted", computed inside the same transaction as the deletes
    // themselves so nothing can change between counting and deleting.
    const counts = await countDependents(tx, resumeIds);

    await tx.delete(jobMatchFailures).where(inArray(jobMatchFailures.resumeId, resumeIds));
    await tx
      .update(userJobStatuses)
      .set({ resumeId: null })
      .where(inArray(userJobStatuses.resumeId, resumeIds));
    await tx.delete(handoffs).where(inArray(handoffs.resumeId, resumeIds));
    await tx.delete(jobMatches).where(inArray(jobMatches.resumeId, resumeIds));
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
      `\nFound ${candidates.length} of ${totalResumeCount} total resume(s) with no scored jobs:`,
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
