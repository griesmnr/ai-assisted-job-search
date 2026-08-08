import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["{apps,packages}/*/src/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**"],
    passWithNoTests: false,
  },
});
