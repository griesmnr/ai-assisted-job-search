/**
 * End-to-end vertical slice, real infrastructure underneath.
 *
 *   real job postings  ->  Claude  ->  ranked match scores  ->  Postgres
 *
 * Bypasses the queue and the API, but not the database: the resume, the
 * jobs, and every match score are persisted, so running this twice does
 * not pay Claude twice for identical work (ticket 620ca30). Everything
 * that decides *which* jobs get scored and *how* they get persisted lives
 * in `runDemoMatch`, which takes its dependencies as arguments so tests can
 * inject a fake scorer and a fake source instead of hitting the real
 * Anthropic API or the real USAJOBS/Greenhouse APIs.
 *
 *   npx tsx apps/api/src/demo-match.ts
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { Job } from "@app/shared";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { seedSourceDescriptors } from "./db/seed.js";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchSources,
  userJobStatuses,
} from "./db/schema.js";
import { ingestJobsForSearch } from "./ingest/ingestJobs.js";
import { createAshbySourceFromEnv } from "./sources/ashby.js";
import { CompositeSource, type PerSourceOutcome } from "./sources/composite.js";
import { createGreenhouseSourceFromEnv } from "./sources/greenhouse.js";
import { createLeverSourceFromEnv } from "./sources/lever.js";
import { createSmartRecruitersSourceFromEnv } from "./sources/smartrecruiters.js";
import { filterSoftwareEngineeringJobs } from "./sources/swe-filter.js";
import type { JobSource, NormalizedJob, SearchCriteria, TokenOutcome } from "./sources/types.js";

process.loadEnvFile();

/**
 * Scoring model. Chosen 2026-08-22 on the evidence of the A/B in
 * `model-ab.ts`, which re-scored the same real jobs against the same real
 * resume with both models: sonnet produced the same #1, the same top-5 set,
 * and the same overall ordering as opus for roughly 40% less. That was a
 * defensible-either-way call at 13 candidates; at 130 (ticket b723fb9 took
 * the funnel from 545 postings to 6,038) the cost difference stops being
 * theoretical.
 *
 * Note this makes new scores not strictly comparable to any opus-scored
 * rows already in `job_matches`. The A/B says the *ranking* agrees, which is what the shortlist
 * actually consumes, so mixed scales are acceptable here; re-scoring
 * history to match would cost more than the inconsistency does.
 * Re-run `model-ab.ts` before changing this again.
 */
export const MODEL = "claude-sonnet-5";

/**
 * Hard cap on the scorer's own response size — the JSON schema below is
 * small (a score, a rationale, two short string arrays), so this is rarely
 * actually reached, but it's the real, code-enforced upper bound on output
 * tokens per call and is reused below as the worst-case input to
 * `estimateScoringCost`'s bootstrap path.
 */
const MAX_OUTPUT_TOKENS = 2000;

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

const SCHEMA = {
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
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["matchScore", "rationale", "strengths", "gaps"],
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
const SCORING_PREAMBLE = [
  "Score how well this candidate matches this job posting.",
  "Be honest and calibrated — most candidates are not a 90.",
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
const CACHE_MIN_PREFIX_TOKENS = 1024;

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

/**
 * $/million tokens for `MODEL` (claude-sonnet-5) — mirrors model-ab.ts's own
 * `PRICING` table for the same model. Duplicated rather than imported:
 * model-ab.ts reads `prep/resume.txt` and constructs an `Anthropic` client
 * at MODULE LOAD time (not inside its `main()`), so importing it here would
 * make every test — and every non-scoring code path — depend on that file
 * existing and `ANTHROPIC_API_KEY` being set. Same reason
 * `filterSoftwareEngineeringJobs` lives in swe-filter.ts instead of here;
 * see the re-export comment near the bottom of this file.
 *
 * NOTE (ticket 16c824a review F5): claude-sonnet-5 is running an
 * introductory price of $2/$10 per MTok through 2026-08-31; this constant
 * intentionally uses the $3/$15 standard rate instead (matching
 * model-ab.ts exactly), so every estimate below is conservative on top of
 * the bootstrap path already assuming worst-case output — see
 * `describeCostEstimate`.
 */
const SONNET_PRICE_PER_MILLION_TOKENS = { in: 3, out: 15 };

/**
 * Prompt-cache pricing multipliers (ticket aff284b), applied to the
 * relevant `pricePerMillionTokens.in` rate. Verified live against
 * platform.claude.com/docs/en/build-with-claude/prompt-caching.md,
 * 2026-08-31: a cache READ costs 0.1x the base input price; a cache WRITE
 * under the default 5-minute TTL costs 1.25x (a 1-hour TTL write would be
 * 2x instead, but `makeClaudeScorer` never passes a `ttl` override, so 5
 * minutes — and 1.25x — is what this project actually pays).
 *
 * MEASURED, not assumed (ticket aff284b acceptance criteria) — live
 * `claude-sonnet-5` run, 2026-09-02, same 5-job set scored twice, real
 * `prep/resume.txt` (4,914 chars): BEFORE (pre-ticket single-block prompt,
 * no `cache_control`) totaled 11,563 input tokens across 5 calls, $0.034689
 * of input cost at this constant's rate. AFTER (this ticket's two-block
 * prompt, first call alone then the rest) totaled 1,228 uncached input +
 * 8,452 cache-read + 2,113 cache-creation tokens, $0.014143 of input cost
 * — a 59.2% reduction in input cost on this small set. `cache_read_input_tokens`
 * was confirmed nonzero in the raw API response on every call after the
 * first, and 0 on the first call and on a resume too short to cache — see
 * `buildCachedPrefix`'s doc comment for that case. Full commit message has
 * the per-call numbers.
 *
 * CORRECTION (ticket aff284b review R4, 2026-09-02, same day as the
 * measurement above): an earlier version of this comment claimed the 59.2%
 * figure beat the ticket's ~25% estimate "because a 5-call run has a much
 * higher cache-hit ratio (4/5) than the production 200-call/1-write case."
 * That explanation is backwards and has been deleted, not merely
 * softened: a 200-call run's hit ratio is 199/200 = 99.5%, HIGHER than
 * this set's 4/5 = 80%, so if hit ratio alone explained the saving, the
 * LARGER run would save MORE, not less — the opposite of what the old
 * comment claimed.
 *
 * The real reason, traced from this measurement's own numbers: this
 * 5-job set's cached prefix (preamble + resume) measured 2,113 tokens —
 * the AFTER run's `cache_creation_input_tokens` on call 1 — about 1.7x
 * the ticket's assumed ~1,230 tokens. Meanwhile its AFTER run's uncached
 * input totaled 1,228 tokens across all 5 calls, i.e. ~246 tokens of
 * per-job SUFFIX on average (1,228 / 5) — unusually small next to the
 * real production baseline measured 2026-08-31, whose per-job suffix
 * (the job-posting text `buildJobSuffix` sends, capped at 6,000 chars)
 * runs closer to ~1,762 tokens. A bigger-than-assumed cached prefix and a
 * much smaller-than-typical uncached suffix both push this small set's
 * percentage saving UP relative to a normal run, independent of call
 * count or hit ratio: the cached (discounted) share of each prompt is
 * larger, and the always-full-price uncached share is smaller.
 *
 * Projected onto the production-scale baseline instead of this small
 * set's own suffix size (N=200 jobs, prefix=2,113 tokens written once,
 * suffix≈1,762 tokens/job, this constant's multipliers): BEFORE cost ≈
 * 200 × (2,113 + 1,762) tokens × $3/MTok ≈ $2.325; AFTER cost ≈
 * (200 × 1,762 uncached + 199 × 2,113 cache-read × 0.1 + 2,113
 * cache-creation × 1.25) tokens priced at $3/MTok ≈ $1.191 — a ~49%
 * reduction, not 59.2%. Still roughly 2x the ticket's ~25% estimate
 * (genuinely good news, and the reason this ticket shipped), but the
 * 59.2% headline above is specific to this small, suffix-light test set,
 * not representative of a real 200-job run.
 */
const CACHE_READ_PRICE_MULTIPLIER = 0.1;
const CACHE_WRITE_PRICE_MULTIPLIER = 1.25;

/**
 * ~4 characters per token is the standard rough estimate for English text
 * (the same figure both OpenAI's and Anthropic's own tokenizer guidance
 * cite) — used only to convert a REAL character count (this run's actual
 * prompt text, built by the same `buildScoringPrompt` the live scorer
 * sends) into an estimated token count. Only the conversion ratio is
 * approximate; the character counts it's applied to are exact, not
 * guessed.
 */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Running totals of REAL per-call token usage, accumulated across live
 * runs (see `recordUsageStats` / the end of the scoring loop in
 * `runDemoMatch`). Read back by `estimateScoringCost` so the pre-scoring
 * cost estimate is grounded in what scoring actually cost last time, not a
 * one-off guess. `calls` counts real Claude calls only — a fake test
 * scorer's `ScoredJob` has no `usage`, so test runs never pollute this.
 */
export type UsageStats = {
  /**
   * Which model these totals were measured against (ticket 16c824a review
   * F5). `MODEL` has already changed once, opus -> sonnet, two days before
   * this ticket. Averages recorded under a different model have a
   * different typical response length AND a different price — blending
   * them into "the" average would silently corrupt both. `readUsageStats`
   * refuses to return stats recorded under a model other than the one it's
   * asked about, rather than average across models.
   */
  model: string;
  calls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /**
   * Real recorded cache-read / cache-write tokens, accumulated separately
   * from `totalInputTokens` (ticket aff284b) for the same reason
   * `ScoredJob.usage.cacheReadTokens` is separate from `inputTokens` — see
   * that field's doc comment. Optional on the TYPE only so a
   * caller-constructed literal (several tests build one directly, without
   * going through `recordUsageStats`) can omit them; `recordUsageStats`
   * itself always writes concrete numbers, 0 if unknown, never omits them.
   *
   * A stats file written by a PRE-aff284b build of this project — shape
   * `{model, calls, totalInputTokens, totalOutputTokens}`, no cache fields
   * at all — is NOT treated as a valid current-shape `UsageStats` (ticket
   * aff284b review R2, reversing an earlier draft of this comment that
   * claimed otherwise): `totalInputTokens` meant "the whole prompt" under
   * that old shape and means "the uncached remainder only" under this one
   * — the same field name, two incompatible meanings — so defaulting the
   * missing cache fields to 0 and blending the old average in would
   * silently corrupt it (reviewer measured ~7x overestimate in one
   * reconstructed scenario). `readUsageStats` detects "missing both cache
   * fields" and discards such a file (returns `undefined`) instead of
   * reading it as current — see that function's doc comment. Total prompt
   * size for any one call = inputTokens + cacheReadTokens +
   * cacheCreationTokens (shared/prompt-caching.md).
   */
  totalCacheReadTokens?: number;
  totalCacheCreationTokens?: number;
};

/**
 * Reads previously recorded usage stats. Returns `undefined` — not a
 * thrown error — when the file is missing (every project's very first
 * scoring run, or a fresh checkout), unparseable, recorded under a
 * DIFFERENT model than `expectedModel` (ticket 16c824a review F5 — see
 * `UsageStats.model`'s doc comment), or — as of ticket aff284b review R2 —
 * missing BOTH cache-related keys, meaning it predates prompt caching
 * entirely: a stats file existing is an optimization for the cost
 * estimate, never a precondition for scoring to work, and stale stats
 * (wrong model, OR pre-caching shape) are worse than no stats at all.
 *
 * Why a pre-aff284b file can't just default its missing cache fields to 0
 * and be treated as current (which is what this function did before R2):
 * `totalInputTokens` meant "the WHOLE prompt" under the pre-caching code
 * and means "the UNCACHED remainder only" under the current code (see
 * `UsageStats`'s doc comment) — the SAME field name, two incompatible
 * meanings. A same-model file written before this ticket would otherwise
 * silently blend a "whole prompt" average into a "remainder only" running
 * total as if they measured the same thing, corrupting the average
 * (reviewer measured roughly a 7x overestimate in one reconstructed
 * scenario). Detecting "predates caching" by the presence of the cache
 * keys themselves — rather than, say, a schema version field this
 * codebase never had — is what's available on disk today; every file
 * `recordUsageStats` writes now carries both keys together (concrete
 * numbers, 0 if unknown — see that function), so "has neither key" is an
 * unambiguous signal of "written by an older build", not a coincidence of
 * a partially-written file.
 */
export function readUsageStats(
  path: string,
  expectedModel: string = MODEL,
): UsageStats | undefined {
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsageStats>;
    if (
      typeof parsed.calls === "number" &&
      typeof parsed.totalInputTokens === "number" &&
      typeof parsed.totalOutputTokens === "number" &&
      typeof parsed.model === "string" &&
      parsed.calls > 0
    ) {
      if (parsed.model !== expectedModel) return undefined;
      // Ticket aff284b review R2: a file that predates this ticket has
      // NEITHER cache-related key at all (the pre-aff284b `UsageStats`
      // shape was exactly `{model, calls, totalInputTokens,
      // totalOutputTokens}`). Before this fix, such a file was silently
      // treated as "0 cache tokens measured yet" and its
      // `totalInputTokens` — which meant "the WHOLE prompt" under the old
      // code — got blended straight into the SAME field's new meaning
      // ("the UNCACHED remainder only", see `UsageStats`'s doc comment) as
      // if they were commensurable. They are not: blending them silently
      // corrupted the average (reviewer measured ~7x overestimate in one
      // scenario). Same treatment as a model mismatch above — stale data
      // is worse than no data — except the trigger here is "predates
      // caching" rather than "wrong model": a file missing BOTH cache keys
      // is stale regardless of `model` matching, and gets discarded rather
      // than blended.
      const hasAnyCacheField =
        typeof parsed.totalCacheReadTokens === "number" ||
        typeof parsed.totalCacheCreationTokens === "number";
      if (!hasAnyCacheField) return undefined;
      return {
        model: parsed.model,
        calls: parsed.calls,
        totalInputTokens: parsed.totalInputTokens,
        totalOutputTokens: parsed.totalOutputTokens,
        totalCacheReadTokens:
          typeof parsed.totalCacheReadTokens === "number" ? parsed.totalCacheReadTokens : 0,
        totalCacheCreationTokens:
          typeof parsed.totalCacheCreationTokens === "number" ? parsed.totalCacheCreationTokens : 0,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges `added` real usage into whatever `readUsageStats(path, model)`
 * currently holds (treating a missing/corrupt/different-model file as
 * zero — see `readUsageStats`) and writes the result back under `model`.
 * If `MODEL` changes again, the next call here starts a fresh average
 * under the new model name instead of blending into the old one.
 *
 * `totalCacheReadTokens`/`totalCacheCreationTokens` on `added` are
 * optional (ticket aff284b) so existing call sites that only ever tracked
 * `{calls, totalInputTokens, totalOutputTokens}` keep compiling unchanged;
 * omitted is treated as 0, same as `readUsageStats` treats their absence
 * on disk. The written file always carries concrete numbers for both
 * (0 if nothing was added), not `undefined` — once any run has passed
 * through this code, the stats file is self-describing.
 *
 * Deliberately allowed to throw (ENOENT for a missing directory, EACCES,
 * ENOSPC, ...) rather than swallowing the error itself — ticket 16c824a
 * review F1 found this being called with nothing guarding it BEFORE the
 * scores it's tracking were persisted, which meant a write failure here
 * discarded already-paid-for scores along with it. The fix is entirely in
 * the CALLER: call this only after the scores are safely in the database,
 * and wrap the call in try/catch there (see `runDemoMatch`) so a failure
 * here can never take persisted, already-billed scores down with it.
 */
export function recordUsageStats(
  path: string,
  added: {
    calls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
  },
  model: string = MODEL,
): void {
  if (added.calls === 0) return;
  const prior = readUsageStats(path, model) ?? {
    model,
    calls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
  };
  const next: UsageStats = {
    model,
    calls: prior.calls + added.calls,
    totalInputTokens: prior.totalInputTokens + added.totalInputTokens,
    totalOutputTokens: prior.totalOutputTokens + added.totalOutputTokens,
    totalCacheReadTokens: (prior.totalCacheReadTokens ?? 0) + (added.totalCacheReadTokens ?? 0),
    totalCacheCreationTokens:
      (prior.totalCacheCreationTokens ?? 0) + (added.totalCacheCreationTokens ?? 0),
  };
  fs.writeFileSync(path, JSON.stringify(next, null, 2));
}

/**
 * Ticket aff284b review R1: `estimatedInputTokens` mirrors the Claude API's
 * own `input_tokens` field, which post-caching is only the UNCACHED
 * remainder of a prompt — NOT the whole thing (see `buildCachedPrefix` /
 * `makeClaudeScorer` above). A real 200-job run measured
 * `estimatedInputTokens` alone understating actual prompt tokens sent by
 * ~90% (roughly 49,120 + 91,160 shown vs ~471,720 actually sent) when a
 * caller rendered it as though it were the whole prompt. Total tokens sent
 * for a call is always `estimatedInputTokens + estimatedCacheReadTokens +
 * estimatedCacheCreationTokens` — see those two fields, and
 * `describeCostEstimate` below, which renders the total rather than
 * `estimatedInputTokens` alone.
 */
export type CostEstimate = {
  jobCount: number;
  /** Uncached input tokens only. Do not present this alone as "the" input
   * token count — see this type's own doc comment. */
  estimatedInputTokens: number;
  /**
   * Cache-read tokens (billed at `CACHE_READ_PRICE_MULTIPLIER`, 0.1x the
   * input rate) — every job after the run's first reads a warm cache. 0 on
   * the "bootstrap" basis (see `basis` below): with no recorded history,
   * `estimateScoringCost` has no way to know the run-time cache-hit split
   * in advance, so it prices bootstrap conservatively at the flat input
   * rate instead of guessing a split.
   *
   * Ticket aff284b review round 3 F3: on the "measured" basis this is now
   * computed the same direct way as `estimatedCacheCreationTokens` below —
   * this run's real prefix token count (`buildCachedPrefix(resumeText)`,
   * heuristically estimated — see that field's doc comment on the
   * estimate's accuracy) times `jobCount - 1`, since every job after the
   * first (which is the cache WRITE, not a read) reads the cache exactly
   * once. This replaced an earlier historical-average approach
   * (`avgCacheReadTokens * jobCount`) that both diluted the per-read figure
   * with each historical run's one non-reading write call, and multiplied
   * by the full `jobCount` instead of `jobCount - 1` — so it also came out
   * wrong (nonzero) for a single-job run, where there is no second job to
   * ever read the cache. 0 for `jobCount === 1` and for any prefix under
   * `CACHE_MIN_PREFIX_TOKENS` (ticket aff284b review round 3 F4 — a prefix
   * that short never creates a cache entry at all; see
   * `buildCachedPrefix`'s doc comment).
   */
  estimatedCacheReadTokens: number;
  /**
   * Cache-creation (cache-write) tokens (billed at
   * `CACHE_WRITE_PRICE_MULTIPLIER`, 1.25x the input rate, default 5-minute
   * TTL). Ticket aff284b review S1: a run writes its cache exactly ONCE
   * regardless of job count (`runDemoMatch`'s first-then-batch pre-warm —
   * see the comment on `toScoreIds`/`firstId` there), so this must never be
   * multiplied by `jobCount` the way `estimatedCacheReadTokens` is.
   *
   * Ticket aff284b review round 2 S2: on the "measured" basis this is NOT
   * a historical per-run average — an earlier version of this comment (and
   * of `estimateScoringCost`) claimed `totalCacheCreationTokens / calls`
   * already *was* that average, which is wrong (see the inline comment in
   * `estimateScoringCost` for the math and the live-stats measurement that
   * caught it: a 5x undercount). It's computed directly from THIS run's
   * real cached prefix (`buildCachedPrefix(resumeText)`, converted to
   * tokens via `CHARS_PER_TOKEN_ESTIMATE`, the same character-count
   * heuristic the bootstrap path uses for a whole prompt below) instead of
   * averaged from history.
   *
   * Ticket aff284b review round 3 F1/F2 (correcting an overclaim in an
   * earlier version of this comment and of `estimateScoringCost`'s inline
   * comments): that conversion is an ESTIMATE, not an exact token count —
   * `buildCachedPrefix(resumeText).length / CHARS_PER_TOKEN_ESTIMATE` is
   * the same chars/4 heuristic used everywhere else in this file, and it is
   * NOT what the API actually tokenizes to. Measured directly against this
   * project's own real resume (`prep/resume.txt`, 4,914 chars, live
   * `claude-sonnet-5` call, 2026-09-02 — see `CACHE_READ_PRICE_MULTIPLIER`'s
   * doc comment above): the resulting 5,043-char prefix estimates to 1,261
   * tokens by this heuristic, but the real, measured
   * `cache_creation_input_tokens` on that call was 2,113 — the heuristic
   * undercounts real tokenization of resume-style text by roughly 40%.
   * Still a large improvement over the S2 fix's predecessor (a 5x
   * undercount from averaging across a differently-shaped historical
   * figure), and still directly grounded in this run's real prompt text
   * rather than an invented number — but not exact, and no per-run
   * measurement performed before the call is made ever can be (there is no
   * way to know the API's real tokenization without asking the API, and
   * `estimateScoringCost` must produce a number before any call happens).
   * 0 on the "bootstrap" basis and for a prefix under
   * `CACHE_MIN_PREFIX_TOKENS` (ticket aff284b review round 3 F4) — see
   * `estimatedCacheReadTokens` above and `estimateScoringCost`'s own doc
   * comment for why bootstrap prices the whole prompt (prefix included) at
   * the flat input rate instead of splitting out a separate cache-write
   * estimate.
   */
  estimatedCacheCreationTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  /**
   * "measured": both averages come from `usageStats` — real recorded calls
   * from a prior run. "bootstrap": no recorded calls exist yet, so input is
   * estimated from THIS run's real prompt character counts (see
   * `CHARS_PER_TOKEN_ESTIMATE`) and output assumes the worst case,
   * `MAX_OUTPUT_TOKENS` per job (the model's actual hard cap) — real
   * numbers from this codebase, never an invented per-job dollar figure.
   */
  basis: "measured" | "bootstrap";
};

/**
 * Estimates the cost of scoring `jobsToScore`, before any of those calls
 * are made (ticket 16c824a). Prefers `usageStats` — real, measured
 * input/output (and, as of ticket aff284b, cache-read/cache-write) token
 * averages recorded from this project's own prior live runs (see
 * `recordUsageStats`) — over the bootstrap path, which still grounds
 * itself in real numbers (this run's actual prompt text, and the code's
 * own `max_tokens` cap) rather than an arbitrary guess.
 *
 * Cache pricing (ticket aff284b): the MEASURED path prices each token
 * bucket at its own rate — cache reads at `CACHE_READ_PRICE_MULTIPLIER`,
 * cache writes at `CACHE_WRITE_PRICE_MULTIPLIER`, both against
 * `pricePerMillionTokens.in` — rather than blending everything into the
 * flat input price the way this function did before this ticket. The
 * BOOTSTRAP path deliberately does NOT do this: with no recorded history
 * yet, this function has no way to know how many of `jobCount` calls will
 * actually hit a warm cache versus pay the write premium (that depends on
 * run-time ordering — see `runDemoMatch`'s cache pre-warm), so it prices
 * every token at the full input rate, same as before this ticket. That
 * is CONSERVATIVE (an overestimate, never an underestimate) rather than
 * silently wrong — the same reasoning `describeCostEstimate` already
 * documents for `MAX_OUTPUT_TOKENS`'s worst-case assumption below.
 *
 * Cache-CREATION specifically (ticket aff284b review round 2 S2) is not
 * priced off `usageStats` at all on the measured path, even though the
 * other three buckets are: a run writes its cache exactly once regardless
 * of `jobCount` (see `CostEstimate.estimatedCacheCreationTokens`), and
 * averaging a "total tokens written across all historical calls" figure
 * by a "total historical calls" denominator does not recover "tokens
 * written per run" unless every historical run happened to score exactly
 * one job — see the inline comment at this function's `estimatedCacheCreationTokens`
 * assignment below for the arithmetic and the measurement that caught it
 * (a 5x undercount against this ticket's own live stats). Measuring the
 * real prefix directly from `resumeText` sidesteps that per-run-vs-per-call
 * averaging problem entirely instead of trying to track a `runs` counter
 * through `UsageStats`.
 *
 * Cache-READ scaling (ticket aff284b review round 3 F3) now uses the same
 * direct-measurement approach as cache-creation instead of a historical
 * average: `prefixTokens * (jobCount - 1)`, where `prefixTokens` is this
 * run's real prefix (`buildCachedPrefix(resumeText)`, same heuristic
 * estimate as cache-creation — see `CostEstimate.estimatedCacheCreationTokens`
 * on its accuracy) and `jobCount - 1` because the run's first call is the
 * cache WRITE, not a read. This replaced an earlier historical-average
 * approach (`avgCacheReadTokens * jobCount`) that was previously left
 * unfixed on the reasoning that a correct fix would need either a
 * `runs`-per-file counter (a stats-file schema migration) or threading
 * each historical run's own `jobCount` through `recordUsageStats`. Neither
 * turned out to be necessary: once the prefix token count is computed
 * directly (as cache-creation already did as of S2), the same figure times
 * `jobCount - 1` is the whole fix, with no new state. The old approach's
 * error was also previously mis-stated as a flat ~20% undercount; the real
 * picture is two separate errors that happen to partially cancel at one
 * specific ratio: (a) dividing by every historical call (including each
 * run's one non-reading write) understates the per-read figure, while (b)
 * multiplying by the full `jobCount` instead of `jobCount - 1` overstates
 * it — for a single-job run specifically, (b) alone used to produce a
 * nonzero cache-read estimate for a call that can never read anything
 * (there is no second job). See the inline comment on
 * `estimatedCacheReadTokens` below for the current computation.
 */
export function estimateScoringCost(
  jobsToScore: NormalizedJob[],
  resumeText: string,
  usageStats: UsageStats | undefined,
  pricePerMillionTokens: { in: number; out: number } = SONNET_PRICE_PER_MILLION_TOKENS,
): CostEstimate {
  const jobCount = jobsToScore.length;
  const basis: CostEstimate["basis"] =
    usageStats && usageStats.calls > 0 ? "measured" : "bootstrap";

  if (jobCount === 0) {
    return {
      jobCount: 0,
      estimatedInputTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      basis,
    };
  }

  let estimatedInputTokens: number;
  let estimatedCacheReadTokens: number;
  let estimatedCacheCreationTokens: number;
  let estimatedOutputTokens: number;
  let estimatedCostUsd: number;

  if (basis === "measured") {
    const avgInputTokens = usageStats!.totalInputTokens / usageStats!.calls;
    const avgOutputTokens = usageStats!.totalOutputTokens / usageStats!.calls;
    estimatedOutputTokens = Math.round(avgOutputTokens * jobCount);

    // This run's real cached-prefix (preamble + resume, `buildCachedPrefix`)
    // token count, ESTIMATED directly from THIS run's real `resumeText`
    // rather than averaged from history — same character-count heuristic
    // (`CHARS_PER_TOKEN_ESTIMATE`) the bootstrap path below uses for a
    // whole prompt, applied here to just the cached prefix. Not an exact
    // token count — see `CostEstimate.estimatedCacheCreationTokens`'s doc
    // comment (ticket aff284b review round 3 F1/F2) for the measured ~40%
    // undercount against this project's own real resume, and why an exact
    // pre-call count isn't obtainable at all.
    const prefixTokens = Math.round(
      buildCachedPrefix(resumeText).length / CHARS_PER_TOKEN_ESTIMATE,
    );

    if (prefixTokens < CACHE_MIN_PREFIX_TOKENS) {
      // Ticket aff284b review round 3 F4 (refined round 4 R2): prefixTokens
      // is this run's ESTIMATE of the prefix, not a measured count, so this
      // branch can misclassify a prefix that would actually clear the real
      // minimum -- see `buildCachedPrefix`'s doc comment. When it does
      // trigger correctly, though, a prefix this short never actually
      // creates a cache entry at all (`CACHE_MIN_PREFIX_TOKENS`) -- every
      // call sends the FULL
      // prompt (prefix + suffix) at the flat input rate, nothing
      // discounted, nothing written. `avgInputTokens` above is the wrong
      // basis here: it's a per-call average of the UNCACHED REMAINDER from
      // historical calls whose prefix *did* clear the minimum, i.e. it
      // reflects roughly one job-suffix's worth of tokens, not a whole
      // prompt. Using it would silently assume caching that cannot happen
      // for this resume, understating the real cost (reviewer measured
      // ~2x too low — $0.0426 estimated vs. ~$0.088 real — for a 10-job
      // short-resume scenario) in the non-conservative direction this
      // file's cost estimates otherwise avoid. Instead, price every job's
      // real full prompt directly, the same char-count approach the
      // bootstrap path uses below.
      const totalPromptChars = jobsToScore.reduce(
        (sum, job) => sum + buildScoringPrompt(job, resumeText).length,
        0,
      );
      estimatedInputTokens = Math.round(totalPromptChars / CHARS_PER_TOKEN_ESTIMATE);
      estimatedCacheReadTokens = 0;
      estimatedCacheCreationTokens = 0;
      estimatedCostUsd =
        (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
        (estimatedOutputTokens / 1e6) * pricePerMillionTokens.out;
    } else {
      estimatedInputTokens = Math.round(avgInputTokens * jobCount);
      // Cache READS scale per job — every job AFTER the run's first reads
      // the warm cache once (the first call is the cache WRITE, not a
      // read), so `prefixTokens * (jobCount - 1)` is the right projection
      // — NOT `* jobCount`, and NOT the historical `avgCacheReadTokens`
      // this used to be (ticket aff284b review round 3 F3; see this
      // function's own doc comment above for what was wrong with that and
      // why it's fixed here rather than left as a documented imprecision).
      // For `jobCount === 1` this is naturally 0: a single-job run has no
      // second job to ever read the cache (only the write happens) —
      // ticket aff284b review round 3 F4.
      estimatedCacheReadTokens = prefixTokens * (jobCount - 1);
      // Cache CREATION does NOT scale per job (ticket aff284b review S1): a
      // run writes its cache exactly ONCE, regardless of how many jobs get
      // scored (`runDemoMatch`'s first-then-batch pre-warm — score job #1
      // alone, which is the run's one cache WRITE, then every job after it
      // is a cache READ). Computed directly from `prefixTokens` above
      // rather than averaged from history — see
      // `CostEstimate.estimatedCacheCreationTokens`'s doc comment for the
      // S2 fix this followed and the F1/F2 accuracy correction on top of
      // it.
      estimatedCacheCreationTokens = prefixTokens;

      estimatedCostUsd =
        (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
        (estimatedCacheReadTokens / 1e6) * pricePerMillionTokens.in * CACHE_READ_PRICE_MULTIPLIER +
        (estimatedCacheCreationTokens / 1e6) *
          pricePerMillionTokens.in *
          CACHE_WRITE_PRICE_MULTIPLIER +
        (estimatedOutputTokens / 1e6) * pricePerMillionTokens.out;
    }
  } else {
    const totalPromptChars = jobsToScore.reduce(
      (sum, job) => sum + buildScoringPrompt(job, resumeText).length,
      0,
    );
    estimatedInputTokens = Math.round(totalPromptChars / CHARS_PER_TOKEN_ESTIMATE);
    // Bootstrap has no recorded cache history to split from — see this
    // function's own doc comment on why the bootstrap path prices
    // everything at the flat input rate instead of guessing a split.
    estimatedCacheReadTokens = 0;
    estimatedCacheCreationTokens = 0;
    estimatedOutputTokens = MAX_OUTPUT_TOKENS * jobCount;
    estimatedCostUsd =
      (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
      (estimatedOutputTokens / 1e6) * pricePerMillionTokens.out;
  }

  return {
    jobCount,
    estimatedInputTokens,
    estimatedCacheReadTokens,
    estimatedCacheCreationTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    basis,
  };
}

/**
 * Human-readable rendering of a `CostEstimate` (ticket 16c824a review F4).
 * The "bootstrap" basis assumes `MAX_OUTPUT_TOKENS` (2000) of output for
 * EVERY job — that constant's own doc comment says that cap is "rarely
 * actually reached" (the JSON schema is small: a score, a rationale, two
 * short string arrays), so a bootstrap estimate for 129 jobs comes out
 * around $4.93 against a realistic ~$1.83. Rendered as a point estimate,
 * that reads as far more precise — and far more expensive — than it is.
 * The FIRST run against any given `usageStatsPath` is always bootstrap
 * (there is no measured data yet), which means it's also the one run
 * where this number is the user's ONLY guide before deciding whether to
 * proceed — exactly the run where overstating it is worst. So: rendered
 * as an explicit ceiling (`≤$…`), not a point estimate, whenever
 * `basis === "bootstrap"`.
 *
 * Ticket aff284b review R1: the token figure shown here is now the REAL
 * total tokens a call actually sends (`estimatedInputTokens +
 * estimatedCacheReadTokens + estimatedCacheCreationTokens`), broken down
 * by bucket, rather than `estimatedInputTokens` alone — which, post
 * caching, is only the uncached remainder and understated real usage by
 * ~90% on a real 200-job run when shown bare (see `CostEstimate`'s own doc
 * comment for that measurement). `estimatedCostUsd` already priced every
 * bucket correctly before this fix (see `estimateScoringCost`); only this
 * rendering was misleading.
 */
export function describeCostEstimate(estimate: CostEstimate): string {
  const totalInputTokens =
    estimate.estimatedInputTokens +
    estimate.estimatedCacheReadTokens +
    estimate.estimatedCacheCreationTokens;
  const tokens =
    `~${totalInputTokens} in tokens total (${estimate.estimatedInputTokens} uncached + ` +
    `${estimate.estimatedCacheReadTokens} cache-read + ${estimate.estimatedCacheCreationTokens} ` +
    `cache-write) / ~${estimate.estimatedOutputTokens} out tokens`;
  if (estimate.jobCount === 0) {
    return "$0.00 (nothing needs scoring)";
  }
  if (estimate.basis === "bootstrap") {
    return (
      `≤$${estimate.estimatedCostUsd.toFixed(2)} (worst case — no measured usage yet, assumes every ` +
      `call uses its full ${MAX_OUTPUT_TOKENS}-token output budget; the realistic cost is typically ` +
      `well under this, ${tokens})`
    );
  }
  return `~$${estimate.estimatedCostUsd.toFixed(2)} (${tokens}, based on measured usage from prior runs)`;
}

export type RankedResult = {
  jobId: string;
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  locationType: string | null;
  applyUrl: string;
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
};

export type RunDemoMatchOptions = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /**
   * Every source this run should search — Greenhouse, Lever, Ashby,
   * SmartRecruiters, or any combination (ticket d8417b2 wired all four in;
   * before that, this was a single `source: JobSource` and only Greenhouse
   * was ever passed). Fanned out via `CompositeSource`
   * (sources/composite.ts), which isolates one source's total failure from
   * the others — see that file's top-of-file comment for why it does NOT
   * itself pretend to be a single `JobSource`. Must be non-empty; an empty
   * array throws rather than silently searching nothing.
   */
  sources: JobSource[];
  resumeText: string;
  scoreJob: ScoreJobFn;
  /**
   * Defaults to `{}` (no criteria). Deliberately NOT `{ location:
   * "Washington" }`: `GreenhouseSource` (and any other client-side-filtered
   * source) substring-matches `criteria.location` against the board's raw
   * location string, which would reject "Remote - US" / "Seattle, WA" /
   * "Bellevue" — precisely the postings `filter` below exists to keep.
   * Location narrowing belongs in `filter`, not in `criteria`, for any
   * source whose adapter does that kind of substring match.
   */
  criteria?: SearchCriteria;
  /**
   * Applied to everything every source returned (the union, across all
   * configured sources). Defaults to the identity function (no filtering)
   * — callers that want title/location/dedupe narrowing (see `main()`
   * below for the real one) pass it explicitly. Every survivor gets
   * ingested — ticket 16c824a removed the `maxJobs` truncation that used
   * to slice this down in source/board iteration order before any of it
   * reached the database. What gets SCORED (as opposed to merely ingested)
   * is a separate, later decision — see `scoreThreshold`/`allowAboveThreshold`.
   */
  filter?: (jobs: NormalizedJob[]) => NormalizedJob[];
  /**
   * Spend guard (ticket 16c824a). Above this many jobs actually NEEDING a
   * new score this run (already-scored jobs are free — ticket 620ca30),
   * scoring stops here unless `allowAboveThreshold` is set — see
   * `DEFAULT_SCORE_THRESHOLD`'s doc comment for the pool-size assumption
   * and for exactly what this does and does not truncate (it bounds
   * SCORING/spend, not ingestion, and a plain rerun drains it for free).
   * Defaults to `DEFAULT_SCORE_THRESHOLD`.
   */
  scoreThreshold?: number;
  /**
   * Explicit opt-in to score MORE than `scoreThreshold` jobs in one run.
   * Defaults to `false` — a pool above the threshold gets capped, not
   * silently scored in full, unless a caller deliberately sets this (or,
   * in `main()`, sets `ALLOW_SCORE_ABOVE_THRESHOLD=true`).
   */
  allowAboveThreshold?: boolean;
  /**
   * Where real per-call token usage accumulates across runs (see
   * `recordUsageStats`), read back by `estimateScoringCost` so the
   * pre-scoring cost estimate is grounded in this project's own measured
   * history rather than a one-off guess. Defaults to
   * `"prep/scoring-usage-stats.json"` — deliberately a different file from
   * `outputPath` (`prep/match-results.json`), which holds ranked results a
   * user may have already applied from and must never be touched by this.
   */
  usageStatsPath?: string;
  outputPath?: string;
  log?: (message: string) => void;
  /**
   * Overrides the randomly generated `searches.id` this run creates.
   * Ticket 59fdc52: the REST API's async "run a search" route needs to hand
   * the client a pollable id *before* this (multi-minute, billed) call
   * resolves — it generates the id, starts tracking it, kicks this off
   * without awaiting, and needs that same id to end up on the `searches`
   * row so a later `GET /searches/:id` can find it in the database even if
   * the API process restarts before the run finishes (see that route's doc
   * comment). Defaults to a fresh `randomUUID()` when omitted, exactly as
   * before this ticket.
   */
  searchId?: string;
  /**
   * Ticket 59fdc52: fetches and ingests real postings, computes the
   * pre-scoring cost estimate, and returns — WITHOUT calling `scoreJob` for
   * any of them. This is what backs the REST API's `POST /searches/estimate`
   * (decision: "a search must be able to report its cost before spending").
   * Fetching and ingestion are free (no Claude calls), so an estimate run
   * still grows the durable job corpus exactly like a real run does; a
   * follow-up real run against the same resume/sources re-fetches (cheap,
   * idempotent — `ingestJobsForSearch` upserts) and scores only what
   * `estimateOnly` deliberately left unscored. Defaults to `false`.
   */
  estimateOnly?: boolean;
};

/**
 * One configured token's outcome, extended with how many of its postings
 * survived `filter` — the third distinction ticket b723fb9 asks for, that
 * `TokenOutcome` alone (source-level) can't make: a board can be "ok"
 * (real, has postings) and still contribute zero jobs to the funnel
 * because none matched the title/location filter. `status`/`postingCount`
 * describe the source; `survivedFilter` describes what THIS run's `filter`
 * did with them. A user staring at an empty result can read this list and
 * tell "your board token is wrong" apart from "that employer isn't
 * hiring right now" apart from "they're hiring, just not for this" —
 * three different problems that otherwise all look like silence.
 */
export type BoardCoverageEntry = TokenOutcome & { survivedFilter: number };

export type RunDemoMatchResult = {
  resumeId: string;
  searchId: string;
  /** How many of the ingested candidate jobs already had a score for this
   * resume and so were NOT sent to Claude. */
  skipped: number;
  /** How many jobs were actually scored (Claude calls made AND
   * successfully persisted) this run. */
  newlyScored: number;
  /**
   * Jobs Claude was asked to score but whose call rejected (e.g. a
   * transient overload). Distinct from `skipped` — a failed job was
   * neither skipped nor scored, so the next run will retry it, not treat
   * it as done.
   */
  failed: number;
  results: RankedResult[];
  /**
   * One entry per configured source (ticket d8417b2) — Greenhouse, Lever,
   * Ashby, SmartRecruiters, whichever were passed as `sources`. Replaces
   * what used to be a single `boardCoverage: BoardCoverageEntry[]` from
   * back when `runDemoMatch` only ever took one `source`. See
   * `SourceOutcome`.
   */
  sourceOutcomes: SourceOutcome[];
  /**
   * How many jobs needed a NEW score this run (ingested candidates minus
   * `skipped`), before the spend-guard cap was applied. `newlyScored +
   * failed + cappedCount === candidatesNeedingScore` (ticket 16c824a).
   */
  candidatesNeedingScore: number;
  /**
   * How many of `candidatesNeedingScore` were NOT scored this run because
   * `scoreThreshold` applied and `allowAboveThreshold` wasn't set. Always 0
   * when the pool was at/under the threshold, or the override was active.
   * A nonzero value here means this run's `results` is a truncated view of
   * what's scoreable, not the whole pool — callers must not present it as
   * complete without surfacing this number.
   */
  cappedCount: number;
  /**
   * The `scoreThreshold` actually in effect this run (the caller's override
   * or `DEFAULT_SCORE_THRESHOLD`). Ticket 59fdc52 review round 2: the REST
   * API's cost-estimate response was reporting the cost of scoring the
   * WHOLE pool while a real run caps spend at this number — carrying the
   * threshold itself is what lets a caller understand why `costEstimate`
   * and `candidatesNeedingScore` disagree.
   */
  scoreThreshold: number;
  /**
   * The pre-scoring cost estimate for whatever was actually ATTEMPTED this
   * run — i.e. after `scoreThreshold` capping, exactly like a real run's
   * spend (see `estimateScoringCost`). `estimateOnly` computes this the
   * same cap-aware way rather than pricing the full uncapped pool: pricing
   * the uncapped pool overstated cost by ~30x against what a real run
   * (which caps at `scoreThreshold`) would actually bill (ticket 59fdc52
   * review round 2).
   */
  costEstimate: CostEstimate;
};

/**
 * One-line-per-source funnel status, computed once per `runDemoMatch` call
 * from `CompositeSource`'s `PerSourceOutcome[]` (sources/composite.ts) plus
 * this run's post-`filter` survivors. Deliberately mirrors `TokenStatus`'s
 * vocabulary (`TokenOutcome`, ticket b723fb9) one level up rather than
 * inventing a parallel shape: `TokenOutcome` already solved "tell a bad
 * employer TOKEN apart from a quiet employer apart from a filtered-out
 * employer" *within* one source; this is the identical three-way
 * distinction for a whole SOURCE within a search that now spans several —
 * "Lever wasn't asked" (Lever simply isn't in `sources`, so it has no entry
 * here at all — nothing to average away), "Lever returned nothing"
 * (`status: "empty"`), and "Lever returned postings, none survived
 * filtering" (`status: "ok"`, `survivedFilter: 0`) are three different,
 * user-visible problems that a single skipRate merged across all four
 * sources would collapse into one indistinguishable number. See ticket
 * d8417b2.
 */
export type SourceOutcome = {
  dataSource: Job["dataSource"];
  /**
   * "error": this source's own `search()` call rejected outright —
   * `CompositeSource` isolated it so it couldn't take the other configured
   * sources down with it (see composite.ts's `PerSourceOutcome`). "empty":
   * `search()` succeeded and returned zero raw postings. "ok": `search()`
   * succeeded and returned at least one raw posting — independent of
   * whether any of them survived `filter`; see `survivedFilter` for that.
   */
  status: "ok" | "empty" | "error";
  /** Raw postings this source returned, before `filter`. Always 0 for
   * "error" — nothing was fetched. */
  jobsFound: number;
  /** This source's own record-level skip count — never summed across
   * sources. */
  skippedCount: number;
  /** This source's OWN `skipRate` (see `SourceSearchResult.skipRate`),
   * never averaged against any other source's. Always 0 for "error". */
  skipRate: number;
  /**
   * How many of THIS source's raw postings survived `filter` this run.
   * Computed by an exact `dataSource` match
   * against `filtered` — unlike `BoardCoverageEntry.survivedFilter`'s
   * company-NAME correlation (free text, a documented latent hazard — see
   * that field's WARNING), `NormalizedJob.dataSource` is a closed enum the
   * adapter itself stamps, so this number carries none of that
   * misattribution risk.
   */
  survivedFilter: number;
  /** Present only when `status === "error"`. */
  errorMessage: string | undefined;
  /**
   * This source's own per-token/per-employer breakdown, when it populates
   * `tokenOutcomes` (Greenhouse does, as of ticket b723fb9; Lever, Ashby,
   * and SmartRecruiters do not yet — see this ticket's report). Empty for
   * "error" (nothing was fetched to break down) and for any source that
   * doesn't populate `tokenOutcomes` at all.
   */
  boardCoverage: BoardCoverageEntry[];
};

/**
 * True when every scoring call this run attempted failed and nothing new
 * got scored — as opposed to a healthy run that simply found nothing to
 * score (0 failed, 0 newlyScored, e.g. everything was already scored) or
 * a partial failure (some succeeded). `main()` uses this to decide
 * whether to exit non-zero: since `runDemoMatch` uses `Promise.allSettled`
 * (not `Promise.all`) to score a batch, a total failure — e.g. Anthropic
 * 529ing on every job — no longer throws, and without this check would be
 * observationally identical, at the process exit code, to a successful
 * search that found nothing (ticket 620ca30 review finding B3). Extracted
 * as a pure function so this decision has a direct unit test instead of
 * only being exercised by reading `main()`.
 */
export function isTotalScoringFailure(
  result: Pick<RunDemoMatchResult, "failed" | "newlyScored">,
): boolean {
  return result.failed > 0 && result.newlyScored === 0;
}

/**
 * Extends each raw `TokenOutcome` (source-level: does the token resolve,
 * does the board have postings) with `survivedFilter` — how many of
 * `filtered` (this run's `filter` applied to everything the source
 * returned) came from that token's employer.
 * Matched by `NormalizedJob.company` against `TokenOutcome.companyName`
 * (case-insensitively) rather than by tagging every job with its token,
 * which would mean widening `NormalizedJob` for a concern specific to this
 * reporting. Returns `[]` when the source didn't populate `tokenOutcomes`
 * at all (ticket b723fb9's board-coverage reporting is opt-in per source,
 * not a requirement every `JobSource` implementation must satisfy).
 *
 * WARNING (ticket b723fb9 review finding #1): this correlation is by
 * NAME, not by token, and `TokenOutcome.companyName` is free text an
 * employer typed into a form field — see the WARNING on that field for
 * the concrete hazards (two tokens self-reporting the same name double-
 * counts survivors onto both; a name that differs from the survivors'
 * `company` under-counts to zero while the board is actually healthy).
 * None of that fires against the 25 tokens configured today, but it is
 * real and latent, not hypothetical — `fivetran`'s real API response
 * self-reports `"Fivetran "` with a trailing space today; only `.trim()`
 * keeps that one matching.
 *
 * Rather than pretend the correlation is exact, this function runs two
 * cheap sanity checks over its own output and calls `warn` when either
 * fires, instead of silently returning numbers that may misattribute
 * survivors between boards:
 *
 *   1. `sum(survivedFilter)` across every returned entry should equal
 *      `filtered.length` — every survivor should be attributed to exactly
 *      one token. A mismatch PROVES some misattribution happened
 *      (over-counted somewhere, under-counted somewhere, or both), but a
 *      MATCHING sum does not prove there was none: errors can cancel. Two
 *      tokens sharing a name can double-count 2 survivors up to 4 while a
 *      third, nameless token under-counts its own 2 down to 0 — sum stays
 *      right (4) while every individual number is wrong. That's what
 *      check 2 is for.
 *   2. Two or more entries reporting the identical `companyName`
 *      (case-insensitively) are flagged directly — this is exactly the
 *      double-counting hazard, caught independent of whether the sum
 *      happens to net out.
 *
 * Neither check proves the report is correct; both together catch every
 * hazard this function's own review turned up. A board that's actually
 * healthy must never silently read as "0 survived filtering" (that reads
 * as dead and is exactly what gets a productive token deleted) without at
 * least a `warn` alongside it.
 */
export function buildBoardCoverage(
  tokenOutcomes: TokenOutcome[] | undefined,
  filtered: NormalizedJob[],
  warn: (message: string) => void = (message) => console.warn(message),
): BoardCoverageEntry[] {
  if (!tokenOutcomes || tokenOutcomes.length === 0) return [];

  const survivedByCompany = new Map<string, number>();
  for (const job of filtered) {
    const key = job.company.trim().toLowerCase();
    survivedByCompany.set(key, (survivedByCompany.get(key) ?? 0) + 1);
  }

  const coverage = tokenOutcomes.map((outcome) => ({
    ...outcome,
    survivedFilter: outcome.companyName
      ? (survivedByCompany.get(outcome.companyName.trim().toLowerCase()) ?? 0)
      : 0,
  }));

  const attributedTotal = coverage.reduce((sum, entry) => sum + entry.survivedFilter, 0);
  if (attributedTotal !== filtered.length) {
    warn(
      `buildBoardCoverage: per-token survivedFilter counts sum to ${attributedTotal}, but ` +
        `${filtered.length} job(s) actually survived filtering this run. TokenOutcome.companyName ` +
        `is free text, not a stable key (two tokens can self-report the same name, or a name can ` +
        `differ from what actually survived) — the board-coverage numbers below may misattribute ` +
        `survivors between tokens. Do not conclude a token contributed nothing from this report alone.`,
    );
  }

  const namesSeen = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const entry of coverage) {
    if (!entry.companyName) continue;
    const key = entry.companyName.trim().toLowerCase();
    if (namesSeen.has(key)) duplicateNames.add(key);
    namesSeen.add(key);
  }
  if (duplicateNames.size > 0) {
    warn(
      `buildBoardCoverage: multiple tokens self-report the same company name ` +
        `(${[...duplicateNames].join(", ")}) — each such token's survivedFilter counts every ` +
        `survivor attributed to that name, so they are almost certainly double-counted between ` +
        `those tokens specifically, regardless of whether the totals above happened to match.`,
    );
  }

  return coverage;
}

/**
 * The one-line-per-board summary ticket b723fb9 exists to make possible:
 * outcomes that used to all look like "nothing from this employer" now
 * read as distinct, specific problems.
 */
export function describeBoardOutcome(entry: BoardCoverageEntry): string {
  switch (entry.status) {
    case "not-found":
      return "board does not exist (404) — check the token";
    case "empty":
      return "board exists, 0 postings right now";
    case "error":
      // `entry.message` already says what happened — a fetch failure
      // ("Greenhouse request for board ... timed out...", "... HTTP
      // 503..."), a rate limit ("Greenhouse rate limit exceeded (HTTP
      // 429)..."), or, for a token search() never got to after a 429,
      // "not checked — search() stopped issuing requests after board ...
      // was rate-limited". All three are potentially resolved by a later
      // run, hence the shared "rerun to retry" — this is NOT "not-found":
      // the board may be perfectly healthy, this run just couldn't
      // confirm that.
      return `${entry.message ?? "fetch failed (unknown error)"} — rerun to retry`;
    case "ok":
      return `${entry.postingCount} posting(s), ${entry.survivedFilter} survived filtering`;
  }
}

/**
 * Builds one `SourceOutcome` per entry in `perSource` (see that type's doc
 * comment). `filtered` is the SAME post-`filter` array
 * `buildBoardCoverage` already receives — bucketed here by exact
 * `dataSource` before being handed to `buildBoardCoverage` per source, so a
 * token from one source can never be credited with another source's
 * survivors even if their `TokenOutcome.companyName`s happen to collide
 * (e.g. two different sources both hosting a board that self-reports
 * "Acme") — `buildBoardCoverage`'s own name-correlation hazard (see its doc
 * comment) is scoped per-source here, not left free to cross source
 * boundaries too.
 */
export function buildSourceOutcomes(
  perSource: PerSourceOutcome[],
  filtered: NormalizedJob[],
  warn: (message: string) => void = (message) => console.warn(message),
): SourceOutcome[] {
  return perSource.map((outcome): SourceOutcome => {
    if (outcome.status === "error") {
      return {
        dataSource: outcome.dataSource,
        status: "error",
        jobsFound: 0,
        skippedCount: 0,
        skipRate: 0,
        survivedFilter: 0,
        errorMessage: outcome.errorMessage,
        boardCoverage: [],
      };
    }

    const { result } = outcome;
    const filteredForSource = filtered.filter((j) => j.dataSource === outcome.dataSource);

    return {
      dataSource: outcome.dataSource,
      status: result.jobs.length === 0 ? "empty" : "ok",
      jobsFound: result.jobs.length,
      skippedCount: result.skipped.length,
      skipRate: result.skipRate,
      survivedFilter: filteredForSource.length,
      errorMessage: undefined,
      boardCoverage: buildBoardCoverage(result.tokenOutcomes, filteredForSource, warn),
    };
  });
}

/**
 * The one-line-per-source summary parallel to `describeBoardOutcome` — see
 * `SourceOutcome`'s doc comment for why the vocabulary mirrors
 * `TokenStatus` one level up.
 */
export function describeSourceOutcome(entry: SourceOutcome): string {
  switch (entry.status) {
    case "error":
      return `${entry.errorMessage ?? "search failed (unknown error)"} — rerun to retry`;
    case "empty":
      return "0 postings returned this run";
    case "ok":
      return (
        `${entry.jobsFound} posting(s), ${entry.skippedCount} skipped ` +
        `(skipRate ${entry.skipRate.toFixed(2)}), ${entry.survivedFilter} survived filtering`
      );
  }
}

/**
 * Deterministic content hash used as the resumes upsert key. Two identical
 * resumes hash identically regardless of process/timing, which is what
 * makes `INSERT ... ON CONFLICT (resume_hash) DO NOTHING` a correct,
 * race-safe find-or-create — unlike a plain select-then-insert, this is
 * safe even if two `runDemoMatch` calls for the same resume text overlap.
 */
function hashResumeText(resumeText: string): string {
  return createHash("sha256").update(resumeText, "utf8").digest("hex");
}

/**
 * Finds-or-creates the `resumes` row for this exact resume text, keyed on
 * `resume_hash` (a UNIQUE column — see db/schema.ts), not `resume_text`
 * directly: Postgres btree index rows are capped around 2704 bytes and a
 * real resume can exceed that, so `UNIQUE(resume_text)` would fail at
 * insert time for a long resume. Hashing first sidesteps that and doubles
 * as the concurrency fix: the upsert always attempts the insert (cheap —
 * one row, no Claude call involved), lets `ON CONFLICT DO NOTHING` resolve
 * a race for free, and then selects by the same hash. Two concurrent
 * callers for the same resume text are guaranteed to agree on exactly one
 * winning row afterward — no duplicate `resumes` rows, and no
 * `ORDER BY`-dependent ambiguity about which one "the" row is.
 */
/**
 * Exported (ticket 59fdc52) so the REST API's `POST /resumes` can find-or-
 * create a resume row directly — resumes are content-addressed by
 * `resumeHash` (ticket 620ca30), and this is the one place that hashing +
 * upsert logic lives. Reusing it here, rather than reimplementing the same
 * hash-then-upsert dance in a route handler, is exactly the "reuse
 * runDemoMatch's persistence, don't reimplement it" instruction: a resume
 * paste alone doesn't need a full `runDemoMatch` run (which also fetches
 * and would ingest jobs) — it only needs this one step.
 */
export async function getOrCreateResumeId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeText: string,
): Promise<string> {
  const resumeHash = hashResumeText(resumeText);

  await db
    .insert(resumes)
    .values({ id: randomUUID(), resumeText, resumeHash })
    .onConflictDoNothing({ target: resumes.resumeHash });

  const rows = await db
    .select({ id: resumes.id })
    .from(resumes)
    .where(eq(resumes.resumeHash, resumeHash))
    .limit(1);
  if (rows.length === 0) {
    // Should be impossible: the insert above either created this row or
    // no-opped because a row with this hash already existed.
    throw new Error(
      `getOrCreateResumeId: no resumes row found for hash "${resumeHash}" after upsert`,
    );
  }
  return rows[0]!.id;
}

/**
 * Marks `searches.status = 'complete'` for `searchId`. Called right before
 * EVERY successful return point in `runDemoMatch` (the empty-pool early
 * return, the `estimateOnly` early return, and the normal end) — ticket
 * 59fdc52 review round 2: without this, `GET /searches/:id`'s DB-fallback
 * branch (used once an API process's in-memory tracker has lost this run —
 * e.g. after a restart) could not tell "this run finished" apart from
 * "this run's process died after scoring 3 of 200"; both left an identical
 * `searches` row behind. If `runDemoMatch` itself throws before reaching
 * one of these call sites, the row is simply never updated and stays at
 * its `'running'` default — the honest signal, not a guess. (A caller that
 * catches the rejection, e.g. the REST API's `POST /searches` route, is
 * responsible for marking `'failed'` itself — see that route.)
 */
async function markSearchComplete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  searchId: string,
): Promise<void> {
  await db.update(searches).set({ status: "complete" }).where(eq(searches.id, searchId));
}

/**
 * The DB-backed ranked-results query shared by a normal run's tail (every
 * `linkedJobId`, some newly scored this run) and `estimateOnly`'s early
 * return (only `alreadyScoredIds` — nothing new was scored). Extracted
 * (ticket 59fdc52) so both paths honor the same "results come from the
 * database, not in-memory state" invariant with one implementation, not two
 * that could drift. Returns `[]` without querying when `jobIds` is empty —
 * an empty `inArray(...)` is a Drizzle/Postgres edge case worth avoiding
 * explicitly rather than relying on it happening to behave.
 */
/**
 * Job ids among `jobIds` the user has already APPLIED to (ticket 0c319b2).
 * Read-only; this function never writes a status row — recording an
 * application is a user action, not something a scoring run infers.
 *
 * Keyed on `job_id` alone, with no `resume_id` in the query at ALL. That is
 * deliberate and is the whole reason `user_job_statuses` is keyed the way it
 * is (see its comment in db/schema.ts): this lookup happens during a search
 * run, which is scoped to ONE resume — and the resume in hand today is
 * routinely not the resume an application was sent with. Filtering by resume
 * here would make "have I applied to X?" answer "no" the moment the user
 * rewrites her resume, which is exactly the bug the table's key exists to
 * prevent.
 *
 * Only `applied` is excluded, not `dismissed`/`saved`/`resume_optimized` —
 * acting on those is a UI concern and explicitly out of this ticket's scope.
 */
export async function fetchAppliedJobIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  jobIds: string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const rows = await db
    .select({ jobId: userJobStatuses.jobId })
    .from(userJobStatuses)
    .where(and(eq(userJobStatuses.status, "applied"), inArray(userJobStatuses.jobId, jobIds)));
  return new Set(rows.map((r) => r.jobId));
}

async function fetchRankedResults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
  jobIds: string[],
): Promise<RankedResult[]> {
  if (jobIds.length === 0) return [];

  // Ticket 0c319b2. Applied here — on the ranked list every caller renders,
  // shared by the normal run's tail and `estimateOnly`'s early return — and
  // NOT on `candidates`/`needsScoreIds` above (computed earlier in
  // `runDemoMatch`, keyed only on `jobMatches.resumeId`, with no
  // applied-status check). That is a real, accepted tradeoff, not a free
  // lunch: an applied job usually already has a `job_matches` row for the
  // resume that applied to it, but not for every resume — rewrite the
  // resume to a new version and re-search while the job is still open, and
  // it has no row under the new `resumeId`, so it lands in `needsScoreIds`
  // and consumes one real Claude call even though it's already applied to
  // (see `user-job-statuses.test.ts`'s v2MatchForX case, which exercises
  // exactly this). Filtering it out of `needsScoreIds` instead would close
  // that gap, but this ticket's scope is deliberately a small, additive
  // presentation filter — it doesn't thread applied-status into the
  // scoring-decision path, which stays resume-version-agnostic and is
  // shared with ticket aff284b's scoring-loop work. Ingestion and scoring
  // stay complete either way, so the row and its score remain in the
  // database for a future "jobs I applied to" view. This is presentation
  // filtering, not corpus filtering — accept the occasional extra scoring
  // call as the cost of keeping it that way.
  const appliedJobIds = await fetchAppliedJobIds(db, jobIds);

  const rows = await db
    .select({
      jobId: jobsTable.id,
      externalId: jobsTable.externalId,
      title: jobsTable.title,
      company: jobsTable.company,
      location: jobsTable.location,
      locationType: jobsTable.locationType,
      applyUrl: jobsTable.linkToApply,
      matchScore: jobMatches.matchScore,
      rationale: jobMatches.rationale,
      strengths: jobMatches.strengths,
      gaps: jobMatches.gaps,
    })
    .from(jobMatches)
    .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, jobIds)));

  const results: RankedResult[] = rows
    .filter((r) => !appliedJobIds.has(r.jobId))
    .map((r) => ({
      ...r,
      strengths: r.strengths ?? [],
      gaps: r.gaps ?? [],
    }));
  results.sort((a, b) => b.matchScore - a.matchScore);
  return results;
}

export async function runDemoMatch(options: RunDemoMatchOptions): Promise<RunDemoMatchResult> {
  const {
    db,
    sources,
    resumeText,
    scoreJob,
    criteria = {},
    filter = (jobs: NormalizedJob[]) => jobs,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
    allowAboveThreshold = false,
    usageStatsPath = "prep/scoring-usage-stats.json",
    outputPath = "prep/match-results.json",
    log = console.log,
    searchId: providedSearchId,
    estimateOnly = false,
  } = options;

  if (sources.length === 0) {
    throw new Error("runDemoMatch: `sources` must contain at least one JobSource.");
  }

  // Idempotent and cheap (3 rows, ON CONFLICT DO NOTHING) — see
  // db/seed.ts. Ensures the FK from jobs.data_source to
  // source_descriptors doesn't reject the very first insert on a fresh
  // database.
  await seedSourceDescriptors(db);

  const resumeId = await getOrCreateResumeId(db, resumeText);

  // Ticket 59fdc52 review round 3, N2: the `searches` row (and its
  // `search_sources` links) used to be inserted AFTER fetch+filter below —
  // both of which run arbitrary code (`CompositeSource#search`, and a
  // caller-supplied `filter`) that can reject. If either did, this
  // function's promise rejected before a `searches` row ever existed, so
  // the REST API's `POST /searches` catch handler's `markSearchFailed`
  // (routes/searches.ts) — an `UPDATE searches SET status = 'failed' WHERE
  // id = searchId` — silently matched ZERO rows, and `searchId` (already
  // handed to the client in the 202 response) would 404 forever on a later
  // `GET /searches/:id`, even after a restart, rather than surfacing as
  // "failed". Both `searchId` and `sources` are already known at this
  // point — nothing below needs fetch or filter to have run first — so the
  // row (and its per-source links) are created here instead, before either
  // of those can throw.
  const searchId = providedSearchId ?? randomUUID();
  await db.insert(searches).values({ id: searchId, resumeId, searchedAt: new Date() });
  // One row per CONFIGURED source, not per source that actually returned
  // jobs this run — this records what the search covered; success/failure
  // per source lives in `sourceOutcomes`, not here. `search_sources` has
  // always allowed multiple rows per search (no uniqueness constraint
  // beyond its own id — see db/schema.ts); this is the first ticket that
  // actually inserts more than one.
  await db
    .insert(searchSources)
    .values(sources.map((s) => ({ id: randomUUID(), searchId, sourceDescriptorId: s.dataSource })));

  log(
    `Fetching real postings from ${sources.length} source(s): ` +
      `${sources.map((s) => s.dataSource).join(", ")}...`,
  );
  // CompositeSource isolates one source's total failure from the others —
  // see sources/composite.ts. It deliberately returns one PerSourceOutcome
  // per source rather than one merged SourceSearchResult, for the same
  // reason TokenOutcome (ticket b723fb9) exists one level down: an
  // aggregate number across sources of very different sizes hides exactly
  // which one is unhealthy.
  const perSource = await new CompositeSource(sources).search(criteria);

  const found: NormalizedJob[] = [];
  for (const outcome of perSource) {
    if (outcome.status === "ok") {
      found.push(...outcome.result.jobs);
      log(
        `  ${outcome.dataSource}: ${outcome.result.jobs.length} jobs, ` +
          `${outcome.result.skipped.length} skipped (skipRate ${outcome.result.skipRate.toFixed(2)})`,
      );
    } else {
      log(`  ${outcome.dataSource}: FAILED — ${outcome.errorMessage} (other sources unaffected)`);
    }
  }
  log("");

  // NOTE (adversarial review): `filter` now runs over the UNION of every
  // configured source's jobs, not one source's alone. For
  // `filterSoftwareEngineeringJobs` specifically, that means its
  // `${company}|${title}` dedupe (swe-filter.ts) now also collapses an
  // identical (company, title) pair posted to TWO different sources into
  // one survivor — previously impossible with a single source. Likely
  // desirable (the same real opening shouldn't count twice because an
  // employer cross-posts to Greenhouse and Lever), but it's an emergent
  // consequence of merging before filtering, not something this ticket set
  // out to build, and swe-filter.ts itself is unchanged.
  const filtered = filter(found);

  // Ticket 16c824a: no `maxJobs`-style truncation here. Every survivor gets
  // ingested and is a scoring CANDIDATE — the old bug was slicing this list
  // to 12 in source/board iteration order before any of it reached the
  // database, so employers late in the token list (Coinbase, Databricks,
  // ...) were never even ingested, let alone scored. The spend guard below
  // (`scoreThreshold`/`allowAboveThreshold`) gates which candidates get
  // SCORED, not which ones get persisted.
  const candidates = filtered;

  const sourceOutcomes = buildSourceOutcomes(perSource, filtered, (message) =>
    log(`  WARNING: ${message}`),
  );
  log("  Source coverage:");
  for (const so of sourceOutcomes) {
    log(`    ${so.dataSource}: ${describeSourceOutcome(so)}`);
    for (const b of so.boardCoverage) {
      log(`      ${b.token}: ${describeBoardOutcome(b)}`);
    }
  }
  log("");

  // Group the candidates by each job's OWN `dataSource` — there is no
  // longer one single top-level "the" source to ingest under.
  // `ingestJobsForSearch` upserts on (data_source, external_id) and, per
  // its own doc comment, assumes every job in one call shares the
  // `dataSource` argument passed in; a batch spanning multiple real
  // sources under one label would upsert fine (each NormalizedJob carries
  // its own correct dataSource) but then fail its own post-insert lookup
  // for every job whose real dataSource differs from that one label — see
  // composite.ts's top-of-file comment for the full reasoning. Calling it
  // once per real dataSource sidesteps that entirely.
  //
  // NOTE (adversarial review): this also changes what `ingestJobsForSearch`'s
  // own transaction covers. Its doc comment argues for atomicity ("either
  // every job in this batch ends up inserted and linked, or none of it is")
  // — that guarantee now holds PER SOURCE, not per run: if the Lever call
  // below throws after the Greenhouse call already committed, Greenhouse's
  // jobs stay committed and linked while Lever's are rolled back, not both
  // rolled back together. That's the same one-source-can't-take-down-the-
  // others isolation this ticket applies everywhere else (CompositeSource,
  // SourceOutcome), just worth naming explicitly here since it's a real
  // narrowing of what "atomic" meant before multiple sources existed.
  const candidatesByDataSource = new Map<string, NormalizedJob[]>();
  for (const job of candidates) {
    const list = candidatesByDataSource.get(job.dataSource);
    if (list) list.push(job);
    else candidatesByDataSource.set(job.dataSource, [job]);
  }

  const linkedJobIds: string[] = [];
  for (const [dataSource, jobsForSource] of candidatesByDataSource) {
    const { linkedJobIds: linked } = await ingestJobsForSearch(
      db,
      searchId,
      dataSource,
      jobsForSource,
    );
    linkedJobIds.push(...linked);
  }

  if (linkedJobIds.length === 0) {
    log("No jobs found.");
    fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
    await markSearchComplete(db, searchId);
    return {
      resumeId,
      searchId,
      skipped: 0,
      newlyScored: 0,
      failed: 0,
      results: [],
      sourceOutcomes,
      candidatesNeedingScore: 0,
      cappedCount: 0,
      scoreThreshold,
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        basis: "bootstrap",
      },
    };
  }

  // Map linked job ids back to the NormalizedJob payload a scorer needs
  // (title/description/etc — not stored on job_matches). Looked up by
  // (dataSource, externalId) TOGETHER — see the two-level map built below.
  const dbRows = await db
    .select({
      id: jobsTable.id,
      externalId: jobsTable.externalId,
      dataSource: jobsTable.dataSource,
    })
    .from(jobsTable)
    .where(
      and(
        inArray(jobsTable.dataSource, [...candidatesByDataSource.keys()]),
        inArray(
          jobsTable.externalId,
          candidates.map((j) => j.externalId),
        ),
      ),
    );
  // A two-level lookup (dataSource -> externalId -> job), not a single
  // joined-string key: with multiple sources in play, two different
  // sources can plausibly reuse the same externalId format (e.g. both hand
  // out small sequential numeric ids), and looking up by externalId alone
  // would silently collide two unrelated jobs from different sources onto
  // the same NormalizedJob.
  const jobByDataSourceAndExternalId = new Map<string, Map<string, NormalizedJob>>();
  for (const j of candidates) {
    let byExternalId = jobByDataSourceAndExternalId.get(j.dataSource);
    if (!byExternalId) {
      byExternalId = new Map();
      jobByDataSourceAndExternalId.set(j.dataSource, byExternalId);
    }
    byExternalId.set(j.externalId, j);
  }
  const normalizedJobById = new Map<string, NormalizedJob>();
  for (const row of dbRows) {
    const nj = jobByDataSourceAndExternalId.get(row.dataSource)?.get(row.externalId);
    if (nj) normalizedJobById.set(row.id, nj);
  }

  // Score only what has no score yet for this resume. This is the whole
  // point of ticket 620ca30: a second run against the same candidates must
  // make zero Claude calls.
  const alreadyScoredRows = await db
    .select({ jobId: jobMatches.jobId })
    .from(jobMatches)
    .where(and(eq(jobMatches.resumeId, resumeId), inArray(jobMatches.jobId, linkedJobIds)));
  const alreadyScoredIds = new Set(alreadyScoredRows.map((r) => r.jobId));
  const needsScoreIds = linkedJobIds.filter((id) => !alreadyScoredIds.has(id));
  const needsScoreJobs = needsScoreIds
    .map((id) => normalizedJobById.get(id))
    .filter((nj): nj is NormalizedJob => nj !== undefined);

  // Spend guard (ticket 16c824a). Estimated BEFORE any scoring call is
  // made, over every job that needs a new score — not the whole survivor
  // pool, since already-scored jobs cost nothing to reconfirm (ticket
  // 620ca30).
  const usageStats = readUsageStats(usageStatsPath);
  const preCapEstimate = estimateScoringCost(needsScoreJobs, resumeText, usageStats);
  log(
    `${filtered.length} survivor(s) after filtering; ${needsScoreIds.length} need scoring ` +
      `(${alreadyScoredIds.size} already scored — skipped, saving that many Claude calls).`,
  );
  log(
    `Estimated cost to score all ${needsScoreIds.length}: ${describeCostEstimate(preCapEstimate)}.`,
  );

  // Above `scoreThreshold`, cap SCORING (not ingestion) here unless the
  // caller explicitly opted in — see `DEFAULT_SCORE_THRESHOLD`'s doc
  // comment for precisely what this does and does not truncate, and why a
  // plain rerun drains a bound cap for free. Computed BEFORE the
  // `estimateOnly` check below (ticket 59fdc52 review round 2, "estimate is
  // wrong by ~30x"): a real run never spends more than this cap allows in
  // one call, so an estimate that priced `preCapEstimate` — the FULL
  // uncapped pool — was answering a different question than "what will
  // POST /searches actually bill me". `costEstimate` from here on is
  // cap-aware: exactly what would be attempted (and billed) this run.
  const overThreshold = needsScoreIds.length > scoreThreshold && !allowAboveThreshold;
  const toScoreIds = overThreshold ? needsScoreIds.slice(0, scoreThreshold) : needsScoreIds;
  const cappedCount = needsScoreIds.length - toScoreIds.length;

  const costEstimate = estimateScoringCost(
    toScoreIds.map((id) => normalizedJobById.get(id)!),
    resumeText,
    usageStats,
  );

  // Ticket 59fdc52: `estimateOnly` stops HERE, before any `scoreJob` call —
  // fetching and ingestion above already happened (free), but nothing below
  // this point that costs money runs. `costEstimate`/`cappedCount` are the
  // SAME cap-aware numbers a real run would compute (see above) — this is
  // "what would POST /searches actually spend and defer if run right now",
  // not the full pool's price. `results` still comes from the database
  // (decision: "results come from the database, not a run's in-memory
  // state"), scoped to whatever was ALREADY scored before this call — there
  // is nothing newly scored to add to it.
  if (estimateOnly) {
    log(
      `estimateOnly=true — stopping before any scoring call. Nothing new was scored or billed ` +
        `this run.`,
    );
    const results = await fetchRankedResults(db, resumeId, [...alreadyScoredIds]);
    await markSearchComplete(db, searchId);
    return {
      resumeId,
      searchId,
      skipped: alreadyScoredIds.size,
      newlyScored: 0,
      failed: 0,
      results,
      sourceOutcomes,
      candidatesNeedingScore: needsScoreIds.length,
      cappedCount,
      scoreThreshold,
      costEstimate,
    };
  }

  log(`Scoring ${toScoreIds.length} of ${linkedJobIds.length} candidates with ${MODEL}...\n`);

  let newlyScoredCount = 0;
  let failedCount = 0;

  if (toScoreIds.length > 0) {
    // Promise.allSettled, not Promise.all: every one of these calls is
    // already billed the moment it resolves or rejects. Promise.all
    // rejects the whole batch on the FIRST failure, which would throw
    // away every fulfilled (paid-for) score alongside the failed one —
    // and because nothing gets persisted, a rerun would re-score (and
    // re-pay for) all of them, including the ones that already succeeded.
    // allSettled keeps every fulfilled result so only the actual failures
    // get retried next time.
    const scoreOne = async (jobId: string): Promise<{ jobId: string } & ScoredJob> => {
      const nj = normalizedJobById.get(jobId);
      if (!nj) {
        // Should be impossible: every id in toScoreIds came from
        // linkedJobIds, which ingestJobsForSearch derived from this same
        // candidate set.
        throw new Error(`runDemoMatch: no NormalizedJob found for linked job id "${jobId}"`);
      }
      const scored = await scoreJob(nj, resumeText);
      return { jobId, ...scored };
    };

    // Ticket aff284b: score the FIRST job alone and await it before firing
    // the rest concurrently — do NOT collapse this back into a single
    // `Promise.allSettled(toScoreIds.map(scoreOne))`. Every call in this
    // loop sends a byte-identical cached prefix (preamble + resume — see
    // makeClaudeScorer), but per Anthropic's own docs (verified live
    // 2026-08-31, platform.claude.com/docs/en/build-with-claude/
    // prompt-caching.md): "a cache entry only becomes available after the
    // first response begins ... If you need cache hits for parallel
    // requests, wait for the first response before sending subsequent
    // requests." Firing every one of `toScoreIds` at once — this loop's
    // shape before this ticket — means none of them can read a cache
    // entry the others are simultaneously racing to write, which would
    // make this entire ticket's saving zero on the real 200-job run it
    // exists for, silently, since `Promise.allSettled` reports only one
    // batch result and never distinguishes "every call missed the cache"
    // from "caching isn't in play." Scoring #1 alone first makes it the
    // run's one cache WRITE; every concurrent call after it is a cache
    // READ. Costs one extra network round trip of latency before the
    // batch starts — real, but negligible next to a 200-call run, and
    // the only way the promised ~25% saving is actually realized instead
    // of merely intended.
    //
    // Cache LIFETIME across a long run (ticket aff284b requirement:
    // "confirm behavior and whether refreshes are automatic") — verified
    // live 2026-09-02, platform.claude.com/docs/en/build-with-claude/
    // prompt-caching.md: "The cache is refreshed for no additional cost
    // each time the cached content is used," measured from the START of
    // each request, not its completion. So every READ automatically
    // extends the 5-minute default TTL for free — no explicit re-warm
    // call needed. In THIS shape that makes the concern close to moot
    // anyway: `restIds` below fires as one concurrent batch immediately
    // after the single warming call above, not job-by-job — every call in
    // a run, including a 200-job one, starts within the same handful of
    // seconds, nowhere near the 5-minute boundary. The auto-refresh matters
    // for a hypothetically slower or more sequential caller of
    // `makeClaudeScorer`; it is not something this run shape currently
    // depends on to stay warm.
    const [firstId, ...restIds] = toScoreIds;
    const settled: PromiseSettledResult<{ jobId: string } & ScoredJob>[] = [
      ...(await Promise.allSettled([scoreOne(firstId)])),
      ...(await Promise.allSettled(restIds.map((jobId) => scoreOne(jobId)))),
    ];

    const newlyScoredRows: Array<{ jobId: string } & ScoredJob> = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") {
        newlyScoredRows.push(result.value);
      } else {
        failedCount++;
        const jobId = toScoreIds[i]!;
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        log(`  FAILED to score job ${jobId}: ${reason} (will retry on the next run)`);
      }
    });
    newlyScoredCount = newlyScoredRows.length;

    if (newlyScoredRows.length > 0) {
      // onConflictDoNothing as defense-in-depth: two runs racing (or a
      // human running the script twice at once) both compute a score for
      // the same job, and the second insert simply no-ops on the
      // (resume_id, job_id) unique constraint instead of erroring or
      // creating a duplicate.
      await db
        .insert(jobMatches)
        .values(
          newlyScoredRows.map((r) => ({
            id: randomUUID(),
            resumeId,
            jobId: r.jobId,
            matchScore: r.matchScore,
            rationale: r.rationale,
            strengths: r.strengths,
            gaps: r.gaps,
          })),
        )
        .onConflictDoNothing({ target: [jobMatches.resumeId, jobMatches.jobId] });
    }

    // Real usage from this run's successful calls feeds next run's cost
    // estimate (ticket 16c824a) — a fake test scorer's rows have no
    // `usage`, so test runs never write to `usageStatsPath`.
    //
    // Deliberately AFTER the `db.insert(jobMatches)` above, and wrapped in
    // try/catch (ticket 16c824a review F1, reproduced live): this used to
    // run BEFORE the insert with nothing guarding it, so an unwritable
    // `usageStatsPath` (missing directory, read-only FS, ENOSPC, EACCES —
    // `runDemoMatch` is exported and a future RabbitMQ scoring worker is a
    // planned second caller with its own cwd) threw and discarded 3 of 3
    // already-PAID-FOR scores along with it — the exact failure mode
    // `Promise.allSettled` above exists to prevent. This write is now
    // strictly best-effort: if it fails, the scores above are already
    // safely in the database and stay there; the only consequence is that
    // the NEXT run's cost estimate falls back to the bootstrap path
    // instead of a measured one.
    const rowsWithUsage = newlyScoredRows.filter(
      (r): r is typeof r & { usage: NonNullable<ScoredJob["usage"]> } => r.usage !== undefined,
    );
    if (rowsWithUsage.length > 0) {
      try {
        recordUsageStats(usageStatsPath, {
          calls: rowsWithUsage.length,
          totalInputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.inputTokens, 0),
          totalOutputTokens: rowsWithUsage.reduce((sum, r) => sum + r.usage.outputTokens, 0),
          // Ticket aff284b: recorded separately from totalInputTokens so a
          // stats file written before this ticket (which has neither field)
          // is detectably stale and gets discarded rather than blended --
          // see readUsageStats's staleness check. As of review round 4 F3,
          // estimateScoringCost prices cache reads/writes by measuring the
          // CURRENT run's real resume directly rather than reading these
          // fields back out, but they stay recorded: they're the raw data
          // any future recalibration of that estimate would need.
          totalCacheReadTokens: rowsWithUsage.reduce(
            (sum, r) => sum + (r.usage.cacheReadTokens ?? 0),
            0,
          ),
          totalCacheCreationTokens: rowsWithUsage.reduce(
            (sum, r) => sum + (r.usage.cacheCreationTokens ?? 0),
            0,
          ),
        });
      } catch (err) {
        log(
          `  WARNING: failed to record usage stats to "${usageStatsPath}" — the ${rowsWithUsage.length} ` +
            `score(s) above are already persisted and unaffected; only the NEXT run's cost estimate ` +
            `will fall back to the bootstrap path. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  // Cap summary — emitted AFTER scoring, not before (ticket 16c824a review
  // F2): "scored" must be what actually got persisted, not a prediction
  // `Promise.allSettled` could still falsify with a failure. Base is
  // `linkedJobIds.length`, not `filtered.length` — `linkedJobIds.length ===
  // alreadyScoredIds.size + needsScoreIds.length` exactly (every linked id
  // is either already-scored or needs one), and `needsScoreIds.length ===
  // newlyScoredCount + failedCount + cappedCount` exactly (every id sent to
  // `Promise.allSettled` either fulfills or rejects, and every id NOT sent
  // is capped) — so the four numbers below always sum to the total with no
  // unaccounted remainder, unlike the earlier `filtered.length`-based line
  // this replaced.
  if (cappedCount > 0) {
    const nextRerunPicksUp = Math.min(cappedCount, scoreThreshold);
    log(
      `${linkedJobIds.length} candidate(s): ${alreadyScoredIds.size} already scored, ` +
        `${newlyScoredCount} scored this run, ${failedCount} failed, ${cappedCount} not scored (cap). ` +
        `${needsScoreIds.length} jobs needed scoring this run, above the ${scoreThreshold}-job ` +
        `spend-guard threshold (estimated cost of what was actually attempted: ` +
        `${describeCostEstimate(costEstimate)}). A plain rerun with no flags will pick up the next ` +
        `${nextRerunPicksUp} of the remaining ${cappedCount} at no extra cost (already-scored jobs are ` +
        `free — ticket 620ca30); set allowAboveThreshold (or ALLOW_SCORE_ABOVE_THRESHOLD=true for the ` +
        `CLI) to score all ${cappedCount} remaining in this run instead.`,
    );
  }

  // Final results come from the database, not from this run's in-memory
  // scores — so a second run, which scores nothing new, still prints the
  // full ranked list instead of almost nothing.
  const results = await fetchRankedResults(db, resumeId, linkedJobIds);

  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  log(`Full JSON written to ${outputPath}\n`);
  log("─── ranked ───");
  for (const j of results) {
    log(`  ${String(j.matchScore).padStart(3)}%  ${j.title}  —  ${j.company}`);
  }

  await markSearchComplete(db, searchId);

  return {
    resumeId,
    searchId,
    skipped: alreadyScoredIds.size,
    newlyScored: newlyScoredCount,
    failed: failedCount,
    results,
    sourceOutcomes,
    candidatesNeedingScore: needsScoreIds.length,
    cappedCount,
    scoreThreshold,
    costEstimate,
  };
}

// ---------------------------------------------------------------------------
// Shortlist filter for the real Greenhouse-backed run below. Moved to
// sources/swe-filter.ts (ticket b723fb9 review fix #3) so
// check-greenhouse-board.ts can reuse the exact same filter without pulling
// in this file's much heavier import graph (Drizzle, `pg`, the Anthropic
// SDK, and the top-level `process.loadEnvFile()` call a few lines up, which
// throws if no `.env` exists) — see that file's doc comment for the full
// reasoning. Re-exported here (imported above) so every existing import of
// `filterSoftwareEngineeringJobs` from "./demo-match.js" keeps working
// unchanged.
// ---------------------------------------------------------------------------
export { filterSoftwareEngineeringJobs };

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  const resumeText = fs.readFileSync("prep/resume.txt", "utf8");
  const anthropic = new Anthropic();

  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();
  const db = drizzle(client);

  // Employer lists are configuration (GREENHOUSE_BOARD_TOKENS,
  // LEVER_COMPANIES, ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES — .env),
  // not literals here (ticket b723fb9, extended to all four sources by
  // ticket d8417b2) — see .env.example for the documented default lists
  // and apps/api/src/scripts/check-{greenhouse,lever,ashby,smartrecruiters}
  // -board.ts for how each was verified before being added.
  //
  // Each `createXSourceFromEnv()` throws synchronously if ITS OWN env var
  // isn't set (a deliberate per-source design — see each function's doc
  // comment). Built independently and caught individually here, not as one
  // block, so not having gotten around to configuring (say) Lever
  // yet doesn't prevent Greenhouse/Ashby/SmartRecruiters from searching —
  // the same "one source's problem can't take the others down" principle
  // `CompositeSource` applies at request time, applied here at
  // configuration time too. Only "literally nothing is configured" is
  // treated as fatal, below.
  const sourceBuilders: Array<{ name: string; build: () => JobSource }> = [
    { name: "greenhouse", build: createGreenhouseSourceFromEnv },
    { name: "lever", build: createLeverSourceFromEnv },
    { name: "ashby", build: createAshbySourceFromEnv },
    { name: "smartrecruiters", build: createSmartRecruitersSourceFromEnv },
  ];
  const sources: JobSource[] = [];
  for (const { name, build } of sourceBuilders) {
    try {
      sources.push(build());
    } catch (err) {
      console.warn(`Skipping ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(
      "No job sources are configured. Set at least one of GREENHOUSE_BOARD_TOKENS, " +
        "LEVER_COMPANIES, ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES in .env — see .env.example.",
    );
  }

  try {
    // No location/keyword in `criteria`: every one of these adapters has
    // no (or only partial) server-side query support and substring-matches
    // criteria.location against the board's raw location string, which
    // would incorrectly reject "Remote - US" / "Seattle, WA" / "Bellevue"
    // postings that `filterSoftwareEngineeringJobs` (title + location
    // regex + dedupe) is specifically written to keep.
    // Spend-guard opt-in (ticket 16c824a): unset/anything-but-"true" means
    // a pool needing more than DEFAULT_SCORE_THRESHOLD new scores gets
    // capped at the threshold this run, reported plainly. Fails CLOSED on
    // an unrecognized value (the safe direction — the spend guard stays
    // active), but warns rather than silently guessing what was meant.
    const rawAllowAboveThresholdFlag = process.env.ALLOW_SCORE_ABOVE_THRESHOLD;
    const allowAboveThreshold = rawAllowAboveThresholdFlag === "true";
    if (rawAllowAboveThresholdFlag !== undefined && !allowAboveThreshold) {
      console.warn(
        `ALLOW_SCORE_ABOVE_THRESHOLD is set to "${rawAllowAboveThresholdFlag}", not "true" — treating ` +
          `as NOT opted in (the spend-guard threshold stays active). Set it to exactly "true" to opt in.`,
      );
    }

    const result = await runDemoMatch({
      db,
      sources,
      resumeText,
      scoreJob: makeClaudeScorer(anthropic),
      criteria: {},
      filter: filterSoftwareEngineeringJobs,
      allowAboveThreshold,
    });

    if (result.cappedCount > 0) {
      console.error(
        `${result.cappedCount} job(s) needing a score were NOT scored this run because the spend-guard ` +
          `threshold applied. A plain rerun (no flags) picks up the next batch at no extra cost — ` +
          `already-scored jobs are free. Set ALLOW_SCORE_ABOVE_THRESHOLD=true instead to score all ` +
          `${result.cappedCount} remaining in one run.`,
      );
    }
    if (result.failed > 0) {
      console.error(
        `${result.failed} of ${result.failed + result.newlyScored} scoring call(s) failed this run ` +
          `(they will be retried, not re-billed, on the next run).`,
      );
    }
    if (isTotalScoringFailure(result)) {
      console.error(
        `All ${result.failed} scoring call(s) attempted this run failed and none succeeded — treating this as a failed run.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
