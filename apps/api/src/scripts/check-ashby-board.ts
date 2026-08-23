/**
 * Checks whether a given employer hosts on Ashby, without guessing — and
 * whether it's worth adding, without waiting for a live run to find out.
 * Sibling of check-greenhouse-board.ts (ticket b723fb9) and
 * check-lever-board.ts, added by ticket d8417b2 alongside actually wiring
 * Ashby into the real search for the first time.
 *
 * Method: Ashby's public Job Board API
 * (https://developers.ashbyhq.com/docs/public-job-posting-api),
 * unauthenticated, addressed by a "board name" — the same name that
 * appears in `https://jobs.ashbyhq.com/{boardName}`. There is no public
 * directory mapping company -> board name, so the method is: guess a
 * plausible name, GET
 *
 *   https://api.ashbyhq.com/posting-api/job-board/{boardName}
 *
 * and classify the response — matching `AshbySource#search`'s own
 * classification (see ../sources/ashby.ts, finding 7):
 *
 *   HTTP 404 (plain text)  -> this board name does not exist at all.
 *   HTTP 200, jobs: []     -> a real board that currently has zero postings
 *                             (confirmed real and distinct from 404 — see
 *                             ashby.ts finding 7; e.g. mercury, deel).
 *   HTTP 200, jobs: [N]    -> a real board with N postings; also reports
 *                             how many of the N would survive
 *                             filterSoftwareEngineeringJobs.
 *
 * Runs the SAME `filterSoftwareEngineeringJobs` a real search applies —
 * same reasoning as the Greenhouse/Lever checkers: a real, non-empty board
 * is necessary but not sufficient.
 *
 * Deliberately does NOT request `?includeCompensation=true` (ashby.ts
 * finding 2b): this script only reads `title`/`location`, neither of which
 * that parameter affects — no reason to pay for the extra response weight
 * just to check whether a board is worth adding.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-ashby-board.ts boardName1 boardName2 ...
 *
 * A completed run always exits 0 — a 404, a fetch error, or a board whose
 * postings all fail the filter are useful, expected results for an
 * individual board, not script failures, and none of them stop the rest of
 * the batch. Exits 1 only for a usage error (no board names given) or an
 * unhandled exception in `main()` itself.
 */
import { pathToFileURL } from "node:url";
import { filterSoftwareEngineeringJobs } from "../sources/swe-filter.js";

const BASE_URL = "https://api.ashbyhq.com/posting-api/job-board";
export const TIMEOUT_MS = 10_000;

type RawAshbySecondaryLocation = { location?: string };
type RawAshbyJob = {
  title?: string;
  location?: string;
  secondaryLocations?: RawAshbySecondaryLocation[];
};

export type BoardCheckResult =
  | { boardName: string; status: "not-found" }
  | { boardName: string; status: "error"; message: string }
  | { boardName: string; status: "ok"; postingCount: number; survivingCount: number };

export async function checkBoard(
  boardName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardCheckResult> {
  const url = `${BASE_URL}/${encodeURIComponent(boardName)}`;
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
      boardName,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }

  // Ashby's board-not-found response is plain text ("Not Found"), not
  // JSON — see ashby.ts finding 7. Classified on status alone, same as
  // every other adapter here, before attempting to parse a body.
  if (response.status === 404) {
    return { boardName, status: "not-found" };
  }
  if (!response.ok) {
    return { boardName, status: "error", message: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      boardName,
      status: "error",
      message: `response was not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  const jobs =
    typeof body === "object" && body !== null && Array.isArray((body as { jobs?: unknown }).jobs)
      ? ((body as { jobs: RawAshbyJob[] }).jobs ?? [])
      : undefined;
  if (jobs === undefined) {
    return { boardName, status: "error", message: "response did not have a jobs array" };
  }

  // company is a constant placeholder (Ashby postings carry no company-name
  // field — ashby.ts finding 5; a real search stamps the configured board
  // name instead). location is the union of `location` and every
  // `secondaryLocations[].location` (ashby.ts finding 2a) — this script
  // deliberately does NOT also fold in `address.postalAddress` (finding
  // 2c): that requires `includeCompensation`-adjacent full fields this
  // lightweight check skips for speed, same tradeoff
  // check-greenhouse-board.ts makes by skipping `content=true`. That means
  // this script can UNDER-count survivors relative to a real search for a
  // board whose only qualifying location lives solely in `address` — a
  // real search is the final word, this script is a cheap first filter.
  const filterable = jobs.map((j) => {
    const single = j.location?.trim();
    const secondary = (j.secondaryLocations ?? [])
      .map((s) => s.location?.trim())
      .filter((loc): loc is string => Boolean(loc));
    const locations = single ? [single, ...secondary.filter((loc) => loc !== single)] : secondary;
    return {
      title: j.title ?? "",
      location: locations.length > 0 ? locations.join("; ") : undefined,
      company: boardName,
    };
  });
  const survivingCount = filterSoftwareEngineeringJobs(filterable).length;

  return { boardName, status: "ok", postingCount: jobs.length, survivingCount };
}

function formatResult(result: BoardCheckResult): string {
  switch (result.status) {
    case "not-found":
      return `${result.boardName.padEnd(20)}  404 — does not exist on Ashby`;
    case "error":
      return `${result.boardName.padEnd(20)}  ERROR — ${result.message}`;
    case "ok":
      return (
        `${result.boardName.padEnd(20)}  ${String(result.postingCount).padStart(4)} posting(s), ` +
        `${result.survivingCount} would survive filtering`
      );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const boardNames = process.argv.slice(2);
  if (boardNames.length === 0) {
    console.error(
      "Usage: npx tsx apps/api/src/scripts/check-ashby-board.ts <boardName> [boardName...]",
    );
    process.exit(1);
  }

  // Sequential, not Promise.all — same courtesy AshbySource#search extends
  // to the real API.
  for (const boardName of boardNames) {
    const result = await checkBoard(boardName);
    console.log(formatResult(result));
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
