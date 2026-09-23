import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_SIMILARITY_SHINGLE_SIZE,
  DESCRIPTION_SIMILARITY_THRESHOLD,
  descriptionSimilarity,
  isSameDescription,
  jaccardSimilarity,
  shingleSet,
  tokenizeForSimilarity,
} from "./textSimilarity.js";
import {
  DIFFERENT_REQ_SAME_COMPANY,
  SAME_REQ_ATS_A,
  SAME_REQ_ATS_B,
  SAME_REQ_MAXIMALLY_DISTORTED,
  SAME_REQ_WITHOUT_COMPENSATION,
  SAME_REQ_WITH_PLATFORM_FOOTER,
  UNRELATED_POSTING,
} from "./textSimilarity.fixtures.js";

describe("tokenizeForSimilarity", () => {
  it("lowercases and splits on everything that is not a letter or digit", () => {
    expect(tokenizeForSimilarity("Senior Engineer, Fleet (Remote) - 2 openings!")).toEqual([
      "senior",
      "engineer",
      "fleet",
      "remote",
      "2",
      "openings",
    ]);
  });

  it("drops HTML markup instead of tokenizing tag names", () => {
    // A source that stores raw HTML must not be penalized against one that
    // stores plain text: `div`/`li`/`strong` are markup, not content.
    expect(tokenizeForSimilarity("<ul><li>Build <strong>widgets</strong></li></ul>")).toEqual([
      "build",
      "widgets",
    ]);
  });

  it("is insensitive to line-ending and bullet style", () => {
    expect(tokenizeForSimilarity("• Ship it\r\n• Own it")).toEqual(["ship", "it", "own", "it"]);
  });

  it("tokenizes non-English text into words rather than nothing", () => {
    // `\p{L}` rather than `[a-z]` — a posting in another language must not
    // collapse to zero tokens, which would score 0 against everything.
    expect(tokenizeForSimilarity("Ingénieur logiciel senior")).toEqual([
      "ingénieur",
      "logiciel",
      "senior",
    ]);
  });

  it("returns an empty array for text with no word characters at all", () => {
    expect(tokenizeForSimilarity("  --- \n\n *** ")).toEqual([]);
  });
});

describe("shingleSet", () => {
  it("produces every contiguous k-word sequence", () => {
    expect([...shingleSet(["a", "b", "c", "d"], 3)]).toEqual(["a b c", "b c d"]);
  });

  it("collapses a repeated phrase to one shingle", () => {
    // A posting that pastes the same sentence twice must not get extra
    // weight for it.
    expect(shingleSet(["a", "b", "c", "a", "b", "c"], 3).has("a b c")).toBe(true);
    expect([...shingleSet(["a", "b", "c", "a", "b", "c"], 3)]).toEqual(["a b c", "b c a", "c a b"]);
  });

  it("treats a text shorter than k as a single whole-phrase shingle", () => {
    expect([...shingleSet(["build", "widgets"], 3)]).toEqual(["build widgets"]);
  });

  it("is empty for no tokens", () => {
    expect(shingleSet([], 3).size).toBe(0);
  });
});

describe("jaccardSimilarity", () => {
  it("is |A ∩ B| / |A ∪ B|", () => {
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(
      2 / 4,
      10,
    );
  });

  it("is 1 for identical sets and 0 for disjoint ones", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set(["a"]))).toBe(1);
    expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("is symmetric", () => {
    const a = new Set(["a", "b", "c", "d"]);
    const b = new Set(["c", "d"]);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });

  it("returns 0, not NaN, when a set is empty", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("descriptionSimilarity: an empty description is never evidence of sameness", () => {
  // The single most dangerous default this module could have. Two blank
  // descriptions scoring 1.0 would make every source that fails to populate
  // a description auto-merge with every other such source's postings at the
  // same company/title/location.
  it("scores 0 for empty vs empty", () => {
    expect(descriptionSimilarity("", "")).toBe(0);
    expect(isSameDescription("", "")).toBe(false);
  });

  it("scores 0 for empty vs a real posting", () => {
    expect(descriptionSimilarity("", SAME_REQ_ATS_A)).toBe(0);
  });

  it("scores 0 for whitespace/punctuation-only vs whitespace-only", () => {
    expect(descriptionSimilarity("   ", " --- ")).toBe(0);
  });
});

/**
 * THE THRESHOLD CALIBRATION. Every number quoted in
 * `DESCRIPTION_SIMILARITY_THRESHOLD`'s doc comment is asserted here, so a
 * future edit to the tokenizer or the shingle size cannot silently move the
 * evidence the threshold was chosen from.
 *
 * Bounds, not exact equality: the point is which side of the threshold each
 * case falls on and by how much, and pinning four decimal places would make
 * this a change-detector test.
 */
describe("threshold calibration: TRUE duplicates (same req, two ATS platforms)", () => {
  const cases: [string, string, string, number][] = [
    ["byte-identical", SAME_REQ_ATS_A, SAME_REQ_ATS_A, 1.0],
    ["second platform appends its own footer", SAME_REQ_ATS_A, SAME_REQ_WITH_PLATFORM_FOOTER, 0.89],
    ["lightly reworded, two sections retitled", SAME_REQ_ATS_A, SAME_REQ_ATS_B, 0.88],
    ["one side drops the compensation block", SAME_REQ_ATS_A, SAME_REQ_WITHOUT_COMPENSATION, 0.84],
    ["reworded, no compensation, plus footer", SAME_REQ_ATS_A, SAME_REQ_MAXIMALLY_DISTORTED, 0.72],
  ];

  for (const [label, a, b, floor] of cases) {
    it(`${label}: >= ${floor}, and clears the threshold`, () => {
      const similarity = descriptionSimilarity(a, b);
      expect(similarity).toBeGreaterThanOrEqual(floor);
      expect(isSameDescription(a, b)).toBe(true);
    });
  }

  it("HTML on one side and plain text on the other are identical, not merely similar", () => {
    const html = `<div><p>${SAME_REQ_ATS_A.split("\n\n").join("</p><p>")}</p></div>`;
    expect(descriptionSimilarity(SAME_REQ_ATS_A, html)).toBe(1);
  });

  it("reordering whole paragraphs barely moves the score", () => {
    // Shingles are a set, so moving a paragraph only destroys the handful
    // that span its boundaries. This is a property edit distance does not
    // have, and part of why it was rejected.
    const paragraphs = SAME_REQ_ATS_A.split("\n\n").filter((p) => p.trim());
    const reordered = [paragraphs[0], ...paragraphs.slice(1).reverse()].join("\n\n");
    expect(descriptionSimilarity(SAME_REQ_ATS_A, reordered)).toBeGreaterThan(0.85);
  });

  it("the most distorted true duplicate still leaves real headroom over the threshold", () => {
    // The floor of the true-duplicate cluster. If a future change pushes
    // this under the threshold, the feature stops firing on real
    // duplicates - which is safe, but silently useless, so it is asserted.
    const floor = descriptionSimilarity(SAME_REQ_ATS_A, SAME_REQ_MAXIMALLY_DISTORTED);
    expect(floor - DESCRIPTION_SIMILARITY_THRESHOLD).toBeGreaterThan(0.05);
  });
});

describe("threshold calibration: FALSE-merge risk (different reqs, same company/title/location)", () => {
  it("two different reqs sharing verbatim company boilerplate do NOT clear the threshold", () => {
    // THE most important assertion in this file. A naive
    // company+title+location implementation merges these two; this is the
    // measurement that says the description check refuses to.
    const similarity = descriptionSimilarity(SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY);
    expect(similarity).toBeLessThan(0.3);
    expect(isSameDescription(SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY)).toBe(false);
    // ... with a real margin, not a hair's breadth.
    expect(DESCRIPTION_SIMILARITY_THRESHOLD / similarity).toBeGreaterThan(2);
  });

  it("two unrelated postings score zero", () => {
    expect(descriptionSimilarity(SAME_REQ_ATS_A, UNRELATED_POSTING)).toBe(0);
  });

  /**
   * The honest boundary. Two different reqs get harder to tell apart the
   * more of the posting is shared boilerplate, so the risk is measured as a
   * curve rather than claimed away with one fixture. This documents exactly
   * where the method stops working: below roughly a third role-specific
   * content, two different reqs CAN clear the threshold.
   */
  it("measures where the two clusters actually overlap, rather than pretending they do not", () => {
    const boilerplate = tokenizeForSimilarity(
      SAME_REQ_ATS_A.replace(
        /The Role[\s\S]*?Compensation and benefits/,
        "Compensation and benefits",
      ),
    );
    const roleA = tokenizeForSimilarity(
      /The Role[\s\S]*?Compensation and benefits/.exec(SAME_REQ_ATS_A)?.[0] ?? "",
    );
    const roleB = tokenizeForSimilarity(
      /The Role[\s\S]*?Compensation and benefits/.exec(DIFFERENT_REQ_SAME_COMPANY)?.[0] ?? "",
    );
    expect(boilerplate.length).toBeGreaterThan(50);

    const similarityAtRoleShare = (roleTokens: number) =>
      descriptionSimilarity(
        [...boilerplate, ...roleA.slice(0, roleTokens)].join(" "),
        [...boilerplate, ...roleB.slice(0, roleTokens)].join(" "),
      );

    // Almost no role-specific content: indistinguishable, and it WOULD
    // merge. Stated plainly rather than hidden.
    expect(similarityAtRoleShare(10)).toBeGreaterThan(DESCRIPTION_SIMILARITY_THRESHOLD);
    // A third of the posting role-specific: already safely separated.
    expect(similarityAtRoleShare(60)).toBeLessThan(DESCRIPTION_SIMILARITY_THRESHOLD);
    // Realistic engineering postings (the full fixtures) are ~64%
    // role-specific and land far below.
    expect(similarityAtRoleShare(roleA.length)).toBeLessThan(0.3);
  });
});

describe("why k = 3, measured rather than asserted", () => {
  const similarityAt = (k: number, a: string, b: string) =>
    jaccardSimilarity(
      shingleSet(tokenizeForSimilarity(a), k),
      shingleSet(tokenizeForSimilarity(b), k),
    );

  it("k = 1 (bag of words) loses more than half the safety margin", () => {
    // Different reqs at one company are written from the same vocabulary,
    // so an order-insensitive measure scores them much too high. This is
    // the reason shingles exist here at all.
    const different1 = similarityAt(1, SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY);
    const different3 = similarityAt(3, SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY);
    expect(different1).toBeGreaterThan(0.4);
    expect(different3).toBeLessThan(0.3);
  });

  it("k = 5 costs true-duplicate recall without buying separation", () => {
    const sameAt3 = similarityAt(3, SAME_REQ_ATS_A, SAME_REQ_ATS_B);
    const sameAt5 = similarityAt(5, SAME_REQ_ATS_A, SAME_REQ_ATS_B);
    const differentAt3 = similarityAt(3, SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY);
    const differentAt5 = similarityAt(5, SAME_REQ_ATS_A, DIFFERENT_REQ_SAME_COMPANY);

    // The true-duplicate score falls meaningfully...
    expect(sameAt3 - sameAt5).toBeGreaterThan(0.05);
    // ...while the different-req score barely moves, so the gap between
    // the clusters gets NARROWER, not wider.
    expect(differentAt3 - differentAt5).toBeLessThan(0.05);
    expect(sameAt5 - differentAt5).toBeLessThan(sameAt3 - differentAt3);
  });

  it("the shipped shingle size is 3", () => {
    expect(DESCRIPTION_SIMILARITY_SHINGLE_SIZE).toBe(3);
  });
});

describe("cost: the check is cheap enough to run on every candidate pair", () => {
  it("compares two long descriptions in well under a millisecond", () => {
    // The reason this is Jaccard-over-shingles and not an edit-distance
    // ratio (which is O(n*m) in characters - hundreds of ms for one pair of
    // 10 KB descriptions, inside an ingest transaction).
    const big = SAME_REQ_ATS_A.repeat(8); // ~16 KB, past the real long tail
    const other = DIFFERENT_REQ_SAME_COMPANY.repeat(8);
    const ITERATIONS = 200;

    const started = performance.now();
    for (let i = 0; i < ITERATIONS; i++) descriptionSimilarity(big, other);
    const perCallMs = (performance.now() - started) / ITERATIONS;

    // Generous bound so this isn't flaky on a loaded machine; measured at
    // ~1.1 ms/call for 16 KB inputs on the dev container, 2026-09-23, and
    // ~0.09 ms for realistic ~2 KB descriptions.
    expect(perCallMs).toBeLessThan(20);
  });
});
