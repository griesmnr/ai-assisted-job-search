import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  allMigrationFiles,
  applyMigrationInTransaction,
  createEmptyTestDatabase,
  loadMigrationStatements,
} from "./test-db.js";
import { loadEnvFile } from "../load-env.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

/**
 * Migration 0013 (ticket 9a53485): scopes `job_match_failures` to the search
 * that produced it — `search_id NOT NULL`, and the unique key moved from
 * `(resume_id, job_id)` to `(search_id, resume_id, job_id)`.
 *
 * Same pattern as migration-0004/0006/0010/0011's tests: a real, disposable
 * Postgres database with PRE-EXISTING rows inserted the way a real
 * multi-run database actually has them (no `search_id` — the column does
 * not exist yet at insert time), and only THEN 0013 applied.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE, and why it cannot be read off the
 * SQL. drizzle-kit generated a bare `ADD COLUMN "search_id" text NOT NULL`,
 * which cannot run at all against a table with rows in it. The hand-written
 * backfill that replaces it EXPANDS each legacy row into one row per search
 * that had already linked that (resume, job) — because that is what the old
 * resume-wide row was already saying, and picking a single arbitrary search
 * instead would silently revive the job as `outstanding` in every other
 * search that linked it. "Does that backfill do the right thing to real
 * rows" is answered by running it against real rows.
 */

const MIGRATION_UNDER_TEST = "0013_scope_job_match_failures_to_search.sql";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0013_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so adding 0014 later doesn't silently turn this
  // file into "apply nothing, then apply 0013 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0012_lonely_blindfold.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  await db.query(`insert into source_descriptors (id, display_name) values ('usajobs', 'USAJOBS')`);
  await db.query(
    `insert into resumes (id, resume_text, resume_hash, resume_nickname)
     values ('r-1', 'resume one', 'hash-1', 'Resume 1'),
            ('r-2', 'resume two', 'hash-2', 'Resume 2')`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company,
                       link_to_apply, posted_at)
     values ('j-shared', 'ext-shared', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/shared', now()),
            ('j-orphan', 'ext-orphan', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/orphan', now())`,
  );

  // THE ROW THE DEFECT WAS ABOUT: resume r-1 searched twice, and both
  // searches linked j-shared. Under the old key there is exactly ONE
  // failure row for that pair, and it spoke for both searches.
  await db.query(
    `insert into searches (id, resume_id, searched_at, status)
     values ('s-1', 'r-1', now() - interval '2 hours', 'complete'),
            ('s-2', 'r-1', now() - interval '1 hour', 'complete'),
            ('s-other', 'r-2', now(), 'complete')`,
  );
  await db.query(
    `insert into search_results (id, search_id, job_id) values
       ('sr-1', 's-1', 'j-shared'),
       ('sr-2', 's-2', 'j-shared')`,
  );
  await db.query(
    `insert into job_match_failures (id, resume_id, job_id, kind, error_message, attempts, failed_at)
     values ('f-shared', 'r-1', 'j-shared', 'rate-limited', 'gave up after 4 attempts', 4,
             timestamp '2026-09-01 12:00:00'),
            ('f-orphan', 'r-2', 'j-orphan', 'auth-failed', 'no search ever linked this', 1,
             timestamp '2026-09-01 13:00:00')`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0013 — job_match_failures becomes search-scoped", () => {
  it("expands a legacy row into one row per search that had linked the pair, preserving its cause", async () => {
    const { rows } = await db.query<{
      search_id: string;
      kind: string;
      error_message: string;
      attempts: number;
      failed_at: Date;
    }>(
      `select search_id, kind, error_message, attempts, failed_at
         from job_match_failures where job_id = 'j-shared' order by search_id`,
    );
    // Two rows, one per search — NOT one row on an arbitrarily-chosen
    // search, which would have made j-shared outstanding again in the other.
    expect(rows.map((r) => r.search_id)).toEqual(["s-1", "s-2"]);
    // The cause travels with them: a backfill that invented a fresh `kind`
    // or a fresh `failed_at` would rewrite history rather than re-key it.
    expect(rows.every((r) => r.kind === "rate-limited")).toBe(true);
    expect(rows.every((r) => r.attempts === 4)).toBe(true);
    expect(rows.every((r) => r.failed_at.toISOString().startsWith("2026-09-01T12:00"))).toBe(true);
  });

  it("drops a legacy row no search ever linked, rather than blocking the NOT NULL", async () => {
    // `f-orphan` has no `search_results` row, so there is no search it could
    // honestly be scoped to and nothing that reads it. Not reachable through
    // either writer (both only record a job some search linked) — handled
    // because a NOT NULL column cannot be added over a row left NULL.
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from job_match_failures where job_id = 'j-orphan'",
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it("leaves no NULL search_id behind and enforces NOT NULL on new rows", async () => {
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from job_match_failures where search_id is null",
    );
    expect(Number(rows[0]?.n)).toBe(0);

    await expect(
      db.query(
        `insert into job_match_failures (id, resume_id, job_id, kind, error_message, attempts)
         values ('f-nonull', 'r-1', 'j-shared', 'auth-failed', 'no search named', 1)`,
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it("accepts the SAME (resume, job) under a different search, and still rejects a duplicate within one", async () => {
    // THE WHOLE POINT OF THE MIGRATION, asserted at the constraint level:
    // the old key made this insert a duplicate, which is how a later search
    // silently inherited an earlier one's verdict instead of recording (or
    // not recording) its own.
    await db.query(
      `insert into searches (id, resume_id, searched_at, status)
       values ('s-3', 'r-1', now(), 'running')`,
    );
    await db.query(
      `insert into job_match_failures (id, search_id, resume_id, job_id, kind, error_message, attempts)
       values ('f-s3', 's-3', 'r-1', 'j-shared', 'auth-failed', 'a third search gave up too', 1)`,
    );

    await expect(
      db.query(
        `insert into job_match_failures (id, search_id, resume_id, job_id, kind, error_message, attempts)
         values ('f-s3-dup', 's-3', 'r-1', 'j-shared', 'rate-limited', 'same search again', 2)`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses a search_id that names no search", async () => {
    await expect(
      db.query(
        `insert into job_match_failures (id, search_id, resume_id, job_id, kind, error_message, attempts)
         values ('f-badfk', 's-does-not-exist', 'r-1', 'j-shared', 'auth-failed', 'orphan', 1)`,
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});
