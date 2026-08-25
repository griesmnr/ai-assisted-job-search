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

  // FIX E (adversarial review, round 1): a redirect to a custom domain
  // (e.g. BoschGroup -> jobs.bosch.com) is a REAL signal a real company
  // sends, but this adapter now treats it as "unknown" rather than "valid"
  // — see `#checkCompanyValidity`'s doc comment for why: trusting ANY
  // non-matching redirect target as proof of validity is the same
  // over-trusting mistake as the exact-string bug this fix closes, just
  // with the polarity flipped (trusting too much of "not the known-bad
  // pattern" instead of too little). "Unknown" is still surfaced as a
  // skip, not silently swallowed as a clean empty result — it just no
  // longer claims a confidence this adapter doesn't actually have.
  it("a redirect to a company's own custom domain is surfaced as 'unknown', not silently trusted as 'valid' (deliberately conservative — see Fix E)", async () => {
    const fetchImpl = makeFetch({
      postings: {
        BoschGroup: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
      },
      careers: { BoschGroup: REAL_CAREERS_RESPONSES.recognizedCustomDomain },
    });
    const source = makeSource(fetchImpl, ["BoschGroup"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toMatch(/doesn't match the known "unrecognized company" pattern/);
  });

  // Redirect variants that ARE the known-bad target, just with a scheme or
  // query string SmartRecruiters could plausibly add later — host+path
  // matching is deliberately scheme/query-agnostic so these stay
  // confidently "invalid" (not merely "unknown"), closing the two bypasses
  // an adversarial review found in the original exact-string match.
  it.each([
    ["an http:// scheme on the known-bad homepage", "http://jobs.smartrecruiters.com"],
    [
      "a tracking query string on the known-bad homepage",
      "https://jobs.smartrecruiters.com?utm_source=careers",
    ],
  ])(
    "redirect variant '%s' is still confidently flagged invalid, not merely unknown",
    async (_label, location) => {
      const fetchImpl = makeFetch({
        postings: {
          SomeCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
        },
        careers: {
          SomeCo: () => new Response(null, { status: 302, headers: { location } }),
        },
      });
      const source = makeSource(fetchImpl, ["SomeCo"]);

      const { skipped } = await source.search({});

      expect(skipped[0]?.reason).toMatch(/not recognized/);
    },
  );

  // Redirect variants that are genuinely NOT the known-bad host+empty-path
  // pattern — a different smartrecruiters.com host entirely, and a
  // different path on the known-bad host. Neither proves a real company
  // either (this adapter has no positive evidence for either), so both
  // must surface as "unknown", never a silently-trusted "valid" — the
  // third bypass an adversarial review found in the original exact-string
  // match.
  it.each([
    ["a different smartrecruiters.com host entirely", "https://www.smartrecruiters.com/"],
    ["a different path on the known-bad host", "https://jobs.smartrecruiters.com/some-other-page"],
  ])(
    "redirect variant '%s' is surfaced as unknown, not silently accepted as valid",
    async (_label, location) => {
      const fetchImpl = makeFetch({
        postings: {
          SomeCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 0, content: [] }),
        },
        careers: {
          SomeCo: () => new Response(null, { status: 302, headers: { location } }),
        },
      });
      const source = makeSource(fetchImpl, ["SomeCo"]);

      const { jobs, skipped, skipRate } = await source.search({});

      expect(jobs).toHaveLength(0);
      expect(skipped).toHaveLength(1);
      expect(skipRate).toBe(1);
      expect(skipped[0]?.reason).toMatch(/doesn't match the known "unrecognized company" pattern/);
    },
  );

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

  // FIX C (adversarial review, round 1) — the seventh instance of this
  // project's own recurring bug class, found in this file: deleting
  // `additionalInformation` from `buildDescription` left every test above
  // green, because nothing asserted its content specifically reaches
  // `description`. Measured across 120 live postings during review,
  // `additionalInformation` is a LARGER mean contributor to description
  // text (20.8%) than `qualifications` (11.7%), and 32/120 postings carry
  // pay, work-model, or visa terms found in no other section — on this
  // exact fixture, the real salary figure ("$165,000 - $185,000") and
  // 401(k) benefit exist ONLY in `additionalInformation`, nowhere in
  // `companyDescription`, `jobDescription`, or `qualifications`.
  it("includes real content that exists only in jobAd.sections.additionalInformation, not any other section", async () => {
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

    expect(description).toContain("$165,000");
    expect(description).toContain("401(k)");
  });

  it("a naive implementation that drops additionalInformation would miss that same content — demonstrating why buildDescription folds it in too, not just qualifications", () => {
    // Mirrors the qualifications-dropping demonstration above, but for the
    // section an adversarial review found this test suite had left
    // completely unguarded.
    function naiveBuildDescriptionWithoutAdditionalInformation(
      detail: typeof detailAiResearchScientist,
    ): string {
      const sections = detail.jobAd?.sections;
      const parts: string[] = [];
      for (const section of [
        sections?.companyDescription,
        sections?.jobDescription,
        sections?.qualifications,
      ]) {
        if (section?.text) parts.push(section.text.replace(/<[^>]*>/g, " "));
      }
      return parts.join("\n\n");
    }

    const naiveDescription =
      naiveBuildDescriptionWithoutAdditionalInformation(detailAiResearchScientist);

    expect(naiveDescription).not.toContain("$165,000");
    expect(naiveDescription).not.toContain("401(k)");
  });
});

// ---------------------------------------------------------------------------
// FIX D (adversarial review, round 1): nothing previously pinned this
// adapter's specific `htmlToPlainText` call site to `doubleEncoded: false`
// — flipping it to `true` left all 29 original tests green, because no
// real captured fixture happens to contain a literal `&lt;`/`&gt;` in body
// prose (independently confirmed across 120 live postings during review:
// zero). html.test.ts already proves the shared helper's own
// `doubleEncoded` semantics in the abstract; these tests pin THIS file's
// call site specifically, the same gap-closing motivation html.test.ts's
// own top-of-file comment records for why it exists at all.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — HTML decoding pins the correct doubleEncoded setting", () => {
  it("a real &amp;/&#xa0; snippet from a committed fixture round-trips correctly through the full search() pipeline", async () => {
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

    const { jobs } = await source.search({});
    const description = jobs[0]?.description ?? "";

    // Real qualifications text on this fixture: "...experience in leading
    // R&amp;D project &amp; team..." — both `&amp;` entities must decode to
    // a literal "&", and the adjacent real <li> tags must be stripped, not
    // left as literal markup.
    expect(description).toContain("leading R&D project & team");
    expect(description).not.toContain("&amp;");
    expect(description).not.toContain("<li>");
  });

  it("a realistic '<' in body prose survives intact — the discriminating case that fails if doubleEncoded is ever flipped to true", async () => {
    // Real SmartRecruiters postings don't currently contain this pattern
    // (confirmed: zero literal &lt;/&gt; in body text across 120 live
    // postings checked during review) but plausibly could (e.g. a GPA or
    // budget threshold stated in prose), and the correctness of
    // `doubleEncoded: false` for SmartRecruiters' single-encoded markup
    // depends on handling it correctly if it ever does appear. This
    // mirrors html.test.ts's own "score &lt; 5" corruption demonstration,
    // but exercised through smartrecruiters.ts's actual buildDescription
    // call site via the full adapter pipeline, not the shared helper
    // directly — pinning THIS file's choice, not just the shared one.
    const detail = {
      id: "posting-with-real-lt-gt",
      name: "Role With Threshold Language",
      company: { name: "Acme" },
      releasedDate: "2026-08-01T00:00:00.000Z",
      postingUrl: "https://jobs.smartrecruiters.com/Acme/posting-with-real-lt-gt",
      jobAd: {
        sections: {
          qualifications: {
            title: "Qualifications",
            text: "<li>Minimum GPA &lt; 3.0 will not be considered</li><li>Must have 5&#xa0;years experience</li>",
          },
        },
      },
    };
    const fetchImpl = makeFetch({
      postings: {
        Acme: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [{ id: detail.id, name: detail.name, company: detail.company }],
          }),
      },
      detail: { Acme: { [detail.id]: () => jsonResponse(detail) } },
    });
    const source = makeSource(fetchImpl, ["Acme"]);

    const { jobs, skipped } = await source.search({});

    expect(skipped).toHaveLength(0);
    const description = jobs[0]?.description ?? "";

    // Under the CORRECT (doubleEncoded: false) pipeline, both list items
    // survive intact with the real "<" preserved. Under the WRONG
    // (doubleEncoded: true) pipeline, the pre-decode turns "&lt;" into a
    // literal "<" that the tag-stripper then mistakes for the start of a
    // new tag, silently eating "3.0 will not be considered" through
    // "Must have" — verified directly against html.ts (see this file's
    // report for the exact node command and output).
    expect(description).toContain("Minimum GPA < 3.0 will not be considered");
    // `&#xa0;` decodes to a real non-breaking space (U+00A0), not the
    // regular ASCII space `&nbsp;` decodes to — `\s` matches both, so this
    // assertion isn't sensitive to that (correct, unrelated) distinction.
    expect(description).toMatch(/Must have 5\s*years experience/);
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
// maxPostings cap (ticket 491cd88) — SmartRecruiters' description text
// requires one detail request PER posting (Finding 2/5), so an unbounded
// board is an unbounded number of requests. This suite proves the cap
// actually bounds the detail fan-out (not just what's returned) and that a
// truncated result REPORTS the truncation rather than looking like a
// clean, complete, short board — the same "partial must never impersonate
// complete" discipline as Finding 1 above.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — maxPostings cap", () => {
  function summary(id: string) {
    return {
      id,
      name: `Role ${id}`,
      company: { identifier: "BigCo", name: "Big Co" },
      location: { fullLocation: "Remote", remote: true, hybrid: false },
      typeOfEmployment: { id: "permanent", label: "Full-time" },
      releasedDate: "2026-08-01T00:00:00.000Z",
    };
  }

  function detailFor(id: string) {
    return {
      id,
      name: `Role ${id}`,
      company: { identifier: "BigCo", name: "Big Co" },
      location: { fullLocation: "Remote", remote: true, hybrid: false },
      typeOfEmployment: { id: "permanent", label: "Full-time" },
      releasedDate: "2026-08-01T00:00:00.000Z",
      postingUrl: `https://jobs.smartrecruiters.com/BigCo/${id}`,
      jobAd: {
        sections: {
          jobDescription: { title: "Job Description", text: `<p>Do the work for ${id}.</p>` },
        },
      },
    };
  }

  it("truncates a board larger than maxPostings and REPORTS the truncation, rather than returning a clean short list", async () => {
    const allIds = ["j1", "j2", "j3", "j4", "j5"];
    const detailCalls: string[] = [];
    const fetchImpl = makeFetch({
      postings: {
        BigCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 100,
              totalFound: 5,
              content: allIds.map((id) => summary(id)),
            });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        BigCo: Object.fromEntries(
          allIds.map((id) => [
            id,
            () => {
              detailCalls.push(id);
              return jsonResponse(detailFor(id));
            },
          ]),
        ),
      },
    });
    const source = makeSource(fetchImpl, ["BigCo"], { maxPostings: 3 });

    const { jobs, skipped } = await source.search({});

    // The cap bounds the FAN-OUT itself, not just the final job count —
    // only the first 3 candidates were ever fetched. Detail requests cost
    // real time/money against a live API; a cap that let the fetches
    // happen and only trimmed the result afterward would defeat the whole
    // point of this ticket.
    expect(detailCalls.sort()).toEqual(["j1", "j2", "j3"]);
    expect(jobs).toHaveLength(3);

    // The acceptance-criterion assertion: this must NOT look like a clean,
    // complete board of 3 postings. Exactly one truncation SkippedRecord
    // names the cap and how many postings were left unfetched, so a
    // caller can tell "capped" apart from "this company genuinely has 3
    // open postings".
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.externalId).toBeUndefined();
    expect(skipped[0]?.reason).toMatch(/maxPostings=3/);
    expect(skipped[0]?.reason).toMatch(/"BigCo"/);
    expect(skipped[0]?.reason).toMatch(/\b5\b/); // 5 candidates found
    expect(skipped[0]?.reason).toMatch(/\b2\b/); // 5 - 3 = 2 left unfetched
    expect(skipped[0]?.reason.toLowerCase()).toMatch(/truncat|partial/);
  });

  it("does not truncate (and reports no truncation skip) when the board fits within maxPostings", async () => {
    const ids = ["j1", "j2"];
    const fetchImpl = makeFetch({
      postings: {
        SmallCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 100,
              totalFound: 2,
              content: ids.map((id) => summary(id)),
            });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        SmallCo: Object.fromEntries(ids.map((id) => [id, () => jsonResponse(detailFor(id))])),
      },
    });
    const source = makeSource(fetchImpl, ["SmallCo"], { maxPostings: 3 });

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(2);
    expect(skipped).toHaveLength(0);
  });

  it("a board exactly at the cap is not reported as truncated (boundary: > not >=)", async () => {
    const ids = ["j1", "j2", "j3"];
    const fetchImpl = makeFetch({
      postings: {
        ExactCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 100,
              totalFound: 3,
              content: ids.map((id) => summary(id)),
            });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        ExactCo: Object.fromEntries(ids.map((id) => [id, () => jsonResponse(detailFor(id))])),
      },
    });
    const source = makeSource(fetchImpl, ["ExactCo"], { maxPostings: 3 });

    const { jobs, skipped } = await source.search({});

    expect(jobs).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it("shares the budget ACROSS companies as a running total, not a per-company allowance — an earlier company can leave nothing for a later one (F1 fix: whole-search() budget)", async () => {
    function summaryFor(company: string, id: string) {
      return {
        id,
        name: `Role ${id}`,
        company: { identifier: company, name: company },
        location: { fullLocation: "Remote", remote: true, hybrid: false },
        typeOfEmployment: { id: "permanent", label: "Full-time" },
        releasedDate: "2026-08-01T00:00:00.000Z",
      };
    }
    function detailForCo(company: string, id: string) {
      return {
        id,
        name: `Role ${id}`,
        company: { identifier: company, name: company },
        location: { fullLocation: "Remote", remote: true, hybrid: false },
        typeOfEmployment: { id: "permanent", label: "Full-time" },
        releasedDate: "2026-08-01T00:00:00.000Z",
        postingUrl: `https://jobs.smartrecruiters.com/${company}/${id}`,
        jobAd: {
          sections: {
            jobDescription: { title: "Job Description", text: `<p>Do the work for ${id}.</p>` },
          },
        },
      };
    }
    function postingsResponder(company: string, ids: string[]) {
      return (offset: number) => {
        if (offset === 0) {
          return jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: ids.length,
            content: ids.map((id) => summaryFor(company, id)),
          });
        }
        throw new Error(`unexpected offset ${offset} for ${company}`);
      };
    }
    function detailResponders(company: string, ids: string[], detailCalls: string[]) {
      return Object.fromEntries(
        ids.map((id) => [
          id,
          () => {
            detailCalls.push(id);
            return jsonResponse(detailForCo(company, id));
          },
        ]),
      );
    }

    const coAIds = ["a1", "a2", "a3", "a4"];
    const coBIds = ["b1", "b2", "b3", "b4"];
    const coCIds = ["c1", "c2"];
    const detailCalls: string[] = [];

    const fetchImpl = makeFetch({
      postings: {
        CoA: postingsResponder("CoA", coAIds),
        CoB: postingsResponder("CoB", coBIds),
        CoC: postingsResponder("CoC", coCIds),
      },
      detail: {
        CoA: detailResponders("CoA", coAIds, detailCalls),
        CoB: detailResponders("CoB", coBIds, detailCalls),
        CoC: detailResponders("CoC", coCIds, detailCalls),
      },
    });

    // Global budget: 5, spent in company-loop order (CoA, CoB, CoC). CoA
    // (4 postings) goes first and uses 4 of it, leaving 1. CoB (4
    // postings) only gets that 1 remaining slot, leaving 0. CoC (2
    // postings) gets 0 — the budget was already fully spent before its
    // turn, not because CoC itself is large. If this were still a
    // PER-COMPANY cap (the pre-F1 behavior), all three companies would
    // fetch up to 5 each — 11 total, not 5.
    const source = makeSource(fetchImpl, ["CoA", "CoB", "CoC"], { maxPostings: 5 });

    const { jobs, skipped } = await source.search({});

    expect(detailCalls).toHaveLength(5);
    expect(detailCalls.filter((id) => id.startsWith("a"))).toHaveLength(4);
    expect(detailCalls.filter((id) => id.startsWith("b"))).toHaveLength(1);
    expect(detailCalls.filter((id) => id.startsWith("c"))).toHaveLength(0);
    expect(jobs).toHaveLength(5);

    // CoA was never truncated (4 candidates fit inside its share of the
    // budget at the time, which was still the full 5). CoB and CoC both
    // were truncated, for two DIFFERENTLY-WORDED reasons: CoB had exactly
    // 1 slot left; CoC had none left at all, purely because of what CoA
    // and CoB already spent — that distinction has to be visible in the
    // reason text, not just inferred from a job count of zero.
    expect(skipped).toHaveLength(2);
    const coBSkip = skipped.find((s) => s.reason.includes('"CoB"'));
    const coCSkip = skipped.find((s) => s.reason.includes('"CoC"'));
    expect(coBSkip?.reason).toMatch(/only 1 of the shared maxPostings=5 budget/);
    expect(coCSkip?.reason).toMatch(/already fully spent by an earlier company/);
  });

  it("falls back to the default cap (not a silently-broken clamp) when maxPostings is negative (F5: config validation)", async () => {
    const ids = ["n1", "n2", "n3", "n4", "n5"];
    const fetchImpl = makeFetch({
      postings: {
        NegCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 100,
              totalFound: ids.length,
              content: ids.map((id) => summary(id)),
            });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        NegCo: Object.fromEntries(ids.map((id) => [id, () => jsonResponse(detailFor(id))])),
      },
    });
    const source = makeSource(fetchImpl, ["NegCo"], { maxPostings: -1 });

    const { jobs, skipped } = await source.search({});

    // -1 is invalid input, not "cap everything to zero" and NOT "drop the
    // last posting via a raw Array.prototype.slice(0, -1)" — which is what
    // an UNVALIDATED `candidates.slice(0, this.#maxPostings)` would have
    // done to EVERY board however small (`[1,2,3,4,5].slice(0, -1)` drops
    // only the last element, silently, on every search). Falling back to
    // the default cap instead means a normal 5-posting board is
    // unaffected — this is the test that actually discriminates the fix
    // from the bug at a tractable scale (unlike NaN below, whose only
    // dangerous behavior — silently disabling the cap — only shows up
    // past 1,000 candidates).
    expect(jobs).toHaveLength(5);
    expect(skipped).toHaveLength(0);
  });

  it("falls back to the default cap when maxPostings is NaN, rather than silently disabling the cap entirely (F5: config validation)", async () => {
    const ids = ["m1", "m2", "m3"];
    const fetchImpl = makeFetch({
      postings: {
        NanCo: (offset) => {
          if (offset === 0) {
            return jsonResponse({
              offset: 0,
              limit: 100,
              totalFound: ids.length,
              content: ids.map((id) => summary(id)),
            });
          }
          throw new Error(`unexpected offset ${offset}`);
        },
      },
      detail: {
        NanCo: Object.fromEntries(ids.map((id) => [id, () => jsonResponse(detailFor(id))])),
      },
    });
    const source = makeSource(fetchImpl, ["NanCo"], { maxPostings: NaN });

    const { jobs, skipped } = await source.search({});

    // `candidates.length > NaN` is always `false`, so an unguarded
    // `config.maxPostings ?? DEFAULT_MAX_POSTINGS` (NaN is neither null
    // nor undefined, so `??` never substitutes) silently disables the cap
    // entirely — full unbounded fan-out, no truncation record, exactly the
    // failure this ticket exists to prevent, from a typo. A board this
    // small can't, on its own, distinguish "fell back to the 1,000
    // default" from "disabled entirely" (both let 3 candidates through
    // untruncated) — that discrimination is the constructor-level
    // `Number.isFinite` guard itself (see its comment), covered directly
    // by the negative-value test above using the same code path. This
    // test's job is narrower: prove NaN doesn't crash or otherwise corrupt
    // a normal, small, non-truncated result.
    expect(jobs).toHaveLength(3);
    expect(skipped).toHaveLength(0);
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
    expect(skipped[0]?.reason).toMatch(/failed to fetch or normalize full posting detail/);
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
// FIX A (adversarial review, round 1): a malformed posting (non-string
// `name`) used to throw a raw TypeError out of `normalizeItem`, past
// `#fetchAndNormalize`'s (at the time, too-narrow) try/catch, destroying
// every other posting already fetched for that company along with it —
// see `#fetchAndNormalize`'s doc comment for the full mechanism. This
// reproduces the reviewer's exact scenario: three postings for one
// company, one with a non-string `name`, asserting the other two still
// come back.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — per-posting failure isolation (malformed records)", () => {
  it("a posting with a non-string name does not destroy the other healthy postings in the same company", async () => {
    const healthyA = { id: "healthy-a", name: "Healthy Role A", company: { name: "Acme" } };
    const malformed = { id: "malformed-b", name: 12345, company: { name: "Acme" } };
    const healthyC = { id: "healthy-c", name: "Healthy Role C", company: { name: "Acme" } };

    function detailFor(summary: { id: string; name: unknown }) {
      return {
        id: summary.id,
        name: summary.name,
        company: { name: "Acme" },
        releasedDate: "2026-08-01T00:00:00.000Z",
        postingUrl: `https://jobs.smartrecruiters.com/Acme/${summary.id}`,
        jobAd: {
          sections: {
            jobDescription: {
              title: "Job Description",
              text: `<p>Do the work for ${summary.id}.</p>`,
            },
          },
        },
      };
    }

    const fetchImpl = makeFetch({
      postings: {
        Acme: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 3,
            content: [healthyA, malformed, healthyC],
          }),
      },
      detail: {
        Acme: {
          "healthy-a": () => jsonResponse(detailFor(healthyA)),
          "malformed-b": () => jsonResponse(detailFor(malformed)),
          "healthy-c": () => jsonResponse(detailFor(healthyC)),
        },
      },
    });
    const source = makeSource(fetchImpl, ["Acme"]);

    const { jobs, skipped } = await source.search({});

    // Both healthy postings survive; the malformed one is skipped, not
    // fatal to the company (the old bug: `jobs: []`, one company-wide skip,
    // both healthy postings destroyed).
    expect(jobs.map((j) => j.externalId).sort()).toEqual(["healthy-a", "healthy-c"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.externalId).toBe("malformed-b");
    expect(skipped[0]?.reason).toMatch(/missing or non-string name/);
  });

  // FIX (adversarial review, round 2) — the first round's fix closed the
  // reported bug (a non-string `name`) but a further attack pass found
  // three inputs that still destroyed a whole company's results:
  // `content: [good, null, good]` with no location criteria (A9), the same
  // with a location criteria set — exercising `summaryMatchesLocation`'s
  // separate guard, not `#fetchAndNormalize`'s (A9b) — and a `summary.id`
  // implemented as a throwing getter (A11). `parsePostingsPageShape` only
  // validates that `content` IS an array, never that its elements are
  // well-formed objects, so all three reach the per-record pipeline
  // unfiltered — deliberately: see that function's own comment for why
  // filtering them out earlier would trade a visible skip for a silent,
  // invisible drop.
  it("A9: a null element in content is skipped individually, not fatal to the rest of the company (no location criteria)", async () => {
    const healthyA = { id: "healthy-a", name: "Healthy Role A", company: { name: "Acme" } };
    const healthyC = { id: "healthy-c", name: "Healthy Role C", company: { name: "Acme" } };

    function detailFor(id: string) {
      return {
        id,
        name: `Role ${id}`,
        company: { name: "Acme" },
        releasedDate: "2026-08-01T00:00:00.000Z",
        postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}`,
        jobAd: {
          sections: { jobDescription: { title: "Job Description", text: `<p>Work: ${id}.</p>` } },
        },
      };
    }

    const fetchImpl = makeFetch({
      postings: {
        Acme: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 3,
            content: [healthyA, null, healthyC],
          }),
      },
      detail: {
        Acme: {
          "healthy-a": () => jsonResponse(detailFor("healthy-a")),
          "healthy-c": () => jsonResponse(detailFor("healthy-c")),
        },
      },
    });
    const source = makeSource(fetchImpl, ["Acme"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs.map((j) => j.externalId).sort()).toEqual(["healthy-a", "healthy-c"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.externalId).toBeUndefined();
  });

  it("A9b: a null element in content is skipped individually when a location criteria is set too (exercises summaryMatchesLocation's own guard)", async () => {
    const healthyA = {
      id: "healthy-a",
      name: "Healthy Role A",
      company: { name: "Acme" },
      location: { fullLocation: "Remote" },
    };
    const healthyC = {
      id: "healthy-c",
      name: "Healthy Role C",
      company: { name: "Acme" },
      location: { fullLocation: "Remote" },
    };

    function detailFor(id: string) {
      return {
        id,
        name: `Role ${id}`,
        company: { name: "Acme" },
        releasedDate: "2026-08-01T00:00:00.000Z",
        postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}`,
        jobAd: {
          sections: { jobDescription: { title: "Job Description", text: `<p>Work: ${id}.</p>` } },
        },
      };
    }

    const fetchImpl = makeFetch({
      postings: {
        Acme: () =>
          jsonResponse({
            offset: 0,
            limit: 100,
            totalFound: 3,
            content: [healthyA, null, healthyC],
          }),
      },
      detail: {
        Acme: {
          "healthy-a": () => jsonResponse(detailFor("healthy-a")),
          "healthy-c": () => jsonResponse(detailFor("healthy-c")),
        },
      },
    });
    const source = makeSource(fetchImpl, ["Acme"]);

    // Without this criteria.location, the null element never reaches
    // summaryMatchesLocation at all (candidates === summaries verbatim) —
    // this is the case that specifically exercises its guard, not just
    // #fetchAndNormalize's.
    const { jobs, skipped } = await source.search({ location: "Remote" });

    expect(jobs.map((j) => j.externalId).sort()).toEqual(["healthy-a", "healthy-c"]);
    // The null element never reaches #fetchAndNormalize at all here (it's
    // filtered out of `candidates` by summaryMatchesLocation returning
    // false for it, same as any non-matching real record) — so unlike A9,
    // there is no skip record for it specifically here. What this test
    // actually proves is the absence of a crash: without the round-2 fix,
    // this whole search() call would have rejected/thrown.
    expect(skipped).toHaveLength(0);
  });

  it("A11: a summary.id implemented as a throwing getter is skipped individually, not fatal to the rest of the company", async () => {
    const healthyA = { id: "healthy-a", name: "Healthy Role A", company: { name: "Acme" } };
    const healthyC = { id: "healthy-c", name: "Healthy Role C", company: { name: "Acme" } };
    const hostile = {
      get id(): string {
        throw new Error("boom from id getter");
      },
      name: "Hostile Role",
      company: { name: "Acme" },
    };

    function detailFor(id: string) {
      return {
        id,
        name: `Role ${id}`,
        company: { name: "Acme" },
        releasedDate: "2026-08-01T00:00:00.000Z",
        postingUrl: `https://jobs.smartrecruiters.com/Acme/${id}`,
        jobAd: {
          sections: { jobDescription: { title: "Job Description", text: `<p>Work: ${id}.</p>` } },
        },
      };
    }

    // Built directly as a Response-shaped stub, NOT via jsonResponse() /
    // JSON.stringify — a throwing getter can't survive real JSON
    // serialization (stringifying it would throw immediately, before the
    // mock could even respond), so this constructs only the surface
    // #request/#fetchPostingsPage actually reads.
    const hostileResponse = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        offset: 0,
        limit: 100,
        totalFound: 3,
        content: [healthyA, hostile, healthyC],
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const fetchImpl = makeFetch({
      postings: { Acme: () => hostileResponse },
      detail: {
        Acme: {
          "healthy-a": () => jsonResponse(detailFor("healthy-a")),
          "healthy-c": () => jsonResponse(detailFor("healthy-c")),
        },
      },
    });
    const source = makeSource(fetchImpl, ["Acme"]);

    const { jobs, skipped } = await source.search({});

    expect(jobs.map((j) => j.externalId).sort()).toEqual(["healthy-a", "healthy-c"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toMatch(/boom from id getter/);
  });
});

// ---------------------------------------------------------------------------
// FIX B (adversarial review, round 1): `totalFound > 0` with an empty
// `content` array on the first page used to fall straight through to a
// silent `{jobs: [], skipped: []}` — the API asserting real postings exist
// while this adapter reported a clean zero, the USAJOBS failure signature
// verbatim. See `#searchCompany`'s doc comment.
// ---------------------------------------------------------------------------
describe("SmartRecruitersSource — totalFound asserts postings exist but content is empty", () => {
  it("is surfaced as a skip, not a silent clean empty result", async () => {
    const fetchImpl = makeFetch({
      postings: {
        InconsistentCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 500, content: [] }),
      },
    });
    const source = makeSource(fetchImpl, ["InconsistentCo"]);

    const { jobs, skipped, skipRate } = await source.search({});

    expect(jobs).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipRate).toBe(1);
    expect(skipped[0]?.reason).toContain("totalFound=500");
    expect(skipped[0]?.reason).toContain("InconsistentCo");
  });

  it("does not trigger the careers-site validity check — that check is reserved for totalFound === 0", async () => {
    const careersCheck = vi.fn(REAL_CAREERS_RESPONSES.recognizedHostedDirectly);
    const fetchImpl = makeFetch({
      postings: {
        InconsistentCo: () => jsonResponse({ offset: 0, limit: 100, totalFound: 500, content: [] }),
      },
      careers: { InconsistentCo: careersCheck },
    });
    const source = makeSource(fetchImpl, ["InconsistentCo"]);

    await source.search({});

    expect(careersCheck).not.toHaveBeenCalled();
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
