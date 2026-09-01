import { describe, expect, it } from "vitest";
import { buildApp } from "../index.js";

// Node 22 can read .env itself — no dotenv dependency needed. Explicit here
// (not just relying on demo-match.ts's own module-level call, which "../
// index.js" transitively triggers) so this test's env dependency is
// self-documenting — same pattern demo-match.test.ts uses.
process.loadEnvFile();

// GET /sources never touches the database (see registerSourceRoutes) —
// a fake db is fine here, same reasoning as index.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = {} as any;

describe("GET /sources", () => {
  it("lists all six known sources, each reporting configured status from env", async () => {
    const app = buildApp({
      db: fakeDb,
      getScoreJob: () => {
        throw new Error("not used by this test");
      },
    });

    const response = await app.inject({ method: "GET", url: "/sources" });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      sources: Array<{ id: string; displayName: string; configured: boolean; error?: string }>;
    };
    expect(body.sources).toHaveLength(6);
    const ids = body.sources.map((s) => s.id).sort();
    expect(ids).toEqual(
      ["ashby", "greenhouse", "lever", "smartrecruiters", "usajobs", "wa-state"].sort(),
    );

    // .env (this repo's real dev config) sets USAJOBS_API_KEY/USER_AGENT
    // but none of GREENHOUSE_BOARD_TOKENS/LEVER_COMPANIES/
    // ASHBY_BOARD_NAMES/SMARTRECRUITERS_COMPANIES — asserting on that real,
    // current env state (not a mock) is deliberate: this route's whole job
    // is to report exactly that kind of misconfiguration truthfully.
    const usajobs = body.sources.find((s) => s.id === "usajobs");
    expect(usajobs?.configured).toBe(true);
    expect(usajobs?.error).toBeUndefined();

    const waState = body.sources.find((s) => s.id === "wa-state");
    expect(waState?.configured).toBe(false);
    expect(waState?.error).toBe("no adapter implemented yet");
  });
});
