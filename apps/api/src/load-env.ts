/**
 * BEFORE ticket 2fd6706 (see that ticket's own paragraph below for the
 * full story): `process.loadEnvFile()` looked for `.env` relative to the
 * CURRENT WORKING DIRECTORY, not any fixed project location. That's a real
 * file in local dev (`docker-compose.yml`'s `dev` service also injects the
 * same vars via `env_file`, so this is always redundant-but-harmless
 * there) but doesn't exist at all in a fresh git worktree (nothing copies
 * `.env`, a gitignored file, into one) or in CI/production, where real env
 * vars are injected directly and there is no `.env` file anywhere on disk.
 *
 * Ticket 2b54470: an unguarded `process.loadEnvFile()` at a file's top
 * level throws ENOENT in exactly those cases -- and for a file imported by
 * many test files (apps/api/src/db/test-db.ts), that throw crashes every
 * importer at MODULE LOAD time, which vitest counts as a failed SUITE, not
 * a failed test -- contributing NOTHING to its own "N tests passed" tally.
 * Confirmed live: 10 of 32 test files crashed this way in a worktree with
 * no `.env`, invisible in both `npx vitest run`'s and `rtk vitest run`'s
 * top summary lines. This was independently duplicated (copy-pasted, not
 * shared) across 13 files before this ticket; centralized here so the
 * fix can't silently drift out of a 14th new file the same way.
 *
 * A missing `.env` is never an error here: it means there's nothing extra
 * to add on top of whatever's already in `process.env`, not that the
 * environment is broken.
 *
 * Ticket 2fd6706: the original fix above still called
 * `process.loadEnvFile()` with NO PATH ARGUMENT, which meant it *still*
 * resolved `.env` relative to `process.cwd()` -- just now without crashing
 * when that lookup missed. That's silent, not fixed: `pnpm --filter
 * @app/api dev`, root `pnpm dev` (which runs each workspace package's
 * script with THAT package's own directory as cwd), and `cd apps/api &&
 * pnpm dev` all run with cwd = apps/api, so they were all silently loading
 * nothing and falling through to whatever was already in `process.env`
 * (confirmed live: Postgres then falls back to the OS username, producing
 * `error: role "dev" does not exist` instead of ever reading
 * `POSTGRES_USER`/`PASSWORD`/`DB`). There is exactly one `.env`, at the
 * repo root, for the whole monorepo -- so the correct fix is to stop
 * depending on `process.cwd()` at all and instead resolve `.env` relative
 * to THIS FILE's own location via `import.meta.url`, which Node fixes at
 * module-load time regardless of the caller's cwd. This file lives at
 * `apps/api/src/load-env.ts`, three directory levels below the repo root
 * (`src/` -> `apps/api/` -> `apps/` -> repo root), hence `../../../.env`.
 * Verified directly (not just reasoned about): resolving that path from
 * this worktree lands on `<this worktree's own root>/.env`, not
 * `/workspace/.env` -- each worktree is a full physical copy of the
 * source tree, so file-relative resolution naturally stays worktree-local
 * with no extra handling needed.
 */
const REPO_ROOT_ENV_PATH = new URL("../../../.env", import.meta.url);

export function loadEnvFile(): void {
  try {
    process.loadEnvFile?.(REPO_ROOT_ENV_PATH);
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
