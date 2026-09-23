import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WorkableSource, createWorkableSourceFromEnv } from "./workable.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Workable Accounts API responses
// (`GET https://www.workable.com/api/accounts/{subdomain}?details=true`),
// each trimmed down to a handful of real records (fields untouched — nothing
// stripped out of a kept posting beyond which postings were kept). See
// __fixtures__/workable-real-response-dispel.json (verbatim, all 2 real
// postings Dispel currently has open), __fixtures__/workable-real-response-
// tetrascience-trimmed.json (6 of TetraScience's ~26 real raw postings,
// chosen specifically to span two real duplicate-shortcode multi-location
// groups plus one ordinary single-location control), and
// __fixtures__/workable-real-response-sylvera-empty.json (a real, verbatim
// zero-postings response — HTTP 200, `jobs: []`, a genuinely quiet real
// employer). See workable.ts's top-of-file comment for how these were
// captured (2026-09-23) and what was cross-checked before any mapping was
// written.
//
// Never hand-build a fixture for the success/skip paths below — derive from
// these files, the same discipline this project's USAJOBS adapter had to be
// rebuilt to follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkableFixture = { name: string; description: string; jobs: any[] };

function loadFixture(name: string): WorkableFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as WorkableFixture;
}

const dispelFixture = loadFixture("workable-real-response-dispel.json");
const tetrascienceFixture = loadFixture("workable-real-response-tetrascience-trimmed.json");
const sylveraFixture = loadFixture("workable-real-response-sylvera-empty.json");

if (dispelFixture.jobs.length !== 2) {
  throw new Error(
    `expected the dispel fixture to have 2 postings, got ${dispelFixture.jobs.length}`,
  );
}
if (tetrascienceFixture.jobs.length !== 6) {
  throw new Error(
    `expected the tetrascience-trimmed fixture to have 6 RAW postings (3 real duplicate-shortcode groups), got ${tetrascienceFixture.jobs.length}`,
  );
}
if (sylveraFixture.jobs.length !== 0) {
  throw new Error(
    `expected the sylvera fixture (a real, legitimate empty account) to have 0 postings, got ${sylveraFixture.jobs.length}`,
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Maps subdomain -> canned Response, so tests can mock a multi-account
 * search() by name rather than by call order. */
function fetchBySubdomain(responses: Record<string, () => Response>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const match = /\/accounts\/([^/]+)/.exec(url.pathname);
    const subdomain = match?.[1];
    const responder = subdomain ? responses[subdomain] : undefined;
    if (!responder) {
      throw new Error(`test fetch stub: no mocked response for URL ${url.toString()}`);
    }
    return responder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, companies: string[] = ["dispel"]) {
  return new WorkableSource({ companies, fetchImpl });
}

/** A structurally-complete-but-otherwise-blank posting, for tests that need
 * to isolate one field's behavior without a real fixture's unrelated fields
 * getting in the way. Module-scoped so every describe block below can use
 * it. */
function makeMinimalPosting(overrides: Record<string, unknown>) {
  return {
    shortcode: "AAAA111111",
    title: "Some Role",
    application_url: "https://apply.workable.com/j/AAAA111111/apply",
    description: "<p>Do the work.</p>",
    published_on: "2026-01-15",
    ...overrides,
  };
}

function findJob<T extends { externalId: string }>(jobs: T[], id: string): T {
  const job = jobs.find((j) => j.externalId === id);
  if (!job) throw new Error(`expected fixture job ${id} to be present`);
  return job;
}

describe("WorkableSource — mapping against real captured responses", () => {
  it("returns a non-empty jobs array for a real response", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs } = await source.search({});

    expect(jobs.length).toBeGreaterThan(0);
  });

  it("skipRate is not 1.0 for a real response", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { skipRate } = await source.search({});

    expect(skipRate).not.toBe(1);
  });

  it("maps every real record from the dispel fixture into jobs, none skipped — N postings in, N jobs out (no duplicate shortcodes in this account)", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    expect(jobs).toHaveLength(2);
  });

  it("real requirements/compensation text far down the description survives, not just the marketing intro — proven to fail against a truncated-description mapper (see this ticket's report for the before/after demonstration)", async () => {
    // This is the content test this project's history says to be suspicious
    // of: it must fail if a mapper only captures the opening "About Dispel"
    // paragraph and drops everything after "Requirements". Verified by
    // temporarily replacing this file's `htmlToPlainText(rawDescription, ...)`
    // call in `normalizeGroup` with a stub that kept only the description's
    // first 400 characters (a "marketing intro only" mapper) and re-running
    // this exact test: it failed on both assertions below (the intro-only
    // stub's output does not contain either string, since both live well
    // past character 400 of the real fixture description) — see this
    // ticket's final report for the exact diff and failing output.
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs } = await source.search({});
    const job = findJob(jobs, "85FC6E958E");

    // Marketing intro, near the top of the real description.
    expect(job.description).toContain(
      "Dispel builds secure, private network infrastructure for critical industries",
    );
    // Real requirements bullet, from this exact posting's "Requirements"
    // section, far down the description — not present anywhere in the
    // opening paragraphs.
    expect(job.description).toContain(
      "SLSA, in-toto, Sigstore, SBOM generation and consumption, reproducible builds",
    );
    // Real compensation prose, in the closing "Benefits" section.
    expect(job.description).toContain("$150,000-159,000 salary range");
  });

  it("sets company to the account's own display name (Workable's response envelope `name`), not the configured subdomain", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs } = await source.search({});

    expect(jobs).toHaveLength(2);
    for (const job of jobs) {
      expect(job.company).toBe("Dispel");
    }
  });

  it("prefers application_url over url for linkToApply", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs } = await source.search({});
    const job = findJob(jobs, "85FC6E958E");

    expect(job.linkToApply).toBe("https://apply.workable.com/j/85FC6E958E/apply");
  });

  it("falls back to url when application_url is absent", async () => {
    const posting = makeMinimalPosting({
      application_url: undefined,
      url: "https://apply.workable.com/j/AAAA111111",
    });
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse({ name: "Acme", jobs: [posting] }),
    });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs[0]?.linkToApply).toBe("https://apply.workable.com/j/AAAA111111");
  });

  it("produces a stable externalId (Workable's shortcode) across repeated calls, in the same order", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const first = await source.search({});
    const second = await source.search({});

    const idsFirst = [...first.jobs, ...first.skipped].map((j) => j.externalId);
    const idsSecond = [...second.jobs, ...second.skipped].map((j) => j.externalId);
    expect(idsFirst).toEqual(["85FC6E958E", "46A48326A0"]);
    expect(idsFirst).toEqual(idsSecond);
  });

  it("requests details=true for every configured subdomain, with no credentials required", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      sylvera: () => jsonResponse(sylveraFixture),
    });
    const source = makeSource(fetchImpl, ["dispel", "sylvera"]);

    await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [URL, RequestInit][];
    const urls = calls.map(([url]) => url);
    expect(urls.some((u) => u.pathname.includes("/accounts/dispel"))).toBe(true);
    expect(urls.some((u) => u.pathname.includes("/accounts/sylvera"))).toBe(true);
    for (const url of urls) {
      expect(url.searchParams.get("details")).toBe("true");
    }
  });

  it("keyword filtering searches the full assembled description, not just the title, so a skill named only far down the description still matches", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs, skipped } = await source.search({ keyword: "Sigstore" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["85FC6E958E"]);
  });
});

describe("WorkableSource — Finding 2: shortcode duplication for multi-location postings", () => {
  it("collapses raw entries sharing a shortcode into ONE job, merging every entry's own locations — 6 raw postings in, 3 jobs out, documented exactly why (two real 2- and 3-location groups)", async () => {
    const fetchImpl = fetchBySubdomain({
      tetrascience: () => jsonResponse(tetrascienceFixture),
    });
    const source = makeSource(fetchImpl, ["tetrascience"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    // 6 raw entries, 3 distinct shortcodes (996AE60304 x2, 8573142D3F x1,
    // EB0A566B47 x3) -> 3 normalized jobs, not 6. This is NOT a mapping
    // failure — see workable.ts Finding 2 for the real duplicate-shortcode
    // evidence this fixture is trimmed from.
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.externalId)).size).toBe(3);
  });

  it("merges Boston + Cambridge into one job's location for the real 2-location duplicate-shortcode group (996AE60304)", async () => {
    const fetchImpl = fetchBySubdomain({
      tetrascience: () => jsonResponse(tetrascienceFixture),
    });
    const source = makeSource(fetchImpl, ["tetrascience"]);

    const { jobs } = await source.search({});
    const chiefOfStaff = findJob(jobs, "996AE60304");

    expect(chiefOfStaff.title).toBe("Chief of Staff to the CEO");
    expect(chiefOfStaff.location).toBe(
      "Boston, Massachusetts, United States; Cambridge, United States",
    );
  });

  it("merges all three countries into one job's location for the real 3-location duplicate-shortcode group (EB0A566B47)", async () => {
    const fetchImpl = fetchBySubdomain({
      tetrascience: () => jsonResponse(tetrascienceFixture),
    });
    const source = makeSource(fetchImpl, ["tetrascience"]);

    const { jobs } = await source.search({});
    const architect = findJob(jobs, "EB0A566B47");

    expect(architect.location).toBe(
      "Copenhagen, Capital Region of Denmark, Denmark; Cambridge, England, United Kingdom; Vienna, Vienna, Austria",
    );
  });

  it("leaves an ordinary single-location posting in the same fixture unaffected by the dedup logic (8573142D3F, the control)", async () => {
    const fetchImpl = fetchBySubdomain({
      tetrascience: () => jsonResponse(tetrascienceFixture),
    });
    const source = makeSource(fetchImpl, ["tetrascience"]);

    const { jobs } = await source.search({});
    const cloudEngineer = findJob(jobs, "8573142D3F");

    expect(cloudEngineer.title).toBe("Principal Cloud Engineer");
    expect(cloudEngineer.location).toBe("Boston, Massachusetts, United States");
  });

  it("location filtering matches against the merged location, catching a country only present on one of several duplicate-shortcode entries", async () => {
    const fetchImpl = fetchBySubdomain({
      tetrascience: () => jsonResponse(tetrascienceFixture),
    });
    const source = makeSource(fetchImpl, ["tetrascience"]);

    const { jobs, skipped } = await source.search({ location: "Austria" });

    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId)).toEqual(["EB0A566B47"]);
  });

  it("does not merge two entries with different shortcodes even when otherwise similar", async () => {
    const a = makeMinimalPosting({ shortcode: "SC0000001", title: "Role A", city: "Austin" });
    const b = makeMinimalPosting({ shortcode: "SC0000002", title: "Role B", city: "Denver" });
    const fetchImpl = fetchBySubdomain({
      acme: () => jsonResponse({ name: "Acme", jobs: [a, b] }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["SC0000001", "SC0000002"]);
  });
});

describe("WorkableSource — a real account with zero open postings (HTTP 200) vs. a nonexistent one (HTTP 404), must be distinguishable", () => {
  it("a real account with zero open postings reports skipRate 0 with nothing in skipped", async () => {
    // sylvera really returns this shape (verified live 2026-09-23) — a
    // company that uses Workable but has nothing open right now, not an
    // error.
    const fetchImpl = fetchBySubdomain({ sylvera: () => jsonResponse(sylveraFixture) });
    const source = makeSource(fetchImpl, ["sylvera"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("a nonexistent subdomain (HTTP 404, real observed plain-text 'Not Found' body) reports skipRate 1 with a skipped entry naming the 404 — distinct from the zero-openings case above", async () => {
    // Real observed response for an invalid subdomain (verified live
    // 2026-09-23, after following the documented host's redirect — see
    // Finding 1): HTTP 404, body "Not Found", content-type text/plain.
    const fetchImpl = fetchBySubdomain({
      "this-company-definitely-does-not-exist-12345": () =>
        new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } }),
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
    // The distinguishing claim this ticket exists to prove: this is NOT the
    // same ambiguous shape SmartRecruiters has (see workable.ts Finding 1).
    expect(skipped[0]?.reason).toMatch(/NOT the same as/);
  });

  it("a 404 on one subdomain doesn't discard results from healthy ones (per-subdomain failure isolation)", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/does-not-exist/);
  });
});

describe("WorkableSource — per-subdomain failure isolation for every error kind, not just 404", () => {
  it("a 401 on one subdomain is isolated as a skip, not an aborted search — healthy subdomains still return their jobs", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () => new Response("Unauthorized", { status: 401 }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/broken/);
    expect(skipped[0]?.reason).toMatch(/401/);
  });

  it("a 403 on one subdomain is isolated as a skip", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () => new Response("<html>blocked</html>", { status: 403 }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/403/);
  });

  it("a 429 on one subdomain is isolated as a skip and the message reflects Retry-After", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "12" } }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/429/);
  });

  it("a 5xx on one subdomain is isolated as a skip", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/503/);
  });

  it("a network failure (fetch rejects) on one subdomain is isolated as a skip", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brokenFetch = vi.fn(async (input: any) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname.includes("/accounts/broken")) throw new Error("ECONNRESET");
      return fetchImpl(input);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
    const source = makeSource(brokenFetch, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/broken/);
  });

  it("invalid JSON on one subdomain is isolated as a skip", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () => new Response("not json{{{", { status: 200 }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/not valid JSON/);
  });

  it("well-formed JSON with an unexpected shape (missing jobs array) on one subdomain is isolated as a skip", async () => {
    const fetchImpl = fetchBySubdomain({
      dispel: () => jsonResponse(dispelFixture),
      broken: () => jsonResponse({ notWhatWeExpected: true }),
    });
    const source = makeSource(fetchImpl, ["broken", "dispel"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/did not match the expected shape/);
  });
});

describe("WorkableSource — structurally broken records (synthetic, not fixture-derived)", () => {
  it("honestly reports a mix of jobs and skips, with reasons naming the real cause", async () => {
    // Real Workable records in the sample this adapter was built against are
    // never structurally broken (verified: every one of the 414 real
    // postings checked had a shortcode, title, application_url/url,
    // description content, and published_on), so there's no real fixture
    // that provokes a skip. What's genuinely unmappable is a structurally
    // broken record — handcrafted deliberately, same discipline as
    // ashby.test.ts and lever.test.ts.
    const brokenPostings = [
      { title: "Broken A", application_url: "https://x/1", description: "hi" }, // no shortcode
      {
        shortcode: "B2",
        application_url: "https://x/2",
        description: "hi",
        published_on: "2026-01-01",
      }, // no title
      { shortcode: "B3", title: "Broken C", published_on: "2026-01-01" }, // no description
      { shortcode: "B4", title: "Broken D", description: "hi" }, // no application_url/url
      {
        shortcode: "B5",
        title: "Broken E",
        application_url: "https://x/5",
        description: "hi",
        published_on: "not-a-date",
      }, // unparseable published_on
    ];
    const fetchImpl = fetchBySubdomain({
      acme: () => jsonResponse({ name: "Acme", jobs: brokenPostings }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(5);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/missing shortcode/);
    expect(skipped[1]?.reason).toMatch(/missing title/);
    expect(skipped[2]?.reason).toMatch(/missing description content/);
    expect(skipped[3]?.reason).toMatch(/missing application_url and url/);
    expect(skipped[4]?.reason).toMatch(/unparseable published_on/);
  });
});

describe("WorkableSource — commitment mapping (employment_type)", () => {
  it("maps Full-time/Contract/Part-time and leaves Temporary/empty/null undefined, never guessed", async () => {
    const postings = [
      makeMinimalPosting({ shortcode: "C1", employment_type: "Full-time" }),
      makeMinimalPosting({ shortcode: "C2", employment_type: "Contract" }),
      makeMinimalPosting({ shortcode: "C3", employment_type: "Part-time" }),
      makeMinimalPosting({ shortcode: "C4", employment_type: "Temporary" }),
      makeMinimalPosting({ shortcode: "C5", employment_type: "" }),
      makeMinimalPosting({ shortcode: "C6", employment_type: null }),
    ];
    const fetchImpl = fetchBySubdomain({
      acme: () => jsonResponse({ name: "Acme", jobs: postings }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    expect(findJob(jobs, "C1").commitment).toBe("full-time");
    expect(findJob(jobs, "C2").commitment).toBe("contract");
    expect(findJob(jobs, "C3").commitment).toBe("part-time");
    expect(findJob(jobs, "C4").commitment).toBeUndefined();
    expect(findJob(jobs, "C5").commitment).toBeUndefined();
    expect(findJob(jobs, "C6").commitment).toBeUndefined();
  });
});

describe("WorkableSource — locationType mapping (telecommuting)", () => {
  it("maps telecommuting true/false to remote/onsite and leaves a missing value undefined — never 'hybrid' (Finding 5: no such value exists in this API)", async () => {
    const postings = [
      makeMinimalPosting({ shortcode: "L1", telecommuting: true }),
      makeMinimalPosting({ shortcode: "L2", telecommuting: false }),
      makeMinimalPosting({ shortcode: "L3" }),
    ];
    const fetchImpl = fetchBySubdomain({
      acme: () => jsonResponse({ name: "Acme", jobs: postings }),
    });
    const source = makeSource(fetchImpl, ["acme"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    expect(findJob(jobs, "L1").locationType).toBe("remote");
    expect(findJob(jobs, "L2").locationType).toBe("onsite");
    expect(findJob(jobs, "L3").locationType).toBeUndefined();
  });

  it("payType is always undefined — Workable's public accounts API carries no compensation field anywhere (Finding 6)", async () => {
    const fetchImpl = fetchBySubdomain({ dispel: () => jsonResponse(dispelFixture) });
    const source = makeSource(fetchImpl, ["dispel"]);

    const { jobs } = await source.search({});
    for (const job of jobs) {
      expect(job.payType).toBeUndefined();
    }
  });

  it("never reintroduces enum-based skipping: a record with no employment_type/telecommuting signal at all is still returned as a job, not skipped", async () => {
    const fetchImpl = fetchBySubdomain({
      acme: () => jsonResponse({ name: "Acme", jobs: [makeMinimalPosting({})] }),
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
});

describe("WorkableSource construction", () => {
  it("throws when constructed with an empty companies list", () => {
    expect(() => new WorkableSource({ companies: [] })).toThrow(/at least one subdomain/);
  });
});

describe("createWorkableSourceFromEnv", () => {
  it("throws when WORKABLE_COMPANIES is missing", () => {
    expect(() => createWorkableSourceFromEnv({})).toThrow(/WORKABLE_COMPANIES/);
  });

  it("throws when WORKABLE_COMPANIES is empty/whitespace", () => {
    expect(() => createWorkableSourceFromEnv({ WORKABLE_COMPANIES: "  , ," })).toThrow(
      /WORKABLE_COMPANIES/,
    );
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const source = createWorkableSourceFromEnv({ WORKABLE_COMPANIES: " dispel, rokt ,seeq" });
    expect(source.dataSource).toBe("workable");
  });
});
