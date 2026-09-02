/**
 * The scenario ticket 0c319b2 exists for, run end to end against a real
 * database rather than argued from the schema:
 *
 *   apply to job X with resume v1  ->  rewrite the resume to v2  ->  search
 *   again, X is re-ingested and RE-SCORED under v2  ->  "I applied to X"
 *   must still be true, still be exactly one row, and still point at a live
 *   job.
 *
 * This is the failure `user_job_statuses` is keyed on `job_id` alone to
 * prevent. Under a `(resume_id, job_id)` key — the shape `job_matches` uses,
 * and the obvious-looking shape to copy — every assertion below about the
 * SECOND run fails: the lookup made under v2 finds nothing, the app
 * re-recommends an already-applied job, and recording the application again
 * inserts a second row for the same job. `resumes` is content-addressed by
 * `resume_hash` (ticket 620ca30), so "rewriting the resume" genuinely
 * produces a different row with a different id — not an edit of v1 — which
 * is what makes the resume the wrong thing to key on.
 *
 * Requires a live Postgres (like every other DB-backed test in this repo).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchResults,
  searchSources,
  userJobStatuses,
} from "./schema.js";
import { fetchAppliedJobIds, runDemoMatch, type ScoreJobFn } from "../demo-match.js";
import type { JobSource, NormalizedJob, SourceSearchResult } from "../sources/types.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const db = drizzle(client);

// Real, permanently-seeded source id (see db/seed.ts) — same choice
// demo-match.test.ts makes, and deliberately not deleted in afterAll.
const DATA_SOURCE = "usajobs" as const;

/** Prefixed so a leaked row from a crashed run is still findable by hand;
 * the per-run UUID keeps concurrent/repeated runs from colliding. */
const RUN_ID = randomUUID();
const RESUME_TEXT_PREFIX = "ticket-0c319b2-user-job-statuses-test:";
const RESUME_V1 = `${RESUME_TEXT_PREFIX} v1 ${RUN_ID}`;
const RESUME_V2 = `${RESUME_TEXT_PREFIX} v2 ${RUN_ID} — rewritten, materially different text`;

const APPLIED_EXTERNAL_ID = `0c319b2-applied-${RUN_ID}`;
const OTHER_EXTERNAL_ID = `0c319b2-other-${RUN_ID}`;

function job(externalId: string, title: string): NormalizedJob {
  return {
    externalId,
    dataSource: DATA_SOURCE,
    title,
    description: `Description for ${title}`,
    company: "Test Co",
    payType: "salary",
    commitment: "full-time",
    locationType: "remote",
    location: "Remote",
    linkToApply: `https://example.com/${externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const FAKE_JOBS: NormalizedJob[] = [
  job(APPLIED_EXTERNAL_ID, "Applied Engineer"),
  job(OTHER_EXTERNAL_ID, "Other Engineer"),
];

class FakeSource implements JobSource {
  readonly dataSource = DATA_SOURCE;
  async search(): Promise<SourceSearchResult> {
    return { jobs: FAKE_JOBS, skipped: [], skipRate: 0 };
  }
}

/** Deterministic per (job, resume) so the test can prove a job was really
 * re-scored under v2 rather than reusing v1's row. */
const scoreJob: ScoreJobFn = async (j: NormalizedJob, resumeText: string) => ({
  matchScore: resumeText === RESUME_V2 ? 90 : 60,
  rationale: `fake rationale for ${j.title}`,
  strengths: [],
  gaps: [],
});

let outputDir: string;
let outputPath: string;
let usageStatsPath: string;

beforeAll(async () => {
  await client.connect();
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-job-statuses-test-"));
  outputPath = path.join(outputDir, "match-results.json");
  usageStatsPath = path.join(outputDir, "scoring-usage-stats.json");
});

/** Logs rather than throws, so one failing cleanup statement can't skip
 * every statement after it and leak rows into the shared dev database. */
async function safeDelete(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[user-job-statuses.test.ts afterAll] cleanup step "${label}" failed:`, err);
  }
}

afterAll(async () => {
  // Resolve ids by SELECT from statically-known data, never from a
  // runDemoMatch return value — a run that throws partway still leaves rows
  // behind under ids the test never learned.
  const externalIds = [APPLIED_EXTERNAL_ID, OTHER_EXTERNAL_ID];
  const jobRows = await db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(and(eq(jobsTable.dataSource, DATA_SOURCE), inArray(jobsTable.externalId, externalIds)));
  const jobIds = jobRows.map((r) => r.id);

  const resumeRows = await db
    .select({ id: resumes.id })
    .from(resumes)
    .where(inArray(resumes.resumeText, [RESUME_V1, RESUME_V2]));
  const resumeIds = resumeRows.map((r) => r.id);

  let searchIds: string[] = [];
  if (resumeIds.length > 0) {
    const rows = await db
      .select({ id: searches.id })
      .from(searches)
      .where(inArray(searches.resumeId, resumeIds));
    searchIds = rows.map((r) => r.id);
  }

  // Children before parents.
  if (jobIds.length > 0) {
    await safeDelete("user_job_statuses", () =>
      db.delete(userJobStatuses).where(inArray(userJobStatuses.jobId, jobIds)),
    );
  }
  if (jobIds.length > 0 || searchIds.length > 0) {
    await safeDelete("search_results", () =>
      db
        .delete(searchResults)
        .where(
          or(
            jobIds.length > 0 ? inArray(searchResults.jobId, jobIds) : undefined,
            searchIds.length > 0 ? inArray(searchResults.searchId, searchIds) : undefined,
          ),
        ),
    );
  }
  if (searchIds.length > 0) {
    await safeDelete("search_sources", () =>
      db.delete(searchSources).where(inArray(searchSources.searchId, searchIds)),
    );
  }
  if (jobIds.length > 0 || resumeIds.length > 0) {
    await safeDelete("job_matches", () =>
      db
        .delete(jobMatches)
        .where(
          or(
            resumeIds.length > 0 ? inArray(jobMatches.resumeId, resumeIds) : undefined,
            jobIds.length > 0 ? inArray(jobMatches.jobId, jobIds) : undefined,
          ),
        ),
    );
  }
  await safeDelete("jobs", () =>
    db
      .delete(jobsTable)
      .where(
        and(eq(jobsTable.dataSource, DATA_SOURCE), inArray(jobsTable.externalId, externalIds)),
      ),
  );
  if (searchIds.length > 0) {
    await safeDelete("searches", () => db.delete(searches).where(inArray(searches.id, searchIds)));
  }
  await safeDelete("resumes", () =>
    db.delete(resumes).where(inArray(resumes.resumeText, [RESUME_V1, RESUME_V2])),
  );

  fs.rmSync(outputDir, { recursive: true, force: true });
  await client.end();
});

describe("user_job_statuses survives a resume rewrite (ticket 0c319b2)", () => {
  it("keeps one correct 'applied' row for job X after X is re-scored under a NEW resume", async () => {
    // --- 1. Search with resume v1. Both jobs are ingested and scored.
    const firstRun = await runDemoMatch({
      db,
      sources: [new FakeSource()],
      resumeText: RESUME_V1,
      scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });
    const resumeV1Id = firstRun.resumeId;
    expect(firstRun.results.map((r) => r.externalId).sort()).toEqual(
      [APPLIED_EXTERNAL_ID, OTHER_EXTERNAL_ID].sort(),
    );

    const appliedJobId = firstRun.results.find((r) => r.externalId === APPLIED_EXTERNAL_ID)!.jobId;
    const otherJobId = firstRun.results.find((r) => r.externalId === OTHER_EXTERNAL_ID)!.jobId;

    // --- 2. The user applies to X, with resume v1 in hand. `resume_id` is
    // recorded as an ATTRIBUTE of the application (which resume was sent),
    // but is not part of the key.
    const appliedAt = new Date("2026-08-19T00:00:00Z");
    await db.insert(userJobStatuses).values({
      id: randomUUID(),
      jobId: appliedJobId,
      status: "applied",
      resumeId: resumeV1Id,
      appliedAt,
    });

    // --- 3. The resume is rewritten. Content-addressing (ticket 620ca30)
    // makes v2 a genuinely different row, not an edit of v1 — this is the
    // precondition that breaks a resume-keyed status table.
    const secondRun = await runDemoMatch({
      db,
      sources: [new FakeSource()],
      resumeText: RESUME_V2,
      scoreJob,
      outputPath,
      usageStatsPath,
      log: () => {},
    });
    const resumeV2Id = secondRun.resumeId;
    expect(resumeV2Id).not.toBe(resumeV1Id);

    // X really was re-scored under v2 — otherwise this test would be
    // proving nothing about the rewrite at all.
    const v2MatchForX = await db
      .select({ matchScore: jobMatches.matchScore })
      .from(jobMatches)
      .where(and(eq(jobMatches.resumeId, resumeV2Id), eq(jobMatches.jobId, appliedJobId)));
    expect(v2MatchForX).toHaveLength(1);
    expect(v2MatchForX[0]!.matchScore).toBe(90);

    // --- 4a. Exactly ONE status row for X — not duplicated by the rewrite.
    const statusRows = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, appliedJobId));
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]!.status).toBe("applied");
    expect(statusRows[0]!.appliedAt).toEqual(appliedAt);
    // Still attributed to the resume that was actually sent, untouched by
    // the rewrite — and not orphaned onto v2.
    expect(statusRows[0]!.resumeId).toBe(resumeV1Id);

    // --- 4b. Not orphaned: it still points at a live `jobs` row.
    const jobStillThere = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, appliedJobId));
    expect(jobStillThere).toHaveLength(1);

    // --- 4c. The lookup the shortlist path makes — under v2, with no
    // resume in the query — still finds it. This single assertion is what a
    // `(resume_id, job_id)` key would fail.
    const applied = await fetchAppliedJobIds(db, [appliedJobId, otherJobId]);
    expect([...applied]).toEqual([appliedJobId]);

    // --- 4d. ...and so the second run's shown results exclude X while
    // still showing everything else.
    expect(secondRun.results.map((r) => r.externalId)).toEqual([OTHER_EXTERNAL_ID]);
  });

  it("rejects a second status row for the same job even under a different resume", async () => {
    // Same fact ("I applied to X"), recorded a second time after a resume
    // rewrite, must collide — the uniqueness is on job_id ALONE. Under a
    // (resume_id, job_id) key this insert would succeed and the table could
    // no longer answer "did I apply to X?" with one row.
    const jobRow = await db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(
        and(eq(jobsTable.dataSource, DATA_SOURCE), eq(jobsTable.externalId, APPLIED_EXTERNAL_ID)),
      );
    const appliedJobId = jobRow[0]!.id;
    const resumeV2 = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.resumeText, RESUME_V2));

    const error = await db
      .insert(userJobStatuses)
      .values({
        id: randomUUID(),
        jobId: appliedJobId,
        status: "applied",
        resumeId: resumeV2[0]!.id,
        appliedAt: new Date("2026-08-20T00:00:00Z"),
      })
      .catch((e) => e);

    expect(error.cause.code).toBe("23505");
  });
});
