/**
 * Live MEASUREMENT for ticket d1fc9e2 (opus review F5 — the ticket's own
 * acceptance criterion #2, "measured before/after," was unmet without
 * this). Same convention as verify-staff-title-exclusion-savings.ts and
 * verify-default-criteria-equivalence.ts: hit the real live API, report
 * real numbers, don't assume.
 *
 * UPDATED for ticket 78f48df (opus re-review round 2, F8): the REAL
 * "after" fetch below (`createUsajobsSourceFromEnv().search({keywords:
 * [...]})`) now goes through `PositionTitle`, not `Keyword` — ticket
 * 78f48df retargeted the title-chip adapter path at the parameter that
 * actually searches job titles (see usajobs.ts's `#fetchPage` doc comment
 * for the full measurement). Two claims this script's header used to make
 * are now FALSE and are corrected here:
 *
 *   - "After fetches EXACTLY the real total for each keyword" is no
 *     longer guaranteed. `PositionTitle` ORs every word in a multi-word
 *     phrase (a chip containing one common role-word can measure in the
 *     thousands — see usajobs.ts), so the real fetch now also runs
 *     `TITLE_SEARCH_RESULTS_PER_PAGE`'s relevance-aware early stop
 *     (usajobs.ts), which can stop short of a phrase's full total once its
 *     genuine title matches are exhausted. It is measured LOSSLESS for
 *     every phrase ticket 78f48df tested (zero real matches dropped), but
 *     it is not a pagination-to-completion guarantee the way the old
 *     Keyword-only path was.
 *   - The "before" TOTAL pool sizes below were always measured via
 *     `Keyword`, which is a DIFFERENT field than what the real "after"
 *     fetch now searches. They remain useful as "how big is the
 *     unrestricted-by-title pool" context, but are no longer the same
 *     field as the real fetch — `fetchTotalCount` below now also reports
 *     each phrase's `PositionTitle` total alongside its `Keyword` total so
 *     the comparison is apples to apples with what the adapter actually
 *     sends today.
 *
 * WHY THE "BEFORE" SIDE IS NOT A FULL LIVE FETCH: the old (pre-d1fc9e2)
 * behavior is `search({})` — no keyword, fetch up to `MAX_PAGES` (200)
 * pages / 5,000 postings of USAJOBS's own default sort order. Actually
 * running that fetch here would take many minutes and, worse, is
 * genuinely unreliable in a sandboxed/CI-like environment — it timed out
 * even at 120s during ticket d1fc9e2's own development (see that ticket's
 * git-bug body). A script this slow/flaky would not get run, which
 * defeats the point of having a re-runnable measurement at all. Instead:
 *
 *   1. Real TOTAL pool sizes for a realistic set of title keywords,
 *      fetched cheaply (`ResultsPerPage=1` — one lightweight request per
 *      keyword/param, just reading `SearchResultCountAll`), for BOTH
 *      `Keyword` and `PositionTitle` (ticket 78f48df).
 *   2. The REAL "after" fetch: `createUsajobsSourceFromEnv().search({
 *      keywords: [...] })` — the actual shipped code path, real
 *      pagination, real results, real timing.
 *
 * Usage (requires USAJOBS_API_KEY / USAJOBS_USER_AGENT in .env):
 *   npx tsx apps/api/src/scripts/verify-usajobs-keyword-coverage.ts
 */
import { createUsajobsSourceFromEnv } from "../sources/usajobs.js";

const USAJOBS_SEARCH_URL = "https://data.usajobs.gov/api/search";

// A realistic set of title phrases -- the same shape `resume-title-
// inference.ts` produces (3-6 titles) plus a couple of federal-specific
// job-series names Nicole flagged by name ("Program Analyst" -- the real
// OPM spelling, not "Programmer Analyst"). None contain the punctuation
// `#fetchPage`'s title-mode normalization touches (-, /, +, _), so that
// normalization is a no-op for every phrase here and doesn't need
// reproducing in this script.
const SAMPLE_KEYWORDS = [
  "software engineer",
  "program analyst",
  "computer scientist",
  "it specialist",
  "data scientist",
];

async function fetchTotalCount(
  param: "Keyword" | "PositionTitle",
  phrase: string,
): Promise<number> {
  const url = new URL(USAJOBS_SEARCH_URL);
  url.searchParams.set(param, phrase);
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

  console.log(
    "Real TOTAL pool sizes (USAJOBS's own reported count), one cheap request each, BOTH params " +
      "(ticket 78f48df -- PositionTitle is what the real fetch below now actually sends):\n",
  );
  let sumOfPositionTitleTotals = 0;
  for (const keyword of SAMPLE_KEYWORDS) {
    const keywordTotal = await fetchTotalCount("Keyword", keyword);
    const positionTitleTotal = await fetchTotalCount("PositionTitle", keyword);
    sumOfPositionTitleTotals += positionTitleTotal;
    console.log(
      `  ${keyword.padEnd(20)} Keyword=${String(keywordTotal).padStart(6)}  PositionTitle=${String(positionTitleTotal).padStart(6)}`,
    );
  }
  const noKeywordTotal = await fetchTotalCount("Keyword", "");
  console.log(`\n  (no keyword, today's pre-d1fc9e2 default)  ${noKeywordTotal}`);
  console.log(
    `\nPre-d1fc9e2 approach's own hard cap: 200 pages x 25/page = 5,000 postings fetched, out of ` +
      `the ${noKeywordTotal} total above -- which 5,000 is USAJOBS's own default sort order, ` +
      `unrelated to relevance. Any keyword here whose real total (see above) would occupy more ` +
      `than its statistically "fair share" of that 5,000-slice has real postings that were ` +
      `provably unreachable under that no-keyword approach.`,
  );

  console.log(
    `\nReal "after" fetch (ticket 78f48df: via PositionTitle, not Keyword -- see this file's ` +
      `header): createUsajobsSourceFromEnv().search({ keywords: [${SAMPLE_KEYWORDS.map((k) => `"${k}"`).join(", ")}] })...`,
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
    `\nSum of the ${SAMPLE_KEYWORDS.length} individual PositionTitle totals above ` +
      `(${sumOfPositionTitleTotals}, before cross-keyword dedup AND before any relevance-aware ` +
      `early stop) vs. ${result.jobs.length} distinct jobs actually returned shows how much is ` +
      `cross-phrase overlap vs. how much was trimmed by TITLE_SEARCH_EMPTY_PAGE_GRACE's early ` +
      `stop (usajobs.ts) -- NOT a guarantee that every one of these ${sumOfPositionTitleTotals} ` +
      `raw matches was fetched; see this file's header for why that guarantee no longer holds.`,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
