import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AuthFailedError,
  MalformedResponseError,
  RateLimitedError,
  TransientSourceError,
  UnexpectedStatusError,
} from "./types.js";
import { UsajobsSource, createUsajobsSourceFromEnv } from "./usajobs.js";

function loadFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

type UsajobsFixture = {
  SearchResult: {
    SearchResultCountAll: number;
    SearchResultItems: unknown[];
  };
};

const page1 = loadFixture("usajobs-page-1.json") as UsajobsFixture;
const page2 = loadFixture("usajobs-page-2.json") as UsajobsFixture;
const withUnmappable = loadFixture("usajobs-with-unmappable.json") as UsajobsFixture;

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

describe("UsajobsSource — successful mapping", () => {
  it("maps USAJOBS fields onto Job, including required-field derivation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        SearchResult: { ...page1.SearchResult, SearchResultCountAll: 2 },
      }),
    );
    const source = makeSource(fetchImpl);

    const { jobs, skipped } = await source.search({ keyword: "software engineer" });

    expect(skipped).toEqual([]);
    expect(jobs).toHaveLength(2);

    const [salaried, hourly] = jobs;
    expect(salaried).toEqual({
      externalId: "787306400",
      dataSource: "usajobs",
      title: "Software Engineer",
      description: "Design and build backend services for Army logistics systems.",
      company: "Department of the Army",
      payType: "salary",
      commitment: "full-time",
      locationType: "onsite",
      location: "Washington, District of Columbia",
      linkToApply: "https://www.usajobs.gov/job/787306400/apply",
      postedAt: new Date("2026-07-01"),
    });

    expect(hourly).toEqual({
      externalId: "787306401",
      dataSource: "usajobs",
      title: "IT Specialist (Contractor Support)",
      description: "Support VA telehealth infrastructure remotely.",
      company: "Department of Veterans Affairs",
      payType: "hourly",
      commitment: "part-time",
      locationType: "remote",
      location: "Anywhere in the U.S. (remote job)",
      linkToApply: "https://www.usajobs.gov/job/787306401/apply",
      postedAt: new Date("2026-07-03"),
    });
  });

  it("maps TeleworkEligible=Yes + RemoteIndicator=false to hybrid", async () => {
    // Standalone page: override SearchResultCountAll to match the single
    // item actually included, so the adapter doesn't try to fetch a
    // (nonexistent) second page.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ SearchResult: { ...page2.SearchResult, SearchResultCountAll: 1 } }),
      );
    const source = makeSource(fetchImpl);

    const { jobs } = await source.search({ keyword: "sysadmin" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.locationType).toBe("hybrid");
    expect(jobs[0]?.externalId).toBe("787306402");
  });

  it("produces a stable externalId across repeated calls for the same posting", async () => {
    // mockImplementation (not mockResolvedValue) so each fetch call gets a
    // fresh Response — a Response body can only be read once, and this
    // test calls search() twice.
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ SearchResult: { ...page1.SearchResult, SearchResultCountAll: 2 } }),
      );
    const source = makeSource(fetchImpl);

    const first = await source.search({ keyword: "software engineer" });
    const second = await source.search({ keyword: "software engineer" });

    expect(first.jobs.map((j) => j.externalId)).toEqual(second.jobs.map((j) => j.externalId));
    expect(first.jobs[0]?.externalId).toBe("787306400");
  });

  it("sends Authorization-Key and User-Agent headers, and never a query param for the API key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ SearchResult: { SearchResultCountAll: 0, SearchResultItems: [] } }),
      );
    const source = new UsajobsSource({
      apiKey: "super-secret-key",
      userAgent: "nicole@griesmeyer.org",
      fetchImpl,
    });

    await source.search({ keyword: "engineer" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization-Key"]).toBe("super-secret-key");
    expect(headers["User-Agent"]).toBe("nicole@griesmeyer.org");
    expect(url.toString()).not.toContain("super-secret-key");
  });
});

describe("UsajobsSource — pagination", () => {
  it("follows pages until SearchResultCountAll is reached", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));
    const source = makeSource(fetchImpl);

    const { jobs, skipped } = await source.search({ keyword: "software engineer" });

    expect(skipped).toEqual([]);
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.externalId)).toEqual(["787306400", "787306401", "787306402"]);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as URL;
    const secondUrl = fetchImpl.mock.calls[1]?.[0] as URL;
    expect(firstUrl.searchParams.get("Page")).toBe("1");
    expect(secondUrl.searchParams.get("Page")).toBe("2");
  });

  it("stops after one page when the first page already covers SearchResultCountAll", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ SearchResult: { ...page1.SearchResult, SearchResultCountAll: 2 } }),
      );
    const source = makeSource(fetchImpl);

    await source.search({ keyword: "software engineer" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops if a page comes back with zero items even though the count implies more", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(
        jsonResponse({ SearchResult: { SearchResultCountAll: 3, SearchResultItems: [] } }),
      );
    const source = makeSource(fetchImpl);

    const { jobs } = await source.search({ keyword: "software engineer" });

    expect(jobs).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("UsajobsSource — surfaces unmappable fields instead of guessing", () => {
  it("skips records whose payType/commitment/locationType cannot be determined, with reasons", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(withUnmappable));
    const source = makeSource(fetchImpl);

    const { jobs, skipped } = await source.search({ keyword: "engineer" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("900000001");

    expect(skipped).toHaveLength(3);
    const byId = new Map(skipped.map((s) => [s.externalId, s.reason]));
    expect(byId.get("900000002")).toMatch(/payType/);
    expect(byId.get("900000002")).toMatch(/Per Day/);
    expect(byId.get("900000003")).toMatch(/commitment/);
    expect(byId.get("900000003")).toMatch(/Intermittent/);
    expect(byId.get("900000004")).toMatch(/locationType/);
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

  it("classifies HTTP 403 as AuthFailedError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }));
    const source = makeSource(fetchImpl);

    await expect(source.search({})).rejects.toThrow(AuthFailedError);
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
