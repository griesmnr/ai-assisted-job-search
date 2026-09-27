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
import { requireUserId } from "../identity.js";

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
  /**
   * AUDIT VERDICT (ticket 3fc1e5e): NEEDED PER-USER SCOPING ON `resumeId`
   * -- now scoped. This one was genuinely arguable, so here is the argument
   * in full, because the case AGAINST scoping it is real and was the
   * starting assumption.
   *
   * THE CASE FOR LEAVING IT: this route grants no capability that a fixed
   * `GET /resumes/:id` doesn't already deny. If a caller can't read
   * someone else's resume text directly any more, then minting a handoff to
   * launder it out is the only remaining path -- and closing `GET
   * /resumes/:id` (this same ticket) is what actually shuts the front door.
   * Scoping here could look like belt-on-belt.
   *
   * WHY IT IS SCOPED ANYWAY -- three reasons, the third decisive:
   *
   *   1. THIS ROUTE PERSISTS A COPY. Every other read path in this audit
   *      returns bytes and forgets them; this one writes the resume text
   *      into a NEW `handoffs` row (snapshotted, by design -- see this
   *      file's header and `handoffs` in schema.ts). An unscoped read that
   *      leaves a durable copy behind is the same shape of defect as the
   *      resume-text COPY b2f9dfd's review found in `POST
   *      /searches/estimate`, and that review's own conclusion was that a
   *      copy is not a gap a later access-control fix can clean up after
   *      the fact. The row outlives whatever ownership state `resumes` is
   *      in later.
   *   2. THE COPY IS READABLE WITH NO IDENTITY AT ALL. `GET /handoffs/:id`
   *      is one of exactly two routes exempt from the `x-user-id`
   *      requirement (identity.ts's `registerIdentity`) -- deliberately,
   *      because a separate-origin app fetches it. So the text this route
   *      persists is reachable by a caller presenting no user id
   *      whatsoever. Ownership therefore CANNOT be enforced on the read
   *      side of this pair; the only place it can be enforced is here, at
   *      mint time. That asymmetry is what makes this route different from
   *      every other by-id route in the audit rather than merely redundant
   *      with them.
   *   3. "IT GRANTS NO NEW CAPABILITY" IS AN ARGUMENT ABOUT ANOTHER FILE.
   *      It holds only while `GET /resumes/:id` stays scoped. Leaving one
   *      resume-text read deliberately unscoped, with a comment explaining
   *      that some OTHER route's check is what makes it safe, is exactly
   *      the coupling this ticket exists to remove -- it is how b2f9dfd's
   *      deferred gaps became four separate real ones.
   *
   * `jobId` is deliberately NOT scoped: `jobs` is a global corpus of
   * postings with no owner column (schema.ts), shared by every user by
   * design, and `jobDescription`/`jobTitle`/`company` are public posting
   * data. Only `resumeId` names something owned.
   */
  app.post<{ Body: CreateHandoffBody }>(
    "/handoffs",
    { schema: { body: createHandoffBodySchema } },
    async (request, reply) => {
      const { jobId, resumeId } = request.body;
      const userId = requireUserId(request);

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

      // Ticket 3fc1e5e: scoped to the caller's own resume -- see this
      // route's AUDIT VERDICT above. 404 (not 403) on someone else's id,
      // the same convention every other by-id route in this app uses, so
      // "not yours" is indistinguishable from "never existed".
      const resumeRows = await db
        .select({ resumeText: resumes.resumeText })
        .from(resumes)
        .where(and(eq(resumes.id, resumeId), eq(resumes.userId, userId)))
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

  /**
   * AUDIT VERDICT (ticket 3fc1e5e): DELIBERATELY NOT USER-SCOPED, and it
   * CANNOT be. This is one of exactly two routes exempt from the
   * `x-user-id` requirement (identity.ts's `registerIdentity`), so there is
   * no `request.userId` here to scope BY -- `requireUserId` would throw on
   * this route by design, and that is precisely what its own doc comment
   * warns about. The exemption is not an oversight: Nicole's separate
   * resume-tailoring app runs on another origin, fetches this URL directly,
   * and has no way to know this app's anonymous-id header scheme.
   *
   * Its access control is therefore what it always was, and it is real: an
   * unguessable 122-bit UUID plus a 10-minute TTL (`HANDOFF_TTL_MS`), the
   * same trust level identity.ts's own doc comment describes for the
   * `x-user-id` value itself. What ticket 3fc1e5e changed is the OTHER end
   * of the pair -- `POST /handoffs` now refuses to snapshot a resume the
   * caller doesn't own (see its verdict above), so every row this route can
   * serve was minted by the owner of the resume inside it. That is the
   * invariant that makes an identity-free read here acceptable, and it is
   * why the two verdicts in this file have to be read together.
   */
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
