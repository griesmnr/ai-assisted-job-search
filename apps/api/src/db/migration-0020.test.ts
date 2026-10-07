import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  allMigrationFiles,
  applyMigrationInTransaction,
  createEmptyTestDatabase,
  loadMigrationStatements,
} from "./test-db.js";
import { loadEnvFile } from "../load-env.js";

loadEnvFile();

/**
 * Migration 0020 (ticket 82ae975): backfills `suggested_titles = '[]'` rows
 * to `NULL`.
 *
 * WHY THIS IS WORTH A DEDICATED TEST, since the migration is one `UPDATE`
 * statement. The thing actually worth proving is SELECTIVITY: that it
 * rewrites exactly the `[]` rows and leaves every other shape -- a real
 * populated array, and a row already `null` -- completely untouched. A
 * migration that accidentally null-ed every row, or missed `[]` rows
 * entirely, would both "apply cleanly" with no error, so "ran without
 * throwing" on its own would not catch either failure mode.
 *
 * Same fixture pattern as migration-0019.test.ts: a real, disposable
 * database with every prior migration applied and PRE-EXISTING rows
 * inserted the way a real, already-running database actually holds them,
 * including a dependent `job_matches` row so the migration is proven not to
 * disturb anything that references `resumes.id`.
 */

const MIGRATION_UNDER_TEST = "0020_backfill_failed_title_inference_to_null.sql";

/** A real per-user id, of the shape identity.ts's UUID_RE accepts. */
const REAL_USER_ID = "55555555-5555-5555-8555-555555555555";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0020_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so a future 0021 doesn't silently turn this file
  // into "apply nothing, then apply 0020 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0019_drop_resume_hash_unique.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  await db.query(
    `insert into source_descriptors (id, display_name) values ('usajobs', 'USAJOBS')
       on conflict (id) do nothing`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company, link_to_apply, posted_at)
     values ('job-1', 'ext-1', 'usajobs', 'A job', 'd', 'Co', 'https://example.com/1', TIMESTAMP '2026-01-01 00:00:00')`,
  );
  await db.query(`insert into users (id) values ($1)`, [REAL_USER_ID]);

  // A DATABASE THAT ALREADY CONTAINS DATA, carrying all three real shapes
  // `suggested_titles` can hold today, plus a row some other row's FK
  // points at so the migration is proven to leave dependents alone.
  await db.query(
    `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname, suggested_titles) values
       ('resume-failed-1', $1, 'resume whose inference failed, pre-fix', 'hash-1', 'Resume 1', '[]'::jsonb),
       ('resume-failed-2', $1, 'a second one', 'hash-2', 'Resume 2', '[]'::jsonb),
       ('resume-never-inferred', $1, 'never submitted for inference', 'hash-3', 'Resume 3', null),
       ('resume-real-titles', $1, 'inference succeeded here', 'hash-4', 'Resume 4', '["Backend Engineer", "Cloud Engineer"]'::jsonb)`,
    [REAL_USER_ID],
  );
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale)
       values ('jm-1', 'resume-failed-1', 'job-1', 72, 'a match that must survive untouched')`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0020 — backfills [] suggested_titles to null", () => {
  it("applies cleanly against a database that already contains resumes and a dependent job_matches row", async () => {
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from resumes",
    );
    expect(rows[0]?.count).toBe("4");
  });

  it("rewrites every pre-existing `[]` row to null", async () => {
    const { rows } = await db.query<{ id: string; suggested_titles: string[] | null }>(
      "select id, suggested_titles from resumes where id in ('resume-failed-1', 'resume-failed-2') order by id",
    );
    expect(rows).toEqual([
      { id: "resume-failed-1", suggested_titles: null },
      { id: "resume-failed-2", suggested_titles: null },
    ]);
  });

  it("leaves a row already null exactly as it was — not rewritten to [] or anything else", async () => {
    const { rows } = await db.query<{ suggested_titles: string[] | null }>(
      "select suggested_titles from resumes where id = 'resume-never-inferred'",
    );
    expect(rows[0]?.suggested_titles).toBeNull();
  });

  it("leaves a genuinely populated suggested_titles array completely untouched", async () => {
    const { rows } = await db.query<{ suggested_titles: string[] | null }>(
      "select suggested_titles from resumes where id = 'resume-real-titles'",
    );
    expect(rows[0]?.suggested_titles).toEqual(["Backend Engineer", "Cloud Engineer"]);
  });

  it("leaves rows that REFERENCE a backfilled resume intact — scores are not cascaded or deleted", async () => {
    const { rows } = await db.query<{ id: string; resume_id: string; match_score: number }>(
      "select id, resume_id, match_score from job_matches",
    );
    expect(rows).toEqual([{ id: "jm-1", resume_id: "resume-failed-1", match_score: 72 }]);
  });

  it("other columns on a backfilled row (text, hash, nickname) are untouched — only suggested_titles changes", async () => {
    const { rows } = await db.query<{
      resume_text: string;
      resume_hash: string;
      resume_nickname: string;
    }>(
      "select resume_text, resume_hash, resume_nickname from resumes where id = 'resume-failed-1'",
    );
    expect(rows[0]).toEqual({
      resume_text: "resume whose inference failed, pre-fix",
      resume_hash: "hash-1",
      resume_nickname: "Resume 1",
    });
  });
});
