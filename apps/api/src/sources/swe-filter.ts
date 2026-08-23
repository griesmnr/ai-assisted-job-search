import type { NormalizedJob } from "./types.js";

// ---------------------------------------------------------------------------
// The shortlist filter demo-match.ts applies to Greenhouse-backed searches.
// Greenhouse has no server-side keyword/location query support (it always
// returns a whole board — see greenhouse.ts), so all of this narrowing has
// to happen client-side.
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
// Deliberately out of scope for this ticket: relaxing these two regexes
// to inflate survivor counts. Tightening them is the proven 58% -> 72%
// match-quality lever (see ticket b723fb9's context); this file only moves
// the existing logic, it does not change it.
// ---------------------------------------------------------------------------

// Title filter: actual software engineering roles, not adjacent ones.
const SOFTWARE =
  /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit|intern|designer|field service|machine learning|data scientist)\b/i;

// Location filter: Washington, or genuinely US-remote. Excludes the many
// "Remote - Canada/UK/Poland" postings, which aren't applicable.
const PLACE = /(washington|seattle|bellevue|,\s*wa\b|remote\s*-\s*us|remote,\s*usa)/i;

/**
 * Generic over `T` (constrained to the three fields this filter actually
 * reads) rather than fixed to `NormalizedJob[]`, so a caller that only has
 * a raw, un-normalized posting on hand — `check-greenhouse-board.ts` reads
 * `title`/`location`/`company_name` straight off Greenhouse's list
 * response, before (and without needing) full `NormalizedJob` normalization
 * — can run the identical filter without first constructing every required
 * `NormalizedJob` field (`externalId`, `description`, `postedAt`, ...) just
 * to satisfy the type. `demo-match.ts`'s real run still calls this with
 * `NormalizedJob[]`, which trivially satisfies the constraint.
 */
export function filterSoftwareEngineeringJobs<
  T extends Pick<NormalizedJob, "title" | "location" | "company">,
>(jobs: T[]): T[] {
  const seen = new Set<string>();
  return jobs
    .filter((j) => SOFTWARE.test(j.title) && !NOT.test(j.title))
    .filter((j) => PLACE.test(j.location ?? ""))
    .filter((j) => {
      const key = `${j.company}|${j.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
