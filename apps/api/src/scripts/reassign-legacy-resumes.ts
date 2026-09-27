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
 * `resume_hash` or `resume_nickname` as one being reassigned -- surfaces
 * as a loud Postgres constraint violation (this ticket's own composite
 * `unique(user_id, resume_hash)`, or the app-level nickname check on a
 * later request), never silent corruption. In practice this cannot
 * happen the first time this script is ever run: the target id is a
 * brand-new anonymous identity that owns nothing yet.
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
import { LEGACY_USER_ID, resumes, users } from "../db/schema.js";
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

export type ReassignResult = {
  candidates: ReassignCandidate[];
  reassigned: boolean;
};

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
  if (!opts.live || candidates.length === 0) {
    return { candidates, reassigned: false };
  }

  await db
    .update(resumes)
    .set({ userId: opts.targetUserId })
    .where(eq(resumes.userId, LEGACY_USER_ID));

  return { candidates, reassigned: true };
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
    if (result.candidates.length === 0) {
      console.log("\nNothing to reassign.");
      return;
    }
    if (!live) {
      console.log(
        `\nDry run: stopping here. Nothing was written. Re-run with --live to actually reassign ` +
          `${result.candidates.length} resume(s) to "${targetUserId}".`,
      );
      return;
    }
    console.log(`\nReassigned ${result.candidates.length} resume(s) to "${targetUserId}".`);
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
