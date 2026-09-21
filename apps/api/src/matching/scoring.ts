/**
 * Claude scoring: the prompt (cached prefix + per-job suffix), the response
 * schema, and the `ScoreJobFn` that sends one scoring call.
 *
 * Split out of demo-match.ts (ticket 690c838) — this is the part of the
 * matching pipeline concerned with WHAT gets sent to Claude and HOW the
 * response is shaped; usage-cost.ts (pre-call cost estimation) and
 * pipeline.ts (the orchestration that calls a `ScoreJobFn`) build on top of
 * this file, not the other way around.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { NormalizedJob } from "../sources/types.js";

export const MODEL = "claude-sonnet-5";

/**
 * Hard cap on the scorer's own response size — the JSON schema below is
 * small (a score, a rationale, two short string arrays), so this is rarely
 * actually reached, but it's the real, code-enforced upper bound on output
 * tokens per call and is reused below as the worst-case input to
 * `estimateScoringCost`'s bootstrap path.
 *
 * Exported (ticket d8746eb) so `scripts/validate-level-fit.ts` can send the
 * SAME `max_tokens` demo-match.ts actually sends for both of its arms,
 * rather than a second, driftable literal.
 */
export const MAX_OUTPUT_TOKENS = 2000;

/**
 * Typical (not worst-case) scoring-response size, grounded in `SCHEMA`
 * above rather than assumed to hit `MAX_OUTPUT_TOKENS` every call (ticket
 * 1a2cde3). Nicole, on ticket e85fa9b's bootstrap-equals-max choice: "if
 * you can estimate the top end, I'm confused why you can't estimate a
 * middle end" — she was right that there's a real, non-arbitrary signal
 * available: the response is JSON-schema-shaped (an integer score, a
 * one-or-two-sentence rationale, two short string arrays), not free text,
 * so its typical size doesn't have to be guessed.
 *
 * Grounded in a real captured 200-job scored run (this project's own
 * resume against a real posting pool, 2026-09-04) rather than invented —
 * that data is personal job-search content and is gitignored (`prep/`),
 * so it isn't checked in for someone else to re-derive this number from,
 * but the measurement itself is real:
 *
 *   re-serializing each of the 200 real responses to exactly the shape
 *   `SCHEMA` describes (matchScore, rationale, strengths, gaps) and
 *   measuring the resulting JSON string length gave avg 1,232 chars
 *   (min 869, max 1,665) — roughly 308 tokens at this file's own
 *   `CHARS_PER_TOKEN_ESTIMATE` heuristic (below), well under
 *   `MAX_OUTPUT_TOKENS`'s 2,000-token ceiling. Rounded up slightly for
 *   headroom rather than used raw.
 *
 * Deliberately run through the SAME `CHARS_PER_TOKEN_ESTIMATE` heuristic
 * the input side already uses in this file, not a separately-tuned
 * factor — that heuristic's own known imprecision (see
 * `buildCachedPrefix`'s doc comment: ~40% under real tokenization for
 * this project's resume prose) is an existing, accepted limitation of
 * the bootstrap path generally, not something this ticket's output-side
 * estimate needs to solve differently from the input-side one it sits
 * next to.
 *
 * UPDATED 2026-09-12 (ticket b182bde) for the two new schema fields
 * (`levelFit`, `levelFitNote` — see `SCHEMA` above): `levelFit` is a short
 * enum string (under 20 chars including the JSON key), `levelFitNote` is
 * "one short sentence" per its own schema description — call it a par with
 * one `strengths`/`gaps` array entry. Together, roughly 150-170 chars of
 * additional JSON per response. This is an ESTIMATE, not a re-measurement
 * of a real corpus: this ticket makes no live Claude calls (see its Notes —
 * no API spend), so there is no fresh 200-job run to re-derive the base
 * 1,232-char figure from the way that figure was originally derived. Adding
 * the estimated addition to the prior measured average (1,232 + 160 ≈
 * 1,392) and rounding up for headroom, the same way the prior constant
 * rounded 1,232 up to 1,300, gives 1,450. Revisit this with a real
 * measurement once the money-gated follow-up ticket (af0fca6-b) actually
 * re-scores a corpus with the new fields live.
 */
export const TYPICAL_OUTPUT_CHARS_PER_JOB = 1450;

/**
 * Spend-guard threshold (ticket 16c824a) — replaces `MAX_JOBS`, which used
 * to silently slice the shortlist to 12 in board-iteration order. That was
 * the bug: it went uncaught for two funnel-widening tickets (545 -> 6,038
 * -> 11,609 postings) because nothing measured or reported the truncation.
 *
 * INGESTION has no truncation-by-order cap at all, full stop — every
 * survivor gets ingested and is a scoring candidate (see `candidates` in
 * `runDemoMatch`). SCORING is different, and this needs to be said
 * precisely (ticket 16c824a review F3 caught an earlier draft of this
 * comment overclaiming here): above this many jobs actually needing a
 * *new* score in one run (already-scored jobs are free — ticket 620ca30),
 * `runDemoMatch` caps scoring at the threshold, and when that cap binds,
 * the capped-out subset genuinely IS "the first `scoreThreshold` of
 * `needsScoreIds` in candidate order" — the SAME SHAPE as the original
 * `MAX_JOBS` bug, just at N=200 instead of N=12. Three things are
 * deliberately different this time:
 *
 *   1. It's reported explicitly, every single time it binds — never
 *      silent. A run log line always states it plainly:
 *      `"N candidate(s): ... K not scored (cap)"`.
 *   2. It bounds SPEND, not coverage: every survivor was already ingested
 *      before this cap is even evaluated, so nothing is lost from the
 *      database — only deferred out of THIS run's scoring.
 *   3. It's self-draining at no extra cost. A plain rerun with no flags
 *      sees this run's newly-scored jobs as already-scored (free, ticket
 *      620ca30) and the cap applies to the NEXT `scoreThreshold` of what's
 *      left — repeat until the backlog is gone, for the same total spend
 *      `allowAboveThreshold` would have cost in one run, just spread
 *      across runs. Scoring the whole backlog in a single run instead
 *      requires explicit opt-in (`allowAboveThreshold` /
 *      `ALLOW_SCORE_ABOVE_THRESHOLD=true`).
 *
 * Pool size this assumes: comfortably under a few hundred jobs needing a
 * new score per run. 129 total survivors (Greenhouse only) was the
 * measurement that motivated "score everything" over a cleverer selection
 * heuristic (git-bug 16c824a). Ticket 8d3f4a1 wires Lever, Ashby, and
 * SmartRecruiters into the same search and may grow the pool by an unknown
 * multiple — SmartRecruiters alone lists 4,771 postings for ONE company
 * before filtering, and at the ~2% observed survival rate a four-source
 * pool lands around 250, which means this cap can plausibly bind on the
 * very first real run after those sources are wired in. If real runs start
 * landing above this threshold routinely, that is this exact ticket's
 * original bug recurring at 10x the scale, pointed at the bank account
 * instead of at coverage — raise (or rethink) this number deliberately,
 * don't just flip the opt-in on permanently.
 */
export const DEFAULT_SCORE_THRESHOLD = 200;

/**
 * Exported (ticket d8746eb) so `scripts/validate-level-fit.ts` can import
 * the LIVE, shipped schema directly instead of re-typing it — the whole
 * point of that script's "arm B" is that it can never drift from what this
 * file actually ships, which only holds if it imports this constant rather
 * than copying it. Was a private `const` before this ticket; nothing else
 * about it changed.
 */
export const SCHEMA = {
  type: "object",
  properties: {
    matchScore: {
      type: "integer",
      description: "0-100. How well this candidate matches this posting.",
    },
    rationale: {
      type: "string",
      description: "One or two sentences. What lines up, and what is missing.",
    },
    // Ticket b182bde: added AFTER rationale, BEFORE strengths/gaps — see
    // that ticket's Context for the evidence (matchScore values of 42-78 for
    // the SAME leveling mismatch across six real postings) and
    // SCORING_PREAMBLE below for the instruction that keeps this judgment
    // separate from matchScore.
    levelFit: {
      type: "string",
      enum: ["underqualified", "well_matched", "overqualified"],
      description:
        "Where the candidate's seniority sits against the level THIS POSTING is written for. " +
        "Judge against the posting's own stated level and years-of-experience range, not against " +
        "their skills. 'overqualified' when they are clearly above it, 'underqualified' when the " +
        "posting's level is above them, 'well_matched' otherwise.",
    },
    levelFitNote: {
      type: "string",
      description:
        "One short sentence, plain language, addressed to the candidate, on how level fit affects " +
        "their real chance of being hired here -- screening risk, compensation mismatch, or a stretch. " +
        "Quote the posting's own stated level or years range when it states one. " +
        "Empty string when levelFit is 'well_matched'.",
    },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["matchScore", "rationale", "levelFit", "levelFitNote", "strengths", "gaps"],
  additionalProperties: false,
};

/**
 * What a scorer produces. `matchScore` and `rationale` are the two columns
 * `job_matches` always had; `strengths`/`gaps` are the discrete objections
 * a screener would raise — the highest-signal part of what the model
 * actually returns, and the marginal cost of asking for them is zero (the
 * call is already made). They're persisted as `jsonb` columns so a second
 * run's database-backed results carry them too, not just the run that
 * originally scored the job.
 */
export type ScoredJob = {
  matchScore: number;
  rationale: string;
  /**
   * Leveling fit, judged separately from `matchScore` in this same call —
   * see `SCHEMA`/`SCORING_PREAMBLE` above and `LevelFit` in
   * packages/shared/src/index.ts. Optional on this TYPE only (matching the
   * existing `usage?` precedent right below) so every existing `ScoreJobFn`
   * test fake in demo-match.test.ts keeps compiling without being forced to
   * add these two fields everywhere — a real `makeClaudeScorer` call always
   * returns them (they're in `required` above).
   */
  levelFit?: "underqualified" | "well_matched" | "overqualified";
  levelFitNote?: string;
  strengths: string[];
  gaps: string[];
  /**
   * Real token usage for this call, when the scorer can report it — the
   * live Claude scorer below always can (`response.usage`). Used only to
   * update the on-disk usage stats that back `estimateScoringCost`'s spend
   * guard (ticket 16c824a); never persisted to `job_matches`. Optional so
   * every existing `ScoreJobFn` fake (demo-match.test.ts) keeps compiling
   * unchanged — a fake scorer has no real usage to report.
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /**
     * Real cache-read / cache-write tokens for this call (ticket aff284b),
     * kept separate from `inputTokens` — the API's own `input_tokens` is
     * the UNCACHED remainder only (shared/prompt-caching.md in the
     * claude-api skill: "input_tokens is the uncached remainder only").
     * Optional so a fake scorer that reports plain `{inputTokens,
     * outputTokens}` usage (demo-match.test.ts's `makeUsageReportingScorer`)
     * keeps compiling unchanged; `makeClaudeScorer` always sets both,
     * defaulting the SDK's nullable fields to 0.
     */
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
};

/** Injectable so tests can assert call counts without spending real Claude
 * tokens (or requiring `ANTHROPIC_API_KEY`) and without needing a resume
 * closed over module state. */
export type ScoreJobFn = (job: NormalizedJob, resumeText: string) => Promise<ScoredJob>;

/**
 * Instruction preamble — byte-identical across every scoring call in a run,
 * exactly like the resume (ticket aff284b). Folded into the CACHED PREFIX
 * below alongside the resume rather than left as a separate uncached block:
 * both are constant for the life of a run, so one cache_control breakpoint
 * covering both is strictly better than two (max 4 breakpoints per
 * request; this project uses exactly one) with no functional difference,
 * since neither ever varies independently of the other.
 */
/**
 * Exported (ticket d8746eb) for the same reason `SCHEMA` above now is —
 * `scripts/validate-level-fit.ts`'s "arm B" imports this live preamble
 * directly rather than copying it, so it can never silently drift from
 * what a real scoring call actually sends. Was a private `const` before
 * this ticket.
 */
export const SCORING_PREAMBLE = [
  "Score how well this candidate matches this job posting.",
  "Be honest and calibrated — most candidates are not a 90.",
  "",
  "Judge two separate things and report both.",
  "",
  "matchScore is CAPABILITY fit: how well this candidate's skills and experience cover what",
  "the posting asks for. Do not lower it because the candidate has MORE experience than the",
  "posting asks for.",
  "",
  "levelFit is LEVELING fit: whether the candidate sits below, at, or above the level this",
  "posting is written for. levelFitNote is one plain sentence to the candidate about how that",
  'affects their real chance of being hired; leave it empty when levelFit is "well_matched".',
].join("\n");

/**
 * The CACHED PREFIX (ticket aff284b): preamble + resume, byte-identical
 * across every `scoreJob` call sharing one `resumeText`. Must be sent
 * FIRST — prompt caching is a prefix match, and only bytes AHEAD of a
 * cache_control breakpoint are what gets cached (shared/prompt-caching.md
 * in the claude-api skill). `makeClaudeScorer` sends this as one
 * `cache_control`-marked content block; `buildJobSuffix` (below, varies
 * every call) is a second, unmarked block after it.
 *
 * Minimum cacheable prefix for `claude-sonnet-5` (`MODEL`) is
 * `CACHE_MIN_PREFIX_TOKENS` (1,024) tokens — verified live against
 * platform.claude.com/docs/en/build-with-claude/prompt-caching.md on
 * 2026-08-31 (matches the `claude-api` skill's own cached table). A resume
 * short enough to put this whole prefix under that minimum does NOT
 * error: `cache_control` on a too-short prefix silently creates no cache
 * entry (`cache_creation_input_tokens: 0` in the response) and the call is
 * scored normally at full price — see the "degrades gracefully for a short
 * resume" coverage in demo-match.test.ts. `estimateScoringCost` (ticket
 * aff284b review round 3 F4) checks a run's real prefix against this same
 * threshold before assuming caching will happen at all -- but it can only
 * check its own heuristic ESTIMATE of the prefix's token count (see
 * `CHARS_PER_TOKEN_ESTIMATE`, measured ~40% under real tokenization for
 * this project's resume text), not the true count the live API would see.
 * The misclassification band this leaves (round 4 finding R2) errs toward
 * assuming no caching when real caching would in fact happen -- the
 * conservative direction this file's cost estimates otherwise favor -- so
 * a resume estimated just under the minimum may still cache for real,
 * making the estimate somewhat high rather than dangerously low.
 */
export function buildCachedPrefix(resumeText: string): string {
  return [SCORING_PREAMBLE, "", "=== RESUME ===", resumeText].join("\n");
}

/**
 * See `buildCachedPrefix`'s doc comment above. A prefix below this many
 * tokens never actually creates a cache entry — the API silently no-ops
 * `cache_control` instead of erroring — so any code deciding whether a run
 * WILL cache (as opposed to code that just builds the prompt regardless)
 * must check against this same number.
 */
export const CACHE_MIN_PREFIX_TOKENS = 1024;

/**
 * The per-job suffix — the only part of a scoring prompt that varies
 * across calls sharing one `resumeText`. Placed AFTER the cache_control
 * breakpoint (`buildCachedPrefix`) so a new job posting never invalidates
 * the cached prefix ahead of it. Leading `"\n\n"` (rather than joining
 * through an array, as `buildCachedPrefix` does) reproduces the exact
 * blank-line separator `buildScoringPrompt` sent before this ticket when
 * concatenated directly onto `buildCachedPrefix`'s output with no
 * separator of its own.
 */
export function buildJobSuffix(job: NormalizedJob): string {
  return (
    "\n\n" +
    [
      "=== JOB POSTING ===",
      `Title: ${job.title}`,
      `Employer: ${job.company}`,
      `Location: ${job.location ?? "not stated"} (${job.locationType})`,
      `Type: ${job.payType}, ${job.commitment}`,
      "",
      job.description.slice(0, 6000),
    ].join("\n")
  );
}

/**
 * The exact combined prompt text a real scoring call sends — the cached
 * prefix (`buildCachedPrefix`) followed by the per-job suffix
 * (`buildJobSuffix`). `makeClaudeScorer` itself sends these as TWO
 * separate content blocks (the first `cache_control`-marked), not this one
 * concatenated string — see that function. This combined form still
 * exists because `estimateScoringCost`'s bootstrap path needs the REAL
 * total character count of what a call sends, and total length is
 * identical whether measured as one string or as two concatenated blocks.
 */
export function buildScoringPrompt(job: NormalizedJob, resumeText: string): string {
  return buildCachedPrefix(resumeText) + buildJobSuffix(job);
}

export function makeClaudeScorer(anthropic: Anthropic): ScoreJobFn {
  return async function scoreJob(job: NormalizedJob, resumeText: string): Promise<ScoredJob> {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildCachedPrefix(resumeText),
              // Ticket aff284b: everything up to and including this block
              // is the cache breakpoint. Default TTL (5 minutes — no `ttl`
              // override) is what CACHE_WRITE_PRICE_MULTIPLIER below
              // assumes; see buildCachedPrefix's doc comment for the
              // minimum-length/graceful-degradation behavior.
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: buildJobSuffix(job) },
          ],
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block returned");
    const parsed = JSON.parse(text.text) as Omit<ScoredJob, "usage">;
    return {
      ...parsed,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        // Ticket aff284b — the whole point: 0 on a cache MISS (the run's
        // first call, or a resume too short to cache) and nonzero on every
        // call after the cache is warm. Nullable per the SDK's `Usage`
        // type; defaulted to 0 here so `ScoredJob.usage` always reports
        // real numbers, never `null`.
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}
