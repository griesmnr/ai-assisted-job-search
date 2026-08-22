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
 * was reviewed and approved three times while the shared dev database had
 * zero rows in `resumes` — so its backfill/dedupe steps had never actually
 * run against data. It shipped broken on three separate counts, found only
 * once someone actually ran it against rows instead of reading the SQL:
 *
 *   1. `"resume_text"::bytea` doesn't reinterpret text as UTF-8 bytes — it
 *      parses the text as bytea escape-format input. A resume containing a
 *      valid octal escape sequence (`\101`, `\102`, ...) — which is just
 *      "a backslash followed by three digits", i.e. any regex, Windows
 *      path, or LaTeX snippet — hashed to something Node's crypto (used
 *      everywhere else resume_hash is computed/looked-up) can never
 *      reproduce. Not a crash; silent data corruption that makes
 *      getOrCreateResumeId's ON CONFLICT (resume_hash) never fire, so it
 *      re-inserts a "new" resume — and re-bills every job — on every run.
 *      Fixed with `convert_to("resume_text", 'UTF8')`.
 *   2. `resume_hash` was backfilled and then immediately made UNIQUE with
 *      no dedupe step. Nothing enforced resume_text uniqueness before this
 *      migration (that's the entire reason it's being added) — a database
 *      with two identical resumes failed outright on
 *      `could not create unique index`. Fixed by merging duplicate resumes
 *      onto one canonical row (MIN(id) per resume_hash) before either
 *      UNIQUE constraint is created.
 *   3. The FIRST dedupe fix still aborted on two shapes: three-plus
 *      duplicate resumes where the canonical one doesn't happen to hold
 *      the job two of the OTHER duplicates collide on (its EXISTS guard
 *      only checked the canonical resume's own job_matches, never the
 *      non-canonical rows against each other — see "scenario A" below),
 *      and a duplicate (resume_id, job_id) pair on a single resume with no
 *      resume duplication involved at all (predates the dedupe pass
 *      entirely — shipped in the ticket's very first job_matches unique
 *      constraint commit — see "scenario C" below). Fixed with a
 *      row_number()-ranked DELETE that dedupes every job_matches row by
 *      (canonical resume, job), not just against the canonical's own
 *      pre-existing rows.
 *
 * This test is the actual point of the whole rewrite: it creates a real,
 * disposable Postgres database, applies 0000-0003, inserts rows a real
 * multi-run database could plausibly have, and only THEN applies 0004,
 * wrapped in BEGIN/COMMIT the same way `drizzle-kit migrate` itself wraps
 * a migration file — so "does the migration work against data" is
 * answered by running it against data, not by reading the SQL.
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

/** `drizzle-kit migrate` wraps a pending migration's statements in one
 * transaction — an abort partway through rolls the whole file back, never
 * leaving the database half-migrated. Applying statements one at a time in
 * autocommit (no BEGIN/COMMIT) would NOT reproduce that: a failure midway
 * would leave whatever ran before it committed. Wrapping here matches
 * production behavior instead of testing a laxer approximation of it. */
async function applyMigrationInTransaction(client: Client, filename: string): Promise<void> {
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

const PRE_0004_MIGRATIONS = [
  "0000_jazzy_zarda.sql",
  "0001_married_oracle.sql",
  "0002_closed_captain_stacy.sql",
  "0003_fresh_gabe_jones.sql",
];

let admin: Client;
let db: Client;

// Fixture text, kept as named constants so every `it` below can look up
// "its own" rows by resume_text without re-declaring the string.

// A valid bytea OCTAL escape (\101 decodes to 'A') embedded in otherwise
// ordinary text — under the old `::bytea` cast this hashed successfully
// but to the WRONG value, silently. Deliberately does NOT also contain a
// bytea-illegal escape sequence (see BACKSLASH_HARD_ERROR_TEXT below) —
// mixed together in one row, the old code's hard crash on the illegal
// sequence would abort the whole backfill UPDATE before the silent-wrong-
// hash row was ever reached, masking exactly the corruption this row
// exists to catch.
const BACKSLASH_SILENT_TEXT = "Skills: regex \\101 and \\\\d+";
// `\U` is not a recognized bytea escape at all — under the old `::bytea`
// cast this made the backfill UPDATE throw outright (a whole different
// failure mode from the silent one above, and worth keeping distinct).
const BACKSLASH_HARD_ERROR_TEXT = "Path C:\\Users\\example\\resume.docx";
// Two duplicate rows, both already scored against the SAME job — the
// "does the merge even happen, and does it not silently drop data"
// baseline case.
const DUP_SIMPLE_TEXT = "duplicate resume text, scored independently by two rows";
// Three duplicates. Canonical (a1, lowest id) is NOT among the two rows
// that collide on job-2 — the shape the first (unfixed) dedupe attempt's
// EXISTS-against-canonical-only guard missed entirely.
const SCENARIO_A_TEXT = "scenario A resume text (three duplicates, non-canonical collision)";
// One resume, no resume duplication at all — two job_matches rows for the
// SAME (resume_id, job_id) pair. Predates the dedupe pass; the dedupe pass
// is nonetheless the code that has to make the constraint below it safe.
const SCENARIO_C_TEXT = "scenario C resume text (duplicate match on one resume)";

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

  await db.query(
    `insert into source_descriptors (id, display_name) values ('greenhouse', 'Greenhouse')`,
  );
  await db.query(
    `insert into jobs (id, external_id, data_source, title, description, company, link_to_apply, posted_at) values
     ('job-1', 'ext-1', 'greenhouse', 'T', 'D', 'C', 'https://x', '2026-01-01'),
     ('job-2', 'ext-2', 'greenhouse', 'T', 'D', 'C', 'https://x', '2026-01-01')`,
  );

  // --- backslash rows (kept as two separate resumes — see the comments
  // on the constants above for why they must not be combined into one) ---
  await db.query(`insert into resumes (id, resume_text) values ($1, $2)`, [
    "backslash-silent",
    BACKSLASH_SILENT_TEXT,
  ]);
  await db.query(`insert into resumes (id, resume_text) values ($1, $2)`, [
    "backslash-hard-error",
    BACKSLASH_HARD_ERROR_TEXT,
  ]);

  // --- simple 2-duplicate, both scored against job-1 ---
  await db.query(`insert into resumes (id, resume_text) values ($1, $2), ($3, $2)`, [
    "dup-a",
    DUP_SIMPLE_TEXT,
    "dup-b",
  ]);
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale) values
     ('jm-a', 'dup-a', 'job-1', 80, 'r-a'),
     ('jm-b', 'dup-b', 'job-1', 60, 'r-b')`,
  );
  // dup-b also has a `searches` row — must be repointed, not orphaned.
  await db.query(
    `insert into searches (id, resume_id, searched_at) values ('search-b', 'dup-b', '2026-01-01')`,
  );

  // --- scenario A: three duplicates, non-canonical collision ---
  await db.query(
    `insert into resumes (id, resume_text) values ('a1', $1), ('a2', $1), ('a3', $1)`,
    [SCENARIO_A_TEXT],
  );
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale) values
     ('m-a1-1', 'a1', 'job-1', 10, 'r-a1-1'),
     ('m-a2-1', 'a2', 'job-1', 20, 'r-a2-1'),
     ('m-a2-2', 'a2', 'job-2', 30, 'r-a2-2'),
     ('m-a3-2', 'a3', 'job-2', 40, 'r-a3-2')`,
  );

  // --- scenario C: one resume, duplicate (resume_id, job_id) pair ---
  await db.query(`insert into resumes (id, resume_text) values ('c1', $1)`, [SCENARIO_C_TEXT]);
  await db.query(
    `insert into job_matches (id, resume_id, job_id, match_score, rationale) values
     ('m-c1-a', 'c1', 'job-1', 50, 'r-c1-a'),
     ('m-c1-b', 'c1', 'job-1', 60, 'r-c1-b')`,
  );

  await applyMigrationInTransaction(db, "0004_fancy_richard_fisk.sql");
});

afterAll(async () => {
  await db?.end();
  // A just-created, empty-of-connections database can be dropped
  // immediately — nothing else ever connects to TEST_DB.
  await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
  await admin.end();
});

describe("migration 0004 applied to a table with pre-existing rows (ticket 620ca30 review findings B1, B1-again)", () => {
  it("backfills a hash matching Node's sha256 for every resume, including both backslash shapes", async () => {
    const resumes = (await db.query("select id, resume_text, resume_hash from resumes order by id"))
      .rows as Array<{ id: string; resume_text: string; resume_hash: string }>;
    expect(resumes.length).toBeGreaterThan(0);
    // Computed here, not hardcoded, so this can't drift from whatever
    // getOrCreateResumeId in demo-match.ts actually does.
    for (const row of resumes) {
      const expected = createHash("sha256").update(row.resume_text, "utf8").digest("hex");
      expect(row.resume_hash).toBe(expected);
    }
  });

  it("merges a simple duplicate pair (both already scored against the same job) onto one row", async () => {
    const dupHash = createHash("sha256").update(DUP_SIMPLE_TEXT, "utf8").digest("hex");
    const survivors = (await db.query("select id from resumes where resume_hash = $1", [dupHash]))
      .rows as Array<{ id: string }>;
    expect(survivors).toHaveLength(1);
    const survivingId = survivors[0]!.id;
    expect(["dup-a", "dup-b"]).toContain(survivingId);

    const matchesForJob = (
      await db.query(
        "select jm.resume_id from job_matches jm join resumes r on r.id = jm.resume_id where r.resume_hash = $1 and jm.job_id = 'job-1'",
        [dupHash],
      )
    ).rows as Array<{ resume_id: string }>;
    expect(matchesForJob).toHaveLength(1);
    expect(matchesForJob[0]!.resume_id).toBe(survivingId);

    // The searches row that pointed at the non-surviving duplicate was
    // repointed, not orphaned or dropped.
    const searchRows = (await db.query("select resume_id from searches where id = 'search-b'"))
      .rows as Array<{ resume_id: string }>;
    expect(searchRows).toHaveLength(1);
    expect(searchRows[0]!.resume_id).toBe(survivingId);
  });

  it("scenario A: three duplicates where the canonical resume does NOT hold the job two others collide on", async () => {
    const scenarioAHash = createHash("sha256").update(SCENARIO_A_TEXT, "utf8").digest("hex");
    const survivors = (
      await db.query("select id from resumes where resume_hash = $1", [scenarioAHash])
    ).rows as Array<{ id: string }>;
    // MIN(id) over ('a1','a2','a3') is 'a1'.
    expect(survivors).toEqual([{ id: "a1" }]);

    const matches = (
      await db.query(
        "select resume_id, job_id, match_score, rationale from job_matches where resume_id = 'a1' order by job_id",
      )
    ).rows as Array<{ resume_id: string; job_id: string; match_score: number; rationale: string }>;
    // Exactly one row per job — a1's own (job-1) row survives untouched,
    // and exactly one of a2/a3's colliding job-2 rows survives (a2's, by
    // the tie-break rule: lowest job_matches.id among the non-canonical
    // rows once the canonical-resume preference doesn't apply).
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ job_id: "job-1", match_score: 10, rationale: "r-a1-1" });
    expect(matches[1]).toMatchObject({ job_id: "job-2" });
    expect(["r-a2-2", "r-a3-2"]).toContain(matches[1]!.rationale);
  });

  it("scenario C: a duplicate (resume_id, job_id) pair on a single resume (no resume duplication involved) collapses to one row", async () => {
    const scenarioCHash = createHash("sha256").update(SCENARIO_C_TEXT, "utf8").digest("hex");
    const resumeRows = (
      await db.query("select id from resumes where resume_hash = $1", [scenarioCHash])
    ).rows as Array<{ id: string }>;
    expect(resumeRows).toEqual([{ id: "c1" }]);

    const matches = (
      await db.query("select resume_id, job_id, rationale from job_matches where resume_id = 'c1'")
    ).rows as Array<{ resume_id: string; job_id: string; rationale: string }>;
    expect(matches).toHaveLength(1);
    expect(matches[0]!.job_id).toBe("job-1");
    expect(["r-c1-a", "r-c1-b"]).toContain(matches[0]!.rationale);
  });

  it("both unique constraints exist and actually reject a real duplicate insert", async () => {
    const constraints = (
      await db.query(
        `select conname from pg_constraint where conrelid in ('job_matches'::regclass, 'resumes'::regclass) and contype = 'u'`,
      )
    ).rows as Array<{ conname: string }>;
    expect(constraints.map((c) => c.conname).sort()).toEqual(
      ["job_matches_resume_id_job_id_unique", "resumes_resume_hash_unique"].sort(),
    );

    const dupHash = createHash("sha256").update(DUP_SIMPLE_TEXT, "utf8").digest("hex");
    const rejected = await db
      .query(`insert into resumes (id, resume_text, resume_hash) values ('dup-c', $1, $2)`, [
        DUP_SIMPLE_TEXT,
        dupHash,
      ])
      .catch((e: unknown) => e);
    expect((rejected as { code?: string }).code).toBe("23505");
  });
});
