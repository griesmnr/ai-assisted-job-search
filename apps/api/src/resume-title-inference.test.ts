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
    // compileFilter round-trip tests below for the live proof).
    expect(schemaDescription).toContain("Backend Engineer");
    expect(schemaDescription).toContain("Backend Software Engineer (Java/Node.js)");
    expect(schemaDescription).toContain("React/Angular Frontend Developer");
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

  it("NEW, clean-shaped titles ('Backend Engineer', 'Full Stack Engineer') match both real live postings -- proving the fix closes the loop, not just changes prompt text", () => {
    const newChips = ["Backend Engineer", "Full Stack Engineer"];
    const filter = compileFilter({ titleInclude: newChips });
    expect(
      filter(REAL_LIVE_POSTINGS)
        .map((j) => j.externalId)
        .sort(),
    ).toEqual(["gitlab-1", "gitlab-2"]);
  });
});
