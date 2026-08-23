/**
 * Checks whether a given company identifier is real on SmartRecruiters,
 * without trusting an empty result — and whether it's worth adding,
 * without waiting for a live run to find out. Sibling of
 * check-greenhouse-board.ts (ticket b723fb9), check-lever-board.ts, and
 * check-ashby-board.ts, added by ticket d8417b2.
 *
 * SmartRecruiters needs a DIFFERENT method than the other three checkers.
 * Greenhouse/Lever/Ashby all 404 cleanly on an unrecognized token — "does
 * this resolve" and "is this worth adding" are two separate questions
 * answered by two separate signals (HTTP status, then the filter).
 * SmartRecruiters' postings API does NOT: a wrong company identifier
 * returns HTTP 200 with `totalFound: 0`, byte-identical to a real company
 * with zero current openings (see smartrecruiters.ts, Finding 1 — verified
 * live against six guessed identifiers, all indistinguishable 200/0
 * envelopes from a real company). So THIS checker reuses
 * `checkCareersSiteValidity` (extracted from `SmartRecruitersSource` for
 * exactly this reuse) — the adapter's own careers-microsite
 * disambiguation — rather than trusting `totalFound: 0` at face value.
 * "Use it," per this ticket's own instruction, not a second hand-rolled
 * copy of the same logic.
 *
 * Method:
 *   1. GET {baseUrl}/{company}/postings?limit=100 (repeated across pages —
 *      cheap: this is the summary LIST endpoint, not the mandatory
 *      per-posting detail fetch `SmartRecruitersSource#search` needs for
 *      `description` — see smartrecruiters.ts Finding 2/5. `title`/
 *      `location`/`company` are all present on the summary shape, which is
 *      everything `filterSoftwareEngineeringJobs` reads, so this checker
 *      never needs the expensive detail fan-out at all).
 *   2. If `totalFound > 0`: the identifier is proven real by having actual
 *      postings — no further check needed (mirrors
 *      `SmartRecruitersSource#searchCompany`'s own "only ambiguous when
 *      empty" rule).
 *   3. If `totalFound === 0`: call `checkCareersSiteValidity(company)`.
 *      "valid" -> a real company, genuinely zero postings right now.
 *      "invalid" -> the identifier does not resolve to a real company —
 *      redirects to the generic SmartRecruiters homepage. "unknown" -> the
 *      check itself couldn't complete (network error, unrecognized
 *      redirect target) — NOT assumed valid, per Finding 1's own
 *      "fail toward I don't know, never toward valid" rule.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-smartrecruiters-board.ts company1 company2 ...
 *
 * A completed run always exits 0 for a per-company outcome — "invalid",
 * "unknown", and "valid but empty" are all useful, expected results, not
 * script failures. Exits 1 only for a usage error (no identifiers given)
 * or an unhandled exception in `main()` itself.
 */
import { pathToFileURL } from "node:url";
import { checkCareersSiteValidity } from "../sources/smartrecruiters.js";
import { filterSoftwareEngineeringJobs } from "../sources/swe-filter.js";

const BASE_URL = "https://api.smartrecruiters.com/v1/companies";
export const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** Safety valve against an infinite pagination loop, matching
 * smartrecruiters.ts's own DEFAULT_MAX_PAGES reasoning — comfortably above
 * any realistic board size even for a large enterprise customer. */
const MAX_PAGES = 500;

type RawSummary = {
  name?: string;
  location?: { fullLocation?: string };
};
type RawPostingsPage = { totalFound?: number; content?: RawSummary[] };

export type BoardCheckResult =
  | { company: string; status: "invalid"; reason: string }
  | { company: string; status: "unknown"; reason: string }
  | { company: string; status: "error"; message: string }
  | { company: string; status: "ok"; postingCount: number; survivingCount: number };

async function fetchPage(
  company: string,
  offset: number,
  fetchImpl: typeof fetch,
): Promise<RawPostingsPage> {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(company)}/postings`);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("content" in body) ||
      !Array.isArray((body as Record<string, unknown>).content)
    ) {
      throw new Error("response did not have a content array");
    }
    return body as RawPostingsPage;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkCompany(
  company: string,
  fetchImpl: typeof fetch = fetch,
  careersBaseUrl?: string,
): Promise<BoardCheckResult> {
  let firstPage: RawPostingsPage;
  try {
    firstPage = await fetchPage(company, 0, fetchImpl);
  } catch (err) {
    return {
      company,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const totalFound = firstPage.totalFound ?? 0;

  if (totalFound === 0) {
    // The 200-with-zero-results trap (Finding 1) — disambiguate via the
    // adapter's own careers-site check rather than trusting this silently.
    const validity = await checkCareersSiteValidity(company, careersBaseUrl, fetchImpl, TIMEOUT_MS);
    if (validity.status === "valid") {
      return { company, status: "ok", postingCount: 0, survivingCount: 0 };
    }
    if (validity.status === "invalid") {
      return {
        company,
        status: "invalid",
        reason: "not a recognized SmartRecruiters company identifier (careers-site check failed)",
      };
    }
    return { company, status: "unknown", reason: validity.reason };
  }

  // Non-empty: the identifier is proven real. Page through every summary —
  // title/location/company are all present at the summary level, which is
  // everything filterSoftwareEngineeringJobs needs (see this file's
  // top-of-file comment) — no per-posting detail fetch required.
  const summaries: RawSummary[] = [...(firstPage.content ?? [])];
  let offset = summaries.length;
  let page = 1;
  let latestTotal = totalFound;
  try {
    while (summaries.length > 0 && offset < latestTotal && page < MAX_PAGES) {
      const next = await fetchPage(company, offset, fetchImpl);
      const content = next.content ?? [];
      if (content.length === 0) break;
      summaries.push(...content);
      offset += content.length;
      latestTotal = next.totalFound ?? latestTotal;
      page += 1;
    }
  } catch {
    // A later page failing doesn't invalidate what was already fetched —
    // report what's known so far rather than discarding it, same
    // isolation instinct as every other adapter in this project.
    return {
      company,
      status: "ok",
      postingCount: summaries.length,
      survivingCount: filterSoftwareEngineeringJobs(
        summaries.map((s) => ({
          title: s.name ?? "",
          location: s.location?.fullLocation,
          company,
        })),
      ).length,
    };
  }

  const filterable = summaries.map((s) => ({
    title: s.name ?? "",
    location: s.location?.fullLocation,
    company,
  }));
  const survivingCount = filterSoftwareEngineeringJobs(filterable).length;

  return { company, status: "ok", postingCount: summaries.length, survivingCount };
}

function formatResult(result: BoardCheckResult): string {
  switch (result.status) {
    case "invalid":
      return `${result.company.padEnd(20)}  INVALID — ${result.reason}`;
    case "unknown":
      return `${result.company.padEnd(20)}  UNKNOWN — ${result.reason}`;
    case "error":
      return `${result.company.padEnd(20)}  ERROR — ${result.message}`;
    case "ok":
      return (
        `${result.company.padEnd(20)}  ${String(result.postingCount).padStart(5)} posting(s), ` +
        `${result.survivingCount} would survive filtering`
      );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const companies = process.argv.slice(2);
  if (companies.length === 0) {
    console.error(
      "Usage: npx tsx apps/api/src/scripts/check-smartrecruiters-board.ts <company> [company...]",
    );
    process.exit(1);
  }

  // Sequential, not Promise.all — same courtesy every other checker/adapter
  // in this project extends to a shared, unauthenticated public API.
  for (const company of companies) {
    const result = await checkCompany(company);
    console.log(formatResult(result));
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
