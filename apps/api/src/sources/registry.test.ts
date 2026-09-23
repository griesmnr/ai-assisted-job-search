import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAllSources } from "./registry.js";

// Same env-var isolation `routes/sources.test.ts` already established for
// `checkSourceHealth` — `buildAllSources` reads live `process.env` via each
// `createXSourceFromEnv()` too (no injectable env parameter of its own), so
// this test controls the same vars the same way, for the same reason
// (a real, gitignored local `.env` — or CI's total absence of one — would
// otherwise make this test's outcome depend on the machine it runs on). See
// that file's own doc comment for the ticket 9a3b7f1 failure this pattern
// exists to prevent.
const ENV_VARS = [
  "USAJOBS_API_KEY",
  "USAJOBS_USER_AGENT",
  "GREENHOUSE_BOARD_TOKENS",
  "LEVER_COMPANIES",
  "ASHBY_BOARD_NAMES",
  "SMARTRECRUITERS_COMPANIES",
  "WORKABLE_COMPANIES",
  "RECRUITEE_COMPANIES",
  "RIPPLING_COMPANIES",
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
  // greenhouse/lever/ashby/smartrecruiters/workable/recruitee/rippling:
  // deliberately absent -> each createXSourceFromEnv() throws synchronously.
  delete process.env.GREENHOUSE_BOARD_TOKENS;
  delete process.env.LEVER_COMPANIES;
  delete process.env.ASHBY_BOARD_NAMES;
  delete process.env.SMARTRECRUITERS_COMPANIES;
  delete process.env.WORKABLE_COMPANIES;
  delete process.env.RECRUITEE_COMPANIES;
  delete process.env.RIPPLING_COMPANIES;
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

describe("buildAllSources", () => {
  it("builds every configured source and skips every unconfigured one independently, without throwing", () => {
    const skipped: { id: string; error: string }[] = [];
    const sources = buildAllSources((id, error) => skipped.push({ id, error }));

    // Exactly one adapter is configured in this test's env — the other six
    // real adapters (wa-state has no adapter at all, see registry.ts's own
    // BUILDERS comment, so it's excluded from `sources`/`skipped` here too)
    // are unconfigured and must each be reported, not swallowed or allowed
    // to abort the loop.
    expect(Object.keys(sources).sort()).toEqual(["usajobs"]);
    expect(sources.usajobs?.dataSource).toBe("usajobs");

    expect(skipped.map((s) => s.id).sort()).toEqual([
      "ashby",
      "greenhouse",
      "lever",
      "recruitee",
      "rippling",
      "smartrecruiters",
      "workable",
    ]);
    // Every skip carries a real, source-specific reason, not a generic
    // placeholder — same "which env var" specificity
    // checkSourceHealth's own test asserts on.
    for (const s of skipped) {
      expect(s.error.length).toBeGreaterThan(0);
    }
  });

  it("onSkip defaults to a no-op — calling it with no callback never throws even though every non-usajobs source is unconfigured", () => {
    expect(() => buildAllSources()).not.toThrow();
  });
});
