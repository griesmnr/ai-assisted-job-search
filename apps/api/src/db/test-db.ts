/**
 * Per-run, per-test-file isolated Postgres databases (ticket c434a6e).
 *
 * Every worktree in this project runs its tests against the same local
 * Postgres instance, with no isolation between them. Three separate,
 * dated incidents (see git-bug c434a6e's comment history) came out of
 * that:
 *
 *   1. ticket/620ca30's migration 0004 (adding `resumes.resume_hash NOT
 *      NULL`) landed on the shared database while another worktree's
 *      tests had never heard of that column — those tests started failing
 *      on not-null violations, and the agent running them reported the
 *      failures as "pre-existing and unrelated". They were neither.
 *   2. `demo-match.test.ts`'s teardown leaked FK-referencing rows on any
 *      in-test failure, wedging the suite until someone wrote recovery
 *      SQL by hand.
 *   3. Two worktrees running their suites at the same moment both wrote
 *      the same hardcoded fixture ids (`worker-test-source`,
 *      `worker-test-resume`) into the shared database and hit a real FK
 *      violation neither branch caused on its own.
 *
 * `migration-0004.test.ts` (ticket 620ca30) already solved this for
 * itself: it creates a uniquely-named database
 * (`migration_0004_test_<uuid>`), applies migrations into it, and drops
 * it in `afterAll`. This module generalizes that exact pattern so every
 * other DB-backed test file can get its own database with a couple of
 * lines instead of hand-rolling CREATE/DROP DATABASE boilerplate.
 *
 * With every test file on its own throwaway database:
 *   - two worktrees (or two files in one worktree) running concurrently
 *     can never collide on a fixture id, because they're never in the
 *     same database;
 *   - a branch that hasn't applied a migration is unaffected by one that
 *     has, because "the schema" is whatever that run's own
 *     `createTestDatabase` call just migrated to;
 *   - a test that throws mid-run leaves rows behind, but they die with
 *     the database in `afterAll`'s `teardown()` (or, if the process was
 *     killed hard enough to skip even that, the orphaned database is
 *     inert in the meantime - nothing else ever connects to it, so it
 *     can't wedge a later run the way a leaked row in the SHARED database
 *     could). It doesn't stay orphaned forever, though: every database
 *     name embeds its creation time, and each new `createEmptyTestDatabase`
 *     call opportunistically sweeps and drops any such orphan old enough
 *     and connection-free (see `sweepOrphanedTestDatabases` below) - this
 *     matters most for a long-lived Postgres like CI's (ticket 1b699b5),
 *     which would otherwise accumulate one abandoned database per
 *     hard-killed run forever.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { loadEnvFile } from "../load-env.js";

// Safe to call more than once (each test file that also calls this at its
// own top level just re-parses the same file). Ticket 2b54470: this used
// to be an unguarded `process.loadEnvFile()`, which threw ENOENT for any
// worktree with no .env present -- every worktree unless something
// manually copies one in. Because this file is imported by nearly every
// DB-backed test file (this module's own header comment), that crashed
// the WHOLE FILE at import time, not one test -- vitest counts that as a
// failed SUITE, contributing NOTHING to its own "N passed" tally, so
// `npx vitest run`'s top summary line looked clean while ~1/3 of the
// suite silently never ran (confirmed live, 2026-09-04: 10 of 32 files).
// See load-env.ts for why a missing .env is never an error.
loadEnvFile();

const DRIZZLE_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** drizzle-kit's migration files separate statements with this exact
 * marker (see drizzle/0000_jazzy_zarda.sql etc.) - splitting on it and
 * executing each piece individually is what `drizzle-kit migrate` itself
 * does under the hood. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function connectionConfig(database: string) {
  const {
    POSTGRES_USER = "jobsearch",
    POSTGRES_PASSWORD = "",
    POSTGRES_HOST = "postgres",
    POSTGRES_PORT = "5432",
  } = process.env;
  return {
    host: POSTGRES_HOST,
    port: Number(POSTGRES_PORT),
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database,
  };
}

/** The database every admin-y operation (CREATE DATABASE / DROP DATABASE)
 * connects to - never a database a test itself runs against. Defaults
 * match every existing test file's fallback. */
function adminDatabaseName(): string {
  return process.env.POSTGRES_DB ?? "jobsearch";
}

/**
 * A normal `teardown()` always drops its own database, but a hard-killed
 * run (SIGKILL, an OOM, a crashed CI runner) skips `afterAll` entirely and
 * leaves the database behind. It's inert - nothing else ever connects to
 * it - but nothing ever drops it either, so in a long-lived Postgres (this
 * matters most for CI, ticket 1b699b5) these accumulate forever.
 *
 * Postgres doesn't track a database's creation time anywhere queryable
 * (`pg_database` has no such column), so the name itself carries it: every
 * database this module creates is `<prefix>_<createdAtEpochMsHex>_<uuidHex>`.
 * This regex pulls the timestamp back out to decide whether a database is
 * old enough to be a candidate for the sweep below. `.+` is greedy but the
 * engine backtracks as needed, so a prefix containing underscores (e.g.
 * `"migration_0004_test"`) still matches correctly - the two trailing
 * groups are anchored by their character classes (hex-only) and the
 * fixed 32-hex-char width of the uuid segment.
 */
const TEST_DB_NAME_PATTERN = /^.+_([0-9a-f]+)_([0-9a-f]{32})$/;

/** How old (by the timestamp embedded in its name) an orphaned test
 * database must be before the sweep in {@link sweepOrphanedTestDatabases}
 * will drop it. A few hours: long enough that it can never catch a
 * still-running suite (even a slow one), short enough that CI's Postgres
 * doesn't accumulate all day between sweeps. Not backed by a measurement -
 * revisit if a real run's duration ever gets close to it. */
const ORPHAN_SWEEP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Opportunistically drops old orphaned test databases before creating a
 * new one. Runs on `admin` (already connected, about to `CREATE DATABASE`
 * anyway) so it costs one extra cheap query against `pg_database` in the
 * common case - a real drop only happens for databases that are both
 * named like ours, older than {@link ORPHAN_SWEEP_MAX_AGE_MS}, and have
 * zero active connections (checked via `pg_stat_activity`, never dropped
 * out from under a run that's still going for any reason). Errors are
 * swallowed and logged, never thrown: a sweep failure must never block the
 * database creation the caller actually asked for.
 */
async function sweepOrphanedTestDatabases(admin: Client): Promise<void> {
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "select datname from pg_database where datistemplate = false and datallowconn = true",
    );
    const now = Date.now();
    for (const { datname } of rows) {
      const match = TEST_DB_NAME_PATTERN.exec(datname);
      if (!match) continue;
      const createdAt = Number.parseInt(match[1] ?? "", 16);
      if (!Number.isFinite(createdAt) || now - createdAt < ORPHAN_SWEEP_MAX_AGE_MS) continue;

      const { rows: activity } = await admin.query<{ n: string }>(
        "select count(*) as n from pg_stat_activity where datname = $1",
        [datname],
      );
      if (Number(activity[0]?.n ?? "0") > 0) continue; // still in use somehow - never touch it

      await admin.query(`DROP DATABASE IF EXISTS "${datname}"`).catch((err: unknown) => {
        // Another process could win a race and drop/connect between our
        // checks and this statement; that's fine, not our problem to solve.
        console.warn(`sweepOrphanedTestDatabases: failed to drop "${datname}":`, err);
      });
    }
  } catch (err) {
    console.warn("sweepOrphanedTestDatabases: sweep failed, continuing without it:", err);
  }
}

/** Reads one migration file and splits it into individually-executable
 * statements, the same way `drizzle-kit migrate` does. Exported for
 * `migration-0004.test.ts`, which applies migrations one file at a time
 * (pre-0004, then 0004 itself as the thing under test) rather than all at
 * once via {@link applyMigrations}. */
export function loadMigrationStatements(filename: string): string[] {
  const filePath = path.join(DRIZZLE_DIR, filename);
  const sql = readFileSync(filePath, "utf8");
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every `NNNN_*.sql` file in `drizzle/`, in migration order (the
 * filenames are zero-padded, so a plain lexical sort is the journal
 * order). */
export function allMigrationFiles(): string[] {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Applies one migration file's statements wrapped in BEGIN/COMMIT, the
 * same way `drizzle-kit migrate` wraps a pending migration - an abort
 * partway through rolls the whole file back rather than leaving the
 * database half-migrated. Exported for `migration-0004.test.ts`, which
 * needs to apply its migration-under-test as its own explicit test step
 * rather than as part of setup. */
export async function applyMigrationInTransaction(client: Client, filename: string): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of loadMigrationStatements(filename)) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Applies a list of migration files (default: every migration, in
 * order) to `client`'s current database. */
export async function applyMigrations(
  client: Client,
  files: readonly string[] = allMigrationFiles(),
): Promise<void> {
  for (const file of files) {
    await applyMigrationInTransaction(client, file);
  }
}

export interface EmptyTestDatabase {
  /** The generated, globally-unique database name - useful for debugging
   * or logging, not normally needed by test bodies. */
  testDbName: string;
  /** A connected `pg` client pointed at the new, empty database. Nothing
   * has been migrated into it yet. */
  client: Client;
  /** Closes `client` and drops the database. Safe to call once, in
   * `afterAll`. */
  teardown(): Promise<void>;
}

/**
 * Creates a uniquely-named Postgres database (via a short-lived admin
 * connection to {@link adminDatabaseName}) and returns a connected client
 * pointed at it, with NO migrations applied. Most tests want
 * {@link createTestDatabase} instead - this lower-level entry point exists
 * for `migration-0004.test.ts`, which needs full control over which
 * migrations land before its test subject (0004 itself) runs.
 */
export async function createEmptyTestDatabase(prefix: string): Promise<EmptyTestDatabase> {
  // The `<epoch-ms-hex>_<uuid-hex>` suffix is what lets
  // sweepOrphanedTestDatabases (below) tell a stale orphan from a database
  // some other run is still actively using.
  const testDbName = `${prefix}_${Date.now().toString(16)}_${randomUUID().replace(/-/g, "")}`;

  const admin = new Client(connectionConfig(adminDatabaseName()));
  await admin.connect();
  try {
    await sweepOrphanedTestDatabases(admin);
    await admin.query(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.end();
  }

  const client = new Client(connectionConfig(testDbName));
  await client.connect();

  return {
    testDbName,
    client,
    async teardown() {
      await client.end();
      const dropAdmin = new Client(connectionConfig(adminDatabaseName()));
      await dropAdmin.connect();
      try {
        // Nothing else ever connects to a per-run test database, so once
        // this file's own client has disconnected the database is
        // guaranteed to have zero other connections and can be dropped
        // immediately.
        await dropAdmin.query(`DROP DATABASE IF EXISTS "${testDbName}"`);
      } finally {
        await dropAdmin.end();
      }
    },
  };
}

export interface TestDatabase extends EmptyTestDatabase {
  /** A drizzle instance bound to `client`, ready to use with the schema
   * exports from `./schema.js`. */
  db: NodePgDatabase;
}

/**
 * Creates a uniquely-named, fully-migrated, disposable Postgres database
 * for one test file's run. This is the entry point most DB-backed test
 * files want:
 *
 * ```ts
 * let testDb: TestDatabase;
 * beforeAll(async () => {
 *   testDb = await createTestDatabase("schema_test");
 * });
 * // `?.` matters: if `beforeAll` itself throws, `testDb` is never
 * // assigned and `afterAll` still runs - `testDb.teardown()` would throw
 * // "Cannot read properties of undefined", burying the real error under a
 * // second, spurious one.
 * afterAll(async () => testDb?.teardown());
 * const db = () => testDb.db; // or capture testDb.db once beforeAll has run
 * ```
 *
 * `prefix` should be short and describe the file (e.g. `"schema_test"`,
 * `"ingest_jobs_test"`) - it becomes a human-readable prefix on the
 * generated database name, which helps when eyeballing `\l` output for a
 * leaked database from a hard-killed run.
 */
export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const empty = await createEmptyTestDatabase(prefix);
  try {
    await applyMigrations(empty.client);
  } catch (err) {
    // Migration failed partway through: `empty.client` is still connected
    // and `empty.testDbName` still exists. Without this, both leak - an
    // orphaned database pinned open by a live connection, which can't even
    // be dropped by hand without `DROP DATABASE ... WITH (FORCE)` until the
    // process exits. Swallow teardown's own errors so the ORIGINAL
    // migration failure - the one the caller actually needs to see - isn't
    // masked by a secondary cleanup failure.
    await empty.teardown().catch(() => {});
    throw err;
  }
  return { ...empty, db: drizzle(empty.client) };
}
