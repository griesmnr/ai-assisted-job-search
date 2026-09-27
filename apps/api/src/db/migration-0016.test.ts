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
 * Migration 0016 (ticket b2f9dfd, epic 2b9e9dd): scopes `resumes` to a
 * real per-user identity -- adds `resumes.user_id NOT NULL`, and moves the
 * resume-text uniqueness constraint from global (`resume_hash` alone) to
 * composite (`user_id, resume_hash`).
 *
 * Same pattern as migration-0013's own test: a real, disposable database
 * with PRE-EXISTING rows inserted the way a real multi-run database
 * actually has them (no `user_id` -- the column does not exist yet at
 * insert time, since this is the FIRST migration that adds it), and only
 * THEN 0016 applied.
 *
 * WHAT IS ACTUALLY WORTH TESTING HERE, and why it cannot be read off the
 * SQL. drizzle-kit generated a bare `ADD COLUMN "user_id" text NOT NULL`,
 * which cannot run at all against a table with rows in it. The hand-written
 * backfill that replaces it creates one well-known "legacy" user
 * (LEGACY_USER_ID, schema.ts's own exported constant) and points every
 * pre-existing resume at it -- "does the backfill actually reach every
 * pre-existing row, and does the new composite constraint actually behave
 * per-user afterward" is answered by running it against real rows, not by
 * reading the generated SQL.
 */

const MIGRATION_UNDER_TEST = "0016_overjoyed_human_cannonball.sql";

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0016_test");
  db = empty.client;
  teardown = empty.teardown;

  // Every migration BEFORE the one under test, derived from the directory
  // rather than hardcoded, so adding 0017 later doesn't silently turn this
  // file into "apply nothing, then apply 0016 out of order".
  const priorMigrations = allMigrationFiles().filter((f) => f < MIGRATION_UNDER_TEST);
  expect(priorMigrations).toContain("0015_famous_doctor_octopus.sql");
  for (const file of priorMigrations) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  // PRE-EXISTING resumes, inserted the way a real database actually has
  // them at this point in migration history: no `user_id` column exists
  // yet at all (0015 only created the EMPTY `users` table; it never
  // touched `resumes`). Two rows sharing a hash is impossible here
  // (`resume_hash` is still globally UNIQUE at this point) -- the
  // per-user composite constraint doesn't exist until 0016 itself.
  await db.query(
    `insert into resumes (id, resume_text, resume_hash, resume_nickname) values
       ('legacy-r1', 'legacy resume one', 'legacy-hash-1', 'Resume 1'),
       ('legacy-r2', 'legacy resume two', 'legacy-hash-2', 'Resume 2')`,
  );

  await applyMigrationInTransaction(db, MIGRATION_UNDER_TEST);
});

afterAll(async () => teardown?.());

describe("migration 0016 — resumes becomes per-user", () => {
  // Review fix (M2): the migration file necessarily hardcodes this id as a
  // raw SQL string literal (a migration is a frozen historical record, not
  // code that can import a constant) -- this is the one place that literal
  // and schema.ts's own `LEGACY_USER_ID` export are checked against each
  // other, so a future edit to either can't silently drift out of sync
  // with the other while every other assertion in this file keeps passing
  // (they'd all still pass against whatever value the migration actually
  // used, even if it stopped matching the constant the rest of the
  // codebase imports).
  it("the migration file's own hardcoded id matches schema.ts's LEGACY_USER_ID constant", () => {
    const sql = loadMigrationStatements(MIGRATION_UNDER_TEST).join("\n");
    expect(sql).toContain(LEGACY_USER_ID);
  });

  it("creates the well-known legacy user row", async () => {
    const { rows } = await db.query<{ id: string }>("select id from users where id = $1", [
      LEGACY_USER_ID,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("backfills every pre-existing resume row to the legacy user, not left NULL", async () => {
    const { rows } = await db.query<{ id: string; user_id: string }>(
      "select id, user_id from resumes order by id",
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === LEGACY_USER_ID)).toBe(true);
  });

  it("enforces NOT NULL on user_id for a new insert going forward", async () => {
    await expect(
      db.query(
        `insert into resumes (id, resume_text, resume_hash, resume_nickname)
         values ('no-user-id', 'text', 'hash-no-user', 'Resume X')`,
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it("no longer enforces a GLOBAL unique constraint on resume_hash alone -- two different users can share a hash", async () => {
    await db.query(
      `insert into users (id) values ('11111111-1111-1111-1111-111111111111'),
                                      ('22222222-2222-2222-2222-222222222222')
       on conflict (id) do nothing`,
    );

    await db.query(
      `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
       values ('shared-hash-a', '11111111-1111-1111-1111-111111111111', 'shared text', 'shared-hash', 'Resume 1')`,
    );

    // Same hash, DIFFERENT user -- must succeed now.
    await expect(
      db.query(
        `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
         values ('shared-hash-b', '22222222-2222-2222-2222-222222222222', 'shared text', 'shared-hash', 'Resume 1')`,
      ),
    ).resolves.not.toThrow();

    const { rows } = await db.query("select id from resumes where resume_hash = 'shared-hash'");
    expect(rows).toHaveLength(2);
  });

  it("DOES still enforce uniqueness for the SAME user, SAME hash", async () => {
    await expect(
      db.query(
        `insert into resumes (id, user_id, resume_text, resume_hash, resume_nickname)
         values ('shared-hash-a-dup', '11111111-1111-1111-1111-111111111111', 'shared text again', 'shared-hash', 'Resume 2')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
