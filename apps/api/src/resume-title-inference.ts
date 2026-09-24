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
 *    a comma instead. So this round does not add "no commas" to a growing
 *    forbidden-symbol list in the prompt and call it done; it makes the
 *    invariant true BY CONSTRUCTION in code: any title Claude returns that
 *    contains a comma or semicolon joining two chunks is split into
 *    separate standalone chips before this function returns, and any
 *    resulting fragment under two words is dropped rather than kept as its
 *    own chip -- see `splitConjoinedTitles`'s own doc comment for why (round
 *    1 review found the FIRST version of this fix, which also split on "&"/
 *    "and" and kept every fragment regardless of length, itself introduced
 *    two new bugs: mangling real compound titles that legitimately contain
 *    "and", like "Health and Safety Engineer", and manufacturing bare
 *    one-word chips like "Billing"/"Data" that `makePhraseMatcher`
 *    literal-matches against unrelated postings). This is guaranteed to
 *    hold for every future prompt drift on a comma/semicolon, not just the
 *    exact shape reported today.
 *
 *    Directional safety here is narrower than the first draft of this
 *    comment claimed (round 1 review, F2): splitting a chip can only ADD
 *    candidate matches WITHIN `compileFilter` itself, since `titleInclude`
 *    is OR'd (criteria.ts) -- but more chips is not unconditionally free
 *    elsewhere in the pipeline. `sources/usajobs.ts` caps live keyword
 *    searches at `MAX_KEYWORD_SEARCHES` and silently drops the rest, and
 *    `DEFAULT_SCORE_THRESHOLD` caps how many candidates get scored per
 *    search in list order -- so an extra chip, even a narrow one, can in
 *    principle still cost coverage or spend elsewhere. The 2+-word floor on
 *    split fragments is what keeps this unlikely to matter in practice, not
 *    a claim that splitting is free everywhere.
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
        "NEVER join two role or domain concepts into ONE array entry with a comma or a " +
        "semicolon -- not 'Software Engineer, Microservices', not 'Backend Engineer; " +
        "DevOps'. If two distinct concepts both apply, return them as two SEPARATE entries " +
        "in the array instead of joining them into one string. A single entry must be one " +
        "role phrase only. A real compound title that genuinely contains 'and' as part of " +
        "its own name ('Health and Safety Engineer') is fine exactly as written -- this rule " +
        "is about joining two SEPARATE concepts together, not about avoiding the word 'and' " +
        "itself.\n\n" +
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
  "array entry must be exactly ONE role phrase: never combine a role with an unrelated " +
  "qualifier using a comma or semicolon (not 'Software Engineer, Microservices') -- return " +
  "them as two separate entries instead. A real compound title that genuinely contains " +
  "'and' as part of its own name ('Health and Safety Engineer') is fine exactly as written " +
  "-- this rule is about joining two SEPARATE concepts together, not about avoiding the " +
  "word 'and' itself. Also avoid stacking " +
  "extra qualifying words onto a role word when a shorter, more common phrasing already " +
  "covers the same role on real job boards ('Backend Engineer', not 'Backend Software " +
  "Engineer'; 'Cloud Engineer', not 'Cloud Software Engineer') -- prefer the shortest " +
  "phrasing that is still a real, commonly-posted title, and include at least one or two " +
  "entries that are the person's single most GENERIC board-common role phrase on its own, " +
  "not only specific variants. Return ONLY the JSON the schema asks for.\n\n--- RESUME ---\n\n";

/**
 * Splits any string containing a comma or semicolon joining two chunks into
 * separate standalone chips (ticket 976a782 -- see this module's doc
 * comment for why this is a CODE-level fix rather than another prompt
 * instruction).
 *
 * ONLY comma and semicolon (opus review round 1, F3) -- an earlier version
 * of this function also split on "&"/"and", which round 1 found genuinely
 * destructive on real compound titles that legitimately contain "and":
 * "Health and Safety Engineer" -> ["Health", "Safety Engineer"], "Learning
 * and Development Manager" -> ["Learning", "Development Manager"], "Sales
 * and Marketing Coordinator" -> ["Sales", "Marketing Coordinator"] -- all
 * real job titles, all wrongly mangled. The actual reported incident
 * ("Software Engineer, Microservices") never involved "and"/"&" at all.
 * Comma and semicolon carry no equivalent risk: neither is a normal part of
 * a real job title's own text, so splitting on them has no legitimate title
 * to damage.
 *
 * Fragments shorter than two words are DROPPED, not kept as their own chip
 * (opus review round 1, F2). An earlier version kept every non-empty
 * fragment, which let a comma-joined qualifier survive splitting AS a
 * standalone one-word chip instead of being removed -- "Product Manager,
 * Billing" produced a bare "Billing" chip, which `makePhraseMatcher`
 * (criteria.ts) then matches against ANY posting containing that word
 * anywhere in its title ("Billing Specialist", "Medical Billing Clerk"),
 * not just the compound qualifier it came from. That is the exact class of
 * false positive `titleSynonyms.ts`'s qualifier rule exists to prevent for
 * title EXPANSION; this function was reintroducing it through splitting.
 * Requiring 2+ words keeps "Software Engineer" (from "Software Engineer,
 * Microservices") while dropping the bare "Microservices" half, and drops
 * BOTH halves of a title that splits into two single words entirely (rare,
 * and the discarded halves would have been exactly this same false-positive
 * risk, so losing them is the safe outcome, not a loss).
 *
 * Fragments are trimmed, empty/whitespace-only pieces are dropped, and the
 * result is deduped case-insensitively (a resume with several similar
 * qualifiers could otherwise produce the same fragment twice, e.g. "Cloud
 * Engineer" surviving from two different chips). This is a plain string
 * transform, not a user-supplied regex -- same "no raw user input as a
 * pattern" discipline `criteria.ts`'s `escapeForRegex` documents for a
 * different field.
 *
 * SAFETY CLAIM, NARROWED (round 1 also found the original, broader claim
 * false): splitting can only ADD chips relative to the unsplit input within
 * `compileFilter` itself, since this feeds `titleInclude` only, which is
 * OR'd. It is NOT safe in an unqualified sense outside that: `usajobs.ts`
 * caps live keyword searches at `MAX_KEYWORD_SEARCHES` and silently drops
 * the rest, and `DEFAULT_SCORE_THRESHOLD` caps how many candidates get
 * scored per search in list order -- so MORE chips, including a genuinely
 * broad one, can still cost real coverage or spend elsewhere in the
 * pipeline even though `compileFilter` alone never loses a match from it.
 * The 2+-word filter above is what keeps the added chips narrow enough that
 * this is very unlikely to matter in practice, not a claim that adding
 * chips is free.
 *
 * KNOWN RESIDUAL WEAKNESS, recorded rather than chased with another rule:
 * the 2+-word floor filters GARBAGE SHAPE (a lone word), not GARBAGE
 * MEANING -- a two-word fragment that isn't actually a job title can still
 * survive. Observed live (2026-09-24, this ticket's own eval runs): a
 * product-manager resume produced "Senior Product Manager, B2B SaaS",
 * which split into the correct "Senior Product Manager" plus a spurious
 * "B2B SaaS" chip -- two words, but a domain descriptor, not a role. Left
 * unfixed on purpose: a real fix here would mean maintaining a curated list
 * of "role-indicating words" (Engineer, Manager, Developer, ...) to require
 * in a survivor, which is exactly the kind of hand-curated, ever-growing
 * rule this ticket's own Context explicitly warned against reaching for.
 * Lower-severity than the one-word case, not risk-free (round 2 review):
 * "B2B SaaS" specifically is essentially dead weight in the OR'd
 * `titleInclude` list -- it doesn't collide with an ordinary English word
 * the way "Billing"/"Data" did, so THIS chip is closer to "wastes one array
 * slot" than "matches the wrong postings." But the CLASS isn't immune:
 * "Product Manager, Customer Success" -> a bare "Customer Success" chip
 * would literal-match "Customer Success Representative"/"Associate"
 * postings, and "Engineer, Machine Learning" -> a bare "Machine Learning"
 * chip would match every ML-titled posting regardless of role. Those are
 * at least domain-coherent collisions (unlike "Medical Billing Clerk" for a
 * product-management search) that land in an AI-scored ranked list rather
 * than a hard accept/reject, which is why this is still judged not worth a
 * role-word allowlist -- but "essentially never happens" is a claim about
 * the one observed case, not a property of every 2-word fragment this could
 * produce. Revisit if a real search is ever measurably hurt by it.
 */
export function splitConjoinedTitles(titles: string[]): string[] {
  const JOIN_PATTERN = /\s*,\s*|\s*;\s*/g;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const title of titles) {
    for (const fragment of title.split(JOIN_PATTERN)) {
      const trimmed = fragment.trim();
      if (trimmed.length === 0) continue;
      // Drop single-word fragments -- see the doc comment above for why a
      // bare word split out of a qualifier is a false-positive risk, not a
      // useful chip.
      if (!/\s/.test(trimmed)) continue;
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
 *
 * Exported separately from `inferTitleKeywords` (ticket 976a782, opus
 * review round 1, F1) so a caller that needs to inspect what the MODEL
 * actually returned, before `splitConjoinedTitles` runs, can do so without
 * re-implementing the API call and risking drift from the real, shipped
 * request shape -- the same "import the live schema, don't re-type it"
 * discipline `scripts/validate-level-fit.ts` documents for a different
 * field. `scripts/eval-title-inference-prompt.ts` is the actual consumer:
 * checking the model's compliance with the "no comma/semicolon joining"
 * instruction only means anything against this RAW, pre-split output --
 * the split step makes that check vacuously true on its own output, which
 * is exactly the bug round 1 found in this eval script's first draft.
 *
 * NOT for production use (round 2 review, N4): every real caller must go
 * through `inferTitleKeywords` below, which applies `splitConjoinedTitles`
 * before returning -- skipping straight to this function anywhere outside
 * an eval/diagnostic context reintroduces the unsplit comma/semicolon chips
 * this whole ticket exists to close.
 */
export async function fetchRawTitleSuggestions(
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
    return parsed.titles.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  } catch {
    return [];
  }
}

export async function inferTitleKeywords(
  anthropic: Anthropic,
  resumeText: string,
): Promise<string[]> {
  return splitConjoinedTitles(await fetchRawTitleSuggestions(anthropic, resumeText));
}
