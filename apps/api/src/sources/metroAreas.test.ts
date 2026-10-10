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

/**
 * Dataset invariants (ticket e5e1aa1 review round 2, Required 3/D5). The
 * deleted hand-curated table had a test asserting exactly this CLASS of
 * thing for its own 20 strings ("every city is lowercase plain words, which
 * is what makes a bare \\b anchor correct") -- it was removed along with the
 * table instead of being re-pointed at the new, much larger dataset, which
 * left this module with LESS data-shape protection than when the data was
 * 20 hand-written literals. A test asserting all 51 state codes are present
 * would have caught the Hawaii gap (review round 2, D1) immediately, offline,
 * instead of needing a live report; a name-shape assertion would have
 * caught Juneau resolving to Wisconsin (D2) the same way.
 */
describe("CITY_COORDINATES -- dataset invariants", () => {
  it("has all 51 state codes (50 states + DC) -- would have caught the Hawaii gap", () => {
    const VALID_STATES = new Set([
      "AL",
      "AK",
      "AZ",
      "AR",
      "CA",
      "CO",
      "CT",
      "DE",
      "DC",
      "FL",
      "GA",
      "HI",
      "ID",
      "IL",
      "IN",
      "IA",
      "KS",
      "KY",
      "LA",
      "ME",
      "MD",
      "MA",
      "MI",
      "MN",
      "MS",
      "MO",
      "MT",
      "NE",
      "NV",
      "NH",
      "NJ",
      "NM",
      "NY",
      "NC",
      "ND",
      "OH",
      "OK",
      "OR",
      "PA",
      "RI",
      "SC",
      "SD",
      "TN",
      "TX",
      "UT",
      "VT",
      "VA",
      "WA",
      "WV",
      "WI",
      "WY",
    ]);
    const present = new Set(CITY_COORDINATES.map((r) => r.state));
    expect(present.size).toBe(51);
    for (const state of present) expect(VALID_STATES.has(state), state).toBe(true);
    for (const state of VALID_STATES) expect(present.has(state), state).toBe(true);
  });

  it("row count matches the header's documented count (19,670)", () => {
    // A row count drifting out of sync with the header's own claimed count
    // is a sign something was regenerated without the doc comment being
    // updated to match -- exactly what happened across this ticket's own
    // review rounds, caught here so it can't happen silently again.
    expect(CITY_COORDINATES.length).toBe(19670);
  });

  it("every name is lowercase letters/apostrophes/hyphens/spaces only, with no leftover stripped-suffix residue", () => {
    for (const { state, name } of CITY_COORDINATES) {
      expect(name, `${state}: "${name}"`).toMatch(/^[a-z][a-z' -]*$/);
      // The specific shape a BROKEN multi-word LSAD-suffix stripper leaves
      // behind ("Juneau city and borough" -> only "borough" stripped ->
      // "juneau city and") -- a trailing dangling function word is never a
      // real place name's own ending.
      expect(name, `${state}: "${name}"`).not.toMatch(/ (and|of|the|a|in|to|on)$/);
    }
  });

  it("every coordinate is finite and within the real US geographic range", () => {
    for (const { state, name, lat, lon, alandSqMi } of CITY_COORDINATES) {
      const label = `${state}: "${name}"`;
      expect(Number.isFinite(lat), label).toBe(true);
      expect(Number.isFinite(lon), label).toBe(true);
      expect(Number.isFinite(alandSqMi), label).toBe(true);
      // The 50 states + DC span roughly 17N (southern tip of the Big
      // Island, HI) to 72N (Point Barrow, AK), and 180W to 65W (the
      // Aleutians to the western edge of Maine) -- generous bounds, not a
      // tight bounding box, since the point is catching a wrong-hemisphere
      // or swapped-lat/lon bug, not validating precise geography.
      expect(lat, label).toBeGreaterThan(17);
      expect(lat, label).toBeLessThan(72);
      expect(lon, label).toBeGreaterThan(-180);
      expect(lon, label).toBeLessThan(-65);
      expect(alandSqMi, label).toBeGreaterThanOrEqual(0);
    }
  });

  it("MUTATION CHECK: the name-shape assertion actually catches the Juneau-class bug", () => {
    // Confirms the dangling-function-word check above is not vacuous: the
    // EXACT residue a broken multi-word stripper left behind for Juneau
    // ("Juneau city and borough" with only "borough" removed) is a string
    // that passes the plain charset check (it's all lowercase letters and
    // spaces) but must be caught by the trailing-function-word check, which
    // is the one that's actually load-bearing here.
    const brokenJuneau = "juneau city and";
    expect(brokenJuneau).toMatch(/^[a-z][a-z' -]*$/);
    expect(brokenJuneau).toMatch(/ (and|of|the|a|in|to|on)$/);
    expect(CITY_COORDINATES.some((r) => r.name === brokenJuneau)).toBe(false);
  });
});

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

  it("the 60-mile boundary is a knife-edge, not a wide margin -- pins it tightly, not just directionally", () => {
    // Bellevue (51.8mi) and Everett (71.9mi) above survive almost ANY
    // threshold from 52 to 71 -- they don't exercise the actual boundary at
    // 60, they only prove the radius is "roughly 60-ish". Sixteen real WA
    // places sit within [57, 63] miles of Olympia (measured 2026-10-10
    // against this bundled dataset); the closest EXCLUDED one is Bothell at
    // 60.061 miles -- excluded by 1/16th of a mile -- and the closest
    // INCLUDED one near that edge is Brier at 59.519. This is the tightest
    // real pair available, and it's still not a coincidence to rely on for
    // an EXACT `<=` vs `<` mutation (no real place in this dataset sits at
    // precisely 60.000000 miles -- see this file's header for why a
    // different reference point moves a distance "by a few miles", which
    // means Bothell's specific 60.061 is itself an artifact of using the
    // Census internal point rather than, say, downtown Bothell; a few
    // dozen feet of difference in START point could flip which side of 60
    // it lands on). What this test DOES pin tightly: the acceptable
    // threshold window for a passing mutant shrinks from the ~19-mile gap
    // above to well under one mile.
    const olympia = coordinateFor("olympia", "WA");
    const brier = coordinateFor("brier", "WA");
    const bothell = coordinateFor("bothell", "WA");
    const toBrier = haversineMiles(olympia.lat, olympia.lon, brier.lat, brier.lon);
    const toBothell = haversineMiles(olympia.lat, olympia.lon, bothell.lat, bothell.lon);
    expect(toBrier).toBeLessThan(60);
    expect(toBothell).toBeGreaterThan(60);
    const siblings = nearbySiblingCitiesFor("Olympia");
    expect(siblings, "brier (59.5mi) must be IN").toContain("brier");
    expect(siblings, "bothell (60.06mi) must be OUT").not.toContain("bothell");
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

  it("rejects a same-named city whose trailing text hides the region (review finding F1, ticket 410e1a2)", () => {
    // The whole point of F1: whole-field equality required the field to BE
    // the region, so anything trailing it in the same field defeated the
    // guard entirely. Every one of these matched a Seattle/LA search before
    // the fix. "City, ST (suffix)" is not hypothetical -- the owner's real
    // corpus (prep/match-results.json) contains "New York, NY (HQ); San
    // Francisco, CA; Remote (US)".
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

  it("accepts the symmetric cost: a non-ambiguous code shouted in caps as prose (fable review round 5, ticket 410e1a2)", () => {
    // Restored (ticket e5e1aa1 review round 2, Required 7): dropped when
    // this file was rewritten for the distance-based redesign even though
    // `cityIsInRegions`/`regionOfField` -- the region guard itself -- were
    // not touched by that rewrite, so the behavior this test pins is
    // unchanged and it passes as-is. The all-caps discriminator can't tell
    // "real code written in caps" from "ordinary word shouted in caps for
    // emphasis" for a code that ISN'T on the ambiguous list -- there is no
    // version of this rule that closes both directions for the same token.
    // Pinned here (its own original comment's words) "so a future change
    // that flips it is a visible, deliberate decision."
    expect(matchesAny("Seattle", "Tacoma, CO-OP")).toBe(false);
    expect(matchesAny("Seattle", "Tacoma, WI-FI")).toBe(false);
    expect(matchesAny("Seattle", "Tacoma, HI-TECH")).toBe(false);
  });

  it("requires a nationally-ambiguous city to name its region positively (review finding F4, ticket 410e1a2)", () => {
    // "bellevue"/"everett"/"irvine" etc. are ambiguous across states in the
    // bundled dataset (AMBIGUOUS_CITY_NAMES -- ticket e5e1aa1's
    // generalization of the old table's hand-picked REGION_REQUIRED_CITIES,
    // which these same nine names came from), so a bare mention on the
    // POSTING side is not enough. Each of these matched before F4's fix.
    // Measured cost on the owner's real corpus: zero -- all 29 real
    // Bellevue postings spell WA/Washington out.
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

  it("gives the caller's OWN city the same lenient matching as its siblings (review finding F2, ticket 410e1a2)", () => {
    // The bug: the named city was skipped, so it got only criteria.ts's
    // literal matcher while every sibling got the region-guarded one. A
    // "Seattle, WA" search therefore matched "Bellevue, Washington" but not
    // "Seattle, Washington" -- its own city, differently punctuated. On the
    // owner's real corpus that cost 25 real Seattle-named postings. Ticket
    // e5e1aa1 preserves this by construction (see
    // `compileMetroAreaMatchers`'s own doc comment): the named city is
    // always within its own 60-mile radius, so it always gets the same
    // matcher its siblings do.
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

  it("Hawaii is reachable at all (review round 2, D1) -- Honolulu resolves and expands", () => {
    // Before the fix, Hawaii's CDP-only data meant EVERY Hawaiian city,
    // Honolulu included, was absent from the dataset outright -- no state
    // suffix could rescue it, which is a worse version of this ticket's own
    // bug (a checkbox that LOOKS like a real option but silently does
    // nothing for a top-50-by-population US city).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matchers = compileMetroAreaMatchers("Honolulu");
    expect(matchers.length).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    // Nearby Oahu cities should be pulled in; Hilo (on a different island,
    // the Big Island) should not be -- Oahu's longest axis is well under 60
    // miles, Hilo is roughly 200 miles away across open ocean.
    const siblings = nearbySiblingCitiesFor("Honolulu");
    expect(siblings).toContain("aiea");
    expect(siblings).not.toContain("hilo");
  });

  it("Juneau is correctly ambiguous (review round 2, D2) -- a bare mention does not silently pick Wisconsin", () => {
    // The actual bug this test guards: a broken LSAD-suffix stripper that
    // only removed the trailing word turned "Juneau city and borough" (AK)
    // into "juneau city and" -- not a key in the dataset at all -- which
    // left "juneau" looking like it had exactly one state (WI) when it
    // really has two (AK, WI). That false unambiguity meant a Juneau,
    // Alaska searcher who ticked the box would have silently gotten 200+
    // Wisconsin cities pulled in instead of an honest "add a state" report.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(compileMetroAreaMatchers("Juneau")).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain("juneau");
    expect(message).toContain("AK");
    expect(message).toContain("WI");
    warn.mockRestore();
    // Qualified with its real state, it resolves to the real Alaska capital
    // -- never to Wisconsin.
    expect(compileMetroAreaMatchers("Juneau, AK").length).toBeGreaterThan(0);
    const alaskaSiblings = nearbySiblingCitiesFor("Juneau, AK");
    expect(alaskaSiblings).not.toContain("madison");
    expect(alaskaSiblings).not.toContain("watertown");
  });
});
