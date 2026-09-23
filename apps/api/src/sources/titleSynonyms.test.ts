import { describe, expect, it } from "vitest";
import { TITLE_SYNONYM_GROUPS, expandTitlePhrase } from "./titleSynonyms.js";

describe("TITLE_SYNONYM_GROUPS — table invariants (ticket 0298b20)", () => {
  it("every word is lowercase and single-token — the substitution model is 1 token for 1 token", () => {
    // A multi-word entry ("site reliability", "registered nurse") would be
    // silently unreachable: expandTitlePhrase looks words up by
    // whitespace-separated token, so it could never match one. Better to
    // fail here than to ship a table entry that does nothing.
    for (const group of TITLE_SYNONYM_GROUPS) {
      for (const word of group.words) {
        expect(word).toBe(word.toLowerCase());
        expect(word).not.toMatch(/\s/);
        expect(word.length).toBeGreaterThan(0);
      }
    }
  });

  it("no word appears in two groups — otherwise expansion is order-dependent and the table is unreviewable", () => {
    const seen = new Map<string, string>();
    for (const group of TITLE_SYNONYM_GROUPS) {
      for (const word of group.words) {
        expect(seen.get(word), `"${word}" is in both ${seen.get(word)} and ${group.domain}`).toBe(
          undefined,
        );
        seen.set(word, group.domain);
      }
    }
  });

  it("every group has at least two words and a non-empty rationale", () => {
    for (const group of TITLE_SYNONYM_GROUPS) {
      expect(group.words.length).toBeGreaterThanOrEqual(2);
      expect(group.why.length).toBeGreaterThan(80);
      expect(group.domain.length).toBeGreaterThan(0);
    }
  });

  it("covers at least 3 genuinely distinct professions — the ticket's generality bar, not a software-only patch", () => {
    // The whole point of ticket 0298b20: the owner explicitly did NOT want
    // her own title list hardcoded, she wanted a mechanism that helps any
    // profession. If a future edit strips this back to engineer/developer,
    // this fails.
    const domains = new Set(TITLE_SYNONYM_GROUPS.map((g) => g.domain));
    expect(domains.size).toBeGreaterThanOrEqual(3);
    // And spot-check that non-software domains are actually represented.
    const allWords = TITLE_SYNONYM_GROUPS.flatMap((g) => g.words);
    expect(allWords).toContain("technician"); // healthcare / trades / lab
    expect(allWords).toContain("representative"); // sales & customer service
    expect(allWords).toContain("teacher"); // education
  });

  it("does NOT contain the rejected candidates — see titleSynonyms.ts's NOT GROUPED section", () => {
    // These are the tempting-but-wrong groupings the ticket asked to be
    // reasoned about. Pinned so re-adding one from intuition trips a test
    // that points at the written reasoning.
    const allWords = new Set(TITLE_SYNONYM_GROUPS.flatMap((g) => g.words));
    for (const rejected of [
      "manager",
      "supervisor",
      "lead",
      "analyst",
      "specialist",
      "architect",
      "scientist",
      "coder",
      "agent",
      "editor",
      "creator",
      "copywriter",
      "professor",
      "aide", // removed post-review: PTA/OTA vs. aide are separate, licensed-vs-unlicensed roles
    ]) {
      expect(allWords.has(rejected), `"${rejected}" was deliberately left out`).toBe(false);
    }
  });
});

describe("expandTitlePhrase (ticket 0298b20)", () => {
  it("always returns the original phrase first — expansion only ever ADDS matchers", () => {
    expect(expandTitlePhrase("software engineer")[0]).toBe("software engineer");
    expect(expandTitlePhrase("program analyst")[0]).toBe("program analyst");
    expect(expandTitlePhrase("c++")[0]).toBe("c++");
  });

  it("substitutes one role word at a time, not the cross-product", () => {
    expect(expandTitlePhrase("software engineer")).toEqual([
      "software engineer",
      "software developer",
      "software programmer",
    ]);
  });

  it("leaves a phrase with no table word completely untouched", () => {
    expect(expandTitlePhrase("program analyst")).toEqual(["program analyst"]);
    expect(expandTitlePhrase("IT specialist")).toEqual(["IT specialist"]);
    expect(expandTitlePhrase("cloud microservices")).toEqual(["cloud microservices"]);
  });

  it("the QUALIFIER RULE: a bare role word is never expanded", () => {
    // The single most important safety property in the module. Unqualified,
    // "developer" also means a real estate developer and "engineer" spans
    // civil/mechanical/sales engineering — expanding either would drag whole
    // unrelated professions into the result set.
    expect(expandTitlePhrase("engineer")).toEqual(["engineer"]);
    expect(expandTitlePhrase("developer")).toEqual(["developer"]);
    expect(expandTitlePhrase("technician")).toEqual(["technician"]);
    // Two role words and nothing else still has no domain qualifier.
    expect(expandTitlePhrase("engineer developer")).toEqual(["engineer developer"]);
  });

  it("preserves the caller's exact spacing and the case of untouched tokens", () => {
    // makePhraseMatcher's boundary logic reads the literal characters at
    // each end of the phrase, so reconstruction must not normalize spacing
    // or drop characters. The SUBSTITUTED token comes from the table and is
    // therefore lowercase — harmless, because makePhraseMatcher compiles
    // with the `i` flag, and pinned here so the asymmetry is deliberate
    // rather than a surprise to the next reader.
    expect(expandTitlePhrase("Senior Software Engineer")).toEqual([
      "Senior Software Engineer",
      "Senior Software developer",
      "Senior Software programmer",
    ]);
    expect(expandTitlePhrase("back-end  engineer")).toEqual([
      "back-end  engineer",
      "back-end  developer",
      "back-end  programmer",
    ]);
  });

  it("works across professions, not just software", () => {
    expect(expandTitlePhrase("pharmacy tech")).toEqual(["pharmacy tech", "pharmacy technician"]);
    expect(expandTitlePhrase("sales representative")).toEqual([
      "sales representative",
      "sales rep",
    ]);
    expect(expandTitlePhrase("technical writer")).toEqual(["technical writer", "technical author"]);
    expect(expandTitlePhrase("math teacher")).toEqual(["math teacher", "math instructor"]);
  });

  it("does NOT expand a removed candidate group — 'assistant'/'aide' (PTA/OTA vs. aide are separate, licensed-vs-unlicensed roles, see NOT GROUPED)", () => {
    expect(expandTitlePhrase("nursing assistant")).toEqual(["nursing assistant"]);
  });

  it("expands every eligible token when a phrase contains more than one role word", () => {
    // "programmer analyst" is a real US federal/state title; the analyst
    // half is not in the table, so it is also the qualifier that unlocks
    // expansion of the programmer half.
    expect(expandTitlePhrase("programmer analyst")).toEqual([
      "programmer analyst",
      "engineer analyst",
      "developer analyst",
    ]);
  });

  it("does not duplicate the original phrase when a synonym round-trips", () => {
    const expansions = expandTitlePhrase("software developer");
    expect(new Set(expansions.map((p) => p.toLowerCase())).size).toBe(expansions.length);
    expect(expansions).toEqual(["software developer", "software engineer", "software programmer"]);
  });

  it("handles empty and whitespace-only phrases without throwing", () => {
    expect(expandTitlePhrase("")).toEqual([""]);
    expect(expandTitlePhrase("   ")).toEqual(["   "]);
  });

  it("stays cheap — expansion is bounded, not combinatorial (the no-API-call cost argument)", () => {
    // This runs once per compileFilter call, but the BOUND is what keeps
    // per-job matching cheap: a realistic 10-phrase criteria must not blow
    // up into hundreds of compiled regexes.
    const realisticCriteria = [
      "senior software engineer",
      "full stack developer",
      "backend software engineer",
      "software engineer",
      "cloud microservices",
      "AI application developer",
      "Java Node developer",
      "program analyst",
      "IT specialist",
      "computer scientist",
    ];
    const total = realisticCriteria.reduce((n, p) => n + expandTitlePhrase(p).length, 0);
    expect(total).toBe(22);
  });
});
