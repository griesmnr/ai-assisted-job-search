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
import { type SetJobStatusResponse, type UserJobStatus, USER_JOB_STATUSES } from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { jobs as jobsTable, resumes, userJobStatuses } from "../db/schema.js";

const setStatusBodySchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string", enum: [...USER_JOB_STATUSES] },
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
            // Review round F3: `resumeId` needs the SAME protection, for
            // the same reason, and this was an unconditional overwrite
            // before this fix (`resumeId: resumeId ?? null` on every
            // status write, regardless of status). Concrete failure this
            // caused: apply to job X with resume "tailored-v2" (row:
            // applied, appliedAt=T, resumeId=tailored-v2 — correct). Later
            // load a different resume ("generic-v3") and click "Saved" on
            // the SAME job — a status change, not a new application. The
            // old code overwrote resumeId to "generic-v3" while appliedAt
            // correctly stayed T, leaving the row asserting "applied at T
            // with generic-v3" when the real application used
            // tailored-v2 — exactly the scenario this column's own doc
            // comment (schema.ts) names as its reason for existing.
            //
            // NOT a plain `coalesce(excluded.resume_id, existing)` like
            // appliedAt above — deliberately different, and here's why:
            // appliedAt's COALESCE only works because `.values()` above
            // already forces `appliedAt` to `null` on any non-"applied"
            // write, so `excluded.applied_at` is guaranteed null in that
            // case and COALESCE has nothing to prefer over the existing
            // value. `resumeId` in `.values()` CANNOT be gated the same
            // way — `resumeId: resumeId ?? null` must stay unconditional
            // there, because a non-"applied" write (e.g. a first-ever
            // "saved"/"resume_optimized" write, which takes the INSERT
            // path, not this UPDATE path) is still supposed to record
            // whatever resume was in hand (see this file's own
            // "records resumeId when given" test, which writes
            // status:"resume_optimized" with a resumeId on a job's FIRST
            // write and asserts it's stored). That means `excluded.resume_id`
            // can legitimately be non-null even on a non-"applied" write,
            // so `coalesce(excluded.resume_id, existing)` would still take
            // the new, wrong value here — the exact bug this fix closes.
            // Instead: a write that IS "applied" takes the new resumeId
            // (recording which resume the NEW application used); every
            // other write ignores `excluded` entirely and re-asserts the
            // EXISTING row's own `resumeId` (unqualified column reference —
            // same "refers to the pre-conflict row" mechanism the appliedAt
            // COALESCE's second argument relies on), so `excluded` can never
            // win on a non-"applied" write regardless of what resumeId
            // happened to be attached to that write's request body.
            resumeId: status === "applied" ? (resumeId ?? null) : sql`${userJobStatuses.resumeId}`,
          },
        });

      const response: SetJobStatusResponse = { jobId, status, updatedAt: now.toISOString() };
      return reply.send(response);
    },
  );
}
