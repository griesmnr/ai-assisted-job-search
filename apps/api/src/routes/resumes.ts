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
 * joined to `jobs` (and, as of ticket 484889d, left-joined to
 * `user_job_statuses` — still just a read); it has no path to a
 * `ScoreJobFn` or a `JobSource` at all, so there is no way for a filter
 * change to accidentally spend money.
 *
 * STATUS FILTERING (ticket 484889d): ticket 0c319b2 (job status schema) was
 * NOT merged when this route was first written — see the 400 rejection this
 * replaced in git history and its regression test's old title. It is merged
 * now (git-bug 0c319b2, main commit 77b7351), so `?status=` is real: a
 * caller can filter to one exact status, and when the param is omitted the
 * default view excludes `dismissed` jobs — per git-bug 484889d's decision
 * #2, "a dismissed job should leave the visible list." `saved` /
 * `resume_optimized` / `applied` / no-status-row-yet (`NULL`) all still
 * show by default; only an explicit `?status=dismissed` surfaces dismissed
 * jobs again (e.g. a future "dismissed" tab).
 */
import {
  type CreateResumeResponse,
  type GetResumeResponse,
  type GetResumeResultsResponse,
  type UserJobStatus,
  USER_JOB_STATUSES,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { and, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getOrCreateResumeId } from "../demo-match.js";
import { jobMatches, jobs as jobsTable, resumes, userJobStatuses } from "../db/schema.js";
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

    // Ticket 484889d: validated the same way ?source= is below — an
    // unrecognized status string must 400, not silently match nothing.
    // `USER_JOB_STATUSES` (review round F4) is the one canonical runtime
    // list backing `UserJobStatus`, shared with job-status.ts's own
    // validation instead of each route hand-duplicating it.
    if (status !== undefined && !USER_JOB_STATUSES.includes(status as UserJobStatus)) {
      return reply.code(400).send({
        error: `Unknown status "${status}" (known values: ${USER_JOB_STATUSES.join(", ")}).`,
      });
    }
    const statusFilter = status as UserJobStatus | undefined;

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

    // The default-dismissed-exclusion (ticket 484889d decision #2: "a
    // dismissed job should leave the visible list") applies whenever the
    // caller didn't ask for a specific status. `isNull(...)` covers a job
    // with no `user_job_statuses` row at all (the common case — most jobs
    // have never been touched), `ne(...)` covers one with a real row whose
    // status isn't `dismissed`. Postgres's `!=` is NULL, not true, against a
    // NULL column, which is exactly why the `isNull` half is needed
    // separately rather than relying on `ne` alone to include untouched rows.
    function statusCondition(): SQL {
      if (statusFilter !== undefined) return eq(userJobStatuses.status, statusFilter);
      return or(isNull(userJobStatuses.status), ne(userJobStatuses.status, "dismissed"))!;
    }

    const conditions = [eq(jobMatches.resumeId, resumeId), statusCondition()];
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
        status: userJobStatuses.status,
      })
      .from(jobMatches)
      .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
      .leftJoin(userJobStatuses, eq(userJobStatuses.jobId, jobsTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobMatches.matchScore));

    // The "hidden count" the frontend's score-floor design (git-bug
    // 484889d/1b9f81e) needs: a short filtered list must never read as a
    // broken/empty run when it is actually a strict floor hiding real
    // results. Only computed when a floor was actually applied, and — to
    // stay consistent with what "hidden" means for the main query above —
    // scoped to the same status view (a dismissed job below the floor is
    // hidden for its own reason, not double-counted here as floor-hidden).
    let hiddenBelowFloor: number | undefined;
    if (minScoreNum !== undefined) {
      const hiddenConditions = [
        eq(jobMatches.resumeId, resumeId),
        lt(jobMatches.matchScore, minScoreNum),
        statusCondition(),
      ];
      if (source !== undefined) hiddenConditions.push(eq(jobsTable.dataSource, source));
      const hiddenRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobMatches)
        .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
        .leftJoin(userJobStatuses, eq(userJobStatuses.jobId, jobsTable.id))
        .where(and(...hiddenConditions));
      hiddenBelowFloor = hiddenRows[0]?.count ?? 0;
    }

    const response: GetResumeResultsResponse = {
      resumeId,
      results: rows.map((r) => ({
        ...r,
        strengths: r.strengths ?? [],
        gaps: r.gaps ?? [],
        status: r.status ?? null,
      })),
      hiddenBelowFloor,
    };
    return reply.send(response);
  });
}
