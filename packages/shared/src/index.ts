/**
 * Placeholder export for @app/shared.
 *
 * Proves the package builds, is importable from both apps/api and apps/web
 * via the pnpm workspace protocol, and is covered by the root Vitest run.
 * Real shared types/utilities (e.g. the Job/Match domain types) land here
 * as the API and web contract solidifies.
 */
export function ping(): string {
  return "pong";
}

/**
 * Minimum match score (0-100) to display in the ranked list (ticket 1b9f81e).
 * Jobs scoring below this are still scored and persisted in the database, but
 * hidden from the printed/returned ranked list. This is a display filter only,
 * not a scoring or persistence filter — the threshold can be retuned later
 * without re-paying to score anything already in the database.
 */
export const MATCH_SCORE_FLOOR = 55;

export type Job = {
  id: string;
  externalId: string;
  dataSource:
    | "usajobs"
    | "wa-state"
    | "greenhouse"
    | "lever"
    | "ashby"
    | "smartrecruiters"
    | "workable"
    | "recruitee"
    | "rippling";
  title: string;
  description: string;
  company: string;
  // Optional because not every source knows. USAJOBS publishes structured
  // pay and schedule codes; Greenhouse's board API carries neither, for any
  // posting. Requiring them would mean either dropping those sources or
  // guessing — and a guess here writes invented data into the database.
  // "Not stated" is the honest representation of a posting that doesn't state it.
  payType?: "hourly" | "salary";
  commitment?: "full-time" | "part-time" | "contract";
  // Also optional, same reasoning. Measured against real Greenhouse boards:
  // Airbnb asks a custom "Workplace Type" question so this maps cleanly;
  // Discord asks nothing equivalent. Requiring it meant 0 of 3 Discord jobs
  // surviving normalization. A posting that doesn't state its work
  // arrangement genuinely doesn't state it.
  locationType?: "remote" | "onsite" | "hybrid";
  location?: string;
  linkToApply: string;
  postedAt: Date;
};

export type Resume = {
  id: string;
  resumeText: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment (ticket 38a7598). */
  resumeNickname: string;
};

/**
 * The "Resume N" default-nickname numbering scheme (ticket 38a7598),
 * extracted to ONE place (ticket 3db5b35, review finding F6) rather than
 * living as two unlinked expressions that happen to agree today:
 * `getOrCreateResumeId` (apps/api/src/matching/pipeline.ts) calls this at
 * INSERT time, with the real count of that user's existing rows, to assign
 * the server's actual default. `App.tsx` calls it with the already-loaded
 * resumes list's length to render a PRE-SAVE suggestion, before any
 * `POST /resumes` has happened to produce a real one — see that file's
 * `handleResumeSubmit` comment for why a suggestion is necessary at all
 * and why it is explicitly not guaranteed to match (another session
 * inserting a row in between is a real, accepted race either side of this
 * function already lived with alone).
 *
 * Same consolidation reasoning as `USER_JOB_STATUSES` living here instead
 * of being redeclared per-side: two expressions that happen to compute the
 * same thing today drift silently the next time either side changes
 * without the other noticing.
 */
export function nextResumeNicknameFor(existingResumeCount: number): string {
  return `Resume ${existingResumeCount + 1}`;
}

export type JobMatch = {
  id: string;
  resumeId: string;
  jobId: string;
  matchScore: number;
  rationale: string;
};

export type Search = {
  id: string;
  resumeId: string;
  searchedAt: Date;
};

export type SearchResult = {
  id: string;
  searchId: string;
  jobId: string;
};

export type SearchSource = {
  searchId: string;
  sourceDescriptorId: string;
};

export type SourceDescriptor = {
  id: string;
  displayName: string;
};

// ---------------------------------------------------------------------------
// REST API wire contract (ticket 59fdc52, review round 2).
//
// apps/web depends on @app/shared and deliberately NOT on @app/api (a
// separate app forces a real REST boundary — see CLAUDE.md's stack table).
// Every shape a route actually sends or accepts over HTTP lives here so the
// frontend never hand-redeclares it from reading route handler source.
// Internal-only shapes (RunDemoMatchResult, ScoreJobFn, ...) stay in
// apps/api/src/demo-match.ts — they never cross the wire.
// ---------------------------------------------------------------------------

export type CreateResumeRequest = {
  resumeText: string;
  /**
   * @deprecated Ticket 6ba221e: ACCEPTED AND IGNORED by `POST /resumes`.
   *
   * Ticket 7701534 added this so the route could tell "resubmitting my own
   * unchanged text" apart from "this text already belongs to a DIFFERENT
   * saved resume", and reject the latter with a 409. 6ba221e deleted that
   * rejection outright -- two resumes with byte-identical text are legal
   * now (Nicole: "Let them do that... that's their business") -- so there
   * is nothing left for the route to distinguish and no caller sends it
   * any more (`createResume`, apps/web/src/api/client.ts).
   *
   * Still DECLARED, and still accepted by the route's body schema, purely
   * for deploy skew: that schema is `additionalProperties: false`, so a
   * browser running a cached pre-6ba221e bundle would get a 400 on every
   * resume creation if the field were removed outright. Safe to delete
   * once no such bundle can still be in use.
   */
  currentResumeId?: string;
};

export type CreateResumeResponse = {
  id: string;
  /**
   * Job title keywords Claude inferred from this resume (ticket 39b4a48),
   * shown to the user as editable/removable chips — replaces the old
   * hardcoded software-engineering title default. Always a real array,
   * never absent: `[]` means inference ran and found nothing to suggest
   * (or failed — see resume-title-inference.ts, a failure degrades to
   * `[]` rather than blocking resume creation), which the frontend must
   * treat as "no suggestions to show", not an error.
   */
  suggestedTitles: string[];
  /**
   * A real, distinct default ("Resume 1", "Resume 2", ...) assigned by
   * `getOrCreateResumeId` (apps/api/src/matching/pipeline.ts) at insert
   * time for a genuinely new resume, or the resume's EXISTING nickname
   * (including one the user already renamed via `PATCH /resumes/:id`) when
   * this submission's text matched a resume that already existed.
   * Ticket 38a7598: this is what `ResumeInput.tsx` shows/pre-fills right
   * in the submission flow, per Nicole's explicit "at that moment...
   * choosing the resume nickname" — never a value the frontend invents
   * itself.
   *
   * Ticket 6ba221e: re-pasting text that already belongs to one of your
   * resumes used to be a 409 (ticket 7701534's duplicate guardrail) unless
   * it was `currentResumeId`'s own text. That rejection is gone, so this
   * field's "a resubmission resolves to the existing resume's real
   * nickname" behavior is back to covering EVERY such case, not just one.
   * Note the hash lookup behind it is a convenience, not an identity rule
   * any more (apps/api/src/db/schema.ts's `resumeHash`): editing a
   * resume's text goes through `UpdateResumeTextRequest` below, which is
   * the only path that changes an existing resume's text, and it never
   * changes its nickname.
   */
  resumeNickname: string;
  /** See `GetResumeResponse.isLocked`'s doc comment -- same meaning,
   * carried here too since a resubmission of `currentResumeId`'s own
   * text (the one case that still reaches this response) needs to know
   * immediately whether IT is now locked, without a second round-trip. */
  isLocked: boolean;
  /**
   * Ticket 3db5b35 (adversarial review finding F1, severe): `true` only
   * when THIS request is the one that INSERTed a new row --
   * `getOrCreateResumeId`'s own `isNew` (apps/api/src/matching/
   * pipeline.ts), carried onto the wire for the first time. It already
   * existed server-side; it had simply never had a consumer that NEEDED
   * to tell "created" apart from "found" until now.
   *
   * THE DEFECT THIS FIELD FIXES: `resumeNickname` above is NOT proof the
   * server assigned a fresh default -- on a find-or-create hit (pasting
   * text that matches an ALREADY-SAVED resume, including one the owner
   * renamed herself) it is that row's real, possibly-already-chosen
   * nickname. `ResumeInput.tsx`'s pre-save suggestion field (ticket
   * 3db5b35) has no way to know in advance which case it's in -- a
   * pre-save client guess that happens to differ from `resumeNickname`
   * is NOT evidence the user typed something: it is equally, and in the
   * ordinary "paste a resume I already have" case MORE likely, evidence
   * that the guess was wrong and the server found an existing row with
   * its own real name. `App.tsx`'s `handleResumeSubmit` gates its
   * post-create nickname PATCH on `isNew === true` for exactly this
   * reason -- a PATCH is only even considered when this request is
   * PROVABLY the one that created the row, never on a found-existing
   * resolution, no matter what the pre-save field happened to show.
   */
  isNew: boolean;
};

export type GetResumeResponse = {
  id: string;
  resumeText: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment. */
  resumeNickname: string;
  /**
   * Ticket 88f11d7 (Nicole: "once that has happened, then a user can't
   * change the text on the resume anymore"). `true` once this resume has
   * EVER had a real, non-estimate search run against it -- see
   * schema.ts's `searches.isEstimate` doc comment for exactly what
   * distinguishes "real" from "just an estimate", and why that
   * distinction needed its own column rather than being inferred from
   * `job_matches`/`job_match_failures` existing. Re-estimating never
   * sets this; nickname stays editable regardless of this value.
   */
  isLocked: boolean;
  /**
   * Ticket 88f11d7: needed so "Change" -> "Use Resume N" can repopulate
   * title chips from the picked resume's OWN cached suggestions, the
   * same way a fresh submission already does via
   * `CreateResumeResponse.suggestedTitles` -- without this, activating
   * an existing resume would either lose its title chips or require a
   * second call. See that field's own doc comment for the array's
   * semantics ("[] means ran and found nothing", never absent).
   */
  suggestedTitles: string[];
};

/**
 * One row of `GET /resumes`'s list (ticket 303cff0 -- "My Resumes" tab).
 * Deliberately NOT `resumeText`: the list is meant to be cheap to load for
 * every saved resume at once, and full text is fetched per-resume, on
 * demand, via the existing `GET /resumes/:id` -- see that route and
 * `GetResumeResponse` above.
 */
export type ResumeSummary = {
  id: string;
  /** See `CreateResumeResponse.resumeNickname`'s doc comment. */
  resumeNickname: string;
  /** ISO 8601 timestamp (schema.ts's `resumes.createdAt`, `defaultNow()`). */
  createdAt: string;
};

export type ListResumesResponse = {
  /** Oldest first -- matches the "Resume 1", "Resume 2", ... nickname
   * numbering (ticket 38a7598), so list order and nickname order agree. */
  resumes: ResumeSummary[];
};

/**
 * REMOVED by ticket 6ba221e: `CreateResumeDuplicateError`, the `409` body
 * `POST /resumes` used to send (ticket 7701534) when submitted text
 * exactly matched an existing resume other than `currentResumeId`.
 *
 * Nicole, 2026-10-06, reversing her own earlier requirement verbatim: "I
 * know that it was a previous requirement of mine that it wouldn't let the
 * exact same text exist for two resumes before, but now I frankly don't
 * care about that. So I want to remove that requirement. Let them do that.
 * If they want to do that, that's their business."
 *
 * The error was also the most visible symptom of the design 6ba221e
 * reverses: because editing a resume minted a NEW content-addressed row,
 * a user who had only ever worked with "Resume 1" could be told her text
 * collided with a "Resume 2" she never chose to create. Two resumes with
 * byte-identical text are now simply legal (apps/api/src/db/schema.ts's
 * `resumeHash` comment has the full history). Nothing replaced this type:
 * there is no duplicate-text error to report.
 */

/**
 * `PATCH /resumes/:id`'s `409` body (ticket 7701534) when `resumeNickname`
 * collides (case-insensitively) with a DIFFERENT resume's current
 * nickname. A `reason` discriminator, not just a message string, so the
 * frontend can react specifically (leave the user's typed value in place
 * rather than reverting it, per `handleNicknameCommit`'s ticket 38a7598
 * revert-on-any-other-failure behavior) without parsing English text.
 */
export type UpdateResumeNicknameConflictError = {
  error: string;
  reason: "nickname_conflict";
};

/**
 * `PATCH /resumes/:id` (ticket 38a7598) — renames a resume's nickname, and
 * ONLY that. `resumeText` is not and never was accepted here.
 *
 * Ticket 6ba221e: the ORIGINAL reason text was excluded ("that would break
 * content-addressing: `resumeHash` is derived from the text and never
 * recomputed after insert") no longer holds — text IS editable now, and
 * `resumeHash` IS recomputed. The exclusion survives on different grounds,
 * which are recorded on `UpdateResumeTextRequest` below: text lives on its
 * own route (`PUT /resumes/:id/text`) because the two updates have
 * genuinely different consequences, not because one of them is forbidden.
 */
export type UpdateResumeNicknameRequest = {
  resumeNickname: string;
};

export type UpdateResumeNicknameResponse = {
  id: string;
  resumeNickname: string;
};

/**
 * `PUT /resumes/:id/text` (ticket 6ba221e) — replaces a resume's text IN
 * PLACE, keeping the same `resumes.id`, the same nickname, and every
 * `job_matches` row already attached to it.
 *
 * WHY ITS OWN ROUTE RATHER THAN A FIELD ON `PATCH /resumes/:id`, which
 * already exists for the nickname (the ticket asked for this choice to be
 * argued, not assumed):
 *
 *  1. The two updates are not peers. A rename is a pure relabel with one
 *     failure mode (a 409 nickname collision). A text replacement
 *     recomputes `resume_hash`, INVALIDATES the cached `suggestedTitles`,
 *     and spends money re-inferring them — and it is the operation that
 *     silently makes existing match scores describe text that is no longer
 *     there (a tradeoff Nicole has explicitly accepted twice). Putting
 *     both behind one verb invites a caller to treat them as equally
 *     cheap.
 *  2. Merging them would weaken the rename's own validation. That body
 *     schema is `required: ["resumeNickname"]`; making both fields
 *     optional to fit text in means `{}` becomes a well-formed request,
 *     and a body carrying BOTH fields raises a partial-apply question
 *     ("the nickname saved but the text was rejected — now what?") that no
 *     caller actually needs answered.
 *  3. PUT is the honest verb. This replaces the whole text, not a patch
 *     of it; there is no partial text update.
 *  4. The rename UI is a separate open ticket (e7666de) touching the same
 *     file, and a new route keeps the two changes from overlapping.
 *
 * Response fields mirror `CreateResumeResponse` exactly (plus the text
 * itself) so the frontend's submit path can use either call
 * interchangeably — see `handleResumeSubmit` (apps/web/src/App.tsx), which
 * routes an edit here and a first paste to `POST /resumes` and then does
 * the same thing with the result.
 */
export type UpdateResumeTextRequest = {
  resumeText: string;
};

export type UpdateResumeTextResponse = {
  id: string;
  /** The text as stored after the update — echoed back so a caller never
   * has to assume its own optimistic copy won (it also reflects the
   * server's own trim/validation decisions). */
  resumeText: string;
  /** UNCHANGED by this call, by design. Returned so the caller can prove
   * that: "edit the text, keep the nickname" is the single most visible
   * thing ticket 6ba221e fixes (Nicole: "if I'm on resume one and I make
   * an edit and I hit save and it's still called resume one, it actually
   * becomes resume 2"). */
  resumeNickname: string;
  /**
   * Freshly re-inferred from the NEW text whenever the text actually
   * changed, and carried straight back rather than left for a later call
   * to discover. See `CreateResumeResponse.suggestedTitles` for the
   * array's semantics ("[] means ran and found nothing", never absent).
   *
   * COST: a real, paid Claude call per text change. Ticket 39b4a48's cache
   * was once a one-off per resume forever, because content-addressing meant
   * a row's text could never change; this ticket makes it per-edit. A save
   * that does not actually change the text re-infers NOTHING and returns
   * the cached values (see the route).
   */
  suggestedTitles: string[];
  /** See `GetResumeResponse.isLocked`. Returned for the same reason
   * `CreateResumeResponse` carries it: the caller has just changed what
   * this resume is and should not need a second round-trip to re-learn its
   * state. Ticket 6ba221e deliberately does NOT refuse a text edit on a
   * locked resume -- see the route's own comment for that decision and
   * Nicole's quote behind it. */
  isLocked: boolean;
};

/**
 * The user's own status toward a job (ticket 0c319b2, apps/api/src/db/
 * schema.ts's `userJobStatusEnum`). Mirrored here rather than imported from
 * apps/api because nothing under apps/api/src ever crosses the wire into
 * @app/web — see this file's header comment.
 *
 * Review round F4 (git-bug 484889d): the runtime array is exported too, as
 * `USER_JOB_STATUSES`, and the type is derived FROM it (`(typeof
 * USER_JOB_STATUSES)[number]`) rather than the array being typed against a
 * separately hand-written union. Before this, `apps/api/src/routes/
 * resumes.ts` and `apps/api/src/routes/job-status.ts` each hand-duplicated
 * their own local `KNOWN_STATUSES` array (used for runtime validation,
 * since a `type` has no runtime representation) — two copies that could
 * silently drift from this type and from each other. One canonical runtime
 * list here removes that drift risk; both route files now import
 * `USER_JOB_STATUSES` instead of redeclaring it.
 */
export const USER_JOB_STATUSES = ["saved", "resume_optimized", "applied", "dismissed"] as const;
export type UserJobStatus = (typeof USER_JOB_STATUSES)[number];

/**
 * Leveling fit (ticket b182bde), judged separately from `matchScore` in the
 * SAME scoring call — see `SCHEMA`/`SCORING_PREAMBLE` in
 * apps/api/src/demo-match.ts. `matchScore` alone conflated capability fit
 * with leveling fit: the same structural fact ("candidate has far more
 * experience than the posting asks for") produced `matchScore` values
 * ranging 42-78 across six real postings, because nothing told the model to
 * separate the two judgments. Three values, not a single "overqualified"
 * flag, because the corpus shows the mismatch in both directions (a
 * Staff-level posting scores someone under-leveled for it too).
 */
export type LevelFit = "underqualified" | "well_matched" | "overqualified";

export type ScoredJobResult = {
  jobId: string;
  /**
   * Ticket 3f0883f: which resume THIS result was scored against —
   * `jobMatches.resumeId`, carried per-row for the same reason
   * `resumeNickname` (below) is: once "Already Scored Jobs" spans every
   * resume, not just the active one, the SAME `jobId` can legitimately
   * appear twice, once per resume, with two different match scores. A
   * response-level `resumeId` can't express that, and neither can a
   * single `jobId` alone stay a unique list key or a safe target for a
   * resume-specific action -- see ResultCard.tsx's "Optimize Resume"
   * handoff, which used to trust a single caller-supplied `resumeId`
   * prop (silently correct only because every card, at the time,
   * necessarily belonged to the one active resume) and now reads this
   * field instead.
   */
  resumeId: string;
  externalId: string;
  title: string;
  company: string;
  // Plain string, not Job["dataSource"]: this comes straight off the `jobs`
  // table's `data_source` FK column (source_descriptors.id), which is not
  // itself narrowed to the six-member union at the DB layer.
  dataSource: string;
  location: string | null;
  locationType: Job["locationType"] | null;
  applyUrl: string;
  matchScore: number;
  rationale: string;
  strengths: string[];
  gaps: string[];
  /**
   * The user's current status toward this job, or `null` when no
   * `user_job_statuses` row exists for it yet (ticket 484889d — added
   * alongside the frontend since no REST surface previously read this
   * column at all; see that ticket's report for what else was missing).
   */
  status: UserJobStatus | null;
  /**
   * Ticket 38a7598 review fix: the nickname of the resume THIS result was
   * scored against, carried per-result rather than only once at the top
   * level of `GetResumeResultsResponse` (see that type's own doc comment
   * for the "why now, not later" reasoning) -- the very next ticket
   * (3f0883f) widens "Already Scored Jobs" to span MULTIPLE resumes at
   * once, where the SAME posting can legitimately appear twice, once per
   * resume, with two different nicknames. A single response-level field
   * cannot express that; this is what `ResultCard.tsx`'s "Searched with:
   * <nickname>" line now reads, straight off its own `result`, never a
   * prop threaded down from a caller.
   */
  resumeNickname: string;
  /**
   * `null` for a row scored before this ticket, or any row a caller
   * declines to judge — NEVER coerced to `"well_matched"` on read (that
   * would fabricate a claim the model never made). By convention, a real
   * `levelFit` usually comes with a `levelFitNote` (see that field's own
   * comment for why this is convention, not a guarantee).
   */
  levelFit: LevelFit | null;
  /**
   * One plain sentence for the candidate on how level fit affects their
   * real chance of being hired here. Empty string (not null) when
   * `levelFit` is `"well_matched"` — see `SCHEMA` in demo-match.ts.
   *
   * By convention, a real `levelFit` usually comes with a `levelFitNote`,
   * but this is NOT enforced at the schema level (no DB constraint, no
   * runtime check) — treat `levelFitNote` as independently nullable.
   * Confirmed non-enforced by the ticket b182bde review: that ticket's own
   * `resumes.test.ts` tiebreak-ordering fixtures seed rows with
   * `levelFit: "overqualified"` and `levelFitNote: null`, contradicting the
   * old "always coupled" claim this comment used to make. The app degrades
   * gracefully either way (pill renders, no tooltip, no note block), so
   * this is a documentation-accuracy fix, not a bug fix.
   */
  levelFitNote: string | null;
  /**
   * Ticket 8f5a79c: does this posting read as contract/temp work? Computed
   * server-side at read time (`apps/api/src/sources/swe-filter.ts`'s
   * `looksLikeContractOrTemp` — a structured `commitment === "contract"`
   * signal where the source reports one, falling back to title phrasing
   * otherwise), never stored as its own DB column: it's fully derivable
   * from data the row already has, so persisting a duplicate of it would
   * just be another place for it to drift stale.
   *
   * Deliberately NOT an exclusion — contract/temp postings pass the same
   * SOFTWARE/NOT title filter as any other SWE title and are mixed into
   * this same ranked list, per Nicole's explicit ask (git-bug 8f5a79c
   * correction: "they should be able to choose whether they want it... i
   * just thought you were saying that theyd be in a different result
   * section"). This field exists so the frontend's "Hide contract/temp
   * roles" toggle (ResultsList.tsx/GroupedResultsList.tsx) can filter the
   * existing corpus client-side — same pattern as `levelFit` feeding "Hide
   * roles above my level" — never a separate section/tab and never a
   * server round-trip.
   */
  isContractOrTemp: boolean;
};

export type GetResumeResultsResponse = {
  resumeId: string;
  /**
   * Ticket 38a7598: originally the ONE place a card's "Searched with"
   * label read its nickname from, on the (true, at the time) reasoning
   * that every result in one response was scored against the same resume
   * (`?resumeId=` scopes the whole query). Review fix, same ticket: that
   * doesn't hold up against the very next ticket (3f0883f), which widens
   * "Already Scored Jobs" to span MULTIPLE resumes at once — the same
   * posting can then legitimately appear twice, once per resume, with two
   * different nicknames, which this single response-level field can't
   * express. `ScoredJobResult.resumeNickname` is now the canonical,
   * per-result source `ResultCard.tsx` actually reads. This field is kept
   * for convenience/back-compat (it costs nothing extra — the route
   * already looks the resume up to 404-check `resumeId`), but nothing in
   * apps/web reads it anymore; don't add a new reader of it without first
   * checking whether the caller actually wants the per-result field
   * instead.
   */
  resumeNickname: string;
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied — see
   * git-bug 1b9f81e. */
  hiddenBelowFloor?: number;
  /** Present only when `fetchScoredResults`'s server-side LIMIT actually
   * truncated the matching rows (see git-bug e9a82f3) -- the true count of
   * rows matching the same filters, BEFORE the limit was applied. `results`
   * is capped at that limit regardless of how large this number gets, so
   * the frontend can tell "everything that matched" (`results.length ===
   * totalMatchingCount`, this field absent) apart from "there's more than
   * we're showing" (this field present and larger than `results.length`)
   * without guessing from `results.length` alone. */
  totalMatchingCount?: number;
};

/**
 * `GET /results` (ticket 3f0883f) -- the cross-resume counterpart to
 * `GetResumeResultsResponse`, deliberately WITHOUT a top-level `resumeId`/
 * `resumeNickname`: there isn't one singular resume to name when `results`
 * spans every resume in the database. Each `ScoredJobResult` already
 * carries its own `resumeId`/`resumeNickname`, which is what makes this
 * response shape possible at all -- see that type's own doc comments.
 */
export type GetAllResultsResponse = {
  results: ScoredJobResult[];
  /** Present only when a minScore floor was actually applied -- same
   * meaning as `GetResumeResultsResponse.hiddenBelowFloor`, just summed
   * across every resume instead of one. */
  hiddenBelowFloor?: number;
  /** Present only when truncated -- same meaning as
   * `GetResumeResultsResponse.totalMatchingCount`, just summed across every
   * resume instead of one (see git-bug e9a82f3). */
  totalMatchingCount?: number;
};

/**
 * `POST /jobs/:id/status` (ticket 484889d). `resumeId` is optional and
 * records which resume was in hand when the status was set — see
 * `userJobStatuses.resumeId`'s doc comment in apps/api/src/db/schema.ts for
 * why it's an attribute, never part of the row's identity.
 */
export type SetJobStatusRequest = {
  status: UserJobStatus;
  resumeId?: string;
};

export type SetJobStatusResponse = {
  jobId: string;
  status: UserJobStatus;
  updatedAt: string;
};

/**
 * `POST /auth/magic-link` (ticket 9f06f8f, epic 2b9e9dd child 4). The email
 * the user typed into the post-results prompt.
 *
 * The server normalizes this (trims, lowercases) before storing or comparing
 * it -- see `normalizeEmail` in apps/api/src/routes/auth.ts -- so the client
 * does not have to, and two visitors typing `Alice@Example.com` and
 * `alice@example.com` are the same account.
 */
export type RequestMagicLinkRequest = {
  email: string;
};

/**
 * Deliberately says NOTHING about whether this email already has an account.
 * The response is byte-identical for a brand-new address and for one that
 * already owns resumes and results, because anything else would make this
 * route an account-enumeration oracle for any caller who can type an address
 * (a stranger asking "does alice@ use this app?" must not be able to tell).
 * `email` echoes the NORMALIZED address so the "check your inbox" state can
 * show exactly where the mail went.
 */
export type RequestMagicLinkResponse = {
  email: string;
  /** ISO 8601. What the "this link expires in N minutes" copy is derived
   * from, rather than the frontend hardcoding a TTL the server owns. */
  expiresAt: string;
};

/** `POST /auth/magic-link/verify` (ticket 9f06f8f). The raw token from the
 * emailed link's `#magicLinkToken=` URL FRAGMENT. POST, not GET, and sent
 * in a body rather than a URL -- see routes/auth.ts's own reasoning (a GET
 * is consumed by link prefetchers and lands the credential in server logs
 * and `Referer` headers).
 *
 * The fragment, not a query parameter (review round 4, F2): a fragment is
 * never sent to ANY server -- not the static host that serves the SPA, not
 * a proxy in front of it, not in a `Referer` -- whereas
 * `?magicLinkToken=...` would land the live credential in the frontend
 * host's own access logs before a line of this app's code runs. */
export type VerifyMagicLinkRequest = {
  token: string;
};

/**
 * Which of the two identity-resolution branches a verification took (ticket
 * 9f06f8f). Both are normal, expected outcomes, not a success/degraded pair:
 *
 *  - `"attached"` -- no `users` row had this email, so the email was attached
 *    to the anonymous user that REQUESTED the link. "Claiming my anonymous
 *    session": `userId` is unchanged, and everything the visitor already had
 *    is already theirs -- there is no data to migrate, because there were
 *    never two identities, only one gaining an email. Only ever returned to
 *    the browser that requested the link (see `"different_browser"` under
 *    `MagicLinkRejectionReason` for the account-fixation attack that
 *    restriction exists to stop).
 *  - `"adopted"` -- a `users` row already had this email, so the verifying
 *    browser adopts THAT user. "Logging in from a second device": `userId` is
 *    a DIFFERENT id than the caller sent, and the caller must start sending
 *    the returned one. Reachable from ANY browser -- that is the feature, and
 *    it requires only control of the inbox.
 */
export type MagicLinkOutcome = "attached" | "adopted";

/**
 * The identity the verifying browser must use from now on.
 *
 * `userId` IS the credential this app's anonymous identity scheme runs on
 * (`x-user-id`, apps/api/src/identity.ts) -- so this response is the one
 * place in the API that hands out a bearer value, and it does so only in
 * exchange for a single-use token that was mailed to the address on the
 * account. Clients must persist it the same way they persist a minted one
 * (apps/web/src/identity.ts's `setUserId`) and must not log it.
 */
export type VerifyMagicLinkResponse = {
  userId: string;
  email: string;
  outcome: MagicLinkOutcome;
};

/**
 * Why a verification was refused (ticket 9f06f8f). Carried as a stable
 * `reason` code beside the human-readable `error` message, following this
 * API's existing convention for a machine-readable refusal
 * (`UpdateResumeNicknameConflictError.reason`), so the frontend can offer the
 * right recovery without string-matching a message:
 *
 *  - `"invalid"` -- no such token. Deliberately does not confirm or deny that
 *    the token ever existed.
 *  - `"expired"` -- the token was real and unredeemed, but `expiresAt` has
 *    passed. Recovery: request a new link.
 *  - `"already_used"` -- the token was already redeemed. Recovery: request a
 *    new link (and note the earlier redemption may well have been this same
 *    user, on this same device, a moment ago).
 *  - `"browser_already_claimed"` -- this browser's anonymous identity already
 *    carries a DIFFERENT email, so attaching this one would silently relabel
 *    an existing account. See routes/auth.ts's own doc comment for the full
 *    reasoning; recovery is to use the other address's link, or a fresh
 *    browser profile.
 *  - `"different_browser"` -- the link is being redeemed somewhere OTHER than
 *    the browser that requested it, AND no account exists for the address yet
 *    (so redemption would take the "attach" branch). Refused because nothing
 *    authenticates who REQUESTS a link: an attacker who POSTs
 *    `/auth/magic-link` for a stranger's address with their own `x-user-id`
 *    would otherwise have the victim's click bind the victim's email to the
 *    ATTACKER's user id, handing that id back for the victim's browser to
 *    adopt -- permanent account fixation (reproduced end to end by fable's
 *    round-3 review of ticket 9f06f8f, 2026-09-27). The token is NOT consumed
 *    by this refusal, so the real requester's own link still works; recovery
 *    is to open it in the browser it was asked for from, after which
 *    `"adopted"` makes every other device work.
 *
 * Telling `expired` apart from `already_used` is a deliberate, narrow
 * disclosure: both are only ever reachable by someone who already holds the
 * 256-bit token, so neither tells an attacker anything they could not already
 * infer, while the difference is exactly what a confused real user needs to
 * see. `different_browser` discloses nothing further for the same reason, and
 * deliberately does NOT reveal whether an account already exists for the
 * address (it is only ever returned when one does not, but reaching it at all
 * already requires holding the token).
 */
export type MagicLinkRejectionReason =
  "invalid" | "expired" | "already_used" | "browser_already_claimed" | "different_browser";

export type VerifyMagicLinkError = {
  error: string;
  reason: MagicLinkRejectionReason;
};

export type SourceHealth = {
  id: Job["dataSource"];
  displayName: string;
  /** A short, factual line about what this source actually covers — e.g.
   * "U.S. federal government positions" for USAJOBS, or a few of the real
   * companies configured for an ATS-backed source. Grounded in what's
   * actually configured/true for this deployment, not generic marketing
   * copy (ticket e493085). Absent for a source with no adapter (it never
   * reaches the frontend at all — see ticket d480357). */
  description?: string;
  configured: boolean;
  error?: string;
};

export type GetSourcesResponse = {
  sources: SourceHealth[];
};

/**
 * The shortlist filter, parameterized (ticket 59fdc52 review round 2 PM
 * ruling, git-bug 59fdc52 comment 2026-08-29). Four fields, mapping
 * directly onto the filter that already existed in
 * apps/api/src/sources/swe-filter.ts post-4450f39 — deliberately NOT the
 * full preferences-as-data model from f0f16de (still open); this is the
 * minimum that makes the API configurable without inventing a schema
 * nobody has validated.
 *
 * Matching is substring/word-boundary, case-insensitive — never a raw
 * user-supplied regex (footgun + ReDoS risk). When a caller omits
 * `criteria` entirely, the API applies a default that reproduces
 * demo-match.ts's `filterSoftwareEngineeringJobs` EXACTLY — see
 * apps/api/src/sources/criteria.ts's `compileFilter` and its live-pool
 * equivalence proof.
 */
export type SearchCriteria = {
  /** Title phrases that qualify. ANY match passes. */
  titleInclude?: string[];
  /** Title phrases that disqualify, applied after include. ANY match
   * rejects. */
  titleExclude?: string[];
  /** Place names that qualify regardless of work arrangement — i.e. "near
   * enough to commute". */
  nearLocations?: string[];
  /**
   * Ticket 410e1a2: let each `nearLocations` phrase ALSO match the other
   * cities of its metro area — "Seattle" also matching a posting located
   * only in "Bellevue, WA" or "Kirkland, WA".
   *
   * OPT-IN, and it stays opt-in. Omitted/`false` is the default and means
   * exactly today's literal matching, byte for byte (the flag selects a
   * different matcher-compiling branch, so "off" is the original code path
   * rather than a re-derivation of it). Nicole raised both sides herself
   * while dogfooding a real Seattle search: some searchers want the metro
   * assumed, others would be annoyed by an unrequested Kirkland commute —
   * so this is a visible checkbox, not a default, and the UI label names
   * the cities it will pull in.
   *
   * Only `nearLocations` is affected; `remoteOk` and every title axis are
   * untouched, and the flag alone (with no `nearLocations`) is not a
   * location restriction. Which cities count is a small curated,
   * evidence-carrying table of OMB/Census metro areas —
   * apps/api/src/sources/metroAreas.ts, which also documents what is
   * deliberately NOT grouped and why.
   */
  expandMetroAreas?: boolean;
  /** Accept confirmed-remote roles anywhere in-country. */
  remoteOk?: boolean;
  /**
   * Which `Job["commitment"]` values are acceptable. Omitted/empty means
   * no restriction (same pattern as every other field here).
   *
   * UNKNOWN-COMMITMENT POSTINGS ARE NOT EXCLUDED. This REVERSES ticket
   * 18c9f18's PM ruling, on 2026-10-06, under ticket 623098e. The reversal
   * is recorded here instead of quietly applied, because the old reasoning
   * was sound-sounding and someone will otherwise re-derive it.
   *
   * WHAT 18c9f18 RULED: a posting whose commitment is genuinely unknown
   * (not every source reports it) is EXCLUDED once this restriction is
   * non-empty, rather than included permissively — the user explicitly
   * asked for e.g. "full-time only", and a job the app cannot verify as
   * full-time does not satisfy that ask. It called itself a deliberate
   * exception to the "unmatched data isn't penalized beyond what was asked"
   * spirit of `nearLocations`/`remoteOk`, on the grounds that commitment was
   * the first field here with real ambiguity in the upstream data.
   *
   * WHAT OVERTURNED IT — a measurement, not a change of taste. Greenhouse's
   * public schema carries NO employment-type field whatsoever: not a
   * structured field, not board-specific `metadata`, at neither the list nor
   * the single-job detail endpoint, verified across all nine boards checked
   * (apps/api/src/sources/greenhouse.ts's header comment). Greenhouse also
   * DOMINATES this corpus — `.env.example` configures 25 Greenhouse boards,
   * and the real pool measured in criteria.ts is 6,203 postings. So every
   * Greenhouse posting has `commitment: undefined` and 18c9f18's rule
   * discarded all of them: checking "full-time" turned a 50-result search
   * into ZERO results, reproduced independently twice (git-bug 623098e).
   * "Full-time" meant "only jobs from whichever sources happen to state
   * employment type", which is empirically near-zero. Treating "cannot
   * verify" as "does not match" is cautious in the abstract but inaccurate
   * on this data, and it fails in the direction that returns an empty page —
   * which the project owner has ruled out explicitly: "I need these people
   * to be getting results so that the service is useful."
   *
   * There is an irony worth recording: the project owner had already made
   * `commitment` OPTIONAL on `Job` because of that same Greenhouse finding,
   * specifically so these postings would not be dropped — and 18c9f18 then
   * dropped them anyway, at filter time instead of normalization time.
   *
   * WHAT REPLACED IT, AND WHY IT IS NOT JUST "INCLUDE UNKNOWNS". A blanket
   * include would fix full-time by breaking the other two values in the
   * opposite direction: unknown is probably full-time, but it is probably
   * NOT part-time or contract, so admitting unknowns everywhere would flood
   * a part-time or contract search with full-time roles and leave those
   * filters meaningless. The resolution is per-value instead: a posting's
   * STRUCTURED commitment wins wherever a source reports one; failing that,
   * its TITLE is consulted (contract/temp, internship and part-time
   * phrasing, measured 0 false positives against all 54 fixture postings
   * that have a structured commitment to check against — an internship
   * matches none of the three values rather than being forced into one);
   * failing that, it is
   * IMPUTED to "full-time". So full-time admits unknowns, part-time and
   * contract do not, and both keep exactly the precision they have today.
   *
   * The imputation lives in the FILTER ONLY and is never written down.
   * `Job.commitment` still reports what the source actually said, and a
   * posting that stated nothing still reports `undefined` — imputing at
   * normalization time would persist a fabricated "Full-time" into Postgres
   * and show the user a claim no employer made.
   *
   * See apps/api/src/sources/criteria.ts for the implementation: its
   * `resolveCommitmentForFilter` carries the per-value argument, and the
   * COMMITMENT AUDIT table beside it records, per source with evidence and a
   * date, which sources actually populate this field (Greenhouse is the only
   * structural zero; the other seven all carry a real upstream field).
   */
  commitmentIn?: Job["commitment"][];
};

/**
 * Ticket aff284b review R1: `estimatedInputTokens` alone is NOT the whole
 * prompt post-caching — it mirrors the Claude API's own `input_tokens`
 * field, which is only the UNCACHED remainder of a prompt once a run's
 * scoring calls share a cached prefix (see
 * `apps/api/src/demo-match.ts`'s `buildCachedPrefix`/`makeClaudeScorer`).
 * A real 200-job run measured `estimatedInputTokens` understating the
 * actual number of prompt tokens sent by ~90% when read as "the" input
 * count. `estimatedCacheReadTokens`/`estimatedCacheCreationTokens` carry
 * the rest of what was actually sent — total tokens sent for a call is
 * always `estimatedInputTokens + estimatedCacheReadTokens +
 * estimatedCacheCreationTokens`. Every caller that renders this to a user
 * (`describeCostEstimate` in demo-match.ts) must show that total, or label
 * `estimatedInputTokens` explicitly as "uncached" — never present it bare
 * as though it were the whole prompt.
 */
export type CostEstimate = {
  jobCount: number;
  /** Uncached input tokens only — the API's `input_tokens`. See this
   * type's own doc comment; do not treat this as the whole prompt. */
  estimatedInputTokens: number;
  /** Cache-read tokens (billed at 0.1x the input rate). 0 on the
   * "bootstrap" basis, which has no way to know the run-time cache-hit
   * split in advance — see `estimateScoringCost`'s doc comment. */
  estimatedCacheReadTokens: number;
  /** Cache-creation (cache-write) tokens (billed at 1.25x the input rate,
   * default 5-minute TTL), counted ONCE per run regardless of job count —
   * a run writes its cache exactly once (ticket aff284b review S1). 0 on
   * the "bootstrap" basis, same reasoning as `estimatedCacheReadTokens`. */
  estimatedCacheCreationTokens: number;
  estimatedOutputTokens: number;
  /** Kept for internal/back-compat reference — equals `probableCostUsd` on
   * BOTH basis values now (ticket 1a2cde3 — see that field's own doc
   * comment). Not for display: ticket e493085/e85fa9b — Nicole asked to
   * see plain "Max cost" / "Probable cost" numbers, not token buckets or a
   * third ambiguous "estimated" figure. UI code should read `maxCostUsd` /
   * `probableCostUsd` directly. */
  estimatedCostUsd: number;
  /**
   * A genuine worst-case ceiling, grounded in the model's real hard output
   * cap (`MAX_OUTPUT_TOKENS`) applied to every job — never exceeded by an
   * actual run, since that cap is code-enforced on every scoring call
   * (`demo-match.ts`'s `makeClaudeScorer`). Computed the same way on both
   * `basis` values (ticket e85fa9b): previously only "bootstrap" had a
   * ceiling at all.
   */
  maxCostUsd: number;
  /**
   * The best real-data guess at what a run will actually cost. On
   * "measured" basis this comes from genuine historical averages
   * (`usageStats`) — a real, grounded number, not an assumption. On
   * "bootstrap" (no prior run has ever completed, so no measured data
   * exists at all), this ticket (1a2cde3) replaced an earlier
   * bootstrap-equals-`maxCostUsd` tie with a real, non-arbitrary signal
   * instead: the scorer's response is JSON-schema-shaped (a score, a short
   * rationale, two short string arrays — see `demo-match.ts`'s `SCHEMA`),
   * not free text, so a realistic typical output size can be estimated
   * FROM that schema rather than assumed to hit the hard cap every call.
   * See `demo-match.ts`'s `TYPICAL_OUTPUT_CHARS_PER_JOB` for the real
   * measurement this is grounded in. Narrow/temporary in a different sense
   * now: the app's first completed run makes `usageStats` non-empty, and
   * every estimate after that is "measured" — a genuinely observed number,
   * strictly better than even a well-grounded schema guess.
   */
  probableCostUsd: number;
  basis: "measured" | "bootstrap";
};

export type SkippedSource = {
  id: string;
  reason: string;
};

export type BoardCoverageEntry = {
  token: string;
  status: "not-found" | "empty" | "ok" | "error";
  postingCount: number;
  companyName?: string;
  message?: string;
  skippedCount: number;
  survivedFilter: number;
  /**
   * How many of this token's title-passing postings were excluded
   * specifically because they're "somewhere in the US" with no evidence of
   * a remote work arrangement (ticket 14289ac) — distinct from every other
   * reason a token can contribute zero survivors (not-found, empty, error,
   * or filtered out for an unrelated reason). See apps/api's
   * `BoardCoverageEntry` (demo-match.ts) for the full reasoning; this is
   * the same field, mirrored into the REST contract.
   */
  excludedForMissingWorkArrangement: number;
};

export type SourceOutcome = {
  dataSource: Job["dataSource"];
  status: "ok" | "empty" | "error";
  jobsFound: number;
  skippedCount: number;
  skipRate: number;
  survivedFilter: number;
  /** Source-level total of `BoardCoverageEntry.excludedForMissingWorkArrangement`
   * across every token of this source — ticket 14289ac. See that field's
   * doc comment. */
  excludedForMissingWorkArrangement: number;
  errorMessage?: string;
  boardCoverage: BoardCoverageEntry[];
};

export type EstimateSearchRequest = {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
  /**
   * Ticket bf2dd0a. Optional, caller-minted id for the LIGHTWEIGHT progress
   * side channel — see apps/api's `matching/estimateProgress.ts` for the
   * full design. `POST /searches/estimate` stays exactly as synchronous as
   * ever; this id, if supplied, only lets the caller also poll
   * `GET /searches/estimate/:requestId/progress` WHILE that blocking call is
   * still in flight, to show something better than a bare spinner ("3 of 8
   * sources checked"). Minted by the CALLER, not the server, because the
   * server has no way to hand back an id before the blocking response it's
   * attached to — the frontend generates one (`crypto.randomUUID()`) before
   * firing the request and starts polling immediately after, not after the
   * POST resolves. Omitting it costs nothing: the estimate runs identically
   * either way, just with no progress record to poll.
   */
  estimateRequestId?: string;
};

/**
 * One source's progress within a `POST /searches/estimate` run currently
 * being tracked under `EstimateProgressResponse.requestId` (ticket bf2dd0a).
 * Deliberately thinner than `SourceOutcome` — no jobsFound/skipRate/etc:
 * this is pure "has this source's fetch settled yet", read live while the
 * estimate is still running, not the rich per-source result the estimate's
 * own final response (`SourceOutcome`) carries once it's done.
 */
export type EstimateProgressSourceState = {
  sourceId: string;
  status: "pending" | "done";
};

/**
 * `GET /searches/estimate/:requestId/progress` (ticket bf2dd0a) — the
 * optional side channel a caller polls WHILE `POST /searches/estimate` is
 * still blocking, to answer "which of the selected sources have reported in
 * so far" instead of showing a bare spinner. NOT part of the estimate's
 * completion contract: the POST call still returns the final
 * `EstimateSearchResponse` synchronously in one response, exactly as before
 * this ticket, whether or not anything ever polls this endpoint. A 404 here
 * (no `EstimateProgressResponse` to return) means "no tracked run under this
 * id" — never started (the caller omitted `estimateRequestId`), already past
 * its retention window, or a process restart — and is an entirely normal,
 * expected outcome a poller should treat as "nothing to show yet", not an
 * error.
 */
export type EstimateProgressResponse = {
  requestId: string;
  /** How many sources this estimate run started with — every source the
   * caller selected, whether or not it ultimately succeeds. */
  total: number;
  /** How many of `total` have settled (fetched successfully OR failed) so
   * far. `completed === total` means every source has reported in; the
   * blocking POST itself finishes at essentially the same moment, since the
   * estimate path never reaches scoring. */
  completed: number;
  sources: EstimateProgressSourceState[];
  done: boolean;
};

/**
 * `costEstimate` reflects exactly what a real `POST /searches` run would
 * spend scoring every job in `candidatesNeedingScore` — the full pool that
 * needs a new score, not a capped subset.
 *
 * Ticket d37511b removed `scoreThreshold` and `cappedCount`: this response
 * used to be cap-aware (ticket 59fdc52 review round 2, "estimate is wrong
 * by ~30x") because a real run never scored more than `scoreThreshold`
 * jobs and deferred the rest (`cappedCount`). Now that a real run scores
 * the whole pool, `costEstimate` simply prices the whole pool, and there is
 * nothing left to defer or explain the size of.
 */
export type EstimateSearchResponse = {
  resumeId: string;
  costEstimate: CostEstimate;
  candidatesNeedingScore: number;
  alreadyScored: number;
  sourceOutcomes: SourceOutcome[];
  skippedSources: SkippedSource[];
  /**
   * Ticket e5e1aa1 review round 2 (D8/Required 4): the reasons
   * `SearchCriteria.expandMetroAreas` could not expand one or more
   * `nearLocations` entries -- e.g. a typed city absent from the bundled
   * coordinate dataset, or one whose bare name is ambiguous across states
   * ("Boston" exists in GA, IN and MA) and so needs a state added to
   * resolve. `[]` whenever the flag is off, there is nothing to expand, or
   * every entry expanded successfully -- never populated speculatively.
   * `apps/api/src/sources/metroAreas.ts`'s `nearbyCityExpansionWarnings` is
   * what computes these; this field is what gets them from there to the
   * checkbox the user actually sees (`SearchCriteriaForm.tsx`), which a
   * server-side `console.warn` alone -- visible to an operator, not to the
   * person who ticked the box -- did not satisfy.
   */
  locationWarnings: string[];
};

export type StartSearchRequest = {
  resumeId: string;
  sourceIds: string[];
  criteria?: SearchCriteria;
};

export type StartSearchResponse = {
  searchId: string;
  status: "pending";
  skippedSources: SkippedSource[];
};

/**
 * One source's durable state within a search (ticket 4f88339, design
 * c54b9e0 §5.3) — the `search_sources` row, as the REST contract sees it.
 *
 * Deliberately THINNER than `SourceOutcome` above: no `boardCoverage`, no
 * `skipRate`, no `survivedFilter`. Those exist only in the fetch worker's
 * memory for the duration of one message and were never persisted, so a
 * durable read path cannot honestly produce them. What IS here is what
 * ticket 59fdc52's fourth acceptance criterion actually asked for —
 * "unavailable sources are reported per-source so the UI can show a source
 * as failed" — now answerable from Postgres alone, after a restart, from a
 * process that never handled the search. Persisting the richer per-source
 * telemetry is real follow-up work, deliberately not smuggled in here.
 */
export type SearchSourceState = {
  /** `Job["dataSource"]` — the same id `POST /searches` was given. */
  sourceId: string;
  status: "pending" | "complete" | "failed";
  /** Jobs this source linked to the search. `null` until the source
   * reaches a terminal state (and for a `failed` source that never got
   * far enough to link anything). */
  linkedJobCount: number | null;
  /** Only on `failed`: the worker's own classification
   * ("rate-limited", "source-search-timeout", "unknown-source", ...) or
   * "dispatch-failed" when the API could not publish the message at all. */
  errorKind?: string;
  errorMessage?: string;
};

/**
 * `GET /searches/:id`. Every member has its OWN `status` literal (ticket
 * 59fdc52 review round 3, F3 — blocking): an earlier version reused
 * `status: "complete"` for both the live, in-memory-tracked result AND the
 * restart-fallback case (a `searches` row found in the database, but this
 * API process's own in-memory tracker never heard of the run), which meant
 * the two members were NOT distinguishable by `status` alone — TypeScript
 * can only narrow a union by a discriminant that is unique per member, so
 * `if (r.status === "complete") { r.newlyScored }` failed to compile
 * (`r` narrowed to the UNION of both "complete" members, and only one of
 * them has `newlyScored`). A frontend hitting that would have had to
 * reverse-engineer the shape (e.g. `!("note" in r)`) instead of narrowing
 * on `status` the normal way — exactly what AC3 (response types come from
 * `@app/shared`, not redeclared) exists to prevent.
 *
 * REVISED FOR QUEUE-DRIVEN SEARCH (ticket 4f88339, design c54b9e0 §5.3).
 * Every field on the `"pending"` and `"complete"` members is now REBUILT
 * FROM POSTGRES on each request rather than read out of an in-memory
 * tracker that a restart erases — which is strictly stronger than what the
 * tracker provided: correct across restarts, correct across multiple API
 * processes, correct for a search this process never handled. The
 * `searchRuns` Map that used to back them is deleted outright.
 *
 * - `"pending"` — the search is genuinely still outstanding: at least one
 *   source has not reached a terminal state, or at least one linked job
 *   has neither a score nor a permanent-failure record. `scoredSoFar` is
 *   KEPT under its existing name and semantics (a count of jobs
 *   successfully scored, never a count of attempts) so `SearchFlow.tsx`'s
 *   poll loop and its out-of-order-poll guard keep working; it is now the
 *   durable count (linked jobs with a `job_matches` row for this search's
 *   resume) rather than an in-process increment. `linked` is the
 *   denominator that count is "of" — durable for the first time, which is
 *   what a reloaded page needs to rebuild a progress bar.
 * - `"complete"` — nothing is outstanding. `scored` + `failed` account for
 *   every one of the `linked` jobs. `degraded` is exactly `failed > 0`: a
 *   job that could not be scored is a REPORTABLE OUTCOME, not a blocker
 *   (one unscorable posting out of 180 must never hide the other 179 —
 *   CLAUDE.md's DLQ philosophy applied one level down from sources to
 *   jobs). There is deliberately no "mostly failed" middle state: real
 *   counts plus `degraded` let the UI decide how loud to be, which is the
 *   right place for that decision. `costEstimate` is NOT on this member
 *   any more — it was a `RunDemoMatchResult` field with no queue-driven
 *   analogue (no single run computes one) and no durable home. `POST
 *   /searches/estimate` still returns it, unchanged; that is where it
 *   belongs.
 *
 *   TWO-WAY AGAIN, AS OF TICKET d37511b. Ticket c9c676d had split this
 *   field (then named `permanentlyFailed`) three ways against `scored` and
 *   a budget-capped third bucket (`cappedForBudget`), because a search
 *   could deliberately never attempt scoring some jobs once it spent a
 *   per-search scoring budget — "we ran out of budget for these" is not
 *   "these are broken." Ticket d37511b removed that budget concept
 *   outright (`DEFAULT_SCORE_THRESHOLD`, `cappedForBudget` and the UI
 *   bookkeeping around both confused a real user and were removed at
 *   Nicole's explicit request), so there is no third bucket left to carve
 *   out: `failed` (renamed from `permanentlyFailed` — the old name implied
 *   a distinction from a capped bucket that no longer exists) is once again
 *   simply every linked job that isn't `scored`.
 * - `"failed"` — either the search could not be dispatched at all (no
 *   source's `fetch.source` message could be published), or TOTAL SCORING
 *   FAILURE: every linked job permanently failed and none was scored.
 *   That carve-out is deliberate and follows `runDemoMatch`'s own
 *   `isTotalScoringFailure` precedent: source failures are independent
 *   (USAJOBS being down says nothing about Lever), but scoring failures
 *   usually are not — an expired API key, a retired model id, or an
 *   exhausted budget fails every job identically, and reporting
 *   "complete, 0 of 180 scored" as a normal completion would be
 *   technically true and practically a lie.
 * - `"complete-details-unavailable"` — the `searches` row says
 *   `'complete'` but carries no `completed_at` latch, so there is no
 *   durable per-source/per-job ledger to derive details from. Still
 *   reachable, and deliberately kept: every pre-migration row, every
 *   CLI (`runDemoMatch`) row and every `POST /searches/estimate` row looks
 *   exactly like this, and they must keep behaving the way ticket 59fdc52
 *   made them behave. Results are fully queryable via
 *   `GET /resumes/:id/results` regardless.
 * - `"incomplete"` — a pre-queue row stuck at `'running'` with no
 *   `search_sources` ledger to interrogate. It may still be running
 *   elsewhere, or it may have died mid-scoring — never presented as
 *   `"complete"` just because a row exists (ticket 59fdc52 review round 2,
 *   "restart fallback can't report complete for a run that died after
 *   scoring 3 of 200"). Queue-driven searches do not reach this member:
 *   their work lives in RabbitMQ rather than in a process that can die
 *   with it, so the derive can say precisely what is still outstanding.
 */
export type SearchStatusResponse =
  | {
      searchId: string;
      status: "pending";
      resumeId: string;
      /** Linked jobs already scored for this search's resume. Same name
       * and same "successful scores only" semantics as before. */
      scoredSoFar: number;
      /** Jobs this search has linked SO FAR (it grows while sources are
       * still fetching). The denominator `scoredSoFar` is "of". */
      linked: number;
      /** Linked jobs whose scoring was ATTEMPTED and will never succeed —
       * a `score.job` message that exhausted its retries or failed
       * permanently. Named `failed`, not `permanentlyFailed`: ticket
       * d37511b removed the budget-capped third bucket
       * (`cappedForBudget`) this name used to be distinguished FROM, so
       * there is no longer a distinction to carry in the name. */
      failed: number;
      /** False while any source is still `pending`. This is what keeps
       * "every linked job is scored" from reading as TRUE for a search
       * with zero linked jobs — a brand-new search is `pending`, never
       * `complete`. */
      sourcesSettled: boolean;
      sources: SearchSourceState[];
      /** Set only when the search has been outstanding past the stall
       * window (see `routes/searches.ts`'s `STALL_AFTER_MS`): the marker
       * write for a dead-lettered message failed, so nothing will ever
       * settle this on its own. REPORTED, never auto-healed — replaying
       * from the DLQ is an operator action. Its value is the search's
       * `searchedAt`. */
      stalledSince?: string;
      /** Enumerated only alongside `stalledSince`: exactly which jobs are
       * still outstanding, so an operator can find them in the DLQ. */
      outstandingJobIds?: string[];
    }
  | { searchId: string; status: "failed"; resumeId: string; error?: string }
  | {
      searchId: string;
      status: "complete";
      resumeId: string;
      /** Linked jobs with a score for this search's resume. */
      scored: number;
      /**
       * Linked jobs whose scoring was ATTEMPTED and permanently failed —
       * retries exhausted, an expired API key, a retired model id. Something
       * went wrong. Named `failed`, not `permanentlyFailed` — see the
       * `"pending"` member's doc comment on the same rename, ticket
       * d37511b.
       *
       * `scored + failed === linked`, once again a plain two-way split
       * (ticket d37511b removed the budget-capped third bucket ticket
       * c9c676d had split this into).
       */
      failed: number;
      /** Jobs this search linked. `scored + failed === linked`. */
      linked: number;
      sources: SearchSourceState[];
      /** ISO timestamp of the first read that observed this search
       * terminal (schema.ts's `searches.completedAt`). */
      completedAt: string;
      /** `failed > 0` — finished, but something actually went wrong while
       * scoring. */
      degraded: boolean;
    }
  | {
      searchId: string;
      status: "complete-details-unavailable";
      resumeId: string;
      note: string;
    }
  | {
      searchId: string;
      status: "incomplete";
      resumeId: string;
      note: string;
    };
