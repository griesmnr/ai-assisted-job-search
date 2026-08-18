/**
 * A/B: does a cheaper model rank jobs the same way?
 *
 * Re-scores the exact jobs already scored by claude-opus-5 (in
 * prep/match-results.json) using claude-haiku-4-5, same prompt, and compares
 * scores, rank order, latency and cost.
 *
 *   npx tsx apps/api/src/model-ab.ts
 */
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { GreenhouseSource } from "./sources/greenhouse";
import type { NormalizedJob } from "./sources/types";

process.loadEnvFile();

const CHALLENGER = "claude-sonnet-5";
const RESUME = fs.readFileSync("prep/resume.txt", "utf8");
const anthropic = new Anthropic();

// $ per million tokens
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 3, out: 15 },
};

const SCHEMA = {
  type: "object",
  properties: {
    matchScore: { type: "integer", description: "0-100." },
    rationale: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["matchScore", "rationale", "strengths", "gaps"],
  additionalProperties: false,
};

function prompt(job: NormalizedJob) {
  return [
    "Score how well this candidate matches this job posting.",
    "Be honest and calibrated — most candidates are not a 90.",
    "",
    "=== RESUME ===",
    RESUME,
    "",
    "=== JOB POSTING ===",
    `Title: ${job.title}`,
    `Employer: ${job.company}`,
    `Location: ${job.location ?? "not stated"} (${job.locationType})`,
    `Type: ${job.payType}, ${job.commitment}`,
    "",
    job.description.slice(0, 6000),
  ].join("\n");
}

async function score(model: string, job: NormalizedJob) {
  const started = Date.now();
  const r = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: prompt(job) }],
  });
  const text = r.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block");
  return {
    ...(JSON.parse(text.text) as { matchScore: number; rationale: string }),
    ms: Date.now() - started,
    inTok: r.usage.input_tokens,
    outTok: r.usage.output_tokens,
  };
}

async function main() {
  const champion = JSON.parse(fs.readFileSync("prep/match-results.json", "utf8")) as {
    externalId: string;
    title: string;
    company: string;
    matchScore: number;
  }[];
  const wanted = new Set(champion.map((c) => c.externalId));

  const source = new GreenhouseSource({
    boardTokens: ["samsara", "flexport", "smartsheet", "pushpay"],
  });
  const { jobs } = await source.search({});
  const targets = jobs.filter((j) => wanted.has(j.externalId));
  console.log(`Re-scoring ${targets.length} jobs with ${CHALLENGER}...\n`);

  const results = await Promise.all(
    targets.map(async (job) => ({ job, ...(await score(CHALLENGER, job)) })),
  );

  const byId = new Map(results.map((r) => [r.job.externalId, r]));
  const rows = champion
    .map((c) => ({ ...c, challenger: byId.get(c.externalId) }))
    .filter((r) => r.challenger);

  console.log("  opus  haiku   Δ   job");
  console.log("  ────  ─────  ───  ───");
  for (const r of rows) {
    const h = r.challenger!.matchScore;
    const d = h - r.matchScore;
    console.log(
      `  ${String(r.matchScore).padStart(3)}%  ${String(h).padStart(4)}%  ${(d > 0 ? "+" : "") + d}`.padEnd(
        24,
      ) + `${r.company} — ${r.title.slice(0, 44)}`,
    );
  }

  // Rank agreement: do the two models order the jobs the same way?
  const opusOrder = [...rows].sort((a, b) => b.matchScore - a.matchScore).map((r) => r.externalId);
  const haikuOrder = [...rows]
    .sort((a, b) => b.challenger!.matchScore - a.challenger!.matchScore)
    .map((r) => r.externalId);
  const topFiveOverlap = opusOrder
    .slice(0, 5)
    .filter((id) => haikuOrder.slice(0, 5).includes(id)).length;

  const totalIn = results.reduce((s, r) => s + r.inTok, 0);
  const totalOut = results.reduce((s, r) => s + r.outTok, 0);
  const cost = (m: string) =>
    (totalIn / 1e6) * PRICING[m]!.in + (totalOut / 1e6) * PRICING[m]!.out;
  const avgMs = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);

  console.log(`\n  top-5 overlap:   ${topFiveOverlap}/5`);
  console.log(`  same #1:         ${opusOrder[0] === haikuOrder[0] ? "yes" : "no"}`);
  console.log(`  avg latency:     ${avgMs}ms (haiku)`);
  console.log(
    `  cost this run:   haiku $${cost(CHALLENGER).toFixed(4)}  vs  opus $${cost("claude-opus-5").toFixed(4)}`,
  );
  console.log(
    `  at 300 jobs/wk:  haiku $${((cost(CHALLENGER) / results.length) * 300).toFixed(2)}  vs  opus $${((cost("claude-opus-5") / results.length) * 300).toFixed(2)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
