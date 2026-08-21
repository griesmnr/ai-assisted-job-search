import { defineConfig } from "drizzle-kit";

// `npx drizzle-kit generate|migrate` (including `pnpm db:migrate`) runs
// with cwd = apps/api, but .env lives at the repo root. Without loading it
// explicitly, this file falls back to the `postgres`/`""` defaults below,
// which point at the docker-compose hostname and an empty password — wrong
// for a real POSTGRES_PASSWORD, and `db:migrate` then fails to authenticate
// from a clean shell that hasn't separately sourced .env. Anchored to this
// file's own URL (not cwd) so it works regardless of where it's invoked
// from.
process.loadEnvFile(new URL("../../.env", import.meta.url));

const {
  POSTGRES_USER = "jobsearch",
  POSTGRES_PASSWORD = "",
  POSTGRES_HOST = "postgres",
  POSTGRES_PORT = "5432",
  POSTGRES_DB = "jobsearch",
} = process.env;

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
  },
});
