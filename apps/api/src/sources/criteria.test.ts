import { describe, expect, it } from "vitest";
import { compileExcludedForMissingWorkArrangement, compileFilter } from "./criteria.js";
import {
  excludedForMissingWorkArrangement,
  filterSoftwareEngineeringJobs,
} from "../matching/swe-filter.js";
import type { NormalizedJob } from "./types.js";

function job(overrides: Partial<NormalizedJob> & Pick<NormalizedJob, "externalId">): NormalizedJob {
  return {
    dataSource: "greenhouse",
    title: "Software Engineer",
    description: "a job",
    company: "Acme",
    location: "Seattle, WA",
    locationType: undefined,
    linkToApply: `https://example.com/${overrides.externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("compileFilter — default (no criteria supplied)", () => {
  it("delegates to filterSoftwareEngineeringJobs unmodified — the exactness guarantee", () => {
    // Not testing "produces a similar result" — testing that omitting
    // criteria really does select the SAME function the CLI uses, so
    // there is no separate implementation that could drift out of sync.
    expect(compileFilter(undefined)).toBe(filterSoftwareEngineeringJobs);
  });

  it("on a mixed pool, matches filterSoftwareEngineeringJobs's own survivor set exactly", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineer", location: "Seattle, WA" }),
      job({ externalId: "2", title: "Accountant II", location: "Seattle, WA" }),
      job({ externalId: "3", title: "Account Executive, Commercial", location: "Remote - US" }),
      job({ externalId: "4", title: "Backend Engineer", location: "Austin, TX" }),
      job({
        externalId: "5",
        title: "Senior Software Engineering Manager",
        location: "Seattle, WA",
      }),
    ];
    const viaDefault = compileFilter(undefined)(jobs);
    const viaDirect = filterSoftwareEngineeringJobs(jobs);
    expect(viaDefault.map((j) => j.externalId)).toEqual(viaDirect.map((j) => j.externalId));
    expect(viaDefault.map((j) => j.externalId)).toEqual(["1"]);
  });
});

describe("compileFilter — explicit criteria", () => {
  it("titleInclude: ANY match passes; jobs matching none are rejected", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Product Manager" }),
      job({ externalId: "2", title: "Data Analyst" }),
      job({ externalId: "3", title: "Software Engineer" }),
    ];
    const filter = compileFilter({ titleInclude: ["product manager", "software engineer"] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "3"]);
  });

  it("titleExclude applies after titleInclude — ANY match rejects", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior Software Engineer" }),
      job({ externalId: "2", title: "Software Engineering Manager" }),
    ];
    const filter = compileFilter({
      titleInclude: ["software engineer"],
      titleExclude: ["manager"],
    });
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("matching is word-boundary, not raw substring (no false positive on 'us' inside other words)", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineer", location: "Houston, TX" }),
      job({ externalId: "2", title: "Software Engineer", location: "Remote - US" }),
    ];
    const filter = compileFilter({ nearLocations: [], remoteOk: true });
    // "Houston" contains "us" but must not count as a near-location or
    // remote-US match; only #2 (genuinely remote) should survive.
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["2"]);
  });

  it("matches a title phrase that starts or ends on a non-word character (ticket 59fdc52 review round 3, N5)", () => {
    // Regression: an unconditional \b on BOTH ends of "c++" or ".net"
    // silently matched nothing — no error, just an always-empty result —
    // because \b has no meaning between two non-word characters (the "+"
    // at the end of "c++" and whatever follows it, e.g. a space, are both
    // non-word). makePhraseMatcher only anchors an end that IS itself a
    // word character.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior C++ Engineer", company: "Cpp Co" }),
      job({ externalId: "2", title: "Senior .NET Developer", company: "Dotnet Co" }),
      job({ externalId: "3", title: "Senior Java Engineer", company: "Java Co" }),
    ];
    const filter = compileFilter({ titleInclude: ["c++", ".net"] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("nearLocations passes regardless of work arrangement; remoteOk requires confirmed remote", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        title: "Software Engineer",
        company: "Denver Onsite Co",
        location: "Denver, CO",
        locationType: "onsite",
      }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "Denver Remote Co",
        location: "Denver, CO",
        locationType: "remote",
      }),
      job({
        externalId: "3",
        title: "Software Engineer",
        company: "Austin Onsite Co",
        location: "Austin, TX",
        locationType: "onsite",
      }),
    ];
    const filter = compileFilter({ nearLocations: ["denver"], remoteOk: false });
    // Both Denver postings pass (nearLocations ignores work arrangement);
    // the onsite Austin posting does not (no location match, remoteOk off).
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("no titleInclude/titleExclude/nearLocations/remoteOk means no restriction on that axis", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Anything At All", location: "Nowhere Special" }),
    ];
    expect(compileFilter({})(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("still dedupes by company|title like the CLI filter", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineer", company: "Acme" }),
      job({ externalId: "2", title: "Software Engineer", company: "Acme" }),
    ];
    const filter = compileFilter({ titleInclude: ["software engineer"] });
    expect(filter(jobs)).toHaveLength(1);
  });

  it("rejects an unmatched title even with an empty criteria object's title fields absent", () => {
    const jobs: NormalizedJob[] = [job({ externalId: "1", title: "Sales Rep" })];
    const filter = compileFilter({ titleInclude: ["software engineer"] });
    expect(filter(jobs)).toHaveLength(0);
  });
});

describe("compileFilter — explicit criteria never silently defaults titleExclude (ticket 6b2313a, F3 revert)", () => {
  // History: an earlier round of this ticket gave the explicit-criteria path
  // its own hidden `DEFAULT_TITLE_EXCLUDE` (staff/distinguished/fellow),
  // applied whenever a caller supplied `criteria` but omitted `titleExclude`.
  // Adversarial review (F2/F3) found it was actively wrong, not just
  // redundant: `distinguished`/`fellow` save nothing on this path (fellow's
  // only real matches are an early-career fellowship program, not staff
  // roles — see swe-filter.test.ts), and a caller who explicitly asked for
  // staff roles back via `titleInclude: ["staff software engineer"]` — the
  // natural, correct way to request them — got silently zero results, with
  // no way to know why. Removed entirely; this describe block replaces the
  // deleted "DEFAULT_TITLE_EXCLUDE" tests with proof of the CORRECT
  // behavior: the explicit-criteria path applies no title-exclude
  // restriction at all unless the caller supplies one, exactly like every
  // other criteria axis (`titleInclude`/`nearLocations`/`remoteOk`).
  it('a caller who explicitly names a staff-adjacent title via titleInclude gets it back — no hidden default silently zeroes it out (real title: "Staff Software Engineer", live Greenhouse pool, 2026-09-03 — see swe-filter.test.ts for the companies)', () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Staff Software Engineer" }),
      job({ externalId: "2", title: "Software Engineer" }),
    ];
    const filter = compileFilter({ titleInclude: ["staff software engineer"] });
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("an empty criteria object ({}) does not exclude a staff-level title — titleExclude omitted means no restriction, the same rule {}'s doc comment already states for every other axis", () => {
    const jobs: NormalizedJob[] = [job({ externalId: "1", title: "Staff Software Engineer" })];
    expect(compileFilter({})(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("compileFilter(undefined) — the CLI/no-criteria default, unaffected by this revert — still excludes staff-level titles via swe-filter.ts's own NOT regex (that exclusion lives there, not in criteria.ts; see swe-filter.ts's NOT comment)", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Staff Software Engineer", location: "Seattle, WA" }),
      job({ externalId: "2", title: "Software Engineer", location: "Seattle, WA" }),
    ];
    expect(compileFilter(undefined)(jobs).map((j) => j.externalId)).toEqual(["2"]);
  });
});

describe("compileFilter — role-word synonym expansion (ticket 0298b20)", () => {
  it('titleInclude "software engineer" matches a real "Senior Software Developer" posting — the live miss this ticket exists for (2026-09-23 run, all 8 sources)', () => {
    // The concrete, live-verified failure: Nicole's title list contained
    // "software engineer" and not "developer", so a real posting titled
    // "Senior Software Developer" scored zero matches even though a human
    // reading the board would call it the same role.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior Software Developer", company: "Dev Co" }),
      job({ externalId: "2", title: "Senior Software Engineer", company: "Eng Co" }),
      job({ externalId: "3", title: "Accountant II", company: "Books Co" }),
    ];
    const filter = compileFilter({ titleInclude: ["software engineer"] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("is symmetric — searching the developer phrasing finds the engineer posting too", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineer", company: "Eng Co" }),
      job({ externalId: "2", title: "Software Developer", company: "Dev Co" }),
    ];
    const filter = compileFilter({ titleInclude: ["software developer"] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("generalizes to professions with nothing to do with software — the ticket's actual requirement", () => {
    // The owner explicitly asked for a mechanism, not her own title list:
    // "I just hope that that learning gets, like, generically applied
    // enough that it would happen with other professions as well and not
    // just me and my own use case."
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Pharmacy Technician", company: "Pharmacy Co" }),
      job({ externalId: "2", title: "Sales Rep, Midwest", company: "Sales Co" }),
      job({ externalId: "3", title: "Senior Technical Author", company: "Docs Co" }),
      job({ externalId: "4", title: "Math Instructor", company: "School Co" }),
    ];
    expect(
      compileFilter({ titleInclude: ["pharmacy tech"] })(jobs).map((j) => j.externalId),
    ).toEqual(["1"]);
    expect(
      compileFilter({ titleInclude: ["sales representative"] })(jobs).map((j) => j.externalId),
    ).toEqual(["2"]);
    expect(
      compileFilter({ titleInclude: ["technical writer"] })(jobs).map((j) => j.externalId),
    ).toEqual(["3"]);
    expect(
      compileFilter({ titleInclude: ["math teacher"] })(jobs).map((j) => j.externalId),
    ).toEqual(["4"]);
  });

  it("NO FALSE POSITIVES across genuinely different roles — a qualified phrase keeps its qualifier through every substitution", () => {
    // The ticket's explicit safety criterion. "Sales Engineer" is a
    // pre-sales/solutions role and "Sales Development Representative" is
    // quota-carrying outbound sales; neither is what someone searching
    // "software engineer" wants. Expansion cannot reach them because the
    // qualifier ("software") survives the substitution — the only phrases
    // tried are "software developer" and "software programmer".
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Sales Engineer", company: "Presales Co" }),
      job({ externalId: "2", title: "Sales Development Representative", company: "SDR Co" }),
      job({ externalId: "3", title: "Real Estate Developer", company: "Property Co" }),
      job({ externalId: "4", title: "Civil Engineer", company: "Bridge Co" }),
      job({ externalId: "5", title: "Engineering Manager", company: "Mgmt Co" }),
      job({ externalId: "6", title: "Software Architect", company: "Arch Co" }),
      job({ externalId: "7", title: "Medical Coder", company: "Billing Co" }),
      job({ externalId: "8", title: "Software Developer", company: "Dev Co" }),
    ];
    // Only the genuinely-same role survives.
    expect(
      compileFilter({ titleInclude: ["software engineer"] })(jobs).map((j) => j.externalId),
    ).toEqual(["8"]);
    // And the reverse phrasing does not reach the real-estate developer.
    expect(
      compileFilter({ titleInclude: ["software developer"] })(jobs).map((j) => j.externalId),
    ).toEqual(["8"]);
  });

  it("regression (fable review, ticket 0298b20): a PTA/OTA search does not silently return zero results via an aide exclusion", () => {
    // The false positive the review found: "assistant"/"aide" were
    // originally grouped as cross-field synonyms, but in therapy fields
    // they're separate, licensed-vs-unlicensed occupations (BLS: "Physical
    // Therapist Assistants and Aides" are two distinct roles). A licensed
    // PTA searching for her own role while excluding the unlicensed one --
    // a completely natural, real search -- would have silently returned
    // NOTHING, because the excluded phrase's expansion caught the included
    // phrase's own expansion. That group is now removed (see
    // titleSynonyms.ts's NOT GROUPED section); this pins that it stays out.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Physical Therapy Assistant", company: "Clinic Co" }),
      job({ externalId: "2", title: "Physical Therapy Aide", company: "Clinic Co" }),
    ];
    const filter = compileFilter({
      titleInclude: ["physical therapy assistant"],
      titleExclude: ["physical therapy aide"],
    });
    // Must return the real PTA posting, not an empty list.
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1"]);
    // And a plain include must not pull in the aide posting either.
    expect(
      compileFilter({ titleInclude: ["physical therapy assistant"] })(jobs).map(
        (j) => j.externalId,
      ),
    ).toEqual(["1"]);
  });

  it("the qualifier rule: a BARE role word is never expanded, so it cannot drag in other professions", () => {
    // Without this rule, titleInclude: ["developer"] would expand to
    // "engineer" and start returning civil/sales/mechanical engineering.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Civil Engineer", company: "Bridge Co" }),
      job({ externalId: "2", title: "Sales Engineer", company: "Presales Co" }),
      job({ externalId: "3", title: "Software Developer", company: "Dev Co" }),
    ];
    expect(compileFilter({ titleInclude: ["developer"] })(jobs).map((j) => j.externalId)).toEqual([
      "3",
    ]);
    // Symmetrically, a bare "engineer" search does not pick up real-estate
    // or business "Developer" postings.
    const engineerJobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Real Estate Developer", company: "Property Co" }),
      job({ externalId: "2", title: "Civil Engineer", company: "Bridge Co" }),
    ];
    expect(
      compileFilter({ titleInclude: ["engineer"] })(engineerJobs).map((j) => j.externalId),
    ).toEqual(["2"]);
  });

  it("NEVER LOSES A MATCH — measured against the real captured titles in __fixtures__ (2026-09-23, 0 losses on 33 probes)", () => {
    // The core safety invariant: expansion only ADDS matchers, so on every
    // phrase the expanded survivor set is a SUPERSET of the literal one.
    // Verified at full scale during the ticket (all 151 distinct real
    // titles across the eight source fixtures, 33 probe phrases, zero
    // losses — see titleSynonyms.ts's MEASURED section); pinned here on a
    // representative real-title sample so a future edit that made
    // expansion *replace* rather than *add* fails loudly.
    const realTitles = [
      "Senior Software Engineer, Infrastructure Foundations",
      "Backend Software Engineer - Defense",
      "Staff Software Engineer, Open Source Server",
      "Software Engineer Internship, Android",
      "Business Systems Developer",
      "Civil Engineer (Structural)",
      "Calibration Engineer - Brake Controls",
      "Senior Systems Engineer II - Edge Platform & Packaging (On-Prem)",
      "Principal Cloud Engineer",
      "Data Engineer",
      "Machine Learning Engineer",
      "AI Agent Engineer",
      "Security Engineer, Cloud",
      "Sales Representative",
      "Workshop Sales Representative - Washington DC Area",
      "Software Development Engineer in Test (SDET)",
    ];
    const jobs: NormalizedJob[] = realTitles.map((title, i) =>
      job({ externalId: String(i), title, company: `Co ${i}` }),
    );
    const probes = [
      "software engineer",
      "software developer",
      "systems engineer",
      "sales representative",
      "engineer",
      "developer",
      "c++",
      "program analyst",
    ];
    // The literal, pre-ticket matcher, reconstructed here exactly as
    // makePhraseMatcher builds it (including the N5 conditional \b) so this
    // compares against real old behavior, not an approximation of it.
    function literalMatcher(phrase: string): (haystack: string) => boolean {
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const left = /^\w/.test(phrase) ? "\\b" : "";
      const right = /\w$/.test(phrase) ? "\\b" : "";
      const pattern = new RegExp(`${left}${escaped}${right}`, "i");
      return (haystack) => pattern.test(haystack);
    }

    for (const phrase of probes) {
      const expanded = new Set(
        compileFilter({ titleInclude: [phrase] })(jobs).map((j) => j.externalId),
      );
      const literal = literalMatcher(phrase);
      for (const j of jobs.filter((candidate) => literal(candidate.title))) {
        expect(expanded.has(j.externalId), `"${phrase}" lost real title "${j.title}"`).toBe(true);
      }
    }
  });

  it("a bare role word gains NOTHING on real captured titles — the qualifier rule, proven against Civil/Calibration Engineer", () => {
    // Without the qualifier rule, `titleInclude: ["developer"]` would
    // expand to "engineer" and sweep in these two genuinely non-software
    // real postings (both captured in sources/__fixtures__).
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Civil Engineer (Structural)", company: "Civil Co" }),
      job({ externalId: "2", title: "Calibration Engineer - Brake Controls", company: "Auto Co" }),
      job({ externalId: "3", title: "Business Systems Developer", company: "Biz Co" }),
    ];
    expect(compileFilter({ titleInclude: ["developer"] })(jobs).map((j) => j.externalId)).toEqual([
      "3",
    ]);
    expect(
      compileFilter({ titleInclude: ["engineer"] })(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it('a QUALIFIED phrase does gain the right real title — "systems engineer" finds "Business Systems Developer"', () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Business Systems Developer", company: "Biz Co" }),
      job({ externalId: "2", title: "Civil Engineer (Structural)", company: "Civil Co" }),
    ];
    expect(
      compileFilter({ titleInclude: ["systems engineer"] })(jobs).map((j) => j.externalId),
    ).toEqual(["1"]);
  });

  it("titleExclude expands too — include and exclude must share one matching semantics or the filter contradicts itself", () => {
    // If include were synonym-aware and exclude were literal, a caller
    // could surface "Software Developer" via titleInclude: ["software
    // engineer"] and then be unable to remove it with the same phrase.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior Software Developer", company: "Dev Co" }),
      job({ externalId: "2", title: "Senior Software Engineer", company: "Eng Co" }),
      job({ externalId: "3", title: "Senior Data Analyst", company: "Data Co" }),
    ];
    const filter = compileFilter({ titleExclude: ["software engineer"] });
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["3"]);
  });

  it("expansion runs through makePhraseMatcher unchanged, so it stays word-boundary matching (no new substring looseness)", () => {
    // "Software Engineering Manager" does not match "software engineer"
    // (the trailing \b fails against "engineeri"), and expansion must not
    // change that: "software developer"/"software programmer" don't match
    // it either.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineering Manager", company: "Mgmt Co" }),
      job({ externalId: "2", title: "Software Developers Guild Lead", company: "Guild Co" }),
      job({ externalId: "3", title: "Software Developer", company: "Dev Co" }),
    ];
    expect(
      compileFilter({ titleInclude: ["software engineer"] })(jobs).map((j) => j.externalId),
    ).toEqual(["3"]);
  });

  it("a non-word-character phrase (c++/.net) is untouched by expansion — the N5 boundary fix still holds", () => {
    // Regression guard for the composition requirement: these phrases have
    // no table word, expand to themselves, and hit exactly the same
    // makePhraseMatcher path as before this ticket.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior C++ Engineer", company: "Cpp Co" }),
      job({ externalId: "2", title: "Senior .NET Developer", company: "Dotnet Co" }),
      job({ externalId: "3", title: "Senior Java Engineer", company: "Java Co" }),
    ];
    expect(
      compileFilter({ titleInclude: ["c++", ".net"] })(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("does not touch nearLocations — location matching stays literal (ticket 0298b20 scope)", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Software Engineer", location: "Seattle, WA" }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "B Co",
        location: "Portland, OR",
      }),
    ];
    expect(compileFilter({ nearLocations: ["seattle"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
    ]);
  });

  it("the no-criteria default path is completely unaffected — expansion is explicit-criteria only", () => {
    expect(compileFilter(undefined)).toBe(filterSoftwareEngineeringJobs);
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Senior Software Developer", location: "Seattle, WA" }),
    ];
    // swe-filter's own SOFTWARE regex has no "developer" alternative, and
    // this ticket deliberately did not add one — the default path must be
    // byte-for-byte the CLI's behavior.
    expect(compileFilter(undefined)(jobs)).toEqual(filterSoftwareEngineeringJobs(jobs));
  });
});

describe("compileExcludedForMissingWorkArrangement (ticket 14289ac)", () => {
  // Pins the deliberate undefined-vs-explicit split documented on
  // compileExcludedForMissingWorkArrangement's own doc comment in
  // criteria.ts — nothing else asserts it, so a future refactor of
  // compileFilter (e.g. giving the explicit-criteria path a real
  // "us-wide" concept) could silently flip the REST default path to
  // reporting 0 excluded with no test failing to catch it.
  const usWideMissingArrangementJob: NormalizedJob = job({
    externalId: "1",
    title: "Software Engineer",
    location: "United States",
    locationType: undefined,
  });

  it("criteria === undefined delegates to the real excludedForMissingWorkArrangement, unmodified — same exactness guarantee as compileFilter(undefined)", () => {
    expect(compileExcludedForMissingWorkArrangement(undefined)).toBe(
      excludedForMissingWorkArrangement,
    );
    const result = compileExcludedForMissingWorkArrangement(undefined)([
      usWideMissingArrangementJob,
    ]);
    expect(result.map((j) => j.externalId)).toEqual(["1"]);
  });

  it("any EXPLICIT criteria, including {}, gets () => [] — not the real function — because the explicit-criteria location model has no 'us-wide' concept to report against", () => {
    expect(compileExcludedForMissingWorkArrangement({})([usWideMissingArrangementJob])).toEqual([]);
    expect(
      compileExcludedForMissingWorkArrangement({ titleInclude: ["software engineer"] })([
        usWideMissingArrangementJob,
      ]),
    ).toEqual([]);
  });
});

describe("compileFilter — commitmentIn (ticket 18c9f18)", () => {
  it("omitted/empty commitmentIn means no restriction — full-time, part-time, contract, and unknown-commitment jobs all pass", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        title: "Software Engineer",
        company: "Full Co",
        commitment: "full-time",
      }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "Part Co",
        commitment: "part-time",
      }),
      job({
        externalId: "3",
        title: "Software Engineer",
        company: "Contract Co",
        commitment: "contract",
      }),
      job({
        externalId: "4",
        title: "Software Engineer",
        company: "Unknown Co",
        commitment: undefined,
      }),
    ];
    expect(
      compileFilter({})(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2", "3", "4"]);
    expect(
      compileFilter({ commitmentIn: [] })(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("commitmentIn restricts to the named values", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        title: "Software Engineer",
        company: "Full Co",
        commitment: "full-time",
      }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "Part Co",
        commitment: "part-time",
      }),
      job({
        externalId: "3",
        title: "Software Engineer",
        company: "Contract Co",
        commitment: "contract",
      }),
    ];
    const filter = compileFilter({ commitmentIn: ["full-time", "contract"] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "3"]);
  });

  it("a job with unknown/undefined commitment is EXCLUDED once commitmentIn is a real, non-empty restriction — this app can't verify it matches what the caller asked for (ticket 18c9f18's PM ruling, see SearchCriteria.commitmentIn's doc comment)", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        title: "Software Engineer",
        company: "Known Co",
        commitment: "full-time",
      }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "Unknown Co",
        commitment: undefined,
      }),
    ];
    const filter = compileFilter({ commitmentIn: ["full-time"] });
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("compileFilter(undefined) — the CLI/no-criteria default — is unaffected by commitmentIn entirely (it doesn't exist on that path)", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        title: "Software Engineer",
        location: "Seattle, WA",
        commitment: undefined,
      }),
    ];
    expect(compileFilter(undefined)(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });
});
