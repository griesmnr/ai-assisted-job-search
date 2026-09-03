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
 * Columbia"). The "City, State" convention itself is confirmed repeatedly
 * (48 samples) in `LocationName` — e.g. "Walla Walla, Washington", "Gunter
 * AFB, Alabama". `job.location` is actually built from a DIFFERENT field,
 * `PositionLocationDisplay`, which the fixture only samples twice: one
 * follows the same convention ("Walla Walla, Washington"), the other is the
 * literal string "Multiple Locations" — evidence FOR the convention, not
 * disconfirming it, but thin (n=1), and worth naming honestly rather than
 * folding into the 48-sample `LocationName` claim above. A DC-proper
 * posting (city "Washington") would therefore reach `location` as
 * "Washington, District of Columbia" — the exact literal string isn't
 * present verbatim in the fixture (its one DC entry sits inside a
 * `PositionLocationDisplay: "Multiple Locations"` record, so it never
 * reaches `job.location` at all — multi-location USAJOBS postings collapse
 * their state detail before this filter ever sees it; currently harmless,
 * since "Multiple Locations" itself classifies `unknown` and is rejected),
 * but every piece used to construct it is real, not invented. Would have
 * failed in the worst direction: DC federal jobs passing PNW unconditionally
 * (PNW ignores work arrangement), presenting as Washington-state postings.
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

/**
 * The exact separator `lever.ts`'s `normalizeItem` uses to join a
 * multi-location posting's individual locations into the single string
 * stored as `Job.location` (see lever.ts, ~line 634:
 * `locations.join("; ")`). `Job.location` deliberately stays a joined
 * string — the ticket that raised this (git-bug 894b4ef) considered giving
 * locations their own representation on `Job` and rejected it: other code
 * (the UI, `resolveWorkArrangement`'s text fallback below) reasonably wants
 * "the whole location string" to display or scan, and Lever is not the only
 * source that can report several locations for one posting. So the split
 * happens here, at the one place that actually needs "one location at a
 * time" (geography classification), not by changing what gets stored.
 *
 * Semicolon-space, not comma: individual entries are themselves frequently
 * comma-containing city names (real Lever data: "Taiwan, Taipei"), so a
 * comma-join (and comma-split) would make one two-part entry
 * indistinguishable from two separate one-part entries.
 */
const LOCATION_LIST_SEPARATOR = "; ";

/**
 * git-bug 894b4ef: a Lever posting open to several locations reaches this
 * function as one `"; "`-joined string (e.g. real Binance fixture data:
 * `"South East Asia; Taiwan, Taipei; Hong Kong"`, from
 * lever-real-response-binance.json's "Account Manager - VIP Clients
 * (APAC)" — 3 locations; the ticket also measured a real 120-location, 3008-
 * char case on a live board, not committed to any fixture). Testing `PNW`
 * against that whole blob in one shot was wrong two ways: (1) a posting
 * with one PNW location among many unrelated ones would read as a genuine
 * "Seattle job" even for entirely unrelated locations, and (2) a regex
 * alternative like `,\s*wa\b` could in principle match text that SPANS a
 * join boundary rather than sitting inside one location.
 *
 * The fix: split on the exact separator the adapter joins with
 * (`LOCATION_LIST_SEPARATOR`, verified against lever.ts directly — see its
 * doc comment above), then run the existing single-location `PNW`/
 * `isUsWideText` checks against EACH piece independently, never against the
 * reassembled string. Splitting before testing (rather than testing the
 * whole string and trying to special-case boundaries after the fact) is
 * what actually closes the join-boundary risk: once a piece has been split
 * out, a regex run against it has no boundary text from its neighbors left
 * to match. A single-location string (the common case — every source other
 * than Lever, and most Lever postings too) has no `"; "` in it, so
 * `.split` returns a one-element array and behavior is identical to before
 * this change; this is exercised directly in swe-filter.test.ts.
 *
 * DESIGN DECISION (per the ticket's own acceptance criteria — this is a
 * stated choice, not an accident of substring matching): a multi-location
 * posting matches if ANY of its locations classifies as pnw/us-wide — the
 * same "any" a candidate would apply by hand ("is one of these places
 * somewhere I could take this job?"). "pnw" wins over "us-wide" across the
 * whole set, mirroring the existing single-location precedence (e.g.
 * "Seattle, WA, United States" was already "pnw", not "us-wide", before
 * this change) — implemented by short-circuiting the moment any piece is
 * pnw, since nothing else in the list can raise the result further.
 *
 * This "any" semantics is intentionally scoped to geography ONLY — it does
 * not mean a "remote" signal from one location is free to answer a
 * different location's work-arrangement question. See `passesLocationFilter`
 * for how the two questions get recombined per-location when `locationType`
 * is absent (opus review, git-bug 894b4ef round 2, finding 3).
 *
 * (Defense-in-depth note: the "a regex could match text spanning a join
 * boundary" risk this function's split-then-test structure closes is not a
 * demonstrated live bug — a 21,609-pair differential test run for the round
 * 2 review found zero cases where a naive whole-string match against PNW or
 * US_WIDE could actually span a "; " boundary, since none of either regex's
 * alternatives can match a literal ";". Splitting first still buys
 * robustness against a future separator or regex change reintroducing that
 * risk, which is reason enough to keep it, but it is not closing a bug
 * anyone observed.)
 */
function classifyLocationPiece(piece: string): Geography {
  if (PNW.test(piece)) return "pnw";
  if (isUsWideText(piece)) return "us-wide";
  return "unknown";
}

export function classifyGeography(location: string): Geography {
  const pieces = location.split(LOCATION_LIST_SEPARATOR);

  let best: Geography = "unknown";
  for (const piece of pieces) {
    const geography = classifyLocationPiece(piece);
    if (geography === "pnw") return "pnw"; // most specific outcome possible; nothing else in the list can beat it
    if (best === "unknown" && geography === "us-wide") best = "us-wide";
  }
  return best;
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

/**
 * git-bug 894b4ef DESIGN DECISION, REVISED (opus review round 2, finding 3):
 * whether geography and work arrangement are evaluated per-location or once
 * for the whole job depends on WHERE the arrangement signal comes from.
 *
 * When `job.locationType` is a structured value (Ashby/Lever/SmartRecruiters
 * supply this directly), it is genuinely one field for the WHOLE posting —
 * Lever/Ashby/SmartRecruiters report it once, not once per location, so a
 * posting doesn't have "12 work arrangements, pass if any is remote," it has
 * one. That case is unchanged from before this fix: `classifyGeography`'s
 * per-location "any" (see its doc comment) still applies, and the single
 * structured arrangement is checked once against the result.
 *
 * When `locationType` is ABSENT, though — common; per lever.ts's own doc
 * comment, none of `payType`/`commitment`/`locationType` is guaranteed
 * present — the ONLY arrangement signal left is `REMOTE_TEXT` matched
 * against free text. Round 1 of this ticket ran that text match against the
 * whole `"; "`-joined blob, which let a "remote" token attached to one
 * location answer the arrangement question for a completely different
 * location in the same list. Concrete failing case the reviewer found:
 * `{ location: "United States; Remote - Singapore", locationType: undefined }`
 * — `classifyGeography` correctly calls this "us-wide" (from the "United
 * States" piece), but the old whole-blob `REMOTE_TEXT` scan also matched
 * (from the unrelated "Remote - Singapore" piece) and the job passed. That's
 * the exact "onsite in Florida" trap this filter exists to prevent, just
 * leaking across a location-list boundary: "United States" alone, with no
 * arrangement signal of its OWN, must not pass just because some other
 * location in the list happens to say "remote".
 *
 * Fixed by making geography and arrangement resolve TOGETHER, per location
 * piece, whenever `locationType` is absent: each piece decides its own
 * pass/fail (pnw passes regardless of that piece's arrangement; us-wide only
 * passes if THAT piece's own text says "remote"), and the job passes if ANY
 * piece does. A single-location string has one piece, so this is unchanged
 * for the common case (e.g. "Remote U.S." alone still passes — "remote" and
 * "united states" are in the same piece, same as always).
 */
export function passesLocationFilter(
  job: Pick<NormalizedJob, "location" | "locationType">,
): boolean {
  const location = job.location ?? "";

  if (job.locationType) {
    // Structured value: one arrangement for the whole job, combined with
    // geography's existing whole-list "any" semantics.
    const geography = classifyGeography(location);
    if (geography === "unknown") return false;

    // PNW is physically reachable regardless of arrangement: a Seattle-area
    // onsite or hybrid role is exactly what a PNW-based candidate wants, and
    // a Seattle-area "remote" role is still fine too.
    if (geography === "pnw") return true;

    // geography === "us-wide": broad US without a specific city. Only a
    // genuinely remote role can be reached from anywhere in the US — hybrid
    // and onsite roles need the physical proximity "United States" alone
    // doesn't establish. That is the exact trap this filter exists to
    // close: "United States" with no remote signal could be onsite in
    // Florida.
    return job.locationType === "remote";
  }

  // No structured value: resolve geography and arrangement PER PIECE, so a
  // "remote" text match found in one location can never answer the
  // arrangement question for a different location in the same list (see
  // this function's doc comment for the concrete case this closes).
  for (const piece of location.split(LOCATION_LIST_SEPARATOR)) {
    const geography = classifyLocationPiece(piece);
    if (geography === "unknown") continue;
    if (geography === "pnw") return true; // reachable regardless of this piece's own arrangement
    if (REMOTE_TEXT.test(piece)) return true; // us-wide: only THIS piece's own text can qualify it
  }
  return false;
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
