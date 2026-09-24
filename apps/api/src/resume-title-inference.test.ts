import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { inferTitleKeywords } from "./resume-title-inference.js";
import { compileFilter } from "./sources/criteria.js";
import type { NormalizedJob } from "./sources/types.js";

/**
 * Tests for git-bug 5ba5cca: Nicole's real, currently-saved job matches
 * (postings like GitLab's "Intermediate Backend Engineer, AMER", confirmed
 * still live on GitLab's board at investigation time) scored well against
 * her resume, but her auto-generated title chips -- "Senior Full Stack
 * Software Developer", "Backend Software Engineer (Java/Node.js)",
 * "Software Developer - Cloud & Microservices", "AI Application Developer",
 * "React/Angular Frontend Developer" -- matched ZERO of three tested real,
 * live, previously-scoring postings when run through the actual
 * `compileFilter` (criteria.ts) word-boundary literal matcher, while a
 * plain "backend engineer" term correctly matched them. Root cause:
 * `inferTitleKeywords`'s prompt asked for "concise" titles but did not
 * forbid parentheticals/slashes/bolted-on tech names, so Claude folded the
 * resume's own tech-stack language into the suggested title text.
 *
 * `criteria.ts`'s literal, word-boundary matching itself is explicitly OUT
 * OF SCOPE (a deliberate precision-over-recall design used elsewhere, e.g.
 * metroAreas.ts) -- these tests exercise it as a fixed, known quantity to
 * prove the prompt fix closes the loop end to end, not to test it in its
 * own right (see criteria.test.ts for that).
 */

type FakeCreateParams = {
  model: string;
  max_tokens: number;
  output_config: { format: { type: string; schema: unknown } };
  messages: Array<{ role: string; content: string }>;
};

/** Fakes just enough of an `Anthropic` client for `inferTitleKeywords` --
 * captures every `create` call's params (so tests can assert on the actual
 * prompt/schema text sent) and returns a caller-supplied `titles` array as
 * the JSON response. No real network, no ANTHROPIC_API_KEY required and no
 * paid API call -- same no-network pattern as demo-match.test.ts's
 * `makeFakeAnthropicClient`, which this project's existing tests already
 * establish as how this codebase unit-tests Anthropic call sites. */
function makeFakeAnthropicClient(titles: string[]): {
  anthropic: Anthropic;
  capturedParams: FakeCreateParams[];
} {
  const capturedParams: FakeCreateParams[] = [];
  const fakeClient = {
    messages: {
      create: async (params: FakeCreateParams) => {
        capturedParams.push(params);
        return { content: [{ type: "text", text: JSON.stringify({ titles }) }] };
      },
    },
  };
  return { anthropic: fakeClient as unknown as Anthropic, capturedParams };
}

function titlesSchemaDescription(params: FakeCreateParams): string {
  return (
    params.output_config.format.schema as {
      properties: { titles: { description: string } };
    }
  ).properties.titles.description;
}

// A resume shaped like the one behind the real incident: senior, full
// stack, and explicitly namedropping the exact technologies that ended up
// baked into Nicole's actual bad chips (Java, Node.js, Cloud, Microservices,
// React, Angular). Not Nicole's literal resume text (not available to this
// test suite) -- an equivalent fixture per the ticket's own acceptance
// criteria.
const INCIDENT_SHAPED_RESUME =
  "Jane Doe. Senior Full Stack Software Engineer, 8 years experience. Backend: Java and " +
  "Node.js, building REST APIs and Cloud-native Microservices on AWS. Frontend: React and " +
  "Angular single-page applications. Led the migration of a monolith to a microservices " +
  "architecture. Also shipped a small internal AI-assisted support tool. BS Computer Science.";

describe("inferTitleKeywords prompt/schema content (ticket 5ba5cca)", () => {
  it("explicitly forbids parentheses, slashes, and bolted-on technology names in the title text, with the incident's own good/bad examples", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Backend Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(capturedParams).toHaveLength(1);
    const sentPrompt = capturedParams[0]!.messages[0]!.content;
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);
    const combined = sentPrompt + schemaDescription;

    // "Concise" alone (the old prompt's word) did not stop the incident --
    // Nicole's actual chips included "Backend Software Engineer
    // (Java/Node.js)" despite the old prompt already saying "concise". The
    // fix has to be an explicit, structural prohibition, not a vibe word.
    expect(combined).toMatch(/parenthes/i);
    expect(combined).toMatch(/slash/i);
    expect(combined).toMatch(/technology|tech stack/i);

    // Concrete good/bad examples pulled from this exact incident (git-bug
    // 5ba5cca's root cause: zero of three of Nicole's real saved postings
    // passed `compileFilter` against her actual chips; see the
    // compileFilter round-trip tests below for the live proof). "Backend
    // Engineer" alone is NOT asserted here -- the OLD prompt already
    // contained it as an example, so it wouldn't catch a regression back
    // to the old wording. These two only appear after the fix.
    expect(schemaDescription).toContain("Backend Software Engineer (Java/Node.js)");
    expect(schemaDescription).toContain("React/Angular Frontend Developer");
  });

  it("forbids a technology name bolted on as a QUALIFIER but explicitly allows one that IS the title's head (review round 1, F2)", async () => {
    // The first draft of this fix banned 'Cloud'/'Microservices' as bare
    // words, which would also suppress real, common board titles like
    // "Cloud Engineer" and "Machine Learning Engineer" for a cloud/ML
    // resume -- reintroducing the same under-matching bug for a different
    // profession. The schema must state the qualifier-vs-head distinction
    // explicitly, not just list forbidden words.
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Cloud Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);

    expect(schemaDescription).toContain("Cloud Engineer");
    expect(schemaDescription).toMatch(/machine learning engineer/i);
    expect(schemaDescription).toMatch(/qualifier/i);
    // The old, over-broad wording blanket-forbade these as bare words --
    // confirm that specific phrasing is gone.
    expect(schemaDescription).not.toMatch(/'Cloud', 'Microservices'/);
  });

  it("keeps a seniority-prefixed phrase in the good examples so 'short' doesn't get read as 'strip seniority' (review round 1, F3)", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Senior Full Stack Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);

    expect(schemaDescription).toMatch(/senior full stack engineer/i);
  });

  it("keeps the existing, correct instructions intact: 3-6 titles and preserving evidenced seniority", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Staff Backend Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);

    expect(schemaDescription).toMatch(/3-6/);
    expect(schemaDescription).toMatch(/senior\/staff\/principal/i);
    expect(schemaDescription).toMatch(/entry-level/i);
  });
});

/**
 * Tests for git-bug 976a782 (round 2 of the same problem): Nicole's fresh
 * resume edit produced "Software Engineer, Microservices" as one
 * comma-joined chip, plus "Backend Software Engineer" and "Cloud Software
 * Engineer" (extra qualifier words on top of otherwise-standard titles).
 * Root cause confirmed against `compileFilter`: of 7 common real-world
 * titles, only "Full Stack Engineer" matched -- see the round-trip proof
 * describe block below.
 */
describe("inferTitleKeywords prompt/schema content (ticket 976a782)", () => {
  it("explicitly forbids joining two role concepts into one entry with a comma or semicolon, naming the exact incident chip, without over-forbidding a real 'and' compound title", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Software Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    const sentPrompt = capturedParams[0]!.messages[0]!.content;
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);
    const combined = sentPrompt + schemaDescription;

    expect(combined).toMatch(/comma/i);
    expect(combined).toMatch(/semicolon/i);
    // Nicole's actual reported bad chip, named directly -- same tactic
    // 5ba5cca used for its own incident's bad examples.
    expect(schemaDescription).toContain("Software Engineer, Microservices");
    // Round 1 review, F3: the prompt must NOT tell the model to avoid "and"/
    // "&" entirely, since splitConjoinedTitles no longer splits on either
    // (real compound titles like "Health and Safety Engineer" need to
    // survive) -- confirm the prompt explicitly carves this out rather than
    // silently contradicting the code.
    expect(combined).toMatch(/health and safety engineer/i);
  });

  it("guides toward the shortest common phrasing, naming the exact over-qualified chips from tonight's incident", async () => {
    const { anthropic, capturedParams } = makeFakeAnthropicClient(["Backend Engineer"]);
    await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);
    const schemaDescription = titlesSchemaDescription(capturedParams[0]!);

    expect(schemaDescription).toContain("Backend Software Engineer");
    expect(schemaDescription).toContain("Cloud Software Engineer");
    expect(schemaDescription).toMatch(/shortest/i);
    expect(schemaDescription).toMatch(/generic/i);
  });
});

describe("splitConjoinedTitles behavior via inferTitleKeywords (ticket 976a782)", () => {
  it("splits a comma-joined chip into two separate standalone chips", async () => {
    const { anthropic } = makeFakeAnthropicClient([
      "Software Engineer, Microservices",
      "Backend Engineer",
    ]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    // "Microservices" is dropped, not kept as its own chip (opus review
    // round 1, F2): it's a single word, and a bare single-word chip split
    // out of a qualifier is exactly the false-positive risk
    // titleSynonyms.ts's qualifier rule exists to prevent for expansion --
    // splitConjoinedTitles must not reintroduce it for a different reason.
    expect(titles).toEqual(["Software Engineer", "Backend Engineer"]);
    for (const title of titles) {
      expect(title).not.toMatch(/,/);
    }
  });

  it("splits a semicolon-joined chip into standalone chips, dropping any single-word fragment", async () => {
    const { anthropic } = makeFakeAnthropicClient([
      "Backend Engineer; DevOps Engineer",
      "Data Platform; Analytics Engineer",
    ]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual([
      "Backend Engineer",
      "DevOps Engineer",
      "Data Platform",
      "Analytics Engineer",
    ]);
  });

  it("does NOT split on '&' or the word 'and' -- a real compound title containing either survives whole (opus review round 1, F3)", async () => {
    // An earlier version of this function also split on "&"/"and", which
    // review found genuinely destructive on real job titles that legitimately
    // contain them: "Health and Safety Engineer" -> ["Health", "Safety
    // Engineer"], both wrong. The actual reported incident never involved
    // "and"/"&" at all -- only a comma.
    const { anthropic } = makeFakeAnthropicClient([
      "Health and Safety Engineer",
      "Research and Development Engineer",
      "Data & Analytics Engineer",
    ]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual([
      "Health and Safety Engineer",
      "Research and Development Engineer",
      "Data & Analytics Engineer",
    ]);
  });

  it("does NOT split a word that merely contains 'and' with no surrounding whitespace, e.g. 'Android'", async () => {
    const { anthropic } = makeFakeAnthropicClient(["Android Developer", "Brand Manager"]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual(["Android Developer", "Brand Manager"]);
  });

  it("drops a fragment shorter than two words entirely -- never surfaces a bare one-word chip (opus review round 1, F2)", async () => {
    // Live, unprompted, review found the FIRST version of this fix produce
    // bare chips like "Billing" and "Data" from a real model response --
    // each one then literal-matches (criteria.ts's makePhraseMatcher)
    // against ANY posting containing that word anywhere in its title
    // ("Billing Specialist", "Medical Billing Clerk"), not just the
    // compound qualifier it came from.
    const { anthropic } = makeFakeAnthropicClient(["Product Manager, Billing", "Product Manager"]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual(["Product Manager"]);
    expect(titles).not.toContain("Billing");
  });

  it("drops BOTH halves when a comma-joined chip splits into two single words -- never surfaces either as a bare chip", async () => {
    const { anthropic } = makeFakeAnthropicClient(["Backend, Cloud"]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual([]);
  });

  it("dedupes a fragment produced by splitting against an existing chip, case-insensitively", async () => {
    const { anthropic } = makeFakeAnthropicClient([
      "Backend Engineer, Platform Engineer",
      "platform engineer",
    ]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    // "platform engineer" (lowercase, its own separate chip) is a
    // case-insensitive duplicate of the fragment already produced by
    // splitting the first chip, so it is deduped rather than appended twice.
    expect(titles).toEqual(["Backend Engineer", "Platform Engineer"]);
  });
});

describe("inferTitleKeywords with a realistic post-fix mocked response (ticket 5ba5cca)", () => {
  it("passes through clean, board-realistic titles unchanged and none contain parens/slashes/bare tech names", async () => {
    // Stands in for what Claude should return AFTER the prompt change,
    // for a resume shaped like the one that previously produced "Senior
    // Full Stack Software Developer", "Backend Software Engineer
    // (Java/Node.js)", "Software Developer - Cloud & Microservices", "AI
    // Application Developer", "React/Angular Frontend Developer" (git-bug
    // 5ba5cca). This cannot be a real, paid Claude call in CI -- mocked per
    // the existing demo-match.test.ts pattern.
    const CLEAN_TITLES = [
      "Senior Full Stack Engineer",
      "Backend Engineer",
      "Software Engineer",
      "Frontend Engineer",
    ];
    const { anthropic } = makeFakeAnthropicClient(CLEAN_TITLES);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    expect(titles).toEqual(CLEAN_TITLES);
    for (const title of titles) {
      expect(title).not.toMatch(/[()/]/);
      expect(title).not.toMatch(/\b(java|node\.?js|react|angular|cloud|microservices?)\b/i);
    }
  });
});

function job(overrides: Partial<NormalizedJob> & Pick<NormalizedJob, "externalId">): NormalizedJob {
  return {
    dataSource: "greenhouse",
    title: "Software Engineer",
    description: "a job",
    company: "GitLab",
    location: "Remote - US",
    locationType: undefined,
    linkToApply: `https://example.com/${overrides.externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// Real, live posting titles from the ticket's own root-cause investigation
// (boards-api.greenhouse.io/v1/boards/gitlab/jobs, confirmed live at
// investigation time) -- these are the two postings that scored well for
// Nicole but that her old chips failed to surface.
const REAL_LIVE_POSTINGS: NormalizedJob[] = [
  job({ externalId: "gitlab-1", title: "Intermediate Backend Engineer, AMER" }),
  job({ externalId: "gitlab-2", title: "Intermediate Backend Engineer, Platform Readiness" }),
];

describe("compileFilter round-trip proof (ticket 5ba5cca root cause, re-run at the unit level)", () => {
  it("Nicole's OLD, actual bad-shaped chips match ZERO of the real live postings -- reproducing the root-cause finding", () => {
    const oldChips = [
      "Senior Full Stack Software Developer",
      "Backend Software Engineer (Java/Node.js)",
      "Software Developer - Cloud & Microservices",
      "AI Application Developer",
      "React/Angular Frontend Developer",
    ];
    const filter = compileFilter({ titleInclude: oldChips });
    expect(filter(REAL_LIVE_POSTINGS)).toHaveLength(0);
  });

  it("a NEW, clean-shaped chip ('Backend Engineer') matches both real live postings -- the matcher accepts the fixed shape", () => {
    // Only "Backend Engineer" is asserted here, deliberately: neither
    // posting's title contains "Full Stack" anywhere, so including it in
    // titleInclude wouldn't test anything extra -- it would just ride
    // along on the OR-filter and make the test claim more than it shows.
    const filter = compileFilter({ titleInclude: ["Backend Engineer"] });
    expect(
      filter(REAL_LIVE_POSTINGS)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["gitlab-1", "gitlab-2"]);
  });
});

describe("inferTitleKeywords with a realistic post-fix mocked response (ticket 976a782)", () => {
  it("splits the exact reported comma-joined chip and drops it as a single compound entry", async () => {
    // Stands in for what Claude should return AFTER this round's prompt
    // change, for a resume that previously produced Nicole's actual
    // reported chips: "Software Engineer, Microservices" (comma-joined),
    // "Backend Software Engineer", "Cloud Software Engineer" (extra
    // qualifier words). This cannot be a real, paid Claude call in CI --
    // mocked per the existing pattern above.
    const { anthropic } = makeFakeAnthropicClient(["Software Engineer, Microservices"]);
    const titles = await inferTitleKeywords(anthropic, INCIDENT_SHAPED_RESUME);

    // "Microservices" is dropped, not kept as a bare one-word chip (opus
    // review round 1, F2) -- see the splitConjoinedTitles describe block
    // above for the false-positive risk that would reintroduce.
    expect(titles).toEqual(["Software Engineer"]);
    expect(titles).not.toContain("Software Engineer, Microservices");
    expect(titles).not.toContain("Microservices");
  });
});

// A realistic MOCKED post-fix response for a resume shaped like the one
// behind tonight's incident: a bare, generic "Software Engineer" chip (the
// new "include at least one generic entry" guidance), a seniority-specific
// variant, and the two shortest-form domain titles ("Backend Engineer",
// "Cloud Engineer" -- NOT "Backend Software Engineer"/"Cloud Software
// Engineer", the two over-qualified chips actually reported). Not a live
// call result -- this is the acceptance criterion's own required mocked
// proof, distinct from the live-eval script's real-API evidence.
const NEW_CLEAN_CHIPS_976A782 = [
  "Software Engineer",
  "Senior Full Stack Engineer",
  "Backend Engineer",
  "Cloud Engineer",
];

// The exact 7 common real-world titles from the ticket's own root-cause
// investigation, run through `compileFilter` against `NEW_CLEAN_CHIPS_976A782`
// to prove the fixed chip shape actually widens matching, not just that the
// prompt text reads better.
const SEVEN_COMMON_TITLES: NormalizedJob[] = [
  job({ externalId: "t1", title: "Software Engineer" }),
  job({ externalId: "t2", title: "Senior Software Engineer" }),
  job({ externalId: "t3", title: "Backend Engineer" }),
  job({ externalId: "t4", title: "Full Stack Engineer" }),
  job({ externalId: "t5", title: "Cloud Engineer" }),
  job({ externalId: "t6", title: "Staff Software Engineer" }),
  job({ externalId: "t7", title: "Software Engineer II" }),
];

describe("compileFilter round-trip proof (ticket 976a782 root cause, re-run at the unit level)", () => {
  it("Nicole's OLD, actual round-2 bad-shaped chips match only 1 of the 7 common real-world titles -- reproducing the root-cause finding", () => {
    // The exact chips from tonight's incident: a comma-joined compound plus
    // two over-qualified variants of otherwise-standard titles.
    const oldChips = [
      "Senior Full Stack Software Developer",
      "Full Stack Engineer",
      "Backend Software Engineer",
      "Cloud Software Engineer",
      "AI Application Developer",
      "Software Engineer, Microservices",
    ];
    const filter = compileFilter({ titleInclude: oldChips });
    // Only "Full Stack Engineer" (t4) is a literal chip in this list, so it
    // is the only one of the 7 that can match -- matching the ticket's own
    // finding ("only ONE... matched").
    expect(
      filter(SEVEN_COMMON_TITLES)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["t4"]);
  });

  it("the NEW, split-and-shortened chips match materially more than 1 of the 7 -- including both plain 'Software Engineer' and 'Backend Engineer'", () => {
    const filter = compileFilter({ titleInclude: NEW_CLEAN_CHIPS_976A782 });
    const matchedIds = filter(SEVEN_COMMON_TITLES)
      .map((j) => j.externalId)
      .sort();

    // 6 of 7 match (every title but "Full Stack Engineer", which none of
    // the new chips name) -- a large, concrete improvement over the old
    // chips' 1-of-7, and specifically includes both titles the ticket names
    // as the ones that should match ("ideally 'Software Engineer' and
    // 'Backend Engineer' both do").
    expect(matchedIds).toEqual(["t1", "t2", "t3", "t5", "t6", "t7"]);
    expect(matchedIds.length).toBeGreaterThan(1);
    expect(matchedIds).toContain("t1"); // "Software Engineer"
    expect(matchedIds).toContain("t3"); // "Backend Engineer"
  });
});
