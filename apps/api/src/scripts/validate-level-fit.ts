/**
 * Paired A/B validation of the level-fit schema change (ticket d8746eb,
 * child of epic af0fca6 / ticket b182bde).
 *
 * WHY A LIVE RE-SCORE, NOT A READ OF OLD DATA: job descriptions are not
 * persisted anywhere reachable (not in `prep/match-results.json`, not in
 * the now-empty `job_matches` table) -- validating the NEW schema against
 * OLD postings requires re-fetching each posting live and re-scoring it for
 * real.
 *
 * WHY A PAIRED A/B, NOT A NEW SCORE vs. THE OLD STORED NUMBER: the epic's
 * own investigation found up to a 16-point, rank-reversing score swing
 * between two runs of the IDENTICAL prompt on the SAME posting (Smartsheet
 * SWE II: 74% opus-era, 58% sonnet-era). A single new-schema score compared
 * against an old stored number cannot distinguish "the schema change did
 * this" from ordinary run-to-run noise. So this script re-scores the SAME
 * freshly-fetched posting, against the SAME resume, with the SAME model,
 * in the same sitting, under TWO schemas:
 *
 *   Arm A (control) -- the OLD schema/preamble, exactly as they were
 *   immediately before ticket b182bde (frozen literal copy below, `OLD_
 *   SCHEMA`/`OLD_PREAMBLE` -- see that copy's own comment for why it's
 *   never imported, matching `verify-staff-title-exclusion-savings.ts`'s
 *   `OLD_NOT` precedent).
 *
 *   Arm B (candidate) -- the CURRENT, shipped schema/preamble, imported
 *   directly from demo-match.ts (`SCHEMA`, `SCORING_PREAMBLE`) so arm B can
 *   never silently drift from what a real scoring call actually sends.
 *
 * mean |B - A| across the full sample is the schema's real, measured
 * effect. mean |A_run1 - A_run2| across a repeat subset (arm A re-run a
 * second time on the same jobs) is the pure run-to-run noise floor, from
 * the SAME model and prompt with NOTHING changed between the two runs. The
 * report puts both numbers side by side so it is obvious whether any score
 * movement is real or noise -- see `computeNoiseVsEffect`.
 *
 * COST: this makes real, billed Anthropic API calls once run without
 * `--dry-run`. `--dry-run` runs everything else (corpus load, live
 * re-fetch, sample construction, snapshot, cost estimate) and stops before
 * any Claude call. Per ticket d8746eb: script written and reviewed WITHOUT
 * being run against the live API; run only after explicit spend approval.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/validate-level-fit.ts --dry-run   # sanity check, no spend
 *   npx tsx apps/api/src/scripts/validate-level-fit.ts             # the real, billed run
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { LevelFit } from "@app/shared";
import { MATCH_SCORE_FLOOR } from "@app/shared";
import Anthropic from "@anthropic-ai/sdk";
import {
  compareRankedResults,
  MAX_OUTPUT_TOKENS,
  MODEL,
  SCHEMA,
  SCORING_PREAMBLE,
  SONNET_PRICE_PER_MILLION_TOKENS,
  buildJobSuffix,
  type RankedResult,
} from "../demo-match.js";
import { loadEnvFile } from "../load-env.js";
import { createAshbySourceFromEnv } from "../sources/ashby.js";
import { CompositeSource } from "../sources/composite.js";
import { createGreenhouseSourceFromEnv } from "../sources/greenhouse.js";
import { createLeverSourceFromEnv } from "../sources/lever.js";
import { createSmartRecruitersSourceFromEnv } from "../sources/smartrecruiters.js";
import type { JobSource, NormalizedJob } from "../sources/types.js";

loadEnvFile();

// ---------------------------------------------------------------------------
// Configuration constants
// ---------------------------------------------------------------------------

export const CORPUS_PATH = "prep/match-results.json";
export const RESUME_PATH = "prep/resume.txt";
export const USAGE_STATS_PATH = "prep/scoring-usage-stats.json";
export const SNAPSHOT_PATH = "prep/level-fit-validation-corpus.json";
export const REPORT_PATH = "prep/level-fit-validation-report.txt";

/** Target sample size (ticket d8746eb Scope: "~50 jobs"). A real run may
 * land under this if fewer than this many historical jobs could be
 * successfully re-fetched live -- see `buildStratifiedSample`. */
export const SAMPLE_SIZE = 50;

/** Minimum "no level language in the old rationale" control jobs the sample
 * must contain, when enough are available (ticket Scope: "enough...
 * controls (15+)"). */
export const CONTROL_MINIMUM = 15;

/** How many of the sampled jobs get BOTH arms run a SECOND time, purely to
 * measure run-to-run noise (see this file's top comment). Deliberately a
 * named constant, not inlined, so it's easy to retune without re-
 * architecting anything that reads it. */
export const REPEAT_SUBSET_SIZE = 20;

/** How many scoring calls run concurrently. `CompositeSource` itself fans
 * out across sources in parallel (four different hosts -- see that file's
 * comment); this is a separate, much larger concurrency cap on Anthropic
 * calls specifically, kept modest to avoid tripping a rate limit on a
 * ~140-call run. Not tuned against a real measurement (this ticket makes no
 * live calls) -- revisit if a real run hits 429s. */
export const SCORING_CONCURRENCY = 5;

/**
 * Wide net for "the old rationale suggests a level mismatch" (ticket Scope:
 * "regex for terms like overqualif/underqualif/senior/junior/entry-level/
 * exceeds/screened out/leveling/compensation mismatch -- cast a wide net,
 * you don't need this to be perfect"). Used only to STRATIFY the sample
 * before any new scoring happens -- it never decides a job's arm-B
 * `levelFit`, which comes from a real Claude call.
 */
export const LEVEL_LANGUAGE_PATTERN =
  /overqualif|underqualif|senior|junior|entry.level|exceed|screened out|leveling|compensation mismatch|level mismatch|over.level|under.level/i;

/**
 * Estimated additional output tokens arm B's two new fields (`levelFit`, a
 * short enum string, and `levelFitNote`, one short sentence) add per call,
 * on top of the historical (pre-b182bde, arm-A-shaped) average measured
 * from `USAGE_STATS_PATH`. Sourced directly from ticket d8746eb's own Notes
 * section (the number Nicole approved the ~$3 spend against): "Arm B adds
 * ~65 output tokens for the two new fields ~= $0.01942/call" -- reusing
 * that already-reviewed figure here instead of re-deriving a new one, since
 * this ticket makes no live calls to re-measure it directly. Revisit with a
 * real measurement once arm B has actually been scored for real (its own
 * `usage.outputTokens` numbers, collected in a live run, are the ground
 * truth this estimate stands in for).
 */
export const ARM_B_EXTRA_OUTPUT_TOKENS_ESTIMATE = 65;

// ---------------------------------------------------------------------------
// FROZEN pre-ticket-b182bde copy of demo-match.ts's SCHEMA/SCORING_PREAMBLE
// -- "arm A", the control. Copied verbatim from commit f029832 (`git show
// f029832 -- apps/api/src/demo-match.ts`), the commit that introduced
// levelFit/levelFitNote, i.e. this is exactly what every call in
// `prep/match-results.json` was scored against.
//
// Deliberately NOT imported, matching verify-staff-title-exclusion-
// savings.ts's `OLD_NOT` precedent (see that file's top comment): the whole
// point of arm A is to diff against what actually shipped BEFORE this
// ticket's subject change, not against a moving target that would silently
// track demo-match.ts's SCHEMA/SCORING_PREAMBLE if either changes again in
// the future. If demo-match.ts's schema changes again, arm A must stay
// exactly what it is here -- update it only by deliberately re-copying the
// PRE-b182bde version again for a *different* validation ticket, never by
// "keeping it in sync."
// ---------------------------------------------------------------------------

const OLD_SCHEMA = {
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

const OLD_PREAMBLE = [
  "Score how well this candidate matches this job posting.",
  "Be honest and calibrated — most candidates are not a 90.",
].join("\n");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row of `prep/match-results.json` -- the historical, pre-b182bde
 * corpus this script validates against. Only the fields this script
 * actually reads are declared; the real file carries more (strengths,
 * gaps, applyUrl, ...) which pass through untouched via the `unknown`-safe
 * cast at the load site. */
export type HistoricalMatchEntry = {
  jobId: string;
  externalId: string;
  title: string;
  company: string;
  matchScore: number;
  rationale: string;
};

/** A historical job successfully matched to a freshly re-fetched live
 * posting -- the unit `buildStratifiedSample` samples over. */
export type SampleCandidate = {
  jobId: string;
  externalId: string;
  title: string;
  company: string;
  oldMatchScore: number;
  oldRationale: string;
  liveJob: NormalizedJob;
};

/** What one arm's scoring call returns, before this script attaches
 * `usage`. Deliberately loose on `levelFit`/`levelFitNote` (present only
 * for arm B) rather than two separate types -- arm A's raw JSON simply
 * omits them, same optionality `ScoredJob` already uses in demo-match.ts. */
type RawArmScore = {
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
  levelFit?: LevelFit;
  levelFitNote?: string;
};

export type ArmScore = RawArmScore & {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
};

// ---------------------------------------------------------------------------
// PURE functions -- sampling, cost math, rank/floor/noise computation. Every
// one of these is unit-tested in validate-level-fit.test.ts against fixed
// fixtures, with no network/API access. The I/O functions below (live
// fetch, live scoring, file writes, `main`) are NOT unit-tested -- they're
// thin, structurally-obvious wiring around these functions and around
// real network/API calls that can't be exercised without spending money.
// ---------------------------------------------------------------------------

/**
 * Matches historical corpus entries to a freshly-fetched live job pool by
 * `externalId` (disambiguated by `company` when more than one live source
 * happens to reuse the same external id -- unlikely across
 * greenhouse/lever/ashby/smartrecruiters, whose id formats differ, but
 * cheap to guard). A historical job with no live match has most likely
 * expired, been filled, or been withdrawn since the corpus was scored --
 * expected and reported as a skip, not an error.
 */
export function matchCorpusToLivePool(
  corpus: HistoricalMatchEntry[],
  livePool: NormalizedJob[],
): { matched: SampleCandidate[]; skipped: HistoricalMatchEntry[] } {
  const byExternalId = new Map<string, NormalizedJob[]>();
  for (const job of livePool) {
    const existing = byExternalId.get(job.externalId);
    if (existing) existing.push(job);
    else byExternalId.set(job.externalId, [job]);
  }

  const matched: SampleCandidate[] = [];
  const skipped: HistoricalMatchEntry[] = [];
  for (const entry of corpus) {
    const liveCandidates = byExternalId.get(entry.externalId) ?? [];
    const liveJob =
      liveCandidates.find(
        (job) => job.company.trim().toLowerCase() === entry.company.trim().toLowerCase(),
      ) ?? liveCandidates[0];
    if (!liveJob) {
      skipped.push(entry);
      continue;
    }
    matched.push({
      jobId: entry.jobId,
      externalId: entry.externalId,
      title: entry.title,
      company: entry.company,
      oldMatchScore: entry.matchScore,
      oldRationale: entry.rationale,
      liveJob,
    });
  }
  return { matched, skipped };
}

export type StratifiedSampleOptions = {
  targetSize?: number;
  controlMinimum?: number;
  matchScoreFloor?: number;
  levelLanguagePattern?: RegExp;
};

export type StratifiedSampleResult = {
  selected: SampleCandidate[];
  /** All still-live jobs at/above the floor -- unconditional, never capped
   * by `targetSize` (see this function's doc comment). */
  tier1Count: number;
  tier2AddedCount: number;
  controlsAddedCount: number;
  fillAddedCount: number;
  /** Total controls present in `selected`, from ANY tier -- a tier-1 or
   * tier-2 job can also happen to be a control if its old rationale simply
   * doesn't use level language. */
  controlCount: number;
  targetSize: number;
  controlMinimum: number;
};

/**
 * Builds the ~50-job stratified sample (ticket d8746eb Scope), in priority
 * order:
 *
 *   Tier 1 (unconditional, never capped): every still-live job at/above
 *   `matchScoreFloor` -- the currently-displayed set, where ranking
 *   correctness matters most. Included in full even if this alone exceeds
 *   `targetSize`: this is the one tier the ticket asks for "all" of, not
 *   "up to".
 *
 *   Tier 2: still-live jobs whose old rationale matches
 *   `levelLanguagePattern`, filling up to `targetSize`.
 *
 *   Tier 3: "no level language" controls, added (even past `targetSize` if
 *   necessary) until at least `controlMinimum` are present in the sample --
 *   from ANY tier, not just this one. Guaranteeing this count outranks the
 *   soft `targetSize` cap: the control tally is itself one of this ticket's
 *   acceptance criteria ("if they don't [come back well_matched], that's a
 *   real finding, not something to hide"), and an under-sized control set
 *   would silently weaken that finding.
 *
 *   Tier 4: whatever's left, filling any remaining slots up to
 *   `targetSize`.
 *
 * Never pads: if fewer than `controlMinimum` controls (or fewer than
 * `targetSize` jobs total) are available among `candidates`, the result
 * reports the real, smaller number rather than fabricating more.
 */
export function buildStratifiedSample(
  candidates: SampleCandidate[],
  options: StratifiedSampleOptions = {},
): StratifiedSampleResult {
  const {
    targetSize = SAMPLE_SIZE,
    controlMinimum = CONTROL_MINIMUM,
    matchScoreFloor = MATCH_SCORE_FLOOR,
    levelLanguagePattern = LEVEL_LANGUAGE_PATTERN,
  } = options;

  const isControl = (c: SampleCandidate): boolean => !levelLanguagePattern.test(c.oldRationale);

  const selected: SampleCandidate[] = [];
  const selectedIds = new Set<string>();
  const add = (c: SampleCandidate): boolean => {
    if (selectedIds.has(c.jobId)) return false;
    selected.push(c);
    selectedIds.add(c.jobId);
    return true;
  };
  const controlCount = (): number => selected.filter(isControl).length;

  const tier1 = candidates.filter((c) => c.oldMatchScore >= matchScoreFloor);
  for (const c of tier1) add(c);
  const tier1Count = selected.length;

  let tier2AddedCount = 0;
  for (const c of candidates) {
    if (selected.length >= targetSize) break;
    if (selectedIds.has(c.jobId) || !levelLanguagePattern.test(c.oldRationale)) continue;
    if (add(c)) tier2AddedCount++;
  }

  let controlsAddedCount = 0;
  for (const c of candidates) {
    if (controlCount() >= controlMinimum) break;
    if (selectedIds.has(c.jobId) || !isControl(c)) continue;
    if (add(c)) controlsAddedCount++;
  }

  let fillAddedCount = 0;
  for (const c of candidates) {
    if (selected.length >= targetSize) break;
    if (selectedIds.has(c.jobId)) continue;
    if (add(c)) fillAddedCount++;
  }

  return {
    selected,
    tier1Count,
    tier2AddedCount,
    controlsAddedCount,
    fillAddedCount,
    controlCount: controlCount(),
    targetSize,
    controlMinimum,
  };
}

/**
 * Real historical per-call token averages read directly from
 * `USAGE_STATS_PATH`. Deliberately its own small parser rather than
 * demo-match.ts's `readUsageStats`: that function discards a file missing
 * BOTH cache-related keys as pre-`aff284b` stale data (see its own doc
 * comment) -- and the real `prep/scoring-usage-stats.json` on disk today
 * IS exactly that shape (`{model, calls, totalInputTokens,
 * totalOutputTokens}`, no cache fields), because it was written by the
 * ORIGINAL historical 200-job run this script validates against, before
 * prompt caching shipped. That's not stale for THIS script's purpose --
 * these are precisely the arm-A-shaped (pre-b182bde) real averages ticket
 * d8746eb's own Notes section computed its $3 estimate from (3,874.5 in /
 * 454.2 out tokens/call) -- so this script reads them directly rather than
 * through a gate designed for a different concern.
 */
export function loadHistoricalAverages(
  path: string,
): { avgInputTokens: number; avgOutputTokens: number; calls: number } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: Partial<{ calls: number; totalInputTokens: number; totalOutputTokens: number }>;
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return undefined;
  }
  if (
    typeof parsed.calls !== "number" ||
    parsed.calls <= 0 ||
    typeof parsed.totalInputTokens !== "number" ||
    typeof parsed.totalOutputTokens !== "number"
  ) {
    return undefined;
  }
  return {
    avgInputTokens: parsed.totalInputTokens / parsed.calls,
    avgOutputTokens: parsed.totalOutputTokens / parsed.calls,
    calls: parsed.calls,
  };
}

export type ValidationCostEstimate = {
  callsArmA: number;
  callsArmB: number;
  totalCalls: number;
  avgInputTokens: number;
  avgOutputTokensArmA: number;
  avgOutputTokensArmB: number;
  costArmAUsd: number;
  costArmBUsd: number;
  totalCostUsd: number;
};

/**
 * Real cost math, not a guess: `sampleSize + repeatSubsetSize` calls per
 * arm (the initial run plus the repeat-subset re-run), priced at
 * `pricePerMillionTokens` (real `claude-sonnet-5` rate, reused from
 * demo-match.ts's `SONNET_PRICE_PER_MILLION_TOKENS` by default -- never a
 * second, hardcoded number) against real historical per-call token
 * averages (`avgInputTokens`/`avgOutputTokensArmA`, from
 * `loadHistoricalAverages`). Arm B's output is estimated as arm A's real
 * average PLUS `armBExtraOutputTokens` (see that constant's doc comment for
 * where the figure comes from).
 *
 * Deliberately UNCACHED throughout -- prices every token at the flat input
 * rate rather than modeling each arm's own prompt-cache discount. This is
 * the conservative direction (an overestimate, never an underestimate),
 * consistent with `estimateScoringCost`'s own "bootstrap" path in
 * demo-match.ts, and avoids re-deriving demo-match.ts's cache-multiplier
 * constants (which aren't exported) for a one-off script. Verified against
 * ticket d8746eb's own worked example: with this function's defaults, a
 * 50-job sample and a 20-job repeat subset produce ~$2.65 total -- the
 * exact figure the ticket's Notes section (and Nicole's spend approval)
 * cite as "≈ $2.65 uncached".
 */
export function estimateValidationCost(
  avgInputTokens: number,
  avgOutputTokensArmA: number,
  sampleSize: number,
  repeatSubsetSize: number,
  armBExtraOutputTokens: number = ARM_B_EXTRA_OUTPUT_TOKENS_ESTIMATE,
  pricePerMillionTokens: { in: number; out: number } = SONNET_PRICE_PER_MILLION_TOKENS,
): ValidationCostEstimate {
  const callsArmA = sampleSize + repeatSubsetSize;
  const callsArmB = sampleSize + repeatSubsetSize;
  const avgOutputTokensArmB = avgOutputTokensArmA + armBExtraOutputTokens;

  const perCallCost = (avgOutputTokens: number): number =>
    (avgInputTokens / 1e6) * pricePerMillionTokens.in +
    (avgOutputTokens / 1e6) * pricePerMillionTokens.out;

  const costArmAUsd = callsArmA * perCallCost(avgOutputTokensArmA);
  const costArmBUsd = callsArmB * perCallCost(avgOutputTokensArmB);

  return {
    callsArmA,
    callsArmB,
    totalCalls: callsArmA + callsArmB,
    avgInputTokens,
    avgOutputTokensArmA,
    avgOutputTokensArmB,
    costArmAUsd,
    costArmBUsd,
    totalCostUsd: costArmAUsd + costArmBUsd,
  };
}

/** The subset of `RankedResult` the shipped `compareRankedResults` actually
 * reads (`matchScore`, `levelFit`, `jobId`) -- everything else on
 * `RankedResult` is display-only and irrelevant to ordering. */
export type RankableJob = {
  jobId: string;
  title: string;
  company: string;
  matchScore: number;
  levelFit?: LevelFit | null;
};

/** Fills in the display-only fields `RankedResult` requires but
 * `compareRankedResults` never reads, so this file can call the real,
 * SHIPPED comparator (imported above) instead of re-implementing its
 * tiebreak logic -- the whole point being that a rank change this script
 * reports can never silently diverge from how `routes/resumes.ts` /
 * `fetchRankedResults` would actually order the same jobs. */
function toRankedResultStub(job: RankableJob): RankedResult {
  return {
    jobId: job.jobId,
    externalId: job.jobId,
    title: job.title,
    company: job.company,
    location: null,
    locationType: null,
    applyUrl: "",
    matchScore: job.matchScore,
    rationale: "",
    strengths: [],
    gaps: [],
    levelFit: job.levelFit ?? null,
    levelFitNote: null,
  };
}

/** Ranks `jobs` under the shipped ordering (`compareRankedResults`) and
 * returns each with its 1-based rank. */
export function rankJobs(jobs: RankableJob[]): (RankableJob & { rank: number })[] {
  return [...jobs]
    .sort((a, b) => compareRankedResults(toRankedResultStub(a), toRankedResultStub(b)))
    .map((job, index) => ({ ...job, rank: index + 1 }));
}

export type RankChangeRow = {
  jobId: string;
  title: string;
  company: string;
  oldRank: number;
  newRank: number;
  /** `oldRank - newRank`: positive means the job moved UP (better) under
   * arm B; negative means it moved down. */
  rankDelta: number;
  oldScore: number;
  newScore: number;
};

/**
 * Old-corpus rank (old `matchScore`, no `levelFit` -- an unjudged row, per
 * `compareRankedResults`' own tiebreak) vs. arm-B rank (arm B's
 * `matchScore` + real `levelFit`), both computed under the identical
 * shipped ordering, restricted to jobs present in both lists (i.e. this
 * script's own sample). Sorted by the LARGEST rank movement first, so the
 * jobs whose position actually changed the most lead the report.
 */
export function computeRankChanges(
  oldJobs: RankableJob[],
  newJobs: RankableJob[],
): RankChangeRow[] {
  const oldById = new Map(rankJobs(oldJobs).map((j) => [j.jobId, j]));
  const newById = new Map(rankJobs(newJobs).map((j) => [j.jobId, j]));

  const rows: RankChangeRow[] = [];
  for (const [jobId, oldJob] of oldById) {
    const newJob = newById.get(jobId);
    if (!newJob) continue;
    rows.push({
      jobId,
      title: newJob.title,
      company: newJob.company,
      oldRank: oldJob.rank,
      newRank: newJob.rank,
      rankDelta: oldJob.rank - newJob.rank,
      oldScore: oldJob.matchScore,
      newScore: newJob.matchScore,
    });
  }
  return rows.sort((a, b) => Math.abs(b.rankDelta) - Math.abs(a.rankDelta));
}

export type FloorCrossingRow = {
  jobId: string;
  title: string;
  company: string;
  oldScore: number;
  newScore: number;
  levelFit: LevelFit | null | undefined;
  direction: "into-display" | "out-of-display" | "unchanged";
};

export type FloorCrossingSummary = {
  rows: FloorCrossingRow[];
  intoDisplayCount: number;
  outOfDisplayCount: number;
  /** Keyed by `levelFit` (or `"unjudged"`), counting only rows that
   * actually crossed in that direction -- an "unchanged" row contributes to
   * neither bucket. */
  byLevelFit: Record<string, { into: number; out: number }>;
};

/**
 * How many jobs cross `MATCH_SCORE_FLOOR` in each direction between the old
 * stored score and arm B's fresh score, broken out by arm B's `levelFit`
 * (ticket d8746eb Scope).
 */
export function computeFloorCrossings(
  jobs: {
    jobId: string;
    title: string;
    company: string;
    oldScore: number;
    newScore: number;
    levelFit?: LevelFit | null;
  }[],
  floor: number = MATCH_SCORE_FLOOR,
): FloorCrossingSummary {
  const rows: FloorCrossingRow[] = jobs.map((j) => {
    const wasAbove = j.oldScore >= floor;
    const isAbove = j.newScore >= floor;
    const direction: FloorCrossingRow["direction"] =
      !wasAbove && isAbove ? "into-display" : wasAbove && !isAbove ? "out-of-display" : "unchanged";
    return {
      jobId: j.jobId,
      title: j.title,
      company: j.company,
      oldScore: j.oldScore,
      newScore: j.newScore,
      levelFit: j.levelFit,
      direction,
    };
  });

  const byLevelFit: Record<string, { into: number; out: number }> = {};
  const bump = (key: string, field: "into" | "out"): void => {
    const bucket = byLevelFit[key] ?? { into: 0, out: 0 };
    bucket[field] += 1;
    byLevelFit[key] = bucket;
  };

  let intoDisplayCount = 0;
  let outOfDisplayCount = 0;
  for (const row of rows) {
    const key = row.levelFit ?? "unjudged";
    if (row.direction === "into-display") {
      intoDisplayCount++;
      bump(key, "into");
    } else if (row.direction === "out-of-display") {
      outOfDisplayCount++;
      bump(key, "out");
    }
  }

  return { rows, intoDisplayCount, outOfDisplayCount, byLevelFit };
}

export type NoiseVsEffect = {
  /** mean |armB - armA| across the full sample -- the schema's real,
   * measured effect. `NaN` when `effectPairs` is empty. */
  meanAbsEffect: number;
  effectSampleSize: number;
  /** mean |run1 - run2| across the repeat subset -- pure run-to-run noise,
   * same model and prompt, nothing changed between the two runs.
   * `undefined` (not `NaN`/`0`) when there is no repeat data at all, so a
   * caller can't mistake "no noise measured" for "zero noise measured". */
  meanAbsNoise: number | undefined;
  noiseSampleSize: number;
};

/**
 * The heart of this ticket's honesty requirement: puts the schema's real
 * effect (mean |B-A| over the full sample) next to the pure noise floor
 * (mean |A_run1-A_run2| over the repeat subset) so the report can say
 * plainly whether any score movement is real or noise, instead of just
 * "scores changed" (ticket d8746eb acceptance criteria).
 */
export function computeNoiseVsEffect(
  effectPairs: { armA: number; armB: number }[],
  noisePairs: { run1: number; run2: number }[],
): NoiseVsEffect {
  const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    meanAbsEffect:
      effectPairs.length > 0 ? mean(effectPairs.map((p) => Math.abs(p.armB - p.armA))) : NaN,
    effectSampleSize: effectPairs.length,
    meanAbsNoise:
      noisePairs.length > 0 ? mean(noisePairs.map((p) => Math.abs(p.run1 - p.run2))) : undefined,
    noiseSampleSize: noisePairs.length,
  };
}

export type ControlTallyRow = {
  jobId: string;
  title: string;
  company: string;
  levelFit: LevelFit | null | undefined;
  levelFitNote: string | null | undefined;
};

export type ControlTally = {
  total: number;
  wellMatchedCount: number;
  /** Controls that did NOT come back `well_matched` under arm B -- a real
   * finding to report, not to hide (ticket d8746eb Scope). */
  misses: ControlTallyRow[];
};

/**
 * Tallies how many "no level language in the old rationale" controls came
 * back `well_matched` under arm B (expected: most/all). Every miss is
 * listed with its note so a reader can judge for themselves whether it's a
 * real over-firing enum or a control that was mislabeled by the wide-net
 * regex (ticket d8746eb Scope: "if they don't, that's a real finding, not
 * something to hide").
 */
export function computeControlTally(
  controls: {
    jobId: string;
    title: string;
    company: string;
    levelFit?: LevelFit | null;
    levelFitNote?: string | null;
  }[],
): ControlTally {
  const misses = controls.filter((c) => c.levelFit !== "well_matched");
  return {
    total: controls.length,
    wellMatchedCount: controls.length - misses.length,
    misses: misses.map((c) => ({
      jobId: c.jobId,
      title: c.title,
      company: c.company,
      levelFit: c.levelFit,
      levelFitNote: c.levelFitNote,
    })),
  };
}

/**
 * Runs `fn` over `items` with at most `limit` concurrent in-flight calls,
 * preserving input order in the returned results and never letting one
 * item's rejection cancel the others -- the same `Promise.allSettled`-style
 * isolation `runDemoMatch`'s own scoring loop and `CompositeSource` already
 * use, just capped at a fixed concurrency instead of firing everything at
 * once. Needed here because a full run makes up to ~140 Anthropic calls in
 * one go (50 jobs x 2 arms + 20-job repeat subset x 2 arms) -- unlike
 * `resume-ab.ts`/`model-ab.ts`'s small (3-13 call) `Promise.all` batches,
 * firing all of those simultaneously risks a 429 that a modest concurrency
 * cap avoids.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i]!, i);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// I/O -- live fetch, live scoring, file writes, CLI entry point. Not unit
// tested (network/API access); kept thin and structurally obvious around
// the pure functions above.
// ---------------------------------------------------------------------------

/**
 * Builds every job source this project knows how to configure from `.env`
 * (mirrors demo-match.ts's `main()` exactly: one missing env var skips only
 * that source, not the whole run) and fetches the FULL live pool from each
 * via `CompositeSource`. Returns the flattened pool of successfully-fetched
 * postings across every source that returned "ok", plus a human-readable
 * per-source log line for each configured source (fetched count, error, or
 * "skipped: <reason>" for one that wasn't configured at all).
 *
 * USAJOBS is deliberately NOT included here, matching demo-match.ts's own
 * `main()` -- it has never been wired into the real search path this
 * historical corpus was built from.
 */
async function fetchLivePool(): Promise<{ pool: NormalizedJob[]; sourceLog: string[] }> {
  const sourceBuilders: Array<{ name: string; build: () => JobSource }> = [
    { name: "greenhouse", build: createGreenhouseSourceFromEnv },
    { name: "lever", build: createLeverSourceFromEnv },
    { name: "ashby", build: createAshbySourceFromEnv },
    { name: "smartrecruiters", build: createSmartRecruitersSourceFromEnv },
  ];

  const sources: JobSource[] = [];
  const sourceLog: string[] = [];
  for (const { name, build } of sourceBuilders) {
    try {
      sources.push(build());
    } catch (err) {
      sourceLog.push(`${name}: skipped -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (sources.length === 0) {
    throw new Error(
      "No job sources are configured. Set at least one of GREENHOUSE_BOARD_TOKENS, " +
        "LEVER_COMPANIES, ASHBY_BOARD_NAMES, SMARTRECRUITERS_COMPANIES in .env -- see .env.example.",
    );
  }

  const outcomes = await new CompositeSource(sources).search({});
  const pool: NormalizedJob[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "error") {
      sourceLog.push(`${outcome.dataSource}: search failed -- ${outcome.errorMessage}`);
      continue;
    }
    sourceLog.push(`${outcome.dataSource}: ${outcome.result.jobs.length} posting(s) fetched`);
    pool.push(...outcome.result.jobs);
  }
  return { pool, sourceLog };
}

function buildCachedPrefixFor(preamble: string, resumeText: string): string {
  return [preamble, "", "=== RESUME ===", resumeText].join("\n");
}

/**
 * Builds a scorer for one arm -- same real `anthropic.messages.create` call
 * shape `makeClaudeScorer` uses in demo-match.ts (same model, same
 * `max_tokens`, same `output_config.format` json_schema approach, same
 * two-block cached-prefix-then-suffix message), parameterized on `schema`/
 * `preamble` so the identical call code serves both arm A (`OLD_SCHEMA`/
 * `OLD_PREAMBLE`) and arm B (`SCHEMA`/`SCORING_PREAMBLE`, imported live).
 * `buildJobSuffix` is imported unchanged from demo-match.ts -- the per-job
 * suffix has no schema dependency, so it's identical for both arms.
 */
function makeScorer(
  anthropic: Anthropic,
  schema: Record<string, unknown>,
  preamble: string,
): (job: NormalizedJob, resumeText: string) => Promise<ArmScore> {
  return async function scoreJob(job: NormalizedJob, resumeText: string): Promise<ArmScore> {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      output_config: { format: { type: "json_schema", schema } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildCachedPrefixFor(preamble, resumeText),
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: buildJobSuffix(job) },
          ],
        },
      ],
    });

    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("no text block returned");
    const parsed = JSON.parse(text.text) as RawArmScore;
    return {
      ...parsed,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}

function loadCorpus(): HistoricalMatchEntry[] {
  const raw = fs.readFileSync(CORPUS_PATH, "utf8");
  return JSON.parse(raw) as HistoricalMatchEntry[];
}

function settledOrUndefined<R>(result: PromiseSettledResult<R>, label: string): R | undefined {
  if (result.status === "fulfilled") return result.value;
  console.error(`  scoring call failed (${label}): ${String(result.reason)}`);
  return undefined;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  console.log(
    `validate-level-fit: ${
      dryRun
        ? "DRY RUN -- no Anthropic API calls will be made"
        : "LIVE RUN -- this WILL spend real Anthropic API credit"
    }`,
  );

  if (!fs.existsSync(CORPUS_PATH)) {
    console.error(
      `${CORPUS_PATH} not found -- the historical 200-job scored corpus is expected there.`,
    );
    process.exitCode = 1;
    return;
  }
  const corpus = loadCorpus();
  console.log(`Loaded ${corpus.length} historical job(s) from ${CORPUS_PATH}.`);

  if (!fs.existsSync(RESUME_PATH)) {
    console.error(
      `${RESUME_PATH} not found. Both arms must score against the SAME resume text as each other ` +
        `(it does not have to be byte-identical to whatever produced the original corpus) -- put that ` +
        `resume text there, or edit RESUME_PATH above.`,
    );
    process.exitCode = 1;
    return;
  }
  const resumeText = fs.readFileSync(RESUME_PATH, "utf8");
  console.log(`Using resume text from ${RESUME_PATH} (${resumeText.length} chars) for BOTH arms.`);

  console.log("\nFetching live postings from every configured source...");
  const { pool, sourceLog } = await fetchLivePool();
  for (const line of sourceLog) console.log(`  ${line}`);
  console.log(`Live pool: ${pool.length} posting(s) across all configured sources.`);

  const { matched, skipped } = matchCorpusToLivePool(corpus, pool);
  console.log(
    `\nRe-fetch results: ${matched.length}/${corpus.length} historical job(s) are still live and were ` +
      `re-fetched successfully. ${skipped.length} could not be found live (expired/filled/withdrawn) ` +
      `and were skipped.`,
  );

  const snapshot = matched.map((m) => ({
    jobId: m.jobId,
    externalId: m.externalId,
    dataSource: m.liveJob.dataSource,
    title: m.liveJob.title,
    company: m.liveJob.company,
    location: m.liveJob.location ?? null,
    locationType: m.liveJob.locationType ?? null,
    description: m.liveJob.description,
    applyUrl: m.liveJob.linkToApply,
    oldMatchScore: m.oldMatchScore,
    oldRationale: m.oldRationale,
    fetchedAt: new Date().toISOString(),
  }));
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`Snapshotted ${snapshot.length} re-fetched job description(s) to ${SNAPSHOT_PATH}.`);

  const sampleResult = buildStratifiedSample(matched);
  const sample = sampleResult.selected;
  console.log(
    `\nSample: ${sample.length} job(s) (target ${sampleResult.targetSize}) -- ` +
      `${sampleResult.tier1Count} at/above the ${MATCH_SCORE_FLOOR} floor (tier 1, unconditional), ` +
      `${sampleResult.tier2AddedCount} added for level language (tier 2), ` +
      `${sampleResult.controlsAddedCount} added to reach the control minimum (tier 3), ` +
      `${sampleResult.fillAddedCount} fill (tier 4). ` +
      `${sampleResult.controlCount} control(s) total in the sample (target >= ${sampleResult.controlMinimum}).`,
  );
  if (sampleResult.controlCount < sampleResult.controlMinimum) {
    console.warn(
      `  WARNING: only ${sampleResult.controlCount} control job(s) were available among the re-fetched ` +
        `jobs -- fewer than the ${sampleResult.controlMinimum} target. Reporting the real number, not padding it.`,
    );
  }
  if (sample.length === 0) {
    console.error("No jobs available to sample -- nothing left to validate. Stopping.");
    process.exitCode = 1;
    return;
  }

  const repeatSubsetSize = Math.min(REPEAT_SUBSET_SIZE, sample.length);
  const repeatSubset = [...sample]
    .sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0))
    .slice(0, repeatSubsetSize);

  const historicalAverages = loadHistoricalAverages(USAGE_STATS_PATH);
  if (!historicalAverages) {
    console.error(
      `Could not read real historical per-call token averages from ${USAGE_STATS_PATH} -- refusing to ` +
        `produce a cost estimate, and refusing to score without one. Aborting before any Anthropic call.`,
    );
    process.exitCode = 1;
    return;
  }

  const costEstimate = estimateValidationCost(
    historicalAverages.avgInputTokens,
    historicalAverages.avgOutputTokens,
    sample.length,
    repeatSubset.length,
  );
  console.log(
    `\nCost estimate (grounded in ${historicalAverages.calls} real historical calls from ${USAGE_STATS_PATH}):\n` +
      `  arm A: ${costEstimate.callsArmA} call(s) ~= ${formatUsd(costEstimate.costArmAUsd)}\n` +
      `  arm B: ${costEstimate.callsArmB} call(s) ~= ${formatUsd(costEstimate.costArmBUsd)}\n` +
      `  TOTAL (uncached, conservative): ~${formatUsd(costEstimate.totalCostUsd)} across ` +
      `${costEstimate.totalCalls} call(s) -- real cost will likely be somewhat lower once each arm's own ` +
      `prompt cache warms (see demo-match.ts's aff284b measurements for the size of that effect on a ` +
      `similar call shape).`,
  );

  if (dryRun) {
    console.log(
      `\n--dry-run: stopping here. No Anthropic API calls were made. Re-run WITHOUT --dry-run, after ` +
        `explicit spend approval, to actually score.`,
    );
    return;
  }

  console.log(`\nProceeding to LIVE scoring -- this spends real Anthropic API credit.`);
  const anthropic = new Anthropic();
  const scoreArmA = makeScorer(anthropic, OLD_SCHEMA, OLD_PREAMBLE);
  const scoreArmB = makeScorer(anthropic, SCHEMA, SCORING_PREAMBLE);

  console.log(
    `Scoring ${sample.length} job(s) with arm A (old schema) and arm B (shipped schema)...`,
  );
  const [armAResults, armBResults] = await Promise.all([
    mapWithConcurrency(sample, SCORING_CONCURRENCY, (c) => scoreArmA(c.liveJob, resumeText)),
    mapWithConcurrency(sample, SCORING_CONCURRENCY, (c) => scoreArmB(c.liveJob, resumeText)),
  ]);

  console.log(
    `Re-scoring the ${repeatSubset.length}-job repeat subset with both arms for a noise measurement...`,
  );
  const [armARepeatResults, armBRepeatResults] = await Promise.all([
    mapWithConcurrency(repeatSubset, SCORING_CONCURRENCY, (c) => scoreArmA(c.liveJob, resumeText)),
    mapWithConcurrency(repeatSubset, SCORING_CONCURRENCY, (c) => scoreArmB(c.liveJob, resumeText)),
  ]);

  type Row = {
    jobId: string;
    title: string;
    company: string;
    oldScore: number;
    oldRationale: string;
    armA?: ArmScore;
    armB?: ArmScore;
  };
  const rows: Row[] = sample.map((c, i) => ({
    jobId: c.jobId,
    title: c.title,
    company: c.company,
    oldScore: c.oldMatchScore,
    oldRationale: c.oldRationale,
    armA: settledOrUndefined(armAResults[i]!, `${c.company} — ${c.title} (arm A)`),
    armB: settledOrUndefined(armBResults[i]!, `${c.company} — ${c.title} (arm B)`),
  }));

  const repeatRows = repeatSubset.map((c, i) => ({
    jobId: c.jobId,
    armARun2: settledOrUndefined(armARepeatResults[i]!, `${c.company} — ${c.title} (arm A repeat)`),
    armBRun2: settledOrUndefined(armBRepeatResults[i]!, `${c.company} — ${c.title} (arm B repeat)`),
  }));
  const rankChanges = computeRankChanges(
    rows.map((r) => ({
      jobId: r.jobId,
      title: r.title,
      company: r.company,
      matchScore: r.oldScore,
    })),
    rows
      .filter((r) => r.armB)
      .map((r) => ({
        jobId: r.jobId,
        title: r.title,
        company: r.company,
        matchScore: r.armB!.matchScore,
        levelFit: r.armB!.levelFit ?? null,
      })),
  );

  const floorCrossings = computeFloorCrossings(
    rows
      .filter((r) => r.armB)
      .map((r) => ({
        jobId: r.jobId,
        title: r.title,
        company: r.company,
        oldScore: r.oldScore,
        newScore: r.armB!.matchScore,
        levelFit: r.armB!.levelFit,
      })),
  );

  const effectPairs = rows
    .filter((r) => r.armA && r.armB)
    .map((r) => ({ armA: r.armA!.matchScore, armB: r.armB!.matchScore }));
  const noisePairs = repeatRows
    .filter((r) => r.armARun2)
    .map((r) => {
      const original = rows.find((row) => row.jobId === r.jobId);
      return original?.armA
        ? { run1: original.armA.matchScore, run2: r.armARun2!.matchScore }
        : undefined;
    })
    .filter((p): p is { run1: number; run2: number } => p !== undefined);
  const noiseVsEffect = computeNoiseVsEffect(effectPairs, noisePairs);

  const controlTally = computeControlTally(
    rows
      .filter((r) => !LEVEL_LANGUAGE_PATTERN.test(r.oldRationale) && r.armB)
      .map((r) => ({
        jobId: r.jobId,
        title: r.title,
        company: r.company,
        levelFit: r.armB!.levelFit,
        levelFitNote: r.armB!.levelFitNote,
      })),
  );

  const lines: string[] = [];
  const emit = (line: string = ""): void => {
    lines.push(line);
    console.log(line);
  };

  emit(`\n=== validate-level-fit report (ticket d8746eb) — ${new Date().toISOString()} ===\n`);
  emit(`Sample: ${sample.length} job(s), ${repeatSubset.length}-job repeat subset for noise.\n`);

  emit("Per-job scores (old / arm A / arm B, arm B levelFit):");
  for (const r of rows) {
    emit(
      `  ${String(r.oldScore).padStart(3)}% / ${String(r.armA?.matchScore ?? "—").padStart(3)}% / ` +
        `${String(r.armB?.matchScore ?? "—").padStart(3)}%  [${r.armB?.levelFit ?? "n/a"}]  ` +
        `${r.company} — ${r.title}`,
    );
  }

  emit(
    "\nRank changes (old corpus rank vs. arm-B rank, shipped tiebreak ordering, largest movement first):",
  );
  for (const rc of rankChanges) {
    emit(
      `  #${rc.oldRank} -> #${rc.newRank} (${rc.rankDelta >= 0 ? "+" : ""}${rc.rankDelta})  ` +
        `${rc.oldScore}% -> ${rc.newScore}%  ${rc.company} — ${rc.title}`,
    );
  }

  emit(
    `\nFloor crossings (MATCH_SCORE_FLOOR=${MATCH_SCORE_FLOOR}): ${floorCrossings.intoDisplayCount} into ` +
      `display, ${floorCrossings.outOfDisplayCount} out of display.`,
  );
  for (const [levelFit, counts] of Object.entries(floorCrossings.byLevelFit)) {
    emit(`  ${levelFit}: +${counts.into} into, -${counts.out} out`);
  }

  emit(`\nNoise vs. effect:`);
  emit(
    `  mean |armB - armA| (schema's real effect, n=${noiseVsEffect.effectSampleSize}): ` +
      `${noiseVsEffect.meanAbsEffect.toFixed(2)} points`,
  );
  emit(
    `  mean |A run1 - A run2| (pure run-to-run noise floor, n=${noiseVsEffect.noiseSampleSize}): ` +
      `${noiseVsEffect.meanAbsNoise === undefined ? "n/a" : noiseVsEffect.meanAbsNoise.toFixed(2)} points`,
  );

  emit(`\nControl tally (no level language in old rationale, expect well_matched):`);
  emit(`  ${controlTally.wellMatchedCount}/${controlTally.total} came back well_matched.`);
  if (controlTally.misses.length > 0) {
    emit(`  Misses:`);
    for (const m of controlTally.misses) {
      emit(`    ${m.company} — ${m.title}: ${m.levelFit ?? "n/a"} — "${m.levelFitNote ?? ""}"`);
    }
  }

  emit(`\nEvery arm-B levelFitNote, in full:`);
  for (const r of rows) {
    if (!r.armB) continue;
    emit(`  ${r.company} — ${r.title} [${r.armB.levelFit}]: ${r.armB.levelFitNote || "(empty)"}`);
  }

  const failedArmA = rows.filter((r) => !r.armA).length;
  const failedArmB = rows.filter((r) => !r.armB).length;
  if (failedArmA > 0 || failedArmB > 0) {
    emit(
      `\n${failedArmA} arm-A call(s) and ${failedArmB} arm-B call(s) failed and are excluded above.`,
    );
  }

  fs.writeFileSync(REPORT_PATH, lines.join("\n") + "\n");
  console.log(
    `\nFull report written to ${REPORT_PATH} -- paste this into the git-bug d8746eb comment.`,
  );
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
