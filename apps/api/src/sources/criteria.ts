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
import { filterSoftwareEngineeringJobs } from "./swe-filter.js";
import type { NormalizedJob } from "./types.js";

export type { SearchCriteria };

/**
 * Documentation/introspection only — NOT fed through the generic compiler
 * below. Describes, in the new four-field vocabulary, what
 * `filterSoftwareEngineeringJobs` conceptually does, for API responses that
 * want to echo back "what criteria were actually applied" when a caller
 * supplied none. The compiled behavior for "no criteria supplied" always
 * comes from delegating directly to `filterSoftwareEngineeringJobs` (see
 * `compileFilter`), never from compiling this object — so an edit here
 * can never silently change actual filtering behavior.
 */
export const DEFAULT_SEARCH_CRITERIA_DESCRIPTION: Required<SearchCriteria> = {
  titleInclude: [
    "software engineer",
    "full-stack",
    "fullstack",
    "back-end",
    "backend",
    "front-end",
    "frontend",
    "web engineer",
    "senior engineer",
    "staff engineer",
  ],
  titleExclude: [
    "manager",
    "director",
    "principal",
    "sales",
    "marketing",
    "recruit",
    "intern",
    "designer",
    "field service",
    "machine learning",
    "data scientist",
  ],
  nearLocations: ["seattle", "bellevue", "washington"],
  remoteOk: true,
};

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
 */
function makePhraseMatcher(phrase: string): (haystack: string) => boolean {
  const pattern = new RegExp(`\\b${escapeForRegex(phrase)}\\b`, "i");
  return (haystack: string) => pattern.test(haystack);
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
 * regardless of location text; neither set means no location restriction),
 * then the same company|title dedupe `filterSoftwareEngineeringJobs` uses.
 */
export function compileFilter(
  criteria: SearchCriteria | undefined,
): (jobs: NormalizedJob[]) => NormalizedJob[] {
  if (criteria === undefined) {
    return filterSoftwareEngineeringJobs;
  }

  const includeMatchers = (criteria.titleInclude ?? []).map(makePhraseMatcher);
  const excludeMatchers = (criteria.titleExclude ?? []).map(makePhraseMatcher);
  const nearMatchers = (criteria.nearLocations ?? []).map(makePhraseMatcher);
  const remoteOk = criteria.remoteOk ?? false;
  const hasLocationRestriction = nearMatchers.length > 0 || remoteOk;

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

  return (jobs: NormalizedJob[]) => {
    const seen = new Set<string>();
    return jobs
      .filter((j) => passesTitle(j.title))
      .filter((j) => passesLocation(j))
      .filter((j) => {
        const key = `${j.company}|${j.title}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };
}
