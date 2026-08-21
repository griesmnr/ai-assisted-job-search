import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

/**
 * Migration 0004 (job_matches.strengths/gaps, job_matches' (resume_id,
 * job_id) unique constraint, resumes.resume_hash + its unique constraint)
 * was twice reviewed and twice approved while the shared dev database had
 * zero rows in `resumes` — so its backfill step had never actually run
 * against data. It shipped broken on two separate counts:
 *
 *   1. `"resume_text"::bytea` doesn't reinterpret text as UTF-8 bytes — it
 *      parses the text as bytea escape-format input. Most resumes hashed
 *      "correctly" by accident; one containing a valid octal escape
 *      sequence (`\101`, `\102`, ...) — which is just "a backslash
 *      followed by three digits", i.e. any regex, Windows path, or LaTeX
 *      snippet — hashed to something Node's crypto (used everywhere else
 *      resume_hash is computed/looked-up) can never reproduce. That's not
 *      a crash; it's silent data corruption that makes
 *      getOrCreateResumeId's ON CONFLICT (resume_hash) never fire, so it
 *      re-inserts a "new" resume — and re-bills every job — on every run.
 *   2. `resume_hash` was backfilled and then immediately made UNIQUE with
 *      no dedupe step in between. Nothing enforced resume_text uniqueness
 *      before this migration (that's the entire reason it's being added)
 *      — a database with two identical resumes fails outright on
 *      `could not create unique index`.
 *
 * This test is the actual point of the whole rewrite: it creates a real,
 * disposable Postgres database, applies 0000-0003, inserts rows a real
 * multi-run database could plausibly have (a resume with backslashes, a
 * duplicate resume pair each independently scored against the same job),
 * and only THEN applies 0004 — so "does the migration work against data"
 * is answered by running it against data, not by reading the SQL.
 */

const {
  POSTGRES_USER = "jobsearch",
  POSTGRES_PASSWORD = "",
  POSTGRES_HOST = "postgres",
  POSTGRES_PORT = "5432",
  POSTGRES_DB = "jobsearch",
} = process.env;

// Unique per test run so parallel/repeated runs never collide.
const TEST_DB = `migration_0004_test_${randomUUID().replace(/-/g, "")}`;

function connectTo(database: string): Client {
  return new Client({
    host: POSTGRES_HOST,
    port: Number(POSTGRES_PORT),
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database,
  });
}

/** drizzle-kit's migration files separate statements with this exact
 * marker (see drizzle/0000_jazzy_zarda.sql etc.) — splitting on it and
 * executing each piece individually is what `drizzle-kit migrate` itself
 * does under the hood. */
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function loadMigrationStatements(filename: string): string[] {
  const path = fileURLToPath(new URL(`../../drizzle/${filename}`, import.meta.url));
  const sql = readFileSync(path, "utf8");
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const PRE_0004_MIGRATIONS = [
  "0000_jazzy_zarda.sql",
  "0001_married_oracle.sql",
  "0002_closed_captain_stacy.sql",
  "0003_fresh_gabe_jones.sql",
];

let admin: Client;
let db: Client;

beforeAll(async () => {
  admin = connectTo(POSTGRES_DB);
  await admin.connect();
  await admin.query(`CREATE DATABASE "${TEST_DB}"`);

  db = connectTo(TEST_DB);
  await db.connect();
  for (const file of PRE_0004_MIGRATIONS) {
    for (const statement of loadMigrationStatements(file)) {
      await db.query(statement);
    }
  }
});

afterAll(async () => {
  await db?.end();
  // A just-created, empty-of-connections database can be dropped
  // immediately — nothing else ever connects to TEST_DB.
  await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  await admin.end();
});

describe("migration 0004 applied to a table with pre-existing rows (ticket 620ca30 review finding B1)", () => {
  it("backfills a hash matching Node's sha256 even for resume text containing backslashes, and merges duplicate resumes without failing", async () => {
    await db.query(
      `insert into source_descriptors (id, display_name) values ('greenhouse', 'Greenhouse')`,
    );
    await db.query(
      `insert into jobs (id, external_id, data_source, title, description, company, link_to_apply, posted_at)
       values ('job-1', 'ext-1', 'greenhouse', 'T', 'D', 'C', 'https://x', '2026-01-01')`,
    );

    // Contains backslash-digit sequences that are valid bytea octal
    // escapes (\101 = 'A') — the exact shape that made `::bytea` silently
    // produce a hash Node can never reproduce, rather than erroring.
    // Also a bare Windows path and a regex, since both are routine in a
    // real resume/cover-letter and both contain backslashes.
    const backslashResume =
      "Skills: regex \\101 and \\\\d+. Path C:\\Users\\nicole\\resume.docx. LaTeX: \\section{Experience}";

    // Nothing prevented two identical resumes before this migration —
    // that's the entire reason resume_hash is being added — so a
    // real database can plausibly have this.
    const dupResumeText = "duplicate resume text, scored independently by two rows";

    await db.query(`insert into resumes (id, resume_text) values ($1, $2)`, [
      "backslash-resume",
      backslashResume,
    ]);
    await db.query(`insert into resumes (id, resume_text) values ($1, $2), ($3, $2)`, [
      "dup-a",
      dupResumeText,
      "dup-b",
    ]);

    // dup-a and dup-b were BOTH independently scored against job-1 before
    // anyone knew they were the same resume — merging them onto one
    // canonical row must not silently drop this data OR crash on a
    // (resume_id, job_id) collision.
    await db.query(
      `insert into job_matches (id, resume_id, job_id, match_score, rationale) values ('jm-a', 'dup-a', 'job-1', 80, 'r-a')`,
    );
    await db.query(
      `insert into job_matches (id, resume_id, job_id, match_score, rationale) values ('jm-b', 'dup-b', 'job-1', 60, 'r-b')`,
    );
    // dup-b also has a `searches` row — must be repointed, not orphaned.
    await db.query(
      `insert into searches (id, resume_id, searched_at) values ('search-b', 'dup-b', '2026-01-01')`,
    );

    for (const statement of loadMigrationStatements("0004_fancy_richard_fisk.sql")) {
      await db.query(statement);
    }

    // The backfilled hash matches Node's sha256 of the SAME UTF-8 bytes,
    // computed here (not hardcoded) so this test can't drift from
    // whatever getOrCreateResumeId in demo-match.ts actually does.
    const resumes = (await db.query("select id, resume_text, resume_hash from resumes order by id"))
      .rows as Array<{ id: string; resume_text: string; resume_hash: string }>;
    for (const row of resumes) {
      const expected = createHash("sha256").update(row.resume_text, "utf8").digest("hex");
      expect(row.resume_hash).toBe(expected);
    }

    // The duplicate pair merged onto exactly one surviving row.
    const dupHash = createHash("sha256").update(dupResumeText, "utf8").digest("hex");
    const survivors = resumes.filter((r) => r.resume_hash === dupHash);
    expect(survivors).toHaveLength(1);
    const survivingId = survivors[0]!.id;
    expect(["dup-a", "dup-b"]).toContain(survivingId);

    // Exactly one job_matches row for (survivingId, job-1) — the colliding
    // duplicate was resolved, not left to violate the constraint created
    // moments later in the same migration.
    const matchesForJob = (
      await db.query("select resume_id from job_matches where job_id = 'job-1'")
    ).rows as Array<{ resume_id: string }>;
    expect(matchesForJob).toHaveLength(1);
    expect(matchesForJob[0]!.resume_id).toBe(survivingId);

    // The searches row that pointed at the non-surviving duplicate was
    // repointed, not orphaned or dropped.
    const searchRows = (await db.query("select resume_id from searches where id = 'search-b'"))
      .rows as Array<{ resume_id: string }>;
    expect(searchRows).toHaveLength(1);
    expect(searchRows[0]!.resume_id).toBe(survivingId);

    // Both unique constraints exist and are actually enforced afterward —
    // not just present in the schema, but rejecting a real duplicate.
    const constraints = (
      await db.query(
        `select conname from pg_constraint where conrelid in ('job_matches'::regclass, 'resumes'::regclass) and contype = 'u'`,
      )
    ).rows as Array<{ conname: string }>;
    expect(constraints.map((c) => c.conname).sort()).toEqual(
      ["job_matches_resume_id_job_id_unique", "resumes_resume_hash_unique"].sort(),
    );

    const rejected = await db
      .query(`insert into resumes (id, resume_text, resume_hash) values ('dup-c', $1, $2)`, [
        dupResumeText,
        dupHash,
      ])
      .catch((e: unknown) => e);
    expect((rejected as { code?: string }).code).toBe("23505");
  });
});
