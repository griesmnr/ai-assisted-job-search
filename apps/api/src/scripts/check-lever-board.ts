/**
 * Checks whether a given employer hosts on Lever, without guessing — and
 * whether it's worth adding, without waiting for a live run to find out.
 * Sibling of check-greenhouse-board.ts (ticket b723fb9), extended to Lever
 * by ticket d8417b2 when Lever was actually wired into the real search for
 * the first time.
 *
 * Method: Lever's public Postings API
 * (https://github.com/lever/postings-api), unauthenticated, addressed by a
 * "company slug" — the same slug that appears in
 * `https://jobs.lever.co/{slug}`. There is no public directory mapping
 * company -> slug, so the method is: guess a plausible slug, GET
 *
 *   https://api.lever.co/v0/postings/{slug}?mode=json
 *
 * and classify the response — matching `LeverSource#search`'s own
 * classification (see ../sources/lever.ts):
 *
 *   HTTP 404             -> this slug does not resolve to a board at all.
 *   HTTP 200, []          -> a real board that currently has zero postings.
 *   HTTP 200, [N]         -> a real board with N postings; also reports how
 *                            many of the N would survive
 *                            filterSoftwareEngineeringJobs.
 *
 * Runs the SAME `filterSoftwareEngineeringJobs` a real search applies, for
 * the same reason check-greenhouse-board.ts does: a real, non-empty board
 * is necessary but not sufficient — ticket b723fb9's own Greenhouse list
 * had 13 of 25 real, sizeable boards contribute zero postings after
 * filtering.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/check-lever-board.ts slug1 slug2 ...
 *
 * A completed run always exits 0 — a 404, a fetch error, or a board whose
 * postings all fail the filter are useful, expected results for an
 * individual slug, not script failures, and none of them stop the rest of
 * the batch. Exits 1 only for a usage error (no slugs given) or an
 * unhandled exception in `main()` itself.
 */
import { pathToFileURL } from "node:url";
import { filterSoftwareEngineeringJobs } from "../sources/swe-filter.js";
import type { NormalizedJob } from "../sources/types.js";

const BASE_URL = "https://api.lever.co/v0/postings";
export const TIMEOUT_MS = 10_000;

type RawLeverPosting = {
  text?: string;
  categories?: { location?: string; allLocations?: string[] };
  // Top-level field on the list response — not nested under `categories`.
  // See lever.ts's own `mapLocationType`.
  workplaceType?: string;
};

/** Same mapping lever.ts's `mapLocationType` applies — ticket 4450f39:
 * without this, every hybrid/onsite Lever posting outside the PNW would
 * silently fall back to text-only matching here (though not in a real
 * search, which always has the real `NormalizedJob.locationType`), making
 * this checker under-report survivors relative to what a real search would
 * find. Normalizes "on-site"/"on site" the same way lever.ts does, since
 * Lever's own docs and its real observed data disagree on hyphenation. */
function mapWorkplaceType(raw: string | undefined): NormalizedJob["locationType"] {
  const value = raw?.trim().toLowerCase().replace(/[\s-]/g, "");
  if (value === "remote" || value === "onsite" || value === "hybrid") return value;
  return undefined;
}

export type BoardCheckResult =
  | { slug: string; status: "not-found" }
  | { slug: string; status: "error"; message: string }
  | { slug: string; status: "ok"; postingCount: number; survivingCount: number };

export async function checkBoard(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BoardCheckResult> {
  const url = `${BASE_URL}/${encodeURIComponent(slug)}?mode=json`;
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
      slug,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
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
  const postings = body as RawLeverPosting[];

  // Same title/location/company shape check-greenhouse-board.ts builds —
  // `company` is a constant placeholder here (Lever postings carry no
  // company-name field at all; see lever.ts finding 2 — real search()
  // stamps the configured slug instead, which does not affect this
  // filter's title/location logic or its per-board dedupe, since every
  // candidate posting here shares the same placeholder company already).
  // Location uses the union of `categories.location` and
  // `categories.allLocations` — see lever.ts's `itemLocations` — joined the
  // same way (`; `) so a single-string `PLACE` regex test still sees every
  // location a real search would have.
  const filterable = postings.map((p) => {
    const single = p.categories?.location?.trim();
    const all = (p.categories?.allLocations ?? [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    const locations = single ? [single, ...all.filter((entry) => entry !== single)] : all;
    return {
      title: p.text ?? "",
      location: locations.length > 0 ? locations.join("; ") : undefined,
      company: slug,
      locationType: mapWorkplaceType(p.workplaceType),
    };
  });
  const survivingCount = filterSoftwareEngineeringJobs(filterable).length;

  return { slug, status: "ok", postingCount: postings.length, survivingCount };
}

function formatResult(result: BoardCheckResult): string {
  switch (result.status) {
    case "not-found":
      return `${result.slug.padEnd(20)}  404 — does not exist on Lever`;
    case "error":
      return `${result.slug.padEnd(20)}  ERROR — ${result.message}`;
    case "ok":
      return (
        `${result.slug.padEnd(20)}  ${String(result.postingCount).padStart(4)} posting(s), ` +
        `${result.survivingCount} would survive filtering`
      );
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const slugs = process.argv.slice(2);
  if (slugs.length === 0) {
    console.error("Usage: npx tsx apps/api/src/scripts/check-lever-board.ts <slug> [slug...]");
    process.exit(1);
  }

  // Sequential, not Promise.all — same courtesy LeverSource#search extends
  // to the real API: this is a shared, unauthenticated public endpoint, no
  // reason to hit it with a burst of parallel requests.
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
