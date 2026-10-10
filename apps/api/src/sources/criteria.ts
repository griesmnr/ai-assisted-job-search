/**
 * Compiles a caller-supplied `SearchCriteria` (packages/shared) into a
 * `NormalizedJob[] => NormalizedJob[]` filter — ticket 59fdc52 review round
 * 2, replacing the identity-filter default the first round shipped.
 *
 * That first round removed `filterSoftwareEngineeringJobs` outright on the
 * correct premise (its regexes hardcode Nicole's own title/location
 * criteria, which the v1 bar forbids) but the wrong remedy: deleting a
 * quality control isn't the same act as making it configurable, and
 * nothing replaced it. Measured consequence, real Greenhouse pool: 6,203
 * postings ingested, `POST /searches` scores `slice(0, 200)` in board-token
 * order — the first 200 are entirely Samsara, alphabetical by title, of
 * which 5 are software engineering roles and 195 are things like
 * "Accountant II" and "Account Executive, Commercial". The CLI's filter
 * scores 166, all relevant, for less money.
 *
 * The PM ruling (git-bug 59fdc52, 2026-08-29) is the fix: four fields
 * (`SearchCriteria`), substring/word-boundary matching (never a raw
 * user-supplied regex — a footgun and a ReDoS risk), and a default —
 * applied whenever a caller supplies NO `criteria` at all — that must
 * reproduce `filterSoftwareEngineeringJobs` EXACTLY, not approximately.
 *
 * This module gets that exactness by construction rather than by
 * re-deriving swe-filter.ts's regex logic (title regex plus the
 * PNW/US-wide/work-arrangement geography split, including the "Washington
 * but not Washington, D.C." carve-out — see swe-filter.ts's `PNW` comment)
 * through the new generic word-boundary primitives: `compileFilter`, when
 * given no criteria, returns `filterSoftwareEngineeringJobs` itself,
 * unmodified. Re-deriving that logic through a generic substring compiler
 * would risk a subtle mismatch (the D.C. carve-out in particular has no
 * clean word-boundary-substring expression); delegating to the exact same
 * function makes "identical to the CLI" true unconditionally, not "true as
 * long as nobody edits either copy out of sync." See criteria.test.ts and
 * scripts/verify-default-criteria-equivalence.ts for the live-pool proof.
 *
 * When a caller DOES supply `criteria`, this compiles a genuinely new
 * filter from it using the generic primitives below — that's the real new
 * capability this ticket adds, independent of the default's exactness
 * guarantee.
 */
import type { SearchCriteria } from "@app/shared";
import {
  excludedForMissingWorkArrangement,
  filterSoftwareEngineeringJobs,
  looksLikeContractOrTemp,
} from "../matching/swe-filter.js";
import { compileMetroAreaMatchers, nearbyCityExpansionWarnings } from "./metroAreas.js";
import { expandTitlePhrase } from "./titleSynonyms.js";
import type { NormalizedJob } from "./types.js";

export type { SearchCriteria };

/** Escapes regex metacharacters in a plain, caller-supplied string so it
 * can be safely embedded in a `\b...\b` pattern — this is what keeps
 * "substring/word-boundary matching" from becoming "the caller writes
 * regex": every character in `phrase` is matched literally. */
function escapeForRegex(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A single caller-supplied phrase compiled into a case-insensitive,
 * word-boundary-anchored literal matcher. Word-boundary because
 * substring-only matching has real false positives this codebase has
 * already hit in practice (swe-filter.ts's `US_WIDE` doc comment: a bare
 * "us" substring match would fire on "Houston"/"Austin"/"Columbus" without
 * `\b`) — multi-word phrases (e.g. "software engineer") get `\b` at each
 * end, which is the correct generalization.
 *
 * `\b` only fires at a transition between a `\w` character and a non-`\w`
 * character (or a string edge) — it has no meaning between two non-`\w`
 * characters. A phrase that STARTS or ENDS on a non-word character (ticket
 * 59fdc52 review round 3, N5: "c++", ".net") would, with an unconditional
 * `\b` on both ends, silently match NOTHING: "Senior C++ Engineer" has no
 * boundary between the second "+" and the space after it (both non-`\w`),
 * so `/\bc\+\+\b/i` fails on real, correctly-spelled input — no error, just
 * a criteria phrase that quietly excludes everything. Anchoring each end
 * with `\b` only when THAT end of the phrase is itself a word character
 * fixes it: "c++" anchors only its leading "c" (`\bc\+\+`, matching "C++"
 * as a plain trailing substring, no boundary required after "+"); ".net"
 * anchors only its trailing "t" (`\.net\b`). A phrase that's word-
 * characters on both ends (the common case — "software engineer",
 * "seattle") is unaffected: both anchors still apply, exactly as before.
 */
function makePhraseMatcher(phrase: string): (haystack: string) => boolean {
  const escaped = escapeForRegex(phrase);
  const leftBoundary = /^\w/.test(phrase) ? "\\b" : "";
  const rightBoundary = /\w$/.test(phrase) ? "\\b" : "";
  const pattern = new RegExp(`${leftBoundary}${escaped}${rightBoundary}`, "i");
  return (haystack: string) => pattern.test(haystack);
}

/**
 * Compiles ONE caller-supplied title phrase into a matcher that also accepts
 * the table-licensed role-word synonyms of that phrase (ticket 0298b20).
 *
 * Deliberately a thin wrapper over `makePhraseMatcher` rather than a new
 * matching primitive: every expanded phrase goes through the exact same
 * word-boundary compiler as the original, so the `c++` / `.net`
 * non-word-character handling documented above applies to expansions for
 * free and cannot drift. A phrase the table does not touch (a single word,
 * a phrase with no role word, "c++") expands to `[phrase]` and this
 * collapses to precisely today's single matcher.
 *
 * Title only. Locations have their own, separately-gated expansion -- see
 * `makeLocationMatcher` below and `metroAreas.ts`; the two tables never mix,
 * because a role-word synonym and a metro sibling are different claims with
 * different risks.
 */
function makeTitleMatcher(phrase: string): (haystack: string) => boolean {
  const matchers = expandTitlePhrase(phrase).map(makePhraseMatcher);
  if (matchers.length === 1) return matchers[0];
  return (haystack: string) => matchers.some((m) => m(haystack));
}

/**
 * Compiles ONE caller-supplied `nearLocations` phrase (ticket 410e1a2).
 *
 * `expandMetroAreas === false` -- the default, and what an omitted flag
 * means -- returns `makePhraseMatcher(phrase)` and nothing else, i.e. the
 * exact matcher this line compiled before the ticket existed. STRICT
 * BEHAVIOR IS NOT "REPRODUCED" HERE, IT IS THE SAME CODE PATH.
 *
 * With the flag on, the caller's literal matcher is still compiled and still
 * tested first; the curated metro table (`metroAreas.ts`, which carries the
 * full evidence and safety argument) only ever APPENDS metro-city matchers
 * after it. So expansion can only widen `nearLocations` -- every posting that
 * passed with the flag off still passes with it on -- and a phrase naming no
 * city in the table ("Denver", "EMEA", "") produces no extra matchers and
 * collapses back to the single literal matcher.
 *
 * The appended matchers cover the caller's OWN city as well as its metro
 * siblings, which is why the literal matcher is a floor rather than the whole
 * story for it: "Seattle, WA" with the flag on matches a posting phrased
 * "Seattle, Washington" through the metro matcher, not the literal one. See
 * `compileMetroAreaMatchers` for the measurement behind that.
 */
function makeLocationMatcher(
  phrase: string,
  expandMetroAreas: boolean,
): (haystack: string) => boolean {
  const literal = makePhraseMatcher(phrase);
  if (!expandMetroAreas) return literal;
  const metro = compileMetroAreaMatchers(phrase);
  if (metro.length === 0) return literal;
  return (haystack: string) => literal(haystack) || metro.some((m) => m(haystack));
}

const REMOTE_TEXT = /\bremote\b/i;

function isConfirmedRemote(job: Pick<NormalizedJob, "location" | "locationType">): boolean {
  if (job.locationType) return job.locationType === "remote";
  return REMOTE_TEXT.test(job.location ?? "");
}

// ---------------------------------------------------------------------------
// COMMITMENT AUDIT, 2026-10-06 — which sources actually POPULATE
// `Job.commitment` from real upstream data (ticket 623098e)
// ---------------------------------------------------------------------------
//
// MEASURED BY DRIVING EACH ADAPTER'S REAL `search()` against the captured
// fixtures in `__fixtures__/` with an injected `fetchImpl`, then counting
// `commitment` on the `NormalizedJob`s that actually came out. That method
// matters, and an earlier version of this table got two rows wrong by
// counting raw fixture fields instead: it is the adapter, not the payload,
// that decides what a posting ends up as. SmartRecruiters skips list
// postings whose detail fetch fails and Workable collapses duplicate
// shortcodes into one posting, so counting raw rows over-counts both.
// "normalized" is what `search()` returned; "mapped" is how many of those
// have a non-undefined `commitment`.
//
//   source           upstream field                  mapped/normalized  rate
//   ---------------- ------------------------------ ------------------ ------
//   greenhouse       (NONE — no such field exists)              0/6     0.0%
//   lever            categories.commitment                     10/13   76.9%
//   ashby            employmentType                             8/10   80.0%
//   rippling         employmentType.label (detail)              7/8    87.5%
//   recruitee        employment_type_code                      16/17   94.1%
//   smartrecruiters  typeOfEmployment.id                        5/5   100.0%
//   usajobs          PositionSchedule[0].Code                   2/2   100.0%
//   workable         employment_type                            6/6   100.0%
//
// Corpus totals: 67 normalized postings, 66 unique titles, 54 with a
// structured commitment (49 full-time, 4 contract, 1 part-time), 13 unknown.
//
// Rippling deserves one note so the 7/8 is not misread: its LIST rows carry
// no `employmentType` key AT ALL, so the field is readable only on the
// per-posting DETAIL response — which rippling.ts's Finding 1 makes
// mandatory anyway. The 14 list rows also collapse to 8 distinct postings by
// uuid. A list-only denominator would score this source 0%, not 87.5%.
//
// GREENHOUSE IS THE ONLY STRUCTURAL ZERO, and it is not a thin-fixture
// artifact: greenhouse.ts's header records that every job object's key set
// was inspected across all nine boards then checked, plus every board's
// custom `metadata` question names, at BOTH the list and single-job detail
// endpoints — the field does not exist in Greenhouse's public schema. The
// other seven all carry a real upstream field; their sub-100% rates are
// honest `undefined`s for values with no home in Job's 3-value enum
// ("Intern", "Temporary", "Fixed-Term", "Scholarship", "TEMP",
// "internship"), not missing plumbing.
//
// WHY THAT ZERO WAS ENOUGH TO EMPTY THE WHOLE PAGE: Greenhouse is not one
// source among eight by volume, it dominates the corpus. `.env.example`
// configures 25 Greenhouse boards against 4 Ashby / a handful elsewhere, and
// `compileFilter`'s own doc comment above measures the real Greenhouse pool
// at 6,203 postings. So "exclude every unknown-commitment job" deleted most
// of the result set, which is exactly the 50-results-to-zero Nicole and Jay
// both hit.
//
// payType — REPORTED, DELIBERATELY NOT FIXED HERE: greenhouse.ts and
// smartrecruiters.ts both record that `payType` has no reliable upstream
// source and is ALWAYS `undefined`, so the identical
// unknown-excluded-by-policy bug is latent for any future `payTypeIn`
// filter. There is no such filter today (`SearchCriteria` has no payType
// field), so there is nothing to fix yet and nothing user-visible is broken.
// Out of this ticket's scope on purpose; it needs its own ticket if a
// payType filter is ever added.
// ---------------------------------------------------------------------------

/**
 * Title phrasing that reads as part-time. Separate from
 * `looksLikeContractOrTemp` (swe-filter.ts) only because that function
 * answers the contract/temp question and there is no part-time equivalent
 * to reuse.
 *
 * `[\s-]?` so "Part-Time", "Part Time" and "Parttime" all match.
 * `\b`-anchored at both ends, which is what keeps it off "Department Time"
 * ("De|part" has no word boundary before "part", so it cannot fire there).
 *
 * MEASURED FALSE-POSITIVE RATE, 2026-10-06: 0 of the 49 real fixture
 * postings whose STRUCTURED commitment is "full-time" have a title matching
 * this, and 0 of all 66 unique real fixture titles match it at all.
 *
 * HONEST GAP, disclosed rather than dressed up (same disclosure ashby.ts's
 * `mapCommitment` makes about its own untested PartTime branch): no real
 * fixture posting demonstrates a TRUE positive either. The corpus has
 * exactly one genuinely part-time posting — a SmartRecruiters Bosch
 * "Werkstudent Supply Chain Management & Logistik" — and its title says
 * "Werkstudent", not "part-time", so this regex does not fire on it and
 * wouldn't have mattered there (SmartRecruiters reports that posting's
 * commitment structurally anyway, so it never reaches this inference). This
 * branch is therefore backed by the ordinary English phrasing of job titles,
 * not by an observed example, and its real target is the one source that has
 * no structured field at all: Greenhouse.
 */
const PART_TIME_TITLE = /\bpart[\s-]?time\b/i;

/**
 * Title phrasing that reads as an internship.
 *
 * The suffix handling is ticket 06b09cf's lesson, reused rather than
 * re-derived (see swe-filter.ts's header, which documents it at length, and
 * the `intern(ships?|s)?` branch of its own `NOT` regex). Both halves are
 * load-bearing: a bare `\bintern\b` MISSES "Internship" (the trailing `\b`
 * needs a boundary right after "intern", and "s" is a word character),
 * while a bare `\bintern` OVER-matches "internal", "international" and
 * "internationalize" — all real, wanted title words. Allowing only the
 * "s"/"ship"/"ships" suffixes before the closing `\b` catches the real
 * spellings and rejects the others, verified 2026-10-06: "Intern",
 * "Interns", "Internship", "Internships" all match; "internal",
 * "International Growth Lead", "Internationalization Engineer" and
 * "Internist" all do not.
 *
 * MEASURED, 2026-10-06: matches 4 of the 13 unknown-commitment fixture
 * postings, with 0 false positives against all 54 postings that DO have a
 * structured commitment.
 */
const INTERNSHIP_TITLE = /\bintern(?:ships?|s)?\b/i;

/**
 * Sentinel: this posting reads as a real employment type that
 * `Job["commitment"]`'s three values cannot express, so it matches NO
 * requested commitment and is filtered out whenever any restriction is set.
 *
 * It exists for internships. Folding them into one of the three real values
 * was the obvious alternative and is measurably worse: routing them to
 * "contract" takes a `["contract"]` search on the fixture corpus from 4
 * postings to 8, half of them internships — which is exactly the
 * "meaninglessly permissive" failure this ticket exists to avoid, just
 * relocated from full-time onto contract. Routing them to "part-time" is
 * worse still, since plenty of internships are full-time hours.
 *
 * So an internship matches nothing: it is visible in an UNFILTERED search
 * (where `commitmentIn` is empty and this code never runs) and absent from
 * all three filtered ones. That is the honest answer for a value the enum
 * cannot represent, and it follows this project's standing rule against
 * forcing a closed enum from data that does not fit it (greenhouse.ts's
 * `mapPayType`). The real fix — distinguishing "source has no field" from
 * "source reported a value this enum cannot hold", which needs a pg enum
 * migration — is filed separately as git-bug 9b13e58.
 */
const MATCHES_NO_COMMITMENT = "matches-no-commitment";

/**
 * The commitment this filter will TREAT a posting as having — the reversal
 * of ticket 18c9f18's unknown-is-excluded ruling (ticket 623098e,
 * 2026-10-06). See `SearchCriteria.commitmentIn`'s doc comment in
 * @app/shared for the full record of the reversal, and the COMMITMENT AUDIT
 * table above for the measurement that forced it.
 *
 * Three stages, in this order:
 *
 *   1. A STRUCTURED value always wins. Where a source reports commitment,
 *      that is the answer and no inference runs — the same "structured beats
 *      substring" principle `resolveWorkArrangement` and
 *      `looksLikeContractOrTemp` already follow. This is what keeps the
 *      seven sources that DO populate the field behaving exactly as they did
 *      before this ticket.
 *   2. TITLE INFERENCE, only when the structured field is absent —
 *      contract/temp, then internship, then part-time. This narrows the
 *      unknown bucket with evidence instead of guessing about it, and unlike
 *      stage 3 it helps part-time and contract rather than only full-time.
 *      An internship resolves to `MATCHES_NO_COMMITMENT`, matching none of
 *      the three rather than being forced into one.
 *   3. IMPUTE "full-time" for whatever is left.
 *
 * Measured effect of the whole chain on the fixture corpus, 2026-10-06, for
 * `commitmentIn: ["full-time"]`: 49 of 67 postings survived under 18c9f18's
 * rule, 58 of 67 survive now. `["part-time"]` returns 1 and `["contract"]`
 * returns 4 — in both cases exactly the postings whose SOURCE says so, with
 * no unknown admitted to either.
 *
 * WHY IMPUTATION RATHER THAN A SPECIAL CASE. The behavior could be written
 * as "unknown passes when the requested set contains full-time", but stating
 * it as an imputed value is the same behavior with a reason attached: the
 * claim being made is "an unlabelled professional posting is a full-time
 * posting", which is a statement about the corpus that can be argued with,
 * and the ordinary membership test then follows from it unchanged. It also
 * composes correctly over every subset without further case analysis —
 * ["full-time","contract"] admits unknowns, ["part-time","contract"] does
 * not — where a hand-written special case would need re-deriving each time
 * a value was added.
 *
 * WHY THE REVERSAL IS NOT UNIFORM ACROSS THE THREE VALUES. 18c9f18 treated
 * "cannot verify" as "does not match", which is cautious in the abstract and
 * wrong on this data. But the correction is NOT "include unknowns" — that
 * would fix full-time by breaking the other two in the opposite direction,
 * flooding a part-time or contract search with full-time roles and making
 * those filters meaningless. Unknown is PROBABLY full-time and probably NOT
 * part-time or contract, so it is imputed to full-time only: selecting
 * part-time or contract alone still excludes unknowns, and those two filters
 * keep exactly the precision they have today.
 *
 * NEVER WRITTEN DOWN, ONLY FILTERED ON. This imputation exists inside the
 * filter and nowhere else. It is deliberately NOT applied at normalization
 * time, because `Job.commitment` is what the SOURCE said and a posting that
 * stated nothing must keep reporting `undefined` — the project owner made
 * the field optional for exactly that reason (greenhouse.ts). Two concrete
 * things would go wrong if it were imputed upstream instead: a fabricated
 * "full-time" would be PERSISTED to Postgres (`jobs.commitment`), and it
 * would be fed to Claude in the scoring prompt, which interpolates
 * `job.commitment` directly (`matching/scoring.ts`'s `Type:` line) — so the
 * model would be told, as fact, something no employer said. Answering "did
 * the user ask for this posting" with a documented assumption is a different
 * act from recording a fact; only the former happens here.
 *
 * (It would NOT reach the UI: `routes/resumes.ts` deliberately destructures
 * `commitment` out of the response and nothing in `apps/web` renders it,
 * per ticket 8f5a79c. The Postgres and scoring-prompt reasons are the real
 * ones and they are enough.)
 *
 * TITLE ONLY, NOT DESCRIPTION — and this one is measured, 2026-10-06. Taking
 * the 49 real fixture postings whose structured commitment is "full-time" as
 * ground truth and running the contract/temp pattern against their
 * DESCRIPTION text produces 8 false positives (16%): Recruitee's Dutch
 * postings advertise a bonus "bij een contract" and list "Permanent
 * contract" as a BENEFIT — i.e. the word appears to assert the exact
 * opposite of contract work — a Lever account manager "owns the relationship
 * with current customers, including contract…", and a Rippling commercial
 * counsel's duties list "vendor and procurement contract". The same pattern
 * against their TITLES produces 0 false positives out of those 49, and 0 out
 * of all 66 unique real fixture titles. Descriptions are prose that discusses
 * employment and commerce; titles are where a posting LABELS itself. Hence
 * title only.
 *
 * Contract is tested before part-time because `looksLikeContractOrTemp` is
 * the hardened pattern of the two (it carries a real "Smart Contract"
 * false-positive fix); no real fixture title matches both, so the ordering
 * is not currently load-bearing.
 *
 * Reusing `looksLikeContractOrTemp` rather than writing a second
 * contract-matching regex is deliberate: it already carries scar tissue this
 * code would otherwise have to re-earn — the `(?<!\bsmart\s)` lookbehind
 * that stops "Smart Contract Engineer" (a real FULL-TIME title at coinbase
 * and robinhood, both configured Greenhouse boards here) from being read as
 * contract work, and the `contract(?:ors?|ing)?` suffix handling. A second
 * copy would be a second thing to keep in sync and a second place for that
 * bug to come back.
 *
 * It also brings this filter CLOSER to the contract/temp judgment the app
 * already publishes — `ScoredJobResult`'s `isContractOrTemp` is computed
 * from the same function — but it is NOT an agreement guarantee, and the
 * difference is worth stating precisely rather than overclaiming. The helper
 * is structured-OR-title; this resolver is structured-WINS. So a posting
 * whose source reports "full-time" while its title says "Contract" is
 * admitted to a full-time search here and still tagged contract/temp there:
 * a full-time-only search CAN show a card carrying that tag. Zero fixture
 * postings have that shape (0 of the 49 structurally-full-time postings have
 * a contract/temp title), and the tag erring toward caution is the
 * defensible side for a tag whose only job is to let a user hide rows — but
 * it is a real divergence, not an invariant.
 *
 * Note it also folds "Temp"/"Temporary" titles into "contract". That is not
 * a claim that temp and contract are the same employment relationship; it is
 * the only available answer, since `Job["commitment"]` has no temp member
 * (swe-filter.ts's audit comment records this gap and why widening the enum
 * is its own schema-migration ticket). It is also consistent with how the
 * app already groups them for the user, in the "Hide contract/temp roles"
 * toggle. The effect that matters is that a temp-titled posting is kept OUT
 * of a full-time-only search.
 *
 * KNOWN RESIDUAL, measured rather than estimated. A posting whose source
 * reports an employment type with no home in the 3-value enum arrives with
 * `commitment: undefined` and is indistinguishable here from a source that
 * has no field at all. If its title doesn't say so either, it is imputed
 * full-time. On the fixture corpus that is 7 of the 61 non-Greenhouse
 * postings (11.5%) before title inference — and notably these come from
 * sources that DO have the field and said something explicitly
 * not-full-time:
 *
 *   Lever      "Deployment Strategist, Internship"      (Internship)
 *   Lever      "Workplace Operations Analyst"           (Fixed-Term)
 *   Lever      "American Tech Fellowship"               (Scholarship)
 *   Ashby      "Software Engineer Internship, Android"  (Intern)
 *   Ashby      "IT Site Specialist"                     (Temporary)
 *   Rippling   "ML Software Engineer Intern - Winter 2027" (TEMP)
 *   Recruitee  "Copywriting Intern"                     (internship)
 *
 * `INTERNSHIP_TITLE` catches 4 of those 7 from their titles, leaving 3:
 * Ashby's "IT Site Specialist" (Temporary) and Lever's "Workplace
 * Operations Analyst" (Fixed-Term) and "American Tech Fellowship"
 * (Scholarship) — 3 of 61, 4.9%. Nothing in those three titles signals the
 * employment type, so no title pattern can reach them; they are imputed
 * full-time and will appear in a full-time search. That is still strictly
 * better than 18c9f18's behavior of returning nothing at all, and the real
 * fix is distinguishing "no field" from "unmappable value" so the latter
 * can resolve to `MATCHES_NO_COMMITMENT` — a pg enum migration, filed as
 * git-bug 9b13e58.
 */
function resolveCommitmentForFilter(
  job: Pick<NormalizedJob, "commitment" | "title">,
): NonNullable<NormalizedJob["commitment"]> | typeof MATCHES_NO_COMMITMENT {
  if (job.commitment !== undefined) return job.commitment;
  if (looksLikeContractOrTemp({ title: job.title })) return "contract";
  if (INTERNSHIP_TITLE.test(job.title)) return MATCHES_NO_COMMITMENT;
  if (PART_TIME_TITLE.test(job.title)) return "part-time";
  return "full-time";
}

/**
 * Compiles `criteria` into a `NormalizedJob[] => NormalizedJob[]` filter.
 *
 * `criteria === undefined` (the caller omitted the field entirely) is the
 * ONLY case that reproduces the CLI default — delegates straight to
 * `filterSoftwareEngineeringJobs`. An explicitly-supplied `{}` is treated
 * as a real, if maximally permissive, criteria object (no title
 * restriction, no location restriction beyond dedupe) — a caller who sends
 * an empty object asked for that, which is different from asking for
 * nothing.
 *
 * For explicit criteria: `titleInclude` (ANY match passes; empty/omitted
 * means no title restriction), then `titleExclude` (ANY match rejects,
 * applied after include), then location (`nearLocations`: ANY match passes
 * regardless of work arrangement; `remoteOk`: a confirmed-remote job passes
 * regardless of location text; neither set means no location restriction;
 * ticket 410e1a2's `expandMetroAreas` additionally lets each `nearLocations`
 * phrase match its curated metro siblings -- see `makeLocationMatcher`. That
 * flag is an ADDITION to `nearLocations`, never a restriction of its own: an
 * `expandMetroAreas: true` with no `nearLocations` has nothing to expand and
 * leaves `hasLocationRestriction` exactly as it was),
 * then `commitmentIn` (a job's resolved `commitment` must be IN the set;
 * empty/omitted means no restriction), then the same company|title dedupe
 * `filterSoftwareEngineeringJobs` uses.
 *
 * `commitmentIn`'s UNKNOWN-COMMITMENT RULE WAS REVERSED ON 2026-10-06
 * (ticket 623098e), and the reversal is recorded here rather than silently
 * applied. Ticket 18c9f18 ruled that a job whose `commitment` is unknown is
 * EXCLUDED the moment this restriction is non-empty, on the reasoning that a
 * job the app cannot verify as full-time does not satisfy a request for
 * full-time. What overturned it is a measurement, not a change of taste:
 * Greenhouse's public schema carries NO employment-type field at all
 * (greenhouse.ts, verified across all nine boards at both endpoints), and
 * Greenhouse dominates this corpus — 25 configured boards in `.env.example`,
 * 6,203 postings in the real pool measured above. So EVERY Greenhouse
 * posting has `commitment: undefined`, and 18c9f18's rule discarded all of
 * them: checking "full-time" turned a 50-result search into zero, reproduced
 * independently by Nicole and by Jay (git-bug 623098e). "Full-time" in
 * practice meant "only jobs from whichever sources happen to state
 * employment type", which is near-nothing.
 *
 * The replacement is NOT "include unknowns", which would fix one filter by
 * making the other two meaninglessly permissive. Unknown is resolved
 * per-value — structured value wins, else title inference, else imputed
 * full-time — so full-time becomes usable while part-time and contract keep
 * their precision. See `resolveCommitmentForFilter` above for the full
 * argument, the COMMITMENT AUDIT table beside it for the per-source
 * evidence, and `SearchCriteria.commitmentIn`'s doc comment in @app/shared.
 *
 * Note this makes `commitmentIn` consistent with, rather than an exception
 * to, the unmatched-data-still-passes spirit of `nearLocations`/`remoteOk`
 * that 18c9f18 explicitly carved itself out of.
 *
 * Ticket 0298b20: both title axes go through `makeTitleMatcher`, which adds
 * curated role-word synonyms (see `titleSynonyms.ts` for the table and the
 * full safety argument) -- so `titleInclude: ["software engineer"]` also
 * matches a real "Senior Software Developer" posting.
 *
 * BOTH axes, not just include, and that symmetry is load-bearing rather
 * than incidental: a filter whose include is synonym-aware and whose
 * exclude is literal is self-contradictory in a way users would experience
 * as a bug -- searching "software engineer" would surface "Software
 * Developer" postings that EXCLUDING "software engineer" then failed to
 * remove. One matching semantics for both, or the filter cannot be reasoned
 * about. (The risk profiles do differ: a loose include shows one extra row
 * and costs one extra scoring call, while a loose exclude hides a real job
 * invisibly -- the same asymmetry ingest/textSimilarity.ts documents for
 * false merges. That asymmetry is answered by keeping the TABLE
 * conservative, which is where `titleSynonyms.ts`'s "NOT GROUPED" section
 * spends its effort, rather than by making the two axes behave differently.)
 */
export function compileFilter(
  criteria: SearchCriteria | undefined,
): (jobs: NormalizedJob[]) => NormalizedJob[] {
  if (criteria === undefined) {
    return filterSoftwareEngineeringJobs;
  }

  const includeMatchers = (criteria.titleInclude ?? []).map(makeTitleMatcher);
  const excludeMatchers = (criteria.titleExclude ?? []).map(makeTitleMatcher);
  const expandMetroAreas = criteria.expandMetroAreas ?? false;
  const nearMatchers = (criteria.nearLocations ?? []).map((phrase) =>
    makeLocationMatcher(phrase, expandMetroAreas),
  );
  const remoteOk = criteria.remoteOk ?? false;
  const hasLocationRestriction = nearMatchers.length > 0 || remoteOk;
  const commitmentIn = criteria.commitmentIn ?? [];

  function passesTitle(title: string): boolean {
    if (includeMatchers.length > 0 && !includeMatchers.some((m) => m(title))) return false;
    if (excludeMatchers.some((m) => m(title))) return false;
    return true;
  }

  function passesLocation(job: Pick<NormalizedJob, "location" | "locationType">): boolean {
    if (!hasLocationRestriction) return true;
    const location = job.location ?? "";
    if (nearMatchers.some((m) => m(location))) return true;
    return remoteOk && isConfirmedRemote(job);
  }

  function passesCommitment(job: Pick<NormalizedJob, "commitment" | "title">): boolean {
    if (commitmentIn.length === 0) return true;
    // A job whose source didn't report commitment is NO LONGER excluded
    // outright (ticket 623098e reversed ticket 18c9f18's ruling on
    // 2026-10-06 -- that is what emptied the full-time filter). It is
    // resolved to the commitment this filter treats it as having: structured
    // value, else title inference, else imputed full-time. See
    // `resolveCommitmentForFilter` above for the per-value reasoning and the
    // COMMITMENT AUDIT table for the measurement.
    const resolved = resolveCommitmentForFilter(job);
    // An internship matches none of the three values rather than being
    // forced into one of them -- see `MATCHES_NO_COMMITMENT`.
    if (resolved === MATCHES_NO_COMMITMENT) return false;
    return commitmentIn.includes(resolved);
  }

  return (jobs: NormalizedJob[]) => {
    const seen = new Set<string>();
    return jobs
      .filter((j) => passesTitle(j.title))
      .filter((j) => passesLocation(j))
      .filter((j) => passesCommitment(j))
      .filter((j) => {
        const key = `${j.company}|${j.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
}

/**
 * Companion to `compileFilter`, for `RunDemoMatchOptions.excludedForMissingWorkArrangement`
 * (ticket 14289ac) — always compiled and passed alongside `compileFilter`'s
 * result by the two real callers (`main()` in demo-match.ts,
 * `routes/searches.ts`) so the two never drift out of sync for a given
 * request.
 *
 * `criteria === undefined` mirrors `compileFilter` exactly: the caller gets
 * the real `filterSoftwareEngineeringJobs`-equivalent exclusion count,
 * `excludedForMissingWorkArrangement` from swe-filter.ts.
 *
 * Any EXPLICIT `criteria` (including `{}`) instead gets `() => []`. Not an
 * oversight: `passesLocation` above is a genuinely different, simpler
 * location model (`nearLocations`/`remoteOk` substring matches) with no
 * "us-wide broad-US geography" concept at all — there is no equivalent
 * "excluded for missing work-arrangement metadata" reason to report against
 * it, and reporting swe-filter.ts's us-wide/PNW-based count against a
 * filter that doesn't share that model would be actively misleading, not
 * merely absent.
 */
export function compileExcludedForMissingWorkArrangement(
  criteria: SearchCriteria | undefined,
): (jobs: NormalizedJob[]) => NormalizedJob[] {
  if (criteria === undefined) {
    return excludedForMissingWorkArrangement;
  }
  return () => [];
}

/**
 * The reasons "include nearby cities" could not expand one or more of
 * `criteria.nearLocations`, surfaced to the CALLER -- ticket e5e1aa1 review
 * round 2, D8/Required 4. `compileMetroAreaMatchers`'s own `console.warn`
 * (metroAreas.ts) is operator-visible only, which does not satisfy the
 * ticket's central acceptance criterion ("a city with no coordinate data is
 * reported to the user"); this is the companion that a route handler calls
 * ALONGSIDE `compileFilter` (same pairing as
 * `compileExcludedForMissingWorkArrangement` above) and returns on the wire,
 * so the frontend can render it next to the checkbox that produced it.
 *
 * `[]` whenever there is nothing to report: no criteria, the flag off, or no
 * `nearLocations` at all -- mirroring `makeLocationMatcher`'s own "the flag
 * is an addition, never a restriction of its own" rule, so this never
 * fabricates a warning for a search that was never going to expand anything.
 */
export function locationExpansionWarnings(criteria: SearchCriteria | undefined): string[] {
  if (criteria === undefined || !criteria.expandMetroAreas) return [];
  const warnings: string[] = [];
  for (const phrase of criteria.nearLocations ?? []) {
    warnings.push(...nearbyCityExpansionWarnings(phrase));
  }
  return warnings;
}
