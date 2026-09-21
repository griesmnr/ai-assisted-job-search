/**
 * CLI entry point for the matching pipeline: real job postings -> Claude ->
 * ranked match scores -> Postgres.
 *
 *   npx tsx apps/api/src/demo-match.ts
 *
 * Bypasses the queue and the API, but not the database: the resume, the
 * jobs, and every match score are persisted, so running this twice does
 * not pay Claude twice for identical work (ticket 620ca30).
 *
 * The pipeline itself — find-or-create the resume by hash, skip jobs
 * already scored, score the rest with `allSettled`, persist partial
 * results, rank — lives under `matching/` (ticket 690c838; see
 * `matching/index.ts`), not here. This file is only the script tail: reads
 * `prep/resume.txt`, builds sources from env, calls `runDemoMatch`, and
 * prints the CLI summary output below.
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  excludedForMissingWorkArrangement as excludedForMissingWorkArrangementFilter,
  filterSoftwareEngineeringJobs,
  isTotalScoringFailure,
  makeClaudeScorer,
  runDemoMatch,
} from "./matching/index.js";
import { createAshbySourceFromEnv } from "./sources/ashby.js";
import { createGreenhouseSourceFromEnv } from "./sources/greenhouse.js";
import { createLeverSourceFromEnv } from "./sources/lever.js";
import { createSmartRecruitersSourceFromEnv } from "./sources/smartrecruiters.js";
import type { JobSource } from "./sources/types.js";

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
      excludedForMissingWorkArrangement: excludedForMissingWorkArrangementFilter,
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
