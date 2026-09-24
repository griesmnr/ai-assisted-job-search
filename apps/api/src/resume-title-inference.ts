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
        "person's evidenced experience, not folded into the title string.",
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
  "Learning Engineer', 'Android Developer') is fine to suggest exactly as written. Return " +
  "ONLY the JSON the schema asks for.\n\n--- RESUME ---\n\n";

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
    return parsed.titles.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  } catch {
    return [];
  }
}
