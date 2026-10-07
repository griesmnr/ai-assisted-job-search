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
 * the IDENTICAL resume text resolves to the SAME row (getOrCreateResumeId's
 * hash lookup, per-user since ticket b2f9dfd) and `suggestedTitles` is
 * already non-null, so inference is skipped every time.
 *
 * Ticket 6ba221e adds ONE re-trigger that did not exist when this script was
 * written: editing a resume's text (`PUT /resumes/:id/text`) nulls
 * `suggested_titles` and re-infers on the spot. That does not make this
 * script redundant -- it only catches rows whose text the user happens to
 * edit, and a stale-prompt row nobody edits stays stale forever. The current
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
 *   - EVERY resume is a candidate, `suggestedTitles === null` included as of
 *     ticket 82ae975 -- see TICKET 82ae975 below for why the original
 *     non-null-only scoping was wrong, not just incomplete.
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
 * Opus review, B1 (BLOCKING, fixed): `inferTitleKeywords` used to swallow
 * EVERY failure -- a bad API key, a rate limit, a network drop, a malformed
 * response -- into a silent `[]` (the ORIGINAL contract, right for resume
 * submission, which must never be blocked by an inference hiccup). This
 * script is a second caller with the OPPOSITE need, and the first version
 * of it inherited that contract without noticing the reversal: a `[]`
 * result compared as genuinely different from any non-empty stored value,
 * so `--live` would WRITE `[]` over a resume's real chips on a transient
 * failure. Proven live against real Postgres during review (a throwing
 * fake client's `--live` run left a real row's chips overwritten with
 * `[]`). Fixed below: a failure is caught and reported, never written.
 * Ticket 82ae975 (below) changed WHAT counts as the failure signal, not
 * this guarantee -- a caught exception still lands in `failed`, never in
 * `changed`, and is never compared or written.
 *
 * ---------------------------------------------------------------------------
 * TICKET 82ae975 -- `inferTitleKeywords` NOW THROWS ON FAILURE INSTEAD OF
 * RETURNING `[]`, AND THAT CHANGES WHAT THIS SCRIPT CAN REACH
 * ---------------------------------------------------------------------------
 *
 * `resume-title-inference.ts`'s own doc comment has the full history: a
 * failed inference used to persist as `suggestedTitles: []` on `POST
 * /resumes`, which this script's `isNotNull` filter DID reach (an `[]` row
 * is non-null) -- so, by accident, this script was already the operator's
 * only way to retry a POST-path failure. Ticket 82ae975 fixes `POST
 * /resumes` to persist `null` on failure instead (matching `PUT
 * /resumes/:id/text`'s own pre-existing choice, ticket 6ba221e) specifically
 * so the ROUTE's own lazy re-inference gate (`suggestedTitles === null`)
 * can retry it without any operator involvement at all. But that
 * side-effect would have REMOVED this script's only path to a failed row
 * had its `isNotNull` filter stayed as it was: every failure, from either
 * route, now lands on exactly the value this script used to skip on
 * purpose. The fix is the WHERE clause above: every resume is now a
 * candidate, not just previously-inferred ones.
 *
 * WHY THIS IS SAFE AGAINST A NEVER-TOUCHED (genuinely, not failed) ROW, not
 * just a failed one: `findCandidateResumes` below coerces a `null`
 * `suggestedTitles` to `[]` before comparison (same coercion
 * `routes/resumes.ts`'s own readers already perform), so a never-inferred
 * resume that successfully infers for the first time here is correctly
 * reported in `changed` (`[]` vs. a real result is never "identical") and
 * written under `--live` -- which is exactly what would have happened the
 * next time that resume was actually used, just run proactively by the
 * operator instead. Nothing about this script can tell "never touched"
 * apart from "failed, needs rescue" -- both are `null` -- but nothing
 * downstream needs to: either way, a successful re-run improves the row,
 * and a resume that keeps failing lands in `failed`, reported and left
 * alone, regardless of which reason it started `null` for.
 *
 * COST, STATED PLAINLY (the ticket's own instruction: say so if this
 * matters): the candidate pool used to be bounded by "resumes that have
 * already been inferred once"; it is now bounded by "every resume this
 * database holds," which calls Claude once per resume per run even in a DRY
 * RUN (N1 above still holds). At this app's current, effectively
 * single-user scale ("a person has a handful of resumes, not hundreds," the
 * same reasoning WHY NO COST-ESTIMATE GATE above already relies on) that is
 * still cents, not a real budget risk. It stops being true the moment this
 * app has many users each with a few resumes, or any pile of abandoned/test
 * rows accumulates -- if that ever happens, add a cost-estimate gate here
 * first (same shape as `rescore-existing-matches.ts`'s
 * `MAX_ESTIMATED_SPEND_USD`), rather than assuming this reasoning still
 * holds unchanged.
 */
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
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
        "every resume, regardless of its current suggestedTitles value.",
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

/**
 * Every resume in the database, not only previously-inferred ones --
 * ticket 82ae975 (see this file's header for why). `suggestedTitles` is
 * coerced from `null` to `[]` here, the same coercion `routes/resumes.ts`'s
 * own readers (`GET /resumes/:id`, `PUT /resumes/:id/text`'s unchanged-save
 * branch) already perform: `runReinfer` below treats `[]` as "nothing
 * stored to lose," whether that `[]` came from a real `null` row or a
 * genuine past empty success, and either way a non-empty new result is
 * correctly reported as a change.
 */
export async function findCandidateResumes(
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
    .from(resumes);
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

/** Opus review, B1, updated for ticket 82ae975: a resume whose re-inference
 * either THREW (the API call failed, or the response was malformed --
 * `inferTitleKeywords` now propagates that instead of swallowing it into
 * `[]`) or came back structurally empty. `reason` carries the thrown
 * error's own message for the first case, and a fixed string for the
 * second -- so an operator reading this script's console output sees WHY
 * a row was skipped, not just that it was. Reported so a bad run is loud,
 * never written, never compared against the stored value. */
export type ReinferFailure = { id: string; resumeNickname: string; reason: string };

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
  const candidates = await findCandidateResumes(db);
  const changed: ReinferOutcome[] = [];
  const failed: ReinferFailure[] = [];

  for (const candidate of candidates) {
    let newTitles: string[];
    try {
      newTitles = await inferTitleKeywords(anthropic, candidate.resumeText);
    } catch (err) {
      // Ticket 82ae975: `inferTitleKeywords` now THROWS on a failed API
      // call or a malformed response instead of swallowing one into `[]`.
      // This is the catch that replaces the old `newTitles.length === 0`
      // check for that case -- never compared, never written, reported
      // with the real error message so an operator can see WHY.
      failed.push({
        id: candidate.id,
        resumeNickname: candidate.resumeNickname,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // A STRUCTURALLY VALID but empty result is still treated as suspect
    // here, defensively, even though it is no longer the primary failure
    // signal (opus review, B1, and see resume-title-inference.ts's own
    // doc comment on why a genuine empty success is possible but
    // essentially never observed): this script's own prompt asks for 3-6
    // titles, so an empty, non-throwing result is still not an expected
    // shape worth comparing or writing over real stored chips.
    if (newTitles.length === 0) {
      failed.push({
        id: candidate.id,
        resumeNickname: candidate.resumeNickname,
        reason: "re-inference returned no titles (not an exception, but still not written)",
      });
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
    // submissions -- which, before ticket 6ba221e, minted a brand-new row
    // per edit rather than updating one) is
    // visible immediately rather than only inferable from a long list.
    // Ticket 82ae975: every resume is now a candidate, not just
    // previously-inferred ones -- see this file's header.
    console.log(`\n${result.totalConsidered} resume(s) considered.`);

    if (result.failed.length > 0) {
      console.log(
        `\n${result.failed.length} resume(s) FAILED to re-infer (API error, rate limit, or ` +
          `similar -- see this file's header on why an empty result is treated as a failure, ` +
          `never written) and were left completely untouched:\n`,
      );
      for (const failure of result.failed) {
        console.log(`  ${failure.id}  "${failure.resumeNickname}"  -- ${failure.reason}`);
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
