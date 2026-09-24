/**
 * Live evaluation of `inferTitleKeywords`'s prompt/schema against several
 * DIFFERENT resume shapes (ticket 5ba5cca, review round 1 F1/F2; extended
 * for ticket 976a782 -- see that shapes list below).
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
 * TICKET 976a782 (round 2): extended this SAME script, per that ticket's
 * own instruction, rather than writing a new one -- with two more resume
 * shapes reproducing tonight's specific live finding (Nicole's fresh
 * resume edit produced "Software Engineer, Microservices" as one
 * comma-joined chip, plus "Backend Software Engineer" and "Cloud Software
 * Engineer" as over-qualified variants of otherwise-standard titles).
 *
 * ROUND 2's OWN review (round 1 of ITS fixes) found this script's first
 * draft checked the wrong thing: it flagged punctuation on the POST-split
 * `titles` result, but `splitConjoinedTitles` had already removed every
 * comma/semicolon from that result by construction -- so the comma/
 * semicolon flags, and the reported-bad-chip check (every reported chip
 * contains a comma), were unreachable no matter what the model actually
 * did. Fixed by checking the RAW, pre-split model output via the newly
 * exported `fetchRawTitleSuggestions` -- see that function's own doc
 * comment in resume-title-inference.ts.
 *
 * COST: real, billed Anthropic calls, but tiny -- 5 resumes x
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
import { fetchRawTitleSuggestions, splitConjoinedTitles } from "../resume-title-inference.js";

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
  {
    label:
      "976a782: backend/cloud/microservices full-stack resume shaped to reproduce tonight's live incident directly -- this is the resume shape most likely to elicit 'Software Engineer, Microservices' and 'Backend Software Engineer'/'Cloud Software Engineer'",
    text: "Nicole R. Full stack and backend software engineer, 7 years experience, cloud-native systems. Designed, built, and operated backend microservices in Java and Node.js on AWS and GCP, including service decomposition of a monolith into an event-driven microservices architecture. Built React front ends consuming those services. Owned CI/CD, containerization (Docker/Kubernetes), and cloud infrastructure as code (Terraform) for the team's cloud deployments. Comfortable across the stack but spends the majority of time on backend services and cloud infrastructure work. BS Computer Science.",
  },
  {
    label:
      "976a782: senior backend engineer with NO full-stack or cloud framing at all -- checks the shortest-phrasing/generic-mix guidance generalizes to a plainer resume, not just the specific incident shape",
    text: "Marcus Chen. Senior Backend Engineer, 9 years, fintech and payments. Designed and maintained high-throughput Java services processing millions of transactions daily. Deep experience with PostgreSQL, Kafka, and distributed systems reliability. Mentored junior engineers and led on-call rotations. BS Computer Science.",
  },
];

const isLive = process.argv.includes("--live");

// The exact three bad chips reported live tonight (git-bug 976a782) -- the
// specific strings this round's acceptance criteria require no longer
// reproducing.
const REPORTED_BAD_CHIPS = [
  "Software Engineer, Microservices",
  "Backend Software Engineer",
  "Cloud Software Engineer",
];

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
    // RAW output first (opus review round 1, F1): checking the model's own
    // compliance with "no comma/semicolon joining" against the POST-split
    // result is vacuously true, since splitConjoinedTitles has already
    // removed every comma/semicolon by construction -- that was this
    // script's own first-draft bug. The flag below runs against what the
    // model actually returned, before any code touches it.
    const rawTitles = await fetchRawTitleSuggestions(anthropic, text);
    console.log(`RAW MODEL TITLES: ${JSON.stringify(rawTitles)}`);

    const flaggedRawPunctuation = rawTitles.filter((t) => /[()/,;]/.test(t));
    if (flaggedRawPunctuation.length > 0) {
      console.log(
        `  MODEL STILL JOINED WITH COMMA/SEMICOLON/PARENS/SLASH: ${JSON.stringify(flaggedRawPunctuation)}`,
      );
    }

    const titles = splitConjoinedTitles(rawTitles);
    console.log(`FINAL CHIPS (after split): ${JSON.stringify(titles)}`);

    const reproducedBadChips = REPORTED_BAD_CHIPS.filter((bad) =>
      rawTitles.some((t) => t.toLowerCase() === bad.toLowerCase()),
    );
    if (reproducedBadChips.length > 0) {
      console.log(
        `  MODEL REPRODUCED A REPORTED BAD CHIP (pre-split): ${JSON.stringify(reproducedBadChips)}`,
      );
    }

    const degenerateChips = titles.filter((t) => !/\s/.test(t));
    if (degenerateChips.length > 0) {
      // Should be structurally impossible after the 2+-word floor in
      // splitConjoinedTitles -- checked anyway so a regression there is
      // visible here too, not just in the unit tests.
      console.log(`  DEGENERATE ONE-WORD CHIP SURVIVED SPLIT: ${JSON.stringify(degenerateChips)}`);
    }
    console.log();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
