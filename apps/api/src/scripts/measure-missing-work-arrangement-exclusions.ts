/**
 * Live-pool MEASUREMENT for ticket 14289ac — re-runs the "105 of 1,358
 * title-passing postings (7.7%) are us-wide with an unknown work-arrangement
 * and get silently dropped" measurement the ticket itself cites (dated
 * 2026-08-24), against TODAY's live pool, using the shipped
 * `excludedForMissingWorkArrangement` (swe-filter.ts) — not a re-derived
 * copy — so this can never silently drift from what a real run actually
 * counts. Same standalone-script convention as
 * verify-staff-title-exclusion-savings.ts and
 * verify-default-criteria-equivalence.ts: real network fetch, no DB, no
 * Claude calls (source-fetch only — free).
 *
 * Fetches from all FOUR sources, not just Greenhouse, to match the
 * ticket's own "measured live across all 40 configured boards" framing
 * (25 Greenhouse + 4 Lever + 4 Ashby + 7 SmartRecruiters = 40). Lever,
 * Ashby, and SmartRecruiters are instantiated directly with the exact
 * default lists documented in .env.example (LEVER_COMPANIES,
 * ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES) rather than via their
 * `create*FromEnv()` — this environment's own `.env` only sets
 * GREENHOUSE_BOARD_TOKENS, and all three of these public APIs need no
 * credentials, so constructing the source classes directly reproduces the
 * documented 40-board configuration without requiring `.env` changes.
 *
 * Usage (requires GREENHOUSE_BOARD_TOKENS in .env — see .env.example):
 *   npx tsx apps/api/src/scripts/measure-missing-work-arrangement-exclusions.ts
 */
import { AshbySource } from "../sources/ashby.js";
import { createGreenhouseSourceFromEnv } from "../sources/greenhouse.js";
import { LeverSource } from "../sources/lever.js";
import { SmartRecruitersSource } from "../sources/smartrecruiters.js";
import {
  excludedForMissingWorkArrangement,
  filterSoftwareEngineeringJobs,
} from "../sources/swe-filter.js";
import type { JobSource, NormalizedJob } from "../sources/types.js";

// Verbatim from .env.example's documented defaults (see that file's own
// comments for how each list was verified) — not re-guessed here.
const LEVER_COMPANIES = ["outreach", "palantir", "wealthfront", "rover"];
const ASHBY_BOARD_NAMES = ["ramp", "notion", "vanta", "temporal"];
const SMARTRECRUITERS_COMPANIES = [
  "Nike",
  "Starbucks",
  "Nordstrom",
  "TMobile",
  "PACCAR",
  "Visa",
  "Expeditors",
];

// SOFTWARE title filter, copied from swe-filter.ts, needed here ONLY to
// report "how many title-passing postings" the pool has as a denominator —
// the actual exclusion classification comes from the real, imported
// `excludedForMissingWorkArrangement`, never re-derived.
const SOFTWARE =
  /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit(ing|ment|ers?|s)?|intern(ships?|s)?|designer|field service|machine learning|data scientist|distinguished)\b|(?<!\b(?:or|to)\s)(?<!\/)\bstaff\b(?!\s*(?:or|to)\b)(?!\/)/i;

async function fetchAll(): Promise<{
  jobs: NormalizedJob[];
  perSourceCounts: Map<string, number>;
}> {
  const sources: Array<{ name: string; source: JobSource }> = [
    { name: "greenhouse", source: createGreenhouseSourceFromEnv() },
    { name: "lever", source: new LeverSource({ companies: LEVER_COMPANIES }) },
    { name: "ashby", source: new AshbySource({ boardNames: ASHBY_BOARD_NAMES }) },
    {
      name: "smartrecruiters",
      source: new SmartRecruitersSource({ companies: SMARTRECRUITERS_COMPANIES }),
    },
  ];

  const jobs: NormalizedJob[] = [];
  const perSourceCounts = new Map<string, number>();
  for (const { name, source } of sources) {
    console.log(`Fetching from ${name}...`);
    try {
      const result = await source.search({});
      console.log(
        `  ${name}: ${result.jobs.length} posting(s), ${result.skipped.length} skipped ` +
          `(skipRate ${result.skipRate.toFixed(4)}).`,
      );
      jobs.push(...result.jobs);
      perSourceCounts.set(name, result.jobs.length);
    } catch (err) {
      console.error(`  ${name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      perSourceCounts.set(name, 0);
    }
  }
  return { jobs, perSourceCounts };
}

async function main() {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));

  const { jobs, perSourceCounts } = await fetchAll();
  console.log(
    `\nFetched ${jobs.length} raw posting(s) total across ${perSourceCounts.size} source(s).`,
  );

  const titlePassing = jobs.filter((j) => SOFTWARE.test(j.title) && !NOT.test(j.title));
  const survivors = filterSoftwareEngineeringJobs(jobs);
  const excluded = excludedForMissingWorkArrangement(jobs);

  console.log(`\nTitle-passing postings (SOFTWARE, not NOT): ${titlePassing.length}`);
  console.log(
    `Survivors (title + location + dedupe, filterSoftwareEngineeringJobs): ${survivors.length}`,
  );
  console.log(
    `Excluded specifically for missing work-arrangement metadata (excludedForMissingWorkArrangement): ` +
      `${excluded.length}`,
  );
  const pct = titlePassing.length > 0 ? (excluded.length / titlePassing.length) * 100 : 0;
  console.log(
    `\n${excluded.length} of ${titlePassing.length} title-passing postings (${pct.toFixed(1)}%) are ` +
      `us-wide with no evidence of a remote arrangement, as of ${new Date().toISOString().slice(0, 10)}.`,
  );

  // Concentration by employer (ticket's own framing: "concentrated by
  // employer, fivetran 22, brex 19, temporal 15, datadog 14, figma 14").
  const byCompany = new Map<string, number>();
  for (const j of excluded) {
    const key = j.company.trim();
    byCompany.set(key, (byCompany.get(key) ?? 0) + 1);
  }
  const ranked = [...byCompany.entries()].sort((a, b) => b[1] - a[1]);
  console.log(
    `\nConcentration by employer (${ranked.length} distinct compan${ranked.length === 1 ? "y" : "ies"}):`,
  );
  for (const [company, count] of ranked) {
    console.log(`  ${company}: ${count}`);
  }

  // Cross-check: does any configured employer contribute ZERO survivors
  // AND a nonzero exclusion count for this reason? That's exactly the
  // "indistinguishable from a dead board" case the ticket names (Temporal).
  const survivorCompanies = new Set(survivors.map((j) => j.company.trim().toLowerCase()));
  const zeroSurvivorsDueToMetadata = ranked.filter(
    ([company]) => !survivorCompanies.has(company.toLowerCase()),
  );
  if (zeroSurvivorsDueToMetadata.length > 0) {
    console.log(
      `\nEmployer(s) contributing ZERO survivors where this reason alone accounts for it ` +
        `(${zeroSurvivorsDueToMetadata.length}):`,
    );
    for (const [company, count] of zeroSurvivorsDueToMetadata) {
      console.log(
        `  ${company}: 0 survivors, ${count} excluded for missing work-arrangement metadata`,
      );
    }
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
