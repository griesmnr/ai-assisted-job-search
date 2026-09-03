/**
 * `POST /jobs/:id/status` — the write half of ticket 0c319b2's job-status
 * model (ticket 484889d).
 *
 * GAP THIS FILLS: ticket 0c319b2 added the `user_job_statuses` table and one
 * READ-ONLY helper (`fetchAppliedJobIds`, apps/api/src/demo-match.ts) used
 * internally by the scoring pipeline to skip re-suggesting applied jobs.
 * Nothing in the REST surface (ticket 59fdc52, merged before 0c319b2) ever
 * wrote to this table, and nothing read arbitrary per-job status either —
 * checked via `git-bug bug show 0c319b2` and `rg userJobStatuses
 * apps/api/src` before writing this ticket's frontend, per 484889d's "audit
 * what the REST API currently actually returns" instruction. Both gaps
 * (read + write) are small, contained additions to the existing REST
 * surface, so this ticket fills them rather than stubbing them client-side:
 * this file is the write path; `GET /resumes/:id/results`'s new `status`
 * field and `?status=` filter (routes/resumes.ts) are the read path.
 *
 * Scope, deliberately narrow: set a job's status and read it back
 * (piggybacked on the results list, not a separate GET route — the ticket
 * asks for "GET current status per job in a results response," and results
 * are the only place the frontend needs it). No history, no "unset",
 * no bulk endpoint — none of those were asked for and the schema doesn't
 * model history either (a status row is overwritten in place, not
 * versioned).
 */
import { randomUUID } from "node:crypto";
import type { SetJobStatusResponse, UserJobStatus } from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jobs as jobsTable, resumes, userJobStatuses } from "../db/schema.js";

const KNOWN_STATUSES: readonly UserJobStatus[] = [
  "saved",
  "resume_optimized",
  "applied",
  "dismissed",
];

const setStatusBodySchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string", enum: [...KNOWN_STATUSES] },
    resumeId: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type SetStatusBody = { status: UserJobStatus; resumeId?: string };

export function registerJobStatusRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): void {
  app.post<{ Params: { id: string }; Body: SetStatusBody }>(
    "/jobs/:id/status",
    { schema: { body: setStatusBodySchema } },
    async (request, reply) => {
      const jobId = request.params.id;
      const { status, resumeId } = request.body;

      const jobRows = await db
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId))
        .limit(1);
      if (jobRows.length === 0) {
        return reply.code(404).send({ error: `No job with id "${jobId}".` });
      }

      if (resumeId !== undefined) {
        const resumeRows = await db
          .select({ id: resumes.id })
          .from(resumes)
          .where(eq(resumes.id, resumeId))
          .limit(1);
        if (resumeRows.length === 0) {
          return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
        }
      }

      const now = new Date();
      // `appliedAt` (schema.ts) records when an application was actually
      // sent — set only when the status being written IS "applied", left
      // untouched (via COALESCE, not overwritten) on every other status
      // write to the SAME job, so re-saving/re-dismissing an already-applied
      // job never erases its real applied timestamp.
      const appliedAt = status === "applied" ? now : null;

      await db
        .insert(userJobStatuses)
        .values({
          id: randomUUID(),
          jobId,
          status,
          resumeId: resumeId ?? null,
          createdAt: now,
          updatedAt: now,
          appliedAt,
        })
        .onConflictDoUpdate({
          target: userJobStatuses.jobId,
          set: {
            status,
            resumeId: resumeId ?? null,
            updatedAt: now,
            // Ticket 484889d: `excluded.applied_at` is this write's proposed
            // value — `now` when `status === "applied"`, else the `null`
            // set in `.values(...)` above. COALESCE falls back to the
            // EXISTING row's `applied_at` (unqualified, since inside an
            // upsert's UPDATE the target table's own columns are the
            // pre-conflict row) whenever this write isn't itself an
            // "applied" write, so a later save/dismiss of an already-applied
            // job never erases the real timestamp it was applied at.
            appliedAt: sql`coalesce(excluded.applied_at, ${userJobStatuses.appliedAt})`,
          },
        });

      const response: SetJobStatusResponse = { jobId, status, updatedAt: now.toISOString() };
      return reply.send(response);
    },
  );
}
