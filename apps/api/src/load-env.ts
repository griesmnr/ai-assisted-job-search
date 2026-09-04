/**
 * `process.loadEnvFile()` looks for `.env` relative to the CURRENT WORKING
 * DIRECTORY. That's a real file in local dev (`docker-compose.yml`'s `dev`
 * service also injects the same vars via `env_file`, so this is always
 * redundant-but-harmless there) but doesn't exist at all in a fresh git
 * worktree (nothing copies `.env`, a gitignored file, into one) or in CI/
 * production, where real env vars are injected directly and there is no
 * `.env` file anywhere on disk.
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
 */
export function loadEnvFile(): void {
  try {
    process.loadEnvFile?.();
  } catch (err) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
