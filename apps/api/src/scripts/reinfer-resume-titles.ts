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
 *   npx tsx apps/api/src/scripts/reinfer-resume-titles.ts          # DRY RUN -- still calls Claude
 *                                                                   # once per candidate (see N1
 *                                                                   # below), just never writes
 *   npx tsx apps/api/src/scripts/reinfer-resume-titles.ts --live   # actually re-infers and writes
 *
 * Opus review, N1: the dry run does NOT skip spend -- it calls
 * `inferTitleKeywords` for every candidate exactly as `--live` does, only
 * the WRITE is skipped. An earlier draft of this comment claimed "no spend"
 * here, which was wrong in the direction that matters (an operator reading
 * this before deciding how freely to re-run it).
 *
 * Opus review, B1 (BLOCKING, fixed): `inferTitleKeywords` swallows EVERY
 * failure -- a bad API key, a rate limit, a network drop, a malformed
 * response -- into a silent `[]` (see that function's own doc comment: this
 * is the right contract for its ORIGINAL caller, resume submission, which
 * must never be blocked by an inference hiccup). This script is a second
 * caller with the OPPOSITE need, and the first version of it inherited that
 * contract without noticing the reversal: a `[]` result compared as
 * genuinely different from any non-empty stored value, so `--live` would
 * WRITE `[]` over a resume's real chips on a transient failure. That is
 * worse than the bug this script exists to fix -- and, critically, not
 * self-healing: `[]` is NOT NULL, and `routes/resumes.ts`'s lazy
 * re-inference is gated on `suggestedTitles === null`, so a wiped row stays
 * wiped forever through ordinary app use. Proven live against real
 * Postgres during review (a throwing fake client's `--live` run left a real
 * row's chips overwritten with `[]`). Fixed below: an empty re-inference
 * result is now treated as a FAILURE to be reported and skipped, never as a
 * value to compare or write -- the schema this script's own prompt asks for
 * is 3-6 titles, so a genuine empty success is not an expected shape this
 * script needs to accommodate.
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

/** Opus review, B1: a resume whose re-inference came back empty --
 * `inferTitleKeywords` swallows every real failure into `[]` (see this
 * file's header), so an empty result here means "the call failed," not
 * "Claude genuinely suggested zero titles." Reported so a bad run is loud,
 * never written, never compared against the stored value. */
export type ReinferFailure = { id: string; resumeNickname: string };

export type ReinferResult = {
  totalConsidered: number;
  changed: ReinferOutcome[];
  /** Opus review, B1. Always empty in a genuinely healthy run -- a
   * non-empty list here means re-run this script; the affected resumes
   * were left completely untouched, not written with a wrong or partial
   * value. */
  failed: ReinferFailure[];
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
  const failed: ReinferFailure[] = [];

  for (const candidate of candidates) {
    const newTitles = await inferTitleKeywords(anthropic, candidate.resumeText);
    // Opus review, B1 (BLOCKING): an empty result is a FAILURE signal, not
    // a real re-inference outcome to compare or write -- see this file's
    // header for why `inferTitleKeywords` can return `[]` on a transient
    // error, and why writing that over real chips would be silent,
    // non-self-healing data loss. Checked BEFORE `titlesEqual`, and the
    // candidate is skipped entirely: no write, not counted as "changed".
    if (newTitles.length === 0) {
      failed.push({ id: candidate.id, resumeNickname: candidate.resumeNickname });
      continue;
    }
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

  return { totalConsidered: candidates.length, changed, failed, written: opts.live };
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
    // Opus review, N2: the candidate count is now printed BEFORE any
    // per-resume detail (and before the "nothing to do" early return), so
    // an operator always sees the real blast radius up front -- a database
    // with far more candidates than expected (e.g. from repeated dogfooding
    // submissions, each edit creating a new content-addressed row) is
    // visible immediately rather than only inferable from a long list.
    console.log(`\n${result.totalConsidered} resume(s) had a previously-inferred title set.`);

    if (result.failed.length > 0) {
      console.log(
        `\n${result.failed.length} resume(s) FAILED to re-infer (API error, rate limit, or ` +
          `similar -- see this file's header on why an empty result is treated as a failure, ` +
          `never written) and were left completely untouched:\n`,
      );
      for (const failure of result.failed) {
        console.log(`  ${failure.id}  "${failure.resumeNickname}"`);
      }
      console.log("\nRe-run this script to retry the failed resume(s).");
    }

    if (result.changed.length === 0) {
      console.log("\nNone of the rest re-infer to anything different -- nothing to do.");
      return;
    }
    console.log(`\n${result.changed.length} would change:\n`);
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
