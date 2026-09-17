import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  applyMigrationInTransaction,
  createEmptyTestDatabase,
  loadMigrationStatements,
} from "./test-db.js";
import { loadEnvFile } from "../load-env.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

/**
 * Migration 0010 (ticket 38a7598): adds `resumes.created_at` and
 * `resumes.resume_nickname`, and backfills every PRE-EXISTING resume row
 * with a real, distinct nickname ("Resume 1", "Resume 2", ...) ordered by
 * `created_at` (tiebroken by `id`, since every existing row gets backfilled
 * to the SAME `created_at` instant by the earlier `ADD COLUMN ... DEFAULT
 * now()` statement in this same migration).
 *
 * Same pattern as migration-0004.test.ts/migration-0006.test.ts: a real,
 * disposable Postgres database, pre-existing rows inserted the way a real
 * multi-run database could plausibly have them (no `resume_nickname`, since
 * that column doesn't exist yet at insert time), and only THEN migration
 * 0010 applied — "does the backfill work against data" answered by running
 * it against data, not by reading the SQL.
 */

const PRE_0010_MIGRATIONS = [
  "0000_jazzy_zarda.sql",
  "0001_married_oracle.sql",
  "0002_closed_captain_stacy.sql",
  "0003_fresh_gabe_jones.sql",
  "0004_fancy_richard_fisk.sql",
  "0005_melted_cammi.sql",
  "0006_funny_maestro.sql",
  "0007_sharp_sunspot.sql",
  "0008_chilly_havok.sql",
  "0009_curvy_blue_marvel.sql",
];

const drizzleDir = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));

let db: Client;
let teardown: () => Promise<void>;

beforeAll(async () => {
  const empty = await createEmptyTestDatabase("migration_0010_test");
  db = empty.client;
  teardown = empty.teardown;

  for (const file of PRE_0010_MIGRATIONS) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }

  // Three pre-existing rows, inserted in a deliberately SHUFFLED order
  // relative to their intended nickname numbering -- a passing test then
  // proves the migration's own ORDER BY is doing the work, not insertion
  // order happening to already match it. `resume_hash` is required NOT
  // NULL as of migration 0004; `resume_nickname`/`created_at` don't exist
  // yet at this point, matching what a real pre-38a7598 database's rows
  // actually look like.
  await db.query(
    `insert into resumes (id, resume_text, resume_hash) values
     ('r-third', 'third resume text', 'hash-third'),
     ('r-first', 'first resume text', 'hash-first'),
     ('r-second', 'second resume text', 'hash-second')`,
  );

  await applyMigrationInTransaction(db, "0010_remarkable_gressill.sql");
});

afterAll(async () => {
  await teardown?.();
});

describe("migration 0010 (ticket 38a7598)", () => {
  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.some((e) => e.idx === 10 && e.tag.startsWith("0010_"))).toBe(true);
  });

  it("backfills every pre-existing row with a real, distinct nickname, NOT a repeated static string", async () => {
    const rows = (
      await db.query("select id, resume_nickname from resumes order by resume_nickname")
    ).rows as Array<{ id: string; resume_nickname: string }>;
    expect(rows).toHaveLength(3);

    const nicknames = rows.map((r) => r.resume_nickname);
    // Distinct: a Set collapsing duplicates would shrink this.
    expect(new Set(nicknames).size).toBe(3);
    // Real values, not blank/null.
    for (const nickname of nicknames) {
      expect(nickname).toMatch(/^Resume \d+$/);
    }
  });

  it("numbers pre-existing rows 1..N in creation order, not insertion order", async () => {
    // Every row got the SAME created_at (the ADD COLUMN ... DEFAULT now()
    // statement evaluates once for the whole ALTER), so the tiebreak is
    // `id` -- alphabetically: r-first, r-second, r-third.
    const rows = (
      await db.query("select id, resume_nickname, created_at from resumes order by created_at, id")
    ).rows as Array<{ id: string; resume_nickname: string; created_at: Date }>;
    expect(rows.map((r) => r.id)).toEqual(["r-first", "r-second", "r-third"]);
    expect(rows.map((r) => r.resume_nickname)).toEqual(["Resume 1", "Resume 2", "Resume 3"]);

    // And every row's created_at really is the same instant (the single
    // ALTER-time evaluation), confirming the tiebreak is doing real work
    // rather than happening to agree with a coincidentally-distinct
    // created_at per row.
    const timestamps = new Set(rows.map((r) => r.created_at.getTime()));
    expect(timestamps.size).toBe(1);
  });

  it("resume_nickname and created_at are both NOT NULL after the migration", async () => {
    const columns = (
      await db.query(
        `select column_name, is_nullable from information_schema.columns
         where table_name = 'resumes' and column_name in ('resume_nickname', 'created_at')`,
      )
    ).rows as Array<{ column_name: string; is_nullable: "YES" | "NO" }>;
    expect(columns).toHaveLength(2);
    for (const column of columns) {
      expect(column.is_nullable).toBe("NO");
    }
  });

  it("rejects a real duplicate insert with no resume_nickname, proving the NOT NULL constraint is actually enforced", async () => {
    const rejected = await db
      .query(
        `insert into resumes (id, resume_text, resume_hash) values ('r-fourth', 'fourth', 'hash-fourth')`,
      )
      .catch((e: unknown) => e);
    expect((rejected as { code?: string }).code).toBe("23502"); // not_null_violation
  });
});
