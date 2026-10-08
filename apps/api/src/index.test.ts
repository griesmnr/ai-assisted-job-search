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

  // Ticket 6e7008e. Every test above this point uses GET, which is a CORS
  // "simple" method and therefore always allowed -- so the whole suite passed
  // while both of the app's non-simple methods were blocked in every browser.
  // These tests exist to close that specific blind spot.
  //
  // They assert on `access-control-allow-methods`, NOT on the preflight's
  // status code, and that distinction is the entire point: the broken
  // configuration returned a perfectly healthy 204 with the origin echoed and
  // the headers allowed. A test asserting `statusCode === 204` passes against
  // the bug. The method list is the only thing that moved.
  describe("CORS preflight allows the app's non-simple methods (ticket 6e7008e)", () => {
    const ORIGINAL = process.env.CORS_ALLOWED_ORIGIN;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.CORS_ALLOWED_ORIGIN;
      else process.env.CORS_ALLOWED_ORIGIN = ORIGINAL;
    });

    const ORIGIN = "https://jobsearch.example.com";

    function preflight(app: ReturnType<typeof buildApp>, method: string, url: string) {
      return app.inject({
        method: "OPTIONS",
        url,
        headers: {
          origin: ORIGIN,
          // Mirrors what `api/client.ts`'s shared `request()` helper actually
          // sends on every call, so the preflight under test is the one a
          // browser really issues rather than a simplified stand-in.
          "access-control-request-method": method,
          "access-control-request-headers": "content-type,x-user-id",
        },
      });
    }

    function buildAppUnderTest() {
      return buildApp({
        db: fakeDb,
        inferTitles: async () => [],
        getScoreJob: () => {
          throw new Error("not used by this test");
        },
      });
    }

    // DELETE /jobs/:id/status -- unsaving a job (api/client.ts's
    // `clearJobStatus`). This is the call Nicole reproduced failing on the
    // deployed app as "Could not reach the API ... Failed to fetch".
    it("permits DELETE, which unsaving a job depends on", async () => {
      process.env.CORS_ALLOWED_ORIGIN = ORIGIN;
      const response = await preflight(buildAppUnderTest(), "DELETE", "/jobs/abc/status");
      expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    });

    // PATCH /resumes/:id -- renaming a resume (routes/resumes.ts). Had no UI
    // caller when this was found, which is the only reason it was never
    // reported; ticket e7666de wires it up.
    it("permits PATCH, which renaming a resume depends on", async () => {
      process.env.CORS_ALLOWED_ORIGIN = ORIGIN;
      const response = await preflight(buildAppUnderTest(), "PATCH", "/resumes/abc");
      expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    });

    // The methods are configured as a flat option, independent of how
    // `origin` resolves -- so the localhost-regex dev branch must allow them
    // too. Local dev is genuinely cross-origin (5173 -> the API port; there
    // is no Vite proxy), so a developer hits the same wall Nicole did.
    it("permits them on the localhost dev branch too, not just a configured origin", async () => {
      delete process.env.CORS_ALLOWED_ORIGIN;
      const app = buildAppUnderTest();
      const response = await app.inject({
        method: "OPTIONS",
        url: "/jobs/abc/status",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "DELETE",
          "access-control-request-headers": "content-type,x-user-id",
        },
      });
      expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
    });

    // TICKET fb00e02 — THE TEST THAT SHOULD HAVE EXISTED ALL ALONG.
    //
    // Every other CORS test in this file names a verb by hand. That is why
    // this file was fully green while the deployed app could not save a
    // resume edit: ticket 6ba221e added `PUT /resumes/:id/text` and nothing
    // tied the `methods` allowlist to the routes, so the missing verb was
    // invisible to the suite. The browser was told PUT was not allowed,
    // never sent the request, and the server logs were empty because
    // nothing arrived.
    //
    // This asserts the RELATIONSHIP instead of a list: enumerate what the
    // app actually registers, and require each of those verbs to appear in
    // `Access-Control-Allow-Methods`. It fails the moment a route is added
    // with a verb nobody allowed — including the next one.
    //
    // OPTIONS is excluded deliberately: `@fastify/cors` registers its own
    // preflight handler and answers OPTIONS itself, so it shows up in the
    // route table but must not appear in the allowlist (browsers never ask
    // permission for the preflight verb).
    it("allows every HTTP method the app actually registers (ticket fb00e02)", async () => {
      process.env.CORS_ALLOWED_ORIGIN = "https://jobsearch.example.com";
      const app = buildAppUnderTest();
      await app.ready();

      const registered = new Set<string>();
      for (const match of app.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g)) {
        for (const verb of match[1]!.split(",")) {
          const trimmed = verb.trim();
          if (trimmed !== "OPTIONS") registered.add(trimmed);
        }
      }
      // Sanity-check the enumeration itself, so a parsing change that
      // silently yields an empty set cannot make this test vacuous.
      expect(registered.size).toBeGreaterThanOrEqual(5);
      expect(registered.has("PUT")).toBe(true);

      const preflight = await app.inject({
        method: "OPTIONS",
        url: "/resumes/abc/text",
        headers: {
          origin: "https://jobsearch.example.com",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type,x-user-id",
        },
      });
      const allowed = (preflight.headers["access-control-allow-methods"] ?? "")
        .toString()
        .split(",")
        .map((verb) => verb.trim());

      for (const verb of [...registered].sort()) {
        expect(allowed, `${verb} is registered as a route but missing from CORS methods`).toContain(
          verb,
        );
      }
    });

    // Guards the other direction: the explicit list must not have been    // Guards the other direction: the explicit list must not have been
    // written so broadly that it stops meaning anything. PUT is not served by
    // this API, so it should not be advertised.
    // The symmetric half of the fb00e02 test above: the allowlist must not
    // advertise a verb the app does not serve either. Originally (ticket
    // 6e7008e) this asserted `not.toContain("PUT")` — correct then, and
    // WRONG the moment 6ba221e added `PUT /resumes/:id/text`, which is how
    // this test came to fail on a legitimate fix. Hardcoding a verb in
    // either direction is the mistake; both halves now derive from the
    // routes, so neither goes stale when the route table changes.
    it("does not advertise methods the API does not serve (ticket 6e7008e, generalised by fb00e02)", async () => {
      process.env.CORS_ALLOWED_ORIGIN = ORIGIN;
      const app = buildAppUnderTest();
      await app.ready();

      const registered = new Set<string>();
      for (const match of app.printRoutes({ commonPrefix: false }).matchAll(/\(([A-Z, ]+)\)/g)) {
        for (const verb of match[1]!.split(",")) registered.add(verb.trim());
      }
      expect(registered.size).toBeGreaterThanOrEqual(5);

      const response = await preflight(app, "GET", "/sources");
      const allowed = (response.headers["access-control-allow-methods"] ?? "")
        .toString()
        .split(",")
        .map((verb) => verb.trim())
        .filter((verb) => verb.length > 0);
      expect(allowed.length).toBeGreaterThan(0);

      for (const verb of allowed) {
        expect(registered.has(verb), `CORS advertises ${verb} but no route registers it`).toBe(
          true,
        );
      }
    });
  });
});
