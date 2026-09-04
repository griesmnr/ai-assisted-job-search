import { describe, expect, it } from "vitest";
import { ping } from "@app/shared";
import { buildApp } from "./index.js";

// A minimal fake db satisfies BuildAppDeps's type without needing a real
// Postgres connection just to prove buildApp wires routes up — the routes
// this test actually exercises (GET /sources) never touch `db`. Route
// behavior that DOES touch the database is covered by routes/*.test.ts
// against a real Postgres instance, matching this codebase's existing
// integration-test convention (see demo-match.test.ts, db/schema.test.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = {} as any;

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
});
