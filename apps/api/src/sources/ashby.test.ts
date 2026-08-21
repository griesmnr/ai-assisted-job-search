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
import { AshbySource, createAshbySourceFromEnv } from "./ashby.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Ashby Job Board API responses
// (`GET https://api.ashbyhq.com/posting-api/job-board/{boardName}?includeCompensation=true`),
// each trimmed down to a handful of real records (fields untouched — nothing
// stripped out of a kept posting beyond which postings were kept) — see
// __fixtures__/ashby-real-response-ramp.json,
// __fixtures__/ashby-real-response-notion.json, and
// __fixtures__/ashby-real-response-mercury.json (a real, verbatim
// zero-postings response), and ashby.ts's top-of-file comment for how these
// were captured and what was cross-checked before any mapping was written.
//
// Ramp's five were chosen to span: `secondaryLocations` naming places absent
// from `location` (34413f8d — Miami/Remote(Canada)/Remote(US), none of which
// appear in "New York, NY (HQ)"; 94d79eed — San Francisco); a literal escaped
// "&lt;" sitting in ordinary body text right next to real unescaped HTML tags
// (94d79eed, "...in 60 days and &lt;2 calls"); every `employmentType` value
// this ticket's four named boards actually produced except PartTime
// (FullTime, Contract, Intern, Temporary); a multi-tier compensation
// structure with Commission/Equity alongside Salary (94d79eed); a real
// monthly (not annual, not hourly) Salary-typed compensation component
// (67fadb77, a $11.7K/month internship stipend); and a non-USD currency
// (690c661d, GBP). Notion's three were chosen to span: a literal escaped
// "&gt;" in body text (05e14247, "You have &gt; 1 year experience..."); and
// real `workplaceType: null` (f663839e, 5dc7695e — a documented-enum field
// Ashby's own docs don't mention can be null, confirmed as a literal JSON
// null on the key, not an omitted key).
//
// Never hand-build a fixture for the success/skip paths below — derive from
// these files, the same discipline this project's USAJOBS adapter had to be
// rebuilt to follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AshbyFixture = { jobs: any[]; apiVersion: string };

function loadFixture(name: string): AshbyFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as AshbyFixture;
}

const rampFixture = loadFixture("ashby-real-response-ramp.json");
const notionFixture = loadFixture("ashby-real-response-notion.json");
const mercuryFixture = loadFixture("ashby-real-response-mercury.json");

if (rampFixture.jobs.length !== 5) {
  throw new Error(`expected the ramp fixture to have 5 postings, got ${rampFixture.jobs.length}`);
}
if (notionFixture.jobs.length !== 3) {
  throw new Error(
    `expected the notion fixture to have 3 postings, got ${notionFixture.jobs.length}`,
  );
}
if (mercuryFixture.jobs.length !== 0) {
  throw new Error(
    `expected the mercury fixture (a real, legitimate empty board) to have 0 postings, got ${mercuryFixture.jobs.length}`,
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Maps board name -> canned Response, so tests can mock a multi-board
 * search() by name rather than by call order. */
function fetchByBoard(responses: Record<string, () => Response>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const match = /\/job-board\/([^/]+)/.exec(url.pathname);
    const boardName = match?.[1];
    const responder = boardName ? responses[boardName] : undefined;
    if (!responder) {
      throw new Error(`test fetch stub: no mocked response for URL ${url.toString()}`);
    }
    return responder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, boardNames: string[] = ["ramp"]) {
  return new AshbySource({ boardNames, fetchImpl });
}

/** A structurally-complete-but-otherwise-blank posting, for tests that need
 * to isolate one field's behavior without a real fixture's unrelated fields
 * getting in the way. Module-scoped so every describe block below can use
 * it. */
function makeMinimalPosting(overrides: Record<string, unknown>) {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    title: "Some Role",
    applyUrl: "https://jobs.ashbyhq.com/acme/22222222-2222-2222-2222-222222222222/application",
    descriptionPlain: "Do the work.",
    publishedAt: "2026-01-15T00:00:00.000+00:00",
    ...overrides,
  };
}

function findJob<T extends { externalId: string }>(jobs: T[], id: string): T {
  const job = jobs.find((j) => j.externalId === id);
  if (!job) throw new Error(`expected fixture job ${id} to be present`);
  return job;
}

describe("AshbySource — mapping against real captured responses", () => {
  it("returns a non-empty jobs array for a real response", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs } = await source.search({});

    expect(jobs.length).toBeGreaterThan(0);
  });

  it("skipRate is not 1.0 for a real response", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { skipRate } = await source.search({});

    expect(skipRate).not.toBe(1);
  });

  it("maps every real record from both fixtures into jobs, none skipped — N postings in, N jobs out", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      notion: () => jsonResponse(notionFixture),
    });
    const source = makeSource(fetchImpl, ["ramp", "notion"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    // 5 real ramp postings + 3 real notion postings = 8 jobs. Every fixture
    // posting is structurally well-formed real data; none is expected to be
    // unmappable.
    expect(jobs).toHaveLength(8);
  });

  it("sets company to the configured board name, since Ashby's postings carry no company name field", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs } = await source.search({});

    expect(jobs).toHaveLength(5);
    for (const job of jobs) {
      expect(job.company).toBe("ramp");
    }
  });

  it("trims stray leading/trailing whitespace from title (23 of 393 real titles checked 2026-08-21 have it)", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs } = await source.search({});

    // Real fixture value is literally " Security Engineer, Cloud" (leading
    // space) and "Software Engineer Internship, Android " (trailing space).
    const security = findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245");
    expect(security.title).toBe("Security Engineer, Cloud");
    const intern = findJob(jobs, "67fadb77-43d8-4449-954b-d4cf2c6d3b8b");
    expect(intern.title).toBe("Software Engineer Internship, Android");
  });

  it("real requirements/skills text survives into description, not just the marketing intro", async () => {
    // This is the content test this project's history says to be suspicious
    // of: it must fail if a mapper only captures the opening "About <company>"
    // paragraph and drops the requirements section further down — exactly
    // Lever round 1's bug, where "the one content assertion checked a
    // marketing sentence, so it passed BECAUSE the requirements were
    // missing." See this file's companion demonstration (in this ticket's
    // report) proving this exact test fails against a stubbed
    // implementation that only keeps the first section of descriptionPlain.
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs } = await source.search({});
    const job = findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245");

    // Marketing intro, near the top of descriptionPlain.
    expect(job.description).toContain(
      "Ramp is building the smart infrastructure for finance teams",
    );
    // Real requirements bullets, from this exact posting's "WHAT YOU NEED"
    // section, far down descriptionPlain — not present anywhere in the
    // opening paragraphs.
    expect(job.description).toContain("Minimum 5 years of experience building software");
    expect(job.description).toContain(
      "Minimum 3 years of experience building in AWS (with Terraform)",
    );
  });

  it("stores the union of location and every secondaryLocations entry on Job.location, not just the one representative location", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs } = await source.search({});

    // Real fixture: location "New York, NY (HQ)", secondaryLocations
    // ["Remote (Canada)", "Remote (US)", "Miami, FL"] — none of the three
    // secondary entries appear in `location` itself.
    const security = findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245");
    expect(security.location).toBe("New York, NY (HQ); Remote (Canada); Remote (US); Miami, FL");

    // Ordinary no-secondary-locations posting — unaffected.
    const contract = findJob(jobs, "690c661d-7ef7-472c-841b-2e20fb4c5db3");
    expect(contract.location).toBe("London");
  });

  it("location filtering matches against secondaryLocations, not just the single location field", async () => {
    // "Miami, FL" appears in 34413f8d-...'s secondaryLocations but nowhere
    // in its `location` ("New York, NY (HQ)"). A location filter checking
    // only `location` would miss it, the same under-match class of bug
    // Lever's allLocations fix closed for Binance's Taipei roles.
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped } = await source.search({ location: "Miami" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["34413f8d-26bf-4bbc-8ade-eb309a0e2245"]);
  });

  it("keyword filtering searches the full assembled description, not just the title, so a skill named only in the requirements section still matches", async () => {
    // "Terraform" appears in real posting 34413f8d-...'s "WHAT YOU NEED" and
    // "NICE-TO-HAVES" sections, nowhere in the title.
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped } = await source.search({ keyword: "Terraform" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["34413f8d-26bf-4bbc-8ade-eb309a0e2245"]);
  });

  it("decodes a literal escaped '<' in real body text correctly end-to-end when the descriptionHtml fallback fires (synthetic trigger: real fixtures never have an empty descriptionPlain, so this forces the fallback with real descriptionHtml content to prove ashby.ts's own call site passes doubleEncoded: false)", async () => {
    // Real Ramp posting 94d79eed-...'s descriptionHtml contains, as ordinary
    // prose inside a real <li><p> the encoder never touched: "...ensuring
    // they can fully onboard onto Ramp in 60 days and &lt;2 calls". Under
    // the correct (default, single-encoded) pipeline this decodes to a
    // literal "<2 calls" with nothing else disturbed. Under the wrong
    // (double-encoded, Greenhouse-style) pipeline, decoding "&lt;" before
    // stripping tags turns it into a stray "<" that the tag-stripper then
    // treats as a real tag delimiter, silently eating everything up to the
    // next real closing tag — the exact corruption class Lever's N1 finding
    // warns about.
    const source94d79eed = rampFixture.jobs.find(
      (j) => j.id === "94d79eed-34db-42c8-b47c-5edef335b7f2",
    );
    if (!source94d79eed) throw new Error("fixture posting not found");
    const forcedFallback = { ...source94d79eed, descriptionPlain: "" };

    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse({ jobs: [forcedFallback] }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    const job = jobs[0];
    expect(job?.description).toContain(
      "ensuring they can fully onboard onto Ramp in 60 days and <2 calls",
    );
    expect(job?.description).not.toContain("&lt;");
    // Nothing between the decoded operator and the next real bullet was
    // eaten by a mis-stripped stray tag.
    expect(job?.description).toContain("Balance priorities and multiple tasks");
    // HTML-stripped, not raw markup.
    expect(job?.description).not.toContain("<li>");
    expect(job?.description).not.toContain("<p ");
  });

  it("maps commitment from employmentType's documented enum, leaving Intern/Temporary undefined rather than guessed at", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      notion: () => jsonResponse(notionFixture),
    });
    const source = makeSource(fetchImpl, ["ramp", "notion"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    expect(findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245").commitment).toBe("full-time"); // FullTime
    expect(findJob(jobs, "690c661d-7ef7-472c-841b-2e20fb4c5db3").commitment).toBe("contract"); // Contract
    expect(findJob(jobs, "67fadb77-43d8-4449-954b-d4cf2c6d3b8b").commitment).toBeUndefined(); // Intern
    expect(findJob(jobs, "4bc09b14-0389-40cd-9d5b-f5557f451d50").commitment).toBeUndefined(); // Temporary
  });

  it("maps locationType from workplaceType's documented enum, leaving a real null value undefined rather than throwing", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      notion: () => jsonResponse(notionFixture),
    });
    const source = makeSource(fetchImpl, ["ramp", "notion"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    expect(findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245").locationType).toBe("hybrid");
    expect(findJob(jobs, "690c661d-7ef7-472c-841b-2e20fb4c5db3").locationType).toBe("onsite");
    // Real notion postings with workplaceType: null (a literal JSON null,
    // not a missing key).
    expect(findJob(jobs, "f663839e-46ac-44ad-9720-da2b6aa28093").locationType).toBeUndefined();
    expect(findJob(jobs, "5dc7695e-139e-4679-a213-a733ee1d62d5").locationType).toBeUndefined();
  });

  it("maps payType from compensation.compensationTiers (only present because search() requests includeCompensation=true), preferring the Salary-typed component over Equity/Commission", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      notion: () => jsonResponse(notionFixture),
    });
    const source = makeSource(fetchImpl, ["ramp", "notion"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    // $211.4K-$290.6K, interval "1 YEAR", alongside an EquityPercentage
    // component — Salary must win.
    expect(findJob(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245").payType).toBe("salary");
    // GBP Salary + EquityCashValue, interval "1 YEAR".
    expect(findJob(jobs, "690c661d-7ef7-472c-841b-2e20fb4c5db3").payType).toBe("salary");
    // Multi-tier: Salary alongside Commission/EquityCashValue in both tiers.
    expect(findJob(jobs, "94d79eed-34db-42c8-b47c-5edef335b7f2").payType).toBe("salary");
    // A real Salary component with interval "1 MONTH" (an internship's
    // monthly stipend, $11.7K/month) — still "salary", not "hourly": a
    // monthly-paid stipend is not an hourly wage.
    expect(findJob(jobs, "67fadb77-43d8-4449-954b-d4cf2c6d3b8b").payType).toBe("salary");
    // Real postings where `compensation` is present (includeCompensation:
    // true was sent) but `compensationTiers` is empty — comp genuinely not
    // disclosed. Not a skip condition; payType is just undefined.
    expect(findJob(jobs, "05e14247-17c4-4e98-9a13-53828a4e2f13").payType).toBeUndefined();
    expect(findJob(jobs, "f663839e-46ac-44ad-9720-da2b6aa28093").payType).toBeUndefined();
  });

  it("maps a Salary component with an hourly interval to payType 'hourly' (never observed on a real posting checked here, but the branch is real code, not dead code)", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () =>
        jsonResponse({
          jobs: [
            makeMinimalPosting({
              compensation: {
                compensationTiers: [
                  { components: [{ compensationType: "Salary", interval: "1 HOUR" }] },
                ],
              },
            }),
          ],
        }),
    });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.payType).toBe("hourly");
  });

  it("never reintroduces enum-based skipping: a record with no employmentType/workplaceType/compensation signal at all is still returned as a job, not skipped", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse({ jobs: [makeMinimalPosting({})] }),
    });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(skipRate).toBe(0);
    expect(jobs[0]?.payType).toBeUndefined();
    expect(jobs[0]?.commitment).toBeUndefined();
    expect(jobs[0]?.locationType).toBeUndefined();
  });

  it("produces a stable externalId (Ashby's posting id) across repeated calls, in the same order", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse(rampFixture) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const first = await source.search({});
    const second = await source.search({});

    const idsFirst = [...first.jobs, ...first.skipped].map((j) => j.externalId);
    const idsSecond = [...second.jobs, ...second.skipped].map((j) => j.externalId);
    expect(idsFirst).toEqual([
      "34413f8d-26bf-4bbc-8ade-eb309a0e2245",
      "94d79eed-34db-42c8-b47c-5edef335b7f2",
      "690c661d-7ef7-472c-841b-2e20fb4c5db3",
      "67fadb77-43d8-4449-954b-d4cf2c6d3b8b",
      "4bc09b14-0389-40cd-9d5b-f5557f451d50",
    ]);
    expect(idsFirst).toEqual(idsSecond);
  });

  it("requests includeCompensation=true for every configured board name, with no credentials required", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      notion: () => jsonResponse(notionFixture),
    });
    const source = makeSource(fetchImpl, ["ramp", "notion"]);

    await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [URL, RequestInit][];
    const urls = calls.map(([url]) => url);
    expect(urls.some((u) => u.pathname.includes("/job-board/ramp"))).toBe(true);
    expect(urls.some((u) => u.pathname.includes("/job-board/notion"))).toBe(true);
    for (const url of urls) {
      expect(url.searchParams.get("includeCompensation")).toBe("true");
    }
  });
});

describe("AshbySource — nonexistent board vs. a board with zero openings (must be distinguishable)", () => {
  it("a real board with zero open postings (HTTP 200, {jobs: []}) reports skipRate 0 with nothing in skipped", async () => {
    // mercury and deel both really return this shape (verified live,
    // 2026-08-21) — a company that uses Ashby but has nothing open right
    // now, not an error.
    const fetchImpl = fetchByBoard({ mercury: () => jsonResponse(mercuryFixture) });
    const source = makeSource(fetchImpl, ["mercury"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("a nonexistent board name (HTTP 404) reports skipRate 1 with a skipped entry naming the 404 — distinct from the zero-openings case above", async () => {
    const fetchImpl = fetchByBoard({
      "this-board-does-not-exist-xyz123": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["this-board-does-not-exist-xyz123"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    // The distinguishing signal: skipRate 1 (not 0) and a skipped entry
    // naming the board and the 404, vs. skipRate 0 / empty skipped for a
    // real empty board.
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.externalId).toBeUndefined();
    expect(skipped[0]?.reason).toMatch(/does not exist/);
    expect(skipped[0]?.reason).toMatch(/404/);
    expect(skipped[0]?.reason).toContain("this-board-does-not-exist-xyz123");
  });

  it("a 404 on one board doesn't discard results from healthy boards (per-board failure isolation)", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => jsonResponse(rampFixture),
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "ramp"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(5);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/does-not-exist/);
  });
});

describe("AshbySource — structurally broken records (synthetic, not fixture-derived)", () => {
  it("honestly reports a mix of jobs and skips, with reasons naming the real cause", async () => {
    // Real Ashby records are never structurally broken (verified: every one
    // of the 393+ real postings checked while building this adapter had id,
    // title, applyUrl/jobUrl, description content, and publishedAt), so
    // there's no real fixture that provokes a skip. What's genuinely
    // unmappable is a structurally broken record — handcrafted deliberately,
    // same discipline as lever.test.ts and greenhouse.test.ts.
    const brokenPostings = [
      { title: "Broken A", applyUrl: "https://x/1", descriptionPlain: "hi" }, // no id
      { id: "b2", applyUrl: "https://x/2", descriptionPlain: "hi", publishedAt: "2026-01-01" }, // no title
      { id: "b3", title: "Broken C", descriptionPlain: "hi", publishedAt: "2026-01-01" }, // no applyUrl/jobUrl
      { id: "b4", title: "Broken D", applyUrl: "https://x/4", publishedAt: "2026-01-01" }, // no description
      {
        id: "b5",
        title: "Broken E",
        applyUrl: "https://x/5",
        descriptionPlain: "hi",
        publishedAt: "not-a-date",
      }, // unparseable publishedAt
    ];
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse({ jobs: brokenPostings }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(5);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/missing id/);
    expect(skipped[1]?.reason).toMatch(/missing title/);
    expect(skipped[2]?.reason).toMatch(/missing applyUrl and jobUrl/);
    expect(skipped[3]?.reason).toMatch(/missing description content/);
    expect(skipped[4]?.reason).toMatch(/unparseable publishedAt/);
  });

  it("falls back to jobUrl when applyUrl is absent", async () => {
    const posting = makeMinimalPosting({
      applyUrl: undefined,
      jobUrl: "https://jobs.ashbyhq.com/acme/x",
    });
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse({ jobs: [posting] }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.linkToApply).toBe("https://jobs.ashbyhq.com/acme/x");
  });
});

describe("AshbySource — error classification", () => {
  it("classifies HTTP 401 as AuthFailedError (not retryable)", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => new Response("Unauthorized", { status: 401 }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).kind).toBe("auth-failed");
    expect((err as AuthFailedError).retryable).toBe(false);
  });

  it("classifies HTTP 403 as ForbiddenError, distinct from AuthFailedError, and retryable", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => new Response("<html>blocked</html>", { status: 403 }),
    });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(AuthFailedError);
    expect((err as ForbiddenError).retryable).toBe(true);
  });

  it("classifies HTTP 429 as RateLimitedError (retryable) and reads Retry-After", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "12" } }),
    });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryable).toBe(true);
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000);
  });

  it("classifies HTTP 500/503 as TransientSourceError (retryable)", async () => {
    const fetchImpl = fetchByBoard({
      ramp: () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).retryable).toBe(true);
  });

  it("classifies a network failure (fetch rejects) as TransientSourceError", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).cause).toBeInstanceOf(Error);
  });

  it("classifies invalid JSON as MalformedResponseError (not retryable)", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => new Response("not json{{{", { status: 200 }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
    expect((err as MalformedResponseError).retryable).toBe(false);
  });

  it("classifies well-formed JSON with an unexpected shape (missing jobs array) as MalformedResponseError", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => jsonResponse({ notWhatWeExpected: true }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
  });

  it("classifies an unmapped 4xx status (400) as UnexpectedStatusError (not retryable)", async () => {
    const fetchImpl = fetchByBoard({ ramp: () => new Response("Bad Request", { status: 400 }) });
    const source = makeSource(fetchImpl, ["ramp"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatusError);
    expect((err as UnexpectedStatusError).status).toBe(400);
    expect((err as UnexpectedStatusError).retryable).toBe(false);
  });
});

describe("AshbySource construction", () => {
  it("throws when constructed with an empty boardNames list", () => {
    expect(() => new AshbySource({ boardNames: [] })).toThrow(/at least one board name/);
  });
});

describe("createAshbySourceFromEnv", () => {
  it("throws when ASHBY_BOARD_NAMES is missing", () => {
    expect(() => createAshbySourceFromEnv({})).toThrow(/ASHBY_BOARD_NAMES/);
  });

  it("throws when ASHBY_BOARD_NAMES is empty/whitespace", () => {
    expect(() => createAshbySourceFromEnv({ ASHBY_BOARD_NAMES: "  , ," })).toThrow(
      /ASHBY_BOARD_NAMES/,
    );
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const source = createAshbySourceFromEnv({ ASHBY_BOARD_NAMES: " ramp, notion ,vanta" });
    expect(source.dataSource).toBe("ashby");
  });
});
