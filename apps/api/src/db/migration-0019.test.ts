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
 * Migration 0019 (ticket 6ba221e): drops `unique(user_id, resume_hash)` from
 * `resumes`, ending content-addressing. A resume is identified by its `id`;
 * `resume_hash` becomes an ordinary column.
 *
 * Same pattern as migration-0013's, 0016's and 0017's own tests: a real,
 * disposable database with PRE-EXISTING rows inserted the way a real,
 * already-running database actually holds them, and only THEN the migration
 * under test applied.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE, since the migration is one DDL line.
 * Three things, none of which can be read off the SQL:
 *
 *  1. THAT IT RUNS AGAINST A DATABASE THAT ALREADY CONTAINS DATA. A
 *     one-line `DROP CONSTRAINT` is only obviously safe once you have
 *     confirmed the thing it names exists under exactly that auto-generated
 *     name -- which migration 0016 chose, not this one -- and that nothing
 *     else is keyed on it. `resumes.id` is referenced by `job_matches`,
 *     `searches`, `user_job_statuses`, `search_results` and `handoffs`, so
 *     the fixture carries real dependent rows rather than bare resumes.
 *  2. THAT THE NEW BEHAVIOR IS REAL. Two rows with the same
 *     (user_id, resume_hash) must now insert, and -- the case the
 *     application actually performs -- an in-place UPDATE of one resume's
 *     text into another of the SAME user's text must now succeed where the
 *     constraint previously rejected it outright.
 *  3. THAT NOTHING ELSE WAS LOOSENED. `resume_hash` stays NOT NULL, the
 *     primary key stays, and the OTHER unique constraints in this schema
 *     (notably `job_matches(resume_id, job_id)`, which `ON CONFLICT`
 *     targets at runtime) are untouched. A `DROP CONSTRAINT` typo that hit
 *     a different constraint would still leave every assertion about
 *     duplicates passing.
 */

const MIGRATION_UNDER_TEST = "0019_drop_resume_hash_unique.sql";

/** The exact constraint name migration 0016 generated and 0019 drops. */
const CONSTRAINT_NAME = "resumes_user_id_resume_hash_unique";

/** A real per-user id, of the shape identity.ts's UUID_RE accepts. */
const REAL_USER_ID = "44444444-4444-4444-8444-444444444444";

let db: Client;
let teardown: () => Promise<void>;
/** Whether the constraint existed BEFORE the migration ran -- captured in
 * setup, because afterwards it is unobservable. Without it, "the
 * constraint is gone" would also pass against a migration that dropped
 * nothing because 0016 had never created it under this name. */
let constraintExistedBefore = false;

async function constraintExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ conname: string }>(
    `select conname from pg_constraint
       where conrelid = 'resumes'::regclass and conname = $1`,
    [name],
  );
  return rows.length === 1;
}

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0019_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so adding 0020 later doesn't silently turn this
  // file into "apply nothing, then apply 0019 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0018_magic_link_tokens.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  // A DATABASE THAT ALREADY CONTAINS DATA, with the whole FK chain a real
  // one has: source descriptor -> jobs -> job_matches/user_job_statuses,
  // hanging off resumes owned by two different users.
  await db.query(
    `insert into source_descriptors (id, display_name) values ('usajobs', 'USAJOBS')
       on conflict (id) do nothing`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company, link_to_apply, posted_at)
     values
       ('job-1', 'ext-1', 'usajobs', 'A job', 'd', 'Co', 'https://example.com/1', TIMESTAMP '2026-01-01 00:00:00'),
       ('job-2', 'ext-2', 'usajobs', 'B job', 'd', 'Co', 'https://example.com/2', TIMESTAMP '2026-01-01 00:00:00')`,
  );
  await db.query(`insert into users (id) values ($1) on conflict (id) do nothing`, [REAL_USER_ID]);
  // Note every (user_id, resume_hash) pair here is DISTINCT: it has to be,
  // because the constraint is still in force until 0019 itself drops it.
  // That is the exact state a real database is in before this migration.
  await db.query(
    `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname, suggested_titles) values
       ('resume-a', $1, 'real user resume A', 'hash-a', 'Resume 1', '["Backend Engineer"]'::jsonb),
       ('resume-b', $1, 'real user resume B', 'hash-b', 'Resume 2', null),
       ('resume-legacy', $2, 'legacy user resume', 'hash-a', 'Resume 1', null)`,
    [REAL_USER_ID, LEGACY_USER_ID],
  );
  // `resume-legacy` deliberately shares `hash-a` with `resume-a`: the
  // constraint being dropped is PER-USER (ticket b2f9dfd), so this is a
  // legal pre-existing row and proves the fixture is exercising the
  // composite key rather than a global one.
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale) values
       ('jm-1', 'resume-a', 'job-1', 88, 'strong match'),
       ('jm-2', 'resume-a', 'job-2', 41, 'weak match')`,
  );
  await db.query(
    `insert into searches (id, resume_id, searched_at, status, is_estimate)
     values ('search-1', 'resume-a', TIMESTAMP '2026-02-01 00:00:00', 'complete', false)`,
  );
  await db.query(
    `insert into user_job_statuses (id, user_id, job_id, status, resume_id, applied_at)
     values ('ujs-1', $1, 'job-1', 'applied', 'resume-a', TIMESTAMP '2026-02-02 00:00:00')`,
    [REAL_USER_ID],
  );

  constraintExistedBefore = await constraintExists(CONSTRAINT_NAME);

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0019 — resumes stop being content-addressed", () => {
  it("applies cleanly against a database that already contains resumes and their dependent rows", async () => {
    // The fixture above is the assertion: `applyMigrationInTransaction`
    // throws (and fails this whole file's setup) if any statement rejects,
    // and it ran with real resumes, job_matches, searches and
    // user_job_statuses rows present. This test states that explicitly so
    // the "runs against existing data" acceptance criterion is a named,
    // visible result rather than an implicit side effect of setup.
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from resumes",
    );
    expect(rows[0]?.count).toBe("3");
  });

  it("the constraint it drops really existed beforehand, under exactly that name", () => {
    // Guards against the silent-no-op reading of the next test: if
    // migration 0016's auto-generated name ever drifted, "the constraint is
    // gone" would pass for the wrong reason. A migration file necessarily
    // hardcodes the name as a raw SQL literal, so this is the one place
    // that literal is checked against the live schema.
    expect(constraintExistedBefore).toBe(true);
    const sql = loadMigrationStatements(MIGRATION_UNDER_TEST).join("\n");
    expect(sql).toContain(CONSTRAINT_NAME);
  });

  it("no longer enforces unique(user_id, resume_hash) — the SAME user can hold two rows with identical text", async () => {
    // THE POINT OF THE WHOLE MIGRATION. Before it, this insert raised a
    // unique violation, which is what surfaced to users as "I edited
    // Resume 1 and it became Resume 2" and as a 409 naming a resume they
    // never created.
    await expect(
      db.query(
        `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
         values ('resume-a-twin', $1, 'real user resume A', 'hash-a', 'Resume 3')`,
        [REAL_USER_ID],
      ),
    ).resolves.not.toThrow();

    const { rows } = await db.query<{ id: string }>(
      "select id from resumes where user_id = $1 and resume_hash = 'hash-a' order by id",
      [REAL_USER_ID],
    );
    expect(rows.map((r) => r.id)).toEqual(["resume-a", "resume-a-twin"]);
  });

  it("allows an in-place UPDATE into another of the same user's text — the write the app now performs", async () => {
    // `PUT /resumes/:id/text` (routes/resumes.ts) does exactly this:
    // rewrite one row's text and hash, which under the old constraint was
    // rejected outright whenever the new text matched a sibling resume.
    // Asserting the INSERT above alone would miss this: an UPDATE is a
    // different statement hitting the same index.
    await expect(
      db.query(
        `update resumes set resume_text = 'real user resume A', resume_hash = 'hash-a'
           where id = 'resume-b'`,
      ),
    ).resolves.not.toThrow();

    const { rows } = await db.query<{ resume_nickname: string }>(
      "select resume_nickname from resumes where id = 'resume-b'",
    );
    // The nickname is untouched by a text change at the DB level too --
    // nothing in this schema recomputes it.
    expect(rows[0]?.resume_nickname).toBe("Resume 2");
  });

  it("leaves every pre-existing resume row exactly as it was", async () => {
    // Dropping a constraint must not rewrite data. Checked column by
    // column rather than by row count, because a count would survive a
    // migration that (say) null-ed out every hash.
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      resume_text: string;
      resume_hash: string;
      resume_nickname: string;
      suggested_titles: string[] | null;
    }>(
      `select id, user_id, resume_text, resume_hash, resume_nickname, suggested_titles
         from resumes where id in ('resume-a', 'resume-legacy') order by id`,
    );
    expect(rows).toEqual([
      {
        id: "resume-a",
        user_id: REAL_USER_ID,
        resume_text: "real user resume A",
        resume_hash: "hash-a",
        resume_nickname: "Resume 1",
        suggested_titles: ["Backend Engineer"],
      },
      {
        id: "resume-legacy",
        user_id: LEGACY_USER_ID,
        resume_text: "legacy user resume",
        resume_hash: "hash-a",
        resume_nickname: "Resume 1",
        suggested_titles: null,
      },
    ]);
  });

  it("leaves the rows that REFERENCE those resumes intact — scores, searches and job statuses", async () => {
    const matches = await db.query<{ id: string; resume_id: string; match_score: number }>(
      "select id, resume_id, match_score from job_matches order by id",
    );
    expect(matches.rows).toEqual([
      { id: "jm-1", resume_id: "resume-a", match_score: 88 },
      { id: "jm-2", resume_id: "resume-a", match_score: 41 },
    ]);

    const searches = await db.query<{ id: string; resume_id: string }>(
      "select id, resume_id from searches",
    );
    expect(searches.rows).toEqual([{ id: "search-1", resume_id: "resume-a" }]);

    // The one this ticket is explicitly forbidden from touching -- see
    // schema.ts's long comment on `user_job_statuses`'s key.
    const statuses = await db.query<{ id: string; status: string; applied_at: Date | null }>(
      "select id, status, applied_at from user_job_statuses",
    );
    expect(statuses.rows).toEqual([
      { id: "ujs-1", status: "applied", applied_at: new Date("2026-02-02T00:00:00Z") },
    ]);
  });

  it("keeps resume_hash NOT NULL and resumes.id a primary key — only the UNIQUE index was dropped", async () => {
    await expect(
      db.query(
        `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
         values ('resume-no-hash', $1, 'text', null, 'Resume 9')`,
        [REAL_USER_ID],
      ),
    ).rejects.toThrow(/null value|not-null/i);

    await expect(
      db.query(
        `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
         values ('resume-a', $1, 'text', 'hash-dup-pk', 'Resume 9')`,
        [REAL_USER_ID],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("leaves OTHER unique constraints in place — notably job_matches(resume_id, job_id)", async () => {
    // `runDemoMatch` targets this key with `ON CONFLICT` at runtime, so if
    // a stray drop had taken it out, that upsert would start raising
    // SQLSTATE 42P10 -- the exact failure mode this migration had to avoid
    // creating for `resumes` (see matching/pipeline.ts's
    // `getOrCreateResumeId`).
    await expect(
      db.query(
        `insert into job_matches (id, resume_id, job_id, match_score, rationale)
         values ('jm-dup', 'resume-a', 'job-1', 50, 'duplicate')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    const { rows } = await db.query<{ conname: string }>(
      `select conname from pg_constraint
         where conrelid = 'resumes'::regclass and contype = 'u'`,
    );
    // And `resumes` now has NO unique constraints at all, which is what
    // schema.ts's empty table-extras callback says out loud.
    expect(rows).toEqual([]);
  });
});
