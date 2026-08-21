import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SmartRecruitersSource, createSmartRecruitersSourceFromEnv } from "./smartrecruiters.js";

// ---------------------------------------------------------------------------
// Fixtures: real, live-captured SmartRecruiters Posting API responses
// against BoschGroup — the one company identifier out of seven guessed
// during this ticket's verification that turned out to be real (see
// smartrecruiters.ts's top-of-file comment, Finding 1). Two list pages
// (proving the real `offset`/`limit`/`totalFound` shape and that a board
// this size needs more than one page) and five per-posting detail
// responses, chosen to span `typeOfEmployment` (permanent/part-time/
// contract), `location.remote`/`location.hybrid` combinations, and a
// `jobAd.sections.videos` entry (deliberately not read — see Finding 3).
// Never hand-build a fixture for the success/skip paths below — derive
// from these files, the same discipline this project's USAJOBS adapter
// had to be rebuilt to follow.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadFixture(name: string): any {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf-8"));
}

const postingsPage1 = loadFixture("smartrecruiters-real-response-bosch-postings-page1.json");
const postingsPage2 = loadFixture("smartrecruiters-real-response-bosch-postings-page2.json");
const detailAiResearchScientist = loadFixture(
  "smartrecruiters-real-response-bosch-detail-ai-research-scientist.json",
);
const detailCommunicationsAssistant = loadFixture(
  "smartrecruiters-real-response-bosch-detail-communications-assistant.json",
);
const detailContract = loadFixture("smartrecruiters-real-response-bosch-detail-contract.json");
const detailPartTimeHybrid = loadFixture(
  "smartrecruiters-real-response-bosch-detail-parttime-hybrid.json",
);
const detailRemote = loadFixture("smartrecruiters-real-response-bosch-detail-remote.json");

if (postingsPage1.content.length !== 5) {
  throw new Error(
    `expected postings page 1 fixture to have 5 postings, got ${postingsPage1.content.length}`,
  );
}
if (postingsPage2.content.length !== 2) {
  throw new Error(
    `expected postings page 2 fixture to have 2 postings, got ${postingsPage2.content.length}`,
  );
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/**
 * Real, verified HTTP behavior of `careers.smartrecruiters.com/{id}`
 * (redirect: manual) — see smartrecruiters.ts Finding 1. These are not
 * invented status/header combinations; every one was observed live on
 * 2026-08-21 against the identifier named in each constant's comment.
 */
const REAL_CAREERS_RESPONSES = {
  /** Real, recognized SmartRecruiters customer hosted directly on
   * careers.smartrecruiters.com (verified: Visa, McKesson, Bureau
   * Veritas, Sixt, Nike, Twilio all behave this way). */
  recognizedHostedDirectly: () => new Response(null, { status: 200 }),
  /** Real, recognized customer whose careers page redirects to the
   * company's own custom domain (verified: BoschGroup ->
   * https://jobs.bosch.com/en). */
  recognizedCustomDomain: () =>
    new Response(null, { status: 302, headers: { location: "https://jobs.bosch.com/en" } }),
  /** Unrecognized identifier — verified byte-identical across six guessed
   * real-brand-name identifiers (Ubisoft, IKEA, Publicis, McDonalds,
   * Skechers, plus deliberately-nonsense slugs) and never once observed
   * for any confirmed-real company, even one with zero current postings
   * (Twilio, McKesson). */
  unrecognized: () =>
    new Response(null, { status: 302, headers: { location: "https://jobs.smartrecruiters.com" } }),
};

/** Routes a mocked fetch by URL: postings list (`/postings?...`), posting
 * detail (`/postings/{id}`), or the careers-site validity check
 * (`careers.smartrecruiters.com/{id}`) — so a single fetchImpl can drive a
 * full multi-company, paginated, detail-fetching `search()` call. */
function makeFetch(config: {
  postings?: Record<string, (offset: number) => Response>;
  detail?: Record<string, Record<string, () => Response>>;
  careers?: Record<string, () => Response>;
}): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vi.fn(async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));

    if (url.hostname === "careers.smartrecruiters.com") {
      const company = url.pathname.replace(/^\//, "");
      const responder = config.careers?.[company];
      if (!responder) {
        throw new Error(
          `test fetch stub: no mocked careers-site response for company "${company}"`,
        );
      }
      return responder();
    }

    const detailMatch = /\/companies\/([^/]+)\/postings\/([^/?]+)/.exec(url.pathname);
    if (detailMatch) {
      const [, company, id] = detailMatch;
      const responder = company && id ? config.detail?.[company]?.[id] : undefined;
      if (!responder) {
        throw new Error(`test fetch stub: no mocked detail response for ${company}/${id}`);
      }
      return responder();
    }

    const listMatch = /\/companies\/([^/]+)\/postings/.exec(url.pathname);
    if (listMatch) {
      const company = listMatch[1];
      const responder = company ? config.postings?.[company] : undefined;
      if (!responder) {
        throw new Error(`test fetch stub: no mocked postings response for company "${company}"`);
      }
      const offset = Number(url.searchParams.get("offset") ?? "0");
      return responder(offset);
    }

    throw new Error(`test fetch stub: unrecognized URL ${url.toString()}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function makeSource(fetchImpl: typeof fetch, companies: string[] = ["BoschGroup"], overrides = {}) {
  return new SmartRecruitersSource({ companies, fetchImpl, ...overrides });
}

// ---------------------------------------------------------------------------
// THE CENTRAL FINDING OF THIS TICKET: a wrong company identifier and a real
// company with zero current postings both return HTTP 200 with
// `totalFound: 0` from the postings API — see smartrecruiters.ts Finding 1.
// This adapter disambiguates them with one extra request, made only in
// this ambiguous case, to careers.smartrecruiters.com. These tests prove
// the two cases produce genuinely different `SourceSearchResult`s.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — distinguishing an unrecognized company from a real one with no openings", () => {
  it("an unrecognized company identifier is surfaced as a skip, not a silent empty result", async () => {
    const fetchImpl = makeFetch({
      postings: {
        NotARealCompany: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: { NotARealCompany: REAL_CAREERS_RESPONSES.unrecognized },
    });
    const source = makeSource(fetchImpl, ["NotARealCompany"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/not recognized/);
    expect(skipped[0]?.reason).toContain("NotARealCompany");
  });

  it("a real company with genuinely zero current openings returns a clean empty result, not a skip", async () => {
    const fetchImpl = makeFetch({
      postings: {
        Twilio: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: { Twilio: REAL_CAREERS_RESPONSES.recognizedHostedDirectly },
    });
    const source = makeSource(fetchImpl, ["Twilio"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("also recognizes a company whose careers page redirects to its own custom domain (not the generic SmartRecruiters homepage) as valid", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: { BoschGroup: REAL_CAREERS_RESPONSES.recognizedCustomDomain },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });

  it("the two zero-postings cases produce genuinely different SourceSearchResults side by side", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BogusCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
        RealButQuiet: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: {
        BogusCo: REAL_CAREERS_RESPONSES.unrecognized,
        RealButQuiet: REAL_CAREERS_RESPONSES.recognizedHostedDirectly,
      },
    });

    const bogusResult = await makeSource(fetchImpl, ["BogusCo"]).search({});
    const realQuietResult = await makeSource(fetchImpl, ["RealButQuiet"]).search({});

    expect(bogusResult).not.toEqual(realQuietResult);
    expect(bogusResult.skipRate).toBe(1);
    expect(realQuietResult.skipRate).toBe(0);
  });

  it("surfaces (rather than silently trusting) a company whose validity could not be confirmed", async () => {
    const fetchImpl = makeFetch({
      postings: {
        FlakyCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: {
        FlakyCo: () => {
          throw new TypeError("network error");
        },
      },
    });
    const source = makeSource(fetchImpl, ["FlakyCo"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/could not be confirmed/);
  });

  it("does NOT call the careers-site check at all when the postings API already returns real postings", async () => {
    const careersCheck = vi.fn(REAL_CAREERS_RESPONSES.recognizedHostedDirectly);
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: (offset) =>
          offset === 0
            ? jsonResponse(postingsPage1)
            : jsonResponse({ offset, limit: 100, totalFound: 5, content: [] }),
      },
      detail: {
        BoschGroup: {
          "744000144627757": () => jsonResponse(detailAiResearchScientist),
          "744000144806059": () => jsonResponse(detailCommunicationsAssistant),
          "744000144772856": () => jsonResponse(detailContract),
          "744000144784449": () => jsonResponse(detailPartTimeHybrid),
          "744000144765299": () => jsonResponse(detailRemote),
        },
      },
      careers: { BoschGroup: careersCheck },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    await source.search({});

    expect(careersCheck).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Full-text description assembly (Finding 3): a naive mapper that reads
// only `jobAd.sections.jobDescription` drops the real requirements, which
// live in `qualifications`. "Python" and "C++" appear ONLY in the real AI
// Research Scientist fixture's `qualifications` section — nowhere in
// `jobDescription` or `companyDescription`. See this ticket's report for
// the literal failing output of a `jobDescription`-only implementation
// against this exact assertion.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — requirements text (qualifications) reaches description", () => {
  it("includes real requirements text that exists only in jobAd.sections.qualifications, not jobDescription", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: {
        BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) },
      },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(1);
    const description = jobs[0]?.description ?? "";

    // Sanity: the intro (companyDescription) really is present.
    expect(description).toContain("Bosch Research and Technology Center");
    // THE finding: real requirements text that lives ONLY in
    // `qualifications` on the real fixture (verified by inspection — grep
    // the fixture file for "Python": it appears exactly once, inside
    // jobAd.sections.qualifications.text).
    expect(description).toContain("Python");
    expect(description).toContain("C++");
    expect(description).toContain("Ph.D. in Computer Science");
  });

  it("a naive implementation that reads only jobDescription (not qualifications) would miss that same requirements text — demonstrating why buildDescription folds in all four sections", () => {
    // Deliberately reimplements the WRONG, first-draft version of
    // buildDescription — the one that seemed reasonable before Finding 3
    // was made (see smartrecruiters.ts's top-of-file comment) — to prove
    // the failure mode this ticket exists to catch is real, not
    // hypothetical. This is not testing smartrecruiters.ts; it's testing
    // that the bug this adapter avoids is a bug a plausible naive
    // implementation would actually have.
    function naiveBuildDescriptionUsingOnlyJobDescription(
      detail: typeof detailAiResearchScientist,
    ): string {
      const text = detail.jobAd?.sections?.jobDescription?.text ?? "";
      return text.replace(/<[^>]*>/g, " ");
    }

    const naiveDescription =
      naiveBuildDescriptionUsingOnlyJobDescription(detailAiResearchScientist);

    expect(naiveDescription).not.toContain("Python");
    expect(naiveDescription).not.toContain("Ph.D. in Computer Science");
  });
});

// ---------------------------------------------------------------------------
// Pagination — the postings list is capped at 100 results per page (real
// API behavior, verified: requesting limit=1000 or limit=10000 both came
// back with exactly 100 records and `limit: 100` echoed in the response).
// BoschGroup's ~4,780 postings need ~48 pages. Proven here with a small,
// deterministic synthetic board (shape matches the real, fixture-verified
// envelope) so the test suite doesn't need 48 real pages to prove the loop
// walks every one, including a `totalFound` that shrinks between pages —
// real boards do this (see lever.ts's precedent note; SmartRecruiters'
// own totalFound was observed to drift between this ticket's own page1/
// page2 captures, taken minutes apart).
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — pagination", () => {
  function summary(id: string) {
    return {
      id,
      name: `Role ${id}`,
      company: { identifier: "PagedCo", name: "Paged Co" },
      location: { fullLocation: "Remote", remote: true, hybrid: false },
      typeOfEmployment: { id: "permanent", label: "Full-time" },
      releasedDate: "2026-08-01T00:00:00.000Z",
    };
  }

  function detailFor(id: string) {
    return {
      id,
      name: `Role ${id}`,
      company: { identifier: "PagedCo", name: "Paged Co" },
      location: { fullLocation: "Remote", remote: true, hybrid: false },
      typeOfEmployment: { id: "permanent", label: "Full-time" },
      releasedDate: "2026-08-01T00:00:00.000Z",
      postingUrl: `https://jobs.smartrecruiters.com/PagedCo/${id}`,
      jobAd: {
        sections: {
          jobDescription: { title: "Job Description", text: `<p>Do the work for ${id}.</p>` },
        },
      },
    };
  }

  it("walks every page of a board too large for one response, including a totalFound that shrinks mid-fetch", async () => {
    // Page 1: totalFound 5. Page 2: totalFound drifts down to 4 (one
    // posting closed between requests) — the loop must use the LATEST
    // totalFound, not stale data from page 1, and must still fetch every
    // posting actually returned.
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const detailCalls: string[] = [];
    const fetchImpl = makeFetch({
      postings: {
        PagedCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 2,
              totalFound: 5,
              content: [summary("p1"), summary("p2")],
            });
          }
          if (offset === 2) {
            return jsonResponse({
              offset: 2,
              limit: 2,
              totalFound: 4,
              content: [summary("p3"), summary("p4")],
            });
          }
          if (offset === 4) {
            return jsonResponse({ offset: 4, limit: 2, totalFound: 4, content: [] });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        PagedCo: Object.fromEntries(
          ids.map((id) => [
            id,
            () => {
              detailCalls.push(id);
              return jsonResponse(detailFor(id));
            },
          ]),
        ),
      },
    });
    const source = makeSource(fetchImpl, ["PagedCo"], { pageSize: 2 });

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    // Only p1-p4 were ever returned by the (drifting) list endpoint; p5
    // never existed in this board and correctly was never fetched.
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["p1", "p2", "p3", "p4"]);
    expect(detailCalls.sort()).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("parses real captured multi-page responses (page1 offset 0, page2 offset 200) without error", async () => {
    // Proves the real API's envelope shape (offset/limit/totalFound/
    // content) parses correctly at both a first page and a later one, using
    // the two genuinely different real captures under __fixtures__.
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: (offset) => {
          if (offset === 0) return jsonResponse(postingsPage1);
          if (offset === 5)
            return jsonResponse({ offset: 5, limit: 100, totalFound: 5, content: [] });
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        BoschGroup: {
          "744000144627757": () => jsonResponse(detailAiResearchScientist),
          "744000144806059": () => jsonResponse(detailCommunicationsAssistant),
          "744000144772856": () => jsonResponse(detailContract),
          "744000144784449": () => jsonResponse(detailPartTimeHybrid),
          "744000144765299": () => jsonResponse(detailRemote),
        },
      },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    expect(jobs).toHaveLength(5);

    // Independently confirm page 2's own real shape is well-formed (even
    // though this particular board fit in one page by the time page 2 was
    // requested above) — a direct assertion against the captured fixture.
    expect(postingsPage2.offset).toBe(200);
    expect(postingsPage2.content.every((p: { id: string }) => typeof p.id === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mapping against real captured detail responses — commitment, locationType,
// company, location, postedAt. See smartrecruiters.ts Finding 4.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — mapping real fields", () => {
  function singlePostingFetch(id: string, detail: unknown) {
    return makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [postingsPage1.content.find((p: { id: string }) => p.id === id)],
          }),
      },
      detail: { BoschGroup: { [id]: () => jsonResponse(detail) } },
    });
  }

  it("maps typeOfEmployment.id 'contract' to commitment 'contract'", async () => {
    const source = makeSource(singlePostingFetch("744000144772856", detailContract));
    const { jobs } = await source.search({});
    expect(jobs[0]?.commitment).toBe("contract");
  });

  it("maps typeOfEmployment.id 'part-time' to commitment 'part-time', and hybrid:true to locationType 'hybrid'", async () => {
    const source = makeSource(singlePostingFetch("744000144784449", detailPartTimeHybrid));
    const { jobs } = await source.search({});
    expect(jobs[0]?.commitment).toBe("part-time");
    expect(jobs[0]?.locationType).toBe("hybrid");
  });

  it("maps location.remote:true to locationType 'remote', and typeOfEmployment.id 'permanent' to commitment 'full-time'", async () => {
    const source = makeSource(singlePostingFetch("744000144765299", detailRemote));
    const { jobs } = await source.search({});
    expect(jobs[0]?.locationType).toBe("remote");
    expect(jobs[0]?.commitment).toBe("full-time");
  });

  it("maps both remote:false and hybrid:false to locationType 'onsite' (a real posting whose location object explicitly says neither)", async () => {
    const source = makeSource(singlePostingFetch("744000144806059", detailCommunicationsAssistant));
    const { jobs } = await source.search({});
    expect(jobs[0]?.locationType).toBe("onsite");
  });

  it("payType is always undefined — SmartRecruiters has no reliable structured compensation field (see Finding 4)", async () => {
    const source = makeSource(singlePostingFetch("744000144627757", detailAiResearchScientist));
    const { jobs } = await source.search({});
    // This fixture DOES have a pay figure, but only as prose inside
    // additionalInformation ("$165,000 - $185,000") — not a structured
    // field, so it must not be parsed into payType.
    expect(jobs[0]?.payType).toBeUndefined();
  });

  it("uses the detail response's postingUrl (not a tracking-tagged applyUrl) as linkToApply", async () => {
    const source = makeSource(singlePostingFetch("744000144627757", detailAiResearchScientist));
    const { jobs } = await source.search({});
    expect(jobs[0]?.linkToApply).toBe(detailAiResearchScientist.postingUrl);
    expect(jobs[0]?.linkToApply).not.toContain("oga=true");
  });

  it("uses company.name from the posting detail", async () => {
    const source = makeSource(singlePostingFetch("744000144627757", detailAiResearchScientist));
    const { jobs } = await source.search({});
    expect(jobs[0]?.company).toBe("Bosch Group");
  });
});

// ---------------------------------------------------------------------------
// skipRate semantics — matching every other adapter in this project:
// skipped.length / (jobs.length + skipped.length), 0 when nothing was
// found at all.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — skipRate semantics", () => {
  it("is 0 for an all-success result", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: { BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) } },
    });
    const { skipRate } = await makeSource(fetchImpl).search({});
    expect(skipRate).toBe(0);
  });

  it("is a fraction, not 0 or 1, when some real postings map and others don't", async () => {
    const brokenSummary = { id: "broken-1", name: "Broken Role", company: { name: "Acme" } };
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 2,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
              brokenSummary,
            ],
          }),
      },
      detail: {
        BoschGroup: {
          "744000144627757": () => jsonResponse(detailAiResearchScientist),
          "broken-1": () =>
            jsonResponse({
              id: "broken-1",
              name: "Broken Role",
              company: { name: "Acme" },
              // no releasedDate, no jobAd -> fails normalization
            }),
        },
      },
    });
    const { jobs, skipped, skipRate } = await makeSource(fetchImpl).search({});
    expect(jobs).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(0.5);
  });

  it("a per-posting detail fetch failure is skipped individually, not fatal to the rest of the board", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 2,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144806059"),
            ],
          }),
      },
      detail: {
        BoschGroup: {
          "744000144627757": () => jsonResponse(detailAiResearchScientist),
          "744000144806059": () => new Response(null, { status: 500 }),
        },
      },
    });
    const { jobs, skipped } = await makeSource(fetchImpl).search({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("744000144627757");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.externalId).toBe("744000144806059");
    expect(skipped[0]?.reason).toMatch(/failed to fetch full posting detail/);
  });
});

// ---------------------------------------------------------------------------
// Per-company failure isolation — one bad company must not fail the whole
// search(). See greenhouse.ts for the precedent this generalizes; unlike
// Greenhouse/Lever (which isolate only a 404), this adapter isolates ANY
// per-company failure, because a single company here can mean thousands of
// requests, not one (see smartrecruiters.ts's `search()` doc comment).
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — per-company failure isolation", () => {
  it("one company's list-endpoint failure does not prevent another configured company's jobs from being returned", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BrokenCo: () => new Response(null, { status: 500 }),
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: { BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) } },
    });
    const source = makeSource(fetchImpl, ["BrokenCo", "BoschGroup"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.company).toBe("Bosch Group");
    expect(skipped.some((s) => s.reason.includes("BrokenCo"))).toBe(true);
  });

  it("a rate-limited company is recorded and isolated, not thrown out of search()", async () => {
    const fetchImpl = makeFetch({
      postings: {
        RateLimitedCo: () => new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: { BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) } },
    });
    const source = makeSource(fetchImpl, ["RateLimitedCo", "BoschGroup"]);

    await expect(source.search({})).resolves.not.toThrow();
    const { jobs, skipped } = await source.search({});
    expect(jobs).toHaveLength(1);
    expect(skipped.some((s) => s.reason.includes("RateLimitedCo"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Client-side criteria filtering
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — criteria filtering", () => {
  it("filters by location before the detail fetch (no hidden second location field exists to miss — see Finding 5)", async () => {
    const detailFetches: string[] = [];
    const fetchImpl = makeFetch({
      postings: {
        // totalFound overridden to match this page's real content length
        // (5) rather than the real board's live count (4,780+) — this
        // test is about the location pre-filter, not full pagination
        // (which has its own dedicated describe block below), so the
        // mock reports the board as fully returned in this one page.
        BoschGroup: () =>
          jsonResponse({ ...postingsPage1, totalFound: postingsPage1.content.length }),
      },
      detail: {
        BoschGroup: {
          "744000144627757": () => {
            detailFetches.push("744000144627757");
            return jsonResponse(detailAiResearchScientist);
          },
          "744000144806059": () => {
            detailFetches.push("744000144806059");
            return jsonResponse(detailCommunicationsAssistant);
          },
          "744000144772856": () => {
            detailFetches.push("744000144772856");
            return jsonResponse(detailContract);
          },
          "744000144784449": () => {
            detailFetches.push("744000144784449");
            return jsonResponse(detailPartTimeHybrid);
          },
          "744000144765299": () => {
            detailFetches.push("744000144765299");
            return jsonResponse(detailRemote);
          },
        },
      },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    // Sunnyvale is the AI Research Scientist posting's real location.
    const { jobs } = await source.search({ location: "Sunnyvale" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("744000144627757");
    // The location pre-filter means only the matching posting's detail was
    // ever fetched — the other four real postings in this page were
    // filtered out before costing a detail request.
    expect(detailFetches).toEqual(["744000144627757"]);
  });

  it("filters by keyword AFTER the detail fetch, so a keyword that exists only in qualifications still matches (Finding 3)", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: { BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) } },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    // "Python" appears only in jobAd.sections.qualifications.text on this
    // real fixture, never in the title ("AI Research Scientist- World
    // Model") or any other section.
    const { jobs } = await source.search({ keyword: "Python" });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.externalId).toBe("744000144627757");
  });

  it("a keyword with no match anywhere (title or full description) is filtered out, not skipped", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              postingsPage1.content.find((p: { id: string }) => p.id === "744000144627757"),
            ],
          }),
      },
      detail: { BoschGroup: { "744000144627757": () => jsonResponse(detailAiResearchScientist) } },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    const { jobs, skipped, skipRate } = await source.search({
      keyword: "nuclear-submarine-pilot-xyz",
    });

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(skipRate).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createSmartRecruitersSourceFromEnv
// ---------------------------------------------------------------------------
describe("createSmartRecruitersSourceFromEnv", () => {
  it("throws synchronously when SMARTRECRUITERS_COMPANIES is unset", () => {
    expect(() => createSmartRecruitersSourceFromEnv({})).toThrow(/SMARTRECRUITERS_COMPANIES/);
  });

  it("parses a comma-separated company list", () => {
    const source = createSmartRecruitersSourceFromEnv({
      SMARTRECRUITERS_COMPANIES: "BoschGroup, Visa ,McKesson",
    });
    expect(source.dataSource).toBe("smartrecruiters");
  });
});

// ---------------------------------------------------------------------------
// Error classification sanity checks — matching every other adapter's
// typed-error contract.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — error classification", () => {
  it("a malformed (non-JSON-shaped) postings response is classified, not silently swallowed as empty", async () => {
    const fetchImpl = makeFetch({
      postings: { BoschGroup: () => jsonResponse({ notTheRightShape: true }) },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);
    const { skipped } = await source.search({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/did not match the expected shape/);
  });

  it("classifies a 429 on the postings list as RateLimitedError internally (surfaced via the per-company skip)", async () => {
    // Directly exercises the classification helper's contract via a
    // single-company search whose only company rate-limits.
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () => new Response(null, { status: 429, headers: { "Retry-After": "12" } }),
      },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);
    const { skipped } = await source.search({});
    expect(skipped[0]?.reason).toMatch(/rate limit/i);
  });
});
