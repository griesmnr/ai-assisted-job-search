import type { NormalizedJob } from "./types.js";

// ---------------------------------------------------------------------------
// The shortlist filter demo-match.ts applies to every search. Greenhouse in
// particular has no server-side keyword/location query support (it always
// returns a whole board — see greenhouse.ts), so all of this narrowing has
// to happen client-side; the other three sources get it applied the same
// way for consistency even where they support a server-side query.
//
// Lives in its own module, separate from demo-match.ts (which re-exports
// `filterSoftwareEngineeringJobs` for backward compatibility — every
// existing import of it from "./demo-match.js" keeps working unchanged),
// specifically so `check-greenhouse-board.ts` (ticket b723fb9 review fix
// #3) can reuse the exact same filter a real run applies without pulling in
// demo-match.ts's much heavier import graph: Drizzle, `pg`, the Anthropic
// SDK, the db schema/seed/ingest modules, and — critically — the top-level
// `process.loadEnvFile()` call demo-match.ts makes on import, which throws
// if no `.env` file exists in the current working directory. A script whose
// whole point is "check whether a candidate employer is worth adding to
// GREENHOUSE_BOARD_TOKENS" has no business requiring a working Postgres
// connection or an ANTHROPIC_API_KEY to run.
//
// Deliberately out of scope for this ticket: relaxing the TITLE regexes
// below to inflate survivor counts. Tightening them is the proven 58% ->
// 72% match-quality lever (see ticket b723fb9's context) and is untouched
// here. What DID change (ticket 4450f39): the location filter, which was a
// single regex (`PLACE`) conflating "where is the job" with "how is it
// worked" — `remote\s*-\s*us` demanded a literal hyphen, so Ashby's
// "Remote U.S." (period, not hyphen) and every SmartRecruiters posting
// (which never writes "remote - us" at all; it carries a structured
// `location.remote` boolean instead) were silently dropped: 68 Ashby
// postings survived the title filter, 0 survived location; 4,773
// SmartRecruiters postings, 0 survivors. See the ticket for the measured
// before/after.
// ---------------------------------------------------------------------------

// Title filter: actual software engineering roles, not adjacent ones.
const SOFTWARE =
  /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit|intern|designer|field service|machine learning|data scientist)\b/i;

// ---------------------------------------------------------------------------
// Location filter: two independent questions, kept as two independent
// predicates (ticket 4450f39).
//
//   1. WHERE is the job — `classifyGeography` (below).
//   2. HOW is it worked — `resolveWorkArrangement` (below).
//
// A single combined regex (the old `PLACE`) can't express "Remote U.S.
// should pass but a bare 'United States' should not" because that
// distinction is exactly the interaction between these two questions, not
// a property of the location string alone. See `passesLocationFilter`,
// which is where they're recombined.
// ---------------------------------------------------------------------------

/**
 * Physically local to the Seattle area — Nicole's stated preference
 * ("i think i'd respond better in life to a hybrid job than a remote one",
 * 2026-08-22) requires this for a hybrid (or onsite) role to be worth
 * anything: a hybrid role in Austin is useless no matter how the string
 * spells "United States".
 *
 * The `washington` branch deliberately excludes "Washington, D.C." — a real
 * trap in the fixture data, not a hypothetical: Lever/Palantir's real
 * "Backend Software Engineer - Defense" posting (a genuine SWE title) is
 * onsite in "Washington, D.C.", and the OLD `PLACE` regex's bare
 * `washington` match let it through as if it were Washington state. That
 * was always wrong; separating geography from work-arrangement is what
 * surfaced it. Handles "Washington, D.C.", "Washington, DC", and
 * "Washington DC" (comma optional, periods optional).
 */
const PNW = /\b(?:seattle|bellevue)\b|\bwashington\b(?!,?\s*d\.?c\.?)|,\s*wa\b/i;

/**
 * A broad "somewhere in the US" signal from free text — "United States",
 * "USA", "U.S.", or a bare "US" as its own word. Deliberately NOT
 * sufficient on its own to pass the filter (see `passesLocationFilter`):
 * paired with an unknown or non-remote work arrangement, "United States"
 * could be an onsite role in Florida just as easily as Seattle. Only
 * combined with a genuinely remote arrangement does "anywhere in the US"
 * become "reachable" per Nicole's stated preference for remote-friendly US
 * roles.
 *
 * Periods are stripped before matching so "Remote U.S." (Ashby's real
 * spelling — a period, not the hyphen the old regex demanded) and "Remote
 * (US)" match the same way as "Remote - USA"; `\b` around the token keeps
 * this from firing on words that merely contain "us" as a substring (e.g.
 * "Houston", "Columbus", "Austin").
 */
const US_WIDE = /\b(?:united states|usa|us)\b/;

function isUsWideText(location: string): boolean {
  return US_WIDE.test(location.toLowerCase().replace(/\./g, ""));
}

export type Geography = "pnw" | "us-wide" | "unknown";

/** `"pnw"` wins over `"us-wide"` when both match (e.g. "Seattle, WA, United
 * States") — it's the more specific, more useful claim. Exported (along
 * with `resolveWorkArrangement` and `passesLocationFilter`) so tests can
 * verify geography and work-arrangement are genuinely separate predicates,
 * not just assert on the combined pass/fail outcome. */
export function classifyGeography(location: string): Geography {
  if (PNW.test(location)) return "pnw";
  if (isUsWideText(location)) return "us-wide";
  return "unknown";
}

/** Fallback remote detection from free text, for sources without a
 * structured `locationType` (Greenhouse, mostly — see `Job.locationType`'s
 * doc comment). Deliberately narrow: only recognizes an explicit "remote"
 * token rather than trying to infer work arrangement from anything else,
 * since a wrong guess here is exactly the "onsite in Florida" trap. */
const REMOTE_TEXT = /\bremote\b/i;

export type WorkArrangement = "remote" | "hybrid" | "onsite" | "unknown";

/** Structured beats substring: `locationType` (Ashby's `workplaceType`,
 * Lever's `workplaceType`, SmartRecruiters' `location.remote`/`.hybrid`) is
 * used whenever the source supplies it, and only falls back to a text
 * search when it doesn't. */
export function resolveWorkArrangement(
  location: string,
  locationType: NormalizedJob["locationType"],
): WorkArrangement {
  if (locationType) return locationType;
  return REMOTE_TEXT.test(location) ? "remote" : "unknown";
}

export function passesLocationFilter(
  job: Pick<NormalizedJob, "location" | "locationType">,
): boolean {
  const location = job.location ?? "";
  const geography = classifyGeography(location);
  if (geography === "unknown") return false;

  // PNW is physically reachable regardless of arrangement: a Seattle-area
  // onsite or hybrid role is exactly what a PNW-based candidate wants, and
  // a Seattle-area "remote" role is still fine too.
  if (geography === "pnw") return true;

  // geography === "us-wide": broad US without a specific city. Only a
  // genuinely remote role can be reached from anywhere in the US — hybrid
  // and onsite roles need the physical proximity "United States" alone
  // doesn't establish, and an UNKNOWN arrangement must not blanket-pass
  // either. That is the exact trap this ticket exists to close: "United
  // States" with no work-arrangement signal at all could be onsite in
  // Florida.
  const arrangement = resolveWorkArrangement(location, job.locationType);
  return arrangement === "remote";
}

/**
 * Generic over `T` (constrained to the four fields this filter actually
 * reads) rather than fixed to `NormalizedJob[]`, so a caller that only has
 * a raw, un-normalized posting on hand — the `check-*-board.ts` scripts
 * read `title`/`location`/`company`(/`locationType` where the source's list
 * endpoint supplies it) straight off a source's list response, before (and
 * without needing) full `NormalizedJob` normalization — can run the
 * identical filter without first constructing every required
 * `NormalizedJob` field (`externalId`, `description`, `postedAt`, ...) just
 * to satisfy the type. `demo-match.ts`'s real run still calls this with
 * `NormalizedJob[]`, which trivially satisfies the constraint.
 * `locationType` is optional on `NormalizedJob`, so a caller that has no
 * way to read it (e.g. Greenhouse, which mostly lacks the field entirely)
 * can simply omit it — `passesLocationFilter` falls back to text matching
 * exactly as if it were `undefined`.
 */
export function filterSoftwareEngineeringJobs<
  T extends Pick<NormalizedJob, "title" | "location" | "company" | "locationType">,
>(jobs: T[]): T[] {
  const seen = new Set<string>();
  return jobs
    .filter((j) => SOFTWARE.test(j.title) && !NOT.test(j.title))
    .filter((j) => passesLocationFilter(j))
    .filter((j) => {
      const key = `${j.company}|${j.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
