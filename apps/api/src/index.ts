import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import Fastify from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { makeClaudeScorer, type ScoreJobFn } from "./demo-match.js";
import { registerResumeRoutes } from "./routes/resumes.js";
import { registerSearchRoutes } from "./routes/searches.js";
import { registerSourceRoutes } from "./routes/sources.js";
import type { buildSourceSelection } from "./sources/registry.js";

export type BuildAppDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>;
  /**
   * Lazily produces the real scorer `POST /searches` uses. A factory, not a
   * value, so constructing the `Anthropic` client (which requires
   * `ANTHROPIC_API_KEY`) happens on the FIRST actual paid run, not at server
   * boot — every read-only route (GET /sources, GET /resumes/:id/results,
   * ...) and even `POST /searches/estimate` must keep working on a machine
   * that hasn't configured billing credentials yet. See
   * `demo-match.ts`'s non-negotiable: its own `main()` (which reads
   * `prep/resume.txt` off disk and constructs its own `Anthropic` client at
   * the top of the function) must never be reachable from an HTTP request —
   * this app only ever imports named exports from demo-match.ts
   * (`runDemoMatch`, `makeClaudeScorer`, `getOrCreateResumeId`), never
   * `main` itself.
   */
  getScoreJob: () => ScoreJobFn;
  /**
   * Overrides how `POST /searches` and `POST /searches/estimate` resolve
   * requested source ids into real `JobSource`s. Defaults to the real
   * registry (`sources/registry.ts`'s `buildSourceSelection`) when omitted
   * — production always gets this. Route tests pass a `FakeSource`-backed
   * stand-in so `rtk vitest` never makes a real job-board network call. See
   * `registerSearchRoutes`'s matching parameter.
   */
  resolveSourceIds?: (sourceIds: string[]) => ReturnType<typeof buildSourceSelection>;
};

/**
 * Builds the Fastify instance. Routes registered here read or write the
 * `db` passed in directly — no route constructs its own database
 * connection — so a test can pass a real Postgres connection (see
 * `*.test.ts` files under `routes/`) without this module caring whether
 * it's talking to a throwaway local database or production.
 */
export function buildApp(deps: BuildAppDeps) {
  const app = Fastify({
    logger: true,
    // A wildly oversized request body (e.g. an accidental 30 MB resume
    // paste) must fail cleanly with 413 before Fastify even attempts to
    // buffer/parse it as JSON — not 500 partway through. 2 MB is generous
    // for a pasted resume (MAX_RESUME_TEXT_LENGTH in routes/resumes.ts is a
    // tighter, resume-specific check on top of this).
    bodyLimit: 2 * 1024 * 1024,
    // Ticket 59fdc52 review round 2: Fastify's AJV instance coerces types
    // by default (`coerceTypes: true`), so `{"resumeText": 123}` (a number)
    // silently passed the `{ type: "string" }` body schema as the STRING
    // "123" — a resume containing the three characters "123" got created
    // and hashed, no 400 anywhere. `additionalProperties: false` on every
    // route schema was never the gap; the gap was AJV rewriting the wrong
    // type into the right one before that check ever saw it. Disabling
    // coercion globally means a body whose JSON types don't match the
    // schema fails validation (400) instead of being silently reshaped —
    // no route here relies on request-body coercion (query-string values
    // like `minScore` are read as strings and converted explicitly in the
    // handler, not via AJV).
    //
    // Ticket 59fdc52 review round 3, F1 (blocking, live-verified): Fastify's
    // AJV defaults ALSO include `removeAdditional: true`, which this object
    // only overrode `coerceTypes` on — so `additionalProperties: false` on
    // `searchCriteriaSchema` (routes/searches.ts) never actually rejected an
    // unrecognized field; AJV silently DELETED it first, "validating"
    // whatever was left. `POST /searches {"criteria":{"titleInclud":[...]}}`
    // (one typo'd key) 202'd, AJV stripped the bad key, `criteria` became
    // `{}` — this codebase's own sentinel for "opt out of filtering
    // entirely" (sources/criteria.ts) — and the run scored ~200 postings in
    // board order at ~$7.68 for ~5 relevant results: exactly the behavior
    // review round 2 rejected this branch for, reachable by a single typo
    // with no error anywhere. `removeAdditional: false` makes an unknown
    // field a real 400 instead of a silent, wrong-shaped success.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  registerSourceRoutes(app);
  registerResumeRoutes(app, deps.db);
  registerSearchRoutes(app, deps.db, deps.getScoreJob, deps.resolveSourceIds);

  return app;
}

// pathToFileURL handles spaces/non-ASCII in the path correctly (percent-
// encodes as needed); a raw `file://${process.argv[1]}` template does not,
// so this check would silently fail — and the server would silently never
// listen — for anyone running from a path like `~/My Projects/`.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  process.loadEnvFile();

  // Pool, not a single Client (ticket 59fdc52 review round 2, F2 — a real,
  // reproduced defect): a bare `pg.Client` is ONE connection, and two
  // overlapping `db.transaction()` calls on one connection make the
  // second's `BEGIN` a no-op (Postgres sessions don't nest transactions),
  // so the FIRST `COMMIT` commits both transactions' work together —
  // `ingestJobsForSearch`'s documented all-or-nothing guarantee is void
  // the moment two requests overlap. Reachable simply by double-clicking
  // Search. `pg.Pool` gives drizzle a fresh connection per `transaction()`
  // call, which is what makes concurrent transactions actually isolated
  // from each other. `POST /searches` also gets an application-level
  // in-flight guard (routes/searches.ts) on top of this — belt and
  // suspenders: the guard stops the same resume from double-firing at all,
  // the Pool is what makes ANY two concurrent transactions (even for
  // different resumes) safe regardless.
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  // Fail fast on bad credentials/unreachable Postgres at boot, same as the
  // old `client.connect()` did — a Pool otherwise only surfaces a
  // connection failure lazily, on the first query a request happens to
  // trigger.
  const probe = await pool.connect();
  probe.release();
  const db = drizzle(pool);

  // Memoized, not reconstructed per call: the Anthropic client is cheap to
  // reuse across every POST /searches this process handles, and there is no
  // reason to pay connection-setup cost per search. Still only constructed
  // on the FIRST call, not at boot — see BuildAppDeps.getScoreJob's doc
  // comment.
  let cachedScoreJob: ScoreJobFn | undefined;
  const getScoreJob = (): ScoreJobFn => {
    cachedScoreJob ??= makeClaudeScorer(new Anthropic());
    return cachedScoreJob;
  };

  const app = buildApp({ db, getScoreJob });
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (isMain) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
