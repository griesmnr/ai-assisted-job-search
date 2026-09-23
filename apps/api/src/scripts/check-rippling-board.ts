/**
 * Checks whether a given board slug is real on Rippling, without guessing —
 * and whether it's worth adding, without waiting for a live run to find out.
 * Sibling of check-greenhouse-board.ts (ticket b723fb9), check-lever-board.ts,
 * check-ashby-board.ts, and check-smartrecruiters-board.ts, added by ticket
 * a14e3e7.
 *
 * Rippling needs the SAME method Greenhouse/Lever/Ashby use, not
 * SmartRecruiters' careers-microsite disambiguation: an unrecognized board
 * slug returns a clean HTTP 404
 * (`{"error_code":"RESOURCE_NOT_FOUND","message":"Job Board not found"}`),
 * verified live 2026-09-23 (see rippling.ts's top-of-file comment) — there is
 * no 200-with-zero-results trap here to disambiguate.
 *
 * Ticket a14e3e7's context, unlike Greenhouse's b723fb9: a Rippling board
 * only exists for employers on Rippling's paid "Recruiting Pro" tier, so the
 * blind-guess hit rate is much lower — 150 plausible tech/SaaS company slugs
 * guessed during this ticket's own development, only ONE (carbon-health)
 * resolved. The rest of the real boards found (rippling itself,
 * routeware-careers, closinglock, logicbroker-inc, talentneuroncareers,
 * quotapath, and three real-but-currently-empty boards) came from a web
 * search of `ats.rippling.com` job postings, not further guessing — see
 * this ticket's own report for the exact queries. This script exists so the
 * NEXT person widening `RIPPLING_COMPANIES` doesn't have to re-discover that
 * blind guessing here is expensive and low-yield.
 *
 * Method: Rippling's public board API
 * (`https://api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`) is
 * unauthenticated. GET it and classify the response:
 *
 *   HTTP 404             -> this slug does not resolve to a board at all —
 *                            either the guess is wrong, or the employer is
 *                            real but not on Rippling's Recruiting Pro tier
 *                            (there is no way to tell those two apart from
 *                            outside; see rippling.ts's top-of-file comment
 *                            on the coverage caveat).
 *   HTTP 200, []          -> a real board that currently has zero postings.
 *   HTTP 200, [N rows]    -> a real board; also reports how many DISTINCT
 *                            postings that is (Finding 1: a job posted to
 *                            multiple locations appears once per location,
 *                            not once — see rippling.ts) and how many would
 *                            survive filterSoftwareEngineeringJobs.
 *
 * This mirrors what `RipplingSource#search` does per board at the LIST
 * level, minus the mandatory per-posting detail fetch (see rippling.ts,
 * Finding 1) — this script only needs title/location/department, not full
 * descriptions, so it stays cheap even for a large board like `rippling`
 * itself (328 distinct jobs).
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-rippling-board.ts slug1 slug2 ...
 *
 * A completed run always exits 0 — a 404, a fetch error, or a board whose
 * postings all fail the filter are useful, expected results for an
 * individual slug, not script failures, and none of them stop the rest of
 * the batch. Exits 1 only for a usage error (no slugs given) or an
 * unhandled exception in `main()` itself.
 */
import { pathToFileURL } from "node:url";
import { filterSoftwareEngineeringJobs } from "../matching/swe-filter.js";
import type { NormalizedJob } from "../sources/types.js";

const BASE_URL = "https://api.rippling.com/platform/api/ats/v1/board";
export const TIMEOUT_MS = 10_000;

type RawRipplingSummary = {
  uuid?: string;
  name?: string;
  department?: { label?: string };
  workLocation?: { label?: string };
};

export type BoardCheckResult =
  | { slug: string; status: "not-found" }
  | { slug: string; status: "error"; message: string }
  | { slug: string; status: "ok"; postingCount: number; survivingCount: number };

/** Same classification `mapLocationType` in rippling.ts applies to a real
 * DETAIL response's `workLocations` — applied here to the single label a
 * list row carries, so a checker candidate's survivor count reasonably
 * approximates (but is not guaranteed identical to — this script never
 * fetches detail, so it can't see a multi-location job's full location set
 * the way a real search does) what a real search would find. Same honest
 * "cheap first filter, not a guarantee" caveat check-smartrecruiters-
 * board.ts's own duplicated `mapLocationType` documents. */
function classifyLocation(label: string | undefined): NormalizedJob["locationType"] {
  if (!label) return undefined;
  const lower = label.toLowerCase();
  if (lower.startsWith("remote")) return "remote";
  if (lower.startsWith("hybrid")) return "hybrid";
  return "onsite";
}

export async function checkBoard(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardCheckResult> {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}/jobs`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    return { slug, status: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    return { slug, status: "not-found" };
  }
  if (!response.ok) {
    return { slug, status: "error", message: `HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return {
      slug,
      status: "error",
      message: `response was not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  if (!Array.isArray(body)) {
    return { slug, status: "error", message: "response was not a JSON array" };
  }
  const rows = body as RawRipplingSummary[];

  // Finding 1 (rippling.ts): a job posted to multiple locations appears
  // once PER LOCATION, sharing a uuid — dedupe before reporting a posting
  // count, same as RipplingSource#search itself does.
  const seen = new Map<string, RawRipplingSummary>();
  for (const row of rows) {
    if (typeof row.uuid === "string" && row.uuid.length > 0 && !seen.has(row.uuid)) {
      seen.set(row.uuid, row);
    }
  }
  const distinct = [...seen.values()];

  const filterable = distinct.map((r) => ({
    title: r.name ?? "",
    location: r.workLocation?.label,
    company: slug,
    locationType: classifyLocation(r.workLocation?.label),
  }));
  const survivingCount = filterSoftwareEngineeringJobs(filterable).length;

  return { slug, status: "ok", postingCount: distinct.length, survivingCount };
}

function formatResult(result: BoardCheckResult): string {
  switch (result.status) {
    case "not-found":
      return `${result.slug.padEnd(24)}  404 — does not exist on Rippling`;
    case "error":
      return `${result.slug.padEnd(24)}  ERROR — ${result.message}`;
    case "ok":
      return (
        `${result.slug.padEnd(24)}  ${String(result.postingCount).padStart(4)} posting(s), ` +
        `${result.survivingCount} would survive filtering`
      );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const slugs = process.argv.slice(2);
  if (slugs.length === 0) {
    console.error("Usage: npx tsx apps/api/src/scripts/check-rippling-board.ts <slug> [slug...]");
    process.exit(1);
  }

  // Sequential, not Promise.all — same courtesy RipplingSource#search
  // extends to the real API: this is a shared, unauthenticated public
  // endpoint, no reason to hit it with a burst of parallel requests.
  for (const slug of slugs) {
    const result = await checkBoard(slug);
    console.log(formatResult(result));
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
