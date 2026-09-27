import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  jobs as jobsTable,
  LEGACY_USER_ID,
  resumes,
  sourceDescriptors,
  userJobStatuses,
  users,
} from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  findLegacyResumes,
  parseArgs,
  runReassign,
  userExists,
} from "./reassign-legacy-resumes.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("reassign_legacy_resumes_test");
  db = testDb.db;
});

afterAll(async () => testDb?.teardown());

async function seedLegacyResume(nickname: string): Promise<string> {
  const id = randomUUID();
  await db.insert(resumes).values({
    id,
    userId: LEGACY_USER_ID,
    resumeText: `Legacy resume text ${randomUUID()}`,
    resumeHash: randomUUID(),
    resumeNickname: nickname,
  });
  return id;
}

describe("parseArgs", () => {
  it("requires exactly one positional argument", () => {
    expect(() => parseArgs([])).toThrow(/exactly one positional argument/);
    expect(() => parseArgs(["a", "b"])).toThrow(/exactly one positional argument/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["some-user-id", "--force"])).toThrow(/Unrecognized flag/);
  });

  it("rejects the target being LEGACY_USER_ID itself", () => {
    expect(() => parseArgs([LEGACY_USER_ID])).toThrow(/must not be LEGACY_USER_ID/);
  });

  it("defaults live to false, true only with --live", () => {
    expect(parseArgs(["some-user-id"])).toEqual({ targetUserId: "some-user-id", live: false });
    expect(parseArgs(["some-user-id", "--live"])).toEqual({
      targetUserId: "some-user-id",
      live: true,
    });
  });
});

describe("userExists", () => {
  it("is true for the legacy user (created by migration 0016)", async () => {
    expect(await userExists(db, LEGACY_USER_ID)).toBe(true);
  });

  it("is false for an id nothing has ever created a users row for", async () => {
    expect(await userExists(db, randomUUID())).toBe(false);
  });
});

describe("runReassign", () => {
  it("refuses to run at all if the target user doesn't exist yet, dry run or live", async () => {
    const neverSeen = randomUUID();
    await expect(runReassign(db, { targetUserId: neverSeen, live: false })).rejects.toThrow(
      /load the real app/,
    );
    await expect(runReassign(db, { targetUserId: neverSeen, live: true })).rejects.toThrow(
      /load the real app/,
    );
  });

  it("dry run reports the candidates but writes nothing", async () => {
    const target = randomUUID();
    await db.insert(users).values({ id: target });
    const resumeId = await seedLegacyResume("Resume to move (dry run)");

    const result = await runReassign(db, { targetUserId: target, live: false });

    expect(result.reassigned).toBe(false);
    expect(result.candidates.map((c) => c.id)).toContain(resumeId);

    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    expect(row[0]?.userId).toBe(LEGACY_USER_ID);
  });

  it("--live actually reassigns every legacy resume to the target user", async () => {
    const target = randomUUID();
    await db.insert(users).values({ id: target });
    const idA = await seedLegacyResume("Resume A to move");
    const idB = await seedLegacyResume("Resume B to move");

    const result = await runReassign(db, { targetUserId: target, live: true });

    expect(result.reassigned).toBe(true);
    // `arrayContaining`, not exact equality: an EARLIER test in this file
    // (the dry-run one) deliberately leaves its own legacy resume behind
    // un-reassigned, since dry runs never write -- this test only asserts
    // that ITS OWN two resumes are among whatever legacy resumes exist.
    expect(result.candidates.map((c) => c.id)).toEqual(expect.arrayContaining([idA, idB]));

    const rows = await db
      .select()
      .from(resumes)
      .where(inArray(resumes.id, [idA, idB]));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userId === target)).toBe(true);

    // And the legacy user itself no longer owns them.
    const stillLegacy = await findLegacyResumes(db);
    expect(stillLegacy.map((r) => r.id)).not.toContain(idA);
    expect(stillLegacy.map((r) => r.id)).not.toContain(idB);
  });

  it("is a genuine no-op when there are no legacy resumes left to reassign", async () => {
    const target = randomUUID();
    await db.insert(users).values({ id: target });

    // Clear out anything left from earlier tests in this file.
    const remaining = await findLegacyResumes(db);
    if (remaining.length > 0) {
      const cleanupTarget = randomUUID();
      await db.insert(users).values({ id: cleanupTarget });
      await runReassign(db, { targetUserId: cleanupTarget, live: true });
    }

    const result = await runReassign(db, { targetUserId: target, live: true });

    expect(result.candidates).toHaveLength(0);
    expect(result.reassigned).toBe(false);
  });
});

/**
 * Ticket 3fc1e5e: `user_job_statuses` gained its own `user_id` column
 * (migration 0017), so this script has to move those rows too -- otherwise
 * reassigning the resumes strands every saved/dismissed/applied marker under
 * `LEGACY_USER_ID`, which is the same "looks wiped" failure this script
 * exists to prevent, one table over and with worse consequences (an
 * application record is the one fact in this app nothing can reconstruct).
 */
describe("runReassign also moves user_job_statuses (ticket 3fc1e5e)", () => {
  const DATA_SOURCE = "usajobs" as const;

  async function seedLegacyJobStatus(): Promise<string> {
    const jobId = randomUUID();
    await db
      .insert(sourceDescriptors)
      .values([{ id: DATA_SOURCE, displayName: "USAJOBS" }])
      .onConflictDoNothing({ target: sourceDescriptors.id });
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `reassign-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title: "A job",
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const statusId = randomUUID();
    await db.insert(userJobStatuses).values({
      id: statusId,
      userId: LEGACY_USER_ID,
      jobId,
      status: "applied",
      appliedAt: new Date("2026-08-19T00:00:00Z"),
    });
    return statusId;
  }

  it("moves legacy job-status rows to the target user, preserving the applied timestamp", async () => {
    const target = randomUUID();
    await db.insert(users).values({ id: target });
    const statusId = await seedLegacyJobStatus();

    const result = await runReassign(db, { targetUserId: target, live: true });

    expect(result.reassigned).toBe(true);
    expect(result.jobStatusCount).toBeGreaterThanOrEqual(1);

    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.id, statusId));
    expect(rows[0]?.userId).toBe(target);
    // Ownership moved; the authored fact itself is untouched.
    expect(rows[0]?.status).toBe("applied");
    expect(rows[0]?.appliedAt).toEqual(new Date("2026-08-19T00:00:00Z"));
  });

  it("still reassigns job statuses when there are no legacy RESUMES left (the state a pre-0017 run of this script leaves behind)", async () => {
    // The specific reason `candidates.length === 0` alone is no longer a
    // sufficient "nothing to do" test: an earlier version of this script
    // moved resumes only, so a real deployment can sit in exactly this
    // state -- legacy statuses, no legacy resumes.
    const drain = randomUUID();
    await db.insert(users).values({ id: drain });
    await runReassign(db, { targetUserId: drain, live: true });
    expect(await findLegacyResumes(db)).toHaveLength(0);

    const statusId = await seedLegacyJobStatus();
    const target = randomUUID();
    await db.insert(users).values({ id: target });

    const result = await runReassign(db, { targetUserId: target, live: true });

    expect(result.candidates).toHaveLength(0);
    // Pre-fix this returned `reassigned: false` and wrote nothing at all.
    expect(result.reassigned).toBe(true);
    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.id, statusId));
    expect(rows[0]?.userId).toBe(target);
  });

  it("a dry run reports the job-status count without writing anything", async () => {
    const statusId = await seedLegacyJobStatus();
    const target = randomUUID();
    await db.insert(users).values({ id: target });

    const result = await runReassign(db, { targetUserId: target, live: false });

    expect(result.reassigned).toBe(false);
    expect(result.jobStatusCount).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(userJobStatuses).where(eq(userJobStatuses.id, statusId));
    expect(rows[0]?.userId).toBe(LEGACY_USER_ID);
  });
});
