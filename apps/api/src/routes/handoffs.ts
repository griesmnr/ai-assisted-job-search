/**
 * `POST /handoffs` + `GET /handoffs/:id` (ticket dbfd594) — the cross-app
 * handoff "Optimize Resume" uses to send a job description + resume text
 * to Nicole's separate resume-tailoring app (a different origin, its own
 * deployment).
 *
 * WHY A SERVER-SIDE HANDOFF, NOT A DIRECT LINK PAYLOAD: that other app
 * can't be written to via `localStorage` from a link click (localStorage
 * is origin-scoped — a fundamental browser restriction, not a
 * configuration gap), and cramming both full texts into the URL itself
 * doesn't work either — resume text alone can run up to
 * `MAX_RESUME_TEXT_LENGTH` (200K chars, routes/resumes.ts), far past any
 * browser's safe URL length. Instead, `POST /handoffs` snapshots the real
 * payload into its own row, and the link the user actually clicks carries
 * only `?import=<the GET /handoffs/:id URL>` — a small, safe thing to put
 * in a URL. The receiving app does a plain `fetch()` on it.
 *
 * WHY SNAPSHOTTED, NOT LIVE-JOINED: see `handoffs`'s own doc comment in
 * db/schema.ts — a handoff is a point-in-time payload, so it must keep
 * resolving correctly even if the underlying `jobs`/`resumes` row changes
 * (or is later deleted) before the short TTL expires.
 *
 * WHY THE ROW'S OWN `id` IS THE TOKEN: a UUID is already unguessable: a
 * separate `token` column would be the same amount of secrecy for more
 * schema.
 *
 * CORS: `GET /handoffs/:id` needs a route-level CORS override
 * (`config.cors.origin: true`, — see this file's `getHandoff` route
 * below) because the app's GLOBAL CORS policy (index.ts's `buildApp`) is
 * deliberately locked to `localhost`/`127.0.0.1` — for a different,
 * unrelated reason: `POST /searches` spends real money and must not be
 * reachable by an arbitrary open tab via a drive-by cross-origin request.
 * This route has a different risk profile and doesn't need that same
 * lockdown: it's a read-only GET, it spends nothing, and its real access
 * control is the token itself (an unguessable UUID) plus a short TTL —
 * not which origin asks for it. Nicole's resume-tailoring app runs on its
 * own separate origin (a different Vercel deployment) and MUST be able to
 * fetch this route cross-origin for the whole handoff to work at all.
 * `POST /handoffs` itself keeps the default, restrictive global CORS —
 * only THIS app's own frontend (running from a matching origin) is
 * allowed to mint a handoff in the first place.
 */
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { handoffs, jobs as jobsTable, resumes } from "../db/schema.js";

/**
 * Deliberately short — a handoff exists to survive exactly one click
 * (POST here, then immediately navigate to the other app, which fetches
 * it right away). 10 minutes covers a slow page load or a moment's
 * hesitation without leaving old payloads readable indefinitely by
 * anyone who happened to see a stale link.
 */
const HANDOFF_TTL_MS = 10 * 60 * 1000;

const createHandoffBodySchema = {
  type: "object",
  required: ["jobId", "resumeId"],
  properties: {
    jobId: { type: "string", minLength: 1 },
    resumeId: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;

type CreateHandoffBody = { jobId: string; resumeId: string };

export type CreateHandoffResponse = {
  id: string;
  expiresAt: string;
};

export type GetHandoffResponse = {
  resumeText: string;
  jobDescription: string;
  jobTitle: string;
  company: string;
};

export function registerHandoffRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): void {
  app.post<{ Body: CreateHandoffBody }>(
    "/handoffs",
    { schema: { body: createHandoffBodySchema } },
    async (request, reply) => {
      const { jobId, resumeId } = request.body;

      const jobRows = await db
        .select({
          title: jobsTable.title,
          description: jobsTable.description,
          company: jobsTable.company,
        })
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId))
        .limit(1);
      if (jobRows.length === 0) {
        return reply.code(404).send({ error: `No job with id "${jobId}".` });
      }

      const resumeRows = await db
        .select({ resumeText: resumes.resumeText })
        .from(resumes)
        .where(eq(resumes.id, resumeId))
        .limit(1);
      if (resumeRows.length === 0) {
        return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
      }

      const job = jobRows[0]!;
      const resume = resumeRows[0]!;
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);

      await db.insert(handoffs).values({
        id,
        jobId,
        resumeId,
        resumeText: resume.resumeText,
        jobDescription: job.description,
        jobTitle: job.title,
        company: job.company,
        createdAt: now,
        expiresAt,
      });

      const response: CreateHandoffResponse = { id, expiresAt: expiresAt.toISOString() };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/handoffs/:id",
    // Route-level CORS override -- see this file's header comment for why
    // this ONE route needs to differ from the app's default,
    // localhost-only global CORS policy.
    { config: { cors: { origin: true } } },
    async (request, reply) => {
      const rows = await db
        .select({
          resumeText: handoffs.resumeText,
          jobDescription: handoffs.jobDescription,
          jobTitle: handoffs.jobTitle,
          company: handoffs.company,
        })
        .from(handoffs)
        // A missing id and an EXPIRED id both 404 identically -- neither
        // is distinguished for the caller. Telling "expired" apart from
        // "never existed" would only help someone probing for valid ids,
        // never a legitimate caller (the link either still works or it
        // doesn't).
        .where(and(eq(handoffs.id, request.params.id), gt(handoffs.expiresAt, new Date())))
        .limit(1);

      if (rows.length === 0) {
        return reply.code(404).send({ error: `No live handoff with id "${request.params.id}".` });
      }

      const response: GetHandoffResponse = rows[0]!;
      return reply.send(response);
    },
  );
}
