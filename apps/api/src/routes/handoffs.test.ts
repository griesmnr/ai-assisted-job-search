import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp as buildApp,
  DEFAULT_TEST_USER_ID,
  injectAs,
} from "../test-support/build-test-app.js";
import { handoffs, jobs as jobsTable, resumes, sourceDescriptors, users } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

const DATA_SOURCE = "usajobs" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("handoffs_test");
  db = testDb.db;
  await db
    .insert(sourceDescriptors)
    .values([{ id: DATA_SOURCE, displayName: "USAJOBS" }])
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  await testDb?.teardown();
});

function buildTestApp() {
  return buildApp({
    db,
    inferTitles: async () => [],
    getScoreJob: () => {
      throw new Error("not used by these tests");
    },
  });
}

async function seedJob(
  overrides: Partial<{ title: string; description: string; company: string }> = {},
) {
  const jobId = randomUUID();
  await db.insert(jobsTable).values({
    id: jobId,
    externalId: `handoffs-test-${jobId}`,
    dataSource: DATA_SOURCE,
    title: overrides.title ?? "Backend Engineer",
    description: overrides.description ?? "Build backend systems.",
    company: overrides.company ?? "Acme",
    linkToApply: `https://example.com/${jobId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return jobId;
}

/**
 * Ticket 3fc1e5e: `POST /handoffs` now requires the resume to belong to the
 * REQUESTING user, so a seeded resume has to name an owner that matches the
 * user the test injects as. Defaults to `DEFAULT_TEST_USER_ID` -- the id
 * `buildTestApp`'s `.inject()` sends when a test doesn't say otherwise --
 * which keeps every pre-existing test in this file passing unchanged.
 *
 * The `users` upsert is required, not defensive: `resumes.user_id` has a real
 * FK to `users.id`, and the identity hook only creates a user row when an
 * actual HTTP request arrives -- this insert happens BEFORE any request, so
 * nothing else has created it yet.
 */
async function seedResume(resumeText = "A real resume.", ownerUserId = DEFAULT_TEST_USER_ID) {
  const resumeId = randomUUID();
  await db.insert(users).values({ id: ownerUserId }).onConflictDoNothing({ target: users.id });
  await db.insert(resumes).values({
    id: resumeId,
    userId: ownerUserId,
    resumeText,
    resumeHash: randomUUID(),
    resumeNickname: `Resume ${randomUUID().slice(0, 8)}`,
  });
  return resumeId;
}

describe("POST /handoffs", () => {
  it("creates a handoff snapshotting the job description and resume text", async () => {
    const app = buildTestApp();
    const jobId = await seedJob({
      title: "Staff Engineer",
      description: "A real job description.",
      company: "Wealthfront",
    });
    const resumeId = await seedResume("A real resume body.");

    const response = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; expiresAt: string };
    expect(body.id).toBeTruthy();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const rows = await db.select().from(handoffs).where(eq(handoffs.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId,
      resumeId,
      resumeText: "A real resume body.",
      jobDescription: "A real job description.",
      jobTitle: "Staff Engineer",
      company: "Wealthfront",
    });
  });

  it("404s for an unknown jobId", async () => {
    const app = buildTestApp();
    const resumeId = await seedResume();

    const response = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId: "does-not-exist", resumeId },
    });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an unknown resumeId", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();

    const response = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId: "does-not-exist" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("400s on a body missing required fields", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/handoffs", payload: {} });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /handoffs/:id", () => {
  it("returns the snapshotted payload for a live handoff", async () => {
    const app = buildTestApp();
    const jobId = await seedJob({
      title: "Data Engineer",
      description: "Own the data platform.",
      company: "Rover",
    });
    const resumeId = await seedResume("Resume text for the get test.");

    const created = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId },
    });
    const { id } = created.json() as { id: string };

    const response = await app.inject({ method: "GET", url: `/handoffs/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      resumeText: "Resume text for the get test.",
      jobDescription: "Own the data platform.",
      jobTitle: "Data Engineer",
      company: "Rover",
    });
  });

  it("404s for an id that never existed", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: `/handoffs/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
  });

  it("404s for an EXPIRED handoff, not the stale payload (real TTL enforcement, not just a missing-id check)", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const resumeId = await seedResume();
    const id = randomUUID();
    // Insert directly, already expired -- simulates a real handoff whose
    // 10-minute TTL has passed, without waiting 10 real minutes.
    await db.insert(handoffs).values({
      id,
      jobId,
      resumeId,
      resumeText: "stale text",
      jobDescription: "stale description",
      jobTitle: "Stale Title",
      company: "Stale Co",
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    const response = await app.inject({ method: "GET", url: `/handoffs/${id}` });
    expect(response.statusCode).toBe(404);
  });

  it("sets a permissive Access-Control-Allow-Origin header, unlike the app's default localhost-only CORS policy", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const resumeId = await seedResume();
    const created = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId },
    });
    const { id } = created.json() as { id: string };

    // A cross-origin request from an arbitrary origin -- exactly what
    // Nicole's separately-deployed resume-tailoring app looks like to
    // this server, and exactly what the app's GLOBAL CORS policy
    // (localhost/127.0.0.1 only) would otherwise refuse to authorize.
    const response = await app.inject({
      method: "GET",
      url: `/handoffs/${id}`,
      headers: { origin: "https://ai-job-search-assistant-beta.vercel.app" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://ai-job-search-assistant-beta.vercel.app",
    );
  });

  it("POST /handoffs itself keeps the app's default restrictive CORS (only this app's own frontend can mint one)", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const resumeId = await seedResume();

    const response = await app.inject({
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId },
      headers: { origin: "https://some-random-site.example.com" },
    });
    // The request still succeeds server-side (Fastify doesn't enforce
    // CORS as a request-blocking mechanism, only as a response header the
    // BROWSER enforces) -- what matters here is that this route did NOT
    // get the permissive override: no matching-origin ACAO header comes
    // back for a non-localhost origin, so a real browser would refuse to
    // expose the response to a script running on that page.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

/**
 * Ticket 3fc1e5e: `POST /handoffs` is now scoped to the caller's own resume.
 *
 * WHY THIS ONE MATTERS EVEN THOUGH `GET /resumes/:id` IS ALSO FIXED: this
 * route PERSISTS a copy of the resume text into a `handoffs` row, and that
 * row is readable through `GET /handoffs/:id`, which is deliberately EXEMPT
 * from the `x-user-id` requirement (identity.ts) so a separate-origin app
 * can fetch it. Ownership therefore cannot be enforced on the read side of
 * the pair at all -- mint time is the only place it can be enforced, which
 * is what these tests pin.
 */
describe("cross-user isolation for handoffs (ticket 3fc1e5e)", () => {
  const USER_A = "a1111111-1111-4111-8111-111111111111";
  const USER_B = "b2222222-2222-4222-8222-222222222222";

  it("refuses to snapshot another user's resume, and writes no handoff row", async () => {
    const app = buildTestApp();
    const jobId = await seedJob();
    const resumeA = await seedResume("User A's private resume text.", USER_A);

    const attempt = await injectAs(app, USER_B, {
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId: resumeA },
    });

    // 404, indistinguishable from a resumeId that never existed.
    expect(attempt.statusCode).toBe(404);
    expect(attempt.body).not.toContain("User A's private resume text.");

    // The decisive assertion: NO row was created. A created row would be a
    // durable copy of A's resume text, readable forever (well, for the TTL)
    // by anyone with the handoff id and no identity header at all.
    const rows = await db.select().from(handoffs).where(eq(handoffs.resumeId, resumeA));
    expect(rows).toHaveLength(0);
  });

  it("lets the resume's own owner mint a handoff for the same job", async () => {
    // Proves the 404 above is the ownership check, not a broken route -- and
    // that the identity-exempt GET still serves a legitimately-minted
    // handoff, which is the whole point of the feature.
    const app = buildTestApp();
    const jobId = await seedJob();
    const resumeA = await seedResume("User A's private resume text.", USER_A);

    const minted = await injectAs(app, USER_A, {
      method: "POST",
      url: "/handoffs",
      payload: { jobId, resumeId: resumeA },
    });
    expect(minted.statusCode).toBe(200);
    const { id } = minted.json() as { id: string };

    // Fetched with NO x-user-id header at all (the documented exemption) --
    // `headers: { "x-user-id": "" }` is build-test-app's way of omitting it.
    const fetched = await app.inject({
      method: "GET",
      url: `/handoffs/${id}`,
      headers: { "x-user-id": "" },
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { resumeText: string }).resumeText).toBe(
      "User A's private resume text.",
    );
  });
});
