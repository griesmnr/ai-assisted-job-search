/**
 * Live-pool proof (ticket 59fdc52 review round 2): asserts that
 * `compileFilter(undefined)` — what `POST /searches` and `POST
 * /searches/estimate` actually run when a caller supplies no `criteria` —
 * produces an IDENTICAL survivor set to `filterSoftwareEngineeringJobs`
 * (the CLI's filter), over the same real, live Greenhouse pool. Not a
 * fixture, not an approximation: the PM ruling was explicit that "if they
 * differ by one posting, the default is wrong."
 *
 * Deliberately a standalone script, not a vitest test that runs on every
 * `rtk vitest` — it fetches thousands of real postings from a real network
 * host (boards-api.greenhouse.io), which has no place running on every CI
 * invocation (slow, flaky under rate limits, and offline dev loses `pnpm
 * test` entirely). Same reasoning as the existing check-*-board.ts scripts
 * in this directory. `compileFilter(undefined)` is unit-tested for
 * function-identity against `filterSoftwareEngineeringJobs` in
 * sources/criteria.test.ts (fast, offline, runs every time) — this script
 * is the live-data confirmation that the identity actually produces the
 * numbers the review measured, run manually and pasted into the ticket/PR.
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
    `\nIDENTICAL survivor sets (${viaLegacyFilter.length} postings, same ${legacyKeys.length} keys).`,
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
