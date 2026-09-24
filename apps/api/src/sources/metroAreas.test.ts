import { describe, expect, it } from "vitest";
import {
  METRO_AREA_GROUPS,
  compileMetroAreaMatchers,
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

  it("still selects the metro when the caller's phrase has a trailing zip or parenthetical (review finding F1)", () => {
    // The caller side of F1: whole-field equality read "WA 98004" as "not a
    // region", which was harmless here (it selected the group anyway) but
    // silently wrong. Now it resolves, and the right-region cases still
    // select while the wrong-region ones still do not.
    expect(metroGroupsFor("Bellevue, WA 98004")).toHaveLength(1);
    expect(metroGroupsFor("Bellevue, WA (HQ)")).toHaveLength(1);
    expect(metroGroupsFor("Everett, MA 02149")).toEqual([]);
    expect(metroGroupsFor("Pasadena, TX (Hybrid)")).toEqual([]);
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

describe("compileMetroAreaMatchers — the region guard, per posting", () => {
  function matchesAny(phrase: string, location: string): boolean {
    return compileMetroAreaMatchers(phrase).some((m) => m(location));
  }

  it("matches the sibling-city location shapes that appear in this app's real data", () => {
    // Every one of these strings is copied from the owner's real scored
    // corpus (prep/match-results.json, written 2026-08-31) -- 29 of its 200
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

  it("rejects a same-named city whose trailing text hides the region (review finding F1)", () => {
    // The whole point of F1: whole-field equality required the field to BE
    // the region, so anything trailing it in the same field defeated the
    // guard entirely. Every one of these matched a Seattle/LA search before
    // the fix. "City, ST (suffix)" is not hypothetical -- the owner's corpus
    // contains "New York, NY (HQ); San Francisco, CA; Remote (US)".
    for (const location of ["Everett, MA 02149", "Everett, MA (HQ)", "Everett, MA (Hybrid)"]) {
      expect(matchesAny("Seattle", location), location).toBe(false);
    }
    expect(matchesAny("Seattle", "Redmond, OR 97756")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, NE 68005")).toBe(false);
    expect(matchesAny("Los Angeles", "Pasadena, TX 77501")).toBe(false);
    expect(matchesAny("Los Angeles", "Pasadena, TX (Hybrid)")).toBe(false);
    expect(matchesAny("Los Angeles", "Long Beach, NY - Hybrid")).toBe(false);
    // The original claimed-safe cases, re-pinned: no trailing text, and
    // still correctly rejected.
    expect(matchesAny("Seattle", "Redmond, Oregon")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, Nebraska")).toBe(false);
    // ...and the right region with the same trailing shapes still matches,
    // including a bare hyphen with no space before it -- "WA" is not one of
    // the ambiguous English-word codes, so it keeps resolving through a
    // hyphen exactly like it does through a space (fable review round 3).
    expect(matchesAny("Seattle", "Bellevue, WA (HQ)")).toBe(true);
    expect(matchesAny("Seattle", "Bellevue, WA 98004")).toBe(true);
    expect(matchesAny("Seattle", "Bellevue, WA-Remote")).toBe(true);
  });

  it("does not read a two-letter code that is also an English word out of prose", () => {
    // The protection whole-field equality got for free and the leading-token
    // scan has to re-earn: "in office" must not resolve to Indiana and drop
    // a real Bellevue posting.
    expect(matchesAny("Seattle", "Bellevue, WA; in office 3 days")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in office")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, or remote")).toBe(true);
  });

  it("does not read a hyphen-joined ambiguous word as a region code either (fable review round 2)", () => {
    // The naive version of the "not another word" rule treated a hyphen as
    // ending the word, so "on-site" was misread as the two-letter region
    // "ON" (Ontario) and a real Tacoma posting was wrongly rejected. For the
    // seven codes that are also ordinary English words, a hyphen directly
    // joining more letters must count as the SAME word continuing, exactly
    // like a space would.
    expect(matchesAny("Seattle", "Tacoma, on-site")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in-office")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in-person")).toBe(true);
  });

  it("still resolves a non-ambiguous code through a bare hyphen (fable review round 3)", () => {
    // Round 2's fix widened the hyphen-joins rule to every code, not just
    // the ambiguous ones -- which broke detection of a genuinely foreign
    // region attached by a bare hyphen. Burbank is a real city in BOTH the
    // LA metro table and a Chicago suburb; "IL" is not an ambiguous word,
    // so it must still resolve as a region through "-Hybrid" and correctly
    // reject a Chicago posting from an LA search.
    expect(matchesAny("Los Angeles", "Burbank, IL-Hybrid")).toBe(false);
    expect(matchesAny("Los Angeles", "Burbank, Illinois-Hybrid")).toBe(false);
    // ...and the real Burbank, CA still matches.
    expect(matchesAny("Los Angeles", "Burbank, CA-Hybrid")).toBe(true);
  });

  it("does not misread a lowercase hyphenated word as a region code either (fable review round 4)", () => {
    // Round 3's fix used a hand-curated list of ambiguous words, which was
    // itself incomplete: "co" (co-located, co-working, Co-op) wasn't on it,
    // so "Tacoma, co-located" still misread as Colorado and wrongly rejected
    // a real Tacoma posting -- the exact round-2 bug with a different code.
    // The fix replaces the list-completeness question with a property of
    // the data: a real "City, ST-suffix" code is written in caps; a
    // hyphenated English word essentially never is.
    expect(matchesAny("Seattle", "Tacoma, co-located")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, co-working space")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, Co-op")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, hi-tech campus")).toBe(true);
    // A real uppercase Colorado code is still correctly read as foreign and
    // rejects a same-named-elsewhere posting -- proving the fix distinguishes
    // "real caps code" from "prose", not just "any two-letter token before a
    // hyphen".
    expect(matchesAny("Seattle", "Tacoma, CO-Hybrid")).toBe(false);
  });

  it("requires an ambiguous city to name its region positively (review finding F4)", () => {
    // For the nine table cities whose bare name is a real place elsewhere,
    // "no region named" is not good enough on the posting side. Each of
    // these matched before the fix. Measured cost on the owner's corpus:
    // zero -- all 29 real Bellevue postings spell WA/Washington out.
    expect(matchesAny("Los Angeles", "Santa Ana, Costa Rica")).toBe(false);
    expect(matchesAny("Los Angeles", "Irvine, Scotland")).toBe(false);
    expect(matchesAny("Los Angeles", "Irvine, United Kingdom")).toBe(false);
    expect(matchesAny("Los Angeles", "Glendale, Phoenix, AZ")).toBe(false);
    expect(matchesAny("Los Angeles", "Glendale, United States")).toBe(false);
    expect(matchesAny("Seattle", "Kirkland, Canada")).toBe(false);
    expect(matchesAny("Seattle", "Everett, Middlesex County")).toBe(false);
    expect(matchesAny("Seattle", "Everett, United States")).toBe(false);
    // The cost, stated rather than hidden: a genuinely in-metro posting that
    // names no region is now missed, which is exactly strict behavior.
    expect(matchesAny("Seattle", "Bellevue")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, USA")).toBe(false);
    expect(matchesAny("Seattle", "Redmond (Hybrid)")).toBe(false);
    // Unambiguous names keep the absence-passes rule, so "Los Angeles,
    // United States" (the shape of the real Airbnb fixture) still matches
    // an LA search.
    expect(matchesAny("Los Angeles", "Los Angeles, United States")).toBe(true);
    expect(matchesAny("Los Angeles", "West Hollywood")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, 98402")).toBe(true);
    expect(matchesAny("Seattle", "Seattle")).toBe(true);
    // ...and a CALLER's bare ambiguous phrase still selects its metro, which
    // is the asymmetry `REGION_REQUIRED_CITIES` documents.
    expect(metroGroupsFor("Bellevue")).toHaveLength(1);
    expect(metroGroupsFor("Irvine")).toHaveLength(1);
  });

  it("gives the caller's OWN city the same lenient matching as its siblings (review finding F2)", () => {
    // The bug: the named city was skipped, so it got only criteria.ts's
    // literal matcher while every sibling got the region-guarded one. A
    // "Seattle, WA" search therefore matched "Bellevue, Washington" but not
    // "Seattle, Washington" -- its own city, differently punctuated. On the
    // owner's corpus that cost 25 real Seattle-named postings.
    expect(matchesAny("Seattle, WA", "Seattle, Washington")).toBe(true);
    expect(matchesAny("Seattle, WA", "Seattle, Washington, United States")).toBe(true);
    expect(matchesAny("Seattle, WA", "Seattle")).toBe(true);
    expect(matchesAny("Bellevue, WA", "Bellevue, Washington")).toBe(true);
    // Additive, not a replacement: the F1 guard still applies to the named
    // city, so trailing text does not defeat it either way.
    expect(matchesAny("Seattle, WA", "Seattle, WA (HQ)")).toBe(true);
    expect(matchesAny("Los Angeles, CA", "Los Angeles, California")).toBe(true);
    // And it does not become a way into another metro.
    expect(matchesAny("Seattle, WA", "Denver, CO")).toBe(false);
  });

  it("returns no matchers at all for a phrase outside the table — the flag is then a no-op", () => {
    expect(compileMetroAreaMatchers("Denver")).toEqual([]);
    expect(compileMetroAreaMatchers("Remote")).toEqual([]);
    expect(compileMetroAreaMatchers("")).toEqual([]);
  });

  it("compiled matchers are reusable — a shared global RegExp's lastIndex cannot leak between jobs", () => {
    // Regression guard for the one genuinely easy bug in this module: the
    // city patterns are compiled once, at module load, with the /g flag,
    // so `lastIndex` survives between calls unless it is reset. Left
    // unreset, the SECOND job in a search would be matched starting from
    // wherever the first one stopped -- i.e. results that depend on the
    // order jobs arrive in.
    const matchers = compileMetroAreaMatchers("Seattle");
    const run = () => matchers.some((m) => m("Bellevue, WA"));
    expect(run()).toBe(true);
    expect(run()).toBe(true);
    expect(run()).toBe(true);
  });
});
