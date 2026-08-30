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
 * Neither route passes a `filter` to `runDemoMatch` — both take
 * `runDemoMatch`'s default (identity: every ingested job is a scoring
 * candidate), NOT `demo-match.ts`'s own `filterSoftwareEngineeringJobs`.
 * That filter's title regex (software engineer/full-stack/back-end/...) and
 * its location regex (hardcodes the Seattle/PNW + remote-US preference from
 * git-bug b723fb9) are the owner's personal criteria — exactly what the
 * "no hardcoded assumptions about one person's resume or locations" v1 bar
 * (git-bug 484889d, 2026-08-29 note) rules out for a surface meant to work
 * for anyone's resume. Real title/location fit is what the resume-vs-
 * posting scoring call is FOR; a hardcoded pre-filter ahead of it would
 * silently drop postings for every user who isn't Nicole before Claude ever
 * saw them. The tradeoff: without `filterSoftwareEngineeringJobs`'s
 * narrowing, a source with a large board (SmartRecruiters: thousands of
 * postings for one employer) ingests everything, and `DEFAULT_SCORE_THRESHOLD`
 * (demo-match.ts) is what keeps that from becoming an uncapped bill — see
 * its doc comment.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
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
import { buildSourceSelection, type SkippedSource } from "../sources/registry.js";
import type { JobSource } from "../sources/types.js";

const searchBodySchema = {
  type: "object",
  required: ["resumeId", "sourceIds"],
  properties: {
    resumeId: { type: "string", minLength: 1 },
    sourceIds: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  additionalProperties: false,
} as const;

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
 * (see below), and `GET /resumes/:id/results` always reads straight from
 * the database (decision #3: results come from the database, never from
 * in-memory state).
 */
const searchRuns = new Map<string, SearchRunState>();

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
    const unique = new Set(sourceIds);
    if (unique.size !== sourceIds.length) {
      return {
        ok: false,
        skipped: [{ id: sourceIds.join(","), reason: "sourceIds must not contain duplicates" }],
      };
    }
    const { sources, skipped } = resolveSourceIds(sourceIds);
    if (sources.length === 0) return { ok: false, skipped };
    return { ok: true, sources, skipped };
  }

  app.post<{ Body: { resumeId: string; sourceIds: string[] } }>(
    "/searches/estimate",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds } = request.body;
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
        estimateOnly: true,
        outputPath: tempOutputPath(`estimate-${randomUUID()}`),
      });

      return reply.send({
        resumeId,
        searchId: result.searchId,
        costEstimate: result.costEstimate,
        costEstimateDescription: describeCostEstimate(result.costEstimate),
        candidatesNeedingScore: result.candidatesNeedingScore,
        alreadyScored: result.skipped,
        sourceOutcomes: result.sourceOutcomes,
        skippedSources: resolved.skipped,
      });
    },
  );

  app.post<{ Body: { resumeId: string; sourceIds: string[] } }>(
    "/searches",
    { schema: { body: searchBodySchema } },
    async (request, reply) => {
      const { resumeId, sourceIds } = request.body;
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

      const searchId = randomUUID();
      searchRuns.set(searchId, { status: "pending", resumeId });

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
        searchId,
        outputPath: tempOutputPath(searchId),
      })
        .then((result) => {
          searchRuns.set(searchId, { status: "complete", resumeId, result });
        })
        .catch((err: unknown) => {
          searchRuns.set(searchId, {
            status: "failed",
            resumeId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      return reply
        .code(202)
        .send({ searchId, status: "pending", skippedSources: resolved.skipped });
    },
  );

  app.get<{ Params: { id: string } }>("/searches/:id", async (request, reply) => {
    const searchId = request.params.id;
    const state = searchRuns.get(searchId);

    if (!state) {
      // Not in the in-memory tracker: either an unknown id, or a real run
      // from before this process last restarted (the tracker doesn't
      // survive a restart — see its doc comment). Distinguish those by
      // checking the database: a `searches` row existing means this really
      // happened and its results are fully queryable, just without live
      // progress tracking.
      const rows = await db
        .select({ id: searchesTable.id, resumeId: searchesTable.resumeId })
        .from(searchesTable)
        .where(eq(searchesTable.id, searchId))
        .limit(1);
      if (rows.length === 0) {
        return reply.code(404).send({ error: `No search with id "${searchId}".` });
      }
      return reply.send({
        searchId: rows[0]!.id,
        resumeId: rows[0]!.resumeId,
        status: "complete",
        note:
          "This API process restarted since this search ran, so live progress info was lost. " +
          "Its results are in the database — see GET /resumes/:id/results.",
      });
    }

    if (state.status === "pending") {
      return reply.send({ searchId, status: "pending", resumeId: state.resumeId });
    }
    if (state.status === "failed") {
      return reply.send({
        searchId,
        status: "failed",
        resumeId: state.resumeId,
        error: state.error,
      });
    }
    return reply.send({
      searchId,
      status: "complete",
      resumeId: state.resumeId,
      newlyScored: state.result.newlyScored,
      failed: state.result.failed,
      skipped: state.result.skipped,
      cappedCount: state.result.cappedCount,
      costEstimate: state.result.costEstimate,
      sourceOutcomes: state.result.sourceOutcomes,
    });
  });
}
