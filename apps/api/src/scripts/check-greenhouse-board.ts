/**
 * Checks whether a given employer hosts on Greenhouse, without guessing —
 * and whether it's worth adding, without waiting for a live run to find out.
 *
 * Ticket b723fb9's context: hand-picking board tokens by guessing at a
 * company's careers-page URL wastes slots on boards that 404 (7 of 25
 * candidates checked before this ticket: Costco, PACCAR, Alaska Airlines,
 * Philips, Starbucks, Nordstrom, Expeditors — all Workday/iCIMS, not
 * Greenhouse). Existing on Greenhouse is necessary but not sufficient,
 * though: this ticket's own review found 13 of the 25 configured tokens
 * report real, sizeable boards (tanium 45, elastic 249, datadog 448, ...)
 * that contribute ZERO postings after demo-match.ts's title/location
 * filter. A version of this script that only answered "does token X
 * resolve" would have recommended all thirteen. So this script runs the
 * real `filterSoftwareEngineeringJobs` filter too, and reports both
 * numbers — matching `describeBoardOutcome`'s wording in demo-match.ts, so
 * a candidate's report and a real run's report read the same way.
 *
 * Method: Greenhouse's public Job Board API
 * (https://developers.greenhouse.io/job-board.html) is unauthenticated and
 * addressed by a "board token" — usually, but not reliably, the employer's
 * name lowercased with spaces/punctuation stripped (e.g. Stripe -> "stripe",
 * Robinhood -> "robinhood", Smartsheet -> "smartsheet"). There is no public
 * directory mapping company -> token, so the method is: guess one or more
 * plausible tokens per candidate, GET
 *
 *   https://boards-api.greenhouse.io/v1/boards/{token}/jobs
 *
 * for each, and classify the response:
 *
 *   HTTP 404             -> this token does not resolve to a board at all.
 *                            Either the guess is wrong (try another) or the
 *                            employer is not on Greenhouse (they may be on
 *                            Workday, iCIMS, Lever, Ashby, ...).
 *   HTTP 200, jobs: []   -> a real board that currently has zero postings.
 *   HTTP 200, jobs: [N]  -> a real board with N postings; also reports how
 *                            many of the N would survive
 *                            filterSoftwareEngineeringJobs.
 *
 * This mirrors what `GreenhouseSource#search` does per token (see
 * ../sources/greenhouse.ts), minus `content=true` — this script only needs
 * title/location/company, not full descriptions, so it fetches faster.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-greenhouse-board.ts token1 token2 ...
 *
 * A completed run always exits 0 — a 404, a fetch error, or a board whose
 * postings all fail the filter are useful, expected results for an
 * individual token, not script failures, and none of them stop the rest of
 * the batch. Exits 1 only for a usage error (no tokens given) or an
 * unhandled exception in `main()` itself.
 */
import { pathToFileURL } from "node:url";
import { filterSoftwareEngineeringJobs } from "../sources/swe-filter.js";

const BASE_URL = "https://boards-api.greenhouse.io/v1/boards";
export const TIMEOUT_MS = 10_000;

type RawGreenhouseJob = {
  title?: string;
  company_name?: string;
  location?: { name?: string };
};

export type BoardCheckResult =
  | { token: string; status: "not-found" }
  | { token: string; status: "error"; message: string }
  | {
      token: string;
      status: "ok";
      postingCount: number;
      survivingCount: number;
      companyName: string | undefined;
    };

export async function checkBoard(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardCheckResult> {
  const url = `${BASE_URL}/${encodeURIComponent(token)}/jobs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    return {
      token,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    return { token, status: "not-found" };
  }
  if (!response.ok) {
    return { token, status: "error", message: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      token,
      status: "error",
      message: `response was not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const jobs =
    typeof body === "object" && body !== null && Array.isArray((body as { jobs?: unknown }).jobs)
      ? ((body as { jobs: RawGreenhouseJob[] }).jobs ?? [])
      : undefined;

  if (jobs === undefined) {
    return { token, status: "error", message: "response did not have a jobs array" };
  }

  // Built straight from the raw list response — title/location/company_name
  // are present without needing `content=true` (see this file's top-of-file
  // comment) — and run through the SAME filter demo-match.ts applies to a
  // real search, so "would this token have been worth adding" is answered
  // with the actual filter, not a guess about what it might do.
  const filterable = jobs.map((j) => ({
    title: j.title ?? "",
    location: j.location?.name,
    company: j.company_name ?? "",
  }));
  const survivingCount = filterSoftwareEngineeringJobs(filterable).length;

  return {
    token,
    status: "ok",
    postingCount: jobs.length,
    survivingCount,
    companyName: jobs[0]?.company_name,
  };
}

function formatResult(result: BoardCheckResult): string {
  switch (result.status) {
    case "not-found":
      return `${result.token.padEnd(20)}  404 — does not exist on Greenhouse`;
    case "error":
      return `${result.token.padEnd(20)}  ERROR — ${result.message}`;
    case "ok":
      return (
        `${result.token.padEnd(20)}  ${String(result.postingCount).padStart(4)} posting(s), ` +
        `${result.survivingCount} would survive filtering` +
        (result.companyName ? `  (${result.companyName})` : "")
      );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const tokens = process.argv.slice(2);
  if (tokens.length === 0) {
    console.error(
      "Usage: npx tsx apps/api/src/scripts/check-greenhouse-board.ts <token> [token...]",
    );
    process.exit(1);
  }

  // Sequential, not Promise.all — same courtesy GreenhouseSource#search
  // extends to the real API: this is a shared, unauthenticated public
  // endpoint, no reason to hit it with a burst of parallel requests.
  for (const token of tokens) {
    const result = await checkBoard(token);
    console.log(formatResult(result));
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
