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
  },
});
