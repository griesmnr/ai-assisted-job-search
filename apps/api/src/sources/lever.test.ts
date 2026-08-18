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
import { LeverSource, createLeverSourceFromEnv } from "./lever.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Lever Postings API responses
// (`GET https://api.lever.co/v0/postings/{company}?mode=json`), each trimmed
// down to a handful of real records (fields untouched) — see
// __fixtures__/lever-real-response-outreach.json and
// __fixtures__/lever-real-response-palantir.json, and lever.ts's top-of-file
// comment for how they were captured and what was cross-checked before any
// mapping was written (five live boards with open postings, plus four more
// that 200'd with a legitimate empty `[]`).
//
// Outreach's three were chosen to span `salaryRange` presence (two of three
// have it, one doesn't) and `workplaceType` (`remote` and `hybrid`).
// Palantir's five were chosen to span every real `categories.commitment`
// value observed on that board: Full-time, Contractor, Internship,
// Fixed-Term, Scholarship — proving both that the values that map cleanly
// (Full-time, Contractor) do, and that the ones that don't
// (Internship/Fixed-Term/Scholarship) are left undefined rather than
// guessed at. Never hand-build a fixture for the success/skip paths below —
// derive from these files, the same discipline this project's USAJOBS
// adapter had to be rebuilt to follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LeverFixture = any[];

function loadFixture(name: string): LeverFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as LeverFixture;
}

const outreachFixture = loadFixture("lever-real-response-outreach.json");
const palantirFixture = loadFixture("lever-real-response-palantir.json");

if (outreachFixture.length !== 3) {
  throw new Error(
    `expected the outreach fixture to have 3 postings, got ${outreachFixture.length}`,
  );
}
if (palantirFixture.length !== 5) {
  throw new Error(
    `expected the palantir fixture to have 5 postings, got ${palantirFixture.length}`,
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Maps company slug -> canned Response, so tests can mock a multi-company
 * search() by slug rather than by call order. */
function fetchByCompany(responses: Record<string, () => Response>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const match = /\/postings\/([^/]+)/.exec(url.pathname);
    const company = match?.[1];
    const responder = company ? responses[company] : undefined;
    if (!responder) {
      throw new Error(`test fetch stub: no mocked response for URL ${url.toString()}`);
    }
    return responder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, companies: string[] = ["outreach"]) {
  return new LeverSource({ companies, fetchImpl });
}

describe("LeverSource — mapping against real captured responses", () => {
  it("returns a non-empty jobs array for a real response", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs } = await source.search({});

    expect(jobs.length).toBeGreaterThan(0);
  });

  it("skipRate is not 1.0 for a real response", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { skipRate } = await source.search({});

    expect(skipRate).not.toBe(1);
  });

  it("maps every real record from both fixtures into jobs, none skipped", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(outreachFixture),
      palantir: () => jsonResponse(palantirFixture),
    });
    const source = makeSource(fetchImpl, ["outreach", "palantir"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
    expect(jobs).toHaveLength(8);
  });

  it("honestly reports skipRate 1 (not a silent empty result) for records that are genuinely unmappable, with a reason that names the real cause", async () => {
    // Real Lever records are never structurally broken (verified fact about
    // this API, same as Greenhouse) so there's no real fixture that
    // provokes skipRate 1. What's genuinely unmappable is a structurally
    // broken record: no `id`, and a `createdAt` that isn't a number. Both
    // handcrafted deliberately (not derived from a fixture), because real
    // Lever responses never look like this.
    const brokenPostings = [
      { text: "Broken A", hostedUrl: "https://x/1", descriptionPlain: "hi" }, // no id
      {
        id: "abc-123",
        text: "Broken B",
        hostedUrl: "https://x/2",
        descriptionPlain: "hi",
        createdAt: "not-a-number",
      },
    ];
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(brokenPostings),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/missing id/);
    expect(skipped[1]?.reason).toMatch(/missing or non-numeric createdAt/);
  });

  it("sets company to the configured slug, since Lever's postings carry no company name field", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs } = await source.search({});

    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.company).toBe("outreach");
    }
  });

  it("uses descriptionPlain (not the HTML description) as the job description", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs } = await source.search({});

    const job = jobs.find((j) => j.externalId === "9a24e6ad-3af2-4db0-a606-672946284b40");
    expect(job).toBeDefined();
    // The real fixture's HTML `description` for this posting contains
    // markup; descriptionPlain doesn't. This proves normalizeItem actually
    // read the plain field, not the HTML one.
    expect(job?.description).not.toContain("<div>");
    expect(job?.description).not.toContain("<strong");
    expect(job?.description).toContain("Outreach, founded in 2014");
  });

  it("maps commitment from categories.commitment where it unambiguously matches Job's enum, case-insensitively", async () => {
    const fetchImpl = fetchByCompany({ palantir: () => jsonResponse(palantirFixture) });
    const source = makeSource(fetchImpl, ["palantir"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);

    const byId = new Map(jobs.map((j) => [j.externalId, j]));
    // "Full-time" (Palantir's casing, lowercase t) -> "full-time"
    expect(byId.get("1345438c-ebfc-4fa5-b545-30c1414f317c")?.commitment).toBe("full-time");
    // "Contractor" -> "contract"
    expect(byId.get("fdcbb8ff-2a38-467f-9fdf-b80e1563d863")?.commitment).toBe("contract");
    // "Internship", "Fixed-Term", "Scholarship" have no unambiguous mapping
    // onto Job's 3-value enum and must NOT be forced into the nearest
    // guess -- they stay undefined.
    expect(byId.get("774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0")?.commitment).toBeUndefined(); // Internship
    expect(byId.get("e6be4159-c8d1-481d-ad15-13274861b795")?.commitment).toBeUndefined(); // Fixed-Term
    expect(byId.get("0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0")?.commitment).toBeUndefined(); // Scholarship
  });

  it("maps commitment from Outreach's 'Full-Time' casing too (case-insensitive match)", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs } = await source.search({});
    for (const job of jobs) {
      expect(job.commitment).toBe("full-time");
    }
  });

  it("maps locationType directly from workplaceType (remote/onsite/hybrid)", async () => {
    const fetchImpl = fetchByCompany({ palantir: () => jsonResponse(palantirFixture) });
    const source = makeSource(fetchImpl, ["palantir"]);

    const { jobs } = await source.search({});
    const byId = new Map(jobs.map((j) => [j.externalId, j]));

    expect(byId.get("1345438c-ebfc-4fa5-b545-30c1414f317c")?.locationType).toBe("onsite");
    expect(byId.get("fdcbb8ff-2a38-467f-9fdf-b80e1563d863")?.locationType).toBe("hybrid");
    expect(byId.get("0ccbe620-a3ef-41d1-a5c4-68e56b3c91d0")?.locationType).toBe("remote");
  });

  it("maps payType from salaryRange.interval when present, and leaves it undefined when salaryRange is absent", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs } = await source.search({});
    const byId = new Map(jobs.map((j) => [j.externalId, j]));

    // Both have salaryRange.interval === "per-year-salary" in the real fixture.
    expect(byId.get("9a24e6ad-3af2-4db0-a606-672946284b40")?.payType).toBe("salary");
    expect(byId.get("3c27d8b2-bdef-4a0c-8507-092ef90fab33")?.payType).toBe("salary");
    // This one has no salaryRange at all in the real fixture.
    expect(byId.get("dc29c7f1-d7ef-431f-a35a-173dac2a4138")?.payType).toBeUndefined();
  });

  it("never reintroduces enum-based skipping: a record with no commitment/workplaceType/salaryRange signal at all is still returned as a job, not skipped", async () => {
    // This is the regression this change most needs protecting against: if
    // someone re-adds a check like "skip when payType/commitment/
    // locationType is undefined", this test catches it. The record below is
    // otherwise perfectly well-formed (valid id, text, hostedUrl,
    // descriptionPlain, createdAt) and carries no categories/workplaceType/
    // salaryRange that could map to any of the three enums.
    const minimalPosting = {
      id: "11111111-1111-1111-1111-111111111111",
      text: "Some Role",
      hostedUrl: "https://jobs.lever.co/acme/11111111-1111-1111-1111-111111111111",
      descriptionPlain: "Do the work.",
      createdAt: 1_700_000_000_000,
      // deliberately no categories, no workplaceType, no salaryRange
    };
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse([minimalPosting]),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(skipRate).toBe(0);
    expect(jobs[0]?.payType).toBeUndefined();
    expect(jobs[0]?.commitment).toBeUndefined();
    expect(jobs[0]?.locationType).toBeUndefined();
  });

  it("produces a stable externalId (Lever's posting id) across repeated calls, in the same order", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const first = await source.search({});
    const second = await source.search({});

    const idsFirst = [...first.jobs, ...first.skipped].map((j) => j.externalId);
    const idsSecond = [...second.jobs, ...second.skipped].map((j) => j.externalId);
    expect(idsFirst).toEqual([
      "9a24e6ad-3af2-4db0-a606-672946284b40",
      "3c27d8b2-bdef-4a0c-8507-092ef90fab33",
      "dc29c7f1-d7ef-431f-a35a-173dac2a4138",
    ]);
    expect(idsFirst).toEqual(idsSecond);
  });

  it("requests mode=json for every configured company slug, with no credentials required", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(outreachFixture),
      palantir: () => jsonResponse(palantirFixture),
    });
    const source = makeSource(fetchImpl, ["outreach", "palantir"]);

    await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [URL, RequestInit][];
    const urls = calls.map(([url]) => url);
    expect(urls.some((u) => u.pathname.includes("/postings/outreach"))).toBe(true);
    expect(urls.some((u) => u.pathname.includes("/postings/palantir"))).toBe(true);
    for (const url of urls) {
      expect(url.searchParams.get("mode")).toBe("json");
    }
  });
});

describe("LeverSource — merging across configured companies", () => {
  it("fetches every configured company and merges the results", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(outreachFixture),
      palantir: () => jsonResponse(palantirFixture),
    });
    const source = makeSource(fetchImpl, ["outreach", "palantir"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(8);
  });

  it("filters client-side by keyword (Lever's postings endpoint has no server-side search)", async () => {
    const fetchImpl = fetchByCompany({ outreach: () => jsonResponse(outreachFixture) });
    const source = makeSource(fetchImpl, ["outreach"]);

    const { jobs, skipped } = await source.search({ keyword: "Product Management" });

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("3c27d8b2-bdef-4a0c-8507-092ef90fab33");
  });

  it("filters client-side by location", async () => {
    const fetchImpl = fetchByCompany({ palantir: () => jsonResponse(palantirFixture) });
    const source = makeSource(fetchImpl, ["palantir"]);

    const { jobs, skipped } = await source.search({ location: "Paris" });

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("774cf5c9-bf6a-4d77-bf60-d50ef1beb1a0");
  });

  it("a 404 on one company is skipped (that company's board doesn't exist) without discarding results from healthy companies", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(outreachFixture),
      "does-not-exist": () =>
        new Response(JSON.stringify({ ok: false, error: "Document not found" }), { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "outreach"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(3);
  });

  it("reports skipRate 0, not NaN, when every configured company 404s (nothing at all was fetched)", async () => {
    const fetchImpl = fetchByCompany({
      "gone-1": () => new Response("Not Found", { status: 404 }),
      "gone-2": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["gone-1", "gone-2"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("a company with a real, legitimate empty board (HTTP 200, `[]`) contributes zero jobs without being treated as an error", async () => {
    // Real observed behavior: plaid, clari, highspot, and lever's own board
    // all 200'd with an empty array at the time this adapter was written —
    // a company that uses Lever but currently has no open postings, not a
    // 404 and not a malformed response.
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse(outreachFixture),
      plaid: () => jsonResponse([]),
    });
    const source = makeSource(fetchImpl, ["outreach", "plaid"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(3);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });
});

describe("LeverSource — error classification", () => {
  it("classifies HTTP 401 as AuthFailedError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => new Response("Unauthorized", { status: 401 }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).kind).toBe("auth-failed");
    expect((err as AuthFailedError).retryable).toBe(false);
  });

  it("classifies HTTP 403 as ForbiddenError, distinct from AuthFailedError, and retryable", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => new Response("<html>blocked</html>", { status: 403 }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err).not.toBeInstanceOf(AuthFailedError);
    expect((err as ForbiddenError).retryable).toBe(true);
  });

  it("classifies HTTP 429 as RateLimitedError (retryable) and reads Retry-After", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "12" } }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryable).toBe(true);
    expect((err as RateLimitedError).retryAfterMs).toBe(12_000);
  });

  it("classifies HTTP 500/503 as TransientSourceError (retryable)", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).retryable).toBe(true);
  });

  it("classifies a network failure (fetch rejects) as TransientSourceError", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientSourceError);
    expect((err as TransientSourceError).cause).toBeInstanceOf(Error);
  });

  it("classifies invalid JSON as MalformedResponseError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => new Response("not json{{{", { status: 200 }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
    expect((err as MalformedResponseError).retryable).toBe(false);
  });

  it("classifies well-formed JSON with an unexpected shape (not an array) as MalformedResponseError", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => jsonResponse({ notWhatWeExpected: true }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
  });

  it("a lone 404'd company resolves to an empty (not thrown) result", async () => {
    // 404 is classified as UnexpectedStatusError (same as any other
    // unmapped 4xx — see the 400 test below), but search() specifically
    // catches status 404 at the orchestration layer and treats it as "this
    // company has no board, move on" rather than rethrowing — see the doc
    // comment in LeverSource#search. So even with only one (bad) company
    // configured, search() resolves normally instead of rejecting.
    const fetchImpl = fetchByCompany({
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist"]);

    const result = await source.search({});
    expect(result).toEqual({ jobs: [], skipped: [], skipRate: 0 });
  });

  it("classifies an unmapped 4xx status (400) as UnexpectedStatusError (not retryable)", async () => {
    const fetchImpl = fetchByCompany({
      outreach: () => new Response("Bad Request", { status: 400 }),
    });
    const source = makeSource(fetchImpl, ["outreach"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatusError);
    expect((err as UnexpectedStatusError).status).toBe(400);
    expect((err as UnexpectedStatusError).retryable).toBe(false);
  });
});

describe("LeverSource construction", () => {
  it("throws when constructed with an empty companies list", () => {
    expect(() => new LeverSource({ companies: [] })).toThrow(/at least one company slug/);
  });
});

describe("createLeverSourceFromEnv", () => {
  it("throws when LEVER_COMPANIES is missing", () => {
    expect(() => createLeverSourceFromEnv({})).toThrow(/LEVER_COMPANIES/);
  });

  it("throws when LEVER_COMPANIES is empty/whitespace", () => {
    expect(() => createLeverSourceFromEnv({ LEVER_COMPANIES: "  , ," })).toThrow(/LEVER_COMPANIES/);
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const source = createLeverSourceFromEnv({
      LEVER_COMPANIES: " outreach, palantir ,wealthfront",
    });
    expect(source.dataSource).toBe("lever");
  });
});
