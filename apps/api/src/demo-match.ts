/**
 * End-to-end vertical slice, no infrastructure.
 *
 *   real job postings  ->  Claude  ->  ranked match scores
 *
 * Deliberately bypasses the queue, the API, and the database. This is the
 * product; the rest is how it survives failure and scale.
 *
 *   npx tsx apps/api/src/demo-match.ts
 */
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { GreenhouseSource } from "./sources/greenhouse";
import type { NormalizedJob } from "./sources/types";

process.loadEnvFile();

const MODEL = "claude-opus-5";
const MAX_JOBS = 12;
const RESUME = fs.readFileSync("prep/resume.txt", "utf8");

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

async function scoreJob(job: NormalizedJob) {
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
          RESUME,
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
  return JSON.parse(text.text) as {
    matchScore: number;
    rationale: string;
    strengths: string[];
    gaps: string[];
  };
}

async function main() {
  const source = new GreenhouseSource({
    boardTokens: ["samsara", "flexport", "smartsheet", "pushpay"],
  });

  console.log("Fetching live openings from Greenhouse boards...");
  // No keyword: JobCategoryCode=2210 already means "information technology".
  // Adding "software engineer" as free text on top demands those exact words
  // appear in postings that are already IT jobs — the two filters fight, and
  // together with the location they returned zero.
  const { jobs, skipped, skipRate } = await source.search({});
  console.log(`  ${jobs.length} jobs, ${skipped.length} skipped (skipRate ${skipRate.toFixed(2)})\n`);

  // Title filter: actual software engineering roles, not adjacent ones.
  const SOFTWARE =
    /\b(software engineer|full.?stack|back.?end|front.?end|web engineer|senior engineer|staff engineer)\b/i;
  const NOT =
    /\b(manager|director|principal|sales|marketing|recruit|intern|designer|field service|machine learning|data scientist)\b/i;

  // Location filter: Washington, or genuinely US-remote. Excludes the many
  // "Remote - Canada/UK/Poland" postings, which aren't applicable.
  const PLACE = /(washington|seattle|bellevue|,\s*wa\b|remote\s*-\s*us|remote,\s*usa)/i;

  const seen = new Set<string>();
  const shortlist = jobs
    .filter((j) => SOFTWARE.test(j.title) && !NOT.test(j.title))
    .filter((j) => PLACE.test(j.location ?? ""))
    .filter((j) => {
      const key = `${j.company}|${j.title}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_JOBS);

  console.log(`Scoring ${shortlist.length} of them with ${MODEL}...\n`);

  const scored = await Promise.all(
    shortlist.map(async (job) => ({
      title: job.title,
      company: job.company,
      location: job.location ?? null,
      locationType: job.locationType,
      applyUrl: job.linkToApply,
      externalId: job.externalId,
      ...(await scoreJob(job)),
    })),
  );

  scored.sort((a, b) => b.matchScore - a.matchScore);

  fs.writeFileSync("prep/match-results.json", JSON.stringify(scored, null, 2));
  console.log("Full JSON written to prep/match-results.json\n");
  console.log("─── ranked ───");
  for (const j of scored) {
    console.log(`  ${String(j.matchScore).padStart(3)}%  ${j.company.padEnd(11)} ${j.title.slice(0, 48).padEnd(50)} ${j.location ?? ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
