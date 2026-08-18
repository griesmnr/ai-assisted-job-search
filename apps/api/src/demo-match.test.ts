import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
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
} from "./db/schema.js";
import { runDemoMatch, type ScoredJob, type ScoreJobFn } from "./demo-match.js";
import type { JobSource, NormalizedJob, SourceSearchResult } from "./sources/types.js";

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

// "usajobs" is one of the real dataSource ids demo-match.ts always seeds
// via seedSourceDescriptors (see db/seed.ts) — using it here also proves
// runDemoMatch's own seeding step works, without needing a throwaway
// source_descriptors row. Unlike the jobs/resumes/searches rows this test
// creates, the "usajobs" source_descriptors row is real, permanent setup
// data (identical to what `db:seed` produces) and is deliberately NOT
// deleted in afterAll.
const DATA_SOURCE = "usajobs" as const;
const RESUME_TEXT = `demo-match test resume ${randomUUID()}`;

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
  job("demo-match-test-1", "Widget Engineer"),
  job("demo-match-test-2", "Gadget Engineer"),
  job("demo-match-test-3", "Gizmo Engineer"),
];

class FakeSource implements JobSource {
  readonly dataSource = DATA_SOURCE;
  async search(): Promise<SourceSearchResult> {
    return { jobs: FAKE_JOBS, skipped: [], skipRate: 0 };
  }
}

/** Counts invocations so the test can assert a second run makes ZERO
 * Claude calls — the ticket's acceptance criterion — without an
 * ANTHROPIC_API_KEY or any network access. */
function makeCountingScorer(): { scoreJob: ScoreJobFn; calls: () => number } {
  let calls = 0;
  const scoreJob: ScoreJobFn = async (jobArg: NormalizedJob): Promise<ScoredJob> => {
    calls++;
    // Deterministic, distinguishable-per-job score so sort order is
    // checkable.
    const n = Number(jobArg.externalId.split("-").pop());
    return { matchScore: 50 + n, rationale: `fake rationale for ${jobArg.title}` };
  };
  return { scoreJob, calls: () => calls };
}

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-match-test-"));
const outputPath = path.join(outputDir, "match-results.json");

let resumeId: string | undefined;
const searchIds: string[] = [];

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  // Clean up everything this test created. The "usajobs" source_descriptors
  // row seeded along the way is real setup data and is intentionally left
  // in place (see the DATA_SOURCE comment above). Every delete below is
  // explicitly guarded (never `.where(undefined)`, which drizzle treats as
  // "no filter" and would wipe the whole table) so a failed test that
  // never assigned `resumeId`/`searchIds` cleans up nothing rather than
  // everything.
  if (resumeId) {
    await db.delete(jobMatches).where(eq(jobMatches.resumeId, resumeId));
  }
  for (const searchId of searchIds) {
    await db.delete(searchResults).where(eq(searchResults.searchId, searchId));
    await db.delete(searchSources).where(eq(searchSources.searchId, searchId));
  }
  for (const searchId of searchIds) {
    await db.delete(searches).where(eq(searches.id, searchId));
  }
  await db.delete(jobsTable).where(
    and(
      eq(jobsTable.dataSource, DATA_SOURCE),
      inArray(
        jobsTable.externalId,
        FAKE_JOBS.map((j) => j.externalId),
      ),
    ),
  );
  if (resumeId) {
    await db.delete(resumes).where(eq(resumes.id, resumeId));
  }
  fs.rmSync(outputDir, { recursive: true, force: true });
  await client.end();
});

describe("runDemoMatch (ticket 620ca30)", () => {
  it("scores every job on the first run, then scores ZERO jobs on a second run against the same candidates", async () => {
    const scorer = makeCountingScorer();
    const source = new FakeSource();

    const first = await runDemoMatch({
      db,
      source,
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      maxJobs: FAKE_JOBS.length,
      outputPath,
      log: () => {},
    });
    resumeId = first.resumeId;
    searchIds.push(first.searchId);

    expect(first.newlyScored).toBe(FAKE_JOBS.length);
    expect(first.skipped).toBe(0);
    expect(scorer.calls()).toBe(FAKE_JOBS.length);
    expect(first.results).toHaveLength(FAKE_JOBS.length);
    // Ranked descending by matchScore.
    for (let i = 1; i < first.results.length; i++) {
      expect(first.results[i - 1]!.matchScore).toBeGreaterThanOrEqual(first.results[i]!.matchScore);
    }

    // Same posting ingested twice (via the same call, and again below)
    // must produce exactly one `jobs` row per external id.
    const jobRowsAfterFirst = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.dataSource, DATA_SOURCE),
          inArray(
            jobsTable.externalId,
            FAKE_JOBS.map((j) => j.externalId),
          ),
        ),
      );
    expect(jobRowsAfterFirst).toHaveLength(FAKE_JOBS.length);

    // --- second run: identical resume, identical candidate jobs ---
    const second = await runDemoMatch({
      db,
      source,
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      maxJobs: FAKE_JOBS.length,
      outputPath,
      log: () => {},
    });
    searchIds.push(second.searchId);

    // The acceptance criterion: nothing new to score, so zero Claude
    // calls happen on the second run.
    expect(second.newlyScored).toBe(0);
    expect(second.skipped).toBe(FAKE_JOBS.length);
    expect(scorer.calls()).toBe(FAKE_JOBS.length); // unchanged from the first run

    // Results still come back in full — from the database, not from this
    // (empty) run's scoring — so a second run isn't a worse UX than the
    // first.
    expect(second.results).toHaveLength(FAKE_JOBS.length);
    expect(new Set(second.results.map((r) => r.externalId))).toEqual(
      new Set(first.results.map((r) => r.externalId)),
    );

    // Still exactly one `jobs` row per external id — re-ingesting the same
    // postings a second time did not create duplicates.
    const jobRowsAfterSecond = await db
      .select()
      .from(jobsTable)
      .where(
        and(
          eq(jobsTable.dataSource, DATA_SOURCE),
          inArray(
            jobsTable.externalId,
            FAKE_JOBS.map((j) => j.externalId),
          ),
        ),
      );
    expect(jobRowsAfterSecond).toHaveLength(FAKE_JOBS.length);

    // And exactly one job_matches row per (resume, job) — the unique
    // constraint plus the skip-if-already-scored logic together mean no
    // duplicate scoring rows ever land.
    const matchRows = await db
      .select()
      .from(jobMatches)
      .where(eq(jobMatches.resumeId, first.resumeId));
    expect(matchRows).toHaveLength(FAKE_JOBS.length);

    // The output file reflects the database-backed second-run results.
    const written = JSON.parse(fs.readFileSync(outputPath, "utf8")) as unknown[];
    expect(written).toHaveLength(FAKE_JOBS.length);
  });

  it("reuses the same resumes row for identical resume text instead of inserting a duplicate", async () => {
    const scorer = makeCountingScorer();
    const source = new FakeSource();

    const run = await runDemoMatch({
      db,
      source,
      resumeText: RESUME_TEXT,
      scoreJob: scorer.scoreJob,
      maxJobs: FAKE_JOBS.length,
      outputPath,
      log: () => {},
    });
    searchIds.push(run.searchId);

    expect(run.resumeId).toBe(resumeId);

    const resumeRows = await db.select().from(resumes).where(eq(resumes.resumeText, RESUME_TEXT));
    expect(resumeRows).toHaveLength(1);
  });
});
