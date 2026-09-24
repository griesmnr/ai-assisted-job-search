/**
 * Infers job title keywords from a resume (ticket 39b4a48).
 *
 * Context: the frontend's search-criteria form used to default title
 * filtering to a hardcoded software-engineering assumption (swe-filter.ts's
 * SOFTWARE/NOT regexes), invisible to the user and wrong for anyone not
 * job-hunting as a software engineer. Nicole, live: "I don't want any
 * default software engineering role text there... I'm hoping that it
 * customizes for everybody." This replaces that hardcoded default with a
 * cheap, one-time-per-resume Claude call that reads the ACTUAL resume and
 * suggests real title keywords -- shown to the user as editable/removable
 * chips (SearchCriteriaForm), never applied silently.
 *
 * Deliberately a SEPARATE, small call from `makeClaudeScorer` in
 * demo-match.ts, not folded into it: this runs ONCE per resume (cached via
 * the existing content-addressed find-or-create -- see
 * routes/resumes.ts), not once per job, and has nothing to do with scoring
 * a specific posting. Reuses the same structured-JSON-output pattern
 * `makeClaudeScorer` already established (see demo-match.ts's SCHEMA) so
 * there is exactly one convention for "ask Claude for a JSON shape" in
 * this codebase, not two.
 *
 * ---------------------------------------------------------------------------
 * TICKET 976a782 -- ROUND 2 OF THE SAME PROBLEM, AND WHY THIS FIX IS SHAPED
 * DIFFERENTLY FROM ROUND 1 (5ba5cca)
 * ---------------------------------------------------------------------------
 *
 * 5ba5cca closed three of Nicole's five bad chips by forbidding parens,
 * slashes, and dash-qualifiers. Its own round-1 review (opus) predicted the
 * gap in writing: "'AI Application Developer' and 'Senior Full Stack
 * Software Developer' contain no parens, no slashes, and no listed tech
 * word -- yet both match zero. The residual failure mode is
 * over-qualification/word count." Logged non-blocking. It took exactly one
 * more resume edit to show up live: Nicole's estimate dropped from 364
 * candidates to 7 after a fresh resume submission, with all 8 sources still
 * fetching large healthy raw pools (9,375 postings) -- a filter problem, not
 * a fetch problem. Her actual chips: "Senior Full Stack Software Developer",
 * "Full Stack Engineer", "Backend Software Engineer", "Cloud Software
 * Engineer", "AI Application Developer", and a NEW failure shape --
 * "Software Engineer, Microservices" as one comma-joined chip, not two.
 * Root-caused against `compileFilter`: of 7 common real-world titles, only
 * "Full Stack Engineer" matched. Plain "Software Engineer" -- one of the
 * most common titles that exists -- matched nothing, because it was never
 * its own chip.
 *
 * Two genuinely different failure modes, and this fix treats them
 * differently on purpose rather than reaching for one uniform patch:
 *
 * 1. CONJOINED CHIPS ("Software Engineer, Microservices"). This gets a
 *    CODE-level fix (`splitConjoinedTitles` below), not just a prompt
 *    instruction, and that distinction is the actual lesson pulled from
 *    ticket 410e1a2 (metro-area matching) -- that ticket burned three
 *    review rounds patching one separator at a time in a hand-written rule
 *    before a structural, code-enforced discriminator (all-caps vs. prose)
 *    closed the whole class regardless of what the input looked like. A
 *    prompt instruction is exactly the kind of rule 410e1a2 warned against:
 *    5ba5cca already asked the model not to bolt qualifiers on with parens
 *    or slashes, and the model complied with THAT wording while producing
 *    a comma instead -- the next round would find a semicolon or an "and."
 *    So this round does not add "no commas" to a growing forbidden-symbol
 *    list in the prompt and call it done; it makes the invariant true BY
 *    CONSTRUCTION in code: any title Claude returns that contains a comma,
 *    semicolon, ampersand, or the word "and" joining two chunks is split
 *    into separate standalone chips before this function returns. This is
 *    guaranteed to hold for every future prompt drift, not just the
 *    separators anticipated today. It is also directionally safe for this
 *    specific field: `titleInclude` chips are OR'd in `compileFilter` (see
 *    criteria.ts), so splitting a chip into two can only ADD candidate
 *    matches, never remove one that the unsplit chip would have found --
 *    there is no over-broadening risk symmetric to the one titleSynonyms.ts
 *    worries about for `titleExclude`, because this function's output only
 *    ever feeds `titleInclude`.
 *
 * 2. EXTRA QUALIFIER WORDS ("Backend Software Engineer" instead of "Backend
 *    Engineer"; "Cloud Software Engineer" instead of "Cloud Engineer", even
 *    though bare "Cloud Engineer" is explicitly a GOOD example already).
 *    Unlike (1), there is no code-level discriminator available here --
 *    "Backend Engineer" and "Backend Software Engineer" are both perfectly
 *    ordinary Title Case English phrases; nothing about their character
 *    shape distinguishes the standard board title from the over-described
 *    one the way ALL-CAPS-vs-prose distinguished a real metro abbreviation
 *    from ordinary text in 410e1a2. Telling them apart requires knowing
 *    which phrasing employers actually post under, which is a semantic
 *    judgment only the model (or a real title database this app doesn't
 *    have) can make. So this half of the fix stays in the prompt/schema:
 *    explicit new guidance to prefer the shortest common real-world
 *    phrasing a title axis has evidence for over the most descriptive one,
 *    with Nicole's own new bad examples named directly (same tactic
 *    5ba5cca used for its own incident), plus an explicit ask for a MIX of
 *    a couple of broad/generic chips alongside more specific ones rather
 *    than 3-6 uniformly-specific chips -- so that a resume evidencing a
 *    "Software Engineer" doing backend/cloud/full-stack work is more likely
 *    to produce at least one bare, maximally-matchable "Software Engineer"
 *    chip instead of only compound variants of it, mirroring how "Full
 *    Stack Engineer" was the one chip out of six that matched anything in
 *    the live incident.
 *
 * See `splitConjoinedTitles`'s own doc comment for the split mechanics, and
 * `scripts/eval-title-inference-prompt.ts` for the live-model evidence this
 * combination was checked against (not just reasoned about) across resume
 * shapes that reproduce tonight's specific incident plus two others.
 */
import type Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-5";

// Small, deliberately: this is a resume-only call (no job description
// attached), so a handful of short title strings is a large output budget
// already -- nowhere near the per-job scorer's MAX_OUTPUT_TOKENS (2000).
const MAX_OUTPUT_TOKENS = 300;

const SCHEMA = {
  type: "object",
  properties: {
    titles: {
      type: "array",
      items: { type: "string" },
      description:
        "3-6 short job title keywords (e.g. 'Backend Engineer', 'Senior Full Stack Engineer', " +
        "'Technical Writer') this person would plausibly search for, based on their real " +
        "experience in the resume. Prefer the level/seniority actually evidenced in the " +
        "resume -- do not default to entry-level or omit senior/staff/principal titles if " +
        "the resume supports them. Each title must be a short role phrase that could appear " +
        "VERBATIM as a real job posting's title: no parentheses, no slashes, and no title " +
        "built by bolting a technology/framework/language onto a role word as a qualifier " +
        "(not 'Backend Engineer (Java/Node.js)', not 'React/Angular Frontend Developer', not " +
        "'Software Developer - Cloud & Microservices'). This does NOT forbid a technology or " +
        "domain word that is itself the standard head of a real posted title -- 'Cloud " +
        "Engineer', 'Machine Learning Engineer', 'Data Engineer', and 'Android Developer' are " +
        "all real, common board titles and are fine to suggest exactly as written. The line " +
        "is qualifier vs. head: a technology name tacked on to narrow or describe another " +
        "role ('X Engineer (Y)', 'X/Y Developer') is bad; a technology or domain name that " +
        "simply IS the role is fine. Good: 'Backend Engineer', 'Senior Full Stack Engineer', " +
        "'Cloud Engineer', 'Data Scientist', 'Product Manager'. Bad: 'Backend Software " +
        "Engineer (Java/Node.js)' (parenthetical + slash + qualifier), 'React/Angular " +
        "Frontend Developer' (slash + qualifiers), 'Software Developer - Cloud & " +
        "Microservices' (qualifiers bolted on after a dash). If the resume's specific tech " +
        "stack matters beyond what a standard title already conveys, it belongs in the " +
        "person's evidenced experience, not folded into the title string.\n\n" +
        "NEVER join two role or domain concepts into ONE array entry with a comma, a " +
        "semicolon, an ampersand, or the word 'and' -- not 'Software Engineer, " +
        "Microservices', not 'Backend Engineer; DevOps', not 'Data & Analytics Engineer'. If " +
        "two distinct concepts both apply, return them as two SEPARATE entries in the array " +
        "instead of joining them into one string. A single entry must be one role phrase " +
        "only.\n\n" +
        "Also avoid EXTRA QUALIFYING WORDS that turn a standard, commonly-posted title into a " +
        "phrase that rarely appears on a real job board, even with no punctuation at all: " +
        "prefer 'Backend Engineer' over 'Backend Software Engineer', and 'Cloud Engineer' " +
        "over 'Cloud Software Engineer' -- the word 'Software' adds nothing there beyond what " +
        "'Engineer' already conveys in a software resume, and the longer phrase matches far " +
        "fewer real postings than the shorter one. Prefer the SHORTEST phrasing that is still " +
        "a real, commonly-posted title for the evidenced role -- add a qualifying word only " +
        "when it is load-bearing (distinguishes a genuinely different role a real board would " +
        "title differently, e.g. 'Machine Learning Engineer' vs. plain 'Engineer' would lose " +
        "real information), not merely descriptive of the resume's tech stack.\n\n" +
        "Include a MIX of specificity, not 3-6 uniformly narrow variants: at least one or two " +
        "entries should be the person's most GENERIC, board-common role phrase on its own " +
        "(e.g. bare 'Software Engineer' for someone doing backend/full-stack/cloud software " +
        "work), even if more specific variants ('Senior Full Stack Engineer', 'Cloud " +
        "Engineer') are also included -- a generic chip matches the widest range of real " +
        "postings and should not be crowded out by only specific ones.",
    },
  },
  required: ["titles"],
  additionalProperties: false,
};

const PROMPT_PREFIX =
  "You are helping someone search for jobs. Read their resume below and suggest job title " +
  "keywords they would plausibly search for -- grounded in their actual experience and " +
  "seniority as shown in the resume, not a generic guess. Each suggested title must be a " +
  "short phrase that could appear verbatim on a real job board (employers title postings " +
  "'Backend Engineer', not 'Backend Software Engineer (Java/Node.js)') -- never bolt a " +
  "technology, framework, or language onto a role word as a parenthetical, a slash, or a " +
  "dash-qualifier, even when the resume is full of them. This is about how the title is " +
  "STRUCTURED, not about avoiding technology words entirely: a technology or domain name " +
  "that is itself the standard head of a real posted title ('Cloud Engineer', 'Machine " +
  "Learning Engineer', 'Android Developer') is fine to suggest exactly as written. Each " +
  "array entry must be exactly ONE role phrase: never combine two role or domain concepts " +
  "into one entry with a comma, semicolon, ampersand, or 'and' (not 'Software Engineer, " +
  "Microservices') -- return them as two separate entries instead. Also avoid stacking " +
  "extra qualifying words onto a role word when a shorter, more common phrasing already " +
  "covers the same role on real job boards ('Backend Engineer', not 'Backend Software " +
  "Engineer'; 'Cloud Engineer', not 'Cloud Software Engineer') -- prefer the shortest " +
  "phrasing that is still a real, commonly-posted title, and include at least one or two " +
  "entries that are the person's single most GENERIC board-common role phrase on its own, " +
  "not only specific variants. Return ONLY the JSON the schema asks for.\n\n--- RESUME ---\n\n";

/**
 * Splits any string containing a comma, semicolon, ampersand, or the word
 * "and" joining two chunks into separate standalone chips (ticket 976a782 --
 * see this module's doc comment for why this is a CODE-level fix rather
 * than another prompt instruction).
 *
 * The join operators require whitespace on both sides for "&" and "and"
 * specifically (comma/semicolon never need it -- a comma always sits
 * directly against the preceding word, e.g. "Engineer, Microservices"),
 * which is what keeps this from mangling a word that merely CONTAINS
 * "and" with no whitespace around it ("Android Developer", "Brand
 * Manager" are untouched -- there is no `\s` adjacent to the "and"/"and"
 * substring inside either word). A bare, space-free "R&D" is likewise left
 * intact for the same reason. This is a plain string transform, not a
 * user-supplied regex -- same "no raw user input as a pattern" discipline
 * `criteria.ts`'s `escapeForRegex` documents for a different field.
 *
 * Fragments are trimmed, empty/whitespace-only pieces are dropped, and the
 * result is deduped case-insensitively (a resume with several similar
 * qualifiers could otherwise produce the same fragment twice, e.g. "Cloud
 * Engineer" surviving from two different chips). Splitting can only ADD
 * chips relative to the unsplit input, never remove the original meaning of
 * a chip that had no join operator at all -- see the module doc comment for
 * why widening is safe specifically for this function's callers (this
 * feeds `titleInclude` only, which is OR'd in `compileFilter`).
 */
function splitConjoinedTitles(titles: string[]): string[] {
  const JOIN_PATTERN = /\s*,\s*|\s*;\s*|\s+&\s+|\s+and\s+/gi;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const title of titles) {
    for (const fragment of title.split(JOIN_PATTERN)) {
      const trimmed = fragment.trim();
      if (trimmed.length === 0) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

/**
 * Returns `[]` (never throws) if the call fails for any reason -- network
 * error, malformed response, anything. This is a nice-to-have layer on top
 * of resume submission (ticket 39b4a48's explicit, non-optional
 * requirement): a failure here must never block creating the resume, and
 * an empty suggestion list degrades gracefully to "no title restriction",
 * not a broken page. The caller (routes/resumes.ts) is responsible for
 * logging the failure; this function stays silent on purpose so it has
 * exactly one return shape (a string array) for every outcome.
 */
export async function inferTitleKeywords(
  anthropic: Anthropic,
  resumeText: string,
): Promise<string[]> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: PROMPT_PREFIX + resumeText }],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return [];
    const parsed = JSON.parse(text.text) as { titles?: unknown };
    if (!Array.isArray(parsed.titles)) return [];
    const titles = parsed.titles.filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
    return splitConjoinedTitles(titles);
  } catch {
    return [];
  }
}
