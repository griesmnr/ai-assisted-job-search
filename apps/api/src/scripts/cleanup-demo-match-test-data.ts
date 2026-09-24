/**
 * One-off cleanup for pre-ticket-c434a6e test pollution left behind in a
 * REAL dev database (ticket 12fd73d).
 *
 * WHY THIS EXISTS: `demo-match.test.ts` tags every fixture resume it
 * inserts with a fixed prefix (`RESUME_TEXT_PREFIX` in that file,
 * `"ticket-620ca30-demo-match-test:"`) so its own cleanup could one day
 * find them by that tag alone -- see that file's own doc comment. Before
 * ticket c434a6e (git-bug, "isolate database tests, one Postgres per test
 * run"), that test file connected straight to whatever shared Postgres
 * `POSTGRES_HOST` pointed at -- which, for anyone who ran `pnpm test` (or
 * bare `vitest`) inside a dev container wired to their own real
 * `docker-compose` Postgres before that fix landed, IS the same database
 * the real app's `pnpm dev` reads from. c434a6e stopped any NEW pollution
 * (tests now run against a fresh, isolated, per-run database -- see
 * db/test-db.ts), but did nothing to clean up rows a pre-fix run had
 * already written.
 *
 * That pollution was invisible until ticket 303cff0 ("My Resumes" tab)
 * shipped the first UI that lists every saved resume at once -- Nicole,
 * dogfooding it: her real resume list showed rows like
 * "ticket-620ca30-demo-match-test: board-coverage-none
 * ffa49333-a95c-41b2-acf6-18de0f591051" instead of her actual resumes.
 * This script finds and removes exactly those tagged rows, and everything
 * that references them, from HER real database.
 *
 * SCOPE, DELIBERATELY NARROW: only rows tagged by `RESUME_TEXT_PREFIX`
 * below (and rows that reference THOSE resumes' ids) are touched. The
 * fake `jobs` rows those old test runs also created (e.g. "Widget
 * Engineer" / "Gadget Engineer" under `dataSource: "usajobs"`,
 * `externalId` like "demo-match-test-N") are NOT deleted by this script --
 * they are a separate, much lower-risk residue (nothing in the current UI
 * lists "every job ever ingested" the way ticket 303cff0 now lists "every
 * resume ever saved", and a real job search matching one of those exact
 * contrived titles is effectively impossible), so cleaning them up is left
 * for a future ticket if they ever turn out to matter, rather than
 * expanding this one's blast radius for a problem nobody has actually hit.
 *
 * SAFETY GATE, same shape as `rescore-existing-matches.ts` and
 * `validate-level-fit.ts` (ticket d8746eb's established pattern for a
 * script that touches real data):
 *
 *   - DRY RUN is the default. No flags prints exactly which resumes match
 *     the tag and how many dependent rows across every table would be
 *     deleted, then stops -- nothing is written.
 *   - `--live` is required to actually delete. Any OTHER argument is a
 *     hard error, same as those two scripts' own `parseArgs`.
 *   - Every delete runs inside ONE transaction (`db.transaction`), so a
 *     failure partway through (an unexpected FK this script's author
 *     didn't anticipate, a connection drop) leaves the database exactly
 *     as it was, never half-cleaned.
 *   - Deletes go in strict child-before-parent order across every table
 *     that has a `resumeId`/`searchId` FK reachable from `resumes` (see
 *     db/schema.ts): job_match_failures and user_job_statuses and
 *     handoffs and job_matches (direct `resume_id` FK), then
 *     search_sources and search_results (via the matched resumes'
 *     `searches` rows), then searches, then resumes itself.
 *   - Prints the resolved POSTGRES_HOST/PORT/DB/USER (never the password)
 *     AND the total resume count alongside the tagged count, before
 *     touching anything (opus review, ticket 12fd73d, required F2): a
 *     missing/misconfigured `.env` silently falls through to whatever is
 *     already in the environment (`load-env.ts` swallows ENOENT by
 *     design -- see that file), so without this, running against the
 *     WRONG database would print a reassuring "Found 0 resume(s)" and
 *     look identical to "already clean" instead of "checked the wrong
 *     place." Seeing "0 of 0 total resumes" or an unrecognized
 *     host/database name is the visible tell.
 *
 * Opus review, ticket 12fd73d: one deliberate divergence from the literal
 * "delete everything that references a tagged resume" rule above --
 * `user_job_statuses.resume_id` is NOT deleted, it is set to NULL. See
 * `deleteTaggedResumes`'s own comment for why (schema.ts documents that
 * column as an attribute, never a key, precisely so a resume's rename/
 * removal doesn't destroy the one fact -- "I applied to this job" -- this
 * table exists to preserve).
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database -- this never
 * runs in CI or in the sandbox this ticket was implemented in, which has
 * no access to your real data):
 *
 *   npx tsx apps/api/src/scripts/cleanup-demo-match-test-data.ts          # DRY RUN
 *   npx tsx apps/api/src/scripts/cleanup-demo-match-test-data.ts --live   # actually deletes
 */
import { pathToFileURL } from "node:url";
import { inArray, like } from "drizzle-orm";
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

/** Must match `RESUME_TEXT_PREFIX` in `../demo-match.test.ts` exactly --
 * not imported from there (a script importing a `.test.ts` file would be
 * an odd, fragile dependency on test-only code), so if that file's
 * constant ever changes, this one has to be updated by hand alongside it. */
export const RESUME_TEXT_PREFIX = "ticket-620ca30-demo-match-test:";

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

export async function findTaggedResumeIds(
  db: NodePgDatabase,
): Promise<{ id: string; resumeNickname: string; createdAt: Date }[]> {
  return db
    .select({
      id: resumes.id,
      resumeNickname: resumes.resumeNickname,
      createdAt: resumes.createdAt,
    })
    .from(resumes)
    .where(like(resumes.resumeText, `${RESUME_TEXT_PREFIX}%`));
}

export async function countDependents(
  db: NodePgDatabase,
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

  // Sequential, not Promise.all: `db` here is backed by a single `pg.Client`
  // (see `connectDb()`/`main()` below), not a `Pool` -- concurrent queries
  // on one client are not real concurrency (node-postgres just queues them)
  // and pg's own deprecation warning says that queueing is going away in
  // pg@9. One query at a time is both correct and exactly as fast in
  // practice for this script's small, one-off counts.
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

/**
 * Deletes the given resumes and every row that references them, in strict
 * child-before-parent FK order, inside one transaction. Exported (not
 * inlined in `main()`) so a test can exercise it directly against an
 * isolated test database, the same way `rescore-existing-matches.ts`
 * exports its own per-row update helper for its tests to call.
 *
 * `user_job_statuses` is the one exception to "delete everything that
 * references a tagged resume" (opus review, ticket 12fd73d, required F1):
 * its `resume_id` is set to NULL, not deleted. schema.ts is explicit that
 * this column is "an attribute, deliberately NOT part of the uniqueness
 * key... worth knowing, never worth keying on", nullable "for two honest
 * reasons: a `saved`/`dismissed` row can predate any resume being
 * involved at all, and a backfilled row may record a real application
 * whose resume version is no longer identifiable" -- exactly the state
 * this NULL puts it in. `DELETE`ing the row instead would risk destroying
 * a REAL fact this table exists to preserve ("I applied to this job") in
 * the unlikely event a genuine application was ever recorded against a
 * tagged resume, for the sake of removing a column value that was never
 * the row's identity in the first place.
 */
export async function deleteTaggedResumes(db: NodePgDatabase, resumeIds: string[]): Promise<void> {
  if (resumeIds.length === 0) return;
  await db.transaction(async (tx) => {
    const searchIdRows = await tx
      .select({ id: searches.id })
      .from(searches)
      .where(inArray(searches.resumeId, resumeIds));
    const searchIds = searchIdRows.map((r) => r.id);

    await tx.delete(jobMatchFailures).where(inArray(jobMatchFailures.resumeId, resumeIds));
    await tx
      .update(userJobStatuses)
      .set({ resumeId: null })
      .where(inArray(userJobStatuses.resumeId, resumeIds));
    await tx.delete(handoffs).where(inArray(handoffs.resumeId, resumeIds));
    await tx.delete(jobMatches).where(inArray(jobMatches.resumeId, resumeIds));
    if (searchIds.length > 0) {
      // Opus review, required F4: `job_match_failures.resume_id` is
      // documented (schema.ts) as denormalized FROM `search_id` -- true
      // today, but not enforced by any CHECK constraint. A second,
      // search_id-scoped delete here is pure defense against the two ever
      // skewing: it can only match rows the resume_id-scoped delete above
      // already removed (0 rows, harmless) unless that invariant is ever
      // violated, in which case THIS is what stops the `searches` delete
      // below from failing on a real FK violation it would otherwise hit.
      await tx.delete(jobMatchFailures).where(inArray(jobMatchFailures.searchId, searchIds));
      await tx.delete(searchSources).where(inArray(searchSources.searchId, searchIds));
      await tx.delete(searchResults).where(inArray(searchResults.searchId, searchIds));
    }
    await tx.delete(searches).where(inArray(searches.resumeId, resumeIds));
    await tx.delete(resumes).where(inArray(resumes.id, resumeIds));
  });
}

export async function countTotalResumes(db: NodePgDatabase): Promise<number> {
  const rows = await db.select({ id: resumes.id }).from(resumes);
  return rows.length;
}

export type CleanupResult = {
  tagged: { id: string; resumeNickname: string; createdAt: Date }[];
  totalResumeCount: number;
  counts: Record<string, number>;
  deleted: boolean;
};

/**
 * The whole find/count/conditionally-delete decision, as one directly
 * testable function (opus review, ticket 12fd73d, required F3b) -- `live:
 * false` is the entire safety guarantee this script makes, and before
 * this it was only proven at the `parseArgs` level: nothing actually
 * asserted that a dry run performs zero writes against a real database.
 * `main()` below is now just argv parsing, connection handling, and
 * printing this result -- no decision logic of its own left to drift out
 * of a test's reach.
 */
export async function runCleanup(
  db: NodePgDatabase,
  opts: { live: boolean },
): Promise<CleanupResult> {
  const tagged = await findTaggedResumeIds(db);
  const totalResumeCount = await countTotalResumes(db);

  if (tagged.length === 0) {
    return { tagged, totalResumeCount, counts: await countDependents(db, []), deleted: false };
  }

  const resumeIds = tagged.map((r) => r.id);
  const counts = await countDependents(db, resumeIds);

  if (!opts.live) {
    return { tagged, totalResumeCount, counts, deleted: false };
  }

  await deleteTaggedResumes(db, resumeIds);
  return { tagged, totalResumeCount, counts, deleted: true };
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
    `cleanup-demo-match-test-data: ${
      live ? "LIVE RUN -- this WILL delete rows" : "DRY RUN -- nothing will be deleted"
    }`,
  );
  // Opus review, required F2: printed BEFORE any query, so a wrong-database
  // mistake (most likely: a missing .env falling through to whatever is
  // already in the shell's environment -- load-env.ts swallows ENOENT by
  // design) is visible up front rather than only inferable from a
  // suspiciously-empty result below.
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
    const { tagged, totalResumeCount, counts } = result;

    console.log(
      `\nFound ${tagged.length} of ${totalResumeCount} total resume(s) tagged ` +
        `"${RESUME_TEXT_PREFIX}":`,
    );
    for (const r of tagged) {
      console.log(`  ${r.id}  "${r.resumeNickname}"  created ${r.createdAt.toISOString()}`);
    }
    if (tagged.length > 0) {
      // Opus review, F5: migration 0010 backfilled every pre-existing row's
      // created_at to the single instant THAT migration ran (schema.ts's
      // `resumes.createdAt` doc comment) -- these tagged rows predate that
      // migration, so a recent-looking date here is expected and does not
      // mean the row is recent.
      console.log(
        "  (created dates above may be migration 0010's one-time backfill instant, not each " +
          "row's real original creation time -- see schema.ts's resumes.createdAt doc comment)",
      );
    }

    if (tagged.length === 0) {
      console.log("\nNothing to clean up.");
      return;
    }

    console.log("\nDependent rows that would also be deleted:");
    for (const [table, count] of Object.entries(counts)) {
      // Opus review, required (round 2): this table is the one exception --
      // `deleteTaggedResumes` NULLs its resume_id, it never deletes the row
      // (see that function's own F1 comment). Printing it under "would
      // also be deleted" is exactly backwards for the one table this
      // script goes out of its way to protect, so it gets its own line
      // below instead of joining this loop's "deleted" framing.
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

    console.log(`\nDeleted ${tagged.length} tagged resume(s) and all their dependent rows.`);
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
