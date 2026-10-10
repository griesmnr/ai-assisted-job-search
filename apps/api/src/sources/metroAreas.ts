/**
 * Local, zero-cost NEARBY-CITY EXPANSION for caller-supplied location
 * phrases (ticket 410e1a2, replaced by ticket e5e1aa1's distance-based
 * redesign).
 *
 * Consumed by `criteria.ts`'s `compileFilter`, ONLY on the explicit-criteria
 * path, and ONLY when the caller sets `SearchCriteria.expandMetroAreas` to
 * `true`. Everything else -- the no-criteria default
 * (`criteria === undefined` -> `filterSoftwareEngineeringJobs`), the
 * unchecked/omitted flag, `remoteOk`, `commitmentIn`, and every title axis --
 * is untouched by this module. With the flag off, `nearLocations` compiles to
 * precisely the matchers it compiled before this ticket existed.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS EXISTS TO SOLVE
 * ---------------------------------------------------------------------------
 *
 * `makePhraseMatcher` (criteria.ts) is literal, word-boundary-anchored
 * substring matching. It has no idea that a job in Bellevue is, to most
 * Seattle-area job seekers, a Seattle-area job.
 *
 * Measured, not assumed. Against the owner's own real scored corpus
 * (`prep/match-results.json`, written 2026-08-31 21:34 -- 200 postings that
 * had already passed the CLI default filter and been scored by Claude; the
 * same run swe-filter.ts's "200 jobs scored 2026-08-31" note cites), a
 * strict `nearLocations: ["Seattle"]` search drops **29 of 200** postings
 * that are physically in the Seattle metro area but never say "Seattle".
 * Recounted from the file itself (ticket 410e1a2 review finding F3 -- an
 * earlier version of this comment said "24 single-city / 5 multi-city",
 * which double-counted two multi-city strings as Bellevue-only; the total of
 * 29 was right):
 *
 *   - 22 single-city Bellevue postings (Databricks "Senior Software Engineer
 *     - Backend", Robinhood "Senior Software Engineer, Kubernetes Compute",
 *     Smartsheet "Senior Software Engineer I (Automation)", ...), written as
 *     "Bellevue, Washington" (12), "Bellevue, WA" (9) and "Bellevue, WA,
 *     USA" (1).
 *   - 7 multi-city postings pairing Bellevue with an out-of-state office:
 *     "Bellevue, WA; Menlo Park, CA" (3), "Bellevue, WA; Menlo Park, CA; New
 *     York, NY" (1), two Okta variants of "Bellevue, Washington; Chicago,
 *     Illinois; New York, New York" (the second adding "; Washington, DC"),
 *     and "Bellevue, Washington; San Francisco, California" (1).
 *
 * THIS EVIDENCE IS STILL VALID AND STILL THE REASON THE FEATURE EXISTS AT
 * ALL -- carried forward unchanged from the table ticket e5e1aa1 deletes.
 * What e5e1aa1 found wrong was the DELIVERY: `METRO_AREA_GROUPS` only ever
 * covered two hand-built metros (Seattle-Tacoma-Bellevue, Los Angeles-Long
 * Beach-Anaheim), so the checkbox silently did nothing for every other city
 * a user typed -- Olympia, Portland, New York, Chicago, Austin, Denver,
 * Boston, San Francisco. A real user (relayed by Nicole, 2026-10-10) typed
 * "Olympia" with the box checked and got no effect, with no indication why.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS OPT-IN, AND STAYS OPT-IN
 * ---------------------------------------------------------------------------
 *
 * Nicole raised this herself while dogfooding, and raised both sides of it
 * (ticket 410e1a2): some searchers want "Seattle" to mean the metro area;
 * others would be actively annoyed to be shown a Kirkland commute they
 * specifically did not want. There is no correct default here, only a correct
 * DEFAULT-PLUS-CHOICE: strict stays the default, and this is a checkbox --
 * her words, "I think it'll just be a check, a checkbox or something like
 * that... I want it given that it meets both users' needs as long as it can
 * be seen."
 *
 * ---------------------------------------------------------------------------
 * WHY DISTANCE, NOT A CURATED METRO TABLE (ticket e5e1aa1)
 * ---------------------------------------------------------------------------
 *
 * The original design (ticket 410e1a2) used hand-curated OMB/Census MSA
 * groupings instead of a radius specifically BECAUSE "an MSA is a published,
 * checkable, stable definition; '45 minutes by car' is neither." That
 * reasoning was sound for the two metros it covered, but it does not scale:
 * building a verified MSA entry for every US metro a searcher might type is
 * unbounded hand-curation work, and until it's done for a given city the
 * checkbox for that city is a silent no-op -- exactly the bug Olympia hit.
 *
 * Nicole's ruling (git-bug e5e1aa1, 2026-10-10): distance-based, 60 miles,
 * computed from a bundled city-coordinate dataset (`cityCoordinates.ts` --
 * see that file for provenance: the US Census Bureau's own Gazetteer place
 * file, the same public, checkable authority class the old table held
 * itself to). This covers every city in the dataset uniformly, rather than
 * only the handful someone has separately verified. The tradeoff it accepts
 * explicitly: straight-line distance is not commute distance, which is the
 * SAME caveat the old table already carried ("Tacoma to Everett is ~60
 * miles end to end, which is why the whole feature is a checkbox") -- a
 * radius just makes that caveat more visible, by computing a number instead
 * of curating a list, so this file says so again below rather than letting
 * the number imply a precision it does not have.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 *
 * `compileMetroAreaMatchers(phrase)`:
 *
 *  1. Finds every city name `phrase` mentions (`resolveCallerCities`),
 *     disambiguating by a following region ("Everett, MA") where one is
 *     given, and resolving a bare ambiguous name ("Boston") only when the
 *     dataset has exactly one state for it -- see that function's doc
 *     comment for why an ambiguous bare name is left UNRESOLVED rather than
 *     guessed.
 *  2. For each resolved coordinate, scans the full bundled dataset
 *     (`cityCoordinates.ts`) once and collects every place within
 *     `NEARBY_CITY_RADIUS_MILES` miles (`haversineMiles`), grouped by name ->
 *     the set of states a within-radius instance was actually found in.
 *     This always includes the named city itself (distance 0), which is why
 *     a resolved phrase never produces zero matchers -- see
 *     `compileMetroAreaMatchers`'s own comment for what "zero matchers"
 *     therefore means.
 *  3. Builds one matcher per nearby name, reusing `cityIsInRegions` (the
 *     SAME region guard the old table used, unchanged) to reject a posting
 *     that places that name in a region outside the set just computed --
 *     e.g. a Bellevue found only in WA within Olympia's radius still
 *     rejects a real "Bellevue, NE" posting, exactly as the old table's
 *     `REGION_REQUIRED_CITIES` did for the same reason.
 *
 * A phrase that resolves to NOTHING (no recognizable city, an ambiguous bare
 * name, or a named region the city doesn't actually have) produces zero
 * matchers -- the checkbox then does nothing for it, same as today's strict
 * matching alone -- but NEVER silently: see `compileMetroAreaMatchers`'s own
 * comment for the `console.warn` this emits instead, which is the fix for
 * the actual bug (a no-op nobody could see) rather than a repeat of it.
 *
 * ---------------------------------------------------------------------------
 * THE SAFETY MODEL: A REGION GUARD, WHOSE ONLY FAILURE IS NOT EXPANDING
 * ---------------------------------------------------------------------------
 *
 * City names are not unique. Everett is in Snohomish County, WA and also in
 * Massachusetts (pop. 49,075, Boston metro). Pasadena is in Los Angeles
 * County and also in Texas -- where it is prominent enough to be a namesake
 * of the Houston-Pasadena-The Woodlands, TX MSA (pop. 149,615). Glendale is
 * in LA County and also in Arizona (pop. 248,325, Phoenix metro). Kirkland
 * is in King County, WA and also in Quebec. A table of bare city names,
 * matched literally, would happily map a Boston-area job into a Seattle
 * search.
 *
 * So every nearby name carries the SPECIFIC region(s) it was found in within
 * radius, and a posting match is rejected when the text names a region
 * OUTSIDE that set immediately after the city. "Everett, MA" does not
 * satisfy a Seattle expansion; "Everett, WA" and "Everett, Washington" do.
 * The same guard runs on the CALLER's phrase (via `regionAfter`), so typing
 * "Pasadena, TX" resolves to Pasadena, TX's OWN nearby cities (a different,
 * real place with its own coordinates in the dataset) rather than quietly
 * selecting Los Angeles -- see `resolveCallerCities`'s doc comment.
 *
 * **Immediately after** is doing real work and is not a simplification of
 * "anywhere in the string". Seven of the 29 real postings above are
 * multi-city ("Bellevue, WA; Menlo Park, CA"), and a whole-string test would
 * see "CA", call the posting foreign, and drop a job that genuinely is in
 * Bellevue. So the guard reads only the comma-delimited field that follows
 * the matched city, cut at the first `;`/`|`/`/` -- i.e. the "WA" in
 * "Bellevue, WA; Menlo Park, CA".
 *
 * That field is a region mention when it IS a region name/code ("WA",
 * "Washington") or BEGINS with one at a word boundary with a non-word after
 * it ("MA 02149", "MA (HQ)", "NY - Hybrid", "WA-Remote"). The leading-prefix
 * half is ticket 410e1a2 review finding F1: whole-field equality alone let
 * "Everett, MA 02149" and "Everett, MA (HQ)" through a Seattle search, and
 * "City, ST (suffix)" is a shape this app's own corpus contains ("New York,
 * NY (HQ); San Francisco, CA; Remote (US)"). The non-word requirement is
 * what keeps the two-letter codes that are also English words from firing on
 * prose -- "Bellevue, in office 3 days" is not Indiana. A field that is
 * anything else ("USA", "98004", "Hybrid", nothing at all) is not a region
 * mention.
 *
 * A region mention that is absent is not the same as one that agrees. For
 * most names absence passes ("Seattle" alone is Seattle), but for a name
 * that is genuinely ambiguous NATIONWIDE -- found in more than one state
 * anywhere in the bundled dataset, not just within this search's radius -- a
 * POSTING must name an in-set region positively (`AMBIGUOUS_CITY_NAMES`,
 * this ticket's generalization of ticket 410e1a2's hand-picked
 * `REGION_REQUIRED_CITIES`; see that constant's doc comment for the measured
 * scale of the generalization). That is what rejects "Irvine, Scotland",
 * "Kirkland, Canada" and "Everett, United States" -- all of which the
 * absence rule accepted, and the last of which is a real shape in this
 * repo's data (the Airbnb fixture's "Los Angeles, United States").
 *
 * Known residual weaknesses, recorded rather than papered over:
 *  - A bare, region-less ambiguous city name in the CALLER's phrase is left
 *    UNRESOLVED rather than guessed (see `resolveCallerCities`) -- a
 *    deliberate change from ticket 410e1a2's table, which let a caller's
 *    bare ambiguous name through unconditionally because the group it
 *    picked was small and hand-vetted. With 2,732 of 12,827 names in the
 *    bundled dataset ambiguous across states (measured 2026-10-10 -- see
 *    `cityCoordinates.ts`), guessing a coordinate for one would risk
 *    computing "nearby" from the wrong place entirely (a bare "Boston"
 *    could mean Boston, MA, GA or IN). The honest fix given no population
 *    data to break the tie is to ask for a state, not to guess -- see the
 *    `console.warn` this produces instead.
 *  - The region vocabulary is US + Canada, so a POSTING field naming a
 *    region elsewhere ("Kirkland, Île-de-France") is not recognized as
 *    foreign. `AMBIGUOUS_CITY_NAMES` closes this for every name the dataset
 *    knows is ambiguous; for an unambiguous name paired with an unrecognized
 *    foreign region field, this rule still accepts, exactly as the old
 *    table's residual weakness for "Tacoma, Bogotá" did. Canada is included
 *    because it is the adjacency that shows up in this app's real data (the
 *    corpus contains "Vancouver, British Columbia", "Toronto, Ontario",
 *    "Ottawa, Ontario" and "Remote, Canada") -- the bundled coordinate
 *    dataset itself is US-only (see `cityCoordinates.ts`), so a Canadian
 *    CALLER phrase ("Vancouver, BC") cannot resolve a coordinate even though
 *    the region guard recognizes the region name; it is reported as
 *    unresolved, same as any other city absent from the dataset.
 *  - Free-text between the city and its region ("Bellevue (Hybrid), WA") puts
 *    a non-region field in the guard's window, so no region is found.
 *    Unobserved in real data; for an ambiguous name that now means no
 *    expansion, and for the rest it is still a possible false positive.
 *  - A city list whose fields are cities, not regions -- "Seattle, New York,
 *    San Francisco" -- reads "New York" as a state and suppresses the
 *    expansion. One real posting in the corpus has this shape. It costs
 *    coverage, never a false positive (the caller's literal matcher still
 *    matches it), which is the direction below.
 *  - A caller-typed phrase cannot resolve a dataset name that itself
 *    contains an internal hyphen or apostrophe ("Winston-Salem",
 *    "Coeur d'Alene") -- `resolveCallerCities`'s word-tokenizer splits on
 *    both, same as the old table's `\b` treated a hyphen as a boundary
 *    ("Renton-upon-Thames" still finds "renton"). 84 of the dataset's
 *    12,827 names (0.7%, measured 2026-10-10) contain one; posting-side
 *    matching is unaffected (it tests the literal city pattern against raw
 *    posting text, which handles a hyphen or apostrophe directly).
 * **The guard can only ever suppress an expansion, never create one**, and
 * that holds for every change above: expansion only ADDS matchers, and the
 * caller's own literal phrase is always compiled and tested first,
 * unmodified. So a posting that matched with the flag off still matches with
 * it on, and every way the guard can be wrong costs coverage this feature
 * would otherwise have added. A user who hits one sees exactly today's
 * strict behavior.
 */
import { CITY_COORDINATES } from "./cityCoordinates.js";

/**
 * How far "nearby" reaches, in miles, as the great-circle (straight-line)
 * distance between two places' Census-published internal points -- NOT a
 * commute or driving distance. See this file's header for why straight-line
 * is the deliberate choice (no routing-data dependency) and why that is a
 * real cost, not a rounding error, stated again right here rather than left
 * to be discovered:
 *
 * STRAIGHT-LINE IS NOT DRIVING. Bremerton is computed at ~35-39 miles from
 * Olympia (depending on which two points are measured -- see below), but the
 * real trip goes around Puget Sound or by ferry. A curated metro table could
 * at least claim "these are the cities this MSA's own definition names";
 * a radius computes a precise-LOOKING number from two points on a map, which
 * makes the straight-line-vs-driving gap MORE likely to be mistaken for
 * precision, not less -- so it is written down here, not left to be
 * discovered.
 *
 * WHY 60, NOT 50 (Nicole's first instinct) -- measured 2026-10-10, real
 * great-circle distances between Census internal points, requested by
 * Nicole while reviewing this ticket:
 *
 *   from Olympia:  Seattle 47.4   Tacoma 26.1   Lacey 3.7   Bremerton 38.7
 *                  Bellevue 51.3  Everett 72.7
 *   from Seattle:  Bellevue 6.1   Bremerton 14.3  Tacoma 25.0  Everett 26.5
 *                  Lacey 45.7     Olympia 47.4
 *
 * A 50-mile radius already covers everything ticket 410e1a2's hand-built
 * Seattle-Tacoma-Bellevue group contained, PLUS Olympia and Bremerton -- a
 * radius is strictly more generous than that curated table, for every city
 * rather than two. But at 50, Olympia's own numbers produce a visibly
 * absurd result: Seattle is IN (47.4) and Bellevue -- six miles further out
 * than Seattle, and a city nobody would call farther from Olympia than
 * Seattle is -- is OUT (51.3). A user who knows the area would read that as
 * a bug, correctly. 60 admits Bellevue and still excludes Everett (72.7),
 * which is the actual Tacoma-to-Everett-scale distance the old table's own
 * doc comment already called a stretch ("~60 miles end to end, which is why
 * the whole feature is a checkbox"). Nicole chose 60 when shown the 50-mile
 * Bellevue gap.
 *
 * Re-measured against the bundled dataset's own points (`cityCoordinates.ts`,
 * `haversineMiles`) rather than assumed identical to the numbers above:
 * Olympia -> Seattle 47.4, Tacoma 25.1, Lacey 4.6, Bremerton 35.5, Bellevue
 * 51.8, Everett 71.9; Seattle -> Bellevue 9.2, Bremerton 17.9, Tacoma 25.9,
 * Everett 25.1, Lacey 45.0. Every accept/reject decision above still holds
 * (Bellevue still just past 50 and comfortably under 60; Everett still well
 * past 60) even though the individual numbers differ by a few miles from
 * Nicole's own measurement -- expected, not a bug: her numbers and this
 * file's come from different reference points within each city (e.g.
 * downtown vs. the Census internal point used here), which is exactly the
 * straight-line-is-not-one-true-number caveat above restated as data rather
 * than prose.
 */
export const NEARBY_CITY_RADIUS_MILES = 60;

/**
 * Great-circle distance between two lat/lon points, in miles (the haversine
 * formula). Exported for tests and for `compileMetroAreaMatchers`'s own
 * radius scan.
 *
 * Earth radius 3,958.7613 mi (the WGS-84 mean radius used by NOAA/NASA
 * references) -- a sphere, not the actual oblate ellipsoid, which is correct
 * for this use: the two never differ enough at these distances (tens of
 * miles) to move a 60-mile-radius accept/reject decision, and a sphere is
 * what every other number quoted in this file (Nicole's own measurements,
 * the Census internal points) is implicitly assuming too.
 */
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const EARTH_RADIUS_MILES = 3958.7613;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

/**
 * Every bundled coordinate, grouped by lowercase name -- built once at
 * module load from `CITY_COORDINATES` (19,670 rows; see `cityCoordinates.ts`
 * for provenance). A name maps to MORE than one entry either because it is
 * genuinely ambiguous across states (11 different "bellevue"s) or because
 * normalization produced the same (state, name) pair twice for two distinct
 * real places (21 such pairs, e.g. two "Oakwood"s in OH, or Hawaii's own
 * "Kailua" and "Waimea" CDPs, each real on different islands -- see
 * `cityCoordinates.ts`'s own doc comment); either way, every entry is kept
 * and `resolveCallerCities`/the radius scan consider all of them.
 */
const CITY_COORDINATES_BY_NAME: ReadonlyMap<
  string,
  readonly {
    readonly state: string;
    readonly lat: number;
    readonly lon: number;
    readonly alandSqMi: number;
  }[]
> = (() => {
  const map = new Map<string, { state: string; lat: number; lon: number; alandSqMi: number }[]>();
  for (const { state, name, lat, lon, alandSqMi } of CITY_COORDINATES) {
    const existing = map.get(name);
    if (existing) existing.push({ state, lat, lon, alandSqMi });
    else map.set(name, [{ state, lat, lon, alandSqMi }]);
  }
  return map;
})();

/**
 * Names that ARE unambiguous within the bundled (US-only) dataset but
 * collide with a real place OUTSIDE it, carried forward from ticket
 * 410e1a2's hand-picked `REGION_REQUIRED_CITIES` rather than silently
 * dropped when that set was replaced by the computed one below. The
 * dataset-driven set below can only ever see a collision between two US
 * states -- it has no way to know "Santa Ana" is also a real city in Costa
 * Rica and El Salvador, because neither is in a US Census file. Checked
 * 2026-10-10 against the full old hand-picked list: of its nine names,
 * `irvine` (CA, KY) and `kirkland` (IL, WA) turn out to ALSO be ambiguous
 * within the 50 states for an unrelated domestic reason and need no special
 * case; `santa ana` (CA only, domestically) does not, and is the one name
 * in this list. Not an attempt to enumerate every US/non-US name collision
 * nationwide -- that would need a non-US gazetteer this file doesn't have --
 * just the one this project already verified matters, so that verification
 * isn't silently lost.
 */
const FOREIGN_NAMESAKE_COLLISIONS: readonly string[] = ["santa ana"];

/**
 * Names found in MORE than one state anywhere in the bundled dataset --
 * ticket e5e1aa1's generalization of ticket 410e1a2's hand-picked
 * `REGION_REQUIRED_CITIES` (nine names, chosen by inspection: "everett",
 * "glendale", "pasadena", "long beach", "kirkland", "redmond", "bellevue",
 * "santa ana", "irvine"). That hand-picked set could never scale past the
 * two curated metros it protected; this computes the SAME property --
 * "is a bare mention of this name trustworthy on its own, or does it need a
 * region to mean anything" -- from the full nationwide dataset instead.
 *
 * Measured 2026-10-10 (recomputed after review round 2's Hawaii/Juneau
 * fixes to `cityCoordinates.ts`): 2,732 of 12,827 unique names (21.3%) are
 * ambiguous by this definition, including some a human would not expect --
 * "Boston" (GA, IN, MA), "Austin" (AR, IN, MN, PA, TX), "Denver" (CO, IA,
 * IN, MO, PA) and "Portland" (AR, IN, ME, MI, ND, OR, PA, TN, TX) are all,
 * technically, multi-state names, even though common usage treats each as
 * having one obvious referent. This file has no population data to break
 * that kind of tie (the Gazetteer place file carries land AREA, not
 * population) -- and land area was tried and rejected as a substitute,
 * measured, not assumed: picking the largest-land-area candidate resolves
 * the colloquial referent correctly for Boston/Austin/Denver/Portland and
 * Bellevue, but gets it WRONG for "pasadena" (picks TX over the far more
 * famous Pasadena, CA), "nashville" (AR over TN), "lexington" (NC over KY),
 * "rochester" (MN over NY) and "albany" (GA over NY) -- 5 of 23 probed
 * names (2026-10-10), including the exact Pasadena/CA-vs-TX collision this
 * file's own `FOREIGN_NAMESAKE_COLLISIONS`-adjacent reasoning already uses
 * as its worked example of why a human-obvious answer isn't always the
 * measurable one. So resolution does not try ANY tie-break: a POSTING
 * naming one of these bare, with no state, is treated exactly like a
 * posting naming "Bellevue" bare -- not expanded into, on the theory that
 * an unresolved-but-honest miss is better than a resolved-but-wrong guess.
 * (Land area IS used elsewhere, but only to word a WARNING's example text,
 * where a wrong guess costs nothing worse than a slightly-off hint -- see
 * `resolveCallerCities`.) The real motivating names for this ticket --
 * Seattle, Olympia, Tacoma, Lacey, Los Angeles -- are each in exactly ONE
 * state and are unaffected.
 *
 * Same asymmetry as the old `REGION_REQUIRED_CITIES`: this set is consulted
 * for POSTINGS only (`cityIsInRegions`'s `side` parameter). A CALLER typing
 * one of these names bare is handled by `resolveCallerCities`, which has its
 * own (stricter, by necessity -- a coordinate, not just a region check, is
 * needed) decision about when a bare ambiguous name can resolve at all.
 */
const AMBIGUOUS_CITY_NAMES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const [name, candidates] of CITY_COORDINATES_BY_NAME) {
    const states = new Set(candidates.map((c) => c.state));
    if (states.size > 1) set.add(name);
  }
  for (const name of FOREIGN_NAMESAKE_COLLISIONS) set.add(name);
  return set;
})();

/**
 * US states + DC + Canadian provinces, by the forms that actually appear in
 * a location field: full name and postal code. Lowercase keys.
 *
 * The lookup is EXACT against one comma-delimited field, not a substring
 * scan, which is what keeps two-letter codes that are also English words
 * ("IN", "OR", "OK", "ON", "ME") from firing on ordinary text: "Bellevue
 * (remote ok)" yields the field "(remote ok)", which is not a key here.
 */
const REGION_CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries({
    alabama: "AL",
    alaska: "AK",
    arizona: "AZ",
    arkansas: "AR",
    california: "CA",
    colorado: "CO",
    connecticut: "CT",
    delaware: "DE",
    "district of columbia": "DC",
    "d.c.": "DC",
    florida: "FL",
    georgia: "GA",
    hawaii: "HI",
    idaho: "ID",
    illinois: "IL",
    indiana: "IN",
    iowa: "IA",
    kansas: "KS",
    kentucky: "KY",
    louisiana: "LA",
    maine: "ME",
    maryland: "MD",
    massachusetts: "MA",
    michigan: "MI",
    minnesota: "MN",
    mississippi: "MS",
    missouri: "MO",
    montana: "MT",
    nebraska: "NE",
    nevada: "NV",
    "new hampshire": "NH",
    "new jersey": "NJ",
    "new mexico": "NM",
    "new york": "NY",
    "north carolina": "NC",
    "north dakota": "ND",
    ohio: "OH",
    oklahoma: "OK",
    oregon: "OR",
    pennsylvania: "PA",
    "rhode island": "RI",
    "south carolina": "SC",
    "south dakota": "SD",
    tennessee: "TN",
    texas: "TX",
    utah: "UT",
    vermont: "VT",
    virginia: "VA",
    washington: "WA",
    "west virginia": "WV",
    wisconsin: "WI",
    wyoming: "WY",
    alberta: "AB",
    "british columbia": "BC",
    manitoba: "MB",
    "new brunswick": "NB",
    "newfoundland and labrador": "NL",
    "nova scotia": "NS",
    ontario: "ON",
    "prince edward island": "PE",
    quebec: "QC",
    saskatchewan: "SK",
    // Postal codes. Listed explicitly rather than derived from the values
    // above so the map stays a plain, greppable data table, and so a code
    // with no matching full-name spelling can be added if one ever needs to
    // be.
    al: "AL",
    ak: "AK",
    az: "AZ",
    ar: "AR",
    ca: "CA",
    co: "CO",
    ct: "CT",
    de: "DE",
    dc: "DC",
    fl: "FL",
    ga: "GA",
    hi: "HI",
    id: "ID",
    il: "IL",
    in: "IN",
    ia: "IA",
    ks: "KS",
    ky: "KY",
    la: "LA",
    me: "ME",
    md: "MD",
    ma: "MA",
    mi: "MI",
    mn: "MN",
    ms: "MS",
    mo: "MO",
    mt: "MT",
    ne: "NE",
    nv: "NV",
    nh: "NH",
    nj: "NJ",
    nm: "NM",
    ny: "NY",
    nc: "NC",
    nd: "ND",
    oh: "OH",
    ok: "OK",
    or: "OR",
    pa: "PA",
    ri: "RI",
    sc: "SC",
    sd: "SD",
    tn: "TN",
    tx: "TX",
    ut: "UT",
    vt: "VT",
    va: "VA",
    wa: "WA",
    wv: "WV",
    wi: "WI",
    wy: "WY",
    ab: "AB",
    bc: "BC",
    mb: "MB",
    nb: "NB",
    nl: "NL",
    ns: "NS",
    on: "ON",
    pe: "PE",
    qc: "QC",
    sk: "SK",
  }),
);

/**
 * The two-letter region codes worth protecting from a hyphen-joined suffix
 * reading as a word boundary EVEN WHEN WRITTEN IN ALL CAPS -- "ON-SITE",
 * "IN-OFFICE" are common shouted-emphasis styling in real postings, and
 * `regionOfField`'s all-caps discriminator (below) would otherwise read
 * "ON"/"IN" as real region codes there. This list does not need to be
 * exhaustive against ordinary English words the way an earlier version of
 * it tried to be -- see `regionOfField`'s doc comment for why a hand-curated
 * word list was the wrong tool for the lowercase case (ticket 410e1a2 review
 * round 4 found "co-located" misread as Colorado, the same bug this list
 * was meant to close, because the list simply didn't have "co" on it).
 */
const AMBIGUOUS_WORD_CODES: ReadonlySet<string> = new Set([
  "in",
  "or",
  "on",
  "ok",
  "me",
  "de",
  "la",
]);

/**
 * One region token -> its code, or `undefined`. A trailing period is common
 * on abbreviations ("Pasadena, Tx.") and is never part of a region name here
 * except in "d.c.", which the first lookup catches before the strip.
 */
function lookupRegion(token: string): string | undefined {
  const key = token.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return REGION_CODE_BY_NAME.get(key) ?? REGION_CODE_BY_NAME.get(key.replace(/\.$/, ""));
}

/** Longest region name in words: "district of columbia", "newfoundland and
 * labrador", "prince edward island". Nothing in the table is longer, so a
 * fourth word can never be part of a region name. */
const MAX_REGION_WORDS = 3;

/**
 * The region a single comma-delimited field names, or `undefined`.
 *
 * The whole field is tried first -- "WA", "Washington", "New York" -- and
 * that is the shape the overwhelming majority of real location strings use.
 * Failing that, the field's LEADING words are tried, longest prefix first, so
 * that a region with something trailing it in the same field is still seen:
 * "MA 02149", "MA (HQ)", "NY - Hybrid", "WA-Remote". Whole-field equality
 * alone (this function's original shape, ticket 410e1a2 review finding F1)
 * missed every one of those and let "Everett, MA 02149" pass a Seattle
 * expansion.
 *
 * Two constraints keep the prefix scan from firing on ordinary text:
 *
 *  - A prefix is only considered at a word boundary, and only for the first
 *    three words, because no region name is longer.
 *  - A prefix only counts as a region mention when what FOLLOWS it is not
 *    another word -- a digit, a bracket, a dash-then-space, or nothing at
 *    all. For a token longer than two letters (a full name like
 *    "Washington", or a multi-word name like "New York") that boundary is
 *    always any non-letter, so "MA 02149", "MA (HQ)", "NY - Hybrid",
 *    "Oregon-based", and "New York-Hybrid" all resolve their region
 *    regardless of what trails it -- a full name is never at risk of being
 *    misread as ordinary hyphenated prose, so it never needs a stricter rule.
 *
 *    A two-letter token is different, because that length is shared by
 *    postal codes AND short English words/prefixes ("on", "in", "co", "hi").
 *    For these, a real "City, ST-suffix" code is written in caps
 *    ("WA-Remote", "IL-Hybrid"); a hyphenated English word essentially never
 *    is ("co-located", "on-site", "Co-op"). This is an ASSUMPTION about the
 *    shape of real data, not a measurement -- checked once (2026-09-24)
 *    against every posting this repo's own fixtures/corpus carry: the only
 *    hyphen-joined two-letter token in any real `location` field is
 *    "US-Remote" (2 of the 200 postings in `prep/match-results.json`), and
 *    "us" is not a key in `REGION_CODE_BY_NAME` -- so no region-code-shaped
 *    token of this kind appears at all. The caps-vs-prose rule and every
 *    example below (including "ON-SITE"/"IN-OFFICE" as caps styling real
 *    postings are ASSUMED to also shout as emphasis) are informed guesses
 *    about postings this app hasn't seen yet, not confirmed patterns.
 *    Revisit if a real posting ever contradicts one.
 *
 *    So: an exact two-letter ALL-CAPS token is read as a code even across a
 *    bare hyphen, UNLESS it's one of `AMBIGUOUS_WORD_CODES` -- "in", "or",
 *    "on", "ok", "me", "de", "la" -- which are assumed capable of being
 *    shouted in caps as prose too ("ON-SITE", "IN-OFFICE") and therefore
 *    still need the hyphen read as a continuation regardless of case.
 *    Because `lookupRegion` itself is case-insensitive, this makes the
 *    function case-SENSITIVE in exactly one place it wasn't before: a
 *    two-letter code joined by a bare hyphen only resolves when written in
 *    consistent caps. "Bellevue, WA-Remote" resolves; "Bellevue,
 *    wa-remote" and "Bellevue, Wa-Remote" do not (a coverage loss on a
 *    region-required city), and "Burbank, il-hybrid" no longer rejects
 *    either (a false positive on a non-region-required one) -- both
 *    unobserved shapes, accepted for the same reason as the rest of this
 *    list.
 *
 *    Three review rounds (ticket 410e1a2) got this rule to its current
 *    shape, each closing a hole the previous one opened in the other
 *    direction: round 2 found the original any-non-letter-is-a-boundary
 *    rule misread "Tacoma, on-site" as the region "ON" (Ontario) and
 *    wrongly rejected a real posting -- a coverage loss (prose misread as a
 *    code, wrong rejection). Widening the hyphen-continuation rule to every
 *    code fixed that but (round 3) broke "Burbank, IL-Hybrid" -- Burbank is
 *    real in both the LA metro and Chicago's, and the widened rule stopped
 *    seeing "IL" as a region at all -- a false positive (a real code
 *    hidden, wrong acceptance). Narrowing the exception to a curated word
 *    list (`AMBIGUOUS_WORD_CODES`) fixed that, but (round 4) the list
 *    itself was incomplete -- it didn't include "co", so "Tacoma,
 *    co-located" still misread as Colorado, ANOTHER coverage loss in the
 *    same direction as round 2's, not the false-positive direction round 3
 *    fixed. The all-caps discriminator replaces "did we enumerate every
 *    English word this could collide with" with a property of the DATA:
 *    real codes in this shape are assumed written in caps, ordinary words
 *    aren't. `AMBIGUOUS_WORD_CODES` still exists only for the narrower case
 *    of a code ALSO plausibly written in caps as prose.
 *
 *    Residual weaknesses, accepted rather than chased further:
 *     - For the seven ambiguous codes, "Tacoma, OR-Hybrid" does not resolve
 *       "OR" as a region even though it's written in caps, because
 *       `AMBIGUOUS_WORD_CODES` can't tell "real Oregon code" from "shouted
 *       'or'" apart. For a NON-region-required city like Tacoma this is a
 *       false positive (the hidden real code means a foreign posting is
 *       wrongly accepted); for an ambiguous-nationally city it would be a
 *       coverage loss instead (the positive-region rule needs a positively-
 *       named region, and this rule hides the one that was there, so a
 *       genuine match is wrongly rejected) -- the SAME hidden-code
 *       mechanism, but which direction it fails in depends on the city.
 *     - Symmetrically, a NON-ambiguous code shouted in caps as emphasis is
 *       misread as real -- "Tacoma, CO-OP", "Tacoma, WI-FI", and "Tacoma,
 *       HI-TECH" all reject as Colorado/Wisconsin/Hawaii, a coverage loss
 *       (prose misread as a code, a real Tacoma posting wrongly rejected).
 *       Adding "co"/"wi"/"hi" to `AMBIGUOUS_WORD_CODES` would only recreate
 *       the OR-Hybrid residual for those three codes instead -- there is no
 *       version of this rule that closes both directions for the same
 *       token, only a choice of which one to accept.
 *
 * Direction of error: the prefix scan finds a strict superset of what
 * whole-field equality finds (whole-field is always tried first, and
 * returned immediately if it matches). A region the scan finds beyond
 * whole-field equality has two possible effects, not one: for most cities,
 * finding an out-of-set region REJECTS an expansion that absence-passes
 * would otherwise have allowed (closing a false positive, e.g. "Everett, MA
 * 02149"); for an ambiguous-nationally city, finding an IN-set region
 * instead CREATES an acceptance that whole-field equality would have denied
 * (adding a true positive, e.g. "Bellevue, WA (HQ)"). Neither is a
 * coverage-only or safety-only guarantee, which is why earlier versions of
 * this paragraph claiming a one-directional invariant were each wrong: this
 * function's failure modes are symmetric too -- a code misread out of prose
 * is a wrong rejection (coverage loss, "on-site" round 2, "co-located"
 * round 4, "CO-OP" above), and a real code hidden by the hyphen rule is a
 * failure to reject (false positive, "IL-Hybrid" round 3, "OR-Hybrid" above
 * on a non-ambiguous city).
 */
function regionOfField(field: string): string | undefined {
  const whole = lookupRegion(field);
  if (whole !== undefined) return whole;

  // Leading word-prefixes of the field, shortest first, each with the text
  // that follows it: "MA 02149" -> [{ text: "MA", rest: " 02149" }].
  const prefixes: { text: string; rest: string }[] = [];
  let cursor = 0;
  while (prefixes.length < MAX_REGION_WORDS) {
    const word = /^\s*[A-Za-z]+\.?/.exec(field.slice(cursor));
    if (word === null) break;
    cursor += word[0].length;
    prefixes.push({ text: field.slice(0, cursor).trim(), rest: field.slice(cursor) });
  }

  // Longest first: a two-word region ("New York") must win over its own
  // first word. None of the one-word prefixes of a multi-word region is
  // itself a region today ("new", "north", "rhode", "prince", "british", …),
  // so the order is belt-and-braces rather than load-bearing -- but it stays
  // correct if the table ever grows one that is.
  for (let i = prefixes.length - 1; i >= 0; i--) {
    const { text, rest } = prefixes[i];
    // The hyphen-vs-word-boundary ambiguity only ever arises for a TWO-LETTER
    // token -- that's the length postal codes and short English words/
    // prefixes ("on", "in", "co", "hi") both happen to share. Every longer
    // token (a full name like "Washington", or a multi-word name like "New
    // York") is never at risk of being misread as hyphenated prose, so it
    // keeps the plain any-non-letter boundary unconditionally.
    //
    // For a two-letter token, a real "City, ST-suffix" code is written in
    // caps ("WA-Remote", "IL-Hybrid"); a hyphenated English word essentially
    // never is ("co-located", "on-site", "Co-op"). So an exact two-letter
    // ALL-CAPS token is treated as a code even across a bare hyphen --
    // unless it's one of the seven codes assumed to also be shouted in caps
    // as prose emphasis ("ON-SITE", "IN-OFFICE" -- see the doc comment
    // above for why this is an assumption, not a measurement), which still
    // need the hyphen read as a continuation regardless of case.
    const isTwoLetterToken = text.length === 2;
    const looksLikeShoutedCode = isTwoLetterToken && /^[A-Z]{2}$/.test(text);
    const treatHyphenAsContinuation =
      isTwoLetterToken && (!looksLikeShoutedCode || AMBIGUOUS_WORD_CODES.has(text.toLowerCase()));
    const boundary = treatHyphenAsContinuation ? /^(\s*|-)[A-Za-z]/ : /^\s*[A-Za-z]/;
    if (boundary.test(rest)) continue;
    const region = lookupRegion(text);
    if (region !== undefined) return region;
  }
  return undefined;
}

/**
 * The region named immediately after `index` in `text`, or `undefined` if the
 * text names none there.
 *
 * Reads exactly one field: skip any leading separator/whitespace, then take
 * characters up to the next `,`, `;`, `|`, `/` or end of string, and resolve
 * the result with `regionOfField`. "…, WA; Menlo Park, CA" -> "WA". "…,
 * Washington, United States" -> "WA". "…, MA 02149" -> "MA". ", USA" /
 * " (Hybrid)" / ", in office 3 days" / "" -> undefined.
 */
function regionAfter(text: string, index: number): string | undefined {
  const match = /^[\s,]*([^,;|/]*)/.exec(text.slice(index));
  if (match === null) return undefined;
  return regionOfField(match[1].trim());
}

/** `\b city \b`, case-insensitive, global (the caller walks occurrences).
 * Dataset names are lowercase letters, spaces, hyphens and apostrophes only
 * (`cityCoordinates.ts`'s own filtering guarantees it), none of which are
 * regex metacharacters, so no escaping is needed and a bare `\b` anchor on
 * each end is always correct -- both pinned by `metroAreas.test.ts`.
 * Internal spaces are relaxed to `\s+` so "culver city" also matches
 * "Culver  City" across a line break. */
function cityPattern(city: string): RegExp {
  return new RegExp(`\\b${city.replace(/ +/g, "\\s+")}\\b`, "gi");
}

/**
 * Lazily-built, indefinitely-cached `cityPattern` results. The old table
 * precompiled a pattern for every one of its ~20 cities eagerly at module
 * load; that doesn't scale to this dataset's 12,827 unique names, almost
 * none of which are ever looked up in a given process's lifetime. Building
 * on first use and caching forever keeps the steady-state cost identical to
 * the old table's (one compiled `RegExp` per name actually matched against,
 * reused for every job after that) without paying to compile the other
 * ~12,000+ up front.
 */
const cityPatternCache = new Map<string, RegExp>();
function getCityPattern(city: string): RegExp {
  let pattern = cityPatternCache.get(city);
  if (pattern === undefined) {
    pattern = cityPattern(city);
    cityPatternCache.set(city, pattern);
  }
  return pattern;
}

/**
 * Which side of the match `text` is: the caller's search phrase, or a
 * posting's location string. Only `AMBIGUOUS_CITY_NAMES` treats the two
 * differently -- see its doc comment.
 */
type MatchSide = "phrase" | "posting";

/**
 * Does `text` place `city` inside `regions`?
 *
 * True when at least one occurrence of the city is followed by one of
 * `regions` ("Bellevue, WA"), or -- for a city whose bare name is not
 * ambiguous -- by no region at all ("Seattle", "Tacoma, 98402"). False when
 * every occurrence is followed by a region outside the set ("Everett, MA"),
 * false for an ambiguous city with no region on the posting side (see
 * `AMBIGUOUS_CITY_NAMES`), and false, of course, when the city does not
 * occur.
 *
 * Per-occurrence rather than per-string on purpose: "Bellevue, WA; Menlo
 * Park, CA" is a real posting shape in this app's own data and is genuinely
 * in Bellevue.
 */
function cityIsInRegions(
  city: string,
  text: string,
  regions: readonly string[],
  side: MatchSide,
): boolean {
  const pattern = getCityPattern(city);
  const regionRequired = side === "posting" && AMBIGUOUS_CITY_NAMES.has(city);
  // Shared, cached RegExp objects carry `lastIndex` between calls, so reset
  // before every walk. (A fresh RegExp per call would be correct too, and
  // measurably more allocation on the per-job path.)
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const region = regionAfter(text, match.index + match[0].length);
    if (region === undefined) {
      if (!regionRequired) return true;
    } else if (regions.includes(region)) {
      return true;
    }
    // Zero-length matches are impossible here (every city is non-empty), so
    // exec's lastIndex always advances and this loop always terminates.
  }
  return false;
}

/** Longest dataset name in words ("village of grosse pointe shores", "the
 * village of indian hill" -- both 5 words, measured 2026-10-10 against
 * `cityCoordinates.ts`). Bounds the n-gram scan in `resolveCallerCities`. */
const MAX_CITY_NAME_WORDS = 5;

/** `text`'s letter-runs, lowercased, each with the `[start, end)` character
 * span it occupies in `text` -- punctuation, digits, hyphens and apostrophes
 * all act as separators, matching `cityPattern`'s own `\b` treatment of a
 * hyphen as a boundary (ticket 410e1a2's "Renton-upon-Thames still finds
 * 'renton'" case, carried forward). This is also the source of the
 * documented coverage gap for the 87 dataset names that contain an internal
 * hyphen or apostrophe (this file's header) -- a caller phrase can never
 * reconstruct one of those names from separately-tokenized words, though a
 * POSTING naming one is matched fine (that path uses `cityPattern` against
 * raw text directly, never this tokenizer). */
function wordTokensWithOffsets(text: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = [];
  const re = /[A-Za-z]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

/**
 * Every city name `phrase` names, resolved to a coordinate where possible --
 * the caller-phrase half of ticket e5e1aa1's redesign, replacing ticket
 * 410e1a2's `metroGroupsFor`.
 *
 * Scans `phrase` for the longest dataset name starting at each word (so
 * "los angeles" wins over "los" at the same position, and a multi-word match
 * consumes all of its words before scanning continues), then, for each
 * found name:
 *
 *  - If a region immediately follows ("Everett, MA"), resolve to exactly the
 *    dataset entries for that name IN that region -- which may be a
 *    DIFFERENT real place than any other group previously keyed on the same
 *    name (e.g. "Pasadena, TX" resolves to Pasadena, TX's own coordinates,
 *    not "nothing", a deliberate behavior change from ticket 410e1a2's
 *    table -- see this file's header). A region that matches no dataset
 *    entry for the name is reported as unresolved ("wrong region"), not
 *    silently ignored.
 *  - Otherwise, if the name is unambiguous nationwide (exactly one state in
 *    `CITY_COORDINATES_BY_NAME`), resolve to it directly -- "absence passes"
 *    for a bare name, same spirit as ticket 410e1a2's caller-side exemption.
 *  - Otherwise (ambiguous, no region given) the name is reported as
 *    unresolved ("ambiguous") rather than guessed -- see
 *    `AMBIGUOUS_CITY_NAMES`'s doc comment for why.
 *
 * A phrase can name more than one city ("Seattle or Bellevue"), which is
 * unusual but not wrong -- every resolved name's coordinates are returned,
 * not just the first.
 */
type CityCoordinateCandidate = {
  state: string;
  lat: number;
  lon: number;
  alandSqMi: number;
};

function resolveCallerCities(phrase: string): {
  resolved: Map<string, CityCoordinateCandidate[]>;
  unresolvedMessages: string[];
} {
  const resolved = new Map<string, CityCoordinateCandidate[]>();
  const unresolvedMessages: string[] = [];
  const tokens = wordTokensWithOffsets(phrase);

  let i = 0;
  while (i < tokens.length) {
    let matchedLen = 0;
    let candidateName = "";
    let candidates: readonly CityCoordinateCandidate[] | undefined;
    const maxLen = Math.min(MAX_CITY_NAME_WORDS, tokens.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const name = tokens
        .slice(i, i + len)
        .map((t) => t.word)
        .join(" ");
      const found = CITY_COORDINATES_BY_NAME.get(name);
      if (found !== undefined) {
        matchedLen = len;
        candidateName = name;
        candidates = found;
        break;
      }
    }
    if (candidates === undefined) {
      i += 1;
      continue;
    }

    const matchEnd = tokens[i + matchedLen - 1].end;
    const region = regionAfter(phrase, matchEnd);
    if (region !== undefined) {
      const inRegion = candidates.filter((c) => c.state === region);
      if (inRegion.length > 0) {
        resolved.set(candidateName, [...(resolved.get(candidateName) ?? []), ...inRegion]);
      } else {
        unresolvedMessages.push(
          `"${candidateName}" was named with region "${region}", but the bundled dataset has no ` +
            `such place there`,
        );
      }
    } else {
      const states = [...new Set(candidates.map((c) => c.state))].sort();
      if (states.length === 1) {
        resolved.set(candidateName, [...(resolved.get(candidateName) ?? []), ...candidates]);
      } else {
        // The example state named in the warning (NOT the resolution logic
        // above, which never guesses) is picked by largest land area --
        // measured, not assumed, to be a reasonable HINT even though it is
        // not a reliable RESOLUTION heuristic (see `AMBIGUOUS_CITY_NAMES`'s
        // doc comment for the measurement showing it gets Pasadena,
        // Nashville, Lexington, Rochester and Albany wrong as a resolution
        // rule). A wrong example state in a hint costs nothing worse than a
        // slightly-off suggestion; a wrong example in the ACTUAL resolution
        // would silently compute "nearby" from the wrong place entirely,
        // which is exactly what this file refuses to do.
        const suggestedState = [...candidates].sort((a, b) => b.alandSqMi - a.alandSqMi)[0].state;
        unresolvedMessages.push(
          `"${candidateName}" exists in multiple states (${states.join(", ")}) -- add one ` +
            `(e.g. "${candidateName}, ${suggestedState}") to use "include nearby cities" for it`,
        );
      }
    }
    i += matchedLen;
  }

  return { resolved, unresolvedMessages };
}

/**
 * The default "no coordinate data at all" message, or `unresolvedMessages`
 * verbatim when `resolveCallerCities` already has something more specific to
 * say (ambiguous / wrong region). Factored out so `compileMetroAreaMatchers`'s
 * `console.warn` (operator-visible) and `nearbyCityExpansionWarnings` (the
 * caller-facing one surfaced through the API -- ticket e5e1aa1 review round
 * 2, D8) can never drift out of sync in wording -- they call this with the
 * SAME `unresolvedMessages` array `resolveCallerCities` already computed,
 * not two independent re-derivations of it.
 */
function unresolvedReasonMessages(phrase: string, unresolvedMessages: string[]): string[] {
  if (unresolvedMessages.length > 0) return unresolvedMessages;
  return [
    `no coordinate data for "${phrase.trim()}" in the bundled dataset -- "include nearby ` +
      `cities" has no effect for this location`,
  ];
}

/**
 * The reasons `phrase` could not be expanded when `expandMetroAreas` is on --
 * the caller-facing half of the fix for ticket e5e1aa1's central acceptance
 * criterion ("a city with no coordinate data is reported to the user rather
 * than silently matching nothing"), which `compileMetroAreaMatchers`'s
 * `console.warn` alone did not satisfy (review round 2, D8: a server log
 * line is visible to an operator, not to the user filling in the checkbox).
 *
 * `criteria.ts`'s `locationExpansionWarnings` calls this once per
 * `nearLocations` phrase and `searches.ts` returns the result on
 * `EstimateSearchResponse.locationWarnings`; `SearchCriteriaForm.tsx` renders
 * it next to the checkbox. `[]` for a phrase that resolved (nothing to
 * report) or that named no city at all AND is blank -- a non-blank phrase
 * that names no recognizable city ("Remote", "EMEA", a typo) still reports,
 * same as `compileMetroAreaMatchers`'s own console.warn and for the same
 * reason: this function cannot tell "unsupported real city" apart from "not
 * a city" either, and over-reporting a harmless case costs far less than
 * silently swallowing a real one again.
 */
export function nearbyCityExpansionWarnings(phrase: string): string[] {
  if (phrase.trim().length === 0) return [];
  const { resolved, unresolvedMessages } = resolveCallerCities(phrase);
  if (resolved.size > 0) return [];
  return unresolvedReasonMessages(phrase, unresolvedMessages);
}

/**
 * The extra location matchers one `nearLocations` phrase earns when
 * `expandMetroAreas` is on. Empty for a phrase that resolves to no
 * coordinate at all -- see below for what that means and what this function
 * does about it instead of staying silent.
 *
 * Each matcher is "this posting names that city, and does not place it in a
 * region the within-radius scan didn't find it in" (`cityIsInRegions`). The
 * caller's own literal matcher is NOT included here: `criteria.ts` always
 * compiles and tests that one itself, unmodified, which is what makes
 * expansion purely additive.
 *
 * EVERY city within radius gets a matcher, INCLUDING the one the caller
 * typed -- it is always within its own radius (distance 0), so it is always
 * among `nearby`'s keys for a resolved phrase. This is why a SUCCESSFULLY
 * RESOLVED phrase can never produce zero matchers (ticket 410e1a2 review
 * finding F2's fix, preserved by construction rather than by special-casing
 * the named city the way the old table had to).
 *
 * That invariant is what makes `matchers.length === 0` an unambiguous signal
 * that resolution failed -- not "resolved to a city with nothing nearby",
 * which cannot happen. THIS IS THE FIX FOR THE ACTUAL BUG (ticket e5e1aa1):
 * a city absent from the dataset, named with the wrong region, or ambiguous
 * with no region given, now produces a `console.warn` naming the phrase and
 * the reason, rather than the silent no-op John hit typing "Olympia" under
 * the old table. The warning fires for ANY non-blank phrase that resolves to
 * nothing -- including a phrase that was never meant as a city at all
 * ("Remote", "EMEA") -- because this function has no principled way to tell
 * "an unsupported real city" apart from "not a city", and the cost of a
 * same-session developer/operator log line for the latter is far smaller
 * than the cost of silently swallowing the former again. A blank phrase
 * ("", "  ") produces neither a matcher nor a warning: it names no attempt
 * at a location, same as today.
 */
export function compileMetroAreaMatchers(phrase: string): ((location: string) => boolean)[] {
  const { resolved, unresolvedMessages } = resolveCallerCities(phrase);
  const nearby = new Map<string, Set<string>>();
  for (const coordinates of resolved.values()) {
    for (const { lat, lon } of coordinates) {
      for (const candidate of CITY_COORDINATES) {
        if (haversineMiles(lat, lon, candidate.lat, candidate.lon) <= NEARBY_CITY_RADIUS_MILES) {
          let states = nearby.get(candidate.name);
          if (states === undefined) {
            states = new Set();
            nearby.set(candidate.name, states);
          }
          states.add(candidate.state);
        }
      }
    }
  }

  const matchers = [...nearby.entries()].map(([name, states]) => {
    const regions = [...states];
    return (location: string) => cityIsInRegions(name, location, regions, "posting");
  });

  if (matchers.length === 0 && phrase.trim().length > 0) {
    for (const message of unresolvedReasonMessages(phrase, unresolvedMessages)) {
      console.warn(`[metroAreas] "include nearby cities" could not expand: ${message}`);
    }
  }

  return matchers;
}

/**
 * The city names a phrase expands to within `NEARBY_CITY_RADIUS_MILES`
 * miles, EXCLUDING the names the phrase itself resolved to -- "what will
 * this checkbox pull in, beyond what I typed". Exported for tests and for a
 * future UI surface (e.g. a dynamic version of the checkbox's own label
 * text, which ticket e5e1aa1 deliberately left static and generic -- see
 * `SearchCriteriaForm.tsx`); `compileMetroAreaMatchers` is what the filter
 * itself uses, and it deliberately covers the named city too (see its own
 * doc comment for why that is not the same list).
 */
export function nearbySiblingCitiesFor(phrase: string): string[] {
  const { resolved } = resolveCallerCities(phrase);
  const named = new Set(resolved.keys());
  const siblings = new Set<string>();
  for (const coordinates of resolved.values()) {
    for (const { lat, lon } of coordinates) {
      for (const candidate of CITY_COORDINATES) {
        if (
          !named.has(candidate.name) &&
          haversineMiles(lat, lon, candidate.lat, candidate.lon) <= NEARBY_CITY_RADIUS_MILES
        ) {
          siblings.add(candidate.name);
        }
      }
    }
  }
  return [...siblings];
}
