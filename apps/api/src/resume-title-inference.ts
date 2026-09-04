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
        "3-6 concise job title keywords (e.g. 'Backend Engineer', 'Technical Writer') this " +
        "person would plausibly search for, based on their real experience in the resume. " +
        "Prefer the level/seniority actually evidenced in the resume -- do not default to " +
        "entry-level or omit senior/staff/principal titles if the resume supports them.",
    },
  },
  required: ["titles"],
  additionalProperties: false,
};

const PROMPT_PREFIX =
  "You are helping someone search for jobs. Read their resume below and suggest job title " +
  "keywords they would plausibly search for -- grounded in their actual experience and " +
  "seniority as shown in the resume, not a generic guess. Return ONLY the JSON the schema " +
  "asks for.\n\n--- RESUME ---\n\n";

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
