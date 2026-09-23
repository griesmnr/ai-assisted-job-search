/**
 * Local, zero-cost near-duplicate detection for job DESCRIPTIONS (ticket
 * 78d31b7, design 98844f1).
 *
 * Used by `crossSourceDuplicates.ts` as the SECOND of two gates: it only
 * ever sees two postings that already agree exactly (after normalization)
 * on company + title + location. Its whole job is to answer the one
 * question that gate cannot: "are these the same req posted on two ATS
 * platforms, or two genuinely different openings that happen to share a
 * title and a city?"
 *
 * ---------------------------------------------------------------------------
 * WHY JACCARD OVER WORD SHINGLES, AND NOT EDIT DISTANCE
 * ---------------------------------------------------------------------------
 *
 * 1. COST. Real descriptions in this app run to thousands of characters.
 *    Levenshtein / `SequenceMatcher`-style ratios are O(n*m) in characters
 *    — 10 KB vs 10 KB is 10^8 cell updates, hundreds of milliseconds for
 *    ONE pair, inside an ingest transaction. Shingling is O(n) in tokens
 *    for both sides plus a set intersection: microseconds. This check has
 *    to be cheap enough that nobody is ever tempted to sample instead of
 *    running it on every candidate.
 *
 * 2. IT MEASURES THE RIGHT THING. Character edit distance is dominated by
 *    formatting noise — one source emitting HTML-stripped text with
 *    different line breaks, bullet glyphs, or a trailing "Apply on
 *    <platform>" footer shifts every subsequent character and tanks the
 *    ratio even though not one word of the posting changed. Word shingles
 *    are insensitive to whitespace and punctuation entirely, and an edit
 *    only destroys the shingles that actually SPAN it.
 *
 * 3. IT IS ORDER-AWARE, WHICH BAG-OF-WORDS IS NOT. Plain word-set Jaccard
 *    scores two different reqs at one company far too high: they are
 *    written from the same vocabulary (the company name, "engineer",
 *    "collaborate", "benefits", "equal opportunity") and differ mostly in
 *    how those words are arranged. Requiring three CONSECUTIVE words to
 *    match makes shared vocabulary insufficient on its own — the sentences
 *    themselves have to be shared. That is exactly the distinction the
 *    owner was worried about (98844f1: two "Software Engineer" reqs in the
 *    same city, different teams).
 *
 * This is Broder's shingling method, the standard technique for web-scale
 * near-duplicate detection, minus the MinHash sketching step — with at most
 * a handful of candidate pairs per ingest call there is nothing to
 * approximate, so we compute the exact Jaccard coefficient.
 *
 * ---------------------------------------------------------------------------
 * WHY k = 3
 * ---------------------------------------------------------------------------
 *
 * k = 1 is a bag of words and fails reason 3 above — measured on the
 * fixtures in `textSimilarity.test.ts`, two genuinely different reqs at one
 * company score 0.423 at k = 1 versus 0.266 at k = 3, i.e. bag-of-words
 * eats more than half the safety margin for nothing. Large k (5+) is very
 * strict about rewording instead: one changed word destroys k shingles, so
 * a genuinely-identical posting with one retitled section drops further
 * than it should (the reworded-duplicate fixture falls 0.886 -> 0.824 going
 * from k = 3 to k = 5, while the different-req fixture barely moves,
 * 0.266 -> 0.245 — all cost, no separation). k = 3 is also the usual
 * compromise in the literature (Broder used 4 on web pages, which are far
 * longer than a job posting). The test measures k = 1..5 on the same
 * fixtures so this stays a demonstrated choice rather than an asserted one.
 *
 * ---------------------------------------------------------------------------
 * THE ASYMMETRY THAT SETS THE THRESHOLD
 * ---------------------------------------------------------------------------
 *
 * A FALSE MERGE hides a real job from the user permanently and invisibly —
 * nothing in the UI says "we collapsed two postings", so she never learns
 * the second req existed. A FALSE SEPARATION shows one extra row in a
 * ranked list and costs one extra scoring call, which is precisely the
 * behavior the app has today. So a false separation is, at worst, a no-op
 * regression, and the threshold is placed to make false merges hard.
 */

/** Number of consecutive words per shingle. See the k = 3 section above. */
export const DESCRIPTION_SIMILARITY_SHINGLE_SIZE = 3;

/**
 * Jaccard coefficient at or above which two descriptions are treated as
 * the SAME posting.
 *
 * MEASURED, not guessed (2026-09-23, on the realistic-shaped fixtures in
 * `textSimilarity.test.ts`, which asserts every number below so a future
 * edit to the tokenizer cannot silently move them).
 *
 * TRUE DUPLICATES — the same req on two ATS platforms, under every
 * distortion a second platform realistically applies:
 *
 *   byte-identical                                            1.000
 *   HTML on one side, plain text on the other                 1.000
 *   second platform appends its own "apply here" footer       0.899
 *   paragraphs reordered                                      0.896
 *   lightly reworded, one section retitled                    0.886
 *   one side adds a whole "Interview process" section         0.873
 *   one side drops the compensation block                     0.846
 *   one side drops compensation AND the EEO block             0.758
 *   reworded AND drops compensation                           0.740
 *   reworded, drops compensation, adds a footer               0.722  <- floor
 *
 * FALSE-MERGE RISK — two GENUINELY DIFFERENT reqs at one company, same
 * title, same city, sharing verbatim boilerplate (About / Compensation /
 * EEO). This is the owner's own stated worry (98844f1), so it is measured
 * as a CURVE against how much of the description is role-specific rather
 * than as a single number:
 *
 *   role-specific share of the text     similarity
 *      8%                                 1.000
 *     15%                                 0.913
 *     21%                                 0.798
 *     28%                                 0.670
 *     34%                                 0.585
 *     41%                                 0.506
 *     49%                                 0.411
 *     64%  (the realistic fixture)         0.277
 *
 * 0.65 is chosen from those two tables together. It sits 0.072 below the
 * measured true-duplicate FLOOR (0.722), and a pair of different reqs has
 * to be more than ~70% verbatim shared boilerplate before it can reach it.
 * Real engineering postings are nowhere near that: the realistic fixture is
 * 64% role-specific and scores 0.277, a 2.3x margin.
 *
 * THE HONEST LIMITATION, stated rather than hidden: no non-semantic text
 * measure can separate "the same req" from "two reqs that differ only in
 * which team is named", and this one does not pretend to. Below roughly 30%
 * role-specific content the two clusters genuinely overlap and this check
 * can merge two different openings. What bounds the damage is that it is
 * the SECOND gate, not the first — the pair must already agree exactly on
 * company, title AND location to be compared at all — and that the first
 * gate is exact, not fuzzy (see `crossSourceDuplicates.ts`).
 *
 * IF THIS EVER NEEDS RETUNING: raise it, don't lower it. A missed merge
 * reproduces today's behavior. A wrong merge deletes a job the user should
 * have seen, silently and permanently.
 */
export const DESCRIPTION_SIMILARITY_THRESHOLD = 0.65;

const HTML_TAG = /<[^>]*>/g;

/**
 * Word characters only. Splitting on the complement of this class is what
 * makes the comparison immune to punctuation, bullet glyphs, line-ending
 * style and HTML entity residue — none of which say anything about whether
 * two postings are the same req. `\p{L}`/`\p{N}` rather than `[a-z0-9]` so
 * a non-English posting tokenizes into words instead of nothing.
 */
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Splits a description into comparable lowercase word tokens.
 *
 * HTML tags are dropped rather than tokenized: most adapters already store
 * plain text (`htmlToPlainText`, sources/html.ts), but not every source is
 * guaranteed to, and letting `div`/`li`/`strong` become tokens would add
 * noise proportional to one side's markup density — pure measurement error
 * with respect to the question being asked.
 */
export function tokenizeForSimilarity(text: string): string[] {
  return text.replace(HTML_TAG, " ").toLowerCase().match(WORD) ?? [];
}

/**
 * The set of contiguous k-word sequences in `tokens`.
 *
 * A SET, not a multiset: a boilerplate sentence pasted twice counts once,
 * so a posting that repeats itself can't dominate the coefficient.
 *
 * When a description is shorter than k words the whole token run becomes a
 * single shingle, so two very short descriptions are compared as exact
 * phrases instead of both scoring 0 for lack of any shingle at all.
 */
export function shingleSet(
  tokens: string[],
  k: number = DESCRIPTION_SIMILARITY_SHINGLE_SIZE,
): Set<string> {
  if (tokens.length === 0) return new Set();
  if (tokens.length <= k) return new Set([tokens.join(" ")]);
  const shingles = new Set<string>();
  for (let i = 0; i + k <= tokens.length; i++) {
    shingles.add(tokens.slice(i, i + k).join(" "));
  }
  return shingles;
}

/**
 * |A ∩ B| / |A ∪ B|. Returns 0 when either side is empty rather than the
 * mathematically-undefined 0/0 — see `descriptionSimilarity` for why
 * "nothing to compare" must never read as "identical".
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller set; membership tests go against the larger one.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const shingle of small) {
    if (large.has(shingle)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * How alike two job descriptions are, in [0, 1]. 1 means every word
 * sequence is shared; 0 means none is.
 *
 * AN EMPTY DESCRIPTION ON EITHER SIDE SCORES 0, INCLUDING EMPTY vs EMPTY.
 * That is a deliberate refusal, not an oversight: this function is the only
 * thing standing between "same company, same title, same city" and a merge
 * that hides a real posting, and two blank descriptions are an absence of
 * evidence, never evidence of sameness. Scoring 1.0 there would make every
 * source that fails to populate a description auto-merge its postings with
 * every other such source's at the same company.
 */
export function descriptionSimilarity(a: string, b: string): number {
  return jaccardSimilarity(
    shingleSet(tokenizeForSimilarity(a)),
    shingleSet(tokenizeForSimilarity(b)),
  );
}

/**
 * `descriptionSimilarity(a, b) >= DESCRIPTION_SIMILARITY_THRESHOLD`, named
 * so call sites read as the decision they are actually making.
 */
export function isSameDescription(a: string, b: string): boolean {
  return descriptionSimilarity(a, b) >= DESCRIPTION_SIMILARITY_THRESHOLD;
}
