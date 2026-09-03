import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";

// GET /sources never touches the database (see registerSourceRoutes) —
// a fake db is fine here, same reasoning as index.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = {} as any;

// checkSourceHealth() (sources/registry.ts) calls each createXSourceFromEnv
// with no argument, so it always reads live process.env — unlike those
// createXSourceFromEnv unit tests (sources/usajobs.test.ts etc.), which
// inject a fake env object directly and don't touch process.env at all.
// This route has no env parameter to inject into, so the only way to make
// its test deterministic is to control process.env ourselves: save the
// exact six vars the six sources read, force them to a known state before
// each test, and restore whatever was there before.
//
// Ticket 9a3b7f1: this test used to skip that step and assert directly on
// whatever this machine's real, gitignored .env happened to contain
// (USAJOBS_API_KEY/USAJOBS_USER_AGENT set, the other four absent). That
// passed locally but failed in real CI ("expected false to be true" on
// usajobs?.configured) because CI's workflow env: block has no way to know
// about a developer's local secrets. Env var names below are copied from
// each source file's createXSourceFromEnv, not guessed.
const ENV_VARS = [
  "USAJOBS_API_KEY",
  "USAJOBS_USER_AGENT",
  "GREENHOUSE_BOARD_TOKENS",
  "LEVER_COMPANIES",
  "ASHBY_BOARD_NAMES",
  "SMARTRECRUITERS_COMPANIES",
] as const;

let savedEnv: Record<(typeof ENV_VARS)[number], string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_VARS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_VARS)[number],
    string | undefined
  >;

  // usajobs: both required vars present -> configured.
  process.env.USAJOBS_API_KEY = "test-usajobs-key";
  process.env.USAJOBS_USER_AGENT = "test-runner@example.com";
  // greenhouse/lever/ashby/smartrecruiters: deliberately absent -> each
  // should report configured: false with its own "must be set" error.
  delete process.env.GREENHOUSE_BOARD_TOKENS;
  delete process.env.LEVER_COMPANIES;
  delete process.env.ASHBY_BOARD_NAMES;
  delete process.env.SMARTRECRUITERS_COMPANIES;
});

afterEach(() => {
  for (const key of ENV_VARS) {
    const original = savedEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

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

    // Env vars are set explicitly in beforeEach above, not read from this
    // machine's ambient .env — deterministic in CI and everywhere else.
    const usajobs = body.sources.find((s) => s.id === "usajobs");
    expect(usajobs?.configured).toBe(true);
    expect(usajobs?.error).toBeUndefined();

    const greenhouse = body.sources.find((s) => s.id === "greenhouse");
    expect(greenhouse?.configured).toBe(false);
    expect(greenhouse?.error).toMatch(/GREENHOUSE_BOARD_TOKENS/);

    const waState = body.sources.find((s) => s.id === "wa-state");
    expect(waState?.configured).toBe(false);
    expect(waState?.error).toBe("no adapter implemented yet");
  });
});
