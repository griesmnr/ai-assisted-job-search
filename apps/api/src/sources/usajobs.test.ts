import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    userAgent: "jobsearch@example.com",
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
      userAgent: "jobsearch@example.com",
      fetchImpl,
    });

    await source.search({ keyword: "engineer" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get("Fields")).toBe("Full");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization-Key"]).toBe("super-secret-key");
    expect(headers["User-Agent"]).toBe("jobsearch@example.com");
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

  it("classifies a socket-drop/connection-terminated error during response.json() as TransientSourceError, not MalformedResponseError (ticket c419a12, N5)", async () => {
    // The exact shape undici raises when the connection is terminated
    // mid-body (observed live, 2 of 3 runs of
    // scripts/verify-usajobs-keyword-coverage.ts): a `TypeError` with
    // message "terminated" whose `.cause.code` is `UND_ERR_SOCKET`. This is
    // a transient network condition, not malformed data -- the same
    // request retried has every reason to succeed.
    const socketDropErr = new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => Promise.reject(socketDropErr),
    } as unknown as Response);
    const source = makeSource(fetchImpl);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect(err).not.toBeInstanceOf(MalformedResponseError);
    expect((err as TransientSourceError).retryable).toBe(true);
    expect((err as TransientSourceError).cause).toBe(socketDropErr);
  });

  it("still classifies a same-message-shaped but unrelated TypeError as MalformedResponseError (the detection isn't overly broad)", async () => {
    // Guards against a detection so loose it swallows a genuine
    // malformed-response bug as "just retry it" -- a TypeError with an
    // unrelated message and no UND_ERR_SOCKET cause must still be treated
    // as non-retryable malformed data.
    const unrelatedErr = new TypeError("Cannot read properties of undefined");
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: () => Promise.reject(unrelatedErr),
    } as unknown as Response);
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

describe("UsajobsSource — criteria.keywords (ticket d1fc9e2, multi-phrase 'ANY of these' search)", () => {
  // Re-review N3: a spy left un-restored after an assertion throws mid-test
  // leaks into the NEXT test (observed for real during mutation testing —
  // breaking the cap made two tests fail, the second one spuriously,
  // because the first test's thrown assertion skipped its own
  // `warnSpy.mockRestore()`). A blanket restore after every test is cheap
  // insurance regardless of whether a given test happens to spy.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Real per-item response for a given single-item page — used to build a
  // fetchImpl that returns different items for different Keyword values,
  // simulating each phrase genuinely matching a different (or overlapping)
  // slice of USAJOBS.
  function singleItemResponse(item: unknown): Response {
    return jsonResponse({ SearchResult: { SearchResultCountAll: 1, SearchResultItems: [item] } });
  }
  function emptyResponse(): Response {
    return jsonResponse({ SearchResult: { SearchResultCountAll: 0, SearchResultItems: [] } });
  }

  it("runs one fully-paginated search per phrase and merges the jobs", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      const keyword = url.searchParams.get("Keyword");
      if (keyword === "civil engineer") return singleItemResponse(civilEngineer);
      if (keyword === "engineering generalist") return singleItemResponse(engineeringGeneralist);
      return emptyResponse();
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({ keywords: ["civil engineer", "engineering generalist"] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const keywordsSent = fetchImpl.mock.calls
      .map((call) => (call[0] as URL).searchParams.get("Keyword"))
      .sort();
    expect(keywordsSent).toEqual(["civil engineer", "engineering generalist"]);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((j) => j.externalId).sort()).toEqual(["846773600", "879434300"]);
  });

  it("dedupes by externalId when the SAME real posting matches more than one phrase", async () => {
    // A fresh Response per call -- reusing one Response instance across
    // multiple fetchImpl calls fails with "Body has already been read"
    // once its stream is consumed by the first read.
    const fetchImpl = vi.fn().mockImplementation(async () => singleItemResponse(civilEngineer));
    const source = makeSource(fetchImpl);

    const result = await source.search({
      keywords: ["civil engineer", "structural engineer", "engineer"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // All three phrases "found" the same real posting -- merged to one job,
    // not three.
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.externalId).toBe("879434300");
  });

  it("caps at MAX_KEYWORD_SEARCHES (10, opus review F1): extra phrases beyond the cap are never searched, and a warning names the dropped ones", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => emptyResponse());
    const source = makeSource(fetchImpl);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await source.search({
      keywords: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(10);
    const keywordsSent = fetchImpl.mock.calls.map((call) =>
      (call[0] as URL).searchParams.get("Keyword"),
    );
    expect(keywordsSent.sort()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // Re-review N4: `toContain("k, l")` alone also passes if the message
    // names every phrase, not just the dropped ones -- assert the full
    // dropped-list text exactly, and that a KEPT phrase is absent.
    expect(warnSpy.mock.calls[0]?.[0]).toContain("dropped: k, l");
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("a, b");
  });

  it("does NOT warn when the number of phrases is within the cap", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => emptyResponse());
    const source = makeSource(fetchImpl);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await source.search({ keywords: ["a", "b", "c"] });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("dedupes skipped[] by externalId too, not just jobs[] (opus review F3), so skipRate stays honest across overlapping phrases", async () => {
    // Both phrases "find" the same one real page, and that page's item is
    // unmappable -- it should be reported as skipped ONCE, not twice, or
    // skipRate would overstate how much of the pool genuinely failed to map.
    const unmappable = cloneItem(civilEngineer);
    delete unmappable.MatchedObjectDescriptor.UserArea.Details.RemoteIndicator;
    const fetchImpl = vi.fn().mockImplementation(async () => singleItemResponse(unmappable));
    const source = makeSource(fetchImpl);

    const result = await source.search({ keywords: ["civil engineer", "structural engineer"] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.jobs).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipRate).toBe(1);
  });

  it("a job found via ANY phrase always wins over the SAME posting being unmappable via another phrase, regardless of fetch order (re-review N1)", async () => {
    // Same real MatchedObjectId, but phrase A's copy is unmappable
    // (RemoteIndicator missing) while phrase B's copy is a normal, fully
    // mappable posting. A naive single-pass dedup keyed on "seen at all"
    // would let whichever phrase's worker happens to finish FIRST decide
    // the outcome -- if the unmappable copy is seen first, the real job
    // from the other phrase is silently dropped as "already seen," and
    // the posting is wrongly reported as skipped even though a mappable
    // copy of it genuinely existed. A job must always win.
    const unmappableCopy = cloneItem(civilEngineer);
    delete unmappableCopy.MatchedObjectDescriptor.UserArea.Details.RemoteIndicator;
    const mappableCopy = cloneItem(civilEngineer);

    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      const keyword = url.searchParams.get("Keyword");
      if (keyword === "unmappable-first") return singleItemResponse(unmappableCopy);
      return singleItemResponse(mappableCopy);
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({
      keywords: ["unmappable-first", "mappable-second"],
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.externalId).toBe(civilEngineer.MatchedObjectId);
    expect(result.skipped).toHaveLength(0);
    expect(result.skipRate).toBe(0);
  });

  it("an empty keywords array behaves exactly like no criteria at all (falls back to a single unkeyworded search)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(real));
    const source = makeSource(fetchImpl);

    const result = await source.search({ keywords: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![0] as URL).searchParams.has("Keyword")).toBe(false);
    expect(result.jobs).toHaveLength(2);
  });

  it("keywords takes priority over a plain keyword when both are somehow present", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      const keyword = url.searchParams.get("Keyword");
      if (keyword === "civil engineer") return singleItemResponse(civilEngineer);
      return emptyResponse();
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({
      keyword: "ignored plain keyword",
      keywords: ["civil engineer"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0]![0] as URL).searchParams.get("Keyword")).toBe("civil engineer");
    expect(result.jobs).toHaveLength(1);
  });

  it("still fully paginates EACH phrase's own search (multi-phrase doesn't lose per-phrase pagination)", async () => {
    const page1 = jsonResponse({
      SearchResult: { SearchResultCountAll: 2, SearchResultItems: [cloneItem(civilEngineer)] },
    });
    const page2 = jsonResponse({
      SearchResult: {
        SearchResultCountAll: 2,
        SearchResultItems: [{ ...cloneItem(civilEngineer), MatchedObjectId: "999999999" }],
      },
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const source = makeSource(fetchImpl);

    const result = await source.search({ keywords: ["civil engineer"] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.jobs.map((j) => j.externalId).sort()).toEqual(["879434300", "999999999"]);
  });
});

describe("UsajobsSource — per-phrase failure isolation (ticket c419a12)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function singleItemResponse(item: unknown): Response {
    return jsonResponse({ SearchResult: { SearchResultCountAll: 1, SearchResultItems: [item] } });
  }
  function emptyResponse(): Response {
    return jsonResponse({ SearchResult: { SearchResultCountAll: 0, SearchResultItems: [] } });
  }

  it("a transient failure on ONE phrase doesn't discard other phrases' already-completed results", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      const keyword = url.searchParams.get("Keyword");
      if (keyword === "civil engineer") return singleItemResponse(civilEngineer);
      if (keyword === "engineering generalist") return singleItemResponse(engineeringGeneralist);
      if (keyword === "flaky phrase") throw new Error("ECONNRESET");
      return emptyResponse();
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({
      keywords: ["civil engineer", "flaky phrase", "engineering generalist"],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The two healthy phrases' jobs are still returned in full -- the
    // failure on "flaky phrase" did NOT throw and discard them.
    expect(result.jobs.map((j) => j.externalId).sort()).toEqual(["846773600", "879434300"]);

    // The failed phrase is recorded as a skip, not silently dropped either.
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.externalId).toBeUndefined();
    expect(result.skipped[0]?.reason).toContain('"flaky phrase"');
    expect(result.skipped[0]?.reason).toMatch(/network error/i);

    // 2 jobs + 1 collection-level skip -- an honest, non-1.0 skipRate.
    expect(result.skipRate).toBeCloseTo(1 / 3);
  });

  it("still throws normally when the FIRST (non-multi-keyword) search path fails -- this fix is scoped to #searchMultipleKeywords only", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const source = makeSource(fetchImpl);

    await expect(source.search({ keyword: "engineer" })).rejects.toThrow(TransientSourceError);
  });

  // Mirrors greenhouse.test.ts's equivalent 429-mid-fan-out test: with
  // KEYWORD_SEARCH_CONCURRENCY (3) workers, all three of the first three
  // phrases dispatch immediately, so a 4th phrase is needed for there to be
  // any "not yet claimed" work left to stop. The two non-rate-limited
  // in-flight phrases are deliberately held open (deferred) so the
  // rate-limited phrase's 429 is guaranteed to be observed, and the stop
  // flag set, BEFORE any worker can finish and claim the 4th phrase --
  // otherwise whether the 4th phrase gets requested is a genuine race, not
  // a deterministic thing to assert on.
  it("a 429 on one phrase stops issuing new phrase searches, but every phrase already claimed still completes and is returned", async () => {
    function deferredResponse() {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const healthy2Deferred = deferredResponse();
    const healthy3Deferred = deferredResponse();
    const neverRequested = vi.fn(() => emptyResponse());

    const fetchImpl = vi.fn().mockImplementation(async (url: URL) => {
      const keyword = url.searchParams.get("Keyword");
      if (keyword === "rate-limited") {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      }
      if (keyword === "healthy-2") return healthy2Deferred.promise;
      if (keyword === "healthy-3") return healthy3Deferred.promise;
      if (keyword === "never-requested") return neverRequested();
      return emptyResponse();
    });
    const source = makeSource(fetchImpl);

    const resultPromise = source.search({
      keywords: ["rate-limited", "healthy-2", "healthy-3", "never-requested"],
    });

    // Let the rate-limited worker's microtasks (fetch resolve -> 429
    // classification -> catch -> set the stop flag) run to completion
    // before releasing the other two in-flight requests.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    healthy2Deferred.resolve(singleItemResponse(civilEngineer));
    healthy3Deferred.resolve(singleItemResponse(engineeringGeneralist));

    const result = await resultPromise;

    // Not rejected -- resolves with a partial result, and the 4th phrase
    // was never even requested.
    expect(neverRequested).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    expect(result.jobs.map((j) => j.externalId).sort()).toEqual(["846773600", "879434300"]);

    const byReason = (needle: string) => result.skipped.find((s) => s.reason.includes(needle));
    expect(byReason("rate-limited")?.reason).toMatch(/retry after 30000ms/);
    expect(byReason("never-requested")?.reason).toMatch(
      /not attempted.*stopped issuing new phrase searches.*"rate-limited".*rate-limited \(HTTP 429\)/,
    );
  });
});

describe("createUsajobsSourceFromEnv", () => {
  it("throws when USAJOBS_API_KEY is missing", () => {
    expect(() =>
      createUsajobsSourceFromEnv({ USAJOBS_USER_AGENT: "jobsearch@example.com" }),
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
      USAJOBS_USER_AGENT: "jobsearch@example.com",
    });
    expect(source.dataSource).toBe("usajobs");
  });

  it("never exposes the credentials via JSON.stringify or enumeration", () => {
    const source = createUsajobsSourceFromEnv({
      USAJOBS_API_KEY: "super-secret-key",
      USAJOBS_USER_AGENT: "jobsearch@example.com",
    });
    expect(JSON.stringify(source)).not.toContain("super-secret-key");
    expect(Object.keys(source)).not.toContain("apiKey");
  });
});
