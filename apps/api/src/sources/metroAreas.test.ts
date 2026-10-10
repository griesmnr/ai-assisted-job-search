import { describe, expect, it, vi } from "vitest";
import { CITY_COORDINATES } from "./cityCoordinates.js";
import {
  NEARBY_CITY_RADIUS_MILES,
  compileMetroAreaMatchers,
  haversineMiles,
  nearbySiblingCitiesFor,
} from "./metroAreas.js";

/**
 * Tests for the distance-based "include nearby cities" expansion (ticket
 * e5e1aa1, replacing ticket 410e1a2's two-metro curated table). The
 * end-to-end filter behavior -- "strict stays strict, the flag widens" --
 * lives in criteria.test.ts; this file pins the distance math, the
 * caller-phrase resolution, and the region guard's edge cases (most of
 * which are unchanged from the table version -- `cityIsInRegions` itself
 * was not touched by this ticket).
 */

function coordinateFor(name: string, state: string): { lat: number; lon: number } {
  const found = CITY_COORDINATES.find((c) => c.name === name && c.state === state);
  if (found === undefined) throw new Error(`test fixture problem: no ${name}, ${state} in dataset`);
  return found;
}

describe("haversineMiles", () => {
  it("is zero for the same point and symmetric for two different ones", () => {
    const seattle = coordinateFor("seattle", "WA");
    expect(haversineMiles(seattle.lat, seattle.lon, seattle.lat, seattle.lon)).toBe(0);
    const olympia = coordinateFor("olympia", "WA");
    const a = haversineMiles(seattle.lat, seattle.lon, olympia.lat, olympia.lon);
    const b = haversineMiles(olympia.lat, olympia.lon, seattle.lat, seattle.lon);
    expect(a).toBeCloseTo(b, 10);
  });

  it("matches Nicole's real measured Olympia/Seattle distances to within a few miles", () => {
    // Nicole's own great-circle measurements (git-bug e5e1aa1, 2026-10-10)
    // used different reference points per city than this dataset's Census
    // "internal point" (see metroAreas.ts's NEARBY_CITY_RADIUS_MILES doc
    // comment) -- so these are NOT expected to match exactly, only to be
    // close enough that every accept/reject decision the ticket cites comes
    // out the same way. Her numbers: Olympia->Seattle 47.4, ->Bellevue 51.3,
    // ->Everett 72.7.
    const olympia = coordinateFor("olympia", "WA");
    const seattle = coordinateFor("seattle", "WA");
    const bellevue = coordinateFor("bellevue", "WA");
    const everett = coordinateFor("everett", "WA");

    const toSeattle = haversineMiles(olympia.lat, olympia.lon, seattle.lat, seattle.lon);
    const toBellevue = haversineMiles(olympia.lat, olympia.lon, bellevue.lat, bellevue.lon);
    const toEverett = haversineMiles(olympia.lat, olympia.lon, everett.lat, everett.lon);

    expect(toSeattle).toBeGreaterThan(40);
    expect(toSeattle).toBeLessThan(55);
    // The load-bearing fact behind "60, not 50": Bellevue is JUST past 50
    // miles from Olympia, not comfortably inside it.
    expect(toBellevue).toBeGreaterThan(50);
    expect(toBellevue).toBeLessThan(55);
    // And Everett is nowhere close to either radius.
    expect(toEverett).toBeGreaterThan(65);
  });
});

describe("the 60-mile radius (NEARBY_CITY_RADIUS_MILES)", () => {
  it("is 60, not 50 -- Bellevue is the reason", () => {
    expect(NEARBY_CITY_RADIUS_MILES).toBe(60);
    const olympia = coordinateFor("olympia", "WA");
    const bellevue = coordinateFor("bellevue", "WA");
    const everett = coordinateFor("everett", "WA");
    const toBellevue = haversineMiles(olympia.lat, olympia.lon, bellevue.lat, bellevue.lon);
    const toEverett = haversineMiles(olympia.lat, olympia.lon, everett.lat, everett.lon);
    // At 50 miles, Bellevue (just past 50) would be excluded while Seattle
    // (well under 50) is included -- the "visibly absurd" result the ticket
    // cites as the reason to go to 60 instead.
    expect(toBellevue).toBeGreaterThan(50);
    // 60 admits Bellevue...
    expect(toBellevue).toBeLessThanOrEqual(NEARBY_CITY_RADIUS_MILES);
    // ...and still excludes Everett.
    expect(toEverett).toBeGreaterThan(NEARBY_CITY_RADIUS_MILES);
  });
});

describe("nearbySiblingCitiesFor -- Olympia's real acceptance-criteria case", () => {
  it("expands Olympia to Seattle, Tacoma, Lacey and Bellevue, and not Everett", () => {
    const siblings = nearbySiblingCitiesFor("Olympia");
    expect(siblings).toContain("seattle");
    expect(siblings).toContain("tacoma");
    expect(siblings).toContain("lacey");
    expect(siblings).toContain("bellevue");
    expect(siblings).not.toContain("everett");
  });

  it("is a strict superset of what the old hand-curated Seattle group contained, for Seattle itself", () => {
    // Ticket e5e1aa1: "a 50-mile radius already covers everything the
    // hand-built Seattle-Tacoma-Bellevue group contains... A radius is
    // strictly more generous than the curated table, for every city rather
    // than two." Pinning that the deleted table's own city list is still
    // fully covered at 60 miles.
    const siblings = nearbySiblingCitiesFor("Seattle");
    for (const city of ["bellevue", "kirkland", "redmond", "renton", "everett", "tacoma"]) {
      expect(siblings, city).toContain(city);
    }
  });

  it("never mixes Seattle and Los Angeles", () => {
    expect(nearbySiblingCitiesFor("Seattle")).not.toContain("los angeles");
    expect(nearbySiblingCitiesFor("Los Angeles")).not.toContain("seattle");
  });

  it("drops every city the phrase already names, so a two-city phrase expands to the remainder", () => {
    // "Bellevue" alone is deliberately not used here -- it is ambiguous
    // nationwide (11 states; see AMBIGUOUS_CITY_NAMES's doc comment) and so
    // does not resolve bare, a real, disclosed behavior change from ticket
    // 410e1a2's table. Tacoma is unambiguous and genuinely a Seattle
    // sibling, so it exercises the same "two named cities" path cleanly.
    const expanded = nearbySiblingCitiesFor("Seattle or Tacoma");
    expect(expanded).not.toContain("seattle");
    expect(expanded).not.toContain("tacoma");
    expect(expanded).toContain("kirkland");
  });

  it("is symmetric -- a (region-qualified) Bellevue search reaches Seattle", () => {
    // Bare "Bellevue" does not resolve (see the test above) -- qualified
    // with its region, same as any other nationally-ambiguous name, it
    // resolves normally and reaches its real siblings.
    expect(nearbySiblingCitiesFor("Bellevue, WA")).toContain("seattle");
  });
});

describe("compileMetroAreaMatchers -- the region guard, per posting", () => {
  function matchesAny(phrase: string, location: string): boolean {
    return compileMetroAreaMatchers(phrase).some((m) => m(location));
  }

  it("Olympia's expansion matches real Seattle/Tacoma/Lacey/Bellevue location shapes and rejects Everett", () => {
    for (const location of [
      "Seattle, WA",
      "Seattle, Washington",
      "Tacoma, WA",
      "Lacey, WA",
      "Bellevue, WA",
      "Bellevue, Washington",
    ]) {
      expect(matchesAny("Olympia", location), location).toBe(true);
    }
    expect(matchesAny("Olympia", "Everett, WA")).toBe(false);
    expect(matchesAny("Olympia", "Everett, Washington")).toBe(false);
  });

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
    for (const location of ["Everett, MA 02149", "Everett, MA (HQ)", "Everett, MA (Hybrid)"]) {
      expect(matchesAny("Seattle", location), location).toBe(false);
    }
    expect(matchesAny("Seattle", "Redmond, OR 97756")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, NE 68005")).toBe(false);
    expect(matchesAny("Los Angeles", "Pasadena, TX 77501")).toBe(false);
    expect(matchesAny("Los Angeles", "Pasadena, TX (Hybrid)")).toBe(false);
    expect(matchesAny("Los Angeles", "Long Beach, NY - Hybrid")).toBe(false);
    expect(matchesAny("Seattle", "Redmond, Oregon")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, Nebraska")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, WA (HQ)")).toBe(true);
    expect(matchesAny("Seattle", "Bellevue, WA 98004")).toBe(true);
    expect(matchesAny("Seattle", "Bellevue, WA-Remote")).toBe(true);
  });

  it("does not read a two-letter code that is also an English word out of prose", () => {
    expect(matchesAny("Seattle", "Bellevue, WA; in office 3 days")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in office")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, or remote")).toBe(true);
  });

  it("does not read a hyphen-joined ambiguous word as a region code either", () => {
    expect(matchesAny("Seattle", "Tacoma, on-site")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in-office")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, in-person")).toBe(true);
  });

  it("still resolves a non-ambiguous code through a bare hyphen", () => {
    expect(matchesAny("Los Angeles", "Burbank, IL-Hybrid")).toBe(false);
    expect(matchesAny("Los Angeles", "Burbank, Illinois-Hybrid")).toBe(false);
    expect(matchesAny("Los Angeles", "Burbank, CA-Hybrid")).toBe(true);
  });

  it("does not misread a lowercase hyphenated word as a region code either", () => {
    expect(matchesAny("Seattle", "Tacoma, co-located")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, co-working space")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, Co-op")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, hi-tech campus")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, CO-Hybrid")).toBe(false);
  });

  it("requires a nationally-ambiguous city to name its region positively", () => {
    // "bellevue"/"everett"/"irvine" etc. are ambiguous across states in the
    // bundled dataset (AMBIGUOUS_CITY_NAMES), so -- same as the old table's
    // hand-picked REGION_REQUIRED_CITIES -- a bare mention on the POSTING
    // side is not enough.
    expect(matchesAny("Los Angeles", "Santa Ana, Costa Rica")).toBe(false);
    expect(matchesAny("Los Angeles", "Irvine, Scotland")).toBe(false);
    expect(matchesAny("Los Angeles", "Irvine, United Kingdom")).toBe(false);
    expect(matchesAny("Los Angeles", "Glendale, Phoenix, AZ")).toBe(false);
    expect(matchesAny("Los Angeles", "Glendale, United States")).toBe(false);
    expect(matchesAny("Seattle", "Kirkland, Canada")).toBe(false);
    expect(matchesAny("Seattle", "Everett, Middlesex County")).toBe(false);
    expect(matchesAny("Seattle", "Everett, United States")).toBe(false);
    // Cost, stated rather than hidden: a genuinely in-metro posting naming
    // no region is missed -- exactly strict behavior.
    expect(matchesAny("Seattle", "Bellevue")).toBe(false);
    expect(matchesAny("Seattle", "Bellevue, USA")).toBe(false);
    expect(matchesAny("Seattle", "Redmond (Hybrid)")).toBe(false);
    // Unambiguous names (one state nationwide) keep the absence-passes rule.
    expect(matchesAny("Los Angeles", "Los Angeles, United States")).toBe(true);
    expect(matchesAny("Los Angeles", "West Hollywood")).toBe(true);
    expect(matchesAny("Seattle", "Tacoma, 98402")).toBe(true);
    expect(matchesAny("Seattle", "Seattle")).toBe(true);
  });

  it("gives the caller's OWN city the same lenient matching as its siblings (review finding F2)", () => {
    expect(matchesAny("Seattle, WA", "Seattle, Washington")).toBe(true);
    expect(matchesAny("Seattle, WA", "Seattle, Washington, United States")).toBe(true);
    expect(matchesAny("Seattle, WA", "Seattle")).toBe(true);
    expect(matchesAny("Bellevue, WA", "Bellevue, Washington")).toBe(true);
    expect(matchesAny("Seattle, WA", "Seattle, WA (HQ)")).toBe(true);
    expect(matchesAny("Los Angeles, CA", "Los Angeles, California")).toBe(true);
    expect(matchesAny("Seattle, WA", "Denver, CO")).toBe(false);
  });

  it("resolves a region-qualified ambiguous name to ITS OWN place, not to a different metro entirely", () => {
    // Deliberate behavior change from the old table: "Pasadena, TX" used to
    // select nothing (no group had it); now it resolves to the real
    // Pasadena, TX and expands to ITS OWN nearby cities, which do not
    // include Los Angeles.
    expect(matchesAny("Pasadena, TX", "Los Angeles, CA")).toBe(false);
    expect(matchesAny("Pasadena, TX", "Pasadena, Texas")).toBe(true);
  });

  it("returns no matchers for a phrase naming no city at all -- the flag is then a no-op", () => {
    expect(compileMetroAreaMatchers("Remote")).toEqual([]);
    expect(compileMetroAreaMatchers("EMEA")).toEqual([]);
    expect(compileMetroAreaMatchers("")).toEqual([]);
    expect(compileMetroAreaMatchers("  ")).toEqual([]);
  });

  it("compiled matchers are reusable -- a cached RegExp's lastIndex cannot leak between jobs", () => {
    const matchers = compileMetroAreaMatchers("Seattle");
    const run = () => matchers.some((m) => m("Bellevue, WA"));
    expect(run()).toBe(true);
    expect(run()).toBe(true);
    expect(run()).toBe(true);
  });
});

describe("fails closed AND visibly -- the actual bug this ticket fixes", () => {
  it("warns, rather than staying silent, when a typed city has no coordinate data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matchers = compileMetroAreaMatchers("Timbuktu");
    expect(matchers).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Timbuktu");
    warn.mockRestore();
  });

  it("warns with the candidate states when a bare name is ambiguous nationwide, rather than guessing one", () => {
    // "Boston" exists in GA, IN and MA -- this file has no population data
    // to break that tie, so it is reported, not guessed.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compileMetroAreaMatchers("Boston")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("boston");
    expect(message).toContain("MA");
    warn.mockRestore();

    // ...while adding the state resolves it normally.
    expect(compileMetroAreaMatchers("Boston, MA").length).toBeGreaterThan(0);
  });

  it("warns when a named region does not match any dataset entry for that city", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // "Seattle" has no entry outside WA in the dataset.
    expect(compileMetroAreaMatchers("Seattle, TX")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not warn for a blank phrase -- nothing was attempted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compileMetroAreaMatchers("");
    compileMetroAreaMatchers("   ");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("MUTATION CHECK: a phrase that DOES resolve never warns", () => {
    // Guards the warning condition itself -- if `matchers.length === 0` were
    // accidentally replaced with a condition that's also true for a
    // resolved phrase, this would catch it going red.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matchers = compileMetroAreaMatchers("Olympia");
    expect(matchers.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
