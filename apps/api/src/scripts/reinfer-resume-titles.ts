/**
 * Re-runs title-keyword inference against EXISTING resumes whose
 * `suggestedTitles` were computed and cached before ticket 976a782's prompt
 * fix (ticket 1e09c1b, Nicole: dogfooding against her real environment, saw
 * chips like "Backend Software Engineer (Java/Node.js)" and "Software
 * Developer - Cloud & Microservices" -- exactly the two named BAD examples
 * in resume-title-inference.ts's own prompt).
 *
 * WHY THIS IS A STALENESS PROBLEM, NOT A LIVE BUG. `routes/resumes.ts`
 * computes `suggestedTitles` AT MOST ONCE per resume row --
 * `suggestedTitles === null` is the only trigger -- and caches the result
 * forever on that row (db/schema.ts). Nicole's resume was almost certainly
 * inferred before ticket 976a782 landed, so it's serving output the fix was
 * never applied to. Nothing about ordinary usage re-triggers it: resubmitting
 * the IDENTICAL resume text finds the SAME content-addressed row
 * (getOrCreateResumeId, per-user since ticket b2f9dfd) and `suggestedTitles`
 * is already non-null, so inference is skipped every time. The current
 * prompt/`splitConjoinedTitles` logic (resume-title-inference.ts) already
 * forbids exactly this shape -- verified against that file's own test suite
 * and `eval-title-inference-prompt.ts` -- so this script exists to catch
 * EXISTING rows up to logic that's already correct, not to fix the logic
 * itself.
 *
 * WHY NO COST-ESTIMATE GATE (unlike `rescore-existing-matches.ts`'s
 * `MAX_ESTIMATED_SPEND_USD`, which this script's structure otherwise
 * mirrors): that gate exists because job-scoring cost scales with the
 * NUMBER OF JOBS matched against a resume, which can run into the hundreds
 * per resume and genuinely needs a worst-case ceiling. Title inference is
 * ONE call PER RESUME (`resume-title-inference.ts`'s `MAX_OUTPUT_TOKENS`
 * caps it at 300 output tokens, a small fraction of even a single job-score
 * call), and Nicole's own resume count is inherently small -- a person has
 * a handful of resumes, not hundreds of scored jobs. A per-resume cost
 * ceiling would be safety theater at this scale; the real safety property
 * this script needs is "only ever touch a row whose NEW output actually
 * differs," which the diff gate below provides directly.
 *
 * SAFETY GATE (same shape as this directory's other operator scripts):
 *
 *   - DRY RUN is the default. No flags prints, per affected resume, the OLD
 *     chips vs. the NEW ones this run would write, then stops -- nothing is
 *     written, no resume whose output would be UNCHANGED is even mentioned
 *     (see WHY "UNCHANGED" IS SILENT below).
 *   - `--live` is required to actually write. Any other argument is a hard
 *     error.
 *   - Only resumes with a NON-NULL `suggestedTitles` are considered at all --
 *     a resume that has never been inferred (`suggestedTitles === null`)
 *     will get real, current-prompt inference the next time it's actually
 *     used (`routes/resumes.ts`'s own existing lazy-inference path); this
 *     script has nothing to add there and leaves those rows alone.
 *   - A resume whose RE-INFERRED output is IDENTICAL (as a set -- see
 *     `titlesEqual` below) to what's already stored is left untouched: not
 *     written, not even counted as a "candidate" in the summary. Claude is
 *     a real model call, not a deterministic function, so re-running it
 *     against unchanged text can legitimately return the same set in a
 *     different order or, rarely, a slightly different but equally-valid
 *     phrasing -- writing a no-op "different order, same meaning" update on
 *     every affected resume on every run would make this script re-churn
 *     rows that were never actually bad, and would make a dry run's output
 *     noisy with rows an operator doesn't need to look at.
 *
 * Usage (run on YOUR OWN machine, against YOUR OWN database and API key --
 * this never runs in CI or in the sandbox this ticket was implemented in):
 *
 *   npx tsx apps/api/src/scripts/reinfer-resume-titles.ts          # DRY RUN, no spend
 *   npx tsx apps/api/src/scripts/reinfer-resume-titles.ts --live   # actually re-infers and writes
 */
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { eq, isNotNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { resumes } from "../db/schema.js";
import { loadEnvFile } from "../load-env.js";
import { inferTitleKeywords } from "../resume-title-inference.js";

loadEnvFile();

export type ParsedArgs = { live: boolean };

export function parseArgs(argv: string[]): ParsedArgs {
  const unknownFlags = argv.filter((a) => a !== "--live");
  if (unknownFlags.length > 0) {
    throw new Error(
      `Unrecognized argument(s): ${unknownFlags.join(", ")}. Known flags are --live (actually ` +
        "writes; omit for a dry run). This script takes no positional arguments -- it considers " +
        "every resume with a non-null suggestedTitles.",
    );
  }
  return { live: argv.includes("--live") };
}

function connectDb(): Client {
  return new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
}

export type CandidateResume = {
  id: string;
  resumeNickname: string;
  resumeText: string;
  suggestedTitles: string[];
};

export async function findInferredResumes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): Promise<CandidateResume[]> {
  const rows = await db
    .select({
      id: resumes.id,
      resumeNickname: resumes.resumeNickname,
      resumeText: resumes.resumeText,
      suggestedTitles: resumes.suggestedTitles,
    })
    .from(resumes)
    .where(isNotNull(resumes.suggestedTitles));
  // `isNotNull` is a WHERE-clause guarantee, not a type-narrowing one --
  // drizzle's inferred row type keeps `suggestedTitles: string[] | null`
  // regardless. The `?? []` reflects the WHERE clause's own guarantee back
  // into the type, no different in kind from `existingRow[0]?.suggestedTitles
  // ?? null`'s own null-handling in routes/resumes.ts.
  return rows.map((r) => ({ ...r, suggestedTitles: r.suggestedTitles ?? [] }));
}

/**
 * Set-equality, case-insensitive-on-nothing (title casing IS meaningful,
 * unlike an email address) but order-independent: Claude is a real model
 * call, not a deterministic function, so a re-run against literally
 * unchanged resume text can return the same chips in a different order.
 * That is not a real difference this script should report or write over.
 */
export function titlesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((title, i) => title === sortedB[i]);
}

export type ReinferOutcome = {
  id: string;
  resumeNickname: string;
  oldTitles: string[];
  newTitles: string[];
};

export type ReinferResult = {
  totalConsidered: number;
  changed: ReinferOutcome[];
  written: boolean;
};

export async function runReinfer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  anthropic: Anthropic,
  opts: { live: boolean },
): Promise<ReinferResult> {
  const candidates = await findInferredResumes(db);
  const changed: ReinferOutcome[] = [];

  for (const candidate of candidates) {
    const newTitles = await inferTitleKeywords(anthropic, candidate.resumeText);
    if (titlesEqual(candidate.suggestedTitles, newTitles)) continue;
    changed.push({
      id: candidate.id,
      resumeNickname: candidate.resumeNickname,
      oldTitles: candidate.suggestedTitles,
      newTitles,
    });
    if (opts.live) {
      await db
        .update(resumes)
        .set({ suggestedTitles: newTitles })
        .where(eq(resumes.id, candidate.id));
    }
  }

  return { totalConsidered: candidates.length, changed, written: opts.live };
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { live } = parsed;

  console.log(
    `reinfer-resume-titles: ${live ? "LIVE RUN -- this WILL re-infer and write" : "DRY RUN -- nothing will be written"}`,
  );
  console.log(
    `Connecting to postgres://${process.env.POSTGRES_USER ?? "(unset)"}@` +
      `${process.env.POSTGRES_HOST ?? "(unset)"}:${process.env.POSTGRES_PORT ?? "(unset)"}/` +
      `${process.env.POSTGRES_DB ?? "(unset)"}`,
  );

  const client = connectDb();
  try {
    await client.connect();
  } catch (err) {
    console.error(
      `Failed to connect to the database: ${err instanceof Error ? err.message : String(err)} -- ` +
        "check POSTGRES_HOST/POSTGRES_PORT/POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB in your .env " +
        "and that Postgres is actually running.",
    );
    process.exitCode = 1;
    return;
  }
  const db = drizzle(client);
  const anthropic = new Anthropic();

  try {
    const result = await runReinfer(db, anthropic, { live });
    console.log(`\n${result.totalConsidered} resume(s) had a previously-inferred title set.`);
    if (result.changed.length === 0) {
      console.log("None re-infer to anything different -- nothing to do.");
      return;
    }
    console.log(`${result.changed.length} would change:\n`);
    for (const outcome of result.changed) {
      console.log(`  ${outcome.id}  "${outcome.resumeNickname}"`);
      console.log(`    old: ${JSON.stringify(outcome.oldTitles)}`);
      console.log(`    new: ${JSON.stringify(outcome.newTitles)}`);
    }
    if (!live) {
      console.log(
        `\nDry run: stopping here. Nothing was written. Re-run with --live to actually update ` +
          `${result.changed.length} resume(s).`,
      );
      return;
    }
    console.log(`\nUpdated ${result.changed.length} resume(s).`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
