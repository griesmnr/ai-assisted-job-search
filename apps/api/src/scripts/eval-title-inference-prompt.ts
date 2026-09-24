/**
 * Live evaluation of `inferTitleKeywords`'s prompt/schema against several
 * DIFFERENT resume shapes (ticket 5ba5cca, review round 1 F1/F2).
 *
 * WHY THIS EXISTS: the ticket's own acceptance criteria require evaluating
 * the tightened prompt against 2-3 different resume shapes, "since a
 * prompt tightened only against one resume risks re-narrowing for someone
 * else." The unit tests in resume-title-inference.test.ts mock the
 * Anthropic client, which proves the prompt TEXT contains the right
 * instructions but cannot prove a real model actually follows them for a
 * resume the prompt wasn't hand-tuned against. This script makes that real
 * call. Reviewer round 1 (opus) specifically found a real generalization
 * bug this way of thinking predicts: the first draft's blanket ban on
 * "Cloud"/"Microservices" as bare words would have suppressed real,
 * common board titles like "Cloud Engineer" for a cloud/ML resume -- a
 * fresh instance of the exact bug this ticket exists to fix, just for a
 * different profession. That's now fixed in the prompt (qualifier-vs-head
 * distinction); this script is how to check it actually holds for a model,
 * not just for a human reading the prompt text.
 *
 * COST: real, billed Anthropic calls, but tiny -- 3 resumes x
 * MAX_OUTPUT_TOKENS (300) each, same call this app already makes once per
 * real resume submission. Default is DRY RUN (prints the resumes and
 * exits without calling anything); pass `--live` to actually call the API.
 * Same inverted-safety pattern as validate-level-fit.ts: anything other
 * than an exact `--live` match stays dry.
 *
 * Usage:
 *   npx tsx apps/api/src/scripts/eval-title-inference-prompt.ts          # dry run
 *   npx tsx apps/api/src/scripts/eval-title-inference-prompt.ts --live   # real calls
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadEnvFile } from "../load-env.js";
import { inferTitleKeywords } from "../resume-title-inference.js";

const RESUME_SHAPES: { label: string; text: string }[] = [
  {
    label: "Full-stack engineer (the incident's own shape)",
    text: "Jane Doe. Senior Full Stack Software Engineer, 8 years experience. Backend: Java and Node.js, building REST APIs and Cloud-native Microservices on AWS. Frontend: React and Angular single-page applications. Led the migration of a monolith to a microservices architecture. BS Computer Science.",
  },
  {
    label:
      "Cloud/ML engineer (the round-1 review's specific concern -- Cloud Engineer, Machine Learning Engineer are real titles, not qualifiers)",
    text: "Alex Rivera. 6 years building machine learning infrastructure. Designed and deployed model-training pipelines on AWS SageMaker and GCP Vertex AI. Built a feature store serving real-time inference for fraud detection. Deep experience with Kubernetes, Terraform, and PyTorch. Previously a Cloud Engineer at a mid-size fintech, managing multi-region AWS infrastructure. MS Machine Learning.",
  },
  {
    label:
      "Non-engineering profession (product manager -- checks the prompt generalizes past 'engineer' entirely)",
    text: "Priya Shah. Senior Product Manager, 7 years, B2B SaaS. Owned the roadmap for a billing platform used by 200+ enterprise customers. Led cross-functional teams of engineers and designers through discovery, launch, and iteration. Background in UX research and SQL-based analytics. MBA.",
  },
];

const isLive = process.argv.includes("--live");

async function main(): Promise<void> {
  loadEnvFile();

  console.log(
    isLive
      ? "LIVE run -- real, billed Anthropic calls.\n"
      : "DRY RUN -- no API calls will be made. Pass --live to actually call the API.\n",
  );

  for (const { label, text } of RESUME_SHAPES) {
    console.log(`=== ${label} ===`);
    if (!isLive) {
      console.log(`(dry run) resume: ${text.slice(0, 80)}...\n`);
      continue;
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const titles = await inferTitleKeywords(anthropic, text);
    console.log(JSON.stringify(titles, null, 2));

    const flagged = titles.filter((t) => /[()/]/.test(t));
    if (flagged.length > 0) {
      console.log(`  FLAGGED (parens/slash): ${JSON.stringify(flagged)}`);
    }
    console.log();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
