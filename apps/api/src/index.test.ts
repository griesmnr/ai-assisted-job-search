import { afterEach, describe, expect, it } from "vitest";
import { ping } from "@app/shared";
import { buildTestApp as buildApp } from "./test-support/build-test-app.js";

// A minimal fake db satisfies BuildAppDeps's type without needing a real
// Postgres connection just to prove buildApp wires routes up — the routes
// this test actually exercises (GET /sources) never touch `db` themselves.
// Route behavior that DOES touch the database is covered by
// routes/*.test.ts against a real Postgres instance, matching this
// codebase's existing integration-test convention (see demo-match.test.ts,
// db/schema.test.ts).
//
// Ticket dba885e: the identity hook (identity.ts) now runs on EVERY
// request regardless of route, including this one, and does one
// `db.insert(users).values(...).onConflictDoNothing(...)` — so the fake
// needs that one chain to be real (a no-op), even though this test still
// never exercises any actual query logic.
const fakeDb = {
  insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe("api entrypoint", () => {
  it("builds a Fastify instance with routes registered", async () => {
    const app = buildApp({
      db: fakeDb,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used by this test");
      },
    });
    expect(app).toBeDefined();

    // GET /sources doesn't touch `db` at all (see routes/sources.ts) — a
    // cheap way to prove buildApp actually registered a route, not just
    // returned a bare Fastify instance the way the pre-59fdc52 scaffold did.
    const response = await app.inject({ method: "GET", url: "/sources" });
    expect(response.statusCode).toBe(200);
  });

  it("can import @app/shared via the workspace protocol", () => {
    expect(ping()).toBe("pong");
  });

  describe("CORS_ALLOWED_ORIGIN (ticket 17d14b1)", () => {
    // process.env is read inside buildApp() on every call, not once at
    // module load -- safe to flip per test as long as it's restored after.
    const ORIGINAL = process.env.CORS_ALLOWED_ORIGIN;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CORS_ALLOWED_ORIGIN;
      else process.env.CORS_ALLOWED_ORIGIN = ORIGINAL;
    });

    it("falls back to the localhost-only regex when unset, unchanged from before this ticket", async () => {
      delete process.env.CORS_ALLOWED_ORIGIN;
      const app = buildApp({
        db: fakeDb,
        inferTitles: async () => [],
        getScoreJob: () => {
          throw new Error("not used by this test");
        },
      });
      const allowed = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "http://localhost:5173" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

      const blocked = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "https://evil.example.com" },
      });
      expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows exactly the configured origin when CORS_ALLOWED_ORIGIN is set, and nothing else", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "https://jobsearch.example.com";
      const app = buildApp({
        db: fakeDb,
        inferTitles: async () => [],
        getScoreJob: () => {
          throw new Error("not used by this test");
        },
      });
      const allowed = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "https://jobsearch.example.com" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://jobsearch.example.com");

      // @fastify/cors, given a static string, always echoes that ONE
      // configured value regardless of the request's actual Origin -- it
      // never reflects the caller's own origin the way the regex branch
      // does. So a page served from localhost, hitting a deployed API with
      // CORS_ALLOWED_ORIGIN set, still gets told the allowed origin is the
      // real deployed frontend, not localhost -- which is exactly what
      // stops a browser from trusting the response, since the header no
      // longer matches the page's own origin. The dev-time regex must NOT
      // additionally kick in once a real origin is configured.
      const localhost = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "http://localhost:5173" },
      });
      expect(localhost.headers["access-control-allow-origin"]).toBe(
        "https://jobsearch.example.com",
      );
    });
  });
});
