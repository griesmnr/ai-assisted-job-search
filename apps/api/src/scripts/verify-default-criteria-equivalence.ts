/**
 * Live-pool MEASUREMENT (ticket 59fdc52 review round 2, softened per review
 * round 3 N4) — NOT the equivalence proof. `compileFilter(undefined)`
 * returns `filterSoftwareEngineeringJobs` itself (same function object,
 * asserted with `toBe` in sources/criteria.test.ts), so calling both
 * "paths" below on the identical `jobs` array can only ever print
 * IDENTICAL — there is no code path by which this script could observe a
 * divergence, because there is only one function running, not two. That
 * `toBe` test (fast, offline, runs on every `rtk vitest`) is the real,
 * permanent guarantee that the default can never silently drift from the
 * CLI's filter; this script cannot regress-test that guarantee and isn't
 * trying to.
 *
 * What this script IS for: real numbers against the live pool — how many
 * postings a real `GREENHOUSE_BOARD_TOKENS` fetch returns today, how many
 * survive, and a sample of what survived — the same measurement the review
 * itself used (6,230 fetched / 166 survivors on one run; 6,194 / 164 on a
 * later re-run, the board being live and changing between them). Useful for
 * pasting real, dated numbers into a ticket/PR when the underlying pool or
 * filter logic changes; not a CI-run regression test.
 *
 * Deliberately a standalone script, not a vitest test that runs on every
 * `rtk vitest` — it fetches thousands of real postings from a real network
 * host (boards-api.greenhouse.io), which has no place running on every CI
 * invocation (slow, flaky under rate limits, and offline dev loses `pnpm
 * test` entirely). Same reasoning as the existing check-*-board.ts scripts
 * in this directory.
 *
 * Usage (requires GREENHOUSE_BOARD_TOKENS in .env — see .env.example for
 * the documented default 25-token list):
 *   npx tsx apps/api/src/scripts/verify-default-criteria-equivalence.ts
 */
import { compileFilter } from "../sources/criteria.js";
import { createGreenhouseSourceFromEnv } from "../sources/greenhouse.js";
import { filterSoftwareEngineeringJobs } from "../sources/swe-filter.js";
import type { NormalizedJob } from "../sources/types.js";

function survivorKey(job: NormalizedJob): string {
  return `${job.dataSource}|${job.externalId}`;
}

async function main() {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));

  const source = createGreenhouseSourceFromEnv();
  console.log(`Fetching the full live pool from Greenhouse (this takes a while)...`);
  const result = await source.search({});
  console.log(
    `Fetched ${result.jobs.length} posting(s), ${result.skipped.length} skipped ` +
      `(skipRate ${result.skipRate.toFixed(4)}).`,
  );

  const viaLegacyFilter = filterSoftwareEngineeringJobs(result.jobs);
  const viaCompiledDefault = compileFilter(undefined)(result.jobs);

  const legacyKeys = viaLegacyFilter.map(survivorKey).sort();
  const compiledKeys = viaCompiledDefault.map(survivorKey).sort();

  console.log(`\nfilterSoftwareEngineeringJobs directly: ${viaLegacyFilter.length} survivor(s).`);
  console.log(
    `compileFilter(undefined) (the API's default): ${viaCompiledDefault.length} survivor(s).`,
  );

  // This can only ever be true today (see the top-of-file comment) — kept
  // as a canary, not a proof: if `compileFilter`'s `undefined` branch is
  // ever changed to something other than a direct return of
  // `filterSoftwareEngineeringJobs`, THIS check (unlike the `toBe` test,
  // which would simply start failing loudly in CI) is what would catch a
  // divergence in a manual run of this script specifically.
  const identical = JSON.stringify(legacyKeys) === JSON.stringify(compiledKeys);
  if (!identical) {
    const legacySet = new Set(legacyKeys);
    const compiledSet = new Set(compiledKeys);
    const onlyLegacy = legacyKeys.filter((k) => !compiledSet.has(k));
    const onlyCompiled = compiledKeys.filter((k) => !legacySet.has(k));
    console.error(`\nMISMATCH — the default is NOT exact.`);
    console.error(`  Only in filterSoftwareEngineeringJobs (${onlyLegacy.length}):`, onlyLegacy);
    console.error(`  Only in compileFilter(undefined) (${onlyCompiled.length}):`, onlyCompiled);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nIdentical survivor sets, as they always will be (${viaLegacyFilter.length} postings, ` +
      `same ${legacyKeys.length} keys) — see this file's top comment for what that does and ` +
      `doesn't prove. The pool numbers above are today's real measurement.`,
  );
  console.log(`\nSample of what survived (first 10):`);
  for (const j of viaLegacyFilter.slice(0, 10)) {
    console.log(`  ${j.title} — ${j.company} (${j.location ?? "no location"})`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
