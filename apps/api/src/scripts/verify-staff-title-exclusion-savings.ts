/**
 * Live-pool MEASUREMENT for ticket 6b2313a — "excluded by default" applied
 * to `staff`/`distinguished`/`fellow` titles via swe-filter.ts's `NOT`
 * regex (see that file's own doc comment on `NOT` for the full change).
 * Same convention as verify-default-criteria-equivalence.ts (read that
 * file's top comment first): fetch the real live Greenhouse pool once, and
 * compare survivor counts under the OLD `NOT` (pre-ticket, no staff
 * exclusion) against the CURRENT `NOT` (post-ticket, imported directly from
 * swe-filter.ts — never re-typed here, so this can't silently drift from
 * the shipped regex) on the identical fetched pool.
 *
 * Deliberately does NOT call the Claude scoring API — that would spend real
 * money and this ticket's acceptance criteria explicitly forbid it. The
 * "nothing scoring >=55% is lost" claim rests on the ALREADY-established
 * historical measurement in the ticket body (200 jobs scored 2026-08-31:
 * STAFF/PRINCIPAL/etc titles best 52%, median 22%, against a 55% floor) —
 * this script only re-confirms, on TODAY's live pool, how many additional
 * postings the new exclusion actually removes and samples their titles so
 * that claim can be sanity-checked against real, current titles rather than
 * only the one historical snapshot.
 *
 * Usage (requires GREENHOUSE_BOARD_TOKENS in .env):
 *   npx tsx apps/api/src/scripts/verify-staff-title-exclusion-savings.ts
 */
import { createGreenhouseSourceFromEnv } from "../sources/greenhouse.js";
import { filterSoftwareEngineeringJobs, passesLocationFilter } from "../sources/swe-filter.js";
import type { NormalizedJob } from "../sources/types.js";

// The pre-ticket NOT regex, copied verbatim from swe-filter.ts's git history
// (the version this file had immediately before ticket 6b2313a) — NOT
// imported, since the whole point is to diff against what shipped before
// this change existed. `principal` was already here; `staff`, `distinguished`,
// and `fellow` were not.
const OLD_NOT =
  /\b(manager|director|principal|sales|marketing|recruit(ing|ment|ers?|s)?|intern(ships?|s)?|designer|field service|machine learning|data scientist)\b/i;

const SOFTWARE =
  /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;

function survivorKey(job: NormalizedJob): string {
  return `${job.dataSource}|${job.externalId}`;
}

/** Reproduces filterSoftwareEngineeringJobs's own pipeline (SOFTWARE, then
 * NOT, then location, then company|title dedupe) but with a swapped-in NOT
 * regex — everything else identical to the shipped filter, so the ONLY
 * variable between "old" and "new" survivor sets is the NOT regex itself. */
function filterWithNot(jobs: NormalizedJob[], not: RegExp): NormalizedJob[] {
  const seen = new Set<string>();
  return jobs
    .filter((j) => SOFTWARE.test(j.title) && !not.test(j.title))
    .filter((j) => passesLocationFilter(j))
    .filter((j) => {
      const key = `${j.company}|${j.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

  const before = filterWithNot(result.jobs, OLD_NOT);
  // filterSoftwareEngineeringJobs is the SHIPPED function post-ticket — not
  // re-derived here, so "after" always reflects whatever NOT actually is in
  // swe-filter.ts right now, not a copy that could drift.
  const after = filterSoftwareEngineeringJobs(result.jobs);

  const beforeKeys = new Set(before.map(survivorKey));
  const afterKeys = new Set(after.map(survivorKey));
  const removed = before.filter((j) => !afterKeys.has(survivorKey(j)));
  const added = after.filter((j) => !beforeKeys.has(survivorKey(j)));

  console.log(`\nBEFORE (old NOT, no staff/distinguished/fellow): ${before.length} survivor(s).`);
  console.log(`AFTER  (current NOT, this ticket's change):      ${after.length} survivor(s).`);
  console.log(`Removed by the new exclusion: ${removed.length}`);
  if (added.length > 0) {
    // Should never happen — the new NOT is old NOT plus more alternatives,
    // strictly narrower — but check rather than assume.
    console.error(`UNEXPECTED: ${added.length} posting(s) survive AFTER but not BEFORE:`, added);
    process.exitCode = 1;
  }

  console.log(`\nTitles removed by the new exclusion (staff-level, sample up to 25):`);
  for (const j of removed.slice(0, 25)) {
    console.log(`  ${j.title} — ${j.company} (${j.location ?? "no location"})`);
  }

  const savingsPct = before.length > 0 ? (removed.length / before.length) * 100 : 0;
  console.log(
    `\n${removed.length} of ${before.length} previous survivors (${savingsPct.toFixed(1)}%) ` +
      `would no longer be scored — that's the real, dated (${new Date().toISOString().slice(0, 10)}) ` +
      `saving on TODAY's live pool. Whether any of them would have scored >=55% is NOT re-verified ` +
      `here (no Claude calls made) — see this file's top comment for why that claim instead rests on ` +
      `the ticket's existing 2026-08-31 measurement (76/200 staff-level jobs, best 52%, median 22%).`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
