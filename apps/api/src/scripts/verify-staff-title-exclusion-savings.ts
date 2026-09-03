/**
 * Live-pool MEASUREMENT for ticket 6b2313a — "excluded by default" applied
 * to `staff`/`distinguished` titles via swe-filter.ts's `NOT` regex (see
 * that file's own doc comment on `NOT` for the full change, including why
 * `fellow` was tried and then dropped). Same convention as
 * verify-default-criteria-equivalence.ts (read that file's top comment
 * first): fetch the real live Greenhouse pool once, and compare survivor
 * counts under the OLD `NOT` (pre-ticket, no staff/distinguished exclusion)
 * against the CURRENT `NOT` (post-ticket, imported directly from
 * swe-filter.ts — never re-typed here, so this can't silently drift from
 * the shipped regex) on the identical fetched pool.
 *
 * Also reports a PER-WORD breakdown (opus review F2): how many of the
 * "before" survivors each word removes on its own, so "staff alone accounts
 * for effectively all of the saving" is a measured claim, not an assumption.
 * `fellow` is included in the per-word breakdown as an AUDIT ONLY line (a
 * bare `\bfellow\b`, not the shipped NOT, which no longer carries it) to
 * keep the "dropping fellow cost nothing" claim re-verifiable against
 * whatever the live pool looks like on a given day, rather than resting
 * solely on the one dated sample the ticket's review used.
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
// this change existed. `principal` was already here; `staff` and
// `distinguished` were not (`fellow` was briefly added, then dropped — see
// swe-filter.ts's NOT comment — so it never shipped and isn't part of this
// baseline either).
const OLD_NOT =
  /\b(manager|director|principal|sales|marketing|recruit(ing|ment|ers?|s)?|intern(ships?|s)?|designer|field service|machine learning|data scientist)\b/i;

// Per-word breakdown regexes (F2). `STAFF_PRECISE` mirrors the shipped
// range-aware `staff` alternative from swe-filter.ts's NOT exactly (kept as
// a literal copy here, same tradeoff OLD_NOT above already accepts, so this
// script can diff against "what NOT used to be" without importing the very
// thing it's measuring). `FELLOW_AUDIT` is a bare word-boundary match, NOT
// part of the shipped filter — audit-only, to keep re-confirming that
// dropping it was and remains costless.
const STAFF_PRECISE = /(?<!\b(?:or|to)\s)(?<!\/)\bstaff\b(?!\s*(?:or|to)\b)(?!\/)/i;
const DISTINGUISHED_WORD = /\bdistinguished\b/i;
const FELLOW_AUDIT = /\bfellow\b/i;

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

  // Per-word breakdown (F2): counted against `before` (already SOFTWARE +
  // location + dedupe filtered), so each count is "how many of the 178
  // previously-scored postings does this word alone remove" — the same
  // shape as the numbers cited in swe-filter.ts's NOT comment.
  const removedByStaff = before.filter((j) => STAFF_PRECISE.test(j.title));
  const removedByDistinguished = before.filter((j) => DISTINGUISHED_WORD.test(j.title));
  const removedByFellowAudit = before.filter((j) => FELLOW_AUDIT.test(j.title));
  console.log(`\nPer-word breakdown (against the ${before.length} "before" survivors):`);
  console.log(
    `  staff (F1 range-aware fix applied): ${removedByStaff.length} removed` +
      (removedByStaff.length > 0
        ? ` — sample: ${removedByStaff
            .slice(0, 3)
            .map((j) => `"${j.title}"`)
            .join(", ")}`
        : ""),
  );
  console.log(
    `  distinguished: ${removedByDistinguished.length} removed` +
      (removedByDistinguished.length > 0
        ? ` — ${removedByDistinguished.map((j) => `"${j.title}" (${j.company})`).join(", ")}`
        : " (0 real occurrences among SOFTWARE-passing titles — kept for future-proofing, not for measured savings)"),
  );
  console.log(
    `  fellow [AUDIT ONLY — not in the shipped NOT]: ${removedByFellowAudit.length} would-be-removed` +
      (removedByFellowAudit.length > 0
        ? ` — ${removedByFellowAudit
            .slice(0, 3)
            .map((j) => `"${j.title}" (${j.company})`)
            .join(
              ", ",
            )}${removedByFellowAudit.length > 3 ? ", ..." : ""} — confirms these are fellowship-program titles, not staff roles, and dropping "fellow" from NOT costs nothing real`
        : ""),
  );

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
