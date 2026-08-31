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
