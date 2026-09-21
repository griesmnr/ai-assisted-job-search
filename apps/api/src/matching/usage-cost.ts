/**
 * Usage-stats persistence and pre-scoring cost estimation.
 *
 * Split out of demo-match.ts (ticket 690c838) — grouped separately from
 * scoring.ts because this is a distinct concern (what a run is LIKELY to
 * cost, before any Claude call happens) that happens to be built on top of
 * scoring.ts's prompt-construction functions and constants.
 */
import fs from "node:fs";
import type { NormalizedJob } from "../sources/types.js";
import {
  buildCachedPrefix,
  buildScoringPrompt,
  CACHE_MIN_PREFIX_TOKENS,
  MAX_OUTPUT_TOKENS,
  MODEL,
  TYPICAL_OUTPUT_CHARS_PER_JOB,
} from "./scoring.js";

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
 *
 * Exported (ticket d8746eb) so `scripts/validate-level-fit.ts` can price its
 * own pre-run cost estimate off the SAME real rate this file uses, instead
 * of re-typing `{ in: 3, out: 15 }` as a second, driftable literal.
 */
export const SONNET_PRICE_PER_MILLION_TOKENS = { in: 3, out: 15 };

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
  /** Kept for internal reference — equals `probableCostUsd` on BOTH basis
   * values now (ticket 1a2cde3: bootstrap no longer ties its probable
   * figure to `maxCostUsd`). Not for display (ticket e85fa9b) — UI code
   * reads `maxCostUsd`/`probableCostUsd` directly. */
  estimatedCostUsd: number;
  /**
   * A genuine worst-case ceiling: `MAX_OUTPUT_TOKENS` (the model's real,
   * code-enforced hard cap) applied to every job, on top of the same
   * input/cache token figures used for `probableCostUsd`. Never exceeded
   * by a real run. Computed on both `basis` values (ticket e85fa9b) — this
   * used to be the ONLY figure "bootstrap" produced, with no ceiling
   * computed for "measured" at all.
   */
  maxCostUsd: number;
  /**
   * Best real-data guess at actual cost. "measured": genuine historical
   * averages from `usageStats` — grounded, not assumed. "bootstrap": no
   * completed run has ever produced `usageStats` yet, but (ticket 1a2cde3)
   * this is no longer an unfounded discount off `maxCostUsd` either — the
   * scorer's response is JSON-schema-shaped, not free text, so a realistic
   * typical output size is grounded in that schema instead (see
   * `TYPICAL_OUTPUT_CHARS_PER_JOB`'s doc comment). Narrow/temporary in a
   * different sense now: the app's first completed run makes every later
   * estimate "measured" (genuinely observed), which is a strictly better
   * signal than the schema-grounded bootstrap guess this stays until then.
   */
  probableCostUsd: number;
  /**
   * "measured": both averages come from `usageStats` — real recorded calls
   * from a prior run. "bootstrap": no recorded calls exist yet, so input is
   * estimated from THIS run's real prompt character counts (see
   * `CHARS_PER_TOKEN_ESTIMATE`); output feeds `probableCostUsd` from the
   * schema-grounded typical size (`TYPICAL_OUTPUT_CHARS_PER_JOB`, ticket
   * 1a2cde3) and `maxCostUsd` from the worst case, `MAX_OUTPUT_TOKENS` per
   * job (the model's actual hard cap) — real numbers from this codebase
   * either way, never an invented per-job dollar figure.
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
      maxCostUsd: 0,
      probableCostUsd: 0,
      basis,
    };
  }

  let estimatedInputTokens: number;
  let estimatedCacheReadTokens: number;
  let estimatedCacheCreationTokens: number;
  let estimatedOutputTokens: number;
  let estimatedCostUsd: number;
  // Ticket e85fa9b: a genuine worst-case companion to `estimatedCostUsd`,
  // computed on BOTH basis values now (previously only bootstrap had one).
  // Same input/cache-token figures either way -- those come from real
  // prompt/prefix character counts, not from the stochastic part (output
  // length) -- with output priced at `MAX_OUTPUT_TOKENS * jobCount`, the
  // model's real, code-enforced hard cap, instead of whatever this
  // basis's `estimatedOutputTokens` assumption is.
  let maxCostUsd: number;

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
      maxCostUsd =
        (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
        ((MAX_OUTPUT_TOKENS * jobCount) / 1e6) * pricePerMillionTokens.out;
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
      maxCostUsd =
        (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
        (estimatedCacheReadTokens / 1e6) * pricePerMillionTokens.in * CACHE_READ_PRICE_MULTIPLIER +
        (estimatedCacheCreationTokens / 1e6) *
          pricePerMillionTokens.in *
          CACHE_WRITE_PRICE_MULTIPLIER +
        ((MAX_OUTPUT_TOKENS * jobCount) / 1e6) * pricePerMillionTokens.out;
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
    // Ticket 1a2cde3: `estimatedOutputTokens` (and the `estimatedCostUsd`
    // built from it below) is now the TYPICAL, schema-grounded guess —
    // see `TYPICAL_OUTPUT_CHARS_PER_JOB`'s doc comment — not the worst
    // case. `maxCostUsd` below is computed separately, straight off
    // `MAX_OUTPUT_TOKENS`, so it stays the genuine ceiling this field
    // never used to have before ticket e85fa9b added it; the two no
    // longer collapse to the same number on this basis.
    estimatedOutputTokens = Math.round(
      (TYPICAL_OUTPUT_CHARS_PER_JOB / CHARS_PER_TOKEN_ESTIMATE) * jobCount,
    );
    estimatedCostUsd =
      (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
      (estimatedOutputTokens / 1e6) * pricePerMillionTokens.out;
    maxCostUsd =
      (estimatedInputTokens / 1e6) * pricePerMillionTokens.in +
      ((MAX_OUTPUT_TOKENS * jobCount) / 1e6) * pricePerMillionTokens.out;
  }

  // `probableCostUsd` is `estimatedCostUsd` on BOTH bases now (ticket
  // 1a2cde3): "measured" already used real historical averages;
  // "bootstrap" used to fall back to `maxCostUsd` here because it had no
  // grounded output-size signal at all, but now it does (the schema-typical
  // estimate above) — see `TYPICAL_OUTPUT_CHARS_PER_JOB`'s doc comment for
  // why that's a real signal, not an invented discount. The ternary this
  // replaced is gone because there is no longer a basis where these two
  // differ.
  const probableCostUsd = estimatedCostUsd;

  return {
    jobCount,
    estimatedInputTokens,
    estimatedCacheReadTokens,
    estimatedCacheCreationTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    maxCostUsd,
    probableCostUsd,
    basis,
  };
}

/**
 * Human-readable, token-jargon-carrying rendering of a `CostEstimate`
 * (ticket 16c824a review F4). Used ONLY for the CLI/`main()`'s own console
 * narration (see its call sites below) -- NOT by the REST API or the web
 * UI as of ticket e85fa9b, which surface `CostEstimate.maxCostUsd` /
 * `probableCostUsd` as plain numbers instead; Nicole asked not to see
 * token/cache-bucket text in the product. Kept here because the CLI
 * entry point (`npx tsx apps/api/src/demo-match.ts`) is a legitimate
 * separate audience that can reasonably want the fuller technical detail.
 *
 * The "bootstrap" basis (ticket 1a2cde3): `estimate.probableCostUsd` is
 * now a schema-grounded TYPICAL estimate (see
 * `TYPICAL_OUTPUT_CHARS_PER_JOB`'s doc comment), not tied to
 * `MAX_OUTPUT_TOKENS` — this rendering shows it as the headline `~$…`
 * point estimate, same as the "measured" branch below, with the genuine
 * worst case (`estimate.maxCostUsd`, still `MAX_OUTPUT_TOKENS` per job —
 * that cap's own doc comment says it's "rarely actually reached") stated
 * alongside it rather than presented as the number itself. Before this
 * ticket, bootstrap had no typical-case signal at all and this function
 * rendered `estimatedCostUsd` (then always equal to `maxCostUsd` on this
 * basis) as an explicit ceiling (`≤$…`) instead of a point estimate,
 * specifically because overstating the FIRST-ever run's cost — the one
 * run where this number is the user's only guide before deciding whether
 * to proceed — was judged worse than an honest, if numberless, "could be
 * up to $X". That reasoning no longer applies now that there's a real
 * typical number to lead with.
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
      `~$${estimate.probableCostUsd.toFixed(2)} (schema-grounded typical estimate, no measured usage ` +
      `yet — worst case ≤$${estimate.maxCostUsd.toFixed(2)} if every call used its full ` +
      `${MAX_OUTPUT_TOKENS}-token output budget, ${tokens})`
    );
  }
  return `~$${estimate.estimatedCostUsd.toFixed(2)} (${tokens}, based on measured usage from prior runs)`;
}
