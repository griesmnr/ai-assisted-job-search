import { defineConfig } from "drizzle-kit";
import { loadEnvFile } from "./src/load-env.js";

// `npx drizzle-kit generate|migrate` (including `pnpm db:migrate`) runs
// with cwd = apps/api, but .env lives at the repo root. Without loading it
// explicitly, this file falls back to the `postgres`/`""` defaults below,
// which point at the docker-compose hostname and an empty password — wrong
// for a real POSTGRES_PASSWORD, and `db:migrate` then fails to authenticate
// from a clean shell that hasn't separately sourced .env.
//
// Ticket 17d14b1 (opus review, F1, BLOCKER): this used to call
// `process.loadEnvFile()` directly, unguarded -- which throws ENOENT when
// `.env` doesn't exist, true by design in a git worktree, in CI, and in
// the production Docker image (no `.env` is ever baked into that image;
// real env vars are injected directly). `deploy/api.Dockerfile`'s CMD is
// `drizzle-kit migrate && node dist/index.js`, so that throw crash-looped
// the container before it ever started the server -- reproduced live by
// the review, confirmed by AC1/AC3 failing. `load-env.ts`'s `loadEnvFile`
// is the SAME guard `apps/api/src/index.ts` and both workers already use
// for exactly this reason (tickets 2b54470, 2fd6706) -- this was the one
// remaining unguarded caller.
loadEnvFile();

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
