/**
 * Estimate + run a search, and poll a run's status (ticket 59fdc52).
 *
 * This is the ONLY file in the REST surface with a path to a real
 * `ScoreJobFn` (via `getScoreJob`) — every other route (resumes, sources,
 * results) reads or writes free/instant things. `POST /searches` is
 * therefore the one endpoint in this whole API allowed to spend money, and
 * it only does so because the caller explicitly asked (decision: "no
 * endpoint may spend money without the caller explicitly asking it to").
 *
 * `POST /searches/estimate` shares almost all of the same fetch/ingest path
 * (via `runDemoMatch`'s `estimateOnly` option) but never touches
 * `getScoreJob` at all — it passes a scorer that throws if ever called, as
 * an assertion that `estimateOnly` really did stop before scoring.
 *
 * QUALITY FILTER (review round 2 — read before touching `filter`): both
 * routes compile a `SearchCriteria` (packages/shared) into a filter via
 * `compileFilter` (sources/criteria.ts) and pass it to `runDemoMatch`. Round
 * 1 shipped no filter at all on the (correct) premise that
 * `filterSoftwareEngineeringJobs`'s regexes hardcode Nicole's own
 * title/location criteria — but deleting a quality control is not the same
 * act as making it configurable, and round 1 measured nothing. Live
 * consequence: an unfiltered `POST /searches` against the real Greenhouse
 * pool (6,230 postings) scores `slice(0, 200)` in board-token order — 200
 * Samsara postings alphabetical by title, 5 of them software engineering
 * roles, 195 things like "Accountant II" and "Account Executive,
 * Commercial". `compileFilter(criteria)` (when `criteria` is present in the
 * request body) or `compileFilter(undefined)` (when it's absent — which
 * reproduces the CLI's filter EXACTLY, see criteria.ts) is what a caller
 * gets by default now; passing an explicit empty `{}` is how a caller opts
 * out of filtering entirely.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  EstimateSearchResponse,
  SearchCriteria,
  SearchStatusResponse,
  SkippedSource,
  StartSearchResponse,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  describeCostEstimate,
  runDemoMatch,
  type RunDemoMatchResult,
  type ScoreJobFn,
} from "../demo-match.js";
import { resumes, searches as searchesTable } from "../db/schema.js";
import { compileFilter } from "../sources/criteria.js";
import { buildSourceSelection } from "../sources/registry.js";
import type { JobSource } from "../sources/types.js";

const searchCriteriaSchema = {
  type: "object",
  properties: {
    titleInclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    titleExclude: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    nearLocations: { type: "array", items: { type: "string", maxLength: 200 }, maxItems: 20 },
    remoteOk: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const searchBodySchema = {
  type: "object",
  required: ["resumeId", "sourceIds"],
  properties: {
    resumeId: { type: "string", minLength: 1 },
    // uniqueItems (not a hand-rolled duplicate check): AJV rejects a
    // request with a repeated sourceId as a clean 400 before the handler
    // ever runs, rather than the handler having to detect it and build a
    // synthetic "skipped" entry — round 1's version of that synthetic
    // entry reported `skippedSources[0].id` as the literal string
    // "usajobs,usajobs" (every duplicate id joined together), which is
    // exactly the kind of malformed-looking-like-data bug a schema-level
    // check avoids by construction.
    sourceIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
    criteria: searchCriteriaSchema,
  },
  additionalProperties: false,
} as const;

type SearchBody = { resumeId: string; sourceIds: string[]; criteria?: SearchCriteria };

type SearchRunState =
  | { status: "pending"; resumeId: string }
  | { status: "complete"; resumeId: string; result: RunDemoMatchResult }
  | { status: "failed"; resumeId: string; error: string };

/**
 * In-memory tracker for "run a search" invocations, keyed by the same id
 * used for the `searches` row the run creates. Acceptable for v1's bar
 * (CLAUDE.md: single-user, no login, runs locally, single process) — a
 * server restart mid-run loses the ability to POLL that run's live status,
 * but never loses the run's actual output: everything `runDemoMatch`
 * persists lands in Postgres regardless, and `GET /searches/:id` falls back
 * to querying the `searches` table directly when an id isn't in this map
 * (see below, and `searches.status` — schema.ts), and `GET
 * /resumes/:id/results` always reads straight from the database (decision
 * #3: results come from the database, never from in-memory state).
 *
 * Bounded (ticket 59fdc52 review round 2): an unbounded Map here is a slow
 * memory leak over the life of a long-running process — every search ever
 * run, forever. `pruneSearchRuns` evicts the oldest COMPLETE/FAILED entries
 * (never a "pending" one — that would break an in-flight poll) once the
 * tracker exceeds `MAX_TRACKED_SEARCHES`.
 */
const searchRuns = new Map<string, SearchRunState>();
const MAX_TRACKED_SEARCHES = 500;

/**
 * Exposes the module-private tracker internals to `searches.test.ts` only —
 * exercising the 500-entry bound through 500 real `POST /searches` HTTP
 * round trips would be slow and would mostly be testing Fastify/Postgres
 * throughput, not the eviction logic itself. Not used by any route handler
 * above; production code never imports this export.
 */
export const __testing = { searchRuns, MAX_TRACKED_SEARCHES, pruneSearchRuns };

function pruneSearchRuns(): void {
  if (searchRuns.size <= MAX_TRACKED_SEARCHES) return;
  // Map iteration order is insertion order, so this walks oldest-first.
  for (const [id, state] of searchRuns) {
    if (searchRuns.size <= MAX_TRACKED_SEARCHES) break;
    if (state.status === "pending") continue;
    searchRuns.delete(id);
  }
}

/**
 * One entry per resumeId currently running a real (billed) search — the
 * in-flight guard (ticket 59fdc52 review round 2, F2). Reproduced defect:
 * two overlapping `POST /searches` requests (e.g. a double-clicked Search
 * button) each start their own `runDemoMatch`, and — independent of the
 * `pg.Pool` fix in index.ts, which makes concurrent DB transactions safe —
 * running the same resume's search twice concurrently is wasteful (pays
 * for scoring the same candidate set twice, since neither run can see the
 * other's in-progress work) and confusing (which of the two searchIds is
 * "the" search for this resume?). Guards per resumeId, not globally: two
 * DIFFERENT resumes searching at once is fine and unrelated.
 */
const inFlightByResume = new Map<string, string>();

function tempOutputPath(searchId: string): string {
  // Deliberately NOT prep/match-results.json — that file holds the owner's
  // live results and a search triggered through this API must never
  // overwrite it. os.tmpdir() keeps every API-triggered run's throwaway
  // JSON dump (runDemoMatch always writes one) entirely outside the repo.
  return path.join(os.tmpdir(), `rest-api-search-${searchId}.json`);
}

const NEVER_SCORE: ScoreJobFn = () => {
  throw new Error(
    "searches/estimate: scoreJob was called, but estimateOnly should have stopped before any " +
      "scoring call. This would be a real, unexpected Claude spend — treat it as a bug.",
  );
};

export function registerSearchRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  getScoreJob: () => ScoreJobFn,
  /**
   * Defaults to the real `buildSourceSelection` (real `createXSourceFromEnv`
   * adapters, real network calls once `runDemoMatch` calls `.search()` on
   * them). Overridable so route tests can inject `FakeSource`s instead —
   * exactly the pattern `demo-match.test.ts` already uses for
   * `runDemoMatch` itself — without ever hitting a real job board API or
   * requiring real source credentials to be configured in the test
   * environment.
   */
  resolveSourceIds: (
    sourceIds: string[],
  ) => ReturnType<typeof buildSourceSelection> = buildSourceSelection,
): void {
  async function loadResumeText(resumeId: string): Promise<string | undefined> {
    const rows = await db
      .select({ resumeText: resumes.resumeText })
      .from(resumes)
      .where(eq(resumes.id, resumeId))
      .limit(1);
    return rows[0]?.resumeText;
  }

  function resolveSources(
    sourceIds: string[],
  ):
    | { ok: true; sources: JobSource[]; skipped: SkippedSource[] }
    | { ok: false; skipped: SkippedSource[] } {
    const { sources, skipped } = resolveSourceIds(sourceIds);
    if (sources.length === 0) return { ok: false, skipped };
    return { ok: true, sources, skipped };
  }

  /** Best-effort: if this fails, the run's actual outcome is already
   * either persisted (success) or simply unmarked (see markSearchComplete's
   * doc comment in demo-match.ts) — a failed marker write must never throw
   * inside a `.catch()` handler and mask the real error. */
  async function markSearchFailed(searchId: string): Promise<void> {
    try {
      await db
        .update(searchesTable)
        .set({ status: "failed" })
        .where(eq(searchesTable.id, searchId));
    } catch (err) {
      app.log.error({ err, searchId }, "failed to mark searches.status = 'failed'");
    }
  }

  app.post<{ Body: SearchBody }>(
    "/searches/estimate",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds, criteria } = request.body;
      const resumeText = await loadResumeText(resumeId);
      if (resumeText === undefined) {
        return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
      }

      const resolved = resolveSources(sourceIds);
      if (!resolved.ok) {
        return reply.code(400).send({
          error: "None of the requested sourceIds could be used.",
          skippedSources: resolved.skipped,
        });
      }

      const result = await runDemoMatch({
        db,
        sources: resolved.sources,
        resumeText,
        scoreJob: NEVER_SCORE,
        filter: compileFilter(criteria),
        estimateOnly: true,
        outputPath: tempOutputPath(`estimate-${randomUUID()}`),
      });

      // No `searchId` in this response (ticket 59fdc52 review round 2):
      // this run's `searches` row is never registered in `searchRuns`, so
      // polling it via GET /searches/:id used to fall through to the
      // DB-fallback branch and report `status: "complete"` plus a false
      // "process restarted" note — a frontend polling that id would render
      // a finished search with zero results. Simplest correct fix: don't
      // hand out an id there's no honest way to poll.
      const response: EstimateSearchResponse = {
        resumeId,
        costEstimate: result.costEstimate,
        costEstimateDescription: describeCostEstimate(result.costEstimate),
        candidatesNeedingScore: result.candidatesNeedingScore,
        scoreThreshold: result.scoreThreshold,
        cappedCount: result.cappedCount,
        alreadyScored: result.skipped,
        sourceOutcomes: result.sourceOutcomes,
        skippedSources: resolved.skipped,
      };
      return reply.send(response);
    },
  );

  app.post<{ Body: SearchBody }>(
    "/searches",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds, criteria } = request.body;
      const resumeText = await loadResumeText(resumeId);
      if (resumeText === undefined) {
        return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
      }

      const inFlightId = inFlightByResume.get(resumeId);
      if (inFlightId !== undefined) {
        return reply.code(409).send({
          error: `A search is already running for this resume.`,
          searchId: inFlightId,
        });
      }

      const resolved = resolveSources(sourceIds);
      if (!resolved.ok) {
        return reply.code(400).send({
          error: "None of the requested sourceIds could be used.",
          skippedSources: resolved.skipped,
        });
      }

      const searchId = randomUUID();
      searchRuns.set(searchId, { status: "pending", resumeId });
      pruneSearchRuns();
      inFlightByResume.set(resumeId, searchId);

      // Fire-and-forget: this is the one HTTP call in the whole API that
      // spends real money (real Claude calls inside runDemoMatch) and can
      // run for minutes (DEFAULT_SCORE_THRESHOLD's doc comment in
      // demo-match.ts), so the client polls GET /searches/:id rather than
      // holding one HTTP request open for the whole run.
      runDemoMatch({
        db,
        sources: resolved.sources,
        resumeText,
        scoreJob: getScoreJob(),
        filter: compileFilter(criteria),
        searchId,
        outputPath: tempOutputPath(searchId),
      })
        .then((result) => {
          searchRuns.set(searchId, { status: "complete", resumeId, result });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          searchRuns.set(searchId, { status: "failed", resumeId, error: message });
          // Best-effort — see markSearchFailed's doc comment. Deliberately
          // not awaited from inside this .catch (nothing here can un-fail
          // this run); fire it and let it log on its own failure.
          void markSearchFailed(searchId);
        })
        .finally(() => {
          if (inFlightByResume.get(resumeId) === searchId) inFlightByResume.delete(resumeId);
        });

      const response: StartSearchResponse = {
        searchId,
        status: "pending",
        skippedSources: resolved.skipped,
      };
      return reply.code(202).send(response);
    },
  );

  app.get<{ Params: { id: string } }>("/searches/:id", async (request, reply) => {
    const searchId = request.params.id;
    const state = searchRuns.get(searchId);

    if (!state) {
      // Not in the in-memory tracker: either an unknown id, or a real run
      // from before this process last restarted (the tracker doesn't
      // survive a restart — see its doc comment). Distinguish those by
      // checking the database, and — critically — trust `searches.status`
      // rather than assuming a row existing means the run finished (ticket
      // 59fdc52 review round 2): a row can exist with `status = 'running'`
      // forever if the process died mid-scoring, and that must never be
      // reported as "complete".
      const rows = await db
        .select({
          id: searchesTable.id,
          resumeId: searchesTable.resumeId,
          status: searchesTable.status,
        })
        .from(searchesTable)
        .where(eq(searchesTable.id, searchId))
        .limit(1);
      if (rows.length === 0) {
        return reply.code(404).send({ error: `No search with id "${searchId}".` });
      }
      const row = rows[0]!;
      if (row.status === "failed") {
        const response: SearchStatusResponse = {
          searchId: row.id,
          resumeId: row.resumeId,
          status: "failed",
        };
        return reply.send(response);
      }
      // "running" here means the row's own completion marker was never
      // set — either this run is genuinely still in progress (in another
      // process, or before this process restarted), or it died before
      // reaching the line that sets it. Both are honestly "incomplete",
      // never "complete".
      const status = row.status === "complete" ? "complete" : "incomplete";
      const response: SearchStatusResponse = {
        searchId: row.id,
        resumeId: row.resumeId,
        status,
        note:
          status === "complete"
            ? "This API process restarted since this search ran, so live progress info was " +
              "lost. Its results are in the database — see GET /resumes/:id/results."
            : "This search's completion marker was never set — it may still be running " +
              "elsewhere, or it may have died before finishing. Results scored so far, if " +
              "any, are in the database — see GET /resumes/:id/results.",
      };
      return reply.send(response);
    }

    if (state.status === "pending") {
      const response: SearchStatusResponse = {
        searchId,
        status: "pending",
        resumeId: state.resumeId,
      };
      return reply.send(response);
    }
    if (state.status === "failed") {
      const response: SearchStatusResponse = {
        searchId,
        status: "failed",
        resumeId: state.resumeId,
        error: state.error,
      };
      return reply.send(response);
    }
    const response: SearchStatusResponse = {
      searchId,
      status: "complete",
      resumeId: state.resumeId,
      newlyScored: state.result.newlyScored,
      failed: state.result.failed,
      skipped: state.result.skipped,
      cappedCount: state.result.cappedCount,
      costEstimate: state.result.costEstimate,
      sourceOutcomes: state.result.sourceOutcomes,
    };
    return reply.send(response);
  });
}
