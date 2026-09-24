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
} from "../matching/swe-filter.js";
import { compileMetroAreaMatchers } from "./metroAreas.js";
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
 * then `commitmentIn` (ticket 18c9f18: a job's `commitment` must be IN the
 * set; empty/omitted means no restriction; a job whose commitment is
 * unknown/undefined is EXCLUDED once this restriction is non-empty -- see
 * `SearchCriteria.commitmentIn`'s own doc comment in @app/shared for the
 * full reasoning on why this one field doesn't follow the
 * unmatched-data-passes-through pattern the location fields use), then the
 * same company|title dedupe `filterSoftwareEngineeringJobs` uses.
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

  function passesCommitment(job: Pick<NormalizedJob, "commitment">): boolean {
    if (commitmentIn.length === 0) return true;
    // `job.commitment` is undefined for a source that didn't/couldn't
    // report it -- excluded here on purpose, not passed through. See this
    // function's own doc comment above.
    return job.commitment !== undefined && commitmentIn.includes(job.commitment);
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
