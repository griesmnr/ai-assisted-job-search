/**
 * Checks whether a given employer hosts on Greenhouse, without guessing.
 *
 * Ticket b723fb9's context: hand-picking board tokens by guessing at a
 * company's careers-page URL wastes slots on boards that 404 (7 of 25
 * candidates checked before this ticket: Costco, PACCAR, Alaska Airlines,
 * Philips, Starbucks, Nordstrom, Expeditors — all Workday/iCIMS, not
 * Greenhouse). This script makes "does employer X host on Greenhouse"
 * a one-command answer instead of trial-and-error against demo-match.ts.
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
 *   HTTP 200, jobs: [N]  -> a real board with N postings right now.
 *
 * This mirrors exactly what `GreenhouseSource#search` does per token (see
 * ../sources/greenhouse.ts), minus `content=true` — this script only needs
 * the posting count, not full descriptions, so it fetches faster.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-greenhouse-board.ts token1 token2 ...
 *
 * Always exits 0: a 404 is a useful, expected result, not a script failure.
 * Network errors for an individual token are reported inline and do not
 * stop the rest of the batch.
 */
import { pathToFileURL } from "node:url";

const BASE_URL = "https://boards-api.greenhouse.io/v1/boards";
const TIMEOUT_MS = 10_000;

export type BoardCheckResult =
  | { token: string; status: "not-found" }
  | { token: string; status: "error"; message: string }
  | { token: string; status: "ok"; postingCount: number; companyName: string | undefined };

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
      ? ((body as { jobs: Array<{ company_name?: string }> }).jobs ?? [])
      : undefined;

  if (jobs === undefined) {
    return { token, status: "error", message: "response did not have a jobs array" };
  }

  return {
    token,
    status: "ok",
    postingCount: jobs.length,
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
        `${result.token.padEnd(20)}  ${String(result.postingCount).padStart(4)} posting(s)` +
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
