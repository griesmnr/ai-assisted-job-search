/**
 * One-time reconciliation tool (ticket to be filed against epic 2b9e9dd,
 * flagged by opus review of ticket b2f9dfd, round 1, finding F2).
 *
 * THE GAP THIS CLOSES. Ticket b2f9dfd's migration 0016 backfilled every
 * pre-existing resume to `LEGACY_USER_ID` (schema.ts's own exported
 * constant) -- the only thing a MIGRATION can do, since it has no way to
 * know what anonymous id a real browser will mint on its NEXT visit
 * (identity.ts mints that client-side, after the migration has already
 * run). Left alone, this means: on Nicole's first real page load after
 * this ships, her browser gets a brand-new random id that owns NOTHING --
 * `GET /resumes` (now scoped per-user) returns empty, "My Resumes" looks
 * wiped, and re-pasting an old resume's text creates a genuinely NEW row
 * (per-user hashing means it can no longer find her old one), silently
 * detaching it from every already-scored `job_matches` row underneath it.
 *
 * This script is the manual fix: point it at whatever real anonymous id
 * her browser is actually using (read `jobsearch.web.userId.v1` out of
 * that browser's own localStorage -- identity.ts's own doc comment names
 * the key), and it reassigns every `LEGACY_USER_ID` resume to that id.
 *
 * WIDENED (ticket 3fc1e5e, epic 2b9e9dd, child 3): it now also reassigns
 * `user_job_statuses` rows, in the SAME transaction. That ticket gave that
 * table its own `user_id` column (migration 0017), so the saved/dismissed/
 * applied markers have an owner of their own rather than inheriting one
 * from whatever resume they happen to name -- and moving only the resumes
 * would leave every marker stranded under `LEGACY_USER_ID`. That failure is
 * the same shape as the one above ("My Resumes looks wiped") and worse in
 * consequence: an "I applied to this" record is the one fact in this app
 * nothing can reconstruct (schema.ts's `user_job_statuses` doc comment), and
 * a silently-missing one reads as "I never applied", inviting a duplicate
 * application to the same posting.
 * Deliberately NOT automatic, and deliberately not run as part of any
 * migration: there is no way for server-side code to learn a real
 * browser's client-generated id on its own, and guessing would be far
 * worse than asking for it explicitly, once, by hand.
 *
 * WHY A PLAIN UPDATE IS SAFE HERE, UNLIKE THIS DIRECTORY'S DELETE-SHAPED
 * SCRIPTS: this only reassigns ownership -- no row is deleted, no FK
 * cascade to worry about, and it is trivially reversible (rerun with the
 * old target if a mistake is made; nothing here is destructive the way
 * cleanup-unsearched-resumes.ts's deletes are). The one real failure
 * mode -- the target user somehow already owns a resume with the same
 * `resume_hash` or `resume_nickname` as one being reassigned -- is not
 * silent corruption either way. In practice neither can happen the first
 * time this script is ever run: the target id is a brand-new anonymous
 * identity that owns nothing yet.
 *
 * WHAT TICKET 6ba221e CHANGED ABOUT THAT, because an operator reading the
 * old wording would expect a failure that no longer comes. This comment
 * used to say a duplicate `resume_hash` "surfaces as a loud Postgres
 * constraint violation (this ticket's own composite
 * `unique(user_id, resume_hash)`)". That constraint is GONE (migration
 * 0019): a resume is identified by its `id`, and two resumes with
 * byte-identical text under one user are a legal state now. So a
 * reassignment that lands identical text in the target's account SUCCEEDS,
 * silently, leaving them holding two resumes with the same text. That is
 * untidy rather than broken -- both rows are independently readable,
 * renameable and searchable (routes/resumes.ts) -- but it is no longer
 * something Postgres will stop, so nobody should be waiting for it to.
 * The `resume_nickname` half is unaffected: it was never a database
 * constraint, only the app-level check on a later `PATCH /resumes/:id`,
 * and that still fires.
 *
 * SAFETY GATE, same shape as this directory's other scripts:
 *
 *   - DRY RUN is the default. No flags prints exactly which resumes would
 *     move and to where, then stops -- nothing is written.
 *   - `--live` is required to actually update. Any other argument, or a
 *     missing/malformed target id, is a hard error.
 *   - Refuses to run if the target user id doesn't already exist in
 *     `users` -- that means the browser this is meant to rescue hasn't
 *     actually made a real request yet (identity.ts's server-side
 *     counterpart creates the row lazily on first sight); load the real
 *     app in that browser once first, THEN run this.
 *   - Refuses to run if the target id IS `LEGACY_USER_ID` itself (a
 *     same-to-same reassignment is never the intent, and a typo pasting
 *     the wrong id in is exactly the kind of mistake this check exists
 *     to catch before anything is written).
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database -- this never
 * runs in CI or in the sandbox this ticket was implemented in, which has
 * no access to your real data):
 *
 *   npx tsx apps/api/src/scripts/reassign-legacy-resumes.ts <targetUserId>          # DRY RUN
 *   npx tsx apps/api/src/scripts/reassign-legacy-resumes.ts <targetUserId> --live   # actually reassigns
 */
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { LEGACY_USER_ID, resumes, userJobStatuses, users } from "../db/schema.js";
import { loadEnvFile } from "../load-env.js";

loadEnvFile();

export type ParsedArgs = { targetUserId: string; live: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const unknownFlags = flags.filter((f) => f !== "--live");
  if (unknownFlags.length > 0) {
    throw new Error(
      `Unrecognized flag(s): ${unknownFlags.join(", ")}. Known flags are --live (actually ` +
        "reassigns; omit for a dry run).",
    );
  }
  if (positional.length !== 1) {
    throw new Error(
      "Usage: reassign-legacy-resumes.ts <targetUserId> [--live] -- exactly one positional " +
        `argument (the real user id to reassign LEGACY_USER_ID's resumes to) is required, got ` +
        `${positional.length}.`,
    );
  }
  const [targetUserId] = positional;
  if (targetUserId === LEGACY_USER_ID) {
    throw new Error(
      `targetUserId must not be LEGACY_USER_ID (${LEGACY_USER_ID}) itself -- that would be a ` +
        "same-to-same no-op, almost certainly a copy-paste mistake.",
    );
  }
  return { targetUserId: targetUserId!, live: flags.includes("--live") };
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

export type ReassignCandidate = { id: string; resumeNickname: string };

export async function findLegacyResumes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<ReassignCandidate[]> {
  return db
    .select({ id: resumes.id, resumeNickname: resumes.resumeNickname })
    .from(resumes)
    .where(eq(resumes.userId, LEGACY_USER_ID));
}

export async function userExists(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  userId: string,
): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  return rows.length > 0;
}

/**
 * Ticket 3fc1e5e: how many `user_job_statuses` rows this run moved (or
 * would move). `user_job_statuses` gained its OWN `user_id` column in that
 * ticket (migration 0017), so ownership of a saved/dismissed/applied marker
 * is no longer implied by the resume it happens to name -- it is a column of
 * its own, and reassigning only `resumes` would leave every one of Nicole's
 * real "I applied to this" markers stranded under `LEGACY_USER_ID` while the
 * resumes moved out from under them. That is exactly the "My Resumes looks
 * wiped" failure this whole script exists to prevent, one table over, and
 * it is worse because an application record is the one thing in this app
 * nothing can reconstruct (schema.ts's `user_job_statuses` doc comment).
 */
export type ReassignResult = {
  candidates: ReassignCandidate[];
  /** Status rows owned by LEGACY_USER_ID, found the same way `candidates`
   * is: reported in the dry run, moved by `--live`. */
  jobStatusCount: number;
  reassigned: boolean;
};

export async function countLegacyJobStatuses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<number> {
  const rows = await db
    .select({ id: userJobStatuses.id })
    .from(userJobStatuses)
    .where(eq(userJobStatuses.userId, LEGACY_USER_ID));
  return rows.length;
}

export async function runReassign(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  opts: { targetUserId: string; live: boolean },
): Promise<ReassignResult> {
  const targetExists = await userExists(db, opts.targetUserId);
  if (!targetExists) {
    throw new Error(
      `No users row exists for "${opts.targetUserId}" yet -- load the real app in the browser ` +
        "this id belongs to at least once first (identity.ts's server-side hook creates the row " +
        "on that browser's first real request), then run this again.",
    );
  }

  const candidates = await findLegacyResumes(db);
  const jobStatusCount = await countLegacyJobStatuses(db);
  // Ticket 3fc1e5e: `candidates.length === 0` is no longer sufficient as the
  // "nothing to do" test -- a database can legitimately have legacy STATUS
  // rows with no legacy resumes left (e.g. this script was run once before
  // 0017 existed, moving the resumes but not the statuses, which is exactly
  // the state a real deployment of the previous version leaves behind).
  if (!opts.live || (candidates.length === 0 && jobStatusCount === 0)) {
    return { candidates, jobStatusCount, reassigned: false };
  }

  // ONE TRANSACTION (ticket 3fc1e5e). The two updates are halves of a single
  // change of ownership, and a partial application is the specific bad state:
  // resumes moved but statuses not means the target user sees their resumes
  // and their scored jobs with every "applied"/"dismissed" marker silently
  // missing -- which reads as "I never applied to this" and invites a
  // duplicate application. All or neither.
  await db.transaction(async (tx) => {
    await tx
      .update(resumes)
      .set({ userId: opts.targetUserId })
      .where(eq(resumes.userId, LEGACY_USER_ID));

    // No ON CONFLICT handling needed, for the same reason this file's header
    // gives for the resume-hash/nickname case: the target is a brand-new
    // anonymous identity that owns nothing yet, so it cannot already hold a
    // status for one of these jobs. If it somehow does, the new
    // `unique(user_id, job_id)` key (migration 0017) raises a loud
    // constraint violation and this transaction rolls BOTH updates back --
    // never a silent half-move.
    await tx
      .update(userJobStatuses)
      .set({ userId: opts.targetUserId })
      .where(eq(userJobStatuses.userId, LEGACY_USER_ID));
  });

  return { candidates, jobStatusCount, reassigned: true };
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
  const { targetUserId, live } = parsed;

  console.log(
    `reassign-legacy-resumes: ${live ? "LIVE RUN -- this WILL reassign rows" : "DRY RUN -- nothing will be written"}`,
  );
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
    const result = await runReassign(db, { targetUserId, live });
    console.log(
      `\nFound ${result.candidates.length} resume(s) owned by the legacy user (${LEGACY_USER_ID}):`,
    );
    for (const r of result.candidates) {
      console.log(`  ${r.id}  "${r.resumeNickname}"`);
    }
    // Ticket 3fc1e5e: reported alongside the resumes, because these move too
    // (see `ReassignResult.jobStatusCount`) and an operator reading a dry run
    // needs to see everything the live run would touch.
    console.log(
      `Plus ${result.jobStatusCount} user_job_statuses row(s) (saved/dismissed/applied markers) ` +
        `owned by the legacy user.`,
    );
    if (result.candidates.length === 0 && result.jobStatusCount === 0) {
      console.log("\nNothing to reassign.");
      return;
    }
    if (!live) {
      console.log(
        `\nDry run: stopping here. Nothing was written. Re-run with --live to actually reassign ` +
          `${result.candidates.length} resume(s) and ${result.jobStatusCount} job-status row(s) ` +
          `to "${targetUserId}".`,
      );
      return;
    }
    console.log(
      `\nReassigned ${result.candidates.length} resume(s) and ${result.jobStatusCount} ` +
        `job-status row(s) to "${targetUserId}".`,
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
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
