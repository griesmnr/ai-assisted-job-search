import { describe, expect, it } from "vitest";
import { compileFilter, DEFAULT_TITLE_EXCLUDE } from "./criteria.js";
import { filterSoftwareEngineeringJobs, matchesTitleExclusion } from "./swe-filter.js";
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

  it("no titleInclude/nearLocations/remoteOk means no restriction on that axis; titleExclude omitted still applies the ticket 6b2313a staff-title default, which this title doesn't hit", () => {
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

describe("compileFilter — DEFAULT_TITLE_EXCLUDE (ticket 6b2313a)", () => {
  // Real fixture check (2026-09-03): no title in apps/api/src/sources/
  // __fixtures__/ contains "staff", "distinguished", or "fellow" in any
  // form — the only hit anywhere in the fixture set is "Staffing" inside
  // description/URL text (usajobs-real-response.json), never a title, and
  // this filter only ever reads `title`. So — same as swe-filter.test.ts's
  // precedent for "designer"/"manager" suffix forms with no fixture
  // evidence — these titles are realistic-but-synthetic, and the
  // word-boundary claims are cross-checked directly against
  // `matchesTitleExclusion` (swe-filter.ts's own NOT regex, which carries
  // the identical three words) so the two default lists are proven to
  // agree, not just asserted independently.
  const staffTitle = "Staff Software Engineer";
  const distinguishedTitle = "Distinguished Engineer";
  const fellowTitle = "Research Fellow";
  const falsePositiveRisk = "Onsite Support for Understaffed Teams";

  it("swe-filter.ts's NOT regex agrees with DEFAULT_TITLE_EXCLUDE on all three words — the two default paths (undefined-criteria vs. explicit-criteria-omitting-titleExclude) can't silently diverge", () => {
    for (const word of DEFAULT_TITLE_EXCLUDE) {
      expect(matchesTitleExclusion(`Some ${word} Title`), word).toBe(true);
    }
  });

  it("a caller who supplies criteria but omits titleExclude gets staff/distinguished/fellow excluded by default", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: staffTitle }),
      job({ externalId: "2", title: distinguishedTitle }),
      job({ externalId: "3", title: fellowTitle }),
      job({ externalId: "4", title: "Software Engineer" }),
    ];
    // titleInclude left broad enough that all four would otherwise pass —
    // isolates titleExclude's default from titleInclude's own behavior.
    const filter = compileFilter({
      titleInclude: ["software engineer", "distinguished engineer", "research fellow"],
    });
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["4"]);
  });

  it('word-boundary matched: "Staff Software Engineer" is excluded, but a false-positive-risk title like "understaffed" is not — same class of defect as ticket 06b09cf', () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: staffTitle }),
      job({ externalId: "2", title: falsePositiveRisk }),
    ];
    const filter = compileFilter({});
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["2"]);
  });

  it("overridable: an explicit empty titleExclude turns the default off entirely — the real request shape a caller targeting staff roles sends", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: staffTitle }),
      job({ externalId: "2", title: distinguishedTitle }),
      job({ externalId: "3", title: fellowTitle }),
    ];
    const filter = compileFilter({ titleExclude: [] });
    expect(
      filter(jobs)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["1", "2", "3"]);
  });

  it("overridable: a caller can also swap in their own titleExclude list, replacing (not adding to) the default", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: staffTitle }),
      job({ externalId: "2", title: "Software Engineer, Contract" }),
    ];
    const filter = compileFilter({ titleExclude: ["contract"] });
    // The staff title now survives (default replaced, not merged); the
    // caller's own "contract" exclusion still applies.
    expect(filter(jobs).map((j) => j.externalId)).toEqual(["1"]);
  });

  it("compileFilter(undefined) — the CLI/no-criteria default — also excludes staff-level titles, via swe-filter.ts's NOT regex", () => {
    const jobs: NormalizedJob[] = [
      job({ externalId: "1", title: staffTitle, location: "Seattle, WA" }),
      job({ externalId: "2", title: "Software Engineer", location: "Seattle, WA" }),
    ];
    expect(compileFilter(undefined)(jobs).map((j) => j.externalId)).toEqual(["2"]);
  });
});
