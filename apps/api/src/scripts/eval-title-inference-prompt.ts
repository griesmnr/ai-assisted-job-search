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
 * COST: real, billed Anthropic calls, but tiny -- 8 resumes x
 * MAX_OUTPUT_TOKENS (2000, a ceiling billed on actuals) each, same call this app already makes once per
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

/** Ticket 6487ed8 (opus review, must-fix): `currentField` is PER SHAPE.
 * A single global regex of tech words fired a false
 * "NO CURRENT-FIELD CHIPS AT ALL" on the marketing shape 3/3 -- on correct
 * output, every run -- which is the one shape added specifically to prove
 * this prompt does NOT force tech or federal titles onto people with no
 * reason for them. A guard that cries wolf on its own newest test case is
 * worse than no guard. */
const RESUME_SHAPES: { label: string; text: string; currentField: RegExp }[] = [
  {
    label: "Full-stack engineer (the incident's own shape)",
    text: "Jane Doe. Senior Full Stack Software Engineer, 8 years experience. Backend: Java and Node.js, building REST APIs and Cloud-native Microservices on AWS. Frontend: React and Angular single-page applications. Led the migration of a monolith to a microservices architecture. BS Computer Science.",
    currentField: /\b(engineer|developer|architect)\b/i,
  },
  {
    label:
      "Cloud/ML engineer (the round-1 review's specific concern -- Cloud Engineer, Machine Learning Engineer are real titles, not qualifiers)",
    text: "Alex Rivera. 6 years building machine learning infrastructure. Designed and deployed model-training pipelines on AWS SageMaker and GCP Vertex AI. Built a feature store serving real-time inference for fraud detection. Deep experience with Kubernetes, Terraform, and PyTorch. Previously a Cloud Engineer at a mid-size fintech, managing multi-region AWS infrastructure. MS Machine Learning.",
    currentField: /\b(engineer|developer|scientist)\b/i,
  },
  {
    label:
      "Non-engineering profession (product manager -- checks the prompt generalizes past 'engineer' entirely)",
    text: "Priya Shah. Senior Product Manager, 7 years, B2B SaaS. Owned the roadmap for a billing platform used by 200+ enterprise customers. Led cross-functional teams of engineers and designers through discovery, launch, and iteration. Background in UX research and SQL-based analytics. MBA.",
    currentField: /\bproduct (manager|owner|lead)\b|\bproduct\b/i,
  },
  {
    label:
      "976a782: backend/cloud/microservices full-stack resume shaped to reproduce tonight's live incident directly -- this is the resume shape most likely to elicit 'Software Engineer, Microservices' and 'Backend Software Engineer'/'Cloud Software Engineer'",
    text: "Nicole R. Full stack and backend software engineer, 7 years experience, cloud-native systems. Designed, built, and operated backend microservices in Java and Node.js on AWS and GCP, including service decomposition of a monolith into an event-driven microservices architecture. Built React front ends consuming those services. Owned CI/CD, containerization (Docker/Kubernetes), and cloud infrastructure as code (Terraform) for the team's cloud deployments. Comfortable across the stack but spends the majority of time on backend services and cloud infrastructure work. BS Computer Science.",
    currentField: /\b(engineer|developer|architect)\b/i,
  },
  {
    label:
      "6487ed8: GOVERNMENT-sector career -- the MIRROR of the long-career software shape further down. Nicole asked whether the cross-sector guidance generalizes or is tuned to her one resume; this is the direction that would expose over-fitting, since it should produce federal titles PROMINENTLY and private-sector equivalents alongside, not the other way round",
    text: "Robert Alvarez. IT Specialist (Applications Software), GS-13, 12 years federal service. 2019-Present: IT Specialist, Department of Veterans Affairs -- led modernization of a claims-processing application, Java and Angular, Oracle database, managing contractor developers through the full SDLC. 2015-2019: Computer Scientist, Defense Logistics Agency -- designed data-integration services and automated reporting pipelines in Python. 2012-2015: Program Analyst -- requirements gathering, systems analysis, and acquisition support for an enterprise logistics system. Security clearance held. Education: BS Computer Science.",
    currentField: /\b(it specialist|computer scientist|engineer|developer|analyst)\b/i,
  },
  {
    label:
      "6487ed8: NON-TECHNICAL career with no public-sector history at all -- checks the cross-sector guidance does NOT force federal job-series titles onto someone the resume gives no reason to suggest them for (the over-generalization risk of this ticket's own fix)",
    text: "Sofia Marchetti. Senior Marketing Manager, 9 years, consumer packaged goods. 2021-Present: Senior Marketing Manager at a national beverage brand -- owned brand strategy, managed a $4M media budget, led a team of five. 2017-2021: Marketing Manager -- ran integrated campaigns across retail and digital, partnered with sales on category growth. 2015-2017: Brand Coordinator. Education: BA Communications, MBA Marketing.",
    currentField: /\b(marketing|brand)\b/i,
  },
  {
    label:
      "6487ed8: LONG multi-decade career whose EARLIEST titles are analyst-flavoured and whose recent years are all software engineering -- the shape every other entry here misses, and the one that produced Nicole's three federal-series chips live",
    text: "Dana Whitfield. Full Stack Software Developer. Professional summary: enterprise web applications, REST APIs, and cloud-native microservices in Java, Python, Node.js, React, TypeScript, PostgreSQL, Docker, Kubernetes, Azure and AWS; currently building AI-powered applications with multiple LLM providers. 2026-Present: Software Developer, built an AI-powered platform with React, FastAPI and PostgreSQL. 2020-2025: Software Developer, Java Android applications for handheld scanners plus Node.js REST APIs on a Docker/Kubernetes microservices architecture. 2016-2019: Software Developer, backend APIs in Java, Node.js and Rails; containerized services on Kubernetes. 2014-2015: Software Developer, React front ends and Java backend services. 2011-2014: Programmer Analyst 2, Python/Django web application with a SQL database and a JavaScript interface. 2010-2011: Programmer Analyst 1, maintained small internal applications in MSAccess, VB and ASP.NET. Education: BS Mathematics, BA Computer Science.",
    currentField: /\b(engineer|developer|architect)\b/i,
  },
  {
    label:
      "976a782: senior backend engineer with NO full-stack or cloud framing at all -- checks the shortest-phrasing/generic-mix guidance generalizes to a plainer resume, not just the specific incident shape",
    text: "Marcus Chen. Senior Backend Engineer, 9 years, fintech and payments. Designed and maintained high-throughput Java services processing millions of transactions daily. Deep experience with PostgreSQL, Kafka, and distributed systems reliability. Mentored junior engineers and led on-call rotations. BS Computer Science.",
    currentField: /\b(engineer|developer|architect)\b/i,
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

  // Ticket 6487ed8: refuse to run live without a key, loudly. A git worktree
  // has no `.env` of its own (it is gitignored, so `git worktree add` never
  // carries it over -- see CLAUDE.md), so `loadEnvFile()` is a no-op there and
  // every call fails auth. `fetchRawTitleSuggestions` swallows all failures
  // into `[]` by design, so the symptom is an eval that reports empty chip
  // lists for every shape -- indistinguishable from a prompt that produces
  // nothing. That cost real time during this very ticket. Fail here instead.
  if (isLive && (process.env.ANTHROPIC_API_KEY ?? "").trim().length === 0) {
    console.error(
      "ANTHROPIC_API_KEY is not set, so --live would make zero real calls and\n" +
        "report an empty chip list for every shape -- which looks exactly like a\n" +
        "broken prompt. If you are in a git worktree, it has no .env of its own:\n" +
        "  export ANTHROPIC_API_KEY=$(grep -m1 '^ANTHROPIC_API_KEY=' /path/to/main/.env | cut -d= -f2-)",
    );
    process.exit(1);
  }

  console.log(
    isLive
      ? "LIVE run -- real, billed Anthropic calls.\n"
      : "DRY RUN -- no API calls will be made. Pass --live to actually call the API.\n",
  );

  for (const { label, text, currentField } of RESUME_SHAPES) {
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

    // Ticket 6487ed8: the live failure was not malformed chips -- every one was
    // well-formed and well-punctuated, so nothing above would have caught it.
    // It was that the person's CURRENT-FIELD titles were absent entirely,
    // leaving only early-career/other-sector ones.
    //
    // Note what is deliberately NOT flagged: federal job-series names. A first
    // draft of this check treated those as the defect; Nicole corrected it
    // ("I do still want the government ones to come up"), and she is right --
    // USAJOBS is one of this app's own sources, so those titles are how
    // federal postings get found. Their PRESENCE is fine. Their presence
    // *instead of* current-field titles is the bug.
    const currentFieldChips = titles.filter((t) => currentField.test(t));
    if (currentFieldChips.length === 0) {
      console.log(
        `  NO CURRENT-FIELD CHIPS AT ALL -- this is the 6487ed8 failure: ${JSON.stringify(titles)}`,
      );
    }

    // Ticket 6487ed8: three chips was a legal answer under the old "3-6"
    // range and is what she actually got. Breadth is now the requirement,
    // so a thin list is itself a finding.
    if (titles.length < 6) {
      console.log(`  THIN CHIP LIST: only ${titles.length} chips -- the prompt asks for 8-10`);
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
