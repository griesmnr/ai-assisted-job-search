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
import { UsajobsSource, createUsajobsSourceFromEnv } from "./usajobs.js";

// ---------------------------------------------------------------------------
// Fixture: a real, live-captured USAJOBS response (Fields=Full, HTTP 200,
// 2 records chosen to cover TeleworkEligible true and false). See
// __fixtures__/usajobs-real-response.json. Every test below either uses
// this response directly or derives a variant from a deep clone of one of
// its records with a single field changed — never a hand-invented shape.
// An earlier version of this suite used fixtures built from memory of the
// USAJOBS docs rather than a real response, and every mapping in them was
// subtly wrong (RateIntervalCode values, PositionSchedule matching,
// TeleworkEligible's type) in ways that made the adapter map zero real
// jobs while the suite stayed green. Do not reintroduce hand-built
// fixtures for the success/pagination/skip paths - derive from this file.
// ---------------------------------------------------------------------------

type UsajobsFixture = {
  SearchResult: {
    SearchResultCountAll: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SearchResultItems: any[];
  };
};

function loadFixture(name: string): UsajobsFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as UsajobsFixture;
}

const real = loadFixture("usajobs-real-response.json");
const realItems = real.SearchResult.SearchResultItems;
// Sanity-check the fixture itself hasn't drifted from what these tests
// assume, so a broken fixture fails with a clear message instead of
// confusing downstream assertion failures.
if (realItems.length !== 2) {
  throw new Error(`expected the real fixture to have 2 items, got ${realItems.length}`);
}
const [civilEngineer, engineeringGeneralist] = realItems;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cloneItem(item: any): any {
  return structuredClone(item);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeSource(fetchImpl: typeof fetch) {
  return new UsajobsSource({
    apiKey: "test-api-key",
    userAgent: "nicole@griesmeyer.org",
    fetchImpl,
  });
}

describe("UsajobsSource — mapping against a real captured response", () => {
  it("returns a non-empty jobs array for a real response with a 0 skip rate", async () => {
    // This is the guardrail: if the mapping functions regress in a way
    // that makes every real record unmappable (e.g. matching a field type
    // or code that doesn't actually appear in USAJOBS' payload), this
    // fails loudly instead of quietly returning `jobs: []`, which is what
    // happened before this fixture existed.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(real));
    const source = makeSource(fetchImpl);

    const { jobs, skipped, skipRate } = await source.search({ keyword: "engineer" });

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs).toHaveLength(2);
    expect(skipped).toEqual([]);
    expect(skipRate).toBe(0);
  });

  it("maps every field of the real response onto Job", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(real));
    const source = makeSource(fetchImpl);

    const { jobs } = await source.search({ keyword: "engineer" });
    const [civil, generalist] = jobs;

    expect(civil).toEqual({
      externalId: "879434300",
      dataSource: "usajobs",
      title: "Civil Engineer (Structural)",
      description: civilEngineer.MatchedObjectDescriptor.UserArea.Details.JobSummary,
      company: "U.S. Army Corps of Engineers",
      payType: "salary",
      commitment: "full-time",
      // RemoteIndicator: false, TeleworkEligible: true
      locationType: "hybrid",
      location: "Walla Walla, Washington",
      linkToApply: "https://www.usajobs.gov:443/job/879434300",
      postedAt: new Date("2026-08-06T00:00:00.0000"),
    });

    expect(generalist).toEqual({
      externalId: "846773600",
      dataSource: "usajobs",
      title: "ENGINEERING",
      description: engineeringGeneralist.MatchedObjectDescriptor.UserArea.Details.JobSummary,
      company: "Air Force Civilian Career Training",
      payType: "salary",
      commitment: "full-time",
      // RemoteIndicator: false, TeleworkEligible: false
      locationType: "onsite",
      location: "Multiple Locations",
      linkToApply: "https://www.usajobs.gov:443/job/846773600",
      postedAt: new Date("2025-09-29T00:00:00.0000"),
    });
  });

  it("produces a stable externalId (MatchedObjectId) across repeated calls", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(real));
    const source = makeSource(fetchImpl);

    const first = await source.search({ keyword: "engineer" });
    const second = await source.search({ keyword: "engineer" });

    expect(first.jobs.map((j) => j.externalId)).toEqual(["879434300", "846773600"]);
    expect(first.jobs.map((j) => j.externalId)).toEqual(second.jobs.map((j) => j.externalId));
  });

  it("requests Fields=Full and sends Authorization-Key / User-Agent, never leaking the key into the URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(real));
    const source = new UsajobsSource({
      apiKey: "super-secret-key",
      userAgent: "nicole@griesmeyer.org",
      fetchImpl,
    });

    await source.search({ keyword: "engineer" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("Fields")).toBe("Full");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization-Key"]).toBe("super-secret-key");
    expect(headers["User-Agent"]).toBe("nicole@griesmeyer.org");
    expect(url.toString()).not.toContain("super-secret-key");
  });
});

describe("UsajobsSource — pagination", () => {
  it("follows pages until SearchResultCountAll is reached", async () => {
    const page1 = {
      SearchResult: { SearchResultCountAll: 2, SearchResultItems: [cloneItem(civilEngineer)] },
    };
    const page2 = {
      SearchResult: {
        SearchResultCountAll: 2,
        SearchResultItems: [cloneItem(engineeringGeneralist)],
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    const source = makeSource(fetchImpl);

    const { jobs, skipped } = await source.search({ keyword: "engineer" });

    expect(skipped).toEqual([]);
    expect(jobs.map((j) => j.externalId)).toEqual(["879434300", "846773600"]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    const secondUrl = fetchImpl.mock.calls[1]?.[0] as URL;
    expect(firstUrl.searchParams.get("Page")).toBe("1");
    expect(secondUrl.searchParams.get("Page")).toBe("2");
    expect(firstUrl.searchParams.get("Fields")).toBe("Full");
    expect(secondUrl.searchParams.get("Fields")).toBe("Full");
  });

  it("stops after one page when the first page already covers SearchResultCountAll", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(real));
    const source = makeSource(fetchImpl);

    await source.search({ keyword: "engineer" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops if a page comes back with zero items even though the count implies more", async () => {
    const page1 = {
      SearchResult: { SearchResultCountAll: 2, SearchResultItems: [cloneItem(civilEngineer)] },
    };
    const emptyPage2 = { SearchResult: { SearchResultCountAll: 2, SearchResultItems: [] } };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(emptyPage2));
    const source = makeSource(fetchImpl);

    const { jobs } = await source.search({ keyword: "engineer" });

    expect(jobs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("UsajobsSource — surfaces unmappable fields instead of guessing", () => {
  it("skips records whose payType/commitment/locationType cannot be determined, with reasons, and reports skipRate", async () => {
    const good = cloneItem(civilEngineer);

    const badPayType = cloneItem(civilEngineer);
    badPayType.MatchedObjectId = "900000002";
    badPayType.MatchedObjectDescriptor.PositionRemuneration = [
      { MinimumRange: "10", MaximumRange: "20", RateIntervalCode: "PD", Description: "Per Day" },
    ];

    const badCommitment = cloneItem(civilEngineer);
    badCommitment.MatchedObjectId = "900000003";
    badCommitment.MatchedObjectDescriptor.PositionSchedule = [{ Name: "", Code: "4" }];

    const badLocationType = cloneItem(civilEngineer);
    badLocationType.MatchedObjectId = "900000004";
    delete badLocationType.MatchedObjectDescriptor.UserArea.Details.RemoteIndicator;

    const response = {
      SearchResult: {
        SearchResultCountAll: 4,
        SearchResultItems: [good, badPayType, badCommitment, badLocationType],
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const source = makeSource(fetchImpl);

    const { jobs, skipped, skipRate } = await source.search({ keyword: "engineer" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("879434300");

    expect(skipped).toHaveLength(3);
    const byId = new Map(skipped.map((s) => [s.externalId, s.reason]));
    expect(byId.get("900000002")).toMatch(/payType/);
    expect(byId.get("900000002")).toMatch(/PD/);
    expect(byId.get("900000003")).toMatch(/commitment/);
    expect(byId.get("900000003")).toMatch(/"4"/);
    expect(byId.get("900000004")).toMatch(/locationType/);

    expect(skipRate).toBe(0.75);
  });

  it("reports a skipRate of 1 (not a silent empty result) when every record fails to map", async () => {
    const allBad = cloneItem(civilEngineer);
    delete allBad.MatchedObjectDescriptor.UserArea.Details.RemoteIndicator;
    delete allBad.MatchedObjectDescriptor.UserArea.Details.TeleworkEligible;

    const response = {
      SearchResult: { SearchResultCountAll: 1, SearchResultItems: [allBad] },
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const source = makeSource(fetchImpl);

    const { jobs, skipped, skipRate } = await source.search({ keyword: "engineer" });

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
  });

  it("reports skipRate 0, not NaN, when the source genuinely matched nothing", async () => {
    const response = { SearchResult: { SearchResultCountAll: 0, SearchResultItems: [] } };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(response));
    const source = makeSource(fetchImpl);

    const { jobs, skipped, skipRate } = await source.search({
      keyword: "a search with no matches",
    });

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });
});

describe("UsajobsSource — error classification", () => {
  it("classifies HTTP 401 as AuthFailedError (not retryable)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const source = makeSource(fetchImpl);

    await expect(source.search({})).rejects.toThrow(AuthFailedError);

    let err: unknown;
    try {
      await source.search({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).kind).toBe("auth-failed");
    expect((err as AuthFailedError).retryable).toBe(false);
  });

  it("classifies HTTP 403 as ForbiddenError, distinct from AuthFailedError, and retryable", async () => {
    // USAJOBS sits behind Akamai; a 403 there is a WAF block (e.g. bad
    // User-Agent format), not the API itself rejecting our key.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>Access Denied</html>", { status: 403 }));
    const source = makeSource(fetchImpl);

    let err: unknown;
    try {
      await source.search({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(AuthFailedError);
    expect((err as ForbiddenError).kind).toBe("forbidden");
    expect((err as ForbiddenError).retryable).toBe(true);
  });

  it("classifies HTTP 429 as RateLimitedError (retryable) and reads Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "30" } }),
      );
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).kind).toBe("rate-limited");
    expect((err as RateLimitedError).retryable).toBe(true);
    expect((err as RateLimitedError).retryAfterMs).toBe(30_000);
  });

  it("classifies HTTP 500/503 as TransientSourceError (retryable)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).retryable).toBe(true);
  });

  it("classifies a network failure (fetch rejects) as TransientSourceError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).cause).toBeInstanceOf(Error);
  });

  it("classifies invalid JSON as MalformedResponseError (not retryable)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json{{{", { status: 200 }));
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
    expect((err as MalformedResponseError).retryable).toBe(false);
  });

  it("classifies well-formed JSON with an unexpected shape as MalformedResponseError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ notWhatWeExpected: true }));
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
  });

  it("classifies an unmapped 4xx status as UnexpectedStatusError (not retryable)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }));
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatusError);
    expect((err as UnexpectedStatusError).status).toBe(400);
    expect((err as UnexpectedStatusError).retryable).toBe(false);
  });
});

describe("createUsajobsSourceFromEnv", () => {
  it("throws when USAJOBS_API_KEY is missing", () => {
    expect(() =>
      createUsajobsSourceFromEnv({ USAJOBS_USER_AGENT: "nicole@griesmeyer.org" }),
    ).toThrow(/USAJOBS_API_KEY/);
  });

  it("throws when USAJOBS_USER_AGENT is missing", () => {
    expect(() => createUsajobsSourceFromEnv({ USAJOBS_API_KEY: "abc123" })).toThrow(
      /USAJOBS_USER_AGENT/,
    );
  });

  it("constructs a source when both are present", () => {
    const source = createUsajobsSourceFromEnv({
      USAJOBS_API_KEY: "abc123",
      USAJOBS_USER_AGENT: "nicole@griesmeyer.org",
    });
    expect(source.dataSource).toBe("usajobs");
  });

  it("never exposes the credentials via JSON.stringify or enumeration", () => {
    const source = createUsajobsSourceFromEnv({
      USAJOBS_API_KEY: "super-secret-key",
      USAJOBS_USER_AGENT: "nicole@griesmeyer.org",
    });
    expect(JSON.stringify(source)).not.toContain("super-secret-key");
    expect(Object.keys(source)).not.toContain("apiKey");
  });
});
