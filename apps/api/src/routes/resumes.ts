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
 *
 * `GET /results` (ticket 3f0883f) is `GET /resumes/:id/results` widened to
 * every resume at once -- what "Already Scored Jobs" actually needs to be
 * a real browsable history rather than silently narrowed to whichever
 * resume happens to be active this session. Shares its query-building and
 * row-mapping with the single-resume route via `fetchScoredResults`/
 * `parseResultsQuery` below, rather than duplicating ~150 lines of nearly
 * identical Drizzle query for one conditional clause's difference.
 */
import {
  type CreateResumeResponse,
  type GetAllResultsResponse,
  type GetResumeResponse,
  type GetResumeResultsResponse,
  type UpdateResumeNicknameResponse,
  type UserJobStatus,
  USER_JOB_STATUSES,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getOrCreateResumeId } from "../demo-match.js";
import { jobMatches, jobs as jobsTable, resumes, userJobStatuses } from "../db/schema.js";
import { SOURCE_DESCRIPTORS } from "../db/seed.js";
import { looksLikeContractOrTemp } from "../sources/swe-filter.js";

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

/**
 * Ticket 38a7598: generous ceiling for a resume nickname, same reasoning as
 * `MAX_RESUME_TEXT_LENGTH` above but far smaller — this is a short label
 * ("Resume 1", "Senior SWE draft", ...), never a document, so a limit this
 * far above any real nickname still catches an obviously-wrong paste (e.g.
 * pasting the whole resume text into the nickname field by mistake) with a
 * clear error instead of silently accepting it.
 */
const MAX_RESUME_NICKNAME_LENGTH = 200;

const createResumeBodySchema = {
  type: "object",
  required: ["resumeText"],
  properties: {
    resumeText: { type: "string" },
  },
  additionalProperties: false,
} as const;

const updateResumeNicknameBodySchema = {
  type: "object",
  required: ["resumeNickname"],
  properties: {
    resumeNickname: { type: "string" },
  },
  additionalProperties: false,
} as const;

export function registerResumeRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  /**
   * Ticket 39b4a48: real title-keyword inference, one Claude call per
   * genuinely-new resume. Injected (not called directly) so route tests
   * can pass a fake instead of making a real paid call — same DI pattern
   * `registerSearchRoutes`'s `getScoreJob`/`resolveSourceIds` already use.
   */
  inferTitles: (resumeText: string) => Promise<string[]>,
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

      // Ticket 39b4a48: suggested title keywords, computed at most ONCE per
      // resume and cached on the row — `suggestedTitles === null` means
      // inference has never run for this id (schema.ts's column doc
      // comment). Since `id` is content-addressed, a resubmission of
      // identical resume text reuses the same row and never re-pays for
      // this. `inferTitles` itself is documented to never throw (see
      // resume-title-inference.ts) — a failure degrades to `[]` — but this
      // is wrapped in its own try/catch anyway, defense in depth: resume
      // creation succeeding must never depend on a callee honoring its own
      // contract (this is an injected dependency; a test double or a
      // future implementation could throw).
      const existingRow = await db
        .select({
          suggestedTitles: resumes.suggestedTitles,
          resumeNickname: resumes.resumeNickname,
        })
        .from(resumes)
        .where(eq(resumes.id, id))
        .limit(1);
      // Ticket 38a7598: whatever nickname the row already carries -- the
      // real default `getOrCreateResumeId` assigned at insert time for a
      // genuinely new resume, or a rename the user already made via
      // `PATCH /resumes/:id` for one that already existed. Never
      // recomputed or overwritten here; this route only READS it back.
      const resumeNickname = existingRow[0]?.resumeNickname;
      if (resumeNickname === undefined) {
        // Should be impossible: `getOrCreateResumeId` above just
        // guaranteed this row exists, and every row has had a NOT NULL
        // `resume_nickname` since migration 0010.
        throw new Error(`resume ${id} has no resume_nickname after getOrCreateResumeId`);
      }
      let suggestedTitles = existingRow[0]?.suggestedTitles ?? null;
      if (suggestedTitles === null) {
        try {
          suggestedTitles = await inferTitles(resumeText);
        } catch (err) {
          request.log.error({ err, id }, "title inference failed, continuing with none");
          suggestedTitles = [];
        }
        try {
          await db.update(resumes).set({ suggestedTitles }).where(eq(resumes.id, id));
        } catch (err) {
          // A failed WRITE of the (already-computed) suggestions must not
          // fail resume creation either — the response below still carries
          // the real suggestions this request computed; only a FUTURE
          // request for this same resume id would redundantly re-infer.
          request.log.error({ err, id }, "failed to persist suggestedTitles");
        }
      }

      const response: CreateResumeResponse = { id, suggestedTitles, resumeNickname };
      return reply.code(200).send(response);
    },
  );

  app.get<{ Params: { id: string } }>("/resumes/:id", async (request, reply) => {
    const rows = await db
      .select({
        id: resumes.id,
        resumeText: resumes.resumeText,
        resumeNickname: resumes.resumeNickname,
      })
      .from(resumes)
      .where(eq(resumes.id, request.params.id))
      .limit(1);

    if (rows.length === 0) {
      return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
    }
    const response: GetResumeResponse = rows[0]!;
    return reply.send(response);
  });

  // Ticket 38a7598: renames a resume's nickname. Deliberately minimal --
  // the only writable field is `resumeNickname` (never `resumeText`, which
  // would break content-addressing -- see UpdateResumeNicknameRequest's
  // doc comment in @app/shared). This is the one endpoint a rename made
  // AFTER the initial submission (per the ticket's own acceptance
  // criteria: "editable, not just at creation") goes through -- the
  // submission-time default/edit in ResumeInput.tsx also lands here, via
  // the same PATCH, once the resume already has an id.
  app.patch<{ Params: { id: string }; Body: { resumeNickname: string } }>(
    "/resumes/:id",
    { schema: { body: updateResumeNicknameBodySchema } },
    async (request, reply) => {
      const trimmed = request.body.resumeNickname.trim();
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "resumeNickname must not be empty." });
      }
      if (trimmed.length > MAX_RESUME_NICKNAME_LENGTH) {
        return reply.code(400).send({
          error: `resumeNickname exceeds the ${MAX_RESUME_NICKNAME_LENGTH}-character limit (got ${trimmed.length}).`,
        });
      }

      const rows = await db
        .update(resumes)
        .set({ resumeNickname: trimmed })
        .where(eq(resumes.id, request.params.id))
        .returning({ id: resumes.id, resumeNickname: resumes.resumeNickname });

      if (rows.length === 0) {
        return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
      }
      const response: UpdateResumeNicknameResponse = rows[0]!;
      return reply.send(response);
    },
  );

  type ResultsQuerystring = {
    source?: string;
    minScore?: string;
    status?: string;
    includeDismissed?: string;
  };

  type ParsedResultsQuery =
    | {
        ok: true;
        source?: string;
        minScoreNum?: number;
        statusFilter?: UserJobStatus;
        includeDismissedFlag: boolean;
      }
    | { ok: false; error: string };

  // Ticket 3f0883f: pulled out of the single-resume route below so the new
  // cross-resume `GET /results` doesn't hand-duplicate the exact same three
  // validations. Behavior is byte-for-byte what the single-resume route
  // always did.
  function parseResultsQuery(query: ResultsQuerystring): ParsedResultsQuery {
    const { source, minScore, status, includeDismissed } = query;

    // Ticket 484889d: validated the same way ?source= is below — an
    // unrecognized status string must 400, not silently match nothing.
    // `USER_JOB_STATUSES` (review round F4) is the one canonical runtime
    // list backing `UserJobStatus`, shared with job-status.ts's own
    // validation instead of each route hand-duplicating it.
    if (status !== undefined && !USER_JOB_STATUSES.includes(status as UserJobStatus)) {
      return {
        ok: false,
        error: `Unknown status "${status}" (known values: ${USER_JOB_STATUSES.join(", ")}).`,
      };
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
      return {
        ok: false,
        error: `Unknown source "${source}" (known ids: ${[...knownSourceIds].join(", ")}).`,
      };
    }

    let minScoreNum: number | undefined;
    if (minScore !== undefined) {
      minScoreNum = Number(minScore);
      if (!Number.isFinite(minScoreNum)) {
        return { ok: false, error: `minScore must be a number, got "${minScore}".` };
      }
    }

    return {
      ok: true,
      source,
      minScoreNum,
      statusFilter: status as UserJobStatus | undefined,
      includeDismissedFlag: includeDismissed === "true",
    };
  }

  // Ticket b182bde: `matchScore DESC` stays the whole ranking; this is a
  // TIEBREAK ONLY, used exclusively when two rows share the exact same
  // matchScore -- it can never move a row ahead of one with a strictly
  // higher score, because it's a second ORDER BY key, evaluated only
  // where the first key is equal. `well_matched` sorts first among ties,
  // `null` (never judged -- a legacy row, or one this ticket's own
  // migration just added a nullable column for) sits between a
  // known-good and a known-mismatch rather than being lumped in with
  // either, `underqualified` next, `overqualified` last. Mirrors
  // `levelFitTiebreakRank` in demo-match.ts's own (separate, JS-side)
  // sort for `fetchRankedResults` -- see that function's doc comment for
  // why the two aren't shared code.
  const levelFitRank = sql<number>`CASE ${jobMatches.levelFit}
    WHEN 'well_matched' THEN 0
    WHEN 'underqualified' THEN 2
    WHEN 'overqualified' THEN 3
    ELSE 1
  END`;

  type ResultsFilters = {
    /** Ticket 3f0883f: `undefined` means "every resume" (GET /results) --
     * every condition below that depends on this is built conditionally,
     * same pattern as `source`/`minScoreNum` already used. */
    resumeId?: string;
    source?: string;
    minScoreNum?: number;
    statusFilter?: UserJobStatus;
    includeDismissedFlag: boolean;
  };

  // Ticket 3f0883f: the query + row-mapping logic both `GET
  // /resumes/:id/results` and the new `GET /results` need, extracted so the
  // only actual difference between the two routes -- whether
  // `jobMatches.resumeId` is constrained at all -- is a single conditional
  // push, not ~150 lines of copy-pasted query building that could silently
  // drift apart.
  async function fetchScoredResults(
    filters: ResultsFilters,
  ): Promise<{ results: GetResumeResultsResponse["results"]; hiddenBelowFloor?: number }> {
    // The default-dismissed-exclusion (ticket 484889d decision #2: "a
    // dismissed job should leave the visible list") applies whenever the
    // caller didn't ask for a specific status AND didn't opt into
    // `includeDismissed` (ticket bec2f98: Nicole wants a dismissed job to
    // still surface, visibly marked, in a fresh search's results and in the
    // "Already Scored Jobs" tab's grouping — both need every status back,
    // not just non-dismissed). `isNull(...)` covers a job with no
    // `user_job_statuses` row at all (the common case — most jobs have
    // never been touched), `ne(...)` covers one with a real row whose
    // status isn't `dismissed`. Postgres's `!=` is NULL, not true, against a
    // NULL column, which is exactly why the `isNull` half is needed
    // separately rather than relying on `ne` alone to include untouched
    // rows. Returns `undefined` (no condition at all) for the
    // includeDismissed case, rather than reconstructing "any status" as an
    // always-true SQL fragment — the caller below only pushes a defined
    // condition into the WHERE clause.
    function statusCondition(): SQL | undefined {
      if (filters.statusFilter !== undefined)
        return eq(userJobStatuses.status, filters.statusFilter);
      if (filters.includeDismissedFlag) return undefined;
      return or(isNull(userJobStatuses.status), ne(userJobStatuses.status, "dismissed"))!;
    }

    // `and()` (drizzle-orm) already filters out `undefined` entries, so
    // `statusCondition()`'s "no restriction" case (includeDismissed, no
    // explicit ?status=) can be spliced in directly here without a separate
    // push-if-defined step.
    const conditions: (SQL | undefined)[] = [statusCondition()];
    if (filters.resumeId !== undefined) conditions.push(eq(jobMatches.resumeId, filters.resumeId));
    if (filters.source !== undefined) conditions.push(eq(jobsTable.dataSource, filters.source));
    if (filters.minScoreNum !== undefined)
      conditions.push(gte(jobMatches.matchScore, filters.minScoreNum));

    const rows = await db
      .select({
        jobId: jobsTable.id,
        // Ticket 3f0883f: per-row resume identity -- see
        // ScoredJobResult.resumeId's own doc comment (packages/shared) for
        // why this can no longer be a single response-level field once a
        // posting can appear under more than one resume.
        resumeId: jobMatches.resumeId,
        externalId: jobsTable.externalId,
        title: jobsTable.title,
        company: jobsTable.company,
        dataSource: jobsTable.dataSource,
        location: jobsTable.location,
        locationType: jobsTable.locationType,
        // Ticket 8f5a79c: read only to compute `isContractOrTemp` below —
        // never sent over the wire itself (see ScoredJobResult's doc
        // comment on that field for why: it's fully derivable, so exposing
        // the raw enum too would just be a second, redundant way to ask the
        // same question).
        commitment: jobsTable.commitment,
        applyUrl: jobsTable.linkToApply,
        matchScore: jobMatches.matchScore,
        rationale: jobMatches.rationale,
        strengths: jobMatches.strengths,
        gaps: jobMatches.gaps,
        levelFit: jobMatches.levelFit,
        levelFitNote: jobMatches.levelFitNote,
        status: userJobStatuses.status,
        // Ticket 38a7598 review fix, widened by 3f0883f: per-RESULT
        // nickname, joined off `jobMatches.resumeId` rather than any single
        // response-level value -- the same posting can legitimately appear
        // twice, once per resume, with two different nicknames, once
        // results span more than one resume (GET /results below).
        resumeNickname: resumes.resumeNickname,
      })
      .from(jobMatches)
      .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
      .innerJoin(resumes, eq(jobMatches.resumeId, resumes.id))
      .leftJoin(userJobStatuses, eq(userJobStatuses.jobId, jobsTable.id))
      .where(and(...conditions))
      .orderBy(desc(jobMatches.matchScore), levelFitRank, asc(jobsTable.id));

    // The "hidden count" the frontend's score-floor design (git-bug
    // 484889d/1b9f81e) needs: a short filtered list must never read as a
    // broken/empty run when it is actually a strict floor hiding real
    // results. Only computed when a floor was actually applied, and — to
    // stay consistent with what "hidden" means for the main query above —
    // scoped to the same status view (a dismissed job below the floor is
    // hidden for its own reason, not double-counted here as floor-hidden).
    let hiddenBelowFloor: number | undefined;
    if (filters.minScoreNum !== undefined) {
      const hiddenConditions: (SQL | undefined)[] = [
        lt(jobMatches.matchScore, filters.minScoreNum),
        statusCondition(),
      ];
      if (filters.resumeId !== undefined) {
        hiddenConditions.push(eq(jobMatches.resumeId, filters.resumeId));
      }
      if (filters.source !== undefined)
        hiddenConditions.push(eq(jobsTable.dataSource, filters.source));
      const hiddenRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobMatches)
        .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
        .leftJoin(userJobStatuses, eq(userJobStatuses.jobId, jobsTable.id))
        .where(and(...hiddenConditions));
      hiddenBelowFloor = hiddenRows[0]?.count ?? 0;
    }

    return {
      results: rows.map((r) => {
        // `commitment` is destructured OUT here rather than spread into the
        // response (ticket 8f5a79c): it's read from the query purely to
        // compute `isContractOrTemp` below and was never part of the
        // `ScoredJobResult` wire contract -- see that field's doc comment
        // in packages/shared for why the raw enum itself isn't exposed too.
        const { commitment, ...rest } = r;
        return {
          ...rest,
          strengths: r.strengths ?? [],
          gaps: r.gaps ?? [],
          status: r.status ?? null,
          // levelFit/levelFitNote are NOT coerced (ticket b182bde) -- unlike
          // strengths/gaps, `null` here is a real, distinct state ("this row
          // was never judged for level fit"), not "the model returned
          // nothing" -- defaulting it to a value (e.g. "well_matched") would
          // fabricate a claim nobody made. drizzle already returns `null` for
          // an unset column, so no `?? null` is needed here; this comment
          // exists so a future edit doesn't "fix" that into a default.
          isContractOrTemp: looksLikeContractOrTemp({ title: r.title, commitment }),
        };
      }),
      hiddenBelowFloor,
    };
  }

  app.get<{
    Params: { id: string };
    Querystring: ResultsQuerystring;
  }>("/resumes/:id/results", async (request, reply) => {
    const resumeId = request.params.id;

    const parsed = parseResultsQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const resumeRows = await db
      .select({ id: resumes.id, resumeNickname: resumes.resumeNickname })
      .from(resumes)
      .where(eq(resumes.id, resumeId))
      .limit(1);
    if (resumeRows.length === 0) {
      return reply.code(404).send({ error: `No resume with id "${resumeId}".` });
    }
    // Ticket 38a7598, review fix: read once here, alongside the existence
    // check above, and still carried at the TOP LEVEL of the response
    // below for back-compat/convenience -- but this is no longer the
    // canonical source a job card reads its "Searched with" label from.
    // Each row in `results` carries its OWN `resumeNickname` (see
    // GetResumeResultsResponse's own doc comment) -- ticket 3f0883f is why:
    // it widens this use case to span MULTIPLE resumes at once (GET
    // /results below), where a single response-level value can't express
    // "this posting appears twice, once per resume, with two different
    // nicknames."
    const resumeNickname = resumeRows[0]!.resumeNickname;

    const { results, hiddenBelowFloor } = await fetchScoredResults({
      resumeId,
      source: parsed.source,
      minScoreNum: parsed.minScoreNum,
      statusFilter: parsed.statusFilter,
      includeDismissedFlag: parsed.includeDismissedFlag,
    });

    const response: GetResumeResultsResponse = {
      resumeId,
      resumeNickname,
      results,
      hiddenBelowFloor,
    };
    return reply.send(response);
  });

  // Ticket 3f0883f (Nicole: "users should see every job that they've ever
  // applied for and which resume they used to search" -- "Already Scored
  // Jobs" is meant to be the browsable history, silently narrowed to one
  // resume today only because every results query happened to be scoped
  // that way, not by deliberate design). Same filters as the single-resume
  // route above, MINUS any resume scoping at all -- every job_matches row,
  // for every resume, full stop. Deliberately NOT a 404-able resource (no
  // resume existence check): "nothing has ever been scored yet" is a real,
  // valid, empty state here, not an error -- the frontend already renders
  // that as "No jobs scored yet." (App.tsx).
  app.get<{ Querystring: ResultsQuerystring }>("/results", async (request, reply) => {
    const parsed = parseResultsQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const { results, hiddenBelowFloor } = await fetchScoredResults({
      source: parsed.source,
      minScoreNum: parsed.minScoreNum,
      statusFilter: parsed.statusFilter,
      includeDismissedFlag: parsed.includeDismissedFlag,
    });

    const response: GetAllResultsResponse = { results, hiddenBelowFloor };
    return reply.send(response);
  });
}
