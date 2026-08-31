/**
 * Resume paste/read + the filtered results listing (ticket 59fdc52).
 *
 * Resume input is paste-only (decided 2026-08-29 on git-bug a217859 — see
 * that ticket's comments for the PDF-extraction failure mode this avoids;
 * as of this ticket its own docs/adr/002-resume-input.md acceptance
 * criterion is still unwritten) — a `POST` taking raw text, never a file
 * upload. Resumes are content-addressed by `resumeHash`, so this reuses
 * `getOrCreateResumeId` from demo-match.ts rather than reimplementing the
 * hash-then-upsert logic.
 *
 * `GET /resumes/:id/results` is the filtering endpoint the frontend's source
 * toggles and score-floor slider hit — decision #1 (git-bug 484889d,
 * 2026-08-29 note): filtering an existing corpus is free and instant and
 * must never re-fetch or re-score. This route only ever reads `job_matches`
 * joined to `jobs`; it has no path to a `ScoreJobFn` or a `JobSource` at
 * all, so there is no way for a filter change to accidentally spend money.
 */
import type {
  CreateResumeResponse,
  GetResumeResponse,
  GetResumeResultsResponse,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getOrCreateResumeId } from "../demo-match.js";
import { jobMatches, jobs as jobsTable, resumes } from "../db/schema.js";
import { SOURCE_DESCRIPTORS } from "../db/seed.js";

/**
 * Generous ceiling for a pasted resume — well above any real resume, well
 * below "someone pasted the wrong document." Fastify's `bodyLimit` (set in
 * index.ts's `buildApp`) already rejects a wildly oversized request body
 * (e.g. an accidental 30 MB paste) with 413 before this handler even runs;
 * this catches a technically-small-enough-to-parse-as-JSON body that is
 * still an unreasonable resume, with a clearer error than a raw body-size
 * rejection would give.
 */
const MAX_RESUME_TEXT_LENGTH = 200_000;

const createResumeBodySchema = {
  type: "object",
  required: ["resumeText"],
  properties: {
    resumeText: { type: "string" },
  },
  additionalProperties: false,
} as const;

export function registerResumeRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): void {
  app.post<{ Body: { resumeText: string } }>(
    "/resumes",
    { schema: { body: createResumeBodySchema } },
    async (request, reply) => {
      const { resumeText } = request.body;
      const trimmed = resumeText.trim();

      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "resumeText must not be empty." });
      }
      if (resumeText.length > MAX_RESUME_TEXT_LENGTH) {
        return reply.code(400).send({
          error: `resumeText exceeds the ${MAX_RESUME_TEXT_LENGTH}-character limit (got ${resumeText.length}).`,
        });
      }

      // Content-addressed find-or-create (ticket 620ca30): posting the same
      // text twice returns the same id rather than duplicating a row, and a
      // genuinely new resume gets a new id whose scores start empty (no
      // job_matches rows exist for it yet — see GET /resumes/:id/results).
      const id = await getOrCreateResumeId(db, resumeText);
      const response: CreateResumeResponse = { id };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Params: { id: string } }>("/resumes/:id", async (request, reply) => {
    const rows = await db
      .select({ id: resumes.id, resumeText: resumes.resumeText })
      .from(resumes)
      .where(eq(resumes.id, request.params.id))
      .limit(1);

    if (rows.length === 0) {
      return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
    }
    const response: GetResumeResponse = rows[0]!;
    return reply.send(response);
  });

  app.get<{
    Params: { id: string };
    Querystring: { source?: string; minScore?: string; status?: string };
  }>("/resumes/:id/results", async (request, reply) => {
    const resumeId = request.params.id;
    const { source, minScore, status } = request.query;

    // Ticket 0c319b2 (job status: saved/resume_optimized/applied/dismissed)
    // is not merged as of this ticket — checked via `git-bug bug show
    // 0c319b2` before writing this route. Rather than silently ignore a
    // `status` param the caller explicitly sent (which would look like
    // filtering happened when it didn't), this fails loudly: no schema for
    // it exists yet to filter against.
    if (status !== undefined) {
      return reply.code(400).send({
        error:
          "Filtering by job status is not available yet — ticket 0c319b2 (job status schema) " +
          "is not merged. Omit the status parameter.",
      });
    }

    const resumeRows = await db
      .select({ id: resumes.id })
      .from(resumes)
      .where(eq(resumes.id, resumeId))
      .limit(1);
    if (resumeRows.length === 0) {
      return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
    }

    // Ticket 59fdc52 review round 2: an unknown ?source= used to silently
    // return an empty result set — indistinguishable from "this resume
    // genuinely has zero matches from a real source", the exact
    // make-broken-look-different-from-empty failure the DLQ/source-health
    // design (git-bug 59fdc52's Notes) exists to avoid elsewhere. Validated
    // against the same canonical id list `GET /sources` and the ingestion
    // FK both use, not redeclared.
    const knownSourceIds = new Set(SOURCE_DESCRIPTORS.map((d) => d.id as string));
    if (source !== undefined && !knownSourceIds.has(source)) {
      return reply.code(400).send({
        error: `Unknown source "${source}" (known ids: ${[...knownSourceIds].join(", ")}).`,
      });
    }

    let minScoreNum: number | undefined;
    if (minScore !== undefined) {
      minScoreNum = Number(minScore);
      if (!Number.isFinite(minScoreNum)) {
        return reply.code(400).send({ error: `minScore must be a number, got "${minScore}".` });
      }
    }

    const conditions = [eq(jobMatches.resumeId, resumeId)];
    if (source !== undefined) conditions.push(eq(jobsTable.dataSource, source));
    if (minScoreNum !== undefined) conditions.push(gte(jobMatches.matchScore, minScoreNum));

    const rows = await db
      .select({
        jobId: jobsTable.id,
        externalId: jobsTable.externalId,
        title: jobsTable.title,
        company: jobsTable.company,
        dataSource: jobsTable.dataSource,
        location: jobsTable.location,
        locationType: jobsTable.locationType,
        applyUrl: jobsTable.linkToApply,
        matchScore: jobMatches.matchScore,
        rationale: jobMatches.rationale,
        strengths: jobMatches.strengths,
        gaps: jobMatches.gaps,
      })
      .from(jobMatches)
      .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobMatches.matchScore));

    // The "hidden count" the frontend's score-floor design (git-bug
    // 484889d/1b9f81e) needs: a short filtered list must never read as a
    // broken/empty run when it is actually a strict floor hiding real
    // results. Only computed when a floor was actually applied.
    let hiddenBelowFloor: number | undefined;
    if (minScoreNum !== undefined) {
      const hiddenConditions = [
        eq(jobMatches.resumeId, resumeId),
        lt(jobMatches.matchScore, minScoreNum),
      ];
      if (source !== undefined) hiddenConditions.push(eq(jobsTable.dataSource, source));
      const hiddenRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobMatches)
        .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
        .where(and(...hiddenConditions));
      hiddenBelowFloor = hiddenRows[0]?.count ?? 0;
    }

    const response: GetResumeResultsResponse = {
      resumeId,
      results: rows.map((r) => ({ ...r, strengths: r.strengths ?? [], gaps: r.gaps ?? [] })),
      hiddenBelowFloor,
    };
    return reply.send(response);
  });
}
