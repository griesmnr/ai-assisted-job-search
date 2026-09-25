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
 * Migration 0014 (ticket 88f11d7): adds `searches.is_estimate boolean NOT
 * NULL DEFAULT false`, then backfills every PRE-EXISTING row using
 * `search_results`/`job_matches`/`job_match_failures` as the best evidence
 * of which historical rows were real vs. merely estimated — see the
 * migration file's own comment, and schema.ts's `isEstimate` doc comment's
 * "HISTORICAL ROWS" section, for why the default alone is wrong for rows
 * that predate the column (review round 2, N2: an actual sandbox check at
 * review time found 3 of 5 resumes would otherwise be wrongly, permanently
 * locked).
 *
 * Same pattern as migration-0013's own test: a real, disposable database
 * with PRE-EXISTING rows inserted the way a real multi-run database
 * actually has them (no `is_estimate` — the column does not exist yet at
 * insert time), and only THEN 0014 applied. "Does the backfill do the
 * right thing to real rows" is answered by running it against real rows,
 * not by reading the SQL.
 */

const MIGRATION_UNDER_TEST = "0014_big_thunderball.sql";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0014_test");
  db = empty.client;
  teardown = empty.teardown;

  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0013_scope_job_match_failures_to_search.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  await db.query(`insert into source_descriptors (id, display_name) values ('usajobs', 'USAJOBS')`);
  await db.query(
    `insert into resumes (id, resume_text, resume_hash, resume_nickname)
     values ('r-real', 'a real resume', 'hash-real', 'Resume Real'),
            ('r-failed', 'a resume with a failed attempt', 'hash-failed', 'Resume Failed'),
            ('r-estimate', 'a resume only ever estimated', 'hash-estimate', 'Resume Estimate'),
            ('r-other', 'a different resume entirely', 'hash-other', 'Resume Other')`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company,
                       link_to_apply, posted_at)
     values ('j-real', 'ext-real', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/real', now()),
            ('j-failed', 'ext-failed', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/failed', now()),
            ('j-estimate', 'ext-estimate', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/estimate', now()),
            ('j-other', 'ext-other', 'usajobs', 'Engineer', 'desc', 'Co',
             'https://example.com/other', now())`,
  );

  // s-real: linked a job that WAS scored for the same resume -- real
  // evidence, must stay is_estimate = false after the backfill.
  //
  // s-failed: linked no job that ever scored, but has its own
  // job_match_failures row -- also real evidence (a genuine attempt that
  // failed), must also stay is_estimate = false.
  //
  // s-estimate: linked a job, but nothing ever scored OR failed for it --
  // no trace at all, must become is_estimate = true by the backfill.
  //
  // s-cross-resume: linked j-other, which WAS scored -- but for a
  // DIFFERENT resume (r-other), never for r-estimate. Proves the backfill's
  // join is scoped by resume, not just "was this job ever scored by
  // anyone" -- must ALSO become is_estimate = true.
  await db.query(
    `insert into searches (id, resume_id, searched_at, status)
     values ('s-real', 'r-real', now() - interval '3 hours', 'complete'),
            ('s-failed', 'r-failed', now() - interval '2 hours', 'complete'),
            ('s-estimate', 'r-estimate', now() - interval '1 hour', 'complete'),
            ('s-cross-resume', 'r-estimate', now(), 'complete')`,
  );
  await db.query(
    `insert into search_results (id, search_id, job_id)
     values ('sr-real', 's-real', 'j-real'),
            ('sr-estimate', 's-estimate', 'j-estimate'),
            ('sr-cross', 's-cross-resume', 'j-other')`,
  );
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale)
     values ('jm-real', 'r-real', 'j-real', 80, 'good fit'),
            ('jm-other', 'r-other', 'j-other', 70, 'good fit for the OTHER resume')`,
  );
  await db.query(
    `insert into job_match_failures (id, search_id, resume_id, job_id, kind, error_message, attempts, failed_at)
     values ('f-failed', 's-failed', 'r-failed', 'j-failed', 'rate-limited', 'gave up', 4, now())`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0014 — is_estimate backfill for pre-existing rows", () => {
  it("keeps a real search (linked a job that scored for the SAME resume) is_estimate = false", async () => {
    const { rows } = await db.query<{ is_estimate: boolean }>(
      "select is_estimate from searches where id = 's-real'",
    );
    expect(rows[0]?.is_estimate).toBe(false);
  });

  it("keeps a real search (no scored job, but a genuine job_match_failures attempt) is_estimate = false", async () => {
    const { rows } = await db.query<{ is_estimate: boolean }>(
      "select is_estimate from searches where id = 's-failed'",
    );
    expect(rows[0]?.is_estimate).toBe(false);
  });

  it("backfills a search with no scoring trace at all to is_estimate = true", async () => {
    const { rows } = await db.query<{ is_estimate: boolean }>(
      "select is_estimate from searches where id = 's-estimate'",
    );
    expect(rows[0]?.is_estimate).toBe(true);
  });

  it("scopes the evidence by RESUME, not just 'was this job ever scored by anyone' -- a job scored for a different resume doesn't count", async () => {
    const { rows } = await db.query<{ is_estimate: boolean }>(
      "select is_estimate from searches where id = 's-cross-resume'",
    );
    expect(rows[0]?.is_estimate).toBe(true);
  });

  it("a genuinely NEW row (inserted after the migration, no isEstimate given) still defaults to false -- the column default is unaffected by the backfill", async () => {
    await db.query(
      `insert into searches (id, resume_id, searched_at, status)
       values ('s-new', 'r-real', now(), 'running')`,
    );
    const { rows } = await db.query<{ is_estimate: boolean }>(
      "select is_estimate from searches where id = 's-new'",
    );
    expect(rows[0]?.is_estimate).toBe(false);
  });
});
