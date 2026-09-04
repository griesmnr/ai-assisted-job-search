import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AuthFailedError, MalformedResponseError, UnexpectedStatusError } from "./types.js";
import { GreenhouseSource, createGreenhouseSourceFromEnv, htmlToPlainText } from "./greenhouse.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured Greenhouse Job Board API responses, each
// trimmed down to a handful of real records (fields untouched) — see
// __fixtures__/greenhouse-real-response-discord.json and
// __fixtures__/greenhouse-real-response-airbnb.json, and this adapter's
// top-of-file comment for how they were captured and what they were
// checked against (nine live boards, ~1,500 postings, before any mapping
// was written). Discord's records have no "Workplace Type" metadata
// (locationType unmappable); Airbnb's three were chosen specifically
// because they *do* have it, one each of Remote/Hybrid/Onsite, to prove
// that part of the mapper actually works. Never hand-build a fixture for
// the success/skip paths below — derive from these files, the same
// discipline this project's USAJOBS adapter had to be rebuilt to follow.
// ---------------------------------------------------------------------------

type GreenhouseFixture = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jobs: any[];
};

function loadFixture(name: string): GreenhouseFixture {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8")) as GreenhouseFixture;
}

const discordFixture = loadFixture("greenhouse-real-response-discord.json");
const airbnbFixture = loadFixture("greenhouse-real-response-airbnb.json");

if (discordFixture.jobs.length !== 3) {
  throw new Error(`expected the discord fixture to have 3 jobs, got ${discordFixture.jobs.length}`);
}
if (airbnbFixture.jobs.length !== 3) {
  throw new Error(`expected the airbnb fixture to have 3 jobs, got ${airbnbFixture.jobs.length}`);
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** Maps board token -> canned Response (or a promise of one, for tests
 * that need to control WHEN a token's fetch resolves -- see the 429
 * concurrency test below), so tests can mock a multi-token search() by
 * token rather than by call order. */
function fetchByToken(responses: Record<string, () => Response | Promise<Response>>): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const match = /\/boards\/([^/]+)\/jobs/.exec(url.pathname);
    const token = match?.[1];
    const responder = token ? responses[token] : undefined;
    if (!responder) {
      throw new Error(`test fetch stub: no mocked response for URL ${url.toString()}`);
    }
    return responder();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, boardTokens: string[] = ["discord"]) {
  return new GreenhouseSource({ boardTokens, fetchImpl });
}

describe("GreenhouseSource — mapping against real captured responses", () => {
  // -------------------------------------------------------------------
  // THE CENTRAL FINDING OF THIS TICKET, verified against real data:
  //
  // Greenhouse's public Job Board API carries no compensation (payType)
  // and no employment-type (commitment) data anywhere — not for Discord,
  // not for Airbnb, not for any of the seven other real boards checked
  // during development (stripe, figma, robinhood, coinbase, asana,
  // webflow, gitlab). That used to mean every real record was unmappable
  // and landed in `skipped`, because `payType`/`commitment`/`locationType`
  // were required fields on `Job` and an absent enum was treated as a
  // normalization failure.
  //
  // The project owner has since made those three fields optional on `Job`
  // (see packages/shared/src/index.ts): "not stated" is the honest
  // representation of a posting that simply doesn't state it, and forcing
  // a guess to fill a required enum was exactly the mistake this project's
  // USAJOBS post-mortem warned against. `normalizeItem` in greenhouse.ts no
  // longer treats a missing/unmappable enum as a skip condition — a record
  // only lands in `skipped` for a structural reason (no id, unparseable
  // date, etc.). Measured against these real fixtures, that means every
  // record in both boards below now normalizes successfully: airbnb -> 3
  // jobs, 0 skipped; discord -> 3 jobs, 0 skipped.
  //
  // The tests below assert that current contract: real records come back
  // as `jobs` with `payType`/`commitment` undefined (Greenhouse never
  // supplies them) and `locationType` populated only where the source
  // actually offers it (Airbnb's custom "Workplace Type" metadata). A
  // dedicated regression test further down (see "never reintroduces
  // enum-based skipping") pins down that absence of these enums must never
  // cause a skip again.
  // -------------------------------------------------------------------
  it("returns a non-empty jobs array for a real response", async () => {
    const fetchImpl = fetchByToken({ discord: () => jsonResponse(discordFixture) });
    const source = makeSource(fetchImpl, ["discord"]);

    const { jobs } = await source.search({});

    expect(jobs.length).toBeGreaterThan(0);
  });

  it("skipRate is not 1.0 for a real response", async () => {
    const fetchImpl = fetchByToken({ discord: () => jsonResponse(discordFixture) });
    const source = makeSource(fetchImpl, ["discord"]);

    const { skipRate } = await source.search({});

    expect(skipRate).not.toBe(1);
  });

  it("honestly reports skipRate 1 (not a silent empty result) for records that are genuinely unmappable, with a reason that names the real cause", async () => {
    // The property under test is the adapter's honesty about *total*
    // mapping failure, not any particular enum. Real Greenhouse records
    // are never structurally broken (that's a documented, verified fact
    // about the API — see this file's top-of-file comment) so there is no
    // real fixture that provokes skipRate 1 anymore. What's genuinely
    // unmappable now is a structurally broken record: no `id` at all, and
    // a `first_published` value that isn't a parseable date. Both are
    // handcrafted here deliberately (not derived from a fixture) because
    // real Greenhouse responses never look like this — that's the point.
    const brokenJobs = [
      { title: "Broken A", company_name: "Acme", absolute_url: "https://x/1" }, // no id
      {
        id: 42,
        title: "Broken B",
        company_name: "Acme",
        absolute_url: "https://x/2",
        content: "<p>hi</p>",
        first_published: "not-a-date",
      },
    ];
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse({ jobs: brokenJobs }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(2);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/missing id/);
    expect(skipped[1]?.reason).toMatch(/unparseable first_published/);
  });

  it("attributes skippedCount to the token that produced it (ticket b723fb9 review recommendation: skipRate dilutes across a wide token list, skippedCount doesn't)", async () => {
    const brokenJobs = [
      { title: "Broken A", company_name: "Acme", absolute_url: "https://x/1" }, // no id
    ];
    const fetchImpl = fetchByToken({
      "broken-board": () => jsonResponse({ jobs: brokenJobs }),
      discord: () => jsonResponse(discordFixture),
    });
    const source = makeSource(fetchImpl, ["broken-board", "discord"]);

    const { tokenOutcomes } = await source.search({});

    const brokenOutcome = tokenOutcomes!.find((o) => o.token === "broken-board");
    const discordOutcome = tokenOutcomes!.find((o) => o.token === "discord");
    // The broken record's skip is attributed to "broken-board" alone —
    // "discord" (a healthy board fetched in the same search()) reads 0,
    // not diluted by the other token's failure.
    expect(brokenOutcome?.skippedCount).toBe(1);
    expect(discordOutcome?.skippedCount).toBe(0);
  });

  it("maps locationType from Airbnb's real 'Workplace Type' metadata (Remote/Hybrid/Onsite) onto the returned jobs", async () => {
    const fetchImpl = fetchByToken({ airbnb: () => jsonResponse(airbnbFixture) });
    const source = makeSource(fetchImpl, ["airbnb"]);

    const { jobs, skipped } = await source.search({});

    // All three real Airbnb records normalize successfully now — no
    // structural problems, and enums are no longer a skip condition.
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(3);

    const byId = new Map(jobs.map((j) => [j.externalId, j]));
    // One of each Remote/Hybrid/Onsite, matching the fixture's real
    // "Workplace Type" metadata values for these three ids.
    expect(byId.get("7995153")?.locationType).toBe("hybrid");
    expect(byId.get("8067991")?.locationType).toBe("onsite");
    expect(byId.get("8043588")?.locationType).toBe("remote");

    // payType/commitment stay undefined -- Greenhouse never supplies
    // them, but that's no longer a reason these jobs would be skipped.
    for (const job of jobs) {
      expect(job.payType).toBeUndefined();
      expect(job.commitment).toBeUndefined();
    }
  });

  it("maps every real record from both fixtures into jobs, none skipped, with locationType undefined where Greenhouse offers no equivalent (Discord)", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
      airbnb: () => jsonResponse(airbnbFixture),
    });
    const source = makeSource(fetchImpl, ["discord", "airbnb"]);

    const { jobs, skipped } = await source.search({});
    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(6);

    // Discord's board asks no equivalent of Airbnb's "Workplace Type"
    // question, so locationType falls through to undefined for all three
    // of its records -- that's expected, not a failure.
    const discordJobs = jobs.filter((j) => j.company === "Discord");
    expect(discordJobs).toHaveLength(3);
    for (const job of discordJobs) {
      expect(job.locationType).toBeUndefined();
    }
  });

  it("never reintroduces enum-based skipping: a record with no payType/commitment/locationType signal at all is still returned as a job, not skipped", async () => {
    // This is the regression this change most needs protecting against:
    // if someone re-adds a check like "skip when payType/commitment/
    // locationType is undefined", this test catches it. The record below
    // is otherwise perfectly well-formed (valid id, title, company, url,
    // content, date) and carries no metadata that could map to any of the
    // three enums.
    const minimalJob = {
      id: 999,
      title: "Some Role",
      company_name: "Acme",
      absolute_url: "https://acme.example/jobs/999",
      content: "<p>Do the work.</p>",
      first_published: "2026-01-01T00:00:00-00:00",
      location: { name: "Remote" },
      // deliberately no metadata at all
    };
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse({ jobs: [minimalJob] }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(skipRate).toBe(0);
    expect(jobs[0]?.payType).toBeUndefined();
    expect(jobs[0]?.commitment).toBeUndefined();
    expect(jobs[0]?.locationType).toBeUndefined();
  });
});

describe("htmlToPlainText — against real Greenhouse `content` values", () => {
  it("decodes Greenhouse's doubly entity-encoded markup into clean plain text", () => {
    const rawContent = discordFixture.jobs[0].content as string;
    // Sanity-check the fixture itself: confirms the raw JSON value really
    // is entity-encoded markup, not already-decoded HTML or plain text —
    // otherwise this test would trivially pass no matter what
    // htmlToPlainText does.
    expect(rawContent).toContain("&lt;div");
    expect(rawContent).toContain("&amp;nbsp;"); // the double-encoding case

    const text = htmlToPlainText(rawContent);

    // No leftover markup or entities of either encoding layer.
    expect(text).not.toContain("<");
    expect(text).not.toContain("&lt;");
    expect(text).not.toContain("&gt;");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&nbsp;");
    expect(text).not.toContain("&quot;");

    // The real, known opening line of this posting, recovered as plain
    // text (this is the exact string a human reads on Discord's careers
    // page for this job, decoded from two layers of entity-encoding).
    expect(text).toContain(
      "Discord has a highly engaged community of millions of daily active users",
    );
    // The &amp;nbsp; -> &nbsp; -> " " double-decode specifically: this
    // phrase in the raw fixture is "partners&amp;nbsp;" immediately
    // followed by a closing </li> tag — confirms the nested entity
    // resolved to a real space rather than staying literal text.
    expect(text).toContain("technical point of contact for programmatic buyers or partners");
  });

  it("preserves paragraph/list-item structure as line breaks rather than one run-on line", () => {
    const text = htmlToPlainText(discordFixture.jobs[0].content as string);
    const lines = text.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    // A known bullet point from this real posting should be its own line.
    expect(lines).toContain(
      "Coordinate mobile measurement setup with MMP partners (AppsFlyer, Adjust, Singular) and serve as the technical point of contact for attribution",
    );
  });

  it("returns empty string for empty input rather than throwing", () => {
    expect(htmlToPlainText("")).toBe("");
  });

  it("produces a stable externalId (Greenhouse's job id) across repeated calls", async () => {
    const fetchImpl = fetchByToken({ discord: () => jsonResponse(discordFixture) });
    const source = makeSource(fetchImpl, ["discord"]);

    const first = await source.search({});
    const second = await source.search({});

    const idsFirst = [...first.jobs, ...first.skipped].map((j) => j.externalId);
    const idsSecond = [...second.jobs, ...second.skipped].map((j) => j.externalId);
    expect(idsFirst).toEqual(["8599937002", "8614971002", "8625545002"]);
    expect(idsFirst).toEqual(idsSecond);
  });

  it("requests content=true for every configured board token, with no credentials required", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
      airbnb: () => jsonResponse(airbnbFixture),
    });
    const source = makeSource(fetchImpl, ["discord", "airbnb"]);

    await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls as [URL, RequestInit][];
    const urls = calls.map(([url]) => url);
    expect(urls.some((u) => u.pathname.includes("/boards/discord/jobs"))).toBe(true);
    expect(urls.some((u) => u.pathname.includes("/boards/airbnb/jobs"))).toBe(true);
    for (const url of urls) {
      expect(url.searchParams.get("content")).toBe("true");
    }
  });
});

describe("GreenhouseSource — merging across configured board tokens", () => {
  it("fetches every configured token and merges the results", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
      airbnb: () => jsonResponse(airbnbFixture),
    });
    const source = makeSource(fetchImpl, ["discord", "airbnb"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(skipped).toHaveLength(0);
    const ids = jobs.map((j) => j.externalId).sort();
    expect(ids).toEqual(
      ["7995153", "8043588", "8067991", "8599937002", "8614971002", "8625545002"].sort(),
    );
  });

  it("filters client-side by keyword (Greenhouse's board endpoint has no server-side search)", async () => {
    const fetchImpl = fetchByToken({ discord: () => jsonResponse(discordFixture) });
    const source = makeSource(fetchImpl, ["discord"]);

    const { jobs, skipped } = await source.search({ keyword: "Data Engineer" });

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("8614971002");
  });

  it("filters client-side by location", async () => {
    const fetchImpl = fetchByToken({ airbnb: () => jsonResponse(airbnbFixture) });
    const source = makeSource(fetchImpl, ["airbnb"]);

    const { jobs, skipped } = await source.search({ location: "Berlin" });

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("7995153");
  });

  it('criteria.location substring-matches the raw board location string, dropping both "Remote - US" and "Seattle, WA" when searching "Washington" — exactly why demo-match.ts (ticket 620ca30) does NOT pass criteria.location and filters client-side instead', async () => {
    // Neither committed real-response fixture happens to contain a
    // "Remote - US" listing, so this uses three small, hand-built records —
    // same discipline as the "never reintroduces enum-based skipping" test
    // above (this is testing itemMatchesCriteria's filter logic, not the
    // payType/commitment/locationType mapping the "never hand-build a
    // fixture" rule at the top of this file is about).
    const remoteUsJob = {
      id: 501,
      title: "Software Engineer",
      company_name: "Acme",
      absolute_url: "https://acme.example/jobs/501",
      content: "<p>Build things.</p>",
      first_published: "2026-01-01T00:00:00-00:00",
      location: { name: "Remote - US" },
    };
    // A realistic, common way a board actually writes a Washington posting
    // — abbreviated, not spelled out.
    const seattleWaJob = {
      id: 502,
      title: "Software Engineer",
      company_name: "Acme",
      absolute_url: "https://acme.example/jobs/502",
      content: "<p>Build things.</p>",
      first_published: "2026-01-01T00:00:00-00:00",
      location: { name: "Seattle, WA" },
    };
    // Control: the ONE spelling that actually contains "washington" as a
    // literal substring, so it's the only one of the three criteria.location
    // itself can find.
    const bellevueWashingtonJob = {
      id: 503,
      title: "Software Engineer",
      company_name: "Acme",
      absolute_url: "https://acme.example/jobs/503",
      content: "<p>Build things.</p>",
      first_published: "2026-01-01T00:00:00-00:00",
      location: { name: "Bellevue, Washington" },
    };
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse({ jobs: [remoteUsJob, seattleWaJob, bellevueWashingtonJob] }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const { jobs } = await source.search({ location: "Washington" });

    // "remote - us".includes("washington") is false and "seattle, wa"
    // .includes("washington") is ALSO false (the abbreviation "wa" is not
    // the substring "washington") — both real, desirable Washington-area
    // postings are dropped by a plain criteria.location match. Only the
    // fully-spelled-out control survives. demo-match.ts's main() relies on
    // this exact behavior to justify passing `criteria: {}` and doing
    // location narrowing in `filter` (filterSoftwareEngineeringJobs, whose
    // PLACE regex explicitly handles both "remote - us" and ", WA") instead
    // — if that reasoning were ever wrong, this test would fail.
    expect(jobs.map((j) => j.externalId)).toEqual(["503"]);
  });

  it("a 404 on one board token is skipped (that company's board doesn't exist) without discarding results from healthy tokens", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "discord"]);

    const { jobs, skipped } = await source.search({});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(skipped).toHaveLength(0);
    expect(jobs.map((j) => j.externalId).sort()).toEqual(
      ["8599937002", "8614971002", "8625545002"].sort(),
    );
  });

  it("reports skipRate 0, not NaN, when every configured board 404s (nothing at all was fetched)", async () => {
    const fetchImpl = fetchByToken({
      "gone-1": () => new Response("Not Found", { status: 404 }),
      "gone-2": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["gone-1", "gone-2"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });
});

describe("GreenhouseSource — tokenOutcomes (ticket b723fb9)", () => {
  // The heart of the ticket: a 404'd token, a real-but-empty board, and a
  // real board with postings must be distinguishable from each other in
  // the data `search()` returns, not just indistinguishable empty results.
  it("reports 'not-found' for a 404, 'empty' for a real board with zero postings, and 'ok' with a posting count and company name for a real board with postings — all in one search()", async () => {
    const fetchImpl = fetchByToken({
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
      "quiet-board": () => jsonResponse({ jobs: [] }),
      discord: () => jsonResponse(discordFixture),
    });
    const source = makeSource(fetchImpl, ["does-not-exist", "quiet-board", "discord"]);

    const { tokenOutcomes } = await source.search({});

    expect(tokenOutcomes).toEqual([
      {
        token: "does-not-exist",
        status: "not-found",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "quiet-board",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "discord",
        status: "ok",
        postingCount: 3,
        companyName: "Discord",
        message: undefined,
        skippedCount: 0,
      },
    ]);
  });

  it("postingCount on an 'ok' token is the raw count before criteria filtering, not after", async () => {
    // Two jobs, only one of which matches a keyword filter — postingCount
    // must reflect the board's real size (2), not the post-criteria count
    // (1). `TokenOutcome` describes the board, not a particular search.
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    // discordFixture's 3 jobs presumably don't all share one keyword; use
    // a keyword guaranteed not to match anything so criteria filtering
    // removes every job while postingCount still reports the board's real
    // size.
    const { jobs, tokenOutcomes } = await source.search({
      keyword: "this-keyword-matches-nothing-in-the-fixture-xyz",
    });

    expect(jobs).toHaveLength(0);
    expect(tokenOutcomes).toEqual([
      {
        token: "discord",
        status: "ok",
        postingCount: 3,
        companyName: "Discord",
        message: undefined,
        skippedCount: 0,
      },
    ]);
  });
});

describe("GreenhouseSource — error classification", () => {
  it("classifies HTTP 401 as AuthFailedError (not retryable)", async () => {
    const fetchImpl = fetchByToken({
      discord: () => new Response("Unauthorized", { status: 401 }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).kind).toBe("auth-failed");
    expect((err as AuthFailedError).retryable).toBe(false);
  });

  // ticket b723fb9 review round 2, finding #2: 403 is ISOLATED (continue),
  // not aborted. `ForbiddenError`'s own doc comment in types.ts, and
  // `parseResponse`'s 403 comment in this file, both already say a 403
  // here is "not reliably permanent... a WAF rule or fingerprint can
  // change request-to-request" — a per-request blip, exactly what the
  // isolation branch exists for. (A first pass at this ticket grouped 403
  // with 401 as "very likely to recur identically", contradicting both of
  // those comments — this is the corrected boundary.)
  it("isolates HTTP 403 to that token's outcome instead of aborting the whole search()", async () => {
    const fetchImpl = fetchByToken({
      discord: () => new Response("<html>blocked</html>", { status: 403 }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.tokenOutcomes).toEqual([
      {
        token: "discord",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringContaining("HTTP 403"),
        skippedCount: 0,
      },
    ]);
  });

  // ticket b723fb9 review round 2, finding #1: a 429 stops search() from
  // issuing further requests (back-off preserved) but no longer throws
  // away jobs already collected from healthy boards fetched earlier in
  // the same call — see the big comment in GreenhouseSource#search for
  // the full reasoning ("stop hammering" and "discard everything already
  // fetched" are separable, and only the first follows from a 429).
  it("a single rate-limited token resolves with an 'error' outcome instead of rejecting", async () => {
    const fetchImpl = fetchByToken({
      discord: () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "12" } }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.tokenOutcomes).toEqual([
      {
        token: "discord",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringContaining("retry after 12000ms"),
        skippedCount: 0,
      },
    ]);
  });

  // Ticket b681d18: search() now runs 5 tokens concurrently, not strictly
  // one at a time -- with only 4 tokens (the old test's shape), ALL of
  // them dispatch in the first batch and there is no "further requests"
  // left to stop, so this scenario needs at least CONCURRENCY + 1 tokens
  // to mean anything, and needs the non-rate-limited tokens' resolution
  // deliberately held open (not just synchronously returned) so the
  // rate-limited worker's 429 is guaranteed to be observed BEFORE any
  // worker moves on to claim the 6th token -- otherwise which requests
  // "already snuck out" before the stop flag is noticed is a genuine race,
  // not a deterministic thing to assert on.
  it("a 429 mid-batch stops issuing further requests but returns every job already fetched from healthy boards earlier in the same search() — the reviewer's exact scenario, now under 5-way concurrency", async () => {
    function deferredResponse() {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    const discordDeferred = deferredResponse();
    const airbnbDeferred = deferredResponse();
    const healthy3Deferred = deferredResponse();
    const healthy4Deferred = deferredResponse();
    const sixthTokenFetch = vi.fn(() => jsonResponse({ jobs: [] }));

    // Token at index 0 -- resolves on the very next microtask (an
    // ordinary async mock, not deferred). The other four in-flight slots
    // (indices 1-4) are held open on purpose: this guarantees the 429 is
    // observed and the stop flag is set before any of THOSE workers can
    // possibly finish and claim index 5.
    const fetchImpl = fetchByToken({
      "rate-limited": () =>
        new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "30" } }),
      discord: () => discordDeferred.promise,
      airbnb: () => airbnbDeferred.promise,
      "healthy-3": () => healthy3Deferred.promise,
      "healthy-4": () => healthy4Deferred.promise,
      "never-requested": sixthTokenFetch,
    });
    const source = makeSource(fetchImpl, [
      "rate-limited",
      "discord",
      "airbnb",
      "healthy-3",
      "healthy-4",
      "never-requested",
    ]);

    const resultPromise = source.search({});

    // Let the rate-limited worker's microtask run and set the stop flag
    // before releasing anything else.
    await Promise.resolve();
    await Promise.resolve();

    discordDeferred.resolve(jsonResponse(discordFixture));
    airbnbDeferred.resolve(jsonResponse(airbnbFixture));
    healthy3Deferred.resolve(jsonResponse({ jobs: [] }));
    healthy4Deferred.resolve(jsonResponse({ jobs: [] }));

    const result = await resultPromise;

    // Not rejected — resolves with a partial result.
    expect(result.jobs.length).toBe(6); // discordFixture's 3 + airbnbFixture's 3
    expect(sixthTokenFetch).not.toHaveBeenCalled();
    expect(result.tokenOutcomes).toEqual([
      {
        token: "rate-limited",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringContaining("retry after 30000ms"),
        skippedCount: 0,
      },
      {
        token: "discord",
        status: "ok",
        postingCount: 3,
        companyName: "Discord",
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "airbnb",
        status: "ok",
        postingCount: 3,
        companyName: expect.any(String),
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "healthy-3",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "healthy-4",
        status: "empty",
        postingCount: 0,
        companyName: undefined,
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "never-requested",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringMatching(/not checked.*rate-limited/),
        skippedCount: 0,
      },
    ]);
  });

  it("bounded concurrency: never more than 5 requests are in flight to Greenhouse at once", async () => {
    const TOKEN_COUNT = 12;
    const tokens = Array.from({ length: TOKEN_COUNT }, (_, i) => `board-${i}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const responses: Record<string, () => Promise<Response>> = {};
    for (const token of tokens) {
      responses[token] = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A real timer-level delay so overlapping in-flight requests
        // actually overlap in wall-clock terms, not just in call order.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return jsonResponse({ jobs: [] });
      };
    }
    const fetchImpl = fetchByToken(responses);
    const source = makeSource(fetchImpl, tokens);

    const result = await source.search({});

    expect(result.tokenOutcomes).toHaveLength(TOKEN_COUNT);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // proves it's actually concurrent, not accidentally sequential
  });

  // ticket b723fb9 review fix #2: a 500/503 or a network failure — both
  // classified as TransientSourceError internally — used to abort the
  // ENTIRE search() the same way an auth/forbidden/rate-limit/malformed
  // error still does below. That meant one flaky board among many
  // discarded every job already fetched from every healthy board before
  // it. TransientSourceError is now isolated per-token exactly like a 404
  // (see GreenhouseSource#search's doc comment for why): search() resolves
  // with an "error" tokenOutcome for that token instead of rejecting.
  it("isolates HTTP 500/503 to that token's outcome instead of aborting the whole search()", async () => {
    const fetchImpl = fetchByToken({
      discord: () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.tokenOutcomes).toEqual([
      {
        token: "discord",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringContaining("HTTP 503"),
        skippedCount: 0,
      },
    ]);
  });

  it("isolates a network failure (fetch rejects) to that token's outcome instead of aborting the whole search()", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const source = makeSource(fetchImpl, ["discord"]);

    const result = await source.search({});

    expect(result.jobs).toEqual([]);
    expect(result.tokenOutcomes).toHaveLength(1);
    expect(result.tokenOutcomes![0]).toMatchObject({
      token: "discord",
      status: "error",
      postingCount: 0,
      companyName: undefined,
      skippedCount: 0,
    });
    expect(result.tokenOutcomes![0]!.message).toMatch(/network error/i);
  });

  it("a healthy board's jobs survive when a LATER token in the same search() has a transient error — nothing already fetched is discarded", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse(discordFixture),
      "flaky-board": () => new Response("Service Unavailable", { status: 503 }),
    });
    const source = makeSource(fetchImpl, ["discord", "flaky-board"]);

    const result = await source.search({});

    expect(result.jobs.map((j) => j.externalId).sort()).toEqual(
      ["8599937002", "8614971002", "8625545002"].sort(),
    );
    expect(result.tokenOutcomes).toEqual([
      {
        token: "discord",
        status: "ok",
        postingCount: 3,
        companyName: "Discord",
        message: undefined,
        skippedCount: 0,
      },
      {
        token: "flaky-board",
        status: "error",
        postingCount: 0,
        companyName: undefined,
        message: expect.stringContaining("HTTP 503"),
        skippedCount: 0,
      },
    ]);
  });

  it("still aborts the whole search() for 401 (AuthFailedError), a malformed body, and an unmapped 4xx (400) — these three, and only these three, are NOT isolated", async () => {
    // Documents the exact boundary drawn in GreenhouseSource#search's big
    // comment: 404, TransientSourceError, ForbiddenError (403), and
    // RateLimitedError (429) are all isolated per-token now — this test
    // pins down what's LEFT on the aborting side, so that set doesn't
    // silently widen (or narrow) later without a test failing to say so.
    // (A previous version of this test asserted only 401 while claiming
    // to cover 401/403/429/malformed — folding 403 or 429 into the
    // isolated set, as this same review round did, would have left it
    // green despite no longer testing its own boundary. Every status this
    // test claims still aborts is now actually exercised below.)
    const authFailed = fetchByToken({
      discord: () => new Response("Unauthorized", { status: 401 }),
    });
    await expect(makeSource(authFailed, ["discord"]).search({})).rejects.toBeInstanceOf(
      AuthFailedError,
    );

    const malformedJson = fetchByToken({
      discord: () => new Response("not json{{{", { status: 200 }),
    });
    await expect(makeSource(malformedJson, ["discord"]).search({})).rejects.toBeInstanceOf(
      MalformedResponseError,
    );

    const unmappedStatus = fetchByToken({
      discord: () => new Response("Bad Request", { status: 400 }),
    });
    await expect(makeSource(unmappedStatus, ["discord"]).search({})).rejects.toBeInstanceOf(
      UnexpectedStatusError,
    );
  });

  it("classifies invalid JSON as MalformedResponseError (not retryable)", async () => {
    const fetchImpl = fetchByToken({
      discord: () => new Response("not json{{{", { status: 200 }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
    expect((err as MalformedResponseError).retryable).toBe(false);
  });

  it("classifies well-formed JSON with an unexpected shape (missing 'jobs') as MalformedResponseError", async () => {
    const fetchImpl = fetchByToken({
      discord: () => jsonResponse({ notWhatWeExpected: true }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MalformedResponseError);
  });

  it("a lone 404'd board resolves to an empty (not thrown) result — see 'reports skipRate 0' above for the multi-token case", async () => {
    // 404 is classified as UnexpectedStatusError (same as any other
    // unmapped 4xx — see the 400 test below for that classification's
    // fields), but search() specifically catches status 404 at the
    // orchestration layer and treats it as "this board doesn't exist,
    // move on" rather than rethrowing — see the doc comment in
    // GreenhouseSource#search. So even with only one (bad) token
    // configured, search() resolves normally instead of rejecting.
    const fetchImpl = fetchByToken({
      "does-not-exist": () => new Response("Not Found", { status: 404 }),
    });
    const source = makeSource(fetchImpl, ["does-not-exist"]);

    const result = await source.search({});
    expect(result).toEqual({
      jobs: [],
      skipped: [],
      skipRate: 0,
      tokenOutcomes: [
        {
          token: "does-not-exist",
          status: "not-found",
          postingCount: 0,
          companyName: undefined,
          message: undefined,
          skippedCount: 0,
        },
      ],
    });
  });

  it("classifies an unmapped 4xx status (400) as UnexpectedStatusError (not retryable)", async () => {
    const fetchImpl = fetchByToken({
      discord: () => new Response("Bad Request", { status: 400 }),
    });
    const source = makeSource(fetchImpl, ["discord"]);

    const err = await source.search({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedStatusError);
    expect((err as UnexpectedStatusError).status).toBe(400);
    expect((err as UnexpectedStatusError).retryable).toBe(false);
  });
});

describe("GreenhouseSource construction", () => {
  it("throws when constructed with an empty board token list", () => {
    expect(() => new GreenhouseSource({ boardTokens: [] })).toThrow(/at least one board token/);
  });
});

describe("createGreenhouseSourceFromEnv", () => {
  it("throws when GREENHOUSE_BOARD_TOKENS is missing", () => {
    expect(() => createGreenhouseSourceFromEnv({})).toThrow(/GREENHOUSE_BOARD_TOKENS/);
  });

  it("throws when GREENHOUSE_BOARD_TOKENS is empty/whitespace", () => {
    expect(() => createGreenhouseSourceFromEnv({ GREENHOUSE_BOARD_TOKENS: "  , ," })).toThrow(
      /GREENHOUSE_BOARD_TOKENS/,
    );
  });

  it("parses a comma-separated list, trimming whitespace", () => {
    const source = createGreenhouseSourceFromEnv({
      GREENHOUSE_BOARD_TOKENS: " stripe, airbnb ,discord",
    });
    expect(source.dataSource).toBe("greenhouse");
  });
});
