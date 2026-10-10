/**
 * Resume paste/read + the filtered results listing (ticket 59fdc52).
 *
 * Resume input is paste-only (decided 2026-08-29 on git-bug a217859 — see
 * that ticket's comments for the PDF-extraction failure mode this avoids;
 * as of this ticket its own docs/adr/002-resume-input.md acceptance
 * criterion is still unwritten) — a `POST` taking raw text, never a file
 * upload. Creating a resume reuses `getOrCreateResumeId` from the matching
 * pipeline (`matching/pipeline.ts`, via `matching/index.ts`) rather than
 * reimplementing its hash-lookup-then-insert logic.
 *
 * IDENTITY (ticket 6ba221e, read this before changing anything resume-ish
 * in here): a resume is identified by its `id`. It is NOT content-addressed
 * any more. `resume_hash` is an ordinary column -- the
 * `unique(user_id, resume_hash)` index is gone (migration 0019) -- and a
 * user may legitimately hold two resumes with byte-identical text. Two
 * consequences live in this file: the duplicate-text 409 ticket 7701534
 * added here is DELETED (see `CreateResumeDuplicateError`'s obituary in
 * @app/shared for Nicole's own words on it), and `PUT /resumes/:id/text`
 * below is the one path that changes an existing resume's text, mutating
 * the row rather than minting a new one.
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
  type ListResumesResponse,
  type UpdateResumeNicknameConflictError,
  type UpdateResumeNicknameResponse,
  type UpdateResumeTextResponse,
  type UserJobStatus,
  USER_JOB_STATUSES,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  searchResults,
  userJobStatuses,
} from "../db/schema.js";
import { SOURCE_DESCRIPTORS } from "../db/seed.js";
import { requireUserId } from "../identity.js";
import { getOrCreateResumeId, hashResumeText } from "../matching/index.js";
import { looksLikeContractOrTemp } from "../matching/swe-filter.js";

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
 * Ticket e9a82f3: hard ceiling on a single `fetchScoredResults` response.
 * Opus's review of 3f0883f flagged this query as genuinely unbounded --
 * every `job_matches` row matching the filters, full stop -- fetched on
 * every `<App/>` mount (`useAllResults.ts`) and after every job-status
 * write. Current single-resume-search scale is ~200 scored jobs per run
 * (git-bug e9a82f3 context, 2026-09-21); 500 gives real headroom above that
 * without being pointlessly huge, and keeps the payload bounded as the
 * cross-resume total keeps growing across searches instead of growing
 * forever. At ~1.65 KB/result (measured against prep/match-results.json,
 * 329,465 bytes for 200 records), a full 500-row response is roughly
 * 800 KB -- still refetched on every mount/status-write today, but no
 * longer unbounded on top of that. See `totalMatchingCount` below for how
 * truncation past this limit is surfaced rather than silently dropped.
 */
const RESULTS_LIMIT = 500;

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
    // Ticket 6ba221e: ACCEPTED AND IGNORED. Ticket 7701534 used this to
    // decide whether duplicate text was a real duplicate or a
    // self-resubmission; there is no duplicate rejection any more, so the
    // handler never reads it. Still listed because this schema is
    // `additionalProperties: false` and a cached pre-6ba221e browser
    // bundle still sends it -- removing the property would turn every
    // resume creation from such a client into a 400. See
    // `CreateResumeRequest.currentResumeId` (@app/shared).
    currentResumeId: { type: "string" },
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

/** Ticket 6ba221e: body of `PUT /resumes/:id/text`. Deliberately a
 * separate schema (and a separate route) from the nickname PATCH above --
 * see `UpdateResumeTextRequest`'s doc comment (@app/shared) for the four
 * reasons text did not simply join that body. */
const updateResumeTextBodySchema = {
  type: "object",
  required: ["resumeText"],
  properties: {
    resumeText: { type: "string" },
  },
  additionalProperties: false,
} as const;

/**
 * Ticket 88f11d7: `true` once `resumeId` has ever had a real (non-
 * estimate) search run against it -- see schema.ts's `searches
 * .isEstimate` doc comment for exactly what that distinguishes and why.
 * A plain existence check, not a count: the FIRST real search is what
 * locks a resume, permanently -- there is no "unlock" path, so beyond
 * "at least one" nothing else about this query needs to change if more
 * real searches happen later.
 *
 * AUDIT VERDICT (ticket 3fc1e5e): COVERED TRANSITIVELY, no `userId`
 * parameter needed. Takes no user id and needs none: every call site
 * reaches it with a `resumeId` this request has ALREADY established
 * belongs to the caller -- `POST /resumes` with the id
 * `getOrCreateResumeId` just resolved under the caller's own `userId`,
 * `GET /resumes/:id` after its ownership-scoped lookup, and (ticket
 * 6ba221e) `PUT /resumes/:id/text` after its own
 * `and(eq(id), eq(userId))` lookup, which 404s before reaching here if
 * the row is not the caller's. `searches.resumeId` is
 * `notNull().references(() => resumes.id)`, so scoping on the resume is
 * scoping on its owner (b2f9dfd's `resume_id -> user_id` chain). Adding a
 * `userId` argument here would be a second, redundant copy of a check the
 * callers already made. A FUTURE call site must make the same check first.
 */
async function isResumeLocked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  resumeId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: searches.id })
    .from(searches)
    .where(and(eq(searches.resumeId, resumeId), eq(searches.isEstimate, false)))
    .limit(1);
  return rows.length > 0;
}

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
  /**
   * AUDIT VERDICT (ticket 3fc1e5e): ALREADY SCOPED (ticket b2f9dfd),
   * unchanged by this ticket. Every write and read here keys off the
   * `userId` below: `getOrCreateResumeId(db, resumeText, userId)` does the
   * per-user find-or-create, and the `eq(resumes.id, id)` lookup
   * afterwards (the suggestedTitles/nickname read-back) is by-id on the
   * row that call JUST resolved FOR THIS USER -- not on a caller-supplied
   * id, so there is no foreign id for it to reach.
   *
   * Ticket 6ba221e: `currentResumeId` is no longer read AT ALL (the
   * duplicate-text comparison it existed for is gone), which removes the
   * only place a caller-supplied id entered this handler.
   */
  app.post<{ Body: { resumeText: string; currentResumeId?: string } }>(
    "/resumes",
    { schema: { body: createResumeBodySchema } },
    async (request, reply) => {
      const userId = requireUserId(request);
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

      // Find-or-create (ticket 620ca30, per-user as of ticket b2f9dfd):
      // posting the same text twice returns the same id rather than
      // duplicating a row, and a genuinely new resume gets a new id whose
      // scores start empty (no job_matches rows exist for it yet — see GET
      // /resumes/:id/results).
      //
      // TICKET 6ba221e KEPT THIS, DELIBERATELY, and that is worth
      // justifying because the ticket's headline is "resume_hash is not an
      // identity". It isn't: the database no longer enforces it (migration
      // 0019), two identical-text resumes are legal, and this handler no
      // longer REJECTS anything on the strength of a hash match. What
      // survives is a create-path CONVENIENCE -- re-pasting text you
      // already have saved lands on the resume you already have, instead
      // of minting a second row indistinguishable from the first except
      // for its "Resume N". The alternative (always INSERT) was
      // considered and rejected: it would make a double-click, or an Edit
      // -> Submit with nothing actually changed, silently mint "Resume 2",
      // which is the exact user-visible complaint this ticket exists to
      // fix. Two identical-text resumes remain fully reachable, via
      // `PUT /resumes/:id/text` below -- which is how a real user gets
      // there anyway, and which this ticket's own tests cover.
      //
      // KNOWN SEAM that falls out of keeping it, recorded rather than fixed
      // (fable review of 6ba221e). Reached like this: a LOCKED Resume 1 ->
      // "Change" -> "Paste a new resume" -> paste text byte-identical to
      // Resume 1 -> Submit. The user explicitly declined to reuse Resume 1
      // one click ago, and this find-or-create hands them Resume 1 anyway,
      // still locked, with no message saying so -- the collapsed bar just
      // reads "Using Resume 1" again. Nothing is lost or corrupted and no
      // error is wrong, which is why it is not being fixed here: the
      // alternatives are ticket 7701534's 409 (deleted by this ticket, by
      // the owner's explicit instruction) or always-INSERT (rejected just
      // above, for a worse failure). But it IS a silent no-op where the
      // user asked for something, so it is named here instead of waiting to
      // be rediscovered. If it ever needs addressing, the honest fix is in
      // the UI -- say "that's the text of Resume 1, which you're already
      // using" -- not by reinstating a rejection.
      //
      // `isNew` USED TO be left undestructured here ("ticket 7701534's
      // duplicate rejection was its only consumer... reading it would be
      // dead code"). Ticket 3db5b35 (adversarial review finding F1,
      // severe) gives it a second, genuine consumer: `resumeNickname`
      // below is NOT proof this request created a fresh row -- on a
      // find-or-create HIT it is that existing row's real, possibly
      // already-renamed nickname -- so the frontend's pre-save nickname
      // reconciliation (ResumeInput.tsx / App.tsx's `handleResumeSubmit`)
      // needs the server's own "created vs. found" answer to avoid
      // silently renaming a resume the user never touched. See
      // `CreateResumeResponse.isNew`'s doc comment (@app/shared) for the
      // concrete scenario this closes.
      const { id, isNew } = await getOrCreateResumeId(db, resumeText, userId);

      // Ticket 39b4a48: suggested title keywords, cached on the row —
      // `suggestedTitles === null` means inference has never run for this
      // id, OR that it failed, OR that a text edit invalidated it
      // (schema.ts's column doc comment; `PUT /resumes/:id/text` below is
      // what nulls it on an edit). A resubmission of identical resume text
      // reuses the same row and never re-pays for this UNLESS the row is
      // still `null` — which is exactly the self-healing path a failure
      // relies on (see below).
      //
      // TICKET 82ae975: `inferTitles` now THROWS on failure (see
      // resume-title-inference.ts's own doc comment for the full history)
      // instead of swallowing one into `[]`. This try/catch used to be
      // unreachable "defense in depth" against a hypothetical future
      // implementation that could throw — it is that implementation now,
      // and is the PRIMARY mechanism, not a defensive backstop. On failure
      // this sets `suggestedTitles = null`, NOT `[]`: `[]` is what ticket
      // 82ae975 fixed, because it is indistinguishable from "ran, found
      // nothing" and is never `null`, so the lazy re-inference gate above
      // never fires again for it — a transient failure cached zero chips
      // forever, logged nowhere (the whole bug this ticket closes). Writing
      // `null` instead keeps the row honestly "not inferred yet" so the
      // SAME lazy gate retries it the next time this exact resume text is
      // POSTed again (e.g. the user re-pastes it via "paste a new resume"),
      // consistent with `PUT /resumes/:id/text`'s own choice of `null` on
      // failure (ticket 6ba221e) — one convention for this column, not two.
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
          // Ticket 82ae975: logged with the resume id, the resume text's
          // length (not the text itself — it can be the user's real resume,
          // and the length alone is enough to correlate against
          // resume-title-inference.ts's own token-budget comments) and the
          // thrown error's own message, which now names which failure mode
          // occurred (API call failed / no text block / invalid JSON /
          // non-array titles — see that module's doc comment). This is the
          // log line the ticket's own title complains does not exist.
          request.log.error(
            { err, id, resumeTextLength: resumeText.length },
            "title inference failed on resume creation, leaving suggestedTitles null for lazy retry",
          );
          // NOT `[]` — see the long comment above this block for why `null`
          // is the one representation that keeps this resume self-healing.
          suggestedTitles = null;
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

      const isLocked = await isResumeLocked(db, id);
      const response: CreateResumeResponse = {
        id,
        // Ticket 82ae975: `suggestedTitles` can now be `null` here (a
        // failed inference this request just attempted and could not
        // recover from in time to respond) in addition to the pre-existing
        // "never inferred" case. `CreateResumeResponse.suggestedTitles` is
        // `string[]`, not nullable — same `null` → `[]` coercion
        // `GET /resumes/:id` already performs, so the client never has to
        // special-case a nullable field it cannot act on differently anyway
        // (see this ticket's own notes on `GetResumeResponse` for why no
        // reader downstream of the API boundary needs to see `null` at
        // all — only the `suggestedTitles === null` DATABASE check,
        // upstream of this response, needs the real tri-state).
        suggestedTitles: suggestedTitles ?? [],
        resumeNickname,
        isLocked,
        isNew,
      };
      return reply.code(200).send(response);
    },
  );

  // Ticket 303cff0 ("My Resumes" tab, Nicole: "there are multiple resumes
  // going on... I think it's reasonable that if a user's got a resume on
  // here, they should be able to at least view it"). Deliberately cheap:
  // `resumeText` is left out (see `ResumeSummary`'s own doc comment) so
  // this stays fast regardless of how many/how long the saved resumes get
  // -- the tab fetches a single resume's full text on demand via the
  // existing `GET /resumes/:id`, not by preloading every one here.
  //
  // Ordered oldest-first: nicknames are assigned "Resume 1", "Resume 2",
  // ... in creation order (ticket 38a7598), so this keeps list order and
  // nickname order in agreement rather than fighting each other. `id` is a
  // `randomUUID()` (not time-ordered) so it's only a tiebreak, not the
  // primary sort.
  //
  // Ticket b2f9dfd: scoped to the requesting user -- this is the one read
  // path this ticket scopes itself (it's a full, unfiltered list, and
  // returning every user's nicknames/created-dates to anyone would be a
  // glaring, self-inflicted gap the moment resumes became per-user at
  // all).
  //
  // AUDIT VERDICT (ticket 3fc1e5e): ALREADY SCOPED, unchanged. The rest of
  // what b2f9dfd deferred from here -- "the general 'does this id in the
  // URL belong to request.userId' access-control question spanning every
  // by-id route in this app (searches, jobs, ...)" -- is now closed, and
  // closed the same way everywhere: the owning user is a conjunct in the
  // query, and a row belonging to someone else 404s exactly as a
  // nonexistent one does. See each route's own AUDIT VERDICT comment.
  app.get("/resumes", async (request, reply) => {
    const userId = requireUserId(request);
    const rows = await db
      .select({
        id: resumes.id,
        resumeNickname: resumes.resumeNickname,
        createdAt: resumes.createdAt,
      })
      .from(resumes)
      .where(eq(resumes.userId, userId))
      .orderBy(asc(resumes.createdAt), asc(resumes.id));

    const response: ListResumesResponse = {
      resumes: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    };
    return reply.send(response);
  });

  /**
   * AUDIT VERDICT (ticket 3fc1e5e): NEEDED PER-USER SCOPING -- now scoped.
   *
   * This was the worst of the gaps b2f9dfd deferred here, and it was a
   * direct read of the most sensitive thing this app stores: anyone who
   * knew or guessed a resume id got back that resume's FULL `resumeText`,
   * nickname and suggested titles, no matter who owned it. `GET /resumes`
   * (the list) was already scoped, which made this the one remaining way
   * to read a stranger's resume text through the resumes surface.
   *
   * 404, never 403 -- the same shape as "no such resume", so a caller
   * cannot use the status code to distinguish "exists but isn't yours"
   * from "never existed" and probe for valid ids. Same convention
   * `loadResumeText`'s scoped lookup already established in
   * routes/searches.ts.
   */
  app.get<{ Params: { id: string } }>("/resumes/:id", async (request, reply) => {
    const userId = requireUserId(request);
    const rows = await db
      .select({
        id: resumes.id,
        resumeText: resumes.resumeText,
        resumeNickname: resumes.resumeNickname,
        suggestedTitles: resumes.suggestedTitles,
      })
      .from(resumes)
      .where(and(eq(resumes.id, request.params.id), eq(resumes.userId, userId)))
      .limit(1);

    if (rows.length === 0) {
      return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
    }
    const row = rows[0]!;
    const isLocked = await isResumeLocked(db, row.id);
    // Ticket 88f11d7: same "no suggestions yet" vs "ran, found nothing"
    // distinction `CreateResumeResponse.suggestedTitles` already
    // documents -- `null` on the row (inference never ran for this
    // resume, e.g. a very old row from before ticket 39b4a48) degrades
    // to `[]` here rather than leaking a nullable field the frontend
    // would have to special-case.
    const response: GetResumeResponse = {
      id: row.id,
      resumeText: row.resumeText,
      resumeNickname: row.resumeNickname,
      isLocked,
      suggestedTitles: row.suggestedTitles ?? [],
    };
    return reply.send(response);
  });

  // Ticket 38a7598: renames a resume's nickname. Deliberately minimal --
  // the only writable field is `resumeNickname`, never `resumeText`. That
  // exclusion's ORIGINAL reason (it "would break content-addressing") died
  // with ticket 6ba221e; see `UpdateResumeTextRequest`'s doc comment
  // (@app/shared) for the grounds it stands on now, and
  // `PUT /resumes/:id/text` below for where text actually goes. This is
  // the one endpoint a rename made
  // AFTER the initial submission (per the ticket's own acceptance
  // criteria: "editable, not just at creation") goes through -- the
  // submission-time default/edit in ResumeInput.tsx also lands here, via
  // the same PATCH, once the resume already has an id.
  app.patch<{ Params: { id: string }; Body: { resumeNickname: string } }>(
    "/resumes/:id",
    { schema: { body: updateResumeNicknameBodySchema } },
    async (request, reply) => {
      const userId = requireUserId(request);
      const trimmed = request.body.resumeNickname.trim();
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: "resumeNickname must not be empty." });
      }
      if (trimmed.length > MAX_RESUME_NICKNAME_LENGTH) {
        return reply.code(400).send({
          error: `resumeNickname exceeds the ${MAX_RESUME_NICKNAME_LENGTH}-character limit (got ${trimmed.length}).`,
        });
      }

      // Ticket 7701534, Nicole: "if they try to make a nickname that's
      // already been used... it should have an error... This resume
      // nickname is already in use." Case-insensitive (`lower(...)`, not
      // Postgres `ILIKE` -- `ILIKE`'s pattern argument treats `%`/`_` as
      // wildcards, which a real nickname could easily contain literally,
      // e.g. "50% remote resume"; a plain lower-cased equality has no such
      // false-positive risk) and excludes THIS resume's own current
      // nickname (`ne(resumes.id, ...)`), so re-saving a nickname
      // unchanged, or changing only its case, never self-collides.
      //
      // Ticket b2f9dfd: scoped `WHERE user_id = ...` -- two different
      // users can each have their own "Resume 8".
      //
      // AUDIT VERDICT (ticket 3fc1e5e): NEEDED PER-USER SCOPING -- the
      // UPDATE below is now scoped too, and this pair of queries is why
      // the gap was worth naming precisely. b2f9dfd scoped THIS collision
      // check to the requesting user but left the UPDATE matching on `id`
      // alone, so the two disagreed about whose resume was being renamed:
      // a request naming a DIFFERENT user's resume id renamed that user's
      // row, having checked the new nickname for uniqueness against the
      // WRONG namespace (the requester's). Concretely -- user B renames
      // user A's "Resume 1" to "Resume 2" while A already HAS a "Resume
      // 2": the check passes (B has no "Resume 2"), the write lands, and A
      // is left with two identically-named resumes, the exact state the
      // nickname check exists to prevent. Both halves now name
      // `resumes.userId`.
      //
      // RE-CHECKED UNDER IN-PLACE EDITING (ticket 6ba221e, which flagged
      // this query as something its change might have invalidated):
      // unaffected, and the reason is that nothing about nicknames moved.
      // The assumption 6ba221e removed is "new text means a new row",
      // which lived in `getOrCreateResumeId`'s "Resume N" numbering -- not
      // here. This query compares nicknames within one user and excludes
      // the row being renamed; `PUT /resumes/:id/text` never writes
      // `resume_nickname` and never inserts a row, so an edit cannot mint
      // a nickname for this check to collide with, and the count that
      // derives "Resume N" is no longer reached by an edit at all. The one
      // thing 6ba221e genuinely changes nearby is that two resumes may now
      // hold identical TEXT -- which this query does not read.
      const collision = await db
        .select({ id: resumes.id })
        .from(resumes)
        .where(
          and(
            eq(sql<string>`lower(${resumes.resumeNickname})`, trimmed.toLowerCase()),
            ne(resumes.id, request.params.id),
            eq(resumes.userId, userId),
          ),
        )
        .limit(1);
      if (collision.length > 0) {
        const conflictResponse: UpdateResumeNicknameConflictError = {
          error: "This resume nickname is already in use.",
          reason: "nickname_conflict",
        };
        return reply.code(409).send(conflictResponse);
      }

      const rows = await db
        .update(resumes)
        .set({ resumeNickname: trimmed })
        .where(and(eq(resumes.id, request.params.id), eq(resumes.userId, userId)))
        .returning({ id: resumes.id, resumeNickname: resumes.resumeNickname });

      if (rows.length === 0) {
        return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
      }
      const response: UpdateResumeNicknameResponse = rows[0]!;
      return reply.send(response);
    },
  );

  /**
   * TICKET 6ba221e: replaces a resume's TEXT in place, keeping the same
   * `resumes.id`. This is the endpoint the whole ticket is for.
   *
   * WHAT IT FIXES. Before this, "edit a resume" meant POSTing different
   * text, which (resumes being content-addressed) minted a DIFFERENT row
   * with a fresh "Resume N" default -- Nicole, hitting it herself: "if I'm
   * on resume one and I make an edit and I hit save and it's still called
   * resume one, it actually becomes resume 2... the saving doesn't work
   * intuitively." `getOrCreateResumeId` is deliberately NOT involved here:
   * an edit names a row, so it UPDATEs that row.
   *
   * WHY IT IS ITS OWN ROUTE rather than a `resumeText` field on
   * `PATCH /resumes/:id` -- see `UpdateResumeTextRequest`'s doc comment
   * (@app/shared) for the four reasons, argued rather than assumed as the
   * ticket required.
   *
   * SCOPED ON `userId`, NOT ON `id` ALONE, in the single UPDATE that does
   * the work. This is the specific shape ticket 3fc1e5e's audit found
   * broken in the rename path above (a collision check scoped one way and
   * an UPDATE scoped another, so a request could rewrite a stranger's
   * row). This handler does use two statements -- the ownership SELECT
   * below and the UPDATE after it (fable review of 6ba221e, F5, correcting
   * an earlier version of this comment that claimed one). What actually
   * defeats 3fc1e5e's failure shape is that BOTH carry the same
   * `and(eq(resumes.id, ...), eq(resumes.userId, userId))`, so they cannot
   * disagree about whose row is in play: the SELECT 404s a foreign id
   * before anything is written, and the UPDATE would match zero rows even
   * if it were somehow reached. Keep both conjuncts on both statements --
   * dropping either from the UPDATE is not currently reachable, which is
   * exactly the kind of "safe today" argument that ticket stopped
   * accepting. A resume belonging to someone else 404s exactly as a
   * nonexistent one does -- the convention every by-id route in this app
   * uses, so a caller cannot use the status code to probe for valid ids.
   *
   * NOT GATED ON `isLocked`, which is a real decision and not an
   * oversight. Ticket 88f11d7 established that a resume locks on its first
   * REAL search ("once that has happened, then a user can't change the
   * text on the resume anymore"), and that lock still shapes the SEARCH
   * page: the collapsed bar offers "Change" (pick another resume / paste a
   * new one), never "Edit", for a locked resume, and `handleResumeSubmit`
   * (App.tsx) only routes an UNLOCKED resume's submit here. But this
   * ticket's own recorded decision covers the locked case directly, in
   * Nicole's words: "I'm confident that I want that text editable, even if
   * it makes things not true anymore... I'm assuming they won't abuse that
   * edit such that it will negate all of their work and already previously
   * searched things." So the resumes page can edit any resume, and the
   * endpoint does not second-guess that. The cost -- `job_matches` rows
   * keyed `(resume_id, job_id)` now hanging off text they were not
   * computed against -- is accepted, explicitly and twice, and this ticket
   * is forbidden from building a staleness warning for it.
   *
   * `job_statuses` ARE UNAFFECTED, by construction: `user_job_statuses` is
   * keyed `(user_id, job_id)` with `resume_id` deliberately absent
   * (db/schema.ts's long comment on that key), so "I applied to job X"
   * cannot be disturbed by this UPDATE -- it does not mention the table,
   * and the fact it stores is not about a resume. There is an explicit
   * regression test for that anyway (routes/resumes.test.ts), because "the
   * code does not touch it" is an argument about today's code.
   */
  app.put<{ Params: { id: string }; Body: { resumeText: string } }>(
    "/resumes/:id/text",
    { schema: { body: updateResumeTextBodySchema } },
    async (request, reply) => {
      const userId = requireUserId(request);
      const { resumeText } = request.body;
      // Same two validations, same limits and wording as `POST /resumes`
      // above -- an edit that produces an empty or absurd resume must fail
      // for the same reason and with the same message a paste of it does.
      if (resumeText.trim().length === 0) {
        return reply.code(400).send({ error: "resumeText must not be empty." });
      }
      if (resumeText.length > MAX_RESUME_TEXT_LENGTH) {
        return reply.code(400).send({
          error: `resumeText exceeds the ${MAX_RESUME_TEXT_LENGTH}-character limit (got ${resumeText.length}).`,
        });
      }

      const existing = await db
        .select({
          id: resumes.id,
          resumeText: resumes.resumeText,
          resumeNickname: resumes.resumeNickname,
          suggestedTitles: resumes.suggestedTitles,
        })
        .from(resumes)
        .where(and(eq(resumes.id, request.params.id), eq(resumes.userId, userId)))
        .limit(1);
      if (existing.length === 0) {
        return reply.code(404).send({ error: `No resume with id "${request.params.id}".` });
      }
      const row = existing[0]!;

      // AN UNCHANGED SAVE IS A NO-OP, and that is a cost control, not
      // politeness. Everything below this point spends a paid Claude call
      // (`inferTitles`), so "the user opened the editor, changed nothing,
      // and hit Save" -- or double-clicked Save -- must not be billable.
      // Byte-for-byte comparison against the stored text, deliberately not
      // against a trimmed/normalized form: the stored value is whatever
      // was last saved, and anything that would alter it is a real change.
      if (row.resumeText === resumeText) {
        const unchanged: UpdateResumeTextResponse = {
          id: row.id,
          resumeText: row.resumeText,
          resumeNickname: row.resumeNickname,
          // Whatever is cached stays cached -- `null` (never inferred, or
          // a previous inference that failed) degrades to `[]` the same
          // way `GET /resumes/:id` already does it.
          suggestedTitles: row.suggestedTitles ?? [],
          isLocked: await isResumeLocked(db, row.id),
        };
        return reply.send(unchanged);
      }

      // THE ACTUAL EDIT: text, its hash, and the suggestedTitles
      // invalidation, in ONE statement. Ordering matters -- the cache is
      // cleared in the same UPDATE that changes the text, so the row is
      // never observable in a state where `suggested_titles` describes
      // text that is no longer there, even if this process dies on the
      // next line.
      //
      // WHY NULL AND RE-INFER, rather than either alternative (the ticket
      // required this decision to be made and its cost stated):
      //   - Leaving the old titles would show chips inferred from text the
      //     user just replaced. That is the obvious failure mode, and
      //     ticket 39b4a48's cache was only ever safe BECAUSE
      //     content-addressing made a row's text immutable -- which this
      //     ticket ends.
      //   - Nulling WITHOUT re-inferring here looks cheaper but is worse:
      //     the lazy gate that re-infers on `null` lives in `POST
      //     /resumes`, and an edit no longer goes through that route, so
      //     nothing would ever re-infer. `GET /resumes/:id` coerces `null`
      //     to `[]`, which the frontend reads as "inference ran and found
      //     nothing" -- so the resume would silently lose its title chips
      //     for good.
      // COST, stated plainly: one Claude call per REAL text edit, where
      // before this ticket it was at most one per resume, ever. Bounded by
      // how often a human edits a resume, and skipped entirely by the
      // unchanged-save branch above.
      // Hoisted rather than inlined: the follow-up write below needs the
      // SAME value to prove the row still holds this request's text.
      const resumeHash = hashResumeText(resumeText);
      await db
        .update(resumes)
        .set({
          resumeText,
          resumeHash,
          suggestedTitles: null,
        })
        .where(and(eq(resumes.id, row.id), eq(resumes.userId, userId)));

      // TICKET 82ae975: `inferTitles` now THROWS on failure instead of
      // swallowing one into `[]` (resume-title-inference.ts's own doc
      // comment has the full history) -- this try/catch is the PRIMARY
      // mechanism for catching that, not defense-in-depth against a
      // hypothetical. A failure must not fail the EDIT -- the text is
      // already saved by this point, which is the part the user asked for.
      let suggestedTitles: string[] | null = null;
      try {
        suggestedTitles = await inferTitles(resumeText);
      } catch (err) {
        // Same logging shape as `POST /resumes`'s own catch: the resume id,
        // the new text's length (never the text itself), and the thrown
        // error's own message naming which failure mode occurred.
        request.log.error(
          { err, id: row.id, resumeTextLength: resumeText.length },
          "title inference failed after a resume text edit, leaving suggestedTitles null for lazy retry",
        );
      }
      try {
        // On FAILURE this writes `null`, not `[]`, and that is deliberate:
        // ticket 82ae975 fixed `POST /resumes` above to make EXACTLY this
        // same choice -- `null` was always right here because `[]` would be
        // cached forever behind the `suggestedTitles === null` retry gate,
        // with no reason for a write path to walk into that. `null` keeps
        // the row honestly marked "not inferred yet" so a later edit, a
        // POST of this same text, or an operator run of
        // `scripts/reinfer-resume-titles.ts --live` (widened by ticket
        // 82ae975 to reach `null` rows too) can still try. The row is
        // ALREADY `null` from the UPDATE above, so the failure case
        // re-writes the same value
        // rather than relying on that -- one statement either way, and it
        // cannot be read as "we meant to store []".
        //
        // GUARDED ON `resumeHash` (fable review of 6ba221e, F5b): this
        // write lands AFTER a slow network call to Claude, so a second
        // `PUT /resumes/:id/text` for the same resume can have replaced the
        // text in between. Without the guard, the loser's chips would be
        // written over the winner's text -- the exact
        // titles-describing-absent-text failure this whole re-inference
        // path exists to prevent, just reached by a different route. Naming
        // the hash this request wrote makes the statement a no-op (zero
        // rows matched) when someone else has moved on, so the last text to
        // land keeps its own titles and the loser's are simply dropped. The
        // row is then left `null` by the winner's own first UPDATE until
        // its inference returns, which is the honest state. `userId` is
        // here for the same reason it is on the UPDATE above: both
        // conjuncts on every statement, uniformly.
        await db
          .update(resumes)
          .set({ suggestedTitles })
          .where(
            and(
              eq(resumes.id, row.id),
              eq(resumes.userId, userId),
              eq(resumes.resumeHash, resumeHash),
            ),
          );
      } catch (err) {
        // A failed WRITE of already-computed suggestions must not fail the
        // edit either; the response below still carries what this request
        // computed, and the row stays `null` so a future call re-infers.
        request.log.error({ err, id: row.id }, "failed to persist suggestedTitles after an edit");
      }

      const response: UpdateResumeTextResponse = {
        id: row.id,
        resumeText,
        // READ BACK FROM THE ROW AS IT WAS, never recomputed: this
        // endpoint's central promise is that a text edit does not rename
        // anything (no "Resume 2"), and the only way to keep that promise
        // is to not have a nickname-assigning code path here at all.
        resumeNickname: row.resumeNickname,
        suggestedTitles: suggestedTitles ?? [],
        isLocked: await isResumeLocked(db, row.id),
      };
      return reply.send(response);
    },
  );

  type ResultsQuerystring = {
    source?: string;
    minScore?: string;
    status?: string;
    includeDismissed?: string;
    /**
     * Ticket 9e5fcf3 (part (b)): scopes `GET /resumes/:id/results` to one
     * search's own `search_results` links. Parsed here (shared with `GET
     * /results`, below) but only ever FORWARDED into `fetchScoredResults`
     * by the single-resume route -- `GET /results` ("Already Scored Jobs")
     * must stay cumulative across searches and resumes (Nicole confirmed
     * this directly when asked), so that handler deliberately drops this
     * field on the floor rather than acting on it. Existence/ownership
     * (does this search even belong to this resume?) is NOT checked in
     * `parseResultsQuery` below -- that needs a DB round trip, unlike every
     * other field this function validates against a static list, so it's
     * checked once, directly in the single-resume route handler, the same
     * place `resumeId` itself is already existence/ownership-checked.
     */
    searchId?: string;
  };

  type ParsedResultsQuery =
    | {
        ok: true;
        source?: string;
        minScoreNum?: number;
        statusFilter?: UserJobStatus;
        includeDismissedFlag: boolean;
        searchId?: string;
      }
    | { ok: false; error: string };

  // Ticket 3f0883f: pulled out of the single-resume route below so the new
  // cross-resume `GET /results` doesn't hand-duplicate the exact same three
  // validations. Behavior is byte-for-byte what the single-resume route
  // always did.
  function parseResultsQuery(query: ResultsQuerystring): ParsedResultsQuery {
    const { source, minScore, status, includeDismissed, searchId } = query;

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
      searchId,
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
    /**
     * Ticket 3fc1e5e: the requesting user, REQUIRED and deliberately not
     * optional. Every caller of `fetchScoredResults` has one
     * (`requireUserId`), and making it a required field is what makes
     * "someone forgot to scope this" a compile error rather than a silent
     * cross-user read -- exactly the failure mode that let `GET /results`
     * ship unscoped in the first place. Applied unconditionally, even on
     * the single-resume route whose `resumeId` is already
     * ownership-checked: uniform is cheaper to verify than
     * conditionally-correct, and it means both COUNT queries below can
     * join `resumes` unconditionally too.
     */
    userId: string;
    /** Ticket 3f0883f: `undefined` means "every resume" (GET /results) --
     * every condition below that depends on this is built conditionally,
     * same pattern as `source`/`minScoreNum` already used. Ticket 3fc1e5e:
     * "every resume" now means every resume OF `userId`, never every
     * resume in the database. */
    resumeId?: string;
    source?: string;
    minScoreNum?: number;
    statusFilter?: UserJobStatus;
    includeDismissedFlag: boolean;
    /**
     * Ticket 9e5fcf3 (part (b)): `undefined` means "every search this
     * resume has ever run" (the pre-9e5fcf3 behavior, and still what `GET
     * /results` always passes -- see `ResultsQuerystring.searchId`'s own
     * doc comment for why that route never forwards a caller-supplied
     * value here). The single-resume route sets this once it's confirmed
     * (via `searches.resumeId`) that the search actually belongs to the
     * resume being queried.
     */
    searchId?: string;
  };

  // Ticket 3f0883f: the query + row-mapping logic both `GET
  // /resumes/:id/results` and the new `GET /results` need, extracted so the
  // only actual difference between the two routes -- whether
  // `jobMatches.resumeId` is constrained at all -- is a single conditional
  // push, not ~150 lines of copy-pasted query building that could silently
  // drift apart.
  async function fetchScoredResults(filters: ResultsFilters): Promise<{
    results: GetResumeResultsResponse["results"];
    hiddenBelowFloor?: number;
    totalMatchingCount?: number;
  }> {
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

    /**
     * Ticket 3fc1e5e: the per-user scope, enforced through
     * `resumes.userId` rather than by listing the caller's resume ids.
     * Every row this query can return is a `job_matches` row, which is
     * `notNull().references(() => resumes.id)` (schema.ts), so the
     * `innerJoin(resumes, ...)` every query below performs is a total
     * function into exactly one owning user -- b2f9dfd's `resume_id ->
     * user_id` chain. That makes this ONE condition sufficient for the
     * whole results surface, with no separate "which resumes are mine"
     * round trip to drift out of date.
     */
    const ownedByUser = eq(resumes.userId, filters.userId);

    /**
     * Ticket 3fc1e5e: the `user_job_statuses` join predicate, and the
     * `userId` conjunct in it is a CORRECTNESS fix as much as a privacy
     * one -- the one change in this file that would have broken these
     * queries outright if it had been missed.
     *
     * While that table was keyed `unique(job_id)`, joining on `job_id`
     * alone could match AT MOST ONE row, so this left join never changed
     * the row count. This ticket widens the key to
     * `unique(user_id, job_id)` (schema.ts, migration 0017), after which
     * `job_id` alone matches one row PER USER who has ever touched that
     * job -- so an unscoped join would MULTIPLY the results: one duplicate
     * job card per other user holding a status on the same posting, each
     * carrying a stranger's `status` value, and `?status=`/the default
     * dismissed-exclusion filtering on THEIR status instead of the
     * caller's. Shared by all three queries below so they cannot drift.
     */
    const statusJoinOn = and(
      eq(userJobStatuses.jobId, jobsTable.id),
      eq(userJobStatuses.userId, filters.userId),
    );

    // `and()` (drizzle-orm) already filters out `undefined` entries, so
    // `statusCondition()`'s "no restriction" case (includeDismissed, no
    // explicit ?status=) can be spliced in directly here without a separate
    // push-if-defined step.
    const conditions: (SQL | undefined)[] = [statusCondition(), ownedByUser];
    if (filters.resumeId !== undefined) conditions.push(eq(jobMatches.resumeId, filters.resumeId));
    if (filters.source !== undefined) conditions.push(eq(jobsTable.dataSource, filters.source));
    if (filters.minScoreNum !== undefined)
      conditions.push(gte(jobMatches.matchScore, filters.minScoreNum));
    // Ticket 9e5fcf3 (part (b)): an `inArray` subquery against
    // `search_results`, not a fourth `innerJoin` -- that table links
    // `(searchId, jobId)` pairs, and a search can legitimately link the
    // SAME job twice over its lifetime only once per `unique(searchId,
    // jobId)` (schema.ts), so joining it can't multiply `jobMatches` rows
    // the way the `userJobStatuses` join comment above warns a badly-scoped
    // join could -- but it also adds nothing a join wouldn't already risk
    // if that invariant ever changed, where a subquery structurally cannot.
    // `search_results` already exists for an unrelated reason
    // (ingestJobs.ts's idempotent re-link on a redelivered `fetch.source`
    // message) -- this reuses it rather than adding new plumbing.
    if (filters.searchId !== undefined) {
      conditions.push(
        inArray(
          jobsTable.id,
          db
            .select({ jobId: searchResults.jobId })
            .from(searchResults)
            .where(eq(searchResults.searchId, filters.searchId)),
        ),
      );
    }

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
      .leftJoin(userJobStatuses, statusJoinOn)
      .where(and(...conditions))
      .orderBy(desc(jobMatches.matchScore), levelFitRank, asc(jobsTable.id))
      .limit(RESULTS_LIMIT);

    // Ticket e9a82f3: unlike `hiddenBelowFloor` below (conditional on a
    // minScore filter being present -- there's nothing to compute when no
    // floor was applied), whether the LIMIT above truncated anything can't
    // be known from a filter being set; it depends on how many rows exist.
    // So this always runs when the main query came back exactly at the cap
    // (the only case where truncation is even possible) -- scoped to the
    // SAME `conditions` as the main query above, not the floor-specific
    // `hiddenConditions` below, since this counts everything the main query
    // was trying to return, not just what's below a floor.
    let totalMatchingCount: number | undefined;
    if (rows.length === RESULTS_LIMIT) {
      // `.innerJoin(resumes, ...)` IS BACK, and ticket e9a82f3's own
      // comment here is why it had to come back. That comment (opus review,
      // e9a82f3) dropped this join as unnecessary -- correct at the time,
      // since `conditions` referenced no `resumes` column -- and closed with
      // the exact instruction this ticket is following: "If `conditions`
      // ever grows a `resumes`-column filter, this join must be added back
      // or the query will throw." Ticket 3fc1e5e grows precisely that
      // filter (`ownedByUser`, on `resumes.userId`), so the join returns
      // here and in the `hiddenBelowFloor` count below. It still cannot
      // change this COUNT's value for the reason e9a82f3 gave --
      // `jobMatches.resumeId` is `notNull().references(() => resumes.id)`
      // and `resumes.id` is the PK, so the join neither drops nor
      // multiplies rows -- it is purely what makes the new WHERE clause
      // resolvable.
      const totalRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobMatches)
        .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
        .innerJoin(resumes, eq(jobMatches.resumeId, resumes.id))
        .leftJoin(userJobStatuses, statusJoinOn)
        .where(and(...conditions));
      const total = totalRows[0]?.count ?? 0;
      // Boundary: a matching count exactly AT the limit (not over it) is
      // not truncation -- every matching row is already in `rows`, same
      // ">" (not ">=") boundary convention as smartrecruiters.ts's
      // `truncated` check.
      if (total > RESULTS_LIMIT) totalMatchingCount = total;
    }

    // The "hidden count" the frontend's score-floor design (git-bug
    // 484889d/1b9f81e) needs: a short filtered list must never read as a
    // broken/empty run when it is actually a strict floor hiding real
    // results. Only computed when a floor was actually applied, and — to
    // stay consistent with what "hidden" means for the main query above —
    // scoped to the same status view (a dismissed job below the floor is
    // hidden for its own reason, not double-counted here as floor-hidden).
    let hiddenBelowFloor: number | undefined;
    if (filters.minScoreNum !== undefined) {
      // Ticket 3fc1e5e: `ownedByUser` here too, and it is not optional
      // polish -- this count is reported to the caller as
      // `hiddenBelowFloor`, so leaving it unscoped would have leaked a
      // real (if aggregate) fact about OTHER users' scored jobs: "37
      // results hidden below your floor" computed over the whole
      // database. Same `resumes` innerJoin as the count above, for the
      // same reason.
      const hiddenConditions: (SQL | undefined)[] = [
        lt(jobMatches.matchScore, filters.minScoreNum),
        statusCondition(),
        ownedByUser,
      ];
      if (filters.resumeId !== undefined) {
        hiddenConditions.push(eq(jobMatches.resumeId, filters.resumeId));
      }
      if (filters.source !== undefined)
        hiddenConditions.push(eq(jobsTable.dataSource, filters.source));
      // Ticket 9e5fcf3 (part (b)): same subquery as the main query's
      // `conditions` above, and for the same reason -- without it, a
      // floor-scoped-but-search-scoped request would report "N hidden
      // below your floor" counting jobs from OTHER searches on this same
      // resume, which the main query (correctly) never shows at all. Kept
      // as its own push here (not factored into a shared helper with the
      // main query's) because `hiddenConditions` already builds its array
      // independently rather than cloning `conditions` -- same shape every
      // other per-filter condition in this block already takes.
      if (filters.searchId !== undefined) {
        hiddenConditions.push(
          inArray(
            jobsTable.id,
            db
              .select({ jobId: searchResults.jobId })
              .from(searchResults)
              .where(eq(searchResults.searchId, filters.searchId)),
          ),
        );
      }
      const hiddenRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobMatches)
        .innerJoin(jobsTable, eq(jobMatches.jobId, jobsTable.id))
        .innerJoin(resumes, eq(jobMatches.resumeId, resumes.id))
        .leftJoin(userJobStatuses, statusJoinOn)
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
      totalMatchingCount,
    };
  }

  app.get<{
    Params: { id: string };
    Querystring: ResultsQuerystring;
  }>("/resumes/:id/results", async (request, reply) => {
    const resumeId = request.params.id;
    // AUDIT VERDICT (ticket 3fc1e5e): NEEDED PER-USER SCOPING -- now
    // scoped in BOTH halves of this handler. The existence check below is
    // the ownership gate (someone else's resumeId now 404s, identically to
    // one that never existed), and `fetchScoredResults` carries `userId`
    // on top of that. Belt and braces deliberately: the existence check
    // alone would already be sufficient TODAY, since every returned row is
    // a `job_matches` row for this one verified resumeId -- but that is an
    // argument about the current query's shape, and the whole reason this
    // ticket exists is that such arguments stop holding when someone edits
    // the query later. The scope now lives in the query itself.
    const userId = requireUserId(request);

    const parsed = parseResultsQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    const resumeRows = await db
      .select({ id: resumes.id, resumeNickname: resumes.resumeNickname })
      .from(resumes)
      .where(and(eq(resumes.id, resumeId), eq(resumes.userId, userId)))
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

    // Ticket 9e5fcf3 (part (b)): `?searchId=` existence/ownership check --
    // the one piece `parseResultsQuery` above can't do itself (it's a pure
    // function with no DB access; every other field it validates is a
    // static list). Scoped by BOTH `id` and `resumeId` in one query, same
    // shape as the `resumeRows` ownership check just above it: a search
    // that exists but belongs to a DIFFERENT resume (this user's own other
    // resume, or -- `searches.resumeId` is a plain FK, not further scoped
    // by `userId` -- another user's entirely) must 404 exactly like a
    // search that doesn't exist at all, rather than silently falling back
    // to "every search" (the pre-9e5fcf3 behavior) or leaking which
    // resume a foreign searchId actually belongs to via a different error
    // shape.
    if (parsed.searchId !== undefined) {
      const searchRows = await db
        .select({ id: searches.id })
        .from(searches)
        .where(and(eq(searches.id, parsed.searchId), eq(searches.resumeId, resumeId)))
        .limit(1);
      if (searchRows.length === 0) {
        return reply
          .code(404)
          .send({ error: `No search with id "${parsed.searchId}" for this resume.` });
      }
    }

    const { results, hiddenBelowFloor, totalMatchingCount } = await fetchScoredResults({
      userId,
      resumeId,
      source: parsed.source,
      minScoreNum: parsed.minScoreNum,
      statusFilter: parsed.statusFilter,
      includeDismissedFlag: parsed.includeDismissedFlag,
      searchId: parsed.searchId,
    });

    const response: GetResumeResultsResponse = {
      resumeId,
      resumeNickname,
      results,
      hiddenBelowFloor,
      totalMatchingCount,
    };
    return reply.send(response);
  });

  // Ticket 3f0883f (Nicole: "users should see every job that they've ever
  // applied for and which resume they used to search" -- "Already Scored
  // Jobs" is meant to be the browsable history, silently narrowed to one
  // resume today only because every results query happened to be scoped
  // that way, not by deliberate design). Same filters as the single-resume
  // route above, MINUS any RESUME scoping -- every job_matches row, for
  // every one of the CALLER'S OWN resumes. Deliberately NOT a 404-able
  // resource (no resume existence check): "nothing has ever been scored
  // yet" is a real, valid, empty state here, not an error -- the frontend
  // already renders that as "No jobs scored yet." (App.tsx).
  //
  // AUDIT VERDICT (ticket 3fc1e5e): NEEDED PER-USER SCOPING -- now scoped,
  // and this is the case the ticket named as the known big one. Ticket
  // 3f0883f's design ("every scored job across every resume, shown or
  // not") was correct reasoning for a single implicit user and became a
  // full cross-user dump the instant a second real user existed: every
  // other user's scored job titles, companies, match scores, rationales,
  // strengths/gaps AND their resume nicknames, to any caller, with no id
  // to guess -- by far the widest of the gaps this ticket closes, because
  // unlike the by-id routes it required knowing nothing at all.
  //
  // "Across every resume" is preserved exactly as 3f0883f intended; the
  // only thing that changed is that "every resume" now means the caller's,
  // which is what it was always understood to mean when there was only
  // ever one user. `resumes.userId` is the scope (see `ownedByUser` in
  // `fetchScoredResults`), NOT a list of the caller's resume ids.
  app.get<{ Querystring: ResultsQuerystring }>("/results", async (request, reply) => {
    const userId = requireUserId(request);
    const parsed = parseResultsQuery(request.query);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });

    // Ticket 9e5fcf3 (part (b)): `parsed.searchId` is deliberately NOT
    // forwarded here -- "Already Scored Jobs" stays cumulative across every
    // search and every resume (Nicole confirmed this directly when asked),
    // so this route ignores a `?searchId=` even if one is somehow present
    // on the request. See `ResultsQuerystring.searchId`'s own doc comment.
    const { results, hiddenBelowFloor, totalMatchingCount } = await fetchScoredResults({
      userId,
      source: parsed.source,
      minScoreNum: parsed.minScoreNum,
      statusFilter: parsed.statusFilter,
      includeDismissedFlag: parsed.includeDismissedFlag,
    });

    const response: GetAllResultsResponse = { results, hiddenBelowFloor, totalMatchingCount };
    return reply.send(response);
  });
}
