/**
 * Structural checks on the `user_job_statuses` schema and its migration
 * (ticket 0c319b2), deliberately written to need NO database connection.
 *
 * The scenario this table exists for — apply with resume v1, rewrite to v2,
 * re-search, "I applied" must survive — is proved end to end against real
 * Postgres in `user-job-statuses.test.ts`. That test is the real one. This
 * file exists because the single property that whole feature rests on
 * (`resume_id` is NEVER part of the uniqueness key) is statically checkable,
 * and a regression that silently reintroduces the `job_matches`-shaped key
 * should not be able to hide behind "no Postgres reachable, DB tests
 * skipped".
 *
 * UPDATED (ticket 3fc1e5e): the key is now `(user_id, job_id)`, not `job_id`
 * alone -- schema.ts's own doc comment had carried that instruction since
 * ticket dba885e ("widen this to `unique().on(table.userId, table.jobId)`
 * and add the `user_id` column -- do NOT add `resume_id` to it at that
 * time"), and migration 0017 applies it. The INVARIANT this file guards is
 * unchanged and is the second half of that instruction: `resume_id` must
 * stay out of the key. The `migration 0006` describe block below still
 * asserts what 0006 ITSELF wrote (`UNIQUE("job_id")`) -- that migration is
 * history and its text does not change; 0017 is what drops that constraint
 * and adds the wider one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { userJobStatuses } from "./schema.js";

const drizzleDir = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));

function readMigration0006(): string {
  const file = readdirSync(drizzleDir).find((f) => f.startsWith("0006_") && f.endsWith(".sql"));
  if (!file) throw new Error(`no 0006_*.sql migration found in ${drizzleDir}`);
  return readFileSync(path.join(drizzleDir, file), "utf8");
}

describe("user_job_statuses schema (ticket 0c319b2)", () => {
  const config = getTableConfig(userJobStatuses);

  it("is keyed on (user_id, job_id) — resume_id is never part of the uniqueness key", () => {
    const uniqueColumnSets = config.uniqueConstraints.map((c) => c.columns.map((col) => col.name));
    expect(uniqueColumnSets).toEqual([["user_id", "job_id"]]);

    // Stated separately from the equality above so a future edit that adds
    // a second unique constraint still trips on the actual invariant, not
    // just on the array shape. This is the half of the key's design that
    // ticket 3fc1e5e's widening deliberately did NOT change: "I applied to
    // X" is a fact about (person, job) and must survive every resume
    // rewrite, which it does exactly when the resume is not in the key.
    for (const columns of uniqueColumnSets) {
      expect(columns).not.toContain("resume_id");
    }
  });

  it("records user_id as a NOT NULL owning reference (ticket 3fc1e5e)", () => {
    // The column the pre-3fc1e5e table lacked entirely, which is why one
    // status row per job was shared by every user in the database.
    const userId = config.columns.find((c) => c.name === "user_id");
    expect(userId).toBeDefined();
    expect(userId!.notNull).toBe(true);
  });

  it("records resume_id as a nullable attribute, not a key", () => {
    const resumeId = config.columns.find((c) => c.name === "resume_id");
    expect(resumeId).toBeDefined();
    expect(resumeId!.notNull).toBe(false);
    expect(resumeId!.primary).toBe(false);
  });

  it("can answer 'when did I apply' independently of row bookkeeping", () => {
    const names = config.columns.map((c) => c.name);
    expect(names).toContain("applied_at");
    expect(names).toContain("created_at");
    expect(names).toContain("updated_at");
    // Nullable: only an `applied` row has one.
    expect(config.columns.find((c) => c.name === "applied_at")!.notNull).toBe(false);
  });

  it("stops the lifecycle at 'applied' — exactly four statuses, no post-application states", () => {
    const status = config.columns.find((c) => c.name === "status")!;
    expect(status.notNull).toBe(true);
    expect(status.enumValues).toEqual(["saved", "resume_optimized", "applied", "dismissed"]);
    // The boundary, asserted as itself: post-application tracking belongs
    // to a separate job-tracker product (see schema.ts's comment), and this
    // app has no signal for any of it.
    for (const excluded of ["rejected", "interviewing", "offer", "ghosted", "screening"]) {
      expect(status.enumValues).not.toContain(excluded);
    }
  });
});

describe("migration 0006 (ticket 0c319b2)", () => {
  const sql = readMigration0006();

  it("is registered in the drizzle journal", () => {
    const journal = JSON.parse(
      readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.some((e) => e.idx === 6 && e.tag.startsWith("0006_"))).toBe(true);
  });

  it("creates the enum and the table, with UNIQUE on job_id only", () => {
    expect(sql).toContain(
      `CREATE TYPE "public"."user_job_status" AS ENUM('saved', 'resume_optimized', 'applied', 'dismissed')`,
    );
    expect(sql).toContain(`CREATE TABLE "user_job_statuses"`);
    expect(sql).toContain(`UNIQUE("job_id")`);
    expect(sql).not.toMatch(/UNIQUE\(\s*"resume_id"/);
    expect(sql).not.toMatch(/UNIQUE\([^)]*"resume_id"[^)]*"job_id"/);
  });

  it("backfills the confirmed application by (data_source, external_id), never by a hardcoded job id", () => {
    // `jobs.id` is a randomUUID() minted at ingest time — unknowable from a
    // migration file. Resolving through the posting's real identity means
    // the INSERT simply matches zero rows on a database where that posting
    // was never ingested, instead of writing a dangling application record.
    expect(sql).toContain(`INSERT INTO "user_job_statuses"`);
    expect(sql).toContain(`"j"."data_source" = 'greenhouse'`);
    expect(sql).toContain(`"j"."external_id" = '8036387'`);
    expect(sql).toContain(`TIMESTAMP '2026-08-19 00:00:00'`);
    expect(sql).toContain(`ON CONFLICT ("job_id") DO NOTHING`);
  });

  it("does NOT invent a Smartsheet application it cannot confirm was sent", () => {
    // Nothing in this repo records a Smartsheet posting id, a tailored
    // resume, or an A/B run — only that the board is searched. The
    // uncertainty is documented in the migration rather than papered over
    // with a fabricated external_id.
    expect(sql).not.toMatch(/'smartsheet'/);
    expect(sql.toLowerCase()).toContain("smartsheet");
    expect(sql).toMatch(/NOT BACKFILLED/);
  });
});
