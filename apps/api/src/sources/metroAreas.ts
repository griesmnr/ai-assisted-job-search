/**
 * Local, zero-cost METRO-AREA EXPANSION for caller-supplied location
 * phrases (ticket 410e1a2).
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
 * Measured, not assumed. Against the owner's own real scored corpus from her
 * 2026-09-23 run (`prep/match-results.json`, 200 postings that had already
 * passed the CLI default filter and been scored by Claude), a strict
 * `nearLocations: ["Seattle"]` search drops **29 of 200** postings that are
 * physically in the Seattle metro area but never say "Seattle":
 *
 *   - 24 Bellevue-only postings (Databricks "Senior Software Engineer -
 *     Backend", Robinhood "Senior Software Engineer, Kubernetes Compute",
 *     Smartsheet "Senior Software Engineer I (Automation)", ...), written as
 *     "Bellevue, WA" (9), "Bellevue, Washington" (12), "Bellevue, WA, USA"
 *     (1), and multi-city strings led by Bellevue (2).
 *   - 5 more multi-city postings pairing Bellevue with an out-of-state
 *     office: "Bellevue, WA; Menlo Park, CA" (3), "Bellevue, Washington;
 *     Chicago, Illinois; New York, New York" (1+1 variant), "Bellevue,
 *     Washington; San Francisco, California" (1).
 *
 * Verified before writing any of this (see criteria.test.ts's own strict
 * tests): `compileFilter({ nearLocations: ["Seattle"] })` returns nothing for
 * a posting located "Kirkland, WA" or "Bellevue, Washington", and DOES return
 * the real posting located "Bellevue, Washington; Seattle, Washington" --
 * multi-location matching already worked; only the sibling-city case was
 * missing.
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
 * That framing is also why the groups below are METRO areas (an OMB/Census
 * MSA) rather than a commute-time radius. An MSA is a published, checkable,
 * stable definition; "45 minutes by car" is neither, and would need routing
 * data this app does not have. The cost of the MSA choice is stated plainly
 * on each group: Tacoma to Everett is ~60 miles and nobody commutes it
 * daily. The checkbox is what makes that acceptable -- the user opted into
 * "same metro", not into "guaranteed commutable".
 *
 * ---------------------------------------------------------------------------
 * WHY A CURATED TABLE AND NOT A GEOCODER
 * ---------------------------------------------------------------------------
 *
 * Same cost-and-dependency discipline as `titleSynonyms.ts` (ticket 0298b20)
 * and `ingest/textSimilarity.ts` (ticket 78d31b7): this is evaluated against
 * every posting of every source on every search. A geocoding API call per
 * posting would be recurring money and a new network dependency in the
 * filter path, for a question a small table answers correctly for the cases
 * that actually occur. Pure, synchronous, network-free.
 *
 * Cost shape: expansion happens once per `compileFilter` call, not per job --
 * it produces a handful of extra compiled matchers up front. Per job, the
 * added work is a few extra `RegExp.test` calls that short-circuit on the
 * first hit, and the region guard below runs ONLY after a sibling city has
 * already matched (`cityMatcher(loc) && !foreignRegion(...)`), so the common
 * case -- a posting in neither metro -- pays nothing beyond the city tests.
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
 * So each group declares the REGIONS (US state / DC / Canadian province
 * postal codes) it spans, and a sibling-city match is rejected when the text
 * names a region OUTSIDE that set immediately after the city. "Everett, MA"
 * does not satisfy a Seattle expansion; "Everett, WA", "Everett, Washington"
 * and bare "Everett" all do. The same guard runs on the CALLER's phrase, so
 * typing "Pasadena, TX" selects no group at all rather than quietly
 * selecting Los Angeles.
 *
 * **Immediately after** is doing real work and is not a simplification of
 * "anywhere in the string". Five of the 29 real postings above are
 * multi-city ("Bellevue, WA; Menlo Park, CA"), and a whole-string test would
 * see "CA", call the posting foreign, and drop a job that genuinely is in
 * Bellevue. So the guard reads only the comma-delimited field that follows
 * the matched city, cut at the first `;`/`|`/`/` -- i.e. the "WA" in
 * "Bellevue, WA; Menlo Park, CA" -- and that field must BE a region
 * name/code for the guard to fire. A field that is anything else ("USA",
 * "98004", "Hybrid", nothing at all) is not a region mention and does not
 * reject.
 *
 * **The guard can only ever suppress an expansion, never create one.** That
 * asymmetry is the whole safety argument, and it is structural rather than
 * argued: expansion only ever ADDS matchers to `nearLocations` (the caller's
 * own literal phrase is always compiled and tested first, unmodified), and
 * the guard only ever removes added matchers. So every posting that matched
 * with the flag off still matches with it on, and every way the guard can be
 * wrong -- a misread field, an unusual separator, a city list like "Seattle,
 * New York, San Francisco" where "New York" is a city and not a state --
 * costs coverage this feature would otherwise have added, never a false
 * positive. A user who hits one of those sees exactly today's strict
 * behavior.
 *
 * Known residual weaknesses, recorded rather than papered over:
 *  - A bare, region-less ambiguous city name in the CALLER's phrase still
 *    picks a group: `nearLocations: ["Everett"]` meaning Everett, MA expands
 *    to the Seattle metro. The honest mitigation is the UI, where the
 *    checkbox's own label names the cities it will pull in; the technical
 *    one (requiring a region in the caller's phrase before expanding at all)
 *    was rejected as too strict -- "Seattle" with no state is how people
 *    actually type, and it is the exact phrase this ticket exists to serve.
 *  - The region vocabulary is US + Canada. A city field naming a region
 *    elsewhere ("Kirkland, Île-de-France") is not recognized as foreign.
 *    Canada is included because it is the adjacency that actually shows up
 *    in this app's real data (the corpus above contains "Vancouver, British
 *    Columbia", "Toronto, Ontario", "Ottawa, Ontario" and "Remote, Canada").
 *  - Free-text prefixes between the city and its region ("Bellevue (Hybrid),
 *    WA") put a non-region field in the guard's window, so the guard does not
 *    fire. Unobserved in real data; harmless for an in-metro posting, a false
 *    positive for an out-of-metro one.
 */

/**
 * One metro area: cities that a searcher naming any one of them plausibly
 * meant to include, plus the regions that metro spans.
 *
 * Cities are lowercase and plain-word (letters and single spaces only) --
 * `metroAreas.test.ts` asserts that, because it is what makes a `\b...\b`
 * anchor unconditionally correct for every entry, the way `makePhraseMatcher`
 * has to reason case-by-case about phrases like "c++" and ".net" that the
 * caller may type.
 */
export interface MetroAreaGroup {
  /** The metro's published name, with the authority it comes from. */
  readonly metro: string;
  /** US state / DC / Canadian province postal codes this metro spans. */
  readonly regions: readonly string[];
  /** Cities in this metro, lowercase, plain words. */
  readonly cities: readonly string[];
  /** Why these specific cities, and what was checked. */
  readonly why: string;
}

/**
 * The table. Two metro areas, both taken from the OMB/Census metropolitan
 * statistical area that already defines them, both spot-checked against this
 * repo's own real captured postings.
 *
 * Deliberately NOT exhaustive US coverage (ticket 410e1a2 scope: "prove the
 * pattern with 2+ real, well-verified groupings"). Each group lists the
 * metro's principal employment centers -- the cities that appear in the
 * MSA's own published name or metropolitan-division names, plus ones with a
 * real hiring presence -- not every incorporated city in it. An omitted city
 * costs coverage (a Kent, WA posting still will not match a "Seattle"
 * search), which is the same safe direction as everything else in this file;
 * a WRONG city would cost a false positive, which is why each one below is
 * justified individually.
 */
export const METRO_AREA_GROUPS: readonly MetroAreaGroup[] = [
  {
    metro: "Seattle-Tacoma-Bellevue, WA MSA (OMB/Census CBSA 42660)",
    regions: ["WA"],
    cities: ["seattle", "bellevue", "kirkland", "redmond", "renton", "everett", "tacoma"],
    why:
      "The ticket's own starting list, checked rather than accepted. The " +
      "Census Bureau defines the Seattle-Tacoma-Bellevue, WA MSA as exactly " +
      "three counties -- King, Pierce and Snohomish -- and its three " +
      "metropolitan divisions are named Seattle-Bellevue-Kent (King), " +
      "Tacoma-Lakewood (Pierce) and Everett (Snohomish), so Seattle, " +
      "Bellevue, Tacoma and Everett are named by the definition itself. " +
      "Kirkland, Redmond and Renton are King County cities on King County's " +
      "own published city list (Renton is an inner-ring suburb ~11 miles " +
      "southeast of downtown Seattle). All seven verified in-MSA; none " +
      "guessed. Real-data backing, beyond the definition: of 200 postings in " +
      "the owner's own scored corpus, 29 are in a sibling city with no " +
      "'Seattle' anywhere in the location string (all Bellevue -- " +
      "Databricks, Robinhood, Okta, Smartsheet), and 2 are the mixed form " +
      "'Bellevue, Washington; Seattle, Washington' that already matched. " +
      "Honest caveat: this is a metro, not a commute -- Tacoma to Everett is " +
      "~60 miles end to end, which is why the whole feature is a checkbox.",
  },
  {
    metro: "Los Angeles-Long Beach-Anaheim, CA MSA (OMB/Census CBSA 31080)",
    regions: ["CA"],
    cities: [
      "los angeles",
      "long beach",
      "anaheim",
      "santa ana",
      "irvine",
      "glendale",
      "burbank",
      "pasadena",
      "santa monica",
      "culver city",
      "west hollywood",
      "el segundo",
      "torrance",
    ],
    why:
      "The second metro, chosen because this repo already holds real " +
      "evidence of the exact miss: the captured Match Group (Lever) fixture " +
      "contains 'Senior Software Engineer, Machine Learning Infrastructure " +
      "(Tinder LLC, West Hollywood, California)' located ONLY in 'West " +
      "Hollywood, California' -- a posting a strict nearLocations " +
      "['Los Angeles'] search misses today, in a city that is an enclave " +
      "entirely surrounded by Los Angeles. The Census Bureau defines the " +
      "Los Angeles-Long Beach-Anaheim, CA MSA as exactly two counties, Los " +
      "Angeles and Orange, split into the Los Angeles-Long Beach-Glendale " +
      "and Anaheim-Santa Ana-Irvine metropolitan divisions -- which names " +
      "six of the thirteen cities here outright. The rest are LA County " +
      "(Burbank, Pasadena, Santa Monica, Culver City, West Hollywood, El " +
      "Segundo, Torrance) employment centers. Three carry a same-name " +
      "conflict in another metro and are kept only because the region guard " +
      "covers the case where a posting or a caller says so: Pasadena (also " +
      "TX, pop. 149,615, a namesake of the Houston-Pasadena-The Woodlands " +
      "MSA), Glendale (also AZ, pop. 248,325, Phoenix metro) and Long Beach " +
      "(also NY and MS).",
  },
];

/**
 * ---------------------------------------------------------------------------
 * NOT GROUPED -- candidates considered and deliberately left out
 * ---------------------------------------------------------------------------
 *
 * As in `titleSynonyms.ts`, this section is half the point. Each of these
 * looked reasonable and each would have been wrong in a specific way.
 *
 *  - `arlington`, in any group. It is three real places at once: Arlington,
 *    VA (the Pentagon -- and USAJOBS is a live source in this app, so
 *    federal Arlington postings genuinely arrive here; the captured USAJOBS
 *    fixture contains "Pentagon, Arlington, Virginia"), Arlington, TX (a
 *    namesake of the Dallas-Fort Worth-Arlington MSA), and Arlington, WA --
 *    a Snohomish County city INSIDE the Seattle MSA. A bare "Arlington" in a
 *    caller's phrase cannot be resolved, and the one direction the region
 *    guard cannot help with is exactly a bare, region-less phrase. This is
 *    also why the Dallas metro was not the second group despite being an
 *    obvious candidate: its MSA name contains the single most ambiguous
 *    city name in the country.
 *
 *  - `vancouver` in the Seattle group. Tempting because it is in Washington;
 *    wrong twice over. Vancouver, WA is part of the Portland-Vancouver-
 *    Hillsboro, OR-WA MSA -- 150 miles from Seattle, a different metro
 *    entirely -- and Vancouver, BC is a different country. The owner's own
 *    corpus contains "Vancouver, British Columbia" on a real posting, so
 *    this is a live collision, not a hypothetical. A state-level heuristic
 *    ("it's in WA, so it's Seattle") would have grouped it; the MSA
 *    definition correctly does not.
 *
 *  - `olympia`, `bremerton`, `bellingham`, `spokane` in the Seattle group.
 *    Each is its own MSA (Olympia-Lacey-Tumwater; Bremerton-Silverdale-Port
 *    Orchard; Bellingham; Spokane-Spokane Valley). Bremerton in particular
 *    is ~15 miles across Puget Sound and a ferry ride, i.e. close on a map
 *    and not close in practice -- the clearest illustration of why this
 *    table follows published metro definitions instead of map distance.
 *
 *  - `kent`, `auburn`, `lakewood` -- genuinely inside the Seattle MSA (Kent
 *    is even in the Seattle-Bellevue-Kent division name) but each is a very
 *    common US place name (Kent, OH; Auburn, AL and Auburn University;
 *    Lakewood in CO, NJ, OH and CA). They are omitted for now, which costs
 *    only coverage. `bothell`, `issaquah`, `lynnwood`, `federal way`,
 *    `puyallup` and `everett`'s other Snohomish neighbors are in-MSA and
 *    unambiguous and are the natural first additions if this table grows --
 *    left out here only to keep every line of the initial table individually
 *    verified rather than plausible.
 *
 *  - The San Francisco Bay Area, as one group. This is the candidate with
 *    the BEST real-data support in the repo -- the owner's corpus has
 *    "Bellevue, WA; Menlo Park, CA" (x3) and Palo Alto/San Francisco
 *    multi-city postings, and the Bosch fixture has "Sunnyvale, CA, United
 *    States" -- and it is still left out, because it is the one place the
 *    MSA authority this table relies on gives an answer the local job market
 *    would call wrong. San Francisco-Oakland-Berkeley and San Jose-
 *    Sunnyvale-Santa Clara are two SEPARATE MSAs: Menlo Park (San Mateo
 *    County) is in the first, Palo Alto and Sunnyvale (Santa Clara County)
 *    are in the second, even though everyone involved calls all of it "the
 *    Bay Area" and the Combined Statistical Area does group them. Grouping
 *    them here would mean silently switching authorities (MSA for Seattle
 *    and LA, CSA for the Bay) and asserting a 35-mile-each-way commute --
 *    precisely the surprise this ticket's opt-in design exists to avoid.
 *    Deferred to its own ticket, where the MSA-vs-CSA choice can be made
 *    once, explicitly, for every metro.
 *
 *  - New York / Newark / Jersey City. Nothing structural blocks it -- a
 *    group's `regions` is a set, so a tri-state metro is expressible as
 *    `["NY", "NJ", "CT"]` -- it simply has not been verified to the standard
 *    of the two above, and an unverified group is what this file exists to
 *    prevent. Same for Portland (OR vs ME, another bare-name collision that
 *    would need the guard) and for every other US metro: adding one is a
 *    small, reviewable follow-up ticket, not a reason to guess now.
 *
 *  - Neighborhoods, boroughs and areas WITHIN a city (Capitol Hill, Ballard,
 *    Brooklyn, Silicon Beach). A different mechanism with a different risk
 *    profile: they are sub-city, so the containment is one-directional (a
 *    "Seattle" search should match a Ballard posting, but a "Ballard" search
 *    matching everything in Seattle is a much broader claim), and the names
 *    collide with ordinary words far more often. Not attempted.
 */

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
 * The region named immediately after `index` in `text`, or `undefined` if the
 * text names none there.
 *
 * Reads exactly one field: skip any leading separator/whitespace, then take
 * characters up to the next `,`, `;`, `|`, `/` or end of string, and look the
 * trimmed result up as a region. "…, WA; Menlo Park, CA" -> "WA". "…,
 * Washington, United States" -> "WA". "…, MA" -> "MA". ", USA" / " (Hybrid)"
 * / "" -> undefined.
 */
function regionAfter(text: string, index: number): string | undefined {
  const match = /^[\s,]*([^,;|/]*)/.exec(text.slice(index));
  if (match === null) return undefined;
  const field = match[1].trim().toLowerCase();
  if (field.length === 0) return undefined;
  // A trailing period is common on abbreviations ("Pasadena, Tx.") and is
  // never part of a region name here except in "d.c.", which is matched
  // before the strip by the first lookup.
  return REGION_CODE_BY_NAME.get(field) ?? REGION_CODE_BY_NAME.get(field.replace(/\.$/, ""));
}

/** `\b city \b`, case-insensitive, global (the caller walks occurrences).
 * Cities are plain words by construction, so a bare `\b` on each end is
 * always the right anchor and no regex escaping is needed -- both pinned by
 * `metroAreas.test.ts`. Internal spaces are relaxed to `\s+` so "culver
 * city" also matches "Culver  City" across a line break. */
function cityPattern(city: string): RegExp {
  return new RegExp(`\\b${city.replace(/ +/g, "\\s+")}\\b`, "gi");
}

const PATTERN_BY_CITY: ReadonlyMap<string, RegExp> = (() => {
  const map = new Map<string, RegExp>();
  for (const group of METRO_AREA_GROUPS) {
    for (const city of group.cities) map.set(city, cityPattern(city));
  }
  return map;
})();

/**
 * Does `text` place `city` inside `regions`?
 *
 * True when at least one occurrence of the city is either followed by no
 * region at all ("Bellevue", "Bellevue, USA") or followed by one of
 * `regions` ("Bellevue, WA"). False when every occurrence is followed by a
 * region outside the set ("Everett, MA") -- and false, of course, when the
 * city does not occur.
 *
 * Per-occurrence rather than per-string on purpose: "Bellevue, WA; Menlo
 * Park, CA" is a real posting shape in this app's own data and is genuinely
 * in Bellevue.
 */
function cityIsInRegions(city: string, text: string, regions: readonly string[]): boolean {
  const pattern = PATTERN_BY_CITY.get(city);
  if (pattern === undefined) return false;
  // Shared compiled RegExp objects carry `lastIndex` between calls, so reset
  // before every walk. (A fresh RegExp per call would be correct too, and
  // measurably more allocation on the per-job path.)
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const region = regionAfter(text, match.index + match[0].length);
    if (region === undefined || regions.includes(region)) return true;
    // Zero-length matches are impossible here (every city is non-empty), so
    // exec's lastIndex always advances and this loop always terminates.
  }
  return false;
}

/**
 * The metro groups a caller's `nearLocations` phrase selects.
 *
 * A phrase selects a group when it names one of that group's cities AND does
 * not pin that city to a region outside the group -- so "Seattle", "seattle,
 * wa" and "Greater Seattle Area" all select the Seattle metro, while
 * "Pasadena, TX" selects nothing. Usually zero or one group; the array shape
 * is for the phrase that names cities in two ("Seattle and Los Angeles"),
 * which is unusual but not wrong.
 */
export function metroGroupsFor(phrase: string): MetroAreaGroup[] {
  return METRO_AREA_GROUPS.filter((group) =>
    group.cities.some((city) => cityIsInRegions(city, phrase, group.regions)),
  );
}

/**
 * The sibling cities a phrase expands to: every city of every group it
 * selects, minus the ones the phrase already names.
 *
 * Exported for tests and for anything that wants to SHOW a user what a
 * phrase will pull in; `compileMetroSiblingMatchers` is what the filter
 * itself uses.
 */
export function metroSiblingCitiesFor(phrase: string): string[] {
  const siblings: string[] = [];
  for (const group of metroGroupsFor(phrase)) {
    for (const city of group.cities) {
      if (cityIsInRegions(city, phrase, group.regions)) continue;
      if (!siblings.includes(city)) siblings.push(city);
    }
  }
  return siblings;
}

/**
 * The extra location matchers one `nearLocations` phrase earns when
 * `expandMetroAreas` is on. Empty for a phrase that names no table city --
 * i.e. for the overwhelming majority of phrases, the flag changes nothing.
 *
 * Each matcher is "this posting names the sibling city, and does not place
 * that city in another region" (see `cityIsInRegions`). The caller's own
 * literal matcher is NOT included here: `criteria.ts` always compiles and
 * tests that one itself, unmodified, which is what makes expansion purely
 * additive.
 */
export function compileMetroSiblingMatchers(phrase: string): ((location: string) => boolean)[] {
  const matchers: ((location: string) => boolean)[] = [];
  for (const group of metroGroupsFor(phrase)) {
    for (const city of group.cities) {
      if (cityIsInRegions(city, phrase, group.regions)) continue;
      matchers.push((location: string) => cityIsInRegions(city, location, group.regions));
    }
  }
  return matchers;
}
