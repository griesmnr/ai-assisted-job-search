import { describe, expect, it } from "vitest";
import { compileFilter } from "./criteria.js";
import { filterSoftwareEngineeringJobs } from "./swe-filter.js";
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
