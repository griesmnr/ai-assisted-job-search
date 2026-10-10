/**
 * Live-pool MEASUREMENT (ticket e5e1aa1) for one of that ticket's own
 * acceptance criteria: "Seattle keeps matching everything it matches
 * today — measured, not assumed."
 *
 * Ticket e5e1aa1 replaced `METRO_AREA_GROUPS` (two hand-curated metro
 * tables) with a 60-mile distance computed from a bundled city-coordinate
 * dataset (`cityCoordinates.ts`). The worry a "measured, not assumed"
 * acceptance criterion exists to catch: a rewrite of the matching engine
 * could easily regress the ONE metro that already had real, verified
 * coverage, even while fixing every city that had none.
 *
 * This fetches the live Greenhouse corpus ONCE and compares, against that
 * single snapshot, the OLD curated-table-style "Seattle" expansion (every
 * one of the deleted table's seven cities, reimplemented minimally here
 * since that table no longer exists in the source) against the NEW
 * `compileMetroAreaMatchers("Seattle")`. Comparing against one snapshot in
 * one process run — rather than a historical count from a different day —
 * is deliberate: the board's content changes between runs (same reasoning
 * as `verify-default-criteria-equivalence.ts`'s own doc comment), so "did
 * NEW regress relative to OLD" is only answerable by running both against
 * identical input.
 *
 * Both sides apply `compileFilter`'s own company|title dedupe (the first
 * version of this check, run ad hoc while implementing the ticket, didn't,
 * and reported 3 false "regressions" that turned out to be that
 * pre-existing, location-independent dedupe dropping a same-titled
 * duplicate posting at a different office — confirmed by inspecting
 * company+title duplicates directly. Replicating the dedupe here is what
 * makes the comparison apples-to-apples.)
 *
 * Real measurement, 2026-10-10 (25 configured Greenhouse boards, 6,603
 * postings fetched): strict "Seattle" (no expansion) = 239 deduped
 * survivors; OLD curated-table expansion = 380; NEW distance-based
 * expansion = 380, with ZERO jobs OLD matched that NEW misses and zero
 * added beyond OLD. That is a different (much larger) number than the
 * ticket's own "1 job -> 4" figure, because that figure was additionally
 * filtered by a specific title set ("John's title set") this script does
 * not apply — the two measurements are checking the same invariant
 * (expansion ⊇ strict, and OLD == NEW for Seattle specifically) at
 * different points in the pipeline, not reproducing each other's numbers.
 *
 * Usage (requires GREENHOUSE_BOARD_TOKENS in .env):
 *   npx tsx apps/api/src/scripts/verify-metro-radius-seattle-regression.ts
 */
import { compileMetroAreaMatchers } from "../sources/metroAreas.js";
import { createGreenhouseSourceFromEnv } from "../sources/greenhouse.js";
import type { NormalizedJob } from "../sources/types.js";

const OLD_SEATTLE_CITIES = [
  "seattle",
  "bellevue",
  "kirkland",
  "redmond",
  "renton",
  "everett",
  "tacoma",
];

function literalSeattle(location: string): boolean {
  return /\bseattle\b/i.test(location);
}

function oldCuratedTableMatch(location: string | null | undefined): boolean {
  if (!location) return false;
  return OLD_SEATTLE_CITIES.some((city) => new RegExp(`\\b${city}\\b`, "i").test(location));
}

/** The exact company|title dedupe `compileFilter` applies, replicated here
 * so both sides of the comparison see it -- see this file's top comment for
 * why that matters. */
function dedupeByCompanyTitle(jobs: NormalizedJob[]): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs.filter((j) => {
    const key = `${j.company}|${j.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function survivorKey(job: NormalizedJob): string {
  return `${job.dataSource}|${job.externalId}`;
}

async function main() {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));

  const source = createGreenhouseSourceFromEnv();
  console.log(`Fetching the full live pool from Greenhouse (this takes a while)...`);
  const result = await source.search({});
  console.log(`Fetched ${result.jobs.length} posting(s).`);

  const strict = dedupeByCompanyTitle(result.jobs.filter((j) => literalSeattle(j.location ?? "")));

  const oldExpanded = dedupeByCompanyTitle(
    result.jobs.filter((j) => literalSeattle(j.location ?? "") || oldCuratedTableMatch(j.location)),
  );

  const newMatchers = compileMetroAreaMatchers("Seattle");
  const newExpanded = dedupeByCompanyTitle(
    result.jobs.filter(
      (j) => literalSeattle(j.location ?? "") || newMatchers.some((m) => m(j.location ?? "")),
    ),
  );

  console.log(`\nStrict "Seattle" (no expansion): ${strict.length} survivor(s).`);
  console.log(`OLD curated-table-style expansion: ${oldExpanded.length} survivor(s).`);
  console.log(`NEW distance-based expansion:      ${newExpanded.length} survivor(s).`);

  const newKeys = new Set(newExpanded.map(survivorKey));
  const oldKeys = new Set(oldExpanded.map(survivorKey));
  const missingFromNew = oldExpanded.filter((j) => !newKeys.has(survivorKey(j)));
  const addedByNew = newExpanded.filter((j) => !oldKeys.has(survivorKey(j)));

  if (missingFromNew.length > 0) {
    console.error(`\nREGRESSION — ${missingFromNew.length} job(s) OLD matched that NEW misses:`);
    for (const j of missingFromNew) {
      console.error(`  [${j.dataSource}] ${j.company} -- ${j.title} (${j.location})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`\nNo regression: every job OLD matched, NEW matches too.`);
  console.log(
    `NEW additionally matches ${addedByNew.length} job(s) OLD missed (expected -- the 60-mile ` +
      `radius is strictly more generous than the old two-metro table):`,
  );
  for (const j of addedByNew.slice(0, 20)) {
    console.log(`  + [${j.dataSource}] ${j.company} -- ${j.title} (${j.location})`);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
