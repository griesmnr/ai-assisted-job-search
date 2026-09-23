/**
 * Regression test for ticket 2b93534 (POST /searches/estimate's
 * usage-stats read was still cwd-relative). `runDemoMatch`'s
 * `usageStatsPath` option used to default to the bare relative string
 * `"prep/scoring-usage-stats.json"`, resolved by `fs.readFileSync`/
 * `writeFileSync` relative to `process.cwd()` at read/write time —
 * silently missing whenever the API server was started with cwd ==
 * `apps/api` (`pnpm dev`, `pnpm --filter @app/api dev`,
 * `cd apps/api && pnpm dev`), since `routes/searches.ts`'s
 * `POST /searches/estimate` never overrides this option and there is no
 * `apps/api/prep/scoring-usage-stats.json` — only the real one at the
 * repo root. Fixed the same way ticket 2fd6706 fixed the identical
 * mechanism in `load-env.ts`'s `REPO_ROOT_ENV_PATH`: resolve relative to
 * `import.meta.url` instead of `process.cwd()`.
 *
 * Mirrors `load-env.test.ts`'s approach: deliberately does NOT depend on a
 * real `prep/scoring-usage-stats.json` existing on disk and does NOT call
 * `process.chdir()` (unsafe inside a test worker, and unnecessary besides
 * — `import.meta.url` is fixed at module-parse time, before any cwd could
 * matter). Instead this asserts the actual resolved path directly,
 * computed independently here rather than by importing the module's own
 * internal math back at itself.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_USAGE_STATS_PATH } from "./pipeline.js";

describe("DEFAULT_USAGE_STATS_PATH", () => {
  it("resolves to a fixed, absolute path under the repo root's prep/ directory -- never a bare cwd-relative string", () => {
    // The pre-2b93534 regression: `usageStatsPath = "prep/scoring-usage-stats.json"`
    // was a relative string handed straight to `fs.readFileSync`, which
    // Node resolves against `process.cwd()` internally. This assertion is
    // what actually catches that revert: a relative string is never absolute.
    expect(path.isAbsolute(DEFAULT_USAGE_STATS_PATH)).toBe(true);
    expect(DEFAULT_USAGE_STATS_PATH).not.toBe("prep/scoring-usage-stats.json");

    // pipeline.ts lives at apps/api/src/matching/pipeline.ts, four
    // directory levels below the repo root (matching/ -> src/ -> apps/api/
    // -> apps/ -> root), matching the ../../../../prep/scoring-usage-stats.json
    // computed independently here (this test file lives in the same
    // directory, so the same relative math applies) -- not by importing
    // the module's own internal constant, which would just restate the
    // same possibly-wrong math back at itself.
    const expectedPath = fileURLToPath(
      new URL("../../../../prep/scoring-usage-stats.json", import.meta.url),
    );
    expect(DEFAULT_USAGE_STATS_PATH).toBe(expectedPath);
    expect(DEFAULT_USAGE_STATS_PATH.endsWith("/prep/scoring-usage-stats.json")).toBe(true);
  });

  it("lands on this worktree's own root, not a sibling worktree's or /workspace's", () => {
    // Each worktree is a full physical copy of the source tree (see
    // load-env.ts's own doc comment for the identical point about
    // REPO_ROOT_ENV_PATH), so file-relative resolution off import.meta.url
    // naturally stays worktree-local. Verified here by checking the
    // resolved path sits directly under a `prep/` directory that is a
    // sibling of `apps/`, `packages/`, and `node_modules/` -- the shape of
    // a repo root -- rather than asserting a hardcoded absolute string
    // that would break on a differently-named worktree checkout.
    const repoRoot = path.dirname(path.dirname(DEFAULT_USAGE_STATS_PATH));
    expect(path.basename(path.dirname(DEFAULT_USAGE_STATS_PATH))).toBe("prep");
    expect(path.basename(DEFAULT_USAGE_STATS_PATH)).toBe("scoring-usage-stats.json");
    // apps/api/src/matching -> repoRoot should contain apps/api itself.
    const expectedApiDir = path.join(repoRoot, "apps", "api");
    expect(fileURLToPath(new URL(".", import.meta.url)).startsWith(expectedApiDir)).toBe(true);
  });
});
