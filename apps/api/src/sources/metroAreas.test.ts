import { describe, expect, it } from "vitest";
import {
  METRO_AREA_GROUPS,
  compileMetroSiblingMatchers,
  metroGroupsFor,
  metroSiblingCitiesFor,
} from "./metroAreas.js";

/**
 * Tests for the metro table itself (ticket 410e1a2). The end-to-end filter
 * behavior -- "strict stays strict, the flag widens" -- lives in
 * criteria.test.ts; this file pins the table's own invariants and the region
 * guard's edge cases.
 */
describe("METRO_AREA_GROUPS — table invariants", () => {
  it("every city is lowercase plain words, which is what makes a bare \\b anchor correct for all of them", () => {
    // The reason this matters: `makePhraseMatcher` (criteria.ts) has to
    // reason case-by-case about a CALLER's phrase, because "c++" and ".net"
    // break `\b`. This table's entries are ours, not the caller's, so the
    // constraint can simply be enforced -- and must be, since metroAreas.ts
    // compiles them with an unconditional `\b...\b`.
    for (const group of METRO_AREA_GROUPS) {
      for (const city of group.cities) {
        expect(city, `${group.metro}: ${city}`).toMatch(/^[a-z]+( [a-z]+)*$/);
      }
    }
  });

  it("no city appears in two metros — otherwise expansion would be order-dependent and the table unreviewable", () => {
    const seen = new Map<string, string>();
    for (const group of METRO_AREA_GROUPS) {
      for (const city of group.cities) {
        expect(seen.has(city), `${city} is in both ${seen.get(city)} and ${group.metro}`).toBe(
          false,
        );
        seen.set(city, group.metro);
      }
    }
  });

  it("every group declares regions and a non-trivial justification", () => {
    expect(METRO_AREA_GROUPS.length).toBeGreaterThanOrEqual(2);
    for (const group of METRO_AREA_GROUPS) {
      expect(group.regions.length).toBeGreaterThan(0);
      for (const region of group.regions) expect(region).toMatch(/^[A-Z]{2}$/);
      expect(group.cities.length).toBeGreaterThan(1);
      // A group whose `why` is a stub is a group nobody verified.
      expect(group.why.length).toBeGreaterThan(200);
    }
  });
});

describe("metroGroupsFor — which group a caller's phrase selects", () => {
  it("selects the Seattle metro for the phrasings people actually type", () => {
    for (const phrase of [
      "Seattle",
      "seattle",
      "Seattle, WA",
      "Seattle, Washington",
      "Greater Seattle Area",
      "Bellevue",
      "Tacoma, WA",
    ]) {
      expect(
        metroGroupsFor(phrase).map((g) => g.metro),
        phrase,
      ).toEqual([METRO_AREA_GROUPS[0].metro]);
    }
  });

  it("selects nothing for a phrase naming no city in the table", () => {
    for (const phrase of ["Denver", "Remote", "EMEA", "", "  ", "Washington, D.C."]) {
      expect(metroGroupsFor(phrase), phrase).toEqual([]);
    }
  });

  it("does not select a metro when the phrase pins the city to another region", () => {
    // The ambiguous-city-name cases the table's own doc comment names:
    // Everett, MA (Boston metro), Pasadena, TX (Houston metro), Glendale,
    // AZ (Phoenix metro). Typing one of these must not silently opt the
    // user into a metro 2,000 miles away.
    expect(metroGroupsFor("Everett, MA")).toEqual([]);
    expect(metroGroupsFor("Everett, Massachusetts")).toEqual([]);
    expect(metroGroupsFor("Pasadena, TX")).toEqual([]);
    expect(metroGroupsFor("Glendale, AZ")).toEqual([]);
    expect(metroGroupsFor("Kirkland, Quebec")).toEqual([]);
    // ...while the same cities in their own region still do.
    expect(metroGroupsFor("Everett, WA")).toHaveLength(1);
    expect(metroGroupsFor("Pasadena, CA")).toHaveLength(1);
  });

  it("a substring of a city name is not a city (word-boundary anchored)", () => {
    expect(metroGroupsFor("Renton-upon-Thames")).toHaveLength(1); // hyphen IS a boundary
    expect(metroGroupsFor("Bellevueville")).toEqual([]);
    expect(metroGroupsFor("Irvington")).toEqual([]);
  });
});

describe("metroSiblingCitiesFor — what a phrase expands to", () => {
  it("expands Seattle to its metro siblings and never to itself", () => {
    expect(metroSiblingCitiesFor("Seattle").sort()).toEqual(
      ["bellevue", "everett", "kirkland", "redmond", "renton", "tacoma"].sort(),
    );
  });

  it("is symmetric — a Bellevue search reaches Seattle", () => {
    expect(metroSiblingCitiesFor("Bellevue")).toContain("seattle");
  });

  it("drops every city the phrase already names, so a two-city phrase expands to the remainder", () => {
    const expanded = metroSiblingCitiesFor("Seattle or Bellevue");
    expect(expanded).not.toContain("seattle");
    expect(expanded).not.toContain("bellevue");
    expect(expanded).toContain("kirkland");
  });

  it("never mixes metros", () => {
    expect(metroSiblingCitiesFor("Seattle")).not.toContain("los angeles");
    expect(metroSiblingCitiesFor("Los Angeles")).not.toContain("seattle");
  });
});

describe("compileMetroSiblingMatchers — the region guard, per posting", () => {
  function matchesAny(phrase: string, location: string): boolean {
    return compileMetroSiblingMatchers(phrase).some((m) => m(location));
  }

  it("matches the sibling-city location shapes that appear in this app's real data", () => {
    // Every one of these strings is copied from the owner's real scored
    // corpus (prep/match-results.json, 2026-09-23) -- 29 of its 200
    // postings are Seattle-metro-but-not-Seattle, and these are the exact
    // spellings they use.
    for (const location of [
      "Bellevue, WA",
      "Bellevue, Washington",
      "Bellevue, WA, USA",
      "Bellevue, WA; Menlo Park, CA",
      "Bellevue, WA; Menlo Park, CA; New York, NY",
      "Bellevue, Washington; Chicago, Illinois; New York, New York",
      "Bellevue, Washington; San Francisco, California",
    ]) {
      expect(matchesAny("Seattle", location), location).toBe(true);
    }
  });

  it("a multi-city posting is judged on the field after ITS OWN city, not on the whole string", () => {
    // The concrete reason the guard is per-occurrence. A whole-string "does
    // this mention a foreign region" test would see "CA" and throw away a
    // job that really is in Bellevue -- 5 of the 29 real postings above.
    expect(matchesAny("Seattle", "Bellevue, WA; Menlo Park, CA")).toBe(true);
    // And the reverse: the Menlo Park half does not make it an LA job.
    expect(matchesAny("Los Angeles", "Bellevue, WA; Menlo Park, CA")).toBe(false);
  });

  it("rejects a same-named city in another region", () => {
    expect(matchesAny("Seattle", "Everett, MA")).toBe(false);
    expect(matchesAny("Seattle", "Everett, Massachusetts")).toBe(false);
    expect(matchesAny("Seattle", "Kirkland, Quebec, Canada")).toBe(false);
    expect(matchesAny("Los Angeles", "Pasadena, TX")).toBe(false);
    expect(matchesAny("Los Angeles", "Glendale, Arizona")).toBe(false);
    // Same cities, right region: still matched.
    expect(matchesAny("Seattle", "Everett, WA")).toBe(true);
    expect(matchesAny("Los Angeles", "Pasadena, California")).toBe(true);
  });

  it("accepts a bare city with no region at all — best effort, which is the widening direction the flag opted into", () => {
    expect(matchesAny("Seattle", "Bellevue")).toBe(true);
    expect(matchesAny("Seattle", "Everett")).toBe(true);
  });

  it("is not confused by non-region fields after the city", () => {
    expect(matchesAny("Seattle", "Bellevue, USA")).toBe(true);
    expect(matchesAny("Seattle", "Redmond (Hybrid)")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, 98402")).toBe(true);
  });

  it("returns no matchers at all for a phrase outside the table — the flag is then a no-op", () => {
    expect(compileMetroSiblingMatchers("Denver")).toEqual([]);
    expect(compileMetroSiblingMatchers("Remote")).toEqual([]);
    expect(compileMetroSiblingMatchers("")).toEqual([]);
  });

  it("compiled matchers are reusable — a shared global RegExp's lastIndex cannot leak between jobs", () => {
    // Regression guard for the one genuinely easy bug in this module: the
    // city patterns are compiled once, at module load, with the /g flag,
    // so `lastIndex` survives between calls unless it is reset. Left
    // unreset, the SECOND job in a search would be matched starting from
    // wherever the first one stopped -- i.e. results that depend on the
    // order jobs arrive in.
    const matchers = compileMetroSiblingMatchers("Seattle");
    const run = () => matchers.some((m) => m("Bellevue, WA"));
    expect(run()).toBe(true);
    expect(run()).toBe(true);
    expect(run()).toBe(true);
  });
});
