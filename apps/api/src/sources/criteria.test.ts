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
    // Verified at full scale during the ticket (all 68 distinct real
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

  it("THE REVERSAL (ticket 623098e, 2026-10-06): a job with unknown/undefined commitment now PASSES a full-time restriction instead of being excluded. Ticket 18c9f18 ruled the opposite; Greenhouse populates commitment for zero postings and dominates the corpus, so that ruling emptied the page", () => {
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
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1", "2"]);
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

/**
 * Ticket 623098e. The full-time filter returned ZERO results against real
 * data, reproduced independently twice, and the 38 KB of `commitmentIn`
 * tests above did not catch it -- because every one of them gave every job
 * in its set a KNOWN commitment, or asserted the unknown-exclusion rule that
 * was itself the bug. A suite that only ever tests all-known sets will pass
 * forever while the real multi-source case fails, and that is precisely what
 * happened.
 *
 * So these tests are organized around the two things the old block lacked:
 * a MIXED known/unknown set (what real multi-source results always are), and
 * an explicit check that fixing full-time did not make part-time and
 * contract permissive in the other direction.
 *
 * The job data below is REAL: every title/commitment pair is copied from a
 * captured fixture in `__fixtures__/` with its source named in a comment,
 * rather than invented to suit the assertion. Values come from
 * criteria.ts's dated COMMITMENT AUDIT table.
 */
describe("compileFilter — commitmentIn against a MIXED known/unknown set (ticket 623098e)", () => {
  // A realistic multi-source result set, in the proportions the audit
  // measured: Greenhouse supplies the bulk of the corpus (25 configured
  // boards in .env.example, a 6,203-posting real pool) and reports
  // commitment for NOTHING, while the other sources report it for most
  // postings. Titles and commitments are real fixture values.
  function mixedSourceJobs(): NormalizedJob[] {
    return [
      // --- greenhouse: commitment ALWAYS undefined (0/6 in the audit).
      // Titles from greenhouse-real-response-{airbnb,discord}.json.
      job({
        externalId: "gh-1",
        company: "Airbnb",
        title: "Acquisition Manager",
        commitment: undefined,
      }),
      job({
        externalId: "gh-2",
        company: "Airbnb",
        title: "AMER Gathering Programs Manager",
        commitment: undefined,
      }),
      job({
        externalId: "gh-3",
        company: "Airbnb",
        title: "Associate Principal, Strategic Finance & Analytics",
        commitment: undefined,
      }),
      job({
        externalId: "gh-4",
        company: "Discord",
        title: "Account Manager, Advertising Solutions",
        commitment: undefined,
      }),
      job({
        externalId: "gh-5",
        company: "Discord",
        title: "Data Engineer",
        commitment: undefined,
      }),
      job({
        externalId: "gh-6",
        company: "Discord",
        title: "Associate Product Counsel, Safety",
        commitment: undefined,
      }),
      // --- workable: employment_type "Full-time" (6/6 in the audit).
      job({
        externalId: "wk-1",
        dataSource: "workable",
        company: "Dispel",
        title: "Senior Systems Engineer II - Edge Platform & Packaging (On-Prem)",
        commitment: "full-time",
      }),
      job({
        externalId: "wk-2",
        dataSource: "workable",
        company: "TetraScience",
        title: "Principal Cloud Engineer",
        commitment: "full-time",
      }),
      // --- lever: categories.commitment, real mix of values.
      job({
        externalId: "lv-1",
        dataSource: "lever",
        company: "Outreach",
        title: "Account Manager, Commercial",
        commitment: "full-time",
      }),
      job({
        externalId: "lv-2",
        dataSource: "lever",
        company: "Palantir",
        title: "Talent Sourcer (Contractor)",
        commitment: "contract",
      }),
      // "Internship"/"Fixed-Term" have no home in Job's 3-value enum, so
      // Lever's mapCommitment honestly returns undefined for them. lv-3's
      // TITLE still says "Internship", so title inference catches it and it
      // matches none of the three values; lv-4's does not, so it is imputed
      // full-time -- the measured residual gap.
      job({
        externalId: "lv-3",
        dataSource: "lever",
        company: "Palantir",
        title: "Deployment Strategist, Internship",
        commitment: undefined,
      }),
      job({
        externalId: "lv-4",
        dataSource: "lever",
        company: "Palantir",
        title: "Workplace Operations Analyst",
        commitment: undefined,
      }),
      // --- ashby: employmentType.
      job({
        externalId: "as-1",
        dataSource: "ashby",
        company: "Temporal",
        title: "Senior Software Engineer, Infrastructure Foundations",
        commitment: "full-time",
      }),
      job({
        externalId: "as-2",
        dataSource: "ashby",
        company: "Ramp",
        title: "Marketing Media Strategist, International (Contract)",
        commitment: "contract",
      }),
      // --- smartrecruiters: typeOfEmployment.id (5/5 in the audit) --
      // the corpus's ONLY genuinely part-time posting.
      job({
        externalId: "sr-1",
        dataSource: "smartrecruiters",
        company: "BoschGroup",
        title: "Werkstudent Supply Chain Management & Logistik bei Bosch eBike Systems (w/m/div.)",
        commitment: "part-time",
      }),
      // --- usajobs: PositionSchedule Code "1".
      job({
        externalId: "us-1",
        dataSource: "usajobs",
        company: "Department of the Navy",
        title: "Civil Engineer (Structural)",
        commitment: "full-time",
      }),
    ];
  }

  it("the reproduction: a mixed set that returns a useful count unfiltered does NOT collapse to zero with full-time selected, and the Greenhouse postings specifically survive", () => {
    const jobs = mixedSourceJobs();
    const unfiltered = compileFilter({})(jobs);
    expect(unfiltered).toHaveLength(16);

    const fullTimeOnly = compileFilter({ commitmentIn: ["full-time"] })(jobs);

    // The headline property: not zero, and not a rump.
    expect(fullTimeOnly.length).toBeGreaterThan(0);
    expect(fullTimeOnly.length).toBeGreaterThanOrEqual(unfiltered.length / 2);

    // Under ticket 18c9f18's rule this was 5 of 16 -- every unknown-
    // commitment posting dropped, i.e. all six Greenhouse postings plus the
    // three Lever ones. Greenhouse surviving is the whole point of the fix.
    //
    // lv-3 is NOT here: its title says "Internship", so it resolves to
    // "matches no commitment" rather than being imputed full-time. lv-4 IS
    // here -- its source also said Fixed-Term, but nothing in "Workplace
    // Operations Analyst" says so, which is the measured residual gap
    // (git-bug 9b13e58).
    expect(fullTimeOnly.map((j) => j.externalId)).toEqual([
      "gh-1",
      "gh-2",
      "gh-3",
      "gh-4",
      "gh-5",
      "gh-6",
      "wk-1",
      "wk-2",
      "lv-1",
      "lv-4",
      "as-1",
      "us-1",
    ]);
  });

  it("an internship in the mixed set matches NONE of the three commitment values — not full-time, and not folded into contract where it would pad that filter with non-contract work", () => {
    const jobs = mixedSourceJobs();

    for (const commitmentIn of [
      ["full-time"],
      ["part-time"],
      ["contract"],
      ["full-time", "part-time", "contract"],
    ] as ("full-time" | "part-time" | "contract")[][]) {
      expect(
        compileFilter({ commitmentIn })(jobs).map((j) => j.externalId),
        `commitmentIn=${JSON.stringify(commitmentIn)}`,
      ).not.toContain("lv-3");
    }

    // But it is still visible in an unfiltered search -- the imputation and
    // the sentinel only exist while a restriction is set.
    expect(compileFilter({})(jobs).map((j) => j.externalId)).toContain("lv-3");
  });

  it("part-time does NOT become meaninglessly permissive: the mixed set's unknown-commitment jobs are still excluded, and only the genuinely part-time posting comes back", () => {
    const jobs = mixedSourceJobs();
    const partTimeOnly = compileFilter({ commitmentIn: ["part-time"] })(jobs);

    // One real part-time posting in a 16-job set. If unknowns leaked in this
    // would be 8+ and the filter would be useless.
    expect(partTimeOnly.map((j) => j.externalId)).toEqual(["sr-1"]);
  });

  it("contract does NOT become meaninglessly permissive: only the two genuinely-contract postings come back, not the unknowns", () => {
    const jobs = mixedSourceJobs();
    const contractOnly = compileFilter({ commitmentIn: ["contract"] })(jobs);

    expect(contractOnly.map((j) => j.externalId)).toEqual(["lv-2", "as-2"]);
  });

  it("part-time + contract together still excludes unknowns — neither value licenses the full-time imputation", () => {
    const jobs = mixedSourceJobs();
    const filter = compileFilter({ commitmentIn: ["part-time", "contract"] });

    expect(filter(jobs).map((j) => j.externalId)).toEqual(["lv-2", "as-2", "sr-1"]);
  });

  it("a requested set that CONTAINS full-time admits unknowns, because the imputed value is in the set", () => {
    const jobs = mixedSourceJobs();
    const filter = compileFilter({ commitmentIn: ["full-time", "contract"] });
    const ids = filter(jobs).map((j) => j.externalId);

    expect(ids).toContain("gh-1"); // unknown -> imputed full-time -> in set
    expect(ids).toContain("as-2"); // structurally contract -> in set
    expect(ids).not.toContain("sr-1"); // structurally part-time -> not in set
  });
});

describe("compileFilter — commitmentIn title inference for unknown commitment (ticket 623098e)", () => {
  it("a STRUCTURED commitment is never overridden by contradicting title text — structured beats substring, so the seven sources that report commitment behave exactly as before", () => {
    const jobs: NormalizedJob[] = [
      // Real shape: a posting whose title says "(Contract)" AND whose source
      // reports it structurally. The structured value must be what counts --
      // if inference ran first, a source-confirmed full-time posting with
      // "contract" anywhere in its title would vanish from a full-time
      // search.
      job({
        externalId: "1",
        company: "A Co",
        title: "Software Engineer (Contract) - Smart Home",
        commitment: "full-time",
      }),
      job({
        externalId: "2",
        company: "B Co",
        title: "Part-Time Software Engineer",
        commitment: "full-time",
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
      "2",
    ]);
    expect(compileFilter({ commitmentIn: ["contract"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["part-time"] })(jobs)).toEqual([]);
  });

  it("an unknown-commitment posting whose TITLE says contract is treated as contract, not imputed full-time — so it stays OUT of a full-time search and shows up in a contract one", () => {
    // Real title from ashby-real-response-ramp.json, but with commitment
    // undefined -- the Greenhouse case, where no structured field exists.
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        company: "Greenhouse Co",
        title: "Marketing Media Strategist, International (Contract)",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["contract"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
    ]);
  });

  it("an unknown-commitment posting whose TITLE says part-time is treated as part-time — the case the asymmetric policy would otherwise strand", () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        company: "GH Co",
        title: "Part-Time Data Engineer",
        commitment: undefined,
      }),
      job({
        externalId: "2",
        company: "GH Co",
        title: "Part Time Data Engineer",
        commitment: undefined,
      }),
      job({
        externalId: "3",
        company: "GH Co",
        title: "Parttime Data Engineer",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["part-time"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("an unknown-commitment posting whose TITLE says internship matches none of the three values, and is NOT folded into contract — real titles from four different source fixtures", () => {
    // All four are real unknown-commitment postings whose sources reported
    // Intern/Internship/TEMP: ashby ramp, lever palantir, recruitee, and
    // rippling. Routing these to "contract" would take the fixture corpus's
    // contract filter from 4 postings to 8, half of them internships.
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        dataSource: "ashby",
        company: "Ramp",
        title: "Software Engineer Internship, Android",
        commitment: undefined,
      }),
      job({
        externalId: "2",
        dataSource: "lever",
        company: "Palantir",
        title: "Deployment Strategist, Internship",
        commitment: undefined,
      }),
      job({
        externalId: "3",
        dataSource: "recruitee",
        company: "Channable",
        title: "Copywriting Intern",
        commitment: undefined,
      }),
      job({
        externalId: "4",
        dataSource: "rippling",
        company: "Rippling",
        title: "Machine Learning Software Engineer Intern - Winter 2027",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["contract"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["part-time"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["full-time", "part-time", "contract"] })(jobs)).toEqual(
      [],
    );
    // Unfiltered still shows all four.
    expect(compileFilter({})(jobs)).toHaveLength(4);
  });

  it('the internship pattern does not over-match "internal"/"international" titles — ticket 06b09cf\'s suffix lesson, which a bare \\bintern would fail', () => {
    const titles = [
      "Internal Tools Engineer",
      "International Growth Lead",
      "Internationalization Engineer",
      "Internist, Occupational Health",
    ];
    const jobs = titles.map((title, i) =>
      job({ externalId: String(i), company: `Co ${i}`, title, commitment: undefined }),
    );
    // All imputed full-time, none treated as internships.
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toHaveLength(titles.length);
  });

  it('a "Temp"/"Temporary" title is kept out of a full-time search, folded in with contract (Job["commitment"] has no temp member; this matches the app\'s own "Hide contract/temp roles" grouping)', () => {
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        company: "GH Co",
        title: "Software Engineer, Temp",
        commitment: undefined,
      }),
      job({
        externalId: "2",
        company: "GH Co",
        title: "Temporary Site Reliability Engineer",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toEqual([]);
    expect(compileFilter({ commitmentIn: ["contract"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
      "2",
    ]);
  });

  it('does NOT read "Smart Contract Engineer" as contract work — a real FULL-TIME title at coinbase and robinhood, both configured Greenhouse boards (so both arrive with commitment undefined, straight into this inference path)', () => {
    // This is the regression that reusing `looksLikeContractOrTemp` buys
    // instead of writing a second contract regex: that function already
    // carries the `(?<!\bsmart\s)` fix from ticket 8f5a79c's opus review.
    // Without it, a full-time search would silently drop these.
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        company: "Coinbase",
        title: "Smart Contract Engineer",
        commitment: undefined,
      }),
      job({
        externalId: "2",
        company: "Robinhood",
        title: "Senior Smart Contract Engineer, Protocols",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
      "2",
    ]);
    expect(compileFilter({ commitmentIn: ["contract"] })(jobs)).toEqual([]);
  });

  it("does not over-match ordinary titles into part-time or contract — plain unknown-commitment titles are imputed full-time", () => {
    // "Department" contains "part" but has no word boundary before it;
    // "Contractual"/"Attempt"/"Contemporary" are the documented
    // near-misses in swe-filter.ts's own regex comments.
    const titles = [
      "Department Time Lead",
      "Contractual Services Analyst",
      "Attempted Delivery Operations Manager",
      "Contemporary Art Program Manager",
      "Data Engineer",
    ];
    const jobs = titles.map((title, i) =>
      job({ externalId: String(i), company: `Co ${i}`, title, commitment: undefined }),
    );
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs)).toHaveLength(titles.length);
    expect(compileFilter({ commitmentIn: ["part-time", "contract"] })(jobs)).toEqual([]);
  });

  it("KNOWN RESIDUAL, asserted so it is visible rather than forgotten: a genuinely temp/intern posting whose source value has no home in the 3-value enum AND whose title doesn't say so is imputed full-time", () => {
    // These are the EXACT three postings left over after title inference,
    // measured 2026-10-06 by driving every adapter's real search() over the
    // fixtures: 3 of the 61 non-Greenhouse postings (4.9%), down from 7
    // (11.5%) before internship detection. Their sources each reported
    // something explicitly not-full-time (Ashby "Temporary", Lever
    // "Fixed-Term", Lever "Scholarship") which has no home in Job's 3-value
    // enum, so each adapter honestly returns undefined -- and nothing in
    // these three titles signals the employment type, so no title pattern
    // can reach them. They are imputed full-time.
    //
    // Still strictly better than 18c9f18's behavior of returning nothing at
    // all. The real fix is distinguishing "no field" from "unmappable
    // value", a pg enum migration filed as git-bug 9b13e58. This test exists
    // so the gap stays visible and so that ticket has a precise target.
    const jobs: NormalizedJob[] = [
      job({
        externalId: "1",
        dataSource: "ashby",
        company: "Ramp",
        title: "IT Site Specialist",
        commitment: undefined,
      }),
      job({
        externalId: "2",
        dataSource: "lever",
        company: "Palantir",
        title: "Workplace Operations Analyst",
        commitment: undefined,
      }),
      job({
        externalId: "3",
        dataSource: "lever",
        company: "Palantir",
        title: "American Tech Fellowship",
        commitment: undefined,
      }),
    ];
    expect(compileFilter({ commitmentIn: ["full-time"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});

/**
 * Ticket 410e1a2: opt-in metro-area expansion.
 *
 * The load-bearing property of this whole feature is the FIRST describe
 * block: with the flag off or absent, every location result is identical to
 * what it was before the feature existed. Every pre-existing `nearLocations`
 * test in this file is left untouched for the same reason -- they are the
 * real regression suite for "strict stays strict", and they pass unchanged.
 */
describe("compileFilter — metro-area expansion is OFF by default (ticket 410e1a2)", () => {
  // The exact scenario the ticket names, and the baseline the whole feature
  // depends on: verified true against this code BEFORE the feature was
  // written.
  const kirkland = job({ externalId: "1", location: "Kirkland, WA" });

  it("nearLocations ['Seattle'] does NOT match a posting located only in Kirkland, WA", () => {
    expect(compileFilter({ nearLocations: ["Seattle"] })([kirkland])).toEqual([]);
  });

  it("an explicit expandMetroAreas: false is identical to omitting it", () => {
    expect(
      compileFilter({ nearLocations: ["Seattle"], expandMetroAreas: false })([kirkland]),
    ).toEqual([]);
  });

  it("nor does it match the Bellevue-only postings that dominate the real corpus", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Bellevue, WA" }),
      job({ externalId: "2", company: "B Co", location: "Bellevue, Washington" }),
      job({ externalId: "3", company: "C Co", location: "Bellevue, WA; Menlo Park, CA" }),
    ];
    expect(compileFilter({ nearLocations: ["Seattle"] })(jobs)).toEqual([]);
  });

  it("still matches a multi-city posting that names Seattle itself — that already worked and must keep working", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Bellevue, Washington; Seattle, Washington" }),
    ];
    expect(compileFilter({ nearLocations: ["Seattle"] })(jobs).map((j) => j.externalId)).toEqual([
      "1",
    ]);
  });

  it("the flag alone, with no nearLocations, is not a location restriction of its own", () => {
    // `expandMetroAreas` widens `nearLocations` entries; with none to widen
    // it has nothing to do, and must not accidentally become a filter.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Kirkland, WA" }),
      job({ externalId: "2", company: "B Co", location: "Madrid, Spain" }),
    ];
    expect(
      compileFilter({ expandMetroAreas: true })(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2"]);
  });

  it("the no-criteria default path cannot reach this code at all", () => {
    expect(compileFilter(undefined)).toBe(filterSoftwareEngineeringJobs);
  });
});

describe("compileFilter — metro-area expansion when the caller opts in (ticket 410e1a2)", () => {
  const withFlag = { nearLocations: ["Seattle"], expandMetroAreas: true };

  it("the same Seattle search DOES match the Kirkland posting once the flag is set", () => {
    const jobs: NormalizedJob[] = [job({ externalId: "1", location: "Kirkland, WA" })];
    expect(compileFilter(withFlag)(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("matches every real Seattle-metro location spelling in the owner's captured corpus", () => {
    const jobs: NormalizedJob[] = [
      "Bellevue, WA",
      "Bellevue, Washington",
      "Bellevue, WA, USA",
      "Bellevue, WA; Menlo Park, CA",
      "Bellevue, Washington; Chicago, Illinois; New York, New York",
      "Bellevue, Washington; Seattle, Washington",
      "Kirkland, WA",
      "Redmond, WA",
      "Renton, Washington",
      "Everett, WA",
      "Tacoma, WA",
    ].map((location, i) => job({ externalId: String(i), company: `Co ${i}`, location }));
    expect(compileFilter(withFlag)(jobs)).toHaveLength(jobs.length);
  });

  it("does NOT reach into a different metro — the cross-metro false-positive check", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "la", location: "Los Angeles, CA" }),
      job({ externalId: "burbank", company: "B Co", location: "Burbank, California" }),
      job({ externalId: "anaheim", company: "C Co", location: "Anaheim, CA" }),
      job({ externalId: "portland", company: "D Co", location: "Portland, OR" }),
      job({ externalId: "denver", company: "E Co", location: "Denver, CO" }),
      job({ externalId: "spokane", company: "F Co", location: "Spokane, WA" }),
      job({ externalId: "vancouver", company: "G Co", location: "Vancouver, WA" }),
    ];
    expect(compileFilter(withFlag)(jobs)).toEqual([]);
    // ...and symmetrically, an LA search reaches no Seattle-metro city.
    const seattleSide: NormalizedJob[] = [
      job({ externalId: "1", location: "Bellevue, WA" }),
      job({ externalId: "2", company: "B Co", location: "Seattle, WA" }),
    ];
    expect(
      compileFilter({ nearLocations: ["Los Angeles"], expandMetroAreas: true })(seattleSide),
    ).toEqual([]);
  });

  it("does not match a same-named city in another state (the guard, end to end)", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Everett, MA" }),
      job({ externalId: "2", company: "B Co", location: "Kirkland, Quebec, Canada" }),
    ];
    expect(compileFilter(withFlag)(jobs)).toEqual([]);
  });

  it("the second metro works the same way — the pattern generalizes, not a Seattle special case", () => {
    const jobs: NormalizedJob[] = [
      // The real captured Match Group posting: located only in West
      // Hollywood, missed by a strict "Los Angeles" search today.
      job({
        externalId: "1",
        title: "Senior Software Engineer, Machine Learning Infrastructure",
        company: "Tinder LLC",
        location: "West Hollywood, California",
      }),
      job({ externalId: "2", company: "B Co", location: "Irvine, CA" }),
    ];
    const strict = { nearLocations: ["Los Angeles"] };
    expect(compileFilter(strict)(jobs)).toEqual([]);
    expect(compileFilter({ ...strict, expandMetroAreas: true })(jobs)).toHaveLength(2);
  });

  it("leaves a phrase with no metro in the table exactly as strict as before", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Denver, CO" }),
      job({ externalId: "2", company: "B Co", location: "Boulder, CO" }),
    ];
    expect(
      compileFilter({ nearLocations: ["Denver"], expandMetroAreas: true })(jobs).map(
        (j) => j.externalId,
      ),
    ).toEqual(["1"]);
  });

  it("composes with the other axes rather than bypassing them", () => {
    // A Kirkland posting reachable only via expansion is still subject to
    // titleInclude and commitmentIn -- expansion widens ONE axis, it does
    // not wave a job through the filter.
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: "Accountant II", location: "Kirkland, WA" }),
      job({
        externalId: "2",
        title: "Software Engineer",
        company: "B Co",
        location: "Kirkland, WA",
        commitment: "part-time",
      }),
      job({
        externalId: "3",
        title: "Software Engineer",
        company: "C Co",
        location: "Kirkland, WA",
        commitment: "full-time",
      }),
    ];
    expect(
      compileFilter({
        ...withFlag,
        titleInclude: ["software engineer"],
        commitmentIn: ["full-time"],
      })(jobs).map((j) => j.externalId),
    ).toEqual(["3"]);
  });

  it("the caller's own city matches as leniently as its siblings do (review finding F2)", () => {
    // The concrete regression this pins: with the flag on, a "Seattle, WA"
    // search used to get ONLY the literal `\bseattle, wa\b` for Seattle
    // while Bellevue got the region-guarded matcher -- so it matched a
    // Bellevue posting and missed a Seattle one written "Seattle,
    // Washington". Measured on the owner's real corpus, that cost 25 real
    // Seattle-named postings; the same corpus now gives 17 strict -> 72 with
    // the flag, up from 48.
    const jobs: NormalizedJob[] = [
      "Seattle, Washington",
      "Seattle, Washington, United States",
      "Seattle",
      "Seattle, WA (HQ)",
      "Bellevue, WA",
    ].map((location, i) => job({ externalId: String(i), company: `Co ${i}`, location }));
    const criteria = { nearLocations: ["Seattle, WA"], expandMetroAreas: true };
    expect(compileFilter(criteria)(jobs)).toHaveLength(jobs.length);
    // Strict is untouched: only the one literal spelling passes.
    expect(
      compileFilter({ nearLocations: ["Seattle, WA"] })(jobs).map((j) => j.externalId),
    ).toEqual(["3"]);
  });

  it("trailing text after a foreign state does not defeat the guard (review finding F1)", () => {
    // "City, ST <anything>" used to pass, because the guard demanded the
    // comma field BE the region. A Boston-area "Everett, MA (HQ)" landing in
    // a Seattle search is the false positive this whole module exists to
    // prevent, and "City, ST (suffix)" is a real shape in the corpus.
    const foreign: NormalizedJob[] = [
      "Everett, MA 02149",
      "Everett, MA (HQ)",
      "Redmond, OR 97756",
      "Bellevue, NE 68005",
    ].map((location, i) => job({ externalId: String(i), company: `Co ${i}`, location }));
    expect(compileFilter({ nearLocations: ["Seattle"], expandMetroAreas: true })(foreign)).toEqual(
      [],
    );
    // Same shapes, right state: still matched.
    const local: NormalizedJob[] = ["Bellevue, WA 98004", "Bellevue, WA (HQ)"].map((location, i) =>
      job({ externalId: String(i), company: `Co ${i}`, location }),
    );
    expect(
      compileFilter({ nearLocations: ["Seattle"], expandMetroAreas: true })(local),
    ).toHaveLength(2);
  });

  it("expansion is purely additive — every job that passed strict still passes", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", location: "Seattle, WA" }),
      job({ externalId: "2", company: "B Co", location: "Remote - US", locationType: "remote" }),
      job({ externalId: "3", company: "C Co", location: "Kirkland, WA" }),
      job({ externalId: "4", company: "D Co", location: "Austin, TX" }),
    ];
    const strict = compileFilter({ nearLocations: ["Seattle"], remoteOk: true })(jobs);
    const expanded = compileFilter({
      nearLocations: ["Seattle"],
      remoteOk: true,
      expandMetroAreas: true,
    })(jobs);
    const ids = (list: NormalizedJob[]) => list.map((j) => j.externalId);
    expect(ids(strict)).toEqual(["1", "2"]);
    for (const id of ids(strict)) expect(ids(expanded)).toContain(id);
    expect(ids(expanded)).toEqual(["1", "2", "3"]);
  });
});
