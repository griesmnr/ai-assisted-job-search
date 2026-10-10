import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Tests must exercise current source, not a possibly-stale `dist/`.
      // Without this, `@app/shared`'s package.json main/exports resolve to
      // dist/index.js, so `rtk vitest` fails on a fresh clone (no build yet)
      // and `vitest --watch` silently tests old compiled output after an
      // edit to packages/shared/src.
      "@app/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["{apps,packages}/*/src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**"],
    passWithNoTests: false,
    // Raised from vitest's 5000ms default, 2026-10-10, after two separate
    // files flaked on `main` within one hour for the same reason.
    //
    // Many tests here drive a REAL async flow rather than a pure function:
    // App renders under jsdom, SearchFlow's real `setInterval` poll
    // (POLL_INTERVAL_MS = 2000ms), awaited fetch mocks, DB-backed route
    // tests. Under a full-suite run those legitimately exceed 5000ms --
    // measured failures at 6357ms and 8100ms in App.scoredJobCount.test.tsx,
    // and App.searchComplete.test.tsx could spend 3000ms waiting for a poll
    // tick plus another 3000ms for the completion heading, i.e. over budget
    // by arithmetic before load was even a factor. Each passed in isolation
    // and failed in the suite, which is the worst shape of flake: the gate
    // goes green by luck of scheduling.
    //
    // 15000ms is not a new number -- it is what SearchFlow.test.tsx already
    // set per-test (`}, 15000)`) for exactly this reason. Making it the
    // default stops the whack-a-mole: a new test file cannot inherit a
    // too-tight default and reintroduce the flake, which is how the second
    // file got there.
    //
    // A passing test does not consume its timeout, so this costs nothing on
    // a green run. The real trade is that a genuinely HUNG test now takes
    // 15s to report instead of 5s, against a suite that already runs ~100s.
    testTimeout: 15000,
  },
});
