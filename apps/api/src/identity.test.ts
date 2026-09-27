import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp as buildApp,
  DEFAULT_TEST_USER_ID,
  injectAs,
} from "./test-support/build-test-app.js";
import { users } from "./db/schema.js";
import { createTestDatabase, type TestDatabase } from "./db/test-db.js";
import { loadEnvFile } from "./load-env.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("identity_test");
  db = testDb.db;
});

afterAll(async () => testDb.teardown());

function buildTestSubject() {
  return buildApp({
    db,
    inferTitles: async () => [],
    getScoreJob: () => {
      throw new Error("not used by this test");
    },
  });
}

describe("identity hook (ticket dba885e)", () => {
  it("rejects a request with no x-user-id header at all", async () => {
    const app = buildTestSubject();

    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { "x-user-id": "" }, // build-test-app.ts's own escape hatch
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("x-user-id") });
  });

  it("rejects a malformed (non-UUID) x-user-id header", async () => {
    const app = buildTestSubject();

    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { "x-user-id": "not-a-real-uuid" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("accepts a real UUID and creates the corresponding users row", async () => {
    const app = buildTestSubject();
    const id = "11111111-1111-4111-8111-111111111111";

    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { "x-user-id": id },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(users).where(eq(users.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBeNull();
  });

  it("reusing the same id across multiple requests creates exactly one row, not a duplicate", async () => {
    const app = buildTestSubject();
    const id = "22222222-2222-4222-8222-222222222222";

    await app.inject({ method: "GET", url: "/sources", headers: { "x-user-id": id } });
    await app.inject({ method: "GET", url: "/sources", headers: { "x-user-id": id } });
    await app.inject({ method: "GET", url: "/sources", headers: { "x-user-id": id } });

    const rows = await db.select().from(users).where(eq(users.id, id));
    expect(rows).toHaveLength(1);
  });

  // Review fix (B2): the wrapper's own "does the caller already have a
  // header?" check used to be case-SENSITIVE against a case-INSENSITIVE
  // HTTP concept, so a caller spelling the header "X-User-Id" (equally
  // valid HTTP) had it silently discarded and overwritten with the
  // default fixture user, with no error. Proven directly against the
  // real users table, not just against the response.
  it("honors an explicit header even when the caller spells it with different casing (build-test-app.ts's own case-insensitivity)", async () => {
    const app = buildTestSubject();
    const id = "33333333-3333-4333-8333-333333333333";

    const response = await app.inject({
      method: "GET",
      url: "/sources",
      headers: { "X-User-Id": id },
    });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(users).where(eq(users.id, id));
    expect(rows).toHaveLength(1);
    // And NOT silently run as the default fixture user instead.
    const defaultRows = await db.select().from(users).where(eq(users.id, DEFAULT_TEST_USER_ID));
    expect(defaultRows).toHaveLength(0);
  });

  it("injectAs is a casing-proof way to act as a specific user, for future cross-user isolation tests", async () => {
    const app = buildTestSubject();
    const id = "44444444-4444-4444-8444-444444444444";

    const response = await injectAs(app, id, { method: "GET", url: "/sources" });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(users).where(eq(users.id, id));
    expect(rows).toHaveLength(1);
  });

  it("the default test fixture user id (build-test-app.ts) works as a real header out of the box", async () => {
    const app = buildTestSubject();

    // No explicit x-user-id -- build-test-app.ts's wrapper supplies the
    // default automatically, same as every other route test in this repo.
    const response = await app.inject({ method: "GET", url: "/sources" });

    expect(response.statusCode).toBe(200);
    const rows = await db.select().from(users).where(eq(users.id, DEFAULT_TEST_USER_ID));
    expect(rows).toHaveLength(1);
  });

  // CORS preflight must never be blocked by this hook -- a real 400 here
  // would fail EVERY cross-origin request the browser makes right after,
  // since the browser never attempts the real request once preflight fails.
  it("does not block an OPTIONS (CORS preflight) request even with no header at all", async () => {
    const app = buildTestSubject();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/sources",
      headers: {
        "x-user-id": "",
        "access-control-request-method": "GET",
        origin: "http://localhost:5173",
      },
    });

    expect(response.statusCode).not.toBe(400);
  });

  // GET /handoffs/:id is fetched cross-origin by an entirely separate app
  // (routes/handoffs.ts's own doc comment) that has no way to know this
  // app's anonymous-id header scheme -- it must stay reachable with no
  // header at all. A 404 (no such handoff exists) is the correct outcome
  // here, not a 400 from this hook.
  it("does not require the header for GET /handoffs/:id", async () => {
    const app = buildTestSubject();

    const response = await app.inject({
      method: "GET",
      url: "/handoffs/00000000-0000-0000-0000-000000000000",
      headers: { "x-user-id": "" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toMatchObject({ error: expect.stringContaining("x-user-id") });
  });

  // POST /handoffs (creating one, as opposed to fetching one) is only ever
  // called by THIS app's own frontend, never the external one -- it keeps
  // the normal identity requirement.
  it("DOES require the header for POST /handoffs", async () => {
    const app = buildTestSubject();

    const response = await app.inject({
      method: "POST",
      url: "/handoffs",
      headers: { "x-user-id": "" },
      payload: { jobId: "does-not-matter", resumeId: "does-not-matter" },
    });

    expect(response.statusCode).toBe(400);
  });
});
