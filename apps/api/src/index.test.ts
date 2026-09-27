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

    function buildAppUnderTest() {
      return buildApp({
        db: fakeDb,
        inferTitles: async () => [],
        getScoreJob: () => {
          throw new Error("not used by this test");
        },
      });
    }

    it("falls back to the localhost-only regex when unset, unchanged from before this ticket", async () => {
      delete process.env.CORS_ALLOWED_ORIGIN;
      const app = buildAppUnderTest();
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

    // Opus review round 1, F2 (BLOCKER, verified live): a set-but-blank
    // value is not the same as unset, and `??` alone let it through as a
    // real origin string -- @fastify/cors then 500'd every request, since
    // "" isn't a value it accepts. This is the exact state the README's
    // own Railway walkthrough invites on the very first deploy (create the
    // variable before `web`'s real URL exists, fill it in later). Round 2
    // review, R3: the LITERAL empty string is what actually reproduced the
    // 500 against the pre-fix code (a whitespace-only value happened not
    // to, by accident of what @fastify/cors does with it) -- both are
    // covered explicitly below rather than relying on one to stand in for
    // the other.
    it("falls back to the dev regex, rather than 500ing, when set to an empty string", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "";
      const app = buildAppUnderTest();
      const response = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "http://localhost:5173" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });

    it("falls back to the dev regex when set to only whitespace", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "   ";
      const app = buildAppUnderTest();
      const response = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "http://localhost:5173" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    });

    // Opus review round 1, F9 (verified live), corrected by round 2's
    // measurement (R2): a value copied out of a browser's address bar
    // commonly carries a trailing slash, which a browser's own `Origin`
    // header never has -- but round 2 measured that the UNSTRIPPED value
    // does NOT 500 (`@fastify/cors` happily echoes it as a static string);
    // it silently fails the BROWSER's own same-string comparison instead,
    // since the response header then never matches the page's real
    // Origin. Same practical failure (frontend can't call the API),
    // different mechanism than F2's blank-value 500 above.
    it("strips a trailing slash from a configured origin", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "https://jobsearch.example.com/";
      const app = buildAppUnderTest();
      const response = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "https://jobsearch.example.com" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("https://jobsearch.example.com");
    });

    it("echoes the configured origin regardless of the caller's actual Origin header", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "https://jobsearch.example.com";
      const app = buildAppUnderTest();
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
      // stops a BROWSER from trusting the response, since the header no
      // longer matches the page's own origin. The dev-time regex must NOT
      // additionally kick in once a real origin is configured.
      //
      // Opus review, F10: this is protection for a browser specifically,
      // not a server-side allowlist -- the handler still runs and returns
      // its real body to a mismatched Origin (this app has no other
      // request authentication; see the x-user-id header's own documented
      // trust level in identity.ts). A non-browser client that doesn't
      // enforce CORS at all is unaffected by this header either way; that
      // gap is tracked by tickets 3fc1e5e/9f06f8f's identity work, not
      // this one.
      const mismatched = await app.inject({
        method: "GET",
        url: "/sources",
        headers: { origin: "http://localhost:5173" },
      });
      expect(mismatched.statusCode).toBe(200);
      expect(mismatched.headers["access-control-allow-origin"]).toBe(
        "https://jobsearch.example.com",
      );
    });
  });
});
