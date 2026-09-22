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
 * Migration 0011 (ticket 4f88339): grows `search_sources` into the
 * per-source fan-in ledger the queue-driven completion derive reads, adds
 * the `job_match_failures` table, and adds `searches.completed_at`.
 *
 * Same pattern as migration-0004/0006/0010's tests: a real, disposable
 * Postgres database with PRE-EXISTING rows inserted the way a real
 * multi-run database actually has them (no `status`, no `completed_at` —
 * those columns don't exist yet at insert time), and only THEN 0011
 * applied. The one thing worth testing here cannot be read off the SQL:
 * drizzle-kit's generated `ADD COLUMN ... DEFAULT 'pending'` stamps every
 * existing row `pending`, which would be wrong — those rows belong to
 * already-finished synchronous searches — so this migration carries a
 * hand-written backfill to `'complete'` immediately after it. "Does the
 * backfill work against data" is answered by running it against data.
 */

const MIGRATION_UNDER_TEST = "0011_clumsy_quentin_quire.sql";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0011_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so adding 0012 later doesn't silently turn this
  // file into "apply nothing, then apply 0011 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0010_remarkable_gressill.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  // A pre-0011 database's rows: a finished synchronous search with two
  // source links and no per-source status anywhere.
  await db.query(
    `insert into source_descriptors (id, display_name) values
     ('usajobs', 'USAJOBS'), ('greenhouse', 'Greenhouse')`,
  );
  await db.query(
    `insert into resumes (id, resume_text, resume_hash, resume_nickname)
     values ('r-1', 'resume text', 'hash-1', 'Resume 1')`,
  );
  await db.query(
    `insert into searches (id, resume_id, searched_at, status)
     values ('s-done', 'r-1', now(), 'complete'),
            ('s-stuck', 'r-1', now(), 'running')`,
  );
  await db.query(
    `insert into search_sources (id, search_id, source_descriptor_id) values
     ('ss-1', 's-done', 'usajobs'),
     ('ss-2', 's-done', 'greenhouse'),
     ('ss-3', 's-stuck', 'usajobs')`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => {
  await teardown?.();
});

describe("migration 0011 — search_sources grows into the fan-in ledger", () => {
  it("backfills EVERY pre-existing row to 'complete', not to the column default 'pending'", async () => {
    const { rows } = await db.query<{
      id: string;
      status: string;
      linked_job_count: number | null;
    }>("select id, status, linked_job_count from search_sources order by id");
    expect(rows.map((r) => r.status)).toEqual(["complete", "complete", "complete"]);
    // Honest about what was never recorded: the count is unknown for
    // history, not invented as 0.
    expect(rows.every((r) => r.linked_job_count === null)).toBe(true);
  });

  it("leaves NEW rows defaulting to 'pending' — the backfill is a one-time statement, not a changed default", async () => {
    await db.query(
      `insert into search_sources (id, search_id, source_descriptor_id)
       values ('ss-new', 's-stuck', 'greenhouse')`,
    );
    const { rows } = await db.query<{ status: string }>(
      "select status from search_sources where id = 'ss-new'",
    );
    expect(rows[0]?.status).toBe("pending");
  });

  it("enforces unique (search_id, source_descriptor_id)", async () => {
    await expect(
      db.query(
        `insert into search_sources (id, search_id, source_descriptor_id)
         values ('ss-dup', 's-done', 'usajobs')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("adds searches.completed_at as NULL for every pre-existing row", async () => {
    const { rows } = await db.query<{ id: string; completed_at: Date | null }>(
      "select id, completed_at from searches order by id",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.completed_at === null)).toBe(true);
  });
});

describe("migration 0011 — job_match_failures", () => {
  it("accepts one row per (resume_id, job_id) and rejects a second", async () => {
    await db.query(
      `insert into jobs (id, external_id, data_source, title, description, company,
                         link_to_apply, posted_at)
       values ('j-1', 'ext-1', 'usajobs', 'Engineer', 'desc', 'Co',
               'https://example.com/1', now())`,
    );
    await db.query(
      `insert into job_match_failures (id, resume_id, job_id, kind, error_message, attempts)
       values ('f-1', 'r-1', 'j-1', 'rate-limited', 'gave up after 4 attempts', 4)`,
    );

    const { rows } = await db.query<{ kind: string; attempts: number; failed_at: Date }>(
      "select kind, attempts, failed_at from job_match_failures where id = 'f-1'",
    );
    expect(rows[0]?.kind).toBe("rate-limited");
    expect(rows[0]?.attempts).toBe(4);
    expect(rows[0]?.failed_at).toBeInstanceOf(Date);

    await expect(
      db.query(
        `insert into job_match_failures (id, resume_id, job_id, kind, error_message, attempts)
         values ('f-2', 'r-1', 'j-1', 'auth-failed', 'second cause', 1)`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("is a SEPARATE table from job_matches — a failure row does not make a pair look already-scored", async () => {
    // The blocking reason this table exists at all (design c54b9e0 §3.2):
    // `matching/pipeline.ts` and `scoreJobWorker.ts` both treat ANY
    // `job_matches` row for (resume, job) as "already scored". If failures
    // lived there, a transient outage would permanently stop the pair
    // being retried. Asserted against the database rather than by reading
    // the two files.
    const { rows } = await db.query<{ n: string }>(
      "select count(*) as n from job_matches where resume_id = 'r-1' and job_id = 'j-1'",
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
