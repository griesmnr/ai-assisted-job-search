/**
 * Regression test for ticket 2fd6706 (opus review's own recommendation:
 * the bug this ticket fixed had already recurred once in this exact file
 * -- ticket 2b54470 fixed the ENOENT crash, but left the underlying
 * cwd-dependence in place, which is what 2fd6706 then had to fix for
 * real). Without this test, reverting `loadEnvFile()`'s
 * `process.loadEnvFile?.(REPO_ROOT_ENV_PATH)` back to a bare
 * `process.loadEnvFile?.()` passes the entire rest of the suite: vitest
 * itself always runs with the repo root as cwd, where `.env` genuinely
 * exists, so both the fixed and the broken form happen to load the same
 * file when the tests are the ones running them.
 *
 * Deliberately does NOT depend on a real `.env` existing on disk (CI has
 * none -- see this file's own module doc comment on `loadEnvFile` for why)
 * and does NOT call `process.chdir()` (chdir requires a real filesystem
 * cwd, isn't always safe inside a test worker, and is unnecessary here
 * besides): the regression is entirely about WHAT PATH gets passed to
 * `process.loadEnvFile`, which is fixed before that function ever runs,
 * regardless of the caller's actual cwd. Intercepting the call directly
 * proves the fix without needing to fake cwd or touch a real file.
 */
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile } from "./load-env.js";

describe("loadEnvFile", () => {
  const original = process.loadEnvFile;
  afterEach(() => {
    process.loadEnvFile = original;
  });

  it("passes an explicit, fixed repo-root .env path to process.loadEnvFile -- never relies on process.cwd()", () => {
    const calls: unknown[] = [];
    process.loadEnvFile = ((path?: unknown) => {
      calls.push(path);
    }) as typeof process.loadEnvFile;

    loadEnvFile();

    expect(calls).toHaveLength(1);
    // The pre-2fd6706 regression: `process.loadEnvFile?.()` with NO
    // argument -- Node then resolves `.env` relative to `process.cwd()`
    // internally. This assertion is what actually catches that revert:
    // `calls[0]` would be `undefined`, not a URL.
    expect(calls[0]).toBeInstanceOf(URL);

    // The path must resolve to `.env` directly in the repo root -- this
    // file lives at apps/api/src/load-env.ts, three directory levels
    // below the repo root (src/ -> apps/api/ -> apps/ -> root), matching
    // the ../../../.env computed independently here (not by importing the
    // module's own internal constant, which would just restate the same
    // possibly-wrong math back at itself).
    const expectedRepoRootEnv = fileURLToPath(new URL("../../../.env", import.meta.url));
    const actualPath = fileURLToPath(calls[0] as URL);
    expect(actualPath).toBe(expectedRepoRootEnv);
    expect(actualPath.endsWith("/.env")).toBe(true);
  });

  it("still guards ENOENT (ticket 2b54470's original fix), now against the fixed path rather than a cwd-relative one", () => {
    process.loadEnvFile = (() => {
      const err = new Error("no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }) as typeof process.loadEnvFile;

    expect(() => loadEnvFile()).not.toThrow();
  });

  it("still rethrows a non-ENOENT error (ticket 2b54470's original fix)", () => {
    process.loadEnvFile = (() => {
      throw new Error("permission denied");
    }) as typeof process.loadEnvFile;

    expect(() => loadEnvFile()).toThrow("permission denied");
  });
});
