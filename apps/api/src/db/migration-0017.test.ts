import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  allMigrationFiles,
  applyMigrationInTransaction,
  createEmptyTestDatabase,
  loadMigrationStatements,
} from "./test-db.js";
import { LEGACY_USER_ID } from "./schema.js";
import { loadEnvFile } from "../load-env.js";

loadEnvFile();

/**
 * Migration 0017 (ticket 3fc1e5e, epic 2b9e9dd, child 3): scopes
 * `user_job_statuses` to a real per-user identity -- adds `user_id NOT NULL`
 * and moves the uniqueness key from `job_id` alone (ONE row per job for the
 * WHOLE database) to `(user_id, job_id)`.
 *
 * Same pattern as migration-0013's and 0016's own tests: a real, disposable
 * database with PRE-EXISTING rows inserted the way a real multi-run database
 * actually has them (no `user_id` -- the column does not exist yet at insert
 * time), and only THEN 0017 applied.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE, and why it cannot be read off the SQL.
 * drizzle-kit generated a bare `ADD COLUMN "user_id" text NOT NULL`, which
 * cannot run at all against a table with rows in it. The hand-written
 * backfill that replaces it is NOT a blanket `LEGACY_USER_ID` assignment --
 * it derives each row's owner from `resumes.user_id` via that row's own
 * (nullable) `resume_id`, falling back to the legacy user only when there is
 * no resume to derive from. Whether that COALESCE actually resolves each of
 * the three real cases correctly -- a resume owned by a real user, a resume
 * owned by the legacy user, and no resume at all -- is answered by running it
 * against real rows, not by reading the generated SQL. So is the thing the
 * whole ticket is for: that two users can now hold a status on the same job.
 */

const MIGRATION_UNDER_TEST = "0017_scope_user_job_statuses_to_user.sql";

// A real per-user id, of the shape identity.ts's UUID_RE accepts -- stands in
// for a resume created AFTER 0016 landed, i.e. one whose owner is a genuine
// browser identity rather than the legacy bucket. This is the case a blanket
// "backfill everything to LEGACY_USER_ID" would have silently got wrong.
const REAL_USER_ID = "33333333-3333-4333-8333-333333333333";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0017_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so adding 0018 later doesn't silently turn this
  // file into "apply nothing, then apply 0017 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0016_overjoyed_human_cannonball.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  // `user_job_statuses.job_id` has an FK to `jobs`, which has one to
  // `source_descriptors` -- so the fixture needs the whole chain, not just
  // the status rows.
  await db.query(
    `insert into source_descriptors (id, display_name) values ('usajobs', 'USAJOBS')
       on conflict (id) do nothing`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company, link_to_apply, posted_at)
     values
       ('job-real',   'ext-real',   'usajobs', 'A job', 'd', 'Co', 'https://example.com/1', TIMESTAMP '2026-01-01 00:00:00'),
       ('job-legacy', 'ext-legacy', 'usajobs', 'B job', 'd', 'Co', 'https://example.com/2', TIMESTAMP '2026-01-01 00:00:00'),
       ('job-noresume','ext-noresume','usajobs','C job', 'd', 'Co', 'https://example.com/3', TIMESTAMP '2026-01-01 00:00:00')`,
  );

  // Two resumes with two DIFFERENT owners. 0016 has already run, so
  // `resumes.user_id` exists and is NOT NULL by now; the legacy user row was
  // created by 0016 itself.
  await db.query(`insert into users (id) values ($1) on conflict (id) do nothing`, [REAL_USER_ID]);
  await db.query(
    `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname) values
       ('resume-real',   $1, 'real user resume',   'hash-real',   'Resume 1'),
       ('resume-legacy', $2, 'legacy user resume', 'hash-legacy', 'Resume 1')`,
    [REAL_USER_ID, LEGACY_USER_ID],
  );

  // PRE-EXISTING status rows, inserted the way a real database actually has
  // them at this point in migration history: no `user_id` column exists yet
  // at all. All three cases the backfill has to distinguish. Note every
  // `job_id` is distinct -- it MUST be, because `unique(job_id)` is still in
  // force until 0017 itself drops it, which is exactly the constraint this
  // migration exists to widen.
  await db.query(
    `insert into user_job_statuses (id, job_id, status, resume_id, applied_at) values
       ('ujs-real',     'job-real',     'applied',   'resume-real',   TIMESTAMP '2026-08-19 00:00:00'),
       ('ujs-legacy',   'job-legacy',   'dismissed', 'resume-legacy', NULL),
       ('ujs-noresume', 'job-noresume', 'saved',     NULL,            NULL)`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0017 — user_job_statuses becomes per-user", () => {
  // Same reasoning as migration-0016's own version of this test: the
  // migration file necessarily hardcodes this id as a raw SQL literal (a
  // migration is a frozen historical record, not code that can import a
  // constant), so this is the one place that literal and schema.ts's
  // exported constant are checked against each other. Without it, a future
  // edit to either could drift while every other assertion here still
  // passed -- they would all pass against whatever value the migration
  // actually used.
  it("the migration file's own hardcoded id matches schema.ts's LEGACY_USER_ID constant", () => {
    const sql = loadMigrationStatements(MIGRATION_UNDER_TEST).join("\n");
    expect(sql).toContain(LEGACY_USER_ID);
  });

  it("backfills a row whose resume belongs to a REAL user to THAT user, not to the legacy bucket", async () => {
    // The case a blanket LEGACY_USER_ID backfill would have got wrong: this
    // row records a real application by a real identity, and attributing it
    // to the legacy user would have handed that person's own applied record
    // to a bucket they cannot read -- silently losing it from their results.
    const { rows } = await db.query<{ user_id: string }>(
      "select user_id from user_job_statuses where id = 'ujs-real'",
    );
    expect(rows[0]?.user_id).toBe(REAL_USER_ID);
  });

  it("backfills a row whose resume belongs to the legacy user to the legacy user", async () => {
    const { rows } = await db.query<{ user_id: string }>(
      "select user_id from user_job_statuses where id = 'ujs-legacy'",
    );
    expect(rows[0]?.user_id).toBe(LEGACY_USER_ID);
  });

  it("backfills a row with NO resume_id to the legacy user — the one case with no evidence to go on", async () => {
    // `resume_id` is nullable by design (a `saved`/`dismissed` row can
    // predate any resume being involved), so this is a real shape, not a
    // hypothetical one, and LEGACY_USER_ID is the honest answer for it.
    const { rows } = await db.query<{ user_id: string }>(
      "select user_id from user_job_statuses where id = 'ujs-noresume'",
    );
    expect(rows[0]?.user_id).toBe(LEGACY_USER_ID);
  });

  it("leaves no row with a NULL user_id, and enforces NOT NULL for new inserts going forward", async () => {
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from user_job_statuses where user_id is null",
    );
    expect(rows[0]?.count).toBe("0");

    await expect(
      db.query(
        `insert into user_job_statuses (id, job_id, status) values ('no-user', 'job-real', 'saved')`,
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it("no longer enforces a GLOBAL unique constraint on job_id — two different users can hold a status on the SAME job", async () => {
    // THE POINT OF THE WHOLE MIGRATION. Before it, `unique(job_id)` meant
    // user B clicking "Applied" on a job user A had dismissed did not create
    // a second row -- it OVERWROTE A's, destroying an authored fact nothing
    // in this system can reconstruct.
    await expect(
      db.query(
        `insert into user_job_statuses (id, user_id, job_id, status)
         values ('ujs-second-user', $1, 'job-real', 'dismissed')`,
        [LEGACY_USER_ID],
      ),
    ).resolves.not.toThrow();

    const { rows } = await db.query<{ user_id: string; status: string }>(
      "select user_id, status from user_job_statuses where job_id = 'job-real' order by user_id",
    );
    expect(rows).toHaveLength(2);
    // Each user's own status is intact and distinct -- the real user's
    // backfilled `applied` was not touched by the second user's insert.
    expect(rows.map((r) => r.status)).toEqual(["dismissed", "applied"]);
  });

  it("DOES still enforce uniqueness for the SAME user on the SAME job", async () => {
    // The upsert in routes/job-status.ts targets exactly this key, so it has
    // to be a real unique index or `ON CONFLICT` would be a runtime error.
    await expect(
      db.query(
        `insert into user_job_statuses (id, user_id, job_id, status)
         values ('ujs-real-dup', $1, 'job-real', 'saved')`,
        [REAL_USER_ID],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("keeps resume_id OUT of the uniqueness key — a different resume for the same (user, job) still conflicts", async () => {
    // schema.ts is explicit that `resume_id` must never enter this key, and
    // ticket dba885e's standing instruction repeated it. This is that
    // invariant expressed as behavior: varying ONLY the resume must not buy
    // a second row for the same person and job, or "have I applied to X?"
    // would start answering "no" after every resume rewrite.
    await expect(
      db.query(
        `insert into user_job_statuses (id, user_id, job_id, status, resume_id)
         values ('ujs-real-other-resume', $1, 'job-real', 'saved', 'resume-legacy')`,
        [REAL_USER_ID],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("preserves the applied_at timestamp the backfilled row already carried", async () => {
    // The migration rewrites ownership, never the authored facts themselves.
    const { rows } = await db.query<{ applied_at: Date | null }>(
      "select applied_at from user_job_statuses where id = 'ujs-real'",
    );
    expect(rows[0]?.applied_at).toEqual(new Date("2026-08-19T00:00:00Z"));
  });
});
