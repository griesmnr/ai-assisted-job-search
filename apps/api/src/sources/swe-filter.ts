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

// ---------------------------------------------------------------------------
// `\bWORD\b` is only correct when every real suffixed form of WORD is either
// caught by the same trailing `\b` or genuinely shouldn't be. Ticket 06b09cf:
// `\bintern\b` doesn't match "Internship" -- the trailing `\b` needs a
// boundary immediately after "intern", and "s" (from "-ship") is a word
// character, so there's no boundary there. A real Ashby/ramp posting titled
// "Software Engineer Internship, Android" (see swe-filter.test.ts) passed
// SOFTWARE and slipped past NOT, reaching the scorer as if it were a regular
// SWE role.
//
// The fix is an explicit optional-suffix group, not a dropped trailing `\b`
// (`\bintern` alone would also match "internal", "internally",
// "international", "internationalize" -- all real, wanted title words).
// `(ships?|s)?` keeps the boundary requirement right after whichever suffix
// actually matched, so "internal"/"international" still fail to match at
// all (after "intern" the next character is "a", which is neither the
// start of "ship"/"ships" nor "s", so the optional group matches empty and
// the trailing `\b` then fails against "a") while "Intern", "Interns",
// "Internship", and "Internships" all match. No fixture title in this repo
// isolates the "international"/"internal" no-over-match guard -- the one
// candidate, ashby-real-response-ramp.json's "Marketing Media Strategist,
// International (Contract)", is excluded via the `marketing` alternative
// regardless of what this fix does, so it can't prove this specific case.
// That guard is verified at the regex level directly instead -- see
// swe-filter.test.ts's boundary tests.
//
// Audited every other NOT alternative for the same class of defect (a real
// suffixed form of WORD that the trailing `\b` fails to bridge), per the
// ticket's own request:
//   - `recruit` -> real fixture title "GTM Recruiter, AMER"
//     (ashby-real-response-notion.json) proves `\brecruit\b` misses
//     "Recruiter"; likely misses "Recruiting"/"Recruitment"/"Recruits" for
//     the identical reason even though no fixture happens to contain those
//     exact forms. Fixed the same way, below.
//   - `designer` -> no real fixture title contains "design" as a bare word
//     or as a prefix of a longer word, so there is no fixture evidence of
//     either an under-match (a suffixed "designer" form) or the over-match
//     the ticket speculated about (a bare `\bdesign\b` alternative, which
//     doesn't actually exist in this regex). Left unchanged.
//   - `manager` / `director` / `principal` -> every real fixture title
//     using these is already the exact singular word ("Acquisition
//     Manager", "Director, Product Management ...", "Associate Principal,
//     ..."); no fixture contains a plural ("Managers"/"Directors") or other
//     suffixed form, so there's no real evidence of a live defect here.
//     Left unchanged rather than guessing -- see the ticket's own warning
//     against inventing fixes for cases nobody has actually observed.
//   - `sales` / `marketing` / `machine learning` / `data scientist` /
//     `field service` -> every real fixture title containing these already
//     matches correctly (e.g. "Workshop Sales Representative", "Marketing
//     Media Strategist", "Senior Software Engineer, Machine Learning
//     Infrastructure" all have a genuine word boundary right where the
//     regex expects one). No fixture evidence of a defect. Left unchanged.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ticket 6b2313a: `staff`, `distinguished`, `fellow` added to NOT. Measured
// across the 200 jobs scored 2026-08-31: STAFF/PRINCIPAL/etc titles (76 of
// the 200) had a best score of 52% and a median of 22% — no staff-level
// title has EVER cleared the 55% score floor (`principal` was already here;
// `staff` was the gap). Excluding them removes zero jobs the owner would
// ever see while cutting ~38% of a run's scoring spend (76 x $0.0184 =
// ~$1.40/run at the time of measurement) — real money, since the owner is
// unemployed and paying API costs from savings.
//
// This closes the CLI/`compileFilter(undefined)` default path (this file IS
// that default — see criteria.ts's doc comment). It does NOT, by itself,
// make the exclusion overridable — `filterSoftwareEngineeringJobs` has no
// per-caller knobs at all, deliberately (that's the whole reason
// `compileFilter` exists). The override lives on the OTHER path:
// criteria.ts's `DEFAULT_TITLE_EXCLUDE` carries the same three words,
// applied only when a caller supplies explicit `criteria` and omits
// `titleExclude` — a caller who wants staff roles back sends
// `criteria: { titleExclude: [] }` (or their own list), which is real only
// on that path, not this one (omitting `criteria` entirely always gets
// this file's filter, non-negotiably, exactly as before this ticket).
//
// Boundary audit (same class of defect as ticket 06b09cf's `intern`/
// `Internship` miss, per this ticket's own instruction to check): searched
// every fixture under __fixtures__/ for "staff", "distinguish", "fellow" as
// substrings (2026-09-03). Zero real fixture TITLES contain any of the
// three words in any form — the only hit is "Staffing" inside descriptive
// text/URLs (usajobs-real-response.json, "USA Staffing Applicant Resource"
// and "apply.usastaffing.gov"), which this filter never reads (title-only)
// and which `\bstaff\b` wouldn't match anyway (no boundary right after
// "staff" in "Staffing" — "i" is a word character, same reason `\bintern\b`
// missed "Internship"). No fixture evidence of a real "Staffing
// Coordinator"-style title (the specific false-positive the ticket asked to
// check for) or of a plural/suffixed "Distinguished"/"Fellow" form, so all
// three are added as bare `\bword\b` alternatives, per this file's own
// audit precedent above (manager/director/principal/etc.) of not inventing
// suffix handling for a case nobody has actually observed. Verified
// directly: `\bstaff\b` matches "Staff Software Engineer" and "Staff
// Engineer" (both correctly excluded) but not "understaffed" or "Staffing"
// (no boundary at either transition — "r|s" and "ff|i" are both
// word-to-word) — see swe-filter.test.ts.
// ---------------------------------------------------------------------------
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit(ing|ment|ers?|s)?|intern(ships?|s)?|designer|field service|machine learning|data scientist|staff|distinguished|fellow)\b/i;

/** Exported so the exclusion regex can be verified directly against a real
 * fixture title string without also requiring that title to independently
 * match `SOFTWARE` first. Most of the excludable-word fixture titles (e.g.
 * "GTM Recruiter, AMER") never matched SOFTWARE to begin with, so asserting
 * on `filterSoftwareEngineeringJobs`'s combined output proves nothing about
 * NOT specifically -- see swe-filter.test.ts. Mirrors the precedent already
 * set by exporting `classifyGeography`/`resolveWorkArrangement` alongside
 * the combined `passesLocationFilter`. */
export function matchesTitleExclusion(title: string): boolean {
  return NOT.test(title);
}

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
