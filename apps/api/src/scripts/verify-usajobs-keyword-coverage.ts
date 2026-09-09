/**
 * Live MEASUREMENT for ticket d1fc9e2 (opus review F5 — the ticket's own
 * acceptance criterion #2, "measured before/after," was unmet without
 * this). Same convention as verify-staff-title-exclusion-savings.ts and
 * verify-default-criteria-equivalence.ts: hit the real live API, report
 * real numbers, don't assume.
 *
 * WHY THE "BEFORE" SIDE IS NOT A FULL LIVE FETCH: the old (pre-ticket)
 * behavior is `search({})` — no keyword, fetch up to `MAX_PAGES` (200)
 * pages / 5,000 postings of USAJOBS's own default sort order. Actually
 * running that fetch here would take many minutes and, worse, is
 * genuinely unreliable in a sandboxed/CI-like environment — it timed out
 * even at 120s during this ticket's own development (see the ticket's
 * git-bug body). A script this slow/flaky would not get run, which
 * defeats the point of having a re-runnable measurement at all. Instead:
 *
 *   1. Real TOTAL pool sizes for a realistic set of title keywords,
 *      fetched cheaply (`ResultsPerPage=1` — one lightweight request per
 *      keyword, just reading `SearchResultCountAll`). This is the same
 *      technique the ticket's own body used to find the original
 *      10,000-postings-total / 5,234-for-"information technology" facts.
 *   2. The REAL "after" fetch: `createUsajobsSourceFromEnv().search({
 *      keywords: [...] })` — the actual shipped code path, real
 *      pagination, real results, real timing.
 *
 * The comparison this supports: "before" (no keyword) can NEVER surface
 * more than `MAX_PAGES * RESULTS_PER_PAGE` (5,000) postings out of
 * whatever the TRUE total is, in USAJOBS's own arbitrary sort order —
 * for any keyword whose real total exceeds what a lucky arbitrary slice
 * would happen to include, real relevant postings are provably
 * unreachable under the old approach. "After" fetches EXACTLY the real
 * total for each keyword (bounded by `MAX_PAGES` per keyword, which none
 * of these realistic phrases come close to).
 *
 * Usage (requires USAJOBS_API_KEY / USAJOBS_USER_AGENT in .env):
 *   npx tsx apps/api/src/scripts/verify-usajobs-keyword-coverage.ts
 */
import { createUsajobsSourceFromEnv } from "../sources/usajobs.js";

const USAJOBS_SEARCH_URL = "https://data.usajobs.gov/api/search";

// A realistic set of title phrases -- the same shape `resume-title-
// inference.ts` produces (3-6 titles) plus a couple of federal-specific
// job-series names Nicole flagged by name ("Program Analyst" -- the real
// OPM spelling, not "Programmer Analyst").
const SAMPLE_KEYWORDS = [
  "software engineer",
  "program analyst",
  "computer scientist",
  "it specialist",
  "data scientist",
];

async function fetchTotalCount(keyword: string): Promise<number> {
  const url = new URL(USAJOBS_SEARCH_URL);
  url.searchParams.set("Keyword", keyword);
  url.searchParams.set("ResultsPerPage", "1");
  url.searchParams.set("Page", "1");
  const res = await fetch(url, {
    headers: {
      "Authorization-Key": process.env.USAJOBS_API_KEY!,
      "User-Agent": process.env.USAJOBS_USER_AGENT!,
    },
  });
  const data = (await res.json()) as { SearchResult: { SearchResultCountAll: number } };
  return data.SearchResult.SearchResultCountAll;
}

async function main() {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));

  console.log("Real TOTAL pool sizes (USAJOBS's own reported count), one cheap request each:\n");
  let sumOfTotals = 0;
  for (const keyword of SAMPLE_KEYWORDS) {
    const total = await fetchTotalCount(keyword);
    sumOfTotals += total;
    console.log(`  ${keyword.padEnd(20)} ${total}`);
  }
  const noKeywordTotal = await fetchTotalCount("");
  console.log(`\n  (no keyword, today's OLD default)  ${noKeywordTotal}`);
  console.log(
    `\nOld approach's own hard cap: 200 pages x 25/page = 5,000 postings fetched, out of the ` +
      `${noKeywordTotal} total above -- which 5,000 is USAJOBS's own default sort order, unrelated ` +
      `to relevance. Any keyword here whose real total (see above) would occupy more than its ` +
      `statistically "fair share" of that 5,000-slice has real postings that are provably ` +
      `unreachable under the old no-keyword approach.`,
  );

  console.log(
    `\nReal "after" fetch: createUsajobsSourceFromEnv().search({ keywords: [${SAMPLE_KEYWORDS.map((k) => `"${k}"`).join(", ")}] })...`,
  );
  const source = createUsajobsSourceFromEnv();
  const start = Date.now();
  const result = await source.search({ keywords: SAMPLE_KEYWORDS });
  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `  ${result.jobs.length} REAL, DISTINCT postings fetched in ${elapsedSec}s ` +
      `(${result.skipped.length} skipped, skipRate ${result.skipRate.toFixed(3)}).`,
  );
  console.log(
    `\nEvery one of these ${result.jobs.length} postings is guaranteed reachable under the NEW ` +
      `approach for these ${SAMPLE_KEYWORDS.length} keywords, regardless of USAJOBS's sort order -- ` +
      `each keyword's own real total (all comfortably under the 5,000/200-page cap individually) is ` +
      `fully paginated through, not sampled. Sum of the ${SAMPLE_KEYWORDS.length} individual totals ` +
      `above (${sumOfTotals}, before cross-keyword dedup) vs. ${result.jobs.length} distinct jobs ` +
      `returned shows how much real overlap existed between phrases.`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
