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
//
// F6 (ticket 6b2313a review round 2, corrected — round 1's comment here was
// wrong): the `staff engineer` alternative below is NOT dead code. NOT's
// staff exclusion (further down this file) has a range-aware precision fix
// that deliberately does NOT exclude a level-list title like "Senior/Staff
// Engineer" (the point of that fix is to stop dropping non-staff-only
// postings) — and for a slash-joined title like that, `staff engineer` is
// the ONLY SOFTWARE alternative that matches at all (no space before
// "engineer" for `senior engineer` to catch, no "software"/"full-stack"/etc
// present either). So this alternative is genuinely load-bearing: removing
// it would silently drop real "Senior/Staff Engineer"-shaped postings that
// NOT was specifically changed to stop excluding. Verified live,
// 2026-09-03: "Senior/Staff Engineer" survives SOFTWARE only via this
// alternative, and survives NOT (correctly, not staff-only).
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
// Ticket 6b2313a: `staff` and `distinguished` added to NOT (see the F1-F8
// history below for how this landed — `fellow` was tried and then dropped).
//
// SCOPE NOTE (opus adversarial review, F7 — PM-ratified 2026-09-03): the
// ticket as originally written asked for a `criteria`-object-only change
// ("go through criteria, not a hardcoded regex," "Out: any other change to
// SOFTWARE/NOT"), on the assumption that `criteria` is the live path. It
// isn't: `compileFilter(criteria === undefined)` — the ONLY path anything in
// this codebase currently exercises, since apps/web never sends a `criteria`
// object at all — delegates straight to THIS file's `filterSoftwareEngineeringJobs`,
// bypassing criteria.ts's generic machinery entirely. A criteria-only change
// would have been a complete no-op on the path that matters: zero real
// savings, against a ticket whose entire stated purpose is savings. The PM
// ratified editing NOT directly as a deliberate amendment to the ticket's
// "Out" line, because it's the only way to deliver the savings on the path
// real traffic takes. criteria.ts's own `DEFAULT_TITLE_EXCLUDE` — a second,
// independent copy of this idea on the *unused* explicit-criteria path — was
// reverted in the same review round (see criteria.ts's doc comment above
// `compileFilter`) for reasons unrelated to this scope call: it was actively
// wrong on that path (F2/F3 below).
//
// Measured across the 200 jobs scored 2026-08-31: STAFF/PRINCIPAL/etc titles
// (76 of the 200) had a best score of 52% and a median of 22% — no
// staff-level title has EVER cleared the 55% score floor (`principal` was
// already here; `staff` was the gap). Excluding them removes zero jobs the
// owner would ever see.
//
// F1 (opus review, blocking correctness fix): the original bare `\bstaff\b`
// excluded real, CURRENT, Senior-eligible postings that merely mention
// "staff" as one end of a level RANGE — live examples from the 2026-09-03
// pool: "Security Software Engineer, Infrastructure Security (Staff or
// Senior)" (MongoDB), "Site Reliability Engineer (Senior or Staff), Atlas"
// (×5 variants), "Site Reliability Engineering, Fabric (Mid, Senior, or
// Staff)", "Senior/Staff Applied Research Software Engineer" — none of these
// should be excluded; a Senior candidate is explicitly invited to apply.
// Fixed with lookaround that keeps `staff` excluding only when it is NOT
// adjacent to a level-list marker ("or ", "to ", or an immediately-adjacent
// "/" with no space) on either side:
//   (?<!\b(?:or|to)\s)(?<!\/)\bstaff\b(?!\s*(?:or|to)\b)(?!\/)
// The `\b` inside the lookbehind's `(?:or|to)\s` matters — without it,
// "Search **for** Staff Engineers" or "Transition **into** Staff Role" would
// wrongly read the trailing "or "/"to " of "for"/"into" as a range marker and
// suppress the real exclusion. Verified against every real example above
// (still NOT excluded) plus "Staff Software Engineer" and "Staff Engineer"
// (still excluded) — see swe-filter.test.ts.
//
// Known, measured-as-harmless residual gap (round 2 review): the "/" guard
// only covers an UNSPACED slash ("Staff/Senior"). A spaced slash ("Senior /
// Staff …") still excludes. Real example, 2026-09-03: "Senior / Staff
// Machine Learning Research Scientist, Agents" (Scale AI) — still excluded
// by this alternative, but has zero survivor impact: it fails SOFTWARE
// regardless (caught independently by the `machine learning` exclusion), so
// nothing currently reaching the scorer is affected. Not widened further
// since there's no live evidence yet that it needs to be — narrow the
// lookaround (e.g. `\s?\/\s?`) if a real spaced-slash SOFTWARE-passing title
// ever surfaces.
//
// F2 (opus review, measured per-word, corrected pool, 2026-09-03 — see
// verify-staff-title-exclusion-savings.ts for the reproducible script):
// against the live 6,204-posting Greenhouse pool, of the 178 titles that
// survived the OLD (pre-ticket) filter, `staff` (with F1's precision fix)
// alone removes 74 — effectively all of this change's real saving.
// `distinguished` alone removes 0 (only 2 occurrences anywhere in the pool,
// neither survives SOFTWARE) but is kept anyway: harmless today, and a
// future "Distinguished Engineer" title that DID clear SOFTWARE would
// genuinely be staff-tier, matching the ticket's original rationale. `fellow`
// was DROPPED entirely (not just imprecise — actively wrong): its only real
// matches pool-wide are all of the form "SWE Fellow - Human Frontier
// Collective (US/UK/Canada)", an early-career FELLOWSHIP PROGRAM, not a
// staff-level role. The ticket's "staff-level titles never clear the score
// floor" rationale has nothing to do with a junior fellowship — including it
// was a scope/correctness error independent of F1's regex-precision bug.
//
// F4 (opus review, honesty correction): an earlier version of this comment
// claimed "Zero real fixture TITLES contain any of the three words in any
// form — the only hit is 'Staffing' inside descriptive text/URLs." That was
// false: lever-real-response-palantir.json's own posting titled "American
// Tech Fellowship" is a real fixture TITLE containing "Fellow" (as
// "Fellowship") — swe-filter.test.ts's own test two sections up already cited
// this exact title, directly contradicting the claim made here. The correct
// characterization: real fixture titles containing these words as SUBSTRINGS
// do exist ("American Tech Fellowship"; usajobs-real-response.json also has
// "Goodfellow AFB, Texas" and "Staffing"-in-URL, both outside any title
// field), but none of them satisfy `\bword\b`'s word-boundary requirement
// against the bare words this file's NOT alternatives use ("Fellowship"
// has no boundary after "Fellow" — "s" is a word character, same class of
// miss as ticket 06b09cf's `\bintern\b`/"Internship").
//
// Boundary audit (2026-09-03, re-run after F1's fix): `\bstaff\b` (with the
// F1 lookaround) matches "Staff Software Engineer" and "Staff Engineer" but
// not "understaffed", "Staffing", or any of the real range-list titles named
// under F1; `\bdistinguished\b` has no fixture title to test against at all
// (0 occurrences). See swe-filter.test.ts for all of the above as executable
// tests, using real titles per F8.
// ---------------------------------------------------------------------------
const NOT =
  /\b(manager|director|principal|sales|marketing|recruit(ing|ment|ers?|s)?|intern(ships?|s)?|designer|field service|machine learning|data scientist|distinguished)\b|(?<!\b(?:or|to)\s)(?<!\/)\bstaff\b(?!\s*(?:or|to)\b)(?!\/)/i;

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
 *
 * Ticket 9cac9a9 (found by the 4450f39 adversarial reviewer, fixed before
 * going live): the guard above didn't cover the spelled-out "District of
 * Columbia" form. USAJOBS writes exactly that — not "DC"/"D.C." — and
 * wasn't wired into demo-match.ts yet when this was found, so it was latent,
 * not an active false positive. `usajobs-real-response.json` confirms both
 * pieces needed to construct the trap string honestly: the real spelling is
 * "District of Columbia" (its `CountrySubDivisionCode`, and embedded in
 * `LocationName`/`CityName` "Joint Base Anacostia-Bolling, District of
 * Columbia"), and USAJOBS's own `PositionLocationDisplay`/`LocationName`
 * fields both follow a "City, State" convention confirmed repeatedly in the
 * same fixture (e.g. "Walla Walla, Washington", "Gunter AFB, Alabama"). A
 * DC-proper posting (city "Washington") therefore reaches `location` as
 * "Washington, District of Columbia" — the exact literal string isn't
 * present verbatim in the fixture (no single fixture record has both city
 * "Washington" and state "District of Columbia" together), but every piece
 * of it is real, not invented. Would have failed in the worst direction:
 * DC federal jobs passing PNW unconditionally (PNW ignores work
 * arrangement), presenting as Washington-state postings.
 */
const PNW =
  /\b(?:seattle|bellevue)\b|\bwashington\b(?!,?\s*(?:d\.?c\.?|district of columbia))|,\s*wa\b/i;

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
