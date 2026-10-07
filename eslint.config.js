import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.tsbuildinfo",
      ".rtk/**",
      ".worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Ticket 9c78da1: plain Node scripts (not part of either app's TS
    // program, so they get no `@types/node` ambient globals the way
    // apps/api's and apps/web's own .ts files do). This project has no
    // other `.mjs`/`.cjs` yet -- when the next one lands, widen this glob
    // rather than adding a second near-identical block.
    //
    // `document`/`getComputedStyle` are here too: layout-check.mjs's
    // `page.evaluate(() => ...)` callbacks are SOURCE TEXT ESLint parses
    // like any other function in the file, even though Playwright actually
    // serializes and runs them inside the browser page, not this Node
    // process -- so without these, `no-undef` reads them as this script's
    // own undefined Node globals.
    files: ["**/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        document: "readonly",
        getComputedStyle: "readonly",
      },
    },
  },
  eslintConfigPrettier,
);
