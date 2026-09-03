import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyGeography,
  filterSoftwareEngineeringJobs,
  matchesTitleExclusion,
  passesLocationFilter,
  resolveWorkArrangement,
} from "./swe-filter.js";
import type { NormalizedJob } from "./types.js";

// ---------------------------------------------------------------------------
// Ticket 4450f39: the old `PLACE` regex conflated WHERE a job is (Seattle /
// Bellevue / Washington / anywhere-US) with HOW it's worked (remote / hybrid
// / onsite), which is why it silently dropped 100% of Ashby and
// SmartRecruiters survivors (both sources spell "US-remote" differently
// than Greenhouse's one board that happened to inspire the original regex).
//
// Every location string and `locationType` pairing below is copied
// verbatim from a committed fixture under __fixtures__/ (or, for the two
// strings the ticket itself names as live-measured evidence — "Remote
// U.S." and "Remote - Canada" — quoted directly from the ticket body,
// clearly marked as such below). None are hand-invented: this project has
// shipped nine silent location-parsing bugs by testing against strings
// nobody actually captured from a real source.
//
// Titles are mostly real too (see the title-filter section), but the
// trimmed fixtures happen to pair almost every genuine "Software Engineer"
// title with an uninteresting location (or vice versa) — there are only
// two real (passing-title, location) pairs in the whole fixture set
// (lever-real-response-palantir.json's "Backend Software Engineer -
// Defense" / "Washington, D.C." and lever-real-response-matchgroup.json's
// ML-infra role, both used below). For the geography/arrangement matrix,
// `classifyGeography`/`resolveWorkArrangement`/`passesLocationFilter` are
// exported specifically so location behavior can be verified directly
// against real (location, locationType) pairs without first inventing a
// title to smuggle a real location string through the public
// `filterSoftwareEngineeringJobs` API.
// ---------------------------------------------------------------------------

type Fixture = { jobs?: unknown[]; content?: unknown[] };

function loadFixture(name: string): Fixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as Fixture;
}

const leverPalantir = loadFixture("lever-real-response-palantir.json") as unknown as Array<{
  text: string;
  categories?: { location?: string };
  workplaceType?: string;
}>;
const leverOutreach = loadFixture("lever-real-response-outreach.json") as unknown as Array<{
  text: string;
  categories?: { location?: string };
  workplaceType?: string;
}>;
const leverMatchgroup = loadFixture("lever-real-response-matchgroup.json") as unknown as Array<{
  text: string;
}>;
const leverBinance = loadFixture("lever-real-response-binance.json") as unknown as Array<{
  text: string;
  categories?: { location?: string; allLocations?: string[] };
  workplaceType?: string;
}>;
const ashbyRamp = loadFixture("ashby-real-response-ramp.json").jobs as Array<{
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  workplaceType?: string | null;
}>;
const ashbyNotion = loadFixture("ashby-real-response-notion.json").jobs as Array<{
  title: string;
}>;
const greenhouseAirbnb = loadFixture("greenhouse-real-response-airbnb.json").jobs as Array<{
  title: string;
  location?: { name?: string };
  metadata?: { name?: string; value?: unknown }[];
}>;
const greenhouseDiscord = loadFixture("greenhouse-real-response-discord.json").jobs as Array<{
  title: string;
  location?: { name?: string };
}>;
const smartrecruitersPage1 = loadFixture("smartrecruiters-real-response-bosch-postings-page1.json")
  .content as Array<{
  name: string;
  location: { fullLocation: string; remote: boolean; hybrid: boolean };
}>;
const smartrecruitersPage2 = loadFixture("smartrecruiters-real-response-bosch-postings-page2.json")
  .content as Array<{
  name: string;
  location: { fullLocation: string; remote: boolean; hybrid: boolean };
}>;
// Ticket 9cac9a9: not loaded via `.jobs`/`.content` like the sources above —
// usajobs-real-response.json is a raw USAJOBS search response (see
// usajobs.test.ts), shaped `{ SearchResult: { SearchResultItems: [...] } }`.
const usajobsReal = loadFixture("usajobs-real-response.json") as unknown as {
  SearchResult: {
    SearchResultItems: Array<{
      MatchedObjectDescriptor?: {
        PositionLocation?: Array<{ LocationName?: string; CountrySubDivisionCode?: string }>;
      };
    }>;
  };
};

if (leverPalantir.length !== 5) {
  throw new Error(
    `expected the lever palantir fixture to have 5 postings, got ${leverPalantir.length}`,
  );
}
if (leverOutreach.length !== 3) {
  throw new Error(
    `expected the lever outreach fixture to have 3 postings, got ${leverOutreach.length}`,
  );
}
if (ashbyRamp.length !== 5) {
  throw new Error(`expected the ashby ramp fixture to have 5 postings, got ${ashbyRamp.length}`);
}
if (ashbyNotion.length !== 3) {
  throw new Error(
    `expected the ashby notion fixture to have 3 postings, got ${ashbyNotion.length}`,
  );
}
if (greenhouseAirbnb.length !== 3) {
  throw new Error(
    `expected the greenhouse airbnb fixture to have 3 postings, got ${greenhouseAirbnb.length}`,
  );
}
if (greenhouseDiscord.length !== 3) {
  throw new Error(
    `expected the greenhouse discord fixture to have 3 postings, got ${greenhouseDiscord.length}`,
  );
}
if (smartrecruitersPage1.length !== 5) {
  throw new Error(
    `expected the smartrecruiters page1 fixture to have 5 postings, got ${smartrecruitersPage1.length}`,
  );
}
if (smartrecruitersPage2.length !== 2) {
  throw new Error(
    `expected the smartrecruiters page2 fixture to have 2 postings, got ${smartrecruitersPage2.length}`,
  );
}
if (leverMatchgroup.length !== 1) {
  throw new Error(
    `expected the lever matchgroup fixture to have 1 posting, got ${leverMatchgroup.length}`,
  );
}
if (leverBinance.length !== 4) {
  throw new Error(
    `expected the lever binance fixture to have 4 postings, got ${leverBinance.length}`,
  );
}

// Ticket 9cac9a9: the real USAJOBS "District of Columbia" spelling, pulled
// straight from the committed fixture rather than typed by hand. It lives
// inside a `PositionLocation` entry (a "Joint Base Anacostia-Bolling,
// District of Columbia" posting), not in `PositionLocationDisplay` on any
// single-location record in this fixture — see the PNW doc comment in
// swe-filter.ts for why "Washington, " + this value is still the honest,
// non-invented string to test against.
const usajobsDcSubdivision = usajobsReal.SearchResult.SearchResultItems.flatMap(
  (item) => item.MatchedObjectDescriptor?.PositionLocation ?? [],
).find((loc) => loc.CountrySubDivisionCode === "District of Columbia")?.CountrySubDivisionCode;
if (usajobsDcSubdivision !== "District of Columbia") {
  throw new Error(
    'fixture drift: expected usajobs-real-response.json to contain a PositionLocation with CountrySubDivisionCode "District of Columbia"',
  );
}
const usajobsDcLocationString = `Washington, ${usajobsDcSubdivision}`;

function findLever(fixture: typeof leverPalantir, text: string) {
  const job = fixture.find((j) => j.text === text);
  if (!job) throw new Error(`expected lever fixture to contain "${text}"`);
  return job;
}

function findByTitleOrName<T extends { title?: string; name?: string }>(
  fixture: T[],
  needle: string,
): T {
  const job = fixture.find((j) => (j.title ?? j.name) === needle);
  if (!job) throw new Error(`expected fixture to contain "${needle}"`);
  return job;
}

// The Lever "Seattle, WA" / hybrid pairing (outreach fixture) is used below
// as a fixed, real, always-passing location for every title-filter case —
// PNW passes regardless of work arrangement (see the geography section),
// so holding it constant isolates the title regex without inventing a
// location string.
const seattleHybrid = findLever(
  leverOutreach,
  "Director, Product Management – Conversational Intelligence",
);
if (
  seattleHybrid.categories?.location !== "Seattle, WA" ||
  seattleHybrid.workplaceType !== "hybrid"
) {
  throw new Error("fixture drift: expected outreach's Director posting to be Seattle, WA / hybrid");
}

function job(
  overrides: Partial<NormalizedJob> & { title: string; company: string },
): NormalizedJob {
  return {
    externalId: "test-id",
    dataSource: "lever",
    description: "",
    linkToApply: "https://example.com",
    postedAt: new Date("2026-01-01"),
    location: "Seattle, WA",
    locationType: "hybrid",
    ...overrides,
  };
}

describe("filterSoftwareEngineeringJobs — title filter", () => {
  it("keeps a genuine software engineering title (lever-real-response-palantir.json)", () => {
    const result = filterSoftwareEngineeringJobs([
      job({ title: "Backend Software Engineer - Defense", company: "palantir" }),
    ]);
    expect(result).toHaveLength(1);
  });

  it("drops a software-engineer title that also matches an ML exclusion (lever-real-response-matchgroup.json)", () => {
    const real =
      "Senior Software Engineer, Machine Learning Infrastructure (Tinder LLC, West Hollywood, California)";
    expect(leverMatchgroup.some((j) => j.text === real)).toBe(true);
    const result = filterSoftwareEngineeringJobs([job({ title: real, company: "matchgroup" })]);
    expect(result).toHaveLength(0);
  });

  it('FIXED (ticket 06b09cf): "Software Engineer Internship, Android " (real, ashby-real-response-ramp.json) is now caught by the intern exclusion. Previously `\\bintern\\b` required a word boundary immediately after "intern", and "Internship" continues with word characters ("ship"), so this real posting passed the title filter and reached the scorer. The old NOT regex, run against this exact string (verified with `node -e`, 2026-09-02), matches false; the fixed regex matches true — see the module-level comment on `NOT` for the full before/after.', () => {
    const real = "Software Engineer Internship, Android ";
    expect(ashbyRamp.some((j) => j.title === real)).toBe(true);
    const result = filterSoftwareEngineeringJobs([job({ title: real, company: "ramp" })]);
    expect(result).toHaveLength(0);
  });

  it('intern exclusion also catches "Intern", "Interns", and "Internships" (the other suffixed forms named in the ticket, plus the natural plural of "Internship")', () => {
    for (const title of [
      "Software Engineer Intern",
      "Software Engineer Interns",
      "Software Engineer Internships",
    ]) {
      const result = filterSoftwareEngineeringJobs([job({ title, company: "synthetic" })]);
      expect(result, `expected "${title}" to be excluded`).toHaveLength(0);
    }
  });

  it('intern exclusion does NOT wrongly exclude "internal"/"international" (no fixture title in this repo isolates this case -- ashby-real-response-ramp.json\'s "Marketing Media Strategist, International (Contract)" is excluded via the `marketing` alternative regardless, so it cannot prove this guard; verified at the regex level directly instead)', () => {
    expect(matchesTitleExclusion("Software Engineer, Internal Tools")).toBe(false);
    expect(matchesTitleExclusion("Senior Engineer, International Payments")).toBe(false);
    expect(matchesTitleExclusion("Software Engineer, Internally Facing Tools")).toBe(false);
    // End-to-end confirmation that a genuine SWE title containing "Internal"
    // survives the full filter (location held constant at the always-passing
    // Seattle/hybrid pairing).
    const result = filterSoftwareEngineeringJobs([
      job({ title: "Software Engineer, Internal Tools", company: "synthetic" }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('audit finding (ticket 06b09cf): the real fixture title "GTM Recruiter, AMER" (ashby-real-response-notion.json) proves `\\brecruit\\b` also missed "Recruiter" for the identical word-boundary reason as "Internship". Tested against the exported NOT regex directly, not the combined filter, because this title never matched SOFTWARE in the first place (it is not a software-engineering title) — filterSoftwareEngineeringJobs would report it excluded regardless of whether NOT recognizes "Recruiter", so it cannot prove the fix on its own.', () => {
    expect(ashbyNotion.some((j) => j.title === "GTM Recruiter, AMER")).toBe(true);
    expect(matchesTitleExclusion("GTM Recruiter, AMER")).toBe(true);
  });

  it('real fixture "Deployment Strategist, Internship" (lever-real-response-palantir.json) also confirms the intern-exclusion fix on a second source (Lever, not Ashby) -- flagged by review round 1 as evidence the implementer\'s own report cited but the tests never used', () => {
    expect(leverPalantir.some((j) => j.text === "Deployment Strategist, Internship")).toBe(true);
    expect(matchesTitleExclusion("Deployment Strategist, Internship")).toBe(true);
  });

  it("recruit exclusion also catches Recruiting/Recruitment/Recruits (same suffix-boundary class as Recruiter; no fixture instance of these specific forms exists, so verified at the regex level)", () => {
    for (const word of ["Recruiting", "Recruitment", "Recruits", "Recruiter", "Recruiters"]) {
      expect(matchesTitleExclusion(`Software Engineer, ${word} Systems`), word).toBe(true);
    }
  });

  it('drops "Data Engineer" — real title, does not match the SOFTWARE regex at all (greenhouse-real-response-discord.json)', () => {
    expect(greenhouseDiscord.some((j) => j.title === "Data Engineer")).toBe(true);
    const result = filterSoftwareEngineeringJobs([
      job({ title: "Data Engineer", company: "discord" }),
    ]);
    expect(result).toHaveLength(0);
  });

  it('drops a recruiter title (real: "GTM Recruiter, AMER")', () => {
    const result = filterSoftwareEngineeringJobs([
      job({ title: "GTM Recruiter, AMER", company: "notion" }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("drops a director title (real: lever-real-response-outreach.json's own posting)", () => {
    const result = filterSoftwareEngineeringJobs([
      job({ title: seattleHybrid.text, company: "outreach" }),
    ]);
    expect(result).toHaveLength(0);
  });

  it("dedupes identical (company, title) pairs", () => {
    const a = job({ title: "Backend Software Engineer - Defense", company: "palantir" });
    const b = job({ title: "Backend Software Engineer - Defense", company: "palantir" });
    expect(filterSoftwareEngineeringJobs([a, b])).toHaveLength(1);
  });
});

describe("filterSoftwareEngineeringJobs — staff/distinguished exclusion (ticket 6b2313a)", () => {
  // Real, LIVE titles (fetched from the actual Greenhouse pool this review
  // ran against, 2026-09-03 -- not committed under __fixtures__/, since that
  // set is a fixed historical snapshot and these are current-pool evidence;
  // quoted verbatim per this ticket's review, which fetched and verified
  // them itself). Real fixture data still backs the false-positive negative
  // controls further down, since no real title anywhere -- fixture or live
  // pool -- exercises that specific case.
  it('excludes "Staff Software Engineer" (real, live: Coinbase/Lyft/Twilio/Fivetran, 2026-09-03) and "Staff Engineer" (real, live: MongoDB) -- both match SOFTWARE (via "software engineer" and "staff engineer" respectively), so this also proves NOT actually removes them, not just that they never matched SOFTWARE', () => {
    for (const title of ["Staff Software Engineer", "Staff Engineer"]) {
      const result = filterSoftwareEngineeringJobs([job({ title, company: "synthetic" })]);
      expect(result, `expected "${title}" to be excluded`).toHaveLength(0);
    }
  });

  it('excludes "Distinguished Engineer, Enterprise Scalability" (real, live: Klaviyo, 2026-09-03 -- one of only 2 "distinguish*" titles in the whole 6,204-posting live pool, neither of which matches SOFTWARE, which is why F2\'s measurement reports 0 real savings from this word; kept anyway per this file\'s NOT comment)', () => {
    expect(matchesTitleExclusion("Distinguished Engineer, Enterprise Scalability")).toBe(true);
  });

  it('does NOT exclude "understaffed" or "Staffing" -- the specific false-positive risk this ticket asked to check for (no "Staffing Coordinator" or similar title exists in any committed fixture or the live pool sampled 2026-09-03; the only real "Staffing" hit anywhere in __fixtures__/ is "USA Staffing Applicant Resource Center", inside description/URL text in usajobs-real-response.json, never a title, and this filter never reads description anyway -- kept as an invented negative control since no real equivalent exists)', () => {
    expect(matchesTitleExclusion("Onsite Support for Understaffed Teams")).toBe(false);
    expect(matchesTitleExclusion("Staffing Coordinator")).toBe(false);
    const result = filterSoftwareEngineeringJobs([
      job({ title: "Software Engineer, Understaffed Team Support", company: "synthetic" }),
    ]);
    expect(result).toHaveLength(1);
  });
});

describe('filterSoftwareEngineeringJobs — F1 fix: "staff" inside a level RANGE is not excluded (ticket 6b2313a, opus review)', () => {
  // All four titles below are real and were confirmed LIVE against the
  // Greenhouse pool on 2026-09-03 -- named directly in the review that
  // required this fix, and re-verified here rather than taken on faith.
  // Before the fix, the bare `\bstaff\b` alternative wrongly excluded every
  // one of these -- each explicitly invites a Senior (non-staff) candidate
  // too, so excluding them was a real, current false positive, not a
  // hypothetical.
  const mongoStaffOrSenior =
    "Security Software Engineer, Infrastructure Security (Staff or Senior)";
  const mongoSeniorOrStaffSre = "Site Reliability Engineer (Senior or Staff), Atlas";
  const mongoMidSeniorOrStaff = "Site Reliability Engineering, Fabric (Mid, Senior, or Staff)";
  const twilioSeniorSlashStaff = "Senior/Staff Applied Research Software Engineer";

  it("does not exclude any of the four real range-list titles", () => {
    for (const title of [
      mongoStaffOrSenior,
      mongoSeniorOrStaffSre,
      mongoMidSeniorOrStaff,
      twilioSeniorSlashStaff,
    ]) {
      expect(matchesTitleExclusion(title), title).toBe(false);
    }
  });

  it('proves the fix end-to-end (not just at the regex level) on the two range-list titles that also match SOFTWARE -- "Security Software Engineer... (Staff or Senior)" (MongoDB) and "Senior/Staff Applied Research Software Engineer" (Twilio), both real and live', () => {
    for (const title of [mongoStaffOrSenior, twilioSeniorSlashStaff]) {
      const result = filterSoftwareEngineeringJobs([job({ title, company: "synthetic" })]);
      expect(result, `expected "${title}" to survive (not be excluded)`).toHaveLength(1);
    }
  });

  it('still excludes a bare "Staff" title with no range marker, even when preceded by a level word that could be mistaken for one -- "Senior Staff Engineer" and "Senior Staff Software Engineer, Core Infrastructure" (both real, live: MongoDB/Robinhood, 2026-09-03) are single specific staff-tier titles, not ranges, and must still be caught', () => {
    for (const title of [
      "Senior Staff Engineer",
      "Senior Staff Software Engineer, Core Infrastructure",
    ]) {
      expect(matchesTitleExclusion(title), title).toBe(true);
    }
  });

  it('does not let the range-marker lookaround be tricked by a word that merely ENDS in "or "/"to " ("for", "into") -- synthetic, since no real title happens to combine this specific trap with "staff"; verifies the lookbehind requires a genuine word-boundary "or"/"to", not just those two letters followed by a space', () => {
    expect(matchesTitleExclusion("Search for Staff Engineers")).toBe(true);
    expect(matchesTitleExclusion("Transition into Staff Role")).toBe(true);
  });
});

describe('filterSoftwareEngineeringJobs — "fellow" dropped from NOT entirely (ticket 6b2313a, opus review F2/F3)', () => {
  it('does NOT exclude "SWE Fellow - Human Frontier Collective (US)" (real, live: Scale AI, 2026-09-03) -- this is an early-career FELLOWSHIP PROGRAM title, not a staff-level role; every real "fellow" match in the live 6,204-posting pool is this same Human Frontier Collective program (13-14 postings as of 2026-09-03, across Finance/Legal/ML/Medical/STEM/SWE tracks and three countries — exact count drifts day to day as the board changes), which is why "fellow" was dropped from NOT rather than kept -- it never matched the ticket\'s own "staff-level titles never clear the score floor" rationale to begin with', () => {
    expect(matchesTitleExclusion("SWE Fellow - Human Frontier Collective (US)")).toBe(false);
  });

  it('does NOT exclude "American Tech Fellowship" (real fixture title: lever-real-response-palantir.json) -- same word-boundary shape as ticket 06b09cf\'s "Internship" miss regardless (no boundary right after "fellow" in "Fellowship"), now doubly moot since "fellow" carries no NOT alternative at all', () => {
    expect(matchesTitleExclusion("American Tech Fellowship")).toBe(false);
  });
});

describe("classifyGeography — real location strings", () => {
  it('classifies "Seattle, WA" (lever outreach) as pnw', () => {
    expect(classifyGeography("Seattle, WA")).toBe("pnw");
  });

  it('classifies "Washington, D.C." (lever palantir) as NOT pnw — the DC trap', () => {
    // Real trap: the OLD `PLACE` regex's bare `washington` match let a
    // Washington-D.C.-onsite posting through as if it were Washington
    // STATE. lever-real-response-palantir.json's "Backend Software
    // Engineer - Defense" is exactly this posting.
    const dcJob = findLever(leverPalantir, "Backend Software Engineer - Defense");
    expect(dcJob.categories?.location).toBe("Washington, D.C.");
    expect(classifyGeography("Washington, D.C.")).not.toBe("pnw");
  });

  it('classifies "Washington, District of Columbia" (real USAJOBS spelling) as NOT pnw — ticket 9cac9a9', () => {
    // Ticket 9cac9a9: the guard added for "Washington, D.C."/"Washington,
    // DC" (above) didn't cover USAJOBS's spelled-out form. Latent (USAJOBS
    // wasn't wired into demo-match.ts when this was found), but would have
    // failed in the worst direction once it was: DC federal jobs presenting
    // as Washington state. `usajobsDcLocationString` is
    // "Washington, District of Columbia" here, built from the real fixture
    // spelling asserted above, not invented.
    expect(usajobsDcLocationString).toBe("Washington, District of Columbia");
    expect(classifyGeography(usajobsDcLocationString)).not.toBe("pnw");
  });

  it('classifies "Washington, DC, United States" (smartrecruiters) as us-wide, not pnw', () => {
    const dcJob = findByTitleOrName(
      smartrecruitersPage2,
      "Workshop Sales Representative - Washington DC Area ",
    );
    expect(dcJob.location.fullLocation).toBe("Washington, DC, United States");
    expect(classifyGeography(dcJob.location.fullLocation)).toBe("us-wide");
  });

  it('classifies bare "United States " (greenhouse airbnb, real trailing space) as us-wide, not pnw', () => {
    const remoteJob = findByTitleOrName(
      greenhouseAirbnb,
      "Associate Principal, Strategic Finance & Analytics",
    );
    expect(remoteJob.location?.name).toBe("United States ");
    expect(classifyGeography("United States ")).toBe("us-wide");
  });

  it('classifies "United States" (lever outreach) as us-wide', () => {
    const usJob = findLever(leverOutreach, "Account Manager, Commercial");
    expect(usJob.categories?.location).toBe("United States");
    expect(classifyGeography("United States")).toBe("us-wide");
  });

  it('classifies real "Remote (Canada)" (ashby ramp secondaryLocations) as unknown — not US at all', () => {
    const withCanada = ashbyRamp.find((j) =>
      (j.secondaryLocations ?? []).some((s) => s.location === "Remote (Canada)"),
    );
    expect(withCanada).toBeDefined();
    expect(classifyGeography("Remote (Canada)")).toBe("unknown");
  });

  it('classifies "Remote - Canada" (as named in the ticket\'s live measurement) as unknown', () => {
    expect(classifyGeography("Remote - Canada")).toBe("unknown");
  });

  it('classifies "Hyderabad" (lever outreach) as unknown', () => {
    expect(classifyGeography("Hyderabad")).toBe("unknown");
  });

  it('classifies "North America" (lever palantir) as unknown — too broad to place', () => {
    const naJob = findLever(leverPalantir, "American Tech Fellowship");
    expect(naJob.categories?.location).toBe("North America");
    expect(classifyGeography("North America")).toBe("unknown");
  });

  it('classifies "London" (ashby ramp) as unknown', () => {
    expect(ashbyRamp.some((j) => j.location === "London")).toBe(true);
    expect(classifyGeography("London")).toBe("unknown");
  });

  it("still classifies genuine WA locations as pnw — regression check for the ticket 9cac9a9 guard widening", () => {
    // None of these are exercised by the new "district of columbia"
    // alternative (only ", WA" or bare "washington" ever match them), but
    // the ticket's own acceptance criteria calls them out by name as
    // locations that must not regress, so asserted directly rather than
    // only implied by the DC-rejection tests above.
    for (const location of [
      "Seattle, WA",
      "Bellevue, WA",
      "Redmond, WA",
      "Kirkland, WA",
      "Spokane, WA",
    ]) {
      expect(classifyGeography(location)).toBe("pnw");
    }
    // Genuine Washington-STATE strings from the real USAJOBS fixture (not
    // D.C. at all) — "Walla Walla, Washington" etc. — must still pass too,
    // since the new lookahead only fires when "washington" is immediately
    // followed by a DC-shaped suffix.
    const waSubdivisions = usajobsReal.SearchResult.SearchResultItems.flatMap(
      (item) => item.MatchedObjectDescriptor?.PositionLocation ?? [],
    ).filter((loc) => loc.CountrySubDivisionCode === "Washington");
    expect(waSubdivisions.length).toBeGreaterThan(0);
    for (const loc of waSubdivisions) {
      expect(loc.LocationName).toBeDefined();
      expect(classifyGeography(loc.LocationName as string)).toBe("pnw");
    }
  });

  it('classifies "Sunnyvale, CA, United States" (smartrecruiters) as us-wide, not pnw', () => {
    const sunnyvale = findByTitleOrName(
      smartrecruitersPage1,
      "AI Research Scientist- World Model ",
    );
    expect(sunnyvale.location.fullLocation).toBe("Sunnyvale, CA, United States");
    expect(classifyGeography(sunnyvale.location.fullLocation)).toBe("us-wide");
  });
});

describe("classifyGeography — multi-location Lever postings (git-bug 894b4ef)", () => {
  // lever-real-response-binance.json's "Account Manager - VIP Clients
  // (APAC)" is exactly the example the ticket itself measured on a live
  // board (categories.location: "South East Asia",
  // categories.allLocations: ["South East Asia", "Taiwan, Taipei", "Hong
  // Kong"]). `itemLocations()` unions and dedupes those (lever.ts), and
  // `normalizeItem` joins the result with "; ". `apacJoined` below builds
  // that same joined string by hand, with a hardcoded "; " literal -- it
  // does NOT call lever.ts's `normalizeItem`/`itemLocations`, so (opus
  // review round 2, finding correcting an earlier false claim here) a
  // change to lever.ts's actual join separator would NOT break this test;
  // it would just silently start testing a stale assumption. The real
  // separator-drift protection -- a test that drives lever.ts's own code
  // and would break if its separator changed -- lives in lever.test.ts's
  // "stores every entry from categories.allLocations on Job.location" test
  // (~line 577), which asserts a real `Job.location` produced by
  // `normalizeItem` itself equals the "; "-joined string verbatim.
  const apacAccountManager = leverBinance.find(
    (j) => j.text === "Account Manager - VIP Clients (APAC)",
  );
  if (!apacAccountManager) {
    throw new Error(
      'expected lever-real-response-binance.json to contain "Account Manager - VIP Clients (APAC)"',
    );
  }
  const apacLocations = Array.from(
    new Set(
      [
        apacAccountManager.categories?.location,
        ...(apacAccountManager.categories?.allLocations ?? []),
      ].filter((l): l is string => typeof l === "string"),
    ),
  );
  const apacJoined = apacLocations.join("; ");

  it("reproduces the ticket's own cited real example verbatim", () => {
    expect(apacJoined).toBe("South East Asia; Taiwan, Taipei; Hong Kong");
  });

  it("negative: none of several real locations is pnw/us-wide, so the joined posting classifies unknown (no coincidental substring match)", () => {
    // None of "South East Asia" / "Taiwan, Taipei" / "Hong Kong" contains
    // "seattle"/"bellevue"/"washington"/",\s*wa"/"united states"/"usa"/a
    // bare "us" token on its own -- verified per-piece below so this test
    // documents *why* the whole thing is unknown, not just that it is.
    for (const piece of apacLocations) {
      expect(classifyGeography(piece)).toBe("unknown");
    }
    expect(classifyGeography(apacJoined)).toBe("unknown");
  });

  it("true positive: one of several locations is a genuine PNW match, the rest are unrelated -- posting classifies pnw", () => {
    // Synthetic (no committed fixture has a multi-location Lever posting
    // where one entry is PNW): built by splicing a real PNW location string
    // -- "Seattle, WA", lever-real-response-outreach.json's "Director,
    // Product Management" posting -- into the middle of the real, unrelated
    // Binance APAC location list above. Every individual location string is
    // real fixture data; only the combination (which real fixture is
    // "unlucky" enough to have) is constructed.
    const withSeattle = [apacLocations[0], "Seattle, WA", apacLocations[1], apacLocations[2]].join(
      "; ",
    );
    expect(withSeattle).toBe("South East Asia; Seattle, WA; Taiwan, Taipei; Hong Kong");
    expect(classifyGeography(withSeattle)).toBe("pnw");
  });

  it("true positive: one of several locations is us-wide (not pnw), the rest unrelated -- posting classifies us-wide", () => {
    // Same construction, using leverOutreach's real "United States" entry
    // instead of a PNW one, to prove the "us-wide" branch of the same "any"
    // logic independently of the "pnw" branch above.
    const usJob = findLever(leverOutreach, "Account Manager, Commercial");
    expect(usJob.categories?.location).toBe("United States");
    const withUnitedStates = [apacLocations[0], usJob.categories?.location, apacLocations[2]].join(
      "; ",
    );
    expect(classifyGeography(withUnitedStates)).toBe("us-wide");
  });

  it('pnw beats us-wide across the list, same precedence as the single-location "Seattle, WA, United States" case', () => {
    const withBoth = ["United States", "Seattle, WA", "North America"].join("; ");
    expect(classifyGeography(withBoth)).toBe("pnw");
  });

  it("splitting happens before testing, not after: a location string containing no separator behaves identically to today (single-location regression check)", () => {
    // The common case (every non-Lever source, and most Lever postings
    // too) has no "; " in `location` at all. `.split("; ")` on a string
    // with no match returns a one-element array, so this must produce
    // exactly the same result as before this ticket's change.
    expect(classifyGeography("Seattle, WA")).toBe("pnw");
    expect(classifyGeography("United States")).toBe("us-wide");
    expect(classifyGeography("Hyderabad")).toBe("unknown");
  });

  it("evaluating the joined string is equivalent to the best-of the per-piece results, for a real cross-fixture pairing", () => {
    // Direct proof that classification is genuinely per-location, not
    // whole-blob: pairs a real DC posting (fails pnw on its own, per the
    // dedicated DC-trap test above) with a real Seattle posting. If the
    // joined blob were tested as one string with the DC lookahead applied
    // globally rather than per-piece, this specific pairing wouldn't
    // demonstrate anything new -- the point is that the result is driven by
    // the Seattle piece regardless of what the DC piece contributes, exactly
    // as it would if the two were evaluated fully independently.
    const dcJob = findLever(leverPalantir, "Backend Software Engineer - Defense");
    const joined = [dcJob.categories?.location, "Seattle, WA"].join("; ");
    expect(classifyGeography(dcJob.categories?.location ?? "")).not.toBe("pnw");
    expect(classifyGeography("Seattle, WA")).toBe("pnw");
    expect(classifyGeography(joined)).toBe("pnw");
  });
});

describe("resolveWorkArrangement — structured locationType wins over text", () => {
  it("uses locationType when present, even if the text says something else", () => {
    // Real: ashby-real-response-ramp.json's first posting has "Remote (US)"
    // embedded in its location text but a structured workplaceType of
    // "Hybrid" — structured beats substring.
    expect(resolveWorkArrangement("New York, NY (HQ); Remote (US)", "hybrid")).toBe("hybrid");
  });

  it('falls back to text matching ("remote") when locationType is absent', () => {
    expect(resolveWorkArrangement("Remote U.S.", undefined)).toBe("remote");
  });

  it("falls back to unknown when locationType is absent and there is no remote text", () => {
    // Real: greenhouse-real-response-discord.json postings have no
    // "Workplace Type" metadata at all (see greenhouse.test.ts).
    expect(resolveWorkArrangement("San Francisco Bay Area", undefined)).toBe("unknown");
  });
});

describe("passesLocationFilter — geography and work arrangement recombined", () => {
  it("PNW passes regardless of work arrangement (real string: Seattle, WA)", () => {
    for (const locationType of ["remote", "hybrid", "onsite", undefined] as const) {
      expect(passesLocationFilter({ location: "Seattle, WA", locationType })).toBe(true);
    }
  });

  it("Washington, D.C. onsite (real: lever palantir) is rejected — the headline fix", () => {
    expect(passesLocationFilter({ location: "Washington, D.C.", locationType: "onsite" })).toBe(
      false,
    );
  });

  it('"Washington, District of Columbia" (real USAJOBS spelling) is rejected regardless of work arrangement — ticket 9cac9a9', () => {
    // classifyGeography already returns "unknown" for this string (not
    // "us-wide" — plain "District of Columbia" carries no US_WIDE token),
    // so it's rejected at the geography check before work arrangement is
    // ever consulted. Checked across arrangements anyway, matching the
    // style of the Seattle/D.C. cases above, so a future PNW/US_WIDE change
    // can't accidentally start passing this through some other branch.
    for (const locationType of ["remote", "hybrid", "onsite", undefined] as const) {
      expect(passesLocationFilter({ location: usajobsDcLocationString, locationType })).toBe(false);
    }
  });

  it("us-wide + remote passes (real: smartrecruiters Washington DC posting is genuinely remote)", () => {
    const dcRemote = findByTitleOrName(
      smartrecruitersPage2,
      "Workshop Sales Representative - Washington DC Area ",
    );
    expect(dcRemote.location.remote).toBe(true);
    expect(
      passesLocationFilter({ location: dcRemote.location.fullLocation, locationType: "remote" }),
    ).toBe(true);
  });

  it("us-wide + hybrid/onsite/unknown does NOT pass — the same real string, other arrangements", () => {
    const dcJob = findByTitleOrName(
      smartrecruitersPage2,
      "Workshop Sales Representative - Washington DC Area ",
    );
    for (const locationType of ["hybrid", "onsite", undefined] as const) {
      expect(passesLocationFilter({ location: dcJob.location.fullLocation, locationType })).toBe(
        false,
      );
    }
  });

  it('"Remote U.S." (as named in the ticket\'s live measurement, 13 real Ashby postings) passes', () => {
    expect(passesLocationFilter({ location: "Remote U.S.", locationType: "remote" })).toBe(true);
    // Also passes via the text fallback alone, for a source that never
    // supplies locationType at all.
    expect(passesLocationFilter({ location: "Remote U.S.", locationType: undefined })).toBe(true);
  });

  it('"Remote - Canada" (as named in the ticket) does NOT pass', () => {
    expect(passesLocationFilter({ location: "Remote - Canada", locationType: "remote" })).toBe(
      false,
    );
  });

  it('real Ashby composite location with embedded "Remote (US)" text still fails when the REAL locationType is hybrid', () => {
    // ashby-real-response-ramp.json's first posting: location field is the
    // join of `location` + every `secondaryLocations[].location`
    // (ashby.ts's own `itemLocations`), landing "Remote (US)" inside a
    // larger string whose real workplaceType is "Hybrid", not "Remote".
    // This is THE proof that structured data, not a substring match on the
    // tempting "Remote (US)" text, drives the outcome.
    const posting = ashbyRamp[0];
    if (!posting) throw new Error("expected ashby ramp fixture to have a first posting");
    expect(posting.workplaceType).toBe("Hybrid");
    const secondaryLocations = (posting.secondaryLocations ?? [])
      .map((s) => s.location)
      .filter((l): l is string => Boolean(l));
    expect(secondaryLocations).toContain("Remote (US)");
    const location = [posting.location, ...secondaryLocations].filter(Boolean).join("; ");
    expect(passesLocationFilter({ location, locationType: "hybrid" })).toBe(false);
  });

  it("bare 'United States' with NO locationType does not blanket-pass (real string, locationType stripped to simulate a source without it)", () => {
    // Real string: greenhouse-real-response-airbnb.json's "Associate
    // Principal" posting is "United States " with a REAL locationType of
    // "remote" (Airbnb's Workplace Type metadata). Stripping the
    // locationType to `undefined` simulates a board like Discord's, which
    // has no Workplace Type metadata at all — the exact trap named in the
    // ticket's acceptance criteria.
    expect(passesLocationFilter({ location: "United States ", locationType: undefined })).toBe(
      false,
    );
  });

  it("bare 'United States' + real remote locationType (airbnb) passes", () => {
    const remoteJob = findByTitleOrName(
      greenhouseAirbnb,
      "Associate Principal, Strategic Finance & Analytics",
    );
    const workplaceType = remoteJob.metadata?.find((m) => m.name === "Workplace Type")?.value;
    expect(workplaceType).toBe("Remote");
    expect(passesLocationFilter({ location: "United States ", locationType: "remote" })).toBe(true);
  });

  it("real onsite-in-New-York/LA posting (airbnb) with 'United States' in the text does not pass", () => {
    const onsiteJob = findByTitleOrName(greenhouseAirbnb, "AMER Gathering Programs Manager");
    expect(onsiteJob.location?.name).toBe("New York, United States, Los Angeles, United States");
    const workplaceType = onsiteJob.metadata?.find((m) => m.name === "Workplace Type")?.value;
    expect(workplaceType).toBe("Onsite");
    expect(
      passesLocationFilter({
        location: "New York, United States, Los Angeles, United States",
        locationType: "onsite",
      }),
    ).toBe(false);
  });

  it("real onsite-in-Michigan posting (smartrecruiters) does not pass", () => {
    const plymouth = findByTitleOrName(
      smartrecruitersPage2,
      "Calibration Engineer - Brake Controls",
    );
    expect(plymouth.location.fullLocation).toBe("Plymouth, MI, United States");
    expect(plymouth.location.remote).toBe(false);
    expect(plymouth.location.hybrid).toBe(false);
    expect(
      passesLocationFilter({ location: plymouth.location.fullLocation, locationType: "onsite" }),
    ).toBe(false);
  });

  it("real remote-but-non-US posting (smartrecruiters, Barcelona) does not pass", () => {
    const barcelona = findByTitleOrName(
      smartrecruitersPage1,
      "Customer Care Agent - Leasing company AYV-German market",
    );
    expect(barcelona.location.fullLocation).toBe("Barcelona, CT, Spain");
    expect(barcelona.location.remote).toBe(true);
    expect(
      passesLocationFilter({ location: barcelona.location.fullLocation, locationType: "remote" }),
    ).toBe(false);
  });

  it("real hybrid-outside-PNW posting (smartrecruiters, Sunnyvale) does not pass", () => {
    const sunnyvale = findByTitleOrName(
      smartrecruitersPage1,
      "AI Research Scientist- World Model ",
    );
    expect(sunnyvale.location.fullLocation).toBe("Sunnyvale, CA, United States");
    expect(sunnyvale.location.hybrid).toBe(true);
    expect(
      passesLocationFilter({ location: sunnyvale.location.fullLocation, locationType: "hybrid" }),
    ).toBe(false);
  });

  it("a location with no location string at all does not pass", () => {
    expect(passesLocationFilter({ location: undefined, locationType: undefined })).toBe(false);
  });
});

describe("passesLocationFilter — multi-location Lever postings, and the geography-vs-arrangement design decision (git-bug 894b4ef)", () => {
  it("a real multi-location posting with none of its locations pnw/us-wide does not pass, any work arrangement", () => {
    const apacAccountManager = leverBinance.find(
      (j) => j.text === "Account Manager - VIP Clients (APAC)",
    );
    if (!apacAccountManager) throw new Error("fixture drift: expected Binance APAC posting");
    const joined = [
      apacAccountManager.categories?.location,
      ...(apacAccountManager.categories?.allLocations ?? []),
    ]
      .filter((l): l is string => typeof l === "string")
      .filter((l, i, arr) => arr.indexOf(l) === i)
      .join("; ");
    expect(joined).toBe("South East Asia; Taiwan, Taipei; Hong Kong");
    for (const locationType of ["remote", "hybrid", "onsite", undefined] as const) {
      expect(passesLocationFilter({ location: joined, locationType })).toBe(false);
    }
  });

  it("pnw among several locations passes regardless of work arrangement (synthetic list, real PNW + real unrelated pieces)", () => {
    const joined = "South East Asia; Seattle, WA; Hong Kong";
    for (const locationType of ["remote", "hybrid", "onsite", undefined] as const) {
      expect(passesLocationFilter({ location: joined, locationType })).toBe(true);
    }
  });

  it('DESIGN DECISION, REVISED (opus review round 2, finding 3): us-wide among several locations still requires a REMOTE signal that belongs to that same piece -- "any location passes" does not let a remote signal from one location answer a different location\'s arrangement question', () => {
    // Geography's "any" is per-location (classifyGeography above already
    // proves this joined string is "us-wide" because ONE of its three
    // locations is "United States"). When `locationType` is a structured
    // value, it's one field for the whole posting, so it's checked once
    // against the whole job -- the three defined-`locationType` cases below
    // are unchanged from before this fix. When `locationType` is absent,
    // though, there is no whole-job signal to check: the fix resolves
    // arrangement per piece too, and "United States" (its own piece, no
    // "remote" text of its own) correctly still does not pass -- for a
    // per-piece reason now, not a whole-blob one. See the dedicated
    // "leaked remote signal" describe block below for the case that
    // actually distinguishes the old (broken) and new (fixed) logic: a
    // DIFFERENT piece in the list saying "remote".
    const joined = "South East Asia; United States; Hong Kong";
    expect(passesLocationFilter({ location: joined, locationType: "remote" })).toBe(true);
    expect(passesLocationFilter({ location: joined, locationType: "onsite" })).toBe(false);
    expect(passesLocationFilter({ location: joined, locationType: "hybrid" })).toBe(false);
    expect(passesLocationFilter({ location: joined, locationType: undefined })).toBe(false);
  });
});

describe('passesLocationFilter — per-piece arrangement resolution when locationType is absent (opus review round 2, finding 3: a "remote" signal from one location must not leak into a DIFFERENT location\'s geography match)', () => {
  it('BUG (now FIXED): "United States; Remote - Singapore" with no locationType must NOT pass -- "United States" alone, unqualified by its own arrangement text, must not pass just because a DIFFERENT location in the list happens to say "remote"', () => {
    // The reviewer's own concrete failing scenario against the pre-fix
    // code: classifyGeography correctly calls this "us-wide" (from the
    // "United States" piece), but the OLD whole-blob REMOTE_TEXT scan also
    // matched "remote" from the unrelated "Remote - Singapore" piece, so
    // the job wrongly passed. Confirmed independently:
    expect(classifyGeography("United States; Remote - Singapore")).toBe("us-wide");
    expect(
      passesLocationFilter({
        location: "United States; Remote - Singapore",
        locationType: undefined,
      }),
    ).toBe(false);
  });

  it('"Seattle, WA; Remote - Singapore" with no locationType still passes -- PNW passes regardless of arrangement, unaffected by the fix', () => {
    expect(
      passesLocationFilter({
        location: "Seattle, WA; Remote - Singapore",
        locationType: undefined,
      }),
    ).toBe(true);
  });

  it('"Remote - United States" alone (single location -- "remote" and "united states" in the SAME piece) with no locationType still passes -- the correct, non-buggy single-location case the existing logic already handled, confirmed unbroken by the restructure', () => {
    expect(
      passesLocationFilter({ location: "Remote - United States", locationType: undefined }),
    ).toBe(true);
  });

  it('a structured locationType applies as a WHOLE-JOB value, not per-location, even with multi-location text -- "Singapore; United States" onsite behaves identically to before this fix (still fails: onsite, not remote)', () => {
    expect(
      passesLocationFilter({ location: "Singapore; United States", locationType: "onsite" }),
    ).toBe(false);
    // And the mirror case: the same multi-location text with a structured
    // "remote" locationType passes, exactly as any other us-wide + remote
    // posting would -- the structured value is not accidentally re-scoped
    // to only the location piece it happens to sit next to.
    expect(
      passesLocationFilter({ location: "Singapore; United States", locationType: "remote" }),
    ).toBe(true);
  });
});

describe("filterSoftwareEngineeringJobs — end-to-end on real (title, location, locationType) combinations", () => {
  it("keeps a real onsite Seattle-area posting title paired with its own real hybrid Seattle location", () => {
    // Real full pairing from lever-real-response-outreach.json is a
    // Director title (excluded by NOT), so this substitutes a genuine SWE
    // title to prove the pipeline keeps a PNW hybrid posting end to end.
    // The location + locationType pair is exactly this fixture's real
    // record, unmodified.
    const result = filterSoftwareEngineeringJobs([
      job({
        title: "Backend Software Engineer - Defense",
        company: "outreach-seattle",
        location: seattleHybrid.categories?.location,
        locationType: seattleHybrid.workplaceType as NormalizedJob["locationType"],
      }),
    ]);
    expect(result).toHaveLength(1);
  });

  it("drops the real Washington-D.C.-onsite Palantir posting end to end (title passes, geography correctly fails)", () => {
    const dcJob = findLever(leverPalantir, "Backend Software Engineer - Defense");
    const result = filterSoftwareEngineeringJobs([
      job({
        title: dcJob.text,
        company: "palantir",
        location: dcJob.categories?.location,
        locationType: dcJob.workplaceType as NormalizedJob["locationType"],
      }),
    ]);
    expect(result).toHaveLength(0);
  });
});
