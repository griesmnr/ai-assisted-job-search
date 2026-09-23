import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AuthFailedError,
  ForbiddenError,
  MalformedResponseError,
  RateLimitedError,
  TransientSourceError,
  UnexpectedStatusError,
} from "./types.js";
import { RecruiteeSource, createRecruiteeSourceFromEnv } from "./recruitee.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Recruitee Careers Site API responses
// (`GET https://{company}.recruitee.com/api/offers/`), each trimmed down to
// a handful of real records (fields untouched — nothing stripped out of a
// kept posting beyond which postings were kept) — see
// __fixtures__/recruitee-real-response-nmbrs.json (all 8 real postings, the
// board's entire real response, unmodified),
// __fixtures__/recruitee-real-response-channable.json,
// __fixtures__/recruitee-real-response-bunq.json,
// __fixtures__/recruitee-real-response-topicsoftwaredevelopment.json, and
// __fixtures__/recruitee-real-response-tellent.json (a real, verbatim
// zero-postings response, `{"offers":[]}`) — and recruitee.ts's top-of-file
// comment for how these were captured, verified, and cross-checked before
// any mapping was written.
//
// nmbrs's 8 were kept in full (small board, no trimming needed) — used for
// the N-postings-in/N-jobs-out assertion. Channable's 3 were chosen to span:
// `location: "Remote job"` (a non-place display string) alongside a
// `locations[]` entry naming a real city the display string never mentions
// (2694685); a real Salary component with a `period` of `"year"` and one
// with `"month"` (2694685, 2548164/2622523); and real deep technical skills
// text ("mypy", "GCS", "Sentry", "Grafana") living in the `description`
// field while `requirements` on that SAME posting carries unrelated
// company/culture copy (2548164) — proof that field NAMES don't reliably
// predict which field holds the content that matters. Bunq's 4 were chosen
// to span: a posting whose `locations[]` names THREE places (Amsterdam,
// İstanbul, Sofia) while its singular `location` names only one (2642872);
// two real postings with BOTH `hybrid: true` AND `on_site: true`
// simultaneously — genuinely ambiguous real data, not a hand-crafted edge
// case (2071367, 2736989); and a real `employment_type_code: "internship"`
// posting (2736989). TOPIC Software Development's 2 were chosen because one
// (2713866) has real content in `highlight` present in NEITHER
// `description` NOR `requirements` — the sibling-field-drop bug this
// project's history says to go looking for.
//
// Never hand-build a fixture for the success/skip paths below — derive from
// these files, the same discipline this project's USAJOBS adapter had to be
// rebuilt to follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RecruiteeFixture = { offers: any[] };

function loadFixture(name: string): RecruiteeFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as RecruiteeFixture;
}

const nmbrsFixture = loadFixture("recruitee-real-response-nmbrs.json");
const channableFixture = loadFixture("recruitee-real-response-channable.json");
const bunqFixture = loadFixture("recruitee-real-response-bunq.json");
const topicFixture = loadFixture("recruitee-real-response-topicsoftwaredevelopment.json");
const tellentFixture = loadFixture("recruitee-real-response-tellent.json");

if (nmbrsFixture.offers.length !== 8) {
  throw new Error(
    `expected the nmbrs fixture to have 8 postings, got ${nmbrsFixture.offers.length}`,
  );
}
if (channableFixture.offers.length !== 3) {
  throw new Error(
    `expected the channable fixture to have 3 postings, got ${channableFixture.offers.length}`,
  );
}
if (bunqFixture.offers.length !== 4) {
  throw new Error(`expected the bunq fixture to have 4 postings, got ${bunqFixture.offers.length}`);
}
if (topicFixture.offers.length !== 2) {
  throw new Error(
    `expected the topic fixture to have 2 postings, got ${topicFixture.offers.length}`,
  );
}
if (tellentFixture.offers.length !== 0) {
  throw new Error(
    `expected the tellent fixture (a real, legitimate empty tenant) to have 0 postings, got ${tellentFixture.offers.length}`,
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Maps company subdomain -> canned Response, so tests can mock a
 * multi-company search() by name rather than by call order. */
function fetchByCompany(responses: Record<string, () => Response>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const match = /^([^.]+)\.recruitee\.com$/.exec(url.hostname);
    const company = match?.[1];
    const responder = company ? responses[company] : undefined;
    if (!responder) {
      throw new Error(`test fetch stub: no mocked response for URL ${url.toString()}`);
    }
    return responder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, companies: string[] = ["nmbrs"]) {
  return new RecruiteeSource({ companies, fetchImpl });
}

/** A structurally-complete-but-otherwise-blank offer, for tests that need to
 * isolate one field's behavior without a real fixture's unrelated fields
 * getting in the way. Module-scoped so every describe block below can use
 * it. */
function makeMinimalOffer(overrides: Record<string, unknown>) {
  return {
    id: 9_999_999,
    title: "Some Role",
    company_name: "Acme",
    careers_apply_url: "https://acme.recruitee.com/o/some-role/c/new",
    description: "Do the work.",
    published_at: "2026-01-15 00:00:00 UTC",
    ...overrides,
  };
}

function findJob<T extends { externalId: string }>(jobs: T[], id: number): T {
  const job = jobs.find((j) => j.externalId === String(id));
  if (!job) throw new Error(`expected fixture job ${id} to be present`);
  return job;
}

describe("RecruiteeSource — mapping against real captured responses", () => {
  it("returns a non-empty jobs array for a real response", async () => {
    const fetchImpl = fetchByCompany({ nmbrs: () => jsonResponse(nmbrsFixture) });
    const source = makeSource(fetchImpl, ["nmbrs"]);

    const { jobs } = await source.search({});

    expect(jobs.length).toBeGreaterThan(0);
  });

  it("skipRate is not 1.0 for a real response", async () => {
    const fetchImpl = fetchByCompany({ nmbrs: () => jsonResponse(nmbrsFixture) });
    const source = makeSource(fetchImpl, ["nmbrs"]);

    const { skipRate } = await source.search({});

    expect(skipRate).not.toBe(1);
  });

  it("maps every real record from the fixture into jobs, none skipped — N postings in, N jobs out", async () => {
    const fetchImpl = fetchByCompany({ nmbrs: () => jsonResponse(nmbrsFixture) });
    const source = makeSource(fetchImpl, ["nmbrs"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    // nmbrs's fixture is the board's entire real response, unmodified — all
    // 8 real postings are structurally well-formed; none is expected to be
    // unmappable.
    expect(jobs).toHaveLength(8);
  });

  it("maps every real record across TWO companies into jobs, none skipped — combined N-in-N-out", async () => {
    const fetchImpl = fetchByCompany({
      channable: () => jsonResponse(channableFixture),
      bunq: () => jsonResponse(bunqFixture),
    });
    const source = makeSource(fetchImpl, ["channable", "bunq"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    // 3 real channable postings + 4 real bunq postings = 7 jobs.
    expect(jobs).toHaveLength(7);
  });

  it("sets company from company_name, not the configured subdomain", async () => {
    const fetchImpl = fetchByCompany({ nmbrs: () => jsonResponse(nmbrsFixture) });
    const source = makeSource(fetchImpl, ["nmbrs"]);

    const { jobs } = await source.search({});

    expect(jobs).toHaveLength(8);
    for (const job of jobs) {
      expect(job.company).toBe("Nmbrs BV");
    }
  });

  it("real technical skills text survives into description even though it lives in 'description', not 'requirements' — proves both fields must be read, not just the one named 'requirements'", async () => {
    // This is the content test this project's history says to be
    // suspicious of: it must fail if a mapper only captures the field whose
    // NAME sounds like "the requirements", exactly Lever round 1's bug ("the
    // one content assertion checked a marketing sentence, so it passed
    // BECAUSE the requirements were missing"), wearing a field-choice
    // disguise instead of a section-choice one. Real Channable posting
    // 2548164's `requirements` field carries company/culture copy ("The
    // team: Google team focuses on Google marketing integrations...");
    // its REAL engineering-skills text lives entirely in `description`
    // instead. See this file's companion demonstration (below, in this
    // describe block) proving this exact assertion fails against a stub
    // that reads only `requirements` — a plausible-looking simplification a
    // future refactor could make without any test here catching it, if this
    // test didn't exist.
    const fetchImpl = fetchByCompany({ channable: () => jsonResponse(channableFixture) });
    const source = makeSource(fetchImpl, ["channable"]);

    const { jobs } = await source.search({});
    const job = findJob(jobs, 2548164);

    // Company/culture copy, from `requirements`.
    expect(job.description).toContain("Google marketing integrations");
    // Real deep engineering-skills text, from `description` — NOT present
    // anywhere in `requirements`.
    expect(job.description).toContain("strictly typed Python");
    expect(job.description).toContain("mypy");
    expect(job.description).toContain("Sentry, Grafana, Redis");
  });

  it("FAILS against a stub that reads only 'requirements' — demonstrating the test above actually exercises real coverage, not a tautology", async () => {
    // Direct demonstration (not just an assertion) that the test above is
    // load-bearing: reimplement Recruitee's real requirements/description
    // split using ONLY the `requirements` field (the plausible "simplify to
    // one field" mistake), and confirm real content this adapter's own test
    // suite depends on is genuinely absent from it. If this ever stops
    // being true (Recruitee changes its data model), the test above would
    // no longer be proving anything either, and this one is the tripwire.
    const requirementsOnly = (
      channableFixture.offers.find((o) => o.id === 2548164) as {
        requirements: string;
      }
    ).requirements;

    expect(requirementsOnly).not.toContain("strictly typed Python");
    expect(requirementsOnly).not.toContain("mypy");
    expect(requirementsOnly).not.toContain("Sentry, Grafana, Redis");
  });

  it("folds highlight's unique content into description — content present in NEITHER description NOR requirements", async () => {
    // Real TOPIC Software Development posting 2713866: `highlight` states
    // "Technically challenging projects, personal development, teamwork,
    // software design & development, innovation, high-tech, permanent
    // contract, hybrid working." — verified (this file's own
    // fixture-loading section, and recruitee.ts Finding 5) that the phrase
    // "Technically challenging projects" specifically is absent from BOTH
    // `description` and `requirements` on this same posting (unlike
    // "hybrid working" later in the same sentence, which coincidentally
    // also appears in `requirements`' own "flexible hours, and hybrid
    // working" — picked this phrase precisely BECAUSE it has no such
    // overlap). A two-field mapper (description + requirements only, the
    // shape every other adapter in this project's history has needed)
    // would silently drop it — exactly SmartRecruiters'
    // additionalInformation miss wearing a third-field disguise.
    const fetchImpl = fetchByCompany({ topic: () => jsonResponse(topicFixture) });
    const source = makeSource(fetchImpl, ["topic"]);

    const { jobs } = await source.search({});
    const job = findJob(jobs, 2713866);

    expect(job.description).toContain("Technically challenging projects");
    // Sanity: description AND requirements content also present (this is a
    // union, not a highlight-only replacement).
    expect(job.description).toContain("Senior Software Engineer");
    expect(job.description).toContain("At least 5 years of experience");
  });

  it("FAILS against a stub that reads only description+requirements (drops highlight) — demonstrating real, unique highlight content", async () => {
    const offer = topicFixture.offers.find((o) => o.id === 2713866) as {
      description: string;
      requirements: string;
    };
    const descriptionAndRequirementsOnly = `${offer.description}\n\n${offer.requirements}`;

    expect(descriptionAndRequirementsOnly).not.toContain("Technically challenging projects");
  });

  it("decodes a real literal escaped '&gt;' in body text correctly end-to-end, without corrupting adjacent real markup", async () => {
    // Real Vitestro posting 2708084's requirements field contains, as
    // ordinary prose right next to real unescaped tags the encoder never
    // touched: "&gt;5 years working experience in design &amp; development
    // of mechatronic devices" (verified live, 2026-09-23 — see recruitee.ts
    // Finding 9). Reproduced verbatim here as a synthetic record (not worth
    // a whole extra fixture file for one field's encoding proof, same
    // judgment call Ashby's forced-fallback test makes). Under the correct
    // (single-encoded) pipeline this decodes to a literal ">5 years..."
    // with nothing else disturbed; under the wrong (double-encoded,
    // Greenhouse-style) pipeline, pre-decoding "&gt;" would turn it into a
    // stray ">" with no special meaning to a tag-stripper (unlike "&lt;",
    // which WOULD be mistaken for a tag start) — so this specific case
    // mainly proves entities decode correctly at all, not direction.
    const offer = makeMinimalOffer({
      id: 1234,
      requirements:
        "<p><strong>What You’ll Bring:</strong></p><ul><li><p>&gt;5 years working experience in design &amp; development of mechatronic devices</p></li></ul>",
    });
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ offers: [offer] }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.description).toContain(
      ">5 years working experience in design & development of mechatronic devices",
    );
    expect(jobs[0]?.description).not.toContain("&gt;");
    expect(jobs[0]?.description).not.toContain("&amp;");
    expect(jobs[0]?.description).not.toContain("<li>");
    expect(jobs[0]?.description).not.toContain("<p>");
  });

  it("stores the union of location and every locations[] entry on Job.location, not just the one representative location", async () => {
    const fetchImpl = fetchByCompany({ bunq: () => jsonResponse(bunqFixture) });
    const source = makeSource(fetchImpl, ["bunq"]);

    const { jobs } = await source.search({});

    // Real fixture: location "Amsterdam, Noord-Holland, Netherlands",
    // locations names Amsterdam, İstanbul, AND Sofia — two of the three
    // never appear in `location` itself.
    const reporting = findJob(jobs, 2642872);
    expect(reporting.location).toBe(
      "Amsterdam, Noord-Holland, Netherlands; İstanbul, İstanbul, Türkiye; Sofia, Sofia (stolitsa), Bulgaria",
    );
  });

  it("location filtering matches a locations[]-only place absent from the singular location field", async () => {
    // Real posting 2745937 ("Fraud Operations Analyst"): `location` says
    // only "İstanbul, İstanbul, Türkiye"; "Sofia" appears ONLY in
    // `locations[]`. A location filter checking only `location` would miss
    // it, the same under-match class of bug Ashby's secondaryLocations fix
    // closes for Ramp's Miami role.
    const fetchImpl = fetchByCompany({ bunq: () => jsonResponse(bunqFixture) });
    const source = makeSource(fetchImpl, ["bunq"]);

    const { jobs, skipped } = await source.search({ location: "Sofia" });

    expect(skipped).toHaveLength(0);
    // Both 2642872 (Amsterdam/İstanbul/Sofia) and 2745937 (İstanbul/Sofia)
    // have a real Sofia entry in `locations[]`.
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["2642872", "2745937"].sort());
  });

  it("location filtering matches the singular location's non-place display text ('Remote job') with no locations[] equivalent", async () => {
    // Real Channable posting 2694685: `location` is the literal string
    // "Remote job" (set because `remote: true`); no entry in `locations[]`
    // ever says "remote" — this match is possible ONLY via the singular
    // `location` field.
    const fetchImpl = fetchByCompany({ channable: () => jsonResponse(channableFixture) });
    const source = makeSource(fetchImpl, ["channable"]);

    const { jobs, skipped } = await source.search({ location: "Remote" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["2694685"]);
  });

  it("location filtering matches a locations[] real place name even though the singular location says 'Remote job'", async () => {
    // The sibling proof: this same posting's `locations[]` names "New York
    // City, New York, United States" — a search for "New York" would return
    // ZERO results if only the singular `location` string ("Remote job")
    // were read.
    const fetchImpl = fetchByCompany({ channable: () => jsonResponse(channableFixture) });
    const source = makeSource(fetchImpl, ["channable"]);

    const { jobs, skipped } = await source.search({ location: "New York" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["2694685"]);
  });

  it("keyword filtering searches the full assembled description, not just the title, so a skill named only deep in description still matches", async () => {
    // "mypy" appears only in real posting 2548164's `description`, in
    // neither its title nor any other configured posting's text.
    const fetchImpl = fetchByCompany({ channable: () => jsonResponse(channableFixture) });
    const source = makeSource(fetchImpl, ["channable"]);

    const { jobs, skipped } = await source.search({ keyword: "mypy" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["2548164"]);
  });

  it("maps commitment from employment_type_code, leaving internship undefined rather than guessed at", async () => {
    const fetchImpl = fetchByCompany({
      channable: () => jsonResponse(channableFixture),
      bunq: () => jsonResponse(bunqFixture),
    });
    const source = makeSource(fetchImpl, ["channable", "bunq"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    expect(findJob(jobs, 2548164).commitment).toBe("full-time"); // fulltime_permanent
    expect(findJob(jobs, 2736989).commitment).toBeUndefined(); // internship
  });

  it("maps locationType from remote/hybrid/on_site, requiring exactly one true — real data with two flags simultaneously true maps to undefined, not guessed", async () => {
    const fetchImpl = fetchByCompany({
      nmbrs: () => jsonResponse(nmbrsFixture),
      channable: () => jsonResponse(channableFixture),
      bunq: () => jsonResponse(bunqFixture),
    });
    const source = makeSource(fetchImpl, ["nmbrs", "channable", "bunq"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    // Real onsite-only posting.
    expect(findJob(jobs, 2727162).locationType).toBe("onsite"); // nmbrs Customer Care Specialist
    // Real remote-only posting.
    expect(findJob(jobs, 2694685).locationType).toBe("remote"); // channable Account Executive
    // Real hybrid-only posting.
    expect(findJob(jobs, 2642872).locationType).toBe("hybrid"); // bunq Reporting Expert
    // Real postings with BOTH hybrid AND on_site true — genuinely ambiguous
    // real data, mapped to undefined rather than picking a winner.
    expect(findJob(jobs, 2071367).locationType).toBeUndefined(); // bunq KYC Analyst
    expect(findJob(jobs, 2736989).locationType).toBeUndefined(); // bunq Copywriting Intern
  });

  it("maps payType from salary.period, independent of whether min/max amounts are disclosed", async () => {
    const fetchImpl = fetchByCompany({
      channable: () => jsonResponse(channableFixture),
      bunq: () => jsonResponse(bunqFixture),
    });
    const source = makeSource(fetchImpl, ["channable", "bunq"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    // period "year", real figures disclosed ($200K-$250K).
    expect(findJob(jobs, 2694685).payType).toBe("salary");
    // period "month", real figures disclosed.
    expect(findJob(jobs, 2548164).payType).toBe("salary");
    // period "month", but min/max BOTH null — comp cadence stated, figure
    // not disclosed. Still "salary", not undefined: period alone is the
    // signal payType asks for.
    expect(findJob(jobs, 2071367).payType).toBe("salary");
    // salary entirely null (period included) — genuinely not stated.
    expect(findJob(jobs, 2642872).payType).toBeUndefined();
  });

  it("maps a salary.period of 'hour' to payType 'hourly' (real value observed on vandebron postings during this adapter's research, not present in the committed fixtures)", async () => {
    // Real vandebron postings (e.g. "Office & Keuken Medewerker", verified
    // live 2026-09-23, not saved as a fixture here) state
    // `{"min":"15.75","period":"hour","currency":"EUR"}`. Reproduced as a
    // synthetic record with the real observed shape, same judgment call as
    // Ashby's untested-but-documented-enum-branch precedent.
    const offer = makeMinimalOffer({
      salary: { min: "15.75", max: null, period: "hour", currency: "EUR" },
    });
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ offers: [offer] }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.payType).toBe("hourly");
  });

  it("maps employment_type_code 'parttime_fixed_term' to commitment 'part-time' (real value observed on vandebron postings during this adapter's research, not present in the committed fixtures)", async () => {
    const offer = makeMinimalOffer({ employment_type_code: "parttime_fixed_term" });
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ offers: [offer] }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.commitment).toBe("part-time");
  });

  it("never reintroduces enum-based skipping: a record with no employment_type_code/remote-hybrid-onsite/salary signal at all is still returned as a job, not skipped", async () => {
    const fetchImpl = fetchByCompany({
      acme: () => jsonResponse({ offers: [makeMinimalOffer({})] }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(skipRate).toBe(0);
    expect(jobs[0]?.payType).toBeUndefined();
    expect(jobs[0]?.commitment).toBeUndefined();
    expect(jobs[0]?.locationType).toBeUndefined();
  });

  it("produces a stable externalId (Recruitee's numeric offer id) across repeated calls, in the same order", async () => {
    const fetchImpl = fetchByCompany({ nmbrs: () => jsonResponse(nmbrsFixture) });
    const source = makeSource(fetchImpl, ["nmbrs"]);

    const first = await source.search({});
    const second = await source.search({});

    const idsFirst = [...first.jobs, ...first.skipped].map((j) => j.externalId);
    const idsSecond = [...second.jobs, ...second.skipped].map((j) => j.externalId);
    expect(idsFirst).toHaveLength(8);
    expect(idsFirst).toEqual(idsSecond);
  });

  it("issues one GET request per configured company, with no credentials required", async () => {
    const fetchImpl = fetchByCompany({
      nmbrs: () => jsonResponse(nmbrsFixture),
      channable: () => jsonResponse(channableFixture),
    });
    const source = makeSource(fetchImpl, ["nmbrs", "channable"]);

    await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [
      string | URL,
      RequestInit,
    ][];
    for (const [, init] of calls) {
      expect(init.method ?? "GET").toBe("GET");
    }
  });
});

describe("RecruiteeSource — nonexistent company vs. a real company with zero openings (must be distinguishable)", () => {
  it("a real company with zero open postings (HTTP 200, {offers: []}) reports skipRate 0 with nothing in skipped", async () => {
    // tellent really returns this shape (verified live, 2026-09-23,
    // Recruitee's own parent company) — a real tenant that currently has
    // nothing open, not an error. Fixture is the byte-verbatim real
    // response.
    const fetchImpl = fetchByCompany({ tellent: () => jsonResponse(tellentFixture) });
    const source = makeSource(fetchImpl, ["tellent"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("a nonexistent company subdomain (HTTP 404) reports skipRate 1 with a skipped entry naming the 404 — distinct from the zero-openings case above", async () => {
    // Real observed body, verified live 2026-09-23:
    // `{"error":"Not Found"}`.
    const fetchImpl = fetchByCompany({
      "this-company-definitely-does-not-exist-12345": () =>
        jsonResponse({ error: "Not Found" }, { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["this-company-definitely-does-not-exist-12345"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.externalId).toBeUndefined();
    expect(skipped[0]?.reason).toMatch(/does not exist/);
    expect(skipped[0]?.reason).toMatch(/404/);
    expect(skipped[0]?.reason).toContain("this-company-definitely-does-not-exist-12345");
  });

  it("a 404 on one company doesn't discard results from healthy companies (per-company failure isolation)", async () => {
    const fetchImpl = fetchByCompany({
      nmbrs: () => jsonResponse(nmbrsFixture),
      "does-not-exist": () => jsonResponse({ error: "Not Found" }, { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "nmbrs"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(8);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/does-not-exist/);
  });
});

describe("RecruiteeSource — structurally broken records (synthetic, not fixture-derived)", () => {
  it("honestly reports a mix of jobs and skips, with reasons naming the real cause", async () => {
    // Real Recruitee records are never structurally broken (verified: every
    // one of the 65+ real postings checked while building this adapter had
    // id, title, company_name, careers_apply_url/careers_url, description
    // content, and published_at), so there's no real fixture that provokes
    // a skip. What's genuinely unmappable is a structurally broken record —
    // handcrafted deliberately, same discipline as ashby.test.ts.
    const brokenOffers = [
      {
        title: "Broken A",
        company_name: "Acme",
        careers_apply_url: "https://x/1",
        description: "hi",
      }, // no id
      {
        id: 2,
        company_name: "Acme",
        careers_apply_url: "https://x/2",
        description: "hi",
        published_at: "2026-01-01",
      }, // no title
      {
        id: 3,
        title: "Broken C",
        careers_apply_url: "https://x/3",
        description: "hi",
        published_at: "2026-01-01",
      }, // no company_name
      {
        id: 4,
        title: "Broken D",
        company_name: "Acme",
        description: "hi",
        published_at: "2026-01-01",
      }, // no careers_apply_url/careers_url
      {
        id: 5,
        title: "Broken E",
        company_name: "Acme",
        careers_apply_url: "https://x/5",
        published_at: "2026-01-01",
      }, // no description
      {
        id: 6,
        title: "Broken F",
        company_name: "Acme",
        careers_apply_url: "https://x/6",
        description: "hi",
        published_at: "not-a-date",
      }, // unparseable published_at
    ];
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ offers: brokenOffers }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(6);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/missing id/);
    expect(skipped[1]?.reason).toMatch(/missing title/);
    expect(skipped[2]?.reason).toMatch(/missing company_name/);
    expect(skipped[3]?.reason).toMatch(/missing careers_apply_url and careers_url/);
    expect(skipped[4]?.reason).toMatch(/missing description content/);
    expect(skipped[5]?.reason).toMatch(/unparseable published_at/);
  });

  it("falls back to careers_url when careers_apply_url is absent", async () => {
    const offer = makeMinimalOffer({
      careers_apply_url: undefined,
      careers_url: "https://acme.recruitee.com/o/some-role",
    });
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ offers: [offer] }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.linkToApply).toBe("https://acme.recruitee.com/o/some-role");
  });
});

describe("RecruiteeSource — error classification", () => {
  it("classifies HTTP 401 as AuthFailedError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({
      acme: () => new Response("Unauthorized", { status: 401 }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).kind).toBe("auth-failed");
    expect((err as AuthFailedError).retryable).toBe(false);
  });

  it("classifies HTTP 403 as ForbiddenError, distinct from AuthFailedError, and retryable", async () => {
    const fetchImpl = fetchByCompany({
      acme: () => new Response("<html>blocked</html>", { status: 403 }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(AuthFailedError);
    expect((err as ForbiddenError).retryable).toBe(true);
  });

  it("classifies HTTP 429 as RateLimitedError (retryable) and reads Retry-After", async () => {
    const fetchImpl = fetchByCompany({
      acme: () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "12" } }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryable).toBe(true);
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000);
  });

  it("classifies HTTP 500/503 as TransientSourceError (retryable)", async () => {
    const fetchImpl = fetchByCompany({
      acme: () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).retryable).toBe(true);
  });

  it("classifies a network failure (fetch rejects) as TransientSourceError", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).cause).toBeInstanceOf(Error);
  });

  it("classifies invalid JSON as MalformedResponseError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({ acme: () => new Response("not json{{{", { status: 200 }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
    expect((err as MalformedResponseError).retryable).toBe(false);
  });

  it("classifies well-formed JSON with an unexpected shape (missing offers array) as MalformedResponseError", async () => {
    const fetchImpl = fetchByCompany({ acme: () => jsonResponse({ notWhatWeExpected: true }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
  });

  it("classifies an unmapped 4xx status (400) as UnexpectedStatusError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({ acme: () => new Response("Bad Request", { status: 400 }) });
    const source = makeSource(fetchImpl, ["acme"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatusError);
    expect((err as UnexpectedStatusError).status).toBe(400);
    expect((err as UnexpectedStatusError).retryable).toBe(false);
  });
});

describe("RecruiteeSource construction", () => {
  it("throws when constructed with an empty companies list", () => {
    expect(() => new RecruiteeSource({ companies: [] })).toThrow(/at least one company subdomain/);
  });
});

describe("createRecruiteeSourceFromEnv", () => {
  it("throws when RECRUITEE_COMPANIES is missing", () => {
    expect(() => createRecruiteeSourceFromEnv({})).toThrow(/RECRUITEE_COMPANIES/);
  });

  it("throws when RECRUITEE_COMPANIES is empty/whitespace", () => {
    expect(() => createRecruiteeSourceFromEnv({ RECRUITEE_COMPANIES: "  , ," })).toThrow(
      /RECRUITEE_COMPANIES/,
    );
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const source = createRecruiteeSourceFromEnv({ RECRUITEE_COMPANIES: " nmbrs, bunq ,channable" });
    expect(source.dataSource).toBe("recruitee");
  });
});
