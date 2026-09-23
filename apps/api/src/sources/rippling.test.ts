import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { htmlToPlainText } from "./html.js";
import { RipplingSource, createRipplingSourceFromEnv } from "./rippling.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Rippling ATS board responses against the
// `rippling` board itself (the one board confirmed live before this ticket
// started — see rippling.ts's top-of-file comment). The list fixture is a
// trimmed 14-row subset of the real 612-row board response, deliberately
// keeping ALL FIVE rows for one real multi-location job (the "Accounting
// Manager" posting, uuid `19ae5b34-...`) so the list-level dedup-by-uuid
// behavior (Finding 1) is exercised against real duplicated data, not a
// hand-built stand-in. The empty-board fixture is the real captured
// response from a different, real Rippling board
// (`career-opportunities`/CircleBlack, verified live 2026-09-23) that
// genuinely has zero current postings. The 404 fixture is the real body
// Rippling returns for an unrecognized board slug. Never hand-build a
// fixture for the success/skip paths below — derive from these files, the
// same discipline this project's USAJOBS adapter had to be rebuilt to
// follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

const listFixture = loadFixture("rippling-real-response-rippling-list.json");
const emptyBoardFixture = loadFixture("rippling-real-response-empty-board-list.json");
const unknownBoard404 = loadFixture("rippling-real-response-unknown-board-404.json");

const detailAccountExecutive = loadFixture(
  "rippling-real-response-rippling-detail-account-executive.json",
);
const detailAccountingManager = loadFixture(
  "rippling-real-response-rippling-detail-accounting-manager.json",
);
const detailRemoteSalaried = loadFixture(
  "rippling-real-response-rippling-detail-remote-salaried.json",
);
const detailHybrid = loadFixture("rippling-real-response-rippling-detail-hybrid.json");
const detailContractor = loadFixture("rippling-real-response-rippling-detail-contractor.json");
const detailHourly = loadFixture("rippling-real-response-rippling-detail-hourly.json");
const detailInternTemp = loadFixture("rippling-real-response-rippling-detail-intern-temp.json");
const detailOnsiteWithPayrange = loadFixture(
  "rippling-real-response-rippling-detail-onsite-with-payrange.json",
);

if (listFixture.length !== 14) {
  throw new Error(`expected the list fixture to have 14 rows, got ${listFixture.length}`);
}
const distinctUuidsInFixture = new Set(listFixture.map((r: { uuid: string }) => r.uuid));
if (distinctUuidsInFixture.size !== 8) {
  throw new Error(
    `expected the list fixture to have 8 distinct jobs, got ${distinctUuidsInFixture.size}`,
  );
}
if (emptyBoardFixture.length !== 0) {
  throw new Error(
    `expected the empty-board fixture to be an empty array, got ${emptyBoardFixture.length}`,
  );
}
if (unknownBoard404.error_code !== "RESOURCE_NOT_FOUND") {
  throw new Error(`expected the 404 fixture to carry error_code RESOURCE_NOT_FOUND`);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Detail fixtures keyed by their real uuid, for routing a mocked
 * board-detail request regardless of which board slug the test configures. */
const DETAIL_BY_UUID: Record<string, unknown> = {
  "75ad50c6-778f-42ee-9c63-70d1cd687202": detailAccountExecutive,
  "19ae5b34-e7b7-4164-99d4-fc8f84bb37fe": detailAccountingManager,
  "00dbe4a0-da1e-4696-8c15-d4724a402c42": detailRemoteSalaried,
  "88c20f14-ecec-4d0d-8aa9-f82c27d99bc6": detailHybrid,
  "53cc061e-eaef-49aa-a75b-9a1466eaac27": detailContractor,
  "5b7d6034-da86-443e-a07a-07b37cd20287": detailHourly,
  "82c13e8f-ae96-4c60-a872-c0ddf9eb0781": detailInternTemp,
  "b16e994c-8511-4210-8d21-d343d5a25641": detailOnsiteWithPayrange,
};

/** Routes a mocked fetch by URL: board list (`/board/{slug}/jobs`) or
 * posting detail (`/board/{slug}/jobs/{uuid}`) — so a single fetchImpl can
 * drive a full multi-board, detail-fetching `search()` call. `lists` maps a
 * board slug to a responder for its list request; `details`, if given,
 * overrides the default (real-fixture-backed) per-uuid detail responder for
 * specific uuids. */
function makeFetch(config: {
  lists: Record<string, () => Response>;
  details?: Record<string, () => Response>;
}): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));

    const detailMatch = /\/board\/([^/]+)\/jobs\/([^/?]+)/.exec(url.pathname);
    if (detailMatch) {
      const uuid = detailMatch[2] as string;
      const override = config.details?.[uuid];
      if (override) return override();
      const fixture = DETAIL_BY_UUID[uuid];
      if (fixture) return jsonResponse(fixture);
      throw new Error(`test fetch stub: no mocked detail response for uuid "${uuid}"`);
    }

    const listMatch = /\/board\/([^/]+)\/jobs/.exec(url.pathname);
    if (listMatch) {
      const boardSlug = listMatch[1] as string;
      const responder = config.lists[boardSlug];
      if (!responder) {
        throw new Error(`test fetch stub: no mocked list response for board "${boardSlug}"`);
      }
      return responder();
    }

    throw new Error(`test fetch stub: unrecognized URL ${url.toString()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, boardSlugs: string[] = ["rippling"], overrides = {}) {
  return new RipplingSource({ boardSlugs, fetchImpl, ...overrides });
}

// ---------------------------------------------------------------------------
// THE CENTRAL FINDING OF THIS TICKET: an unrecognized board slug returns a
// CLEAN 404 (`{"error_code":"RESOURCE_NOT_FOUND", ...}`), distinct from a
// real board with genuinely zero current postings (HTTP 200, `[]`) — see
// rippling.ts's top-of-file comment. Both are real, live-verified
// 2026-09-23, not assumed.
// ---------------------------------------------------------------------------
describe("RipplingSource — distinguishing an unrecognized board from a real one with no openings", () => {
  it("an unrecognized board slug is reported as not-found via tokenOutcomes, not a silent empty result", async () => {
    const fetchImpl = makeFetch({
      lists: {
        "this-company-definitely-does-not-exist-12345": () =>
          new Response(JSON.stringify(unknownBoard404), { status: 404 }),
      },
    });
    const source = makeSource(fetchImpl, ["this-company-definitely-does-not-exist-12345"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.tokenOutcomes).toEqual([
      {
        token: "this-company-definitely-does-not-exist-12345",
        status: "not-found",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
    ]);
  });

  it("a real board with genuinely zero current openings is reported as empty, not not-found", async () => {
    const fetchImpl = makeFetch({
      lists: {
        "career-opportunities": () => jsonResponse(emptyBoardFixture),
      },
    });
    const source = makeSource(fetchImpl, ["career-opportunities"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.tokenOutcomes).toEqual([
      {
        token: "career-opportunities",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
    ]);
  });

  it("the two zero-postings cases produce genuinely different SourceSearchResults side by side", async () => {
    const fetchImpl = makeFetch({
      lists: {
        "career-opportunities": () => jsonResponse(emptyBoardFixture),
        "totally-bogus-slug-xyz": () =>
          new Response(JSON.stringify(unknownBoard404), { status: 404 }),
      },
    });
    const source = makeSource(fetchImpl, ["career-opportunities", "totally-bogus-slug-xyz"]);

    const result = await source.search({});

    const outcomes = new Map(result.tokenOutcomes!.map((o) => [o.token, o.status]));
    expect(outcomes.get("career-opportunities")).toBe("empty");
    expect(outcomes.get("totally-bogus-slug-xyz")).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// Non-empty assertion: a real fixture with a known number of distinct
// postings yields exactly that many jobs.
// ---------------------------------------------------------------------------
describe("RipplingSource — a real board's list yields the right number of jobs", () => {
  it("the 14-row/8-distinct-uuid list fixture yields exactly 8 jobs, deduplicated by uuid", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(8);
    const externalIds = result.jobs.map((j) => j.externalId).sort();
    expect(externalIds).toEqual(
      [
        "75ad50c6-778f-42ee-9c63-70d1cd687202",
        "19ae5b34-e7b7-4164-99d4-fc8f84bb37fe",
        "b16e994c-8511-4210-8d21-d343d5a25641",
        "00dbe4a0-da1e-4696-8c15-d4724a402c42",
        "5b7d6034-da86-443e-a07a-07b37cd20287",
        "88c20f14-ecec-4d0d-8aa9-f82c27d99bc6",
        "82c13e8f-ae96-4c60-a872-c0ddf9eb0781",
        "53cc061e-eaef-49aa-a75b-9a1466eaac27",
      ].sort(),
    );
  });

  it("the Accounting Manager job (5 duplicate list rows, one per location) produces exactly ONE job, not 5", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    const accountingManagerJobs = result.jobs.filter(
      (j) => j.externalId === "19ae5b34-e7b7-4164-99d4-fc8f84bb37fe",
    );
    expect(accountingManagerJobs).toHaveLength(1);
  });

  it("reports the RAW (pre-dedup... no, pre-filter) posting count on tokenOutcomes as the deduplicated count (8), not the raw row count (14)", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.tokenOutcomes).toHaveLength(1);
    expect(result.tokenOutcomes![0]).toMatchObject({
      token: "rippling",
      status: "ok",
      postingCount: 8,
    });
  });

  it("dedupes by uuid, not by name — two DISTINCT postings that happen to share a title stay two jobs (opus review, ticket a14e3e7)", async () => {
    // Regression for a real gap the review found: mutating the dedup key
    // from `row.uuid` to `row.name` still passed every other test here,
    // because the 8 distinct uuids in listFixture happen to have 8
    // distinct names too. On the live `rippling` board itself, 8 titles
    // are each shared by 2-3 genuinely different uuids today (e.g.
    // "Senior Staff Software Engineer" x3) -- a name-keyed dedup would
    // silently collapse those into one job apiece. This constructs that
    // exact shape: two rows, identical `name`, different `uuid`, each
    // with its own real detail fixture, and asserts both survive.
    const sharedTitle = "Senior Staff Software Engineer";
    const twinListFixture = [
      {
        uuid: "75ad50c6-778f-42ee-9c63-70d1cd687202",
        name: sharedTitle,
        department: { id: "Engineering", label: "Engineering" },
        url: "https://ats.rippling.com/rippling/jobs/75ad50c6-778f-42ee-9c63-70d1cd687202",
        workLocation: { label: "Austin, TX", id: "Austin, TX" },
      },
      {
        uuid: "00dbe4a0-da1e-4696-8c15-d4724a402c42",
        name: sharedTitle,
        department: { id: "Engineering", label: "Engineering" },
        url: "https://ats.rippling.com/rippling/jobs/00dbe4a0-da1e-4696-8c15-d4724a402c42",
        workLocation: { label: "Remote", id: "Remote" },
      },
    ];
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(twinListFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(2);
    const externalIds = result.jobs.map((j) => j.externalId).sort();
    expect(externalIds).toEqual(
      ["75ad50c6-778f-42ee-9c63-70d1cd687202", "00dbe4a0-da1e-4696-8c15-d4724a402c42"].sort(),
    );
    // Title comes from each posting's own detail fetch, not the list row's
    // `name` (see the two real, DIFFERENT detail fixtures reused above) --
    // the point of this test is the count/distinctness by uuid, not title
    // equality, so assert distinctness rather than the (irrelevant, and
    // here actually different) title value.
    expect(new Set(result.jobs.map((j) => j.title)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Description survives into the normalized job — and a naive implementation
// that reads only one of the two real description sections FAILS this
// assertion, demonstrating why buildDescription folds both in. Not just
// asserted — actually shown to fail against a stub.
// ---------------------------------------------------------------------------
describe("RipplingSource — requisition text reaches description", () => {
  it("includes real role-specific requirement text from the posting detail's description.role section", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () =>
          jsonResponse(
            listFixture.filter(
              (r: { uuid: string }) => r.uuid === "19ae5b34-e7b7-4164-99d4-fc8f84bb37fe",
            ),
          ),
      },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(1);
    // Pulled directly from the real captured detail fixture's `role` HTML —
    // role-specific text that does NOT appear in the generic "About
    // Rippling" company section (verified: the company section is
    // byte-identical boilerplate shared by every posting on this board).
    const roleText: string = detailAccountingManager.description.role;
    expect(roleText).toContain("Accounting");
    const plainRoleText = htmlToPlainText(roleText);
    // Pick a substring that is genuinely unique to the role section, not
    // generic filler that might coincidentally also appear in the company
    // blurb.
    const distinctiveSnippet = plainRoleText.split("\n").find((line) => line.length > 30);
    expect(distinctiveSnippet).toBeTruthy();
    expect(result.jobs[0]!.description).toContain(distinctiveSnippet);
  });

  it("a naive implementation that reads only description.company (drops description.role entirely) FAILS to include the same role-specific text — demonstrating why buildDescription folds both sections in", () => {
    // This mirrors real production code's buildDescription EXCEPT it drops
    // the `role` section — the same class of bug SmartRecruiters' own test
    // suite demonstrates for `qualifications`/`additionalInformation`.
    function naiveBuildDescription(detail: typeof detailAccountingManager): string {
      const company = detail.description?.company;
      return typeof company === "string" ? htmlToPlainText(company) : "";
    }

    const fullDescription = htmlToPlainText(detailAccountingManager.description.role);
    const distinctiveSnippet = fullDescription.split("\n").find((line) => line.length > 30);
    expect(distinctiveSnippet).toBeTruthy();

    const naiveDescription = naiveBuildDescription(detailAccountingManager);

    // The real, full implementation includes it (already proven above); the
    // naive one that drops `role` does not — this is the failing-stub
    // demonstration the ticket requires, not just an assertion against the
    // real implementation.
    expect(naiveDescription).not.toContain(distinctiveSnippet);
  });

  it("includes the generic company-boilerplate text too (description.company), not just the role section", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () =>
          jsonResponse(
            listFixture.filter(
              (r: { uuid: string }) => r.uuid === "75ad50c6-778f-42ee-9c63-70d1cd687202",
            ),
          ),
      },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(1);
    const companyText = htmlToPlainText(detailAccountExecutive.description.company);
    const distinctiveSnippet = companyText.split("\n").find((line) => line.length > 30);
    expect(distinctiveSnippet).toBeTruthy();
    expect(result.jobs[0]!.description).toContain(distinctiveSnippet);
  });
});

// ---------------------------------------------------------------------------
// locationType classification (Finding 2): unanimous kind across every
// resolved location -> that kind; anything mixed or absent -> undefined,
// never a guess.
// ---------------------------------------------------------------------------
describe("RipplingSource — locationType classification", () => {
  function searchOne(uuid: string) {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () => jsonResponse(listFixture.filter((r: { uuid: string }) => r.uuid === uuid)),
      },
    });
    return makeSource(fetchImpl).search({});
  }

  it("a posting whose every location is a plain city maps to onsite", async () => {
    const result = await searchOne("b16e994c-8511-4210-8d21-d343d5a25641");
    expect(result.jobs[0]!.locationType).toBe("onsite");
    expect(result.jobs[0]!.location).toBe("San Francisco, CA");
  });

  it("a posting whose every location starts with 'Remote' maps to remote", async () => {
    const result = await searchOne("00dbe4a0-da1e-4696-8c15-d4724a402c42");
    expect(result.jobs[0]!.locationType).toBe("remote");
  });

  it("a posting whose every location starts with 'Hybrid' maps to hybrid", async () => {
    const result = await searchOne("88c20f14-ecec-4d0d-8aa9-f82c27d99bc6");
    expect(result.jobs[0]!.locationType).toBe("hybrid");
  });

  it("a posting mixing remote and onsite locations (a real shape: 4 cities + 'Remote (United States)') maps to undefined, not a guess", async () => {
    const result = await searchOne("19ae5b34-e7b7-4164-99d4-fc8f84bb37fe");
    expect(result.jobs[0]!.locationType).toBeUndefined();
    // location itself is still populated with the full real set, even
    // though locationType can't unambiguously classify it.
    expect(result.jobs[0]!.location).toContain("Remote (United States)");
    expect(result.jobs[0]!.location).toContain("Austin, TX");
  });
});

// ---------------------------------------------------------------------------
// payType / commitment mapping off employmentType.label (the MACHINE code —
// note the real id/label swap documented in rippling.ts).
// ---------------------------------------------------------------------------
describe("RipplingSource — payType and commitment mapping", () => {
  function searchOne(uuid: string) {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () => jsonResponse(listFixture.filter((r: { uuid: string }) => r.uuid === uuid)),
      },
    });
    return makeSource(fetchImpl).search({});
  }

  it("SALARIED_FT maps to payType 'salary' and commitment 'full-time'", async () => {
    const result = await searchOne("b16e994c-8511-4210-8d21-d343d5a25641");
    expect(result.jobs[0]!.payType).toBe("salary");
    expect(result.jobs[0]!.commitment).toBe("full-time");
  });

  it("HOURLY_FT maps to payType 'hourly' and commitment 'full-time'", async () => {
    const result = await searchOne("5b7d6034-da86-443e-a07a-07b37cd20287");
    expect(result.jobs[0]!.payType).toBe("hourly");
    expect(result.jobs[0]!.commitment).toBe("full-time");
  });

  it("CONTRACTOR maps to commitment 'contract' and payType undefined", async () => {
    const result = await searchOne("53cc061e-eaef-49aa-a75b-9a1466eaac27");
    expect(result.jobs[0]!.commitment).toBe("contract");
    expect(result.jobs[0]!.payType).toBeUndefined();
  });

  it("TEMP (temp/intern) maps to commitment undefined, not forced into full-time or contract", async () => {
    const result = await searchOne("82c13e8f-ae96-4c60-a872-c0ddf9eb0781");
    expect(result.jobs[0]!.commitment).toBeUndefined();
    expect(result.jobs[0]!.payType).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// skipRate semantics — matching greenhouse.ts/ashby.ts's convention:
// skipped.length / (jobs.length + skipped.length), 0 when nothing was found
// at all.
// ---------------------------------------------------------------------------
describe("RipplingSource — skipRate semantics", () => {
  it("is 0 for an all-success result", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.skipRate).toBe(0);
  });

  it("is 0 when a board is entirely empty (no jobs, no skips — a legitimate empty result, not a skip)", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(emptyBoardFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.skipRate).toBe(0);
    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("is a fraction, not 0 or 1, when some postings map and one detail fetch fails", async () => {
    const fetchImpl = makeFetch({
      lists: { rippling: () => jsonResponse(listFixture) },
      details: {
        "53cc061e-eaef-49aa-a75b-9a1466eaac27": () => new Response("not json", { status: 200 }),
      },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(7);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipRate).toBeCloseTo(1 / 8);
  });
});

// ---------------------------------------------------------------------------
// Per-board failure isolation: one bad/no-board slug must not fail the
// whole search when multiple boards are configured.
// ---------------------------------------------------------------------------
describe("RipplingSource — per-board failure isolation", () => {
  it("one board's 404 does not prevent another configured board's jobs from being returned", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () => jsonResponse(listFixture),
        "bogus-slug": () => new Response(JSON.stringify(unknownBoard404), { status: 404 }),
      },
    });
    const source = makeSource(fetchImpl, ["rippling", "bogus-slug"]);

    const result = await source.search({});

    expect(result.jobs.length).toBeGreaterThan(0);
    const outcomes = new Map(result.tokenOutcomes!.map((o) => [o.token, o.status]));
    expect(outcomes.get("rippling")).toBe("ok");
    expect(outcomes.get("bogus-slug")).toBe("not-found");
  });

  it("one board's transient/server-error failure does not prevent another configured board's jobs from being returned", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () => jsonResponse(listFixture),
        "flaky-board": () => new Response("server error", { status: 503 }),
      },
    });
    const source = makeSource(fetchImpl, ["rippling", "flaky-board"]);

    const result = await source.search({});

    expect(result.jobs.length).toBeGreaterThan(0);
    const outcomes = new Map(result.tokenOutcomes!.map((o) => [o.token, o.status]));
    expect(outcomes.get("rippling")).toBe("ok");
    expect(outcomes.get("flaky-board")).toBe("error");
  });

  it("a per-posting detail fetch failure is skipped individually, not fatal to the rest of the board", async () => {
    const fetchImpl = makeFetch({
      lists: { rippling: () => jsonResponse(listFixture) },
      details: {
        "82c13e8f-ae96-4c60-a872-c0ddf9eb0781": () => new Response("boom", { status: 500 }),
      },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs).toHaveLength(7);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("82c13e8f-ae96-4c60-a872-c0ddf9eb0781");
  });
});

// ---------------------------------------------------------------------------
// criteria filtering: location is safe to apply before the detail fetch
// (Finding 2); keyword must wait for the full assembled description
// (Finding 4).
// ---------------------------------------------------------------------------
describe("RipplingSource — criteria filtering", () => {
  it("filters by location before the detail fetch — postings with no matching location never trigger a detail request", async () => {
    const detailSpy = vi.fn();
    const fetchImpl = makeFetch({
      lists: { rippling: () => jsonResponse(listFixture) },
    });
    const wrapped: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (/\/jobs\/[^/?]+$/.test(url.pathname)) detailSpy(url.pathname);
      return fetchImpl(input, init);
    };

    const source = makeSource(wrapped);
    const result = await source.search({ location: "Bangalore" });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.externalId).toBe("53cc061e-eaef-49aa-a75b-9a1466eaac27");
    // Only the one matching posting's detail should have been fetched.
    expect(detailSpy).toHaveBeenCalledTimes(1);
  });

  it("filters by keyword AFTER the detail fetch, so a keyword that exists only in the role description text still matches", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () =>
          jsonResponse(
            listFixture.filter(
              (r: { uuid: string }) => r.uuid === "19ae5b34-e7b7-4164-99d4-fc8f84bb37fe",
            ),
          ),
      },
    });
    const source = makeSource(fetchImpl);

    const fullDescription = htmlToPlainText(detailAccountingManager.description.role);
    // Pick a real word from the role text that is not in the job's title
    // ("Accounting Manager") and would only be found by reading the full
    // description.
    const words = fullDescription.split(/\W+/).filter((w) => w.length > 6);
    const keyword = words.find((w) => !"accounting manager".includes(w.toLowerCase()));
    expect(keyword).toBeTruthy();

    const result = await source.search({ keyword: keyword! });

    expect(result.jobs).toHaveLength(1);
  });

  it("a keyword with no match anywhere (title or full description) is filtered out, not skipped", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({ keyword: "zzz-no-such-keyword-anywhere-xyz" });

    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.skipRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// maxPostings budget: a search truncated by the shared budget reports the
// truncation, rather than silently returning a short result.
// ---------------------------------------------------------------------------
describe("RipplingSource — maxPostings cap", () => {
  it("truncates a candidate pool larger than maxPostings and REPORTS the truncation", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl, ["rippling"], { maxPostings: 3 });

    const result = await source.search({});

    expect(result.jobs).toHaveLength(3);
    expect(result.skipped.some((s) => s.reason.includes("truncated"))).toBe(true);
    // The board's own raw posting count is still accurately reported even
    // though the detail fan-out was capped.
    expect(result.tokenOutcomes![0]).toMatchObject({
      token: "rippling",
      status: "ok",
      postingCount: 8,
    });
  });

  it("does not truncate (and reports no truncation skip) when the candidate pool fits within maxPostings", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl, ["rippling"], { maxPostings: 1000 });

    const result = await source.search({});

    expect(result.jobs).toHaveLength(8);
    expect(result.skipped.some((s) => s.reason.includes("truncated"))).toBe(false);
  });

  it("falls back to the default cap when maxPostings is negative, rather than silently disabling the cap", async () => {
    // Asserted behaviorally, not by reaching into the private field: a
    // negative maxPostings must NOT cap the board down to near-zero jobs —
    // it should fall back to DEFAULT_MAX_POSTINGS (1,000), comfortably
    // above this 8-job fixture.
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = new RipplingSource({ boardSlugs: ["rippling"], fetchImpl, maxPostings: -5 });
    const result = await source.search({});
    expect(result.jobs).toHaveLength(8);
  });

  it("falls back to the default cap when maxPostings is NaN, rather than silently disabling the cap", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = new RipplingSource({ boardSlugs: ["rippling"], fetchImpl, maxPostings: NaN });
    const result = await source.search({});
    expect(result.jobs).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// createRipplingSourceFromEnv
// ---------------------------------------------------------------------------
describe("createRipplingSourceFromEnv", () => {
  it("throws synchronously when RIPPLING_COMPANIES is unset", () => {
    expect(() => createRipplingSourceFromEnv({})).toThrow(/RIPPLING_COMPANIES/);
  });

  it("parses a comma-separated, whitespace-trimmed board slug list", () => {
    const source = createRipplingSourceFromEnv({
      RIPPLING_COMPANIES: " rippling , carbon-health ",
    });
    expect(source.dataSource).toBe("rippling");
  });

  it("the parsed slug list drives real per-board requests, in order", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () => jsonResponse(listFixture),
        "carbon-health": () => jsonResponse([]),
      },
    });
    const source = new RipplingSource({ boardSlugs: ["rippling", "carbon-health"], fetchImpl });

    const result = await source.search({});

    const tokens = result.tokenOutcomes!.map((o) => o.token);
    expect(tokens).toEqual(["rippling", "carbon-health"]);
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------
describe("RipplingSource — error classification", () => {
  it("a malformed (non-array) list response is classified, not silently treated as empty", async () => {
    const fetchImpl = makeFetch({
      lists: { rippling: () => jsonResponse({ not: "an array" }) },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.tokenOutcomes![0]).toMatchObject({ token: "rippling", status: "error" });
    expect(result.tokenOutcomes![0]!.message).toMatch(/expected a bare JSON array/);
  });

  it("classifies a 429 on a board's list request, isolated to that board", async () => {
    const fetchImpl = makeFetch({
      lists: {
        rippling: () =>
          new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      },
    });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.tokenOutcomes![0]).toMatchObject({ token: "rippling", status: "error" });
    expect(result.tokenOutcomes![0]!.message).toMatch(/429/);
  });
});

// ---------------------------------------------------------------------------
// dataSource tag
// ---------------------------------------------------------------------------
describe("RipplingSource — dataSource", () => {
  it("tags every normalized job with dataSource 'rippling'", async () => {
    const fetchImpl = makeFetch({ lists: { rippling: () => jsonResponse(listFixture) } });
    const source = makeSource(fetchImpl);

    const result = await source.search({});

    expect(result.jobs.length).toBeGreaterThan(0);
    for (const job of result.jobs) {
      expect(job.dataSource).toBe("rippling");
    }
  });
});
