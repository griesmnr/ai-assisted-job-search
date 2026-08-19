/**
 * A/B: did tailoring the resume actually help, against one specific posting?
 *
 * Scores two resume files against the same live job posting with the same
 * model and the same prompt, N times each, and reports both means with their
 * spread.
 *
 *   npx tsx apps/api/src/resume-ab.ts prep/resume.txt prep/resume-samsara.txt
 *   npx tsx apps/api/src/resume-ab.ts prep/resume.txt prep/tailored.txt 8036387
 *
 * Why N runs and not one: the scorer is an LLM, so the same resume against the
 * same posting does not return the same number twice. A single 72 -> 75 proves
 * nothing. If the two spreads overlap, the tailoring did not measurably move
 * this posting — which is a real answer, not a failed run.
 *
 * The prompt is kept byte-identical to demo-match.ts (including its unset
 * payType/commitment) so scores here are directly comparable to the ones
 * already in prep/match-results.json. Change one, change both.
 */
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { GreenhouseSource } from "./sources/greenhouse";
import type { NormalizedJob } from "./sources/types";

process.loadEnvFile();

const MODEL = "claude-opus-5";
const RUNS = 3;
const BOARDS = ["samsara", "flexport", "smartsheet", "pushpay"];
const DEFAULT_JOB = "8036387"; // Samsara, Software Engineer II, Remote - US

const anthropic = new Anthropic();

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

type Scored = { matchScore: number; rationale: string; strengths: string[]; gaps: string[] };

async function scoreJob(job: NormalizedJob, resume: string): Promise<Scored> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          "Score how well this candidate matches this job posting.",
          "Be honest and calibrated — most candidates are not a 90.",
          "",
          "=== RESUME ===",
          resume,
          "",
          "=== JOB POSTING ===",
          `Title: ${job.title}`,
          `Employer: ${job.company}`,
          `Location: ${job.location ?? "not stated"} (${job.locationType})`,
          `Type: ${job.payType}, ${job.commitment}`,
          "",
          job.description.slice(0, 6000),
        ].join("\n"),
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("no text block returned");
  return JSON.parse(text.text) as Scored;
}

function summarize(runs: Scored[]) {
  const scores = runs.map((r) => r.matchScore);
  const mean = scores.reduce((s, n) => s + n, 0) / scores.length;
  return { mean, lo: Math.min(...scores), hi: Math.max(...scores), scores };
}

async function main() {
  const [baselinePath, tailoredPath, jobId = DEFAULT_JOB] = process.argv.slice(2);
  if (!baselinePath || !tailoredPath) {
    console.error("usage: resume-ab.ts <baseline.txt> <tailored.txt> [externalId]");
    process.exit(2);
  }

  const baseline = fs.readFileSync(baselinePath, "utf8");
  const tailored = fs.readFileSync(tailoredPath, "utf8");

  console.log(`Fetching posting ${jobId}...`);
  const { jobs } = await new GreenhouseSource({ boardTokens: BOARDS }).search({});
  const job = jobs.find((j) => j.externalId === jobId);
  if (!job) {
    // A posting that has been taken down is the most likely cause, and it must
    // not look like a scoring result. Fail loudly rather than returning zeros.
    console.error(`Posting ${jobId} is not on any of: ${BOARDS.join(", ")}.`);
    console.error("It was probably filled or withdrawn. Nothing was scored.");
    process.exit(1);
  }

  console.log(`  ${job.company} — ${job.title} (${job.location ?? "location not stated"})`);
  console.log(`Scoring both resumes ${RUNS}x each with ${MODEL}...\n`);

  const [base, tail] = await Promise.all([
    Promise.all(Array.from({ length: RUNS }, () => scoreJob(job, baseline))),
    Promise.all(Array.from({ length: RUNS }, () => scoreJob(job, tailored))),
  ]);

  const b = summarize(base);
  const t = summarize(tail);
  const delta = t.mean - b.mean;
  const overlap = t.lo <= b.hi && b.lo <= t.hi;

  console.log(`  baseline  ${b.mean.toFixed(1)}%  (${b.scores.join(", ")})   ${baselinePath}`);
  console.log(`  tailored  ${t.mean.toFixed(1)}%  (${t.scores.join(", ")})   ${tailoredPath}`);
  console.log(`  delta     ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points`);
  console.log(
    overlap
      ? "\n  The two ranges overlap — this is within run-to-run noise, not a\n  measurable improvement on this posting."
      : "\n  The ranges do not overlap — the tailoring moved this posting for real.",
  );

  // The gaps are the actionable part: what the tailored version still fails to
  // answer is the list of things worth adding, or worth expecting to be asked.
  const remaining = new Set(tail.flatMap((r) => r.gaps));
  const closed = new Set(base.flatMap((r) => r.gaps));
  for (const g of remaining) closed.delete(g);

  if (closed.size > 0) {
    console.log("\n  ─── gaps the tailoring closed ───");
    for (const g of closed) console.log(`  - ${g}`);
  }
  console.log("\n  ─── gaps still open in the tailored version ───");
  for (const g of remaining) console.log(`  - ${g}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
