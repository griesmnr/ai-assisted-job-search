import { pgTable, text } from "drizzle-orm/pg-core";
import { boolean } from "drizzle-orm/pg-core";
import { timestamp } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { integer } from "drizzle-orm/pg-core";
import { jsonb } from "drizzle-orm/pg-core";
import { unique } from "drizzle-orm/pg-core";

export const sourceDescriptors = pgTable("source_descriptors", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
});

export const payTypeEnum = pgEnum("pay_type", ["hourly", "salary"]);
export const commitmentEnum = pgEnum("commitment", ["full-time", "part-time", "contract"]);
export const locationTypeEnum = pgEnum("location_type", ["remote", "onsite", "hybrid"]);
// Ticket b182bde: leveling fit, judged separately from `matchScore`
// (capability fit) in the same scoring call. See `SCHEMA`/`SCORING_PREAMBLE`
// in demo-match.ts for the prompt side of this and `jobMatches.levelFit`'s
// own doc comment below for why the column is nullable.
export const levelFitEnum = pgEnum("level_fit", [
  "underqualified",
  "well_matched",
  "overqualified",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    externalId: text("external_id").notNull(),
    dataSource: text("data_source")
      .notNull()
      .references(() => sourceDescriptors.id),
    title: text("title").notNull(),
    description: text("description").notNull(),
    company: text("company").notNull(),
    // Nullable: sources differ on whether they publish these at all.
    // See the note on Job.payType in packages/shared.
    payType: payTypeEnum("pay_type"),
    commitment: commitmentEnum("commitment"),
    locationType: locationTypeEnum("location_type"),
    location: text("location"),
    linkToApply: text("link_to_apply").notNull(),
    postedAt: timestamp("posted_at").notNull(),
  },
  (table) => [unique().on(table.dataSource, table.externalId)],
);

/**
 * Ticket dba885e (epic 2b9e9dd): every visitor's anonymous, invisible
 * identity. `id` is NEVER server-generated -- it's a `crypto.randomUUID()`
 * minted client-side (apps/web/src/identity.ts) the first time a browser
 * needs one, persisted in `localStorage` (deliberately NOT `session.ts`'s
 * sessionStorage -- this identity must outlive a tab close, unlike the
 * rest of that file's app-state restore), and sent as the `x-user-id`
 * header on every request. `identity.ts` (this package) creates the row
 * lazily the first time a given id is actually seen -- there is no
 * separate "register" step, and no UI moment at all until a real login
 * happens.
 *
 * `email` starts NULL for every row and stays that way until ticket
 * 9f06f8f's magic-link flow attaches one -- see that ticket for why this
 * is deliberately NOT the login mechanism itself, only what a login
 * later claims. `.unique()`: two different anonymous ids must never both
 * claim the same email (multiple NULLs are fine under a standard unique
 * constraint -- SQL never treats NULL as equal to another NULL).
 *
 * WHY THIS TABLE EXISTS AT ALL, AND WHY NOW: resume-lock design
 * (2026-09-26 conversation, epic 2b9e9dd) needed resume-text/nickname
 * uniqueness scoped per-person, not globally (Nicole: using a friend's
 * resume as test data must never collide with that friend's own later,
 * real usage) -- schema.ts's own `user_job_statuses` doc comment already
 * anticipated this exact moment years in advance.
 */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/**
 * Ticket b2f9dfd (epic 2b9e9dd, child 2): the well-known id every resume
 * row that existed BEFORE real per-user identity did gets backfilled to
 * (migration 0016), and the id `demo-match.ts`'s CLI path uses going
 * forward -- that tool is an explicit bypass of the queue and the API
 * (its own header comment), never a real end user, so attributing its
 * output to a shared "no real account" bucket is honest rather than
 * inventing a fake per-run identity that would break its own documented
 * "running this twice doesn't re-pay for identical work" guarantee (a
 * fresh random id per CLI run would make every run look like a different
 * user, and the PER-USER resume-hash LOOKUP this ticket introduced -- a
 * database constraint then, an ordinary query since ticket 6ba221e, see
 * `resumeHash` below -- would then never find the previous run's cached
 * resume row). The nil UUID is
 * used deliberately for recognizability, not because it needs to be a
 * real `crypto.randomUUID()` -- nothing validates a `users.id` value's
 * shape at the database layer; only `apps/api/src/identity.ts`'s HTTP
 * header check does that, and this id is never sent as that header.
 */
export const LEGACY_USER_ID = "00000000-0000-0000-0000-000000000000";

export const resumes = pgTable(
  "resumes",
  {
    id: text("id").primaryKey(),
    // Ticket b2f9dfd: which user owns this resume. NOT NULL -- migration
    // 0016 backfills every pre-existing row to LEGACY_USER_ID above before
    // adding this constraint, the same "nullable, backfill, then NOT NULL"
    // shape migrations 0010/0013 already used for an identical reason.
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    // MUTABLE since ticket 6ba221e -- `PUT /resumes/:id/text`
    // (routes/resumes.ts) rewrites this column in place, keeping the same
    // `id`. Before that ticket a resume's text was effectively immutable:
    // the only way to "change" it was to submit different text, which
    // (see `resumeHash` below) minted a different row.
    resumeText: text("resume_text").notNull(),
    // Content hash (sha256 hex) of resumeText.
    //
    // AN ORDINARY COLUMN AS OF TICKET 6ba221e -- NOT AN IDENTITY. Read the
    // history below before adding a constraint back to it.
    //
    // What it is still for: a cheap, fixed-size equality lookup for "does
    // this user already have a row with exactly this text?", used by
    // `getOrCreateResumeId` (matching/pipeline.ts) on the CREATE path so
    // that re-pasting text you already have saved resolves to the row you
    // already have instead of minting an indistinguishable second one, and
    // by `runDemoMatch`'s CLI entry point so a repeat run doesn't re-pay
    // for identical work. That is a CONVENIENCE, not an invariant: nothing
    // in the database or the application depends on it being unique, and
    // the lookup is deliberately deterministic (`ORDER BY created_at, id`)
    // precisely because more than one row can now match it.
    //
    // Why hashed at all, rather than querying `resume_text` directly
    // (ticket 620ca30, and still the reason): a real resume's text can
    // exceed Postgres's ~2704-byte btree index row limit, so the column
    // that gets an index has to be small and fixed-size. The hash is still
    // the indexable stand-in for the text even with no unique constraint
    // on it.
    //
    // HISTORY OF THE CONSTRAINT THAT USED TO LIVE HERE, kept because its
    // reasoning was sound for what it was solving and a future change may
    // need it:
    //   - Ticket 620ca30 added `unique(resume_hash)` (global) and built
    //     find-or-create on `ON CONFLICT (resume_hash) DO NOTHING`, which
    //     made two concurrent submissions of identical text resolve to
    //     exactly one row with no select-then-insert race.
    //   - Ticket b2f9dfd widened it to the composite
    //     `unique(user_id, resume_hash)` (per-user), for Nicole's own
    //     motivating case: using a friend's resume as test data must never
    //     collide with that friend's own later, real usage of the identical
    //     text.
    //   - Ticket 6ba221e DROPPED it (migration 0019) and replaced it with
    //     nothing. Identity is `id`, the primary key, and always was; this
    //     index was the one thing making text behave like a second,
    //     competing identity, which is what surfaced to users as "I edited
    //     Resume 1 and it became Resume 2" and as a 409 naming a resume
    //     they never created. Nicole, verbatim: "I know that it was a
    //     previous requirement of mine that it wouldn't let the exact same
    //     text exist for two resumes before, but now I frankly don't care
    //     about that... Let them do that. If they want to do that, that's
    //     their business."
    //
    // WHAT WAS GIVEN UP WITH IT, stated plainly rather than left to be
    // discovered: the race-free upsert. Two concurrent submissions of
    // identical text can now produce TWO rows instead of one. That is the
    // accepted outcome under the new rules (two identical-text resumes are
    // legal), not a bug -- what matters is that it is not an ERROR, which
    // `getOrCreateResumeId`'s select-then-insert guarantees and
    // routes/resumes.test.ts's concurrency test proves.
    resumeHash: text("resume_hash").notNull(),
    // Ticket 39b4a48: job title keywords Claude infers from this resume,
    // computed lazily and then cached on the row. Nullable, not an empty
    // array by default: null means "inference hasn't run yet or failed",
    // [] means "ran, found nothing to suggest" -- the route distinguishes
    // these to decide whether to retry. See routes/resumes.ts.
    //
    // 39b4a48's ORIGINAL justification for caching was that find-or-create
    // deduped identical resume text to one row, so a resume's text could
    // never change under its cached titles. TICKET 6ba221e ENDED THAT: the
    // text is mutable now (`resumeText` above), so the cache is no longer
    // safe on its own. What makes it safe instead is INVALIDATION:
    // `PUT /resumes/:id/text` sets this column back to `null` whenever the
    // text actually changes, and re-infers. The cost is explicit and
    // recurring -- one paid Claude call per real text edit, where before
    // there was at most one per resume, ever. See that route for why
    // nulling without re-inferring was rejected.
    suggestedTitles: jsonb("suggested_titles").$type<string[]>(),
    // Ticket 38a7598: when this row was created. Added alongside
    // `resumeNickname` below purely so a deterministic backfill order
    // ("Resume 1", "Resume 2", ... in creation order) exists at all --
    // `id` is a `randomUUID()` (matching/pipeline.ts's `getOrCreateResumeId`),
    // not time-ordered, so there was previously no column that could answer
    // "which of these rows came first." NOT NULL with `defaultNow()`: every
    // row from this migration forward gets a real creation time for free;
    // migration 0010 backfills existing rows to the single instant the
    // migration ran (Postgres evaluates a volatile ALTER ... DEFAULT once for
    // pre-existing rows), which is honest -- their real creation time was
    // never recorded -- and still gives a stable, deterministic tiebreak
    // (`created_at, id`) for that migration's own nickname backfill.
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Ticket 38a7598 (Nicole: "when they use this resume, they should be at
    // that moment... choosing the resume nickname"): a real, distinct label
    // per resume ("Resume 1", "Resume 2", ...), chosen/confirmed in the
    // resume-submission flow (ResumeInput.tsx) rather than a separate
    // settings screen, and shown on every job card ("Searched with: ...") so
    // results from different resumes are never mixed up on sight. NOT NULL:
    // `getOrCreateResumeId` always assigns a real default at insert time (see
    // that function's own comment), and migration 0010 backfills every
    // pre-existing row before adding this constraint -- there is never a
    // window where a real row has a blank nickname. Editable after creation
    // via `PATCH /resumes/:id` (routes/resumes.ts).
    //
    // Ticket b2f9dfd: uniqueness/collision-checking on this field (routes/
    // resumes.ts) and the "Resume N" numbering scheme (getOrCreateResumeId)
    // are now both scoped `WHERE user_id = ...` -- two different users can
    // each have their own "Resume 1".
    //
    // Ticket 6ba221e: SURVIVES A TEXT EDIT, and that is the whole point of
    // that ticket as the user experienced it. Editing a resume's text used
    // to produce a new row and therefore a fresh "Resume N+1" default
    // (Nicole: "if I'm on resume one and I make an edit and I hit save and
    // it's still called resume one, it actually becomes resume 2").
    // `PUT /resumes/:id/text` never touches this column, so a rename the
    // user made is never silently undone by editing the text afterwards.
    resumeNickname: text("resume_nickname").notNull(),
  },
  // NO table-level constraints. Ticket 6ba221e dropped the only one this
  // table ever had (`unique(user_id, resume_hash)`, migration 0019) -- see
  // the `resumeHash` column comment above for the full history and for
  // what was given up with it. An empty extras array rather than the
  // argument being removed entirely: drizzle accepts both, and keeping the
  // callback makes it obvious at a glance that the absence of constraints
  // here is a decision rather than an oversight.
  () => [],
);

export const jobMatches = pgTable(
  "job_matches",
  {
    id: text("id").primaryKey(),
    resumeId: text("resume_id")
      .notNull()
      .references(() => resumes.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    matchScore: integer("match_score").notNull(),
    rationale: text("rationale").notNull(),
    // The discrete objections/highlights behind the score — the
    // highest-signal part of what the model returns. Nullable: rows
    // scored before this column existed have none, and inserting an empty
    // array vs. NULL for "the model returned nothing here" isn't a
    // distinction worth forcing. New rows always populate both (see
    // demo-match.ts's ScoredJob). See ticket 620ca30.
    strengths: jsonb("strengths").$type<string[]>(),
    gaps: jsonb("gaps").$type<string[]>(),
    // Ticket b182bde: same nullability story as strengths/gaps above — rows
    // scored before this column existed (and any future row a caller
    // deliberately declines to judge) have no level-fit opinion at all.
    // `null` must never be treated as (or defaulted to) "well_matched" —
    // that would fabricate a claim the model never made; see
    // routes/resumes.ts's ORDER BY and the frontend render path for the
    // same rule applied on read.
    levelFit: levelFitEnum("level_fit"),
    levelFitNote: text("level_fit_note"),
  },
  // Makes a duplicate scoring attempt (redelivery, a second demo-match run,
  // a retried score.job message) harmless instead of an expensive repeat
  // LLM call: the insert either lands once or is rejected/no-ops on
  // conflict, mirroring jobs' own (data_source, external_id) uniqueness
  // and search_results' (search_id, job_id) uniqueness. See ticket 620ca30.
  (table) => [unique().on(table.resumeId, table.jobId)],
);

// Ticket 59fdc52 review round 2, finding "the restart fallback can't report
// complete for a run that died after scoring 3 of 200": without a
// completion marker, GET /searches/:id's DB-fallback branch (used once the
// in-memory tracker has lost this run — e.g. after an API process restart)
// had no way to tell "this run finished" apart from "this run's process
// died mid-scoring" — a `searches` row existing looked identical either
// way, so the fallback always claimed `status: "complete"` regardless.
export const searchStatusEnum = pgEnum("search_status", ["running", "complete", "failed"]);

export const searches = pgTable("searches", {
  id: text("id").primaryKey(),
  resumeId: text("resume_id")
    .notNull()
    .references(() => resumes.id),
  searchedAt: timestamp("searched_at").notNull(),
  /**
   * Ticket 4f88339 (design c54b9e0 §3.3): when the completion derive in
   * `GET /searches/:id` first evaluated this search terminal. A MONOTONIC
   * LATCH AND PURE CACHE, never a gate — it is written exactly once,
   * `WHERE completed_at IS NULL`, so racing readers converge instead of
   * fighting. Two things it buys: a real finish time for the UI, and a
   * one-row fast path that skips the two-query derive on every subsequent
   * poll of a finished search.
   *
   * NULL is not "not finished" — it is "no queue-driven derive has ever
   * latched this row". Every pre-migration row, every CLI (`runDemoMatch`)
   * row, and every `POST /searches/estimate` row has `status = 'complete'`
   * with `completed_at` NULL, and the read path deliberately keeps
   * answering those the way ticket 59fdc52 made it answer them
   * (`complete-details-unavailable`): they have no durable per-source or
   * per-job ledger to derive rich details from. `completed_at IS NOT NULL`
   * is therefore also the signal that says "this row's details CAN be
   * rebuilt from Postgres" — see routes/searches.ts's read path.
   */
  completedAt: timestamp("completed_at"),
  // Defaults to "running" so the row looks in-flight from the moment
  // runDemoMatch inserts it (before any scoring happens), not after some
  // later step remembers to say so. demo-match.ts's `runDemoMatch` sets
  // this to "complete" right before it returns (both the `estimateOnly`
  // early return and the normal end) — if the process dies before that
  // line runs, the row is left at "running" forever, which is the honest
  // signal ("never confirmed complete"), not a guess. The REST API's
  // POST /searches route sets it to "failed" in its own catch handler when
  // the whole run rejects.
  status: searchStatusEnum("status").notNull().default("running"),
  /**
   * Ticket 88f11d7: `true` for a `POST /searches/estimate` row, `false`
   * for a real `POST /searches` (or CLI `runDemoMatch`) row. Added
   * because nothing else distinguishes them once both are terminal --
   * `status` converges to `'complete'` for BOTH (see `status`'s own doc
   * comment above: "every... `POST /searches/estimate` row has `status =
   * 'complete'`"), and `runDemoMatch` inserts a full `searches` row (plus
   * `search_sources` rows) for an estimate too, not just a real search
   * (routes/searches.ts's `liveSearchPredicate` comment already notes
   * this same fact for a different reason -- keeping an estimate from
   * wedging the in-flight guard).
   *
   * Exists specifically so "has this resume ever had a REAL search run
   * against it" (the resume-lock rule ResumeInput.tsx enforces) is a
   * plain, always-correct column check -- `EXISTS (SELECT 1 FROM
   * searches WHERE resume_id = X AND is_estimate = false)` -- rather
   * than inferred indirectly from `job_matches`/`job_match_failures`
   * existing, which has a real gap: a real search that happens to score
   * literally nothing (every job filtered out or every attempt failed)
   * would leave a resume looking unsearched under that approach, even
   * though a real search -- Nicole's own stated trigger -- did happen.
   *
   * Defaults to `false` (a real search) deliberately, not `true`: every
   * write site that means "this is just an estimate" sets it
   * explicitly (`matching/pipeline.ts`'s `runDemoMatch`, from its own
   * `estimateOnly` parameter), so a future write site that forgets to
   * set this column at all fails safe -- it reads as a REAL search
   * (locks the resume) rather than silently exempting itself from
   * locking.
   *
   * HISTORICAL ROWS (review round 2, N2): the column default above only
   * governs what a NEW write does when it forgets to set this. Every row
   * that existed BEFORE this migration would, unless corrected, read that
   * same default -- but for THOSE rows `false` is not a fail-safe, it is
   * a guess, and the wrong one for any historical row that was only ever
   * an estimate (a real, pre-existing gap this migration found: 3 of 5
   * resumes in an actual sandbox check at review time). The migration
   * itself (`0014_big_thunderball.sql`) backfills historical rows using
   * `job_matches`/`search_results`/`job_match_failures` as the best
   * available evidence of which ones were real -- see that file's own
   * comment for exactly why that ONE-TIME backfill is a different,
   * narrower call than the ongoing-inference gap this doc comment
   * rejects two paragraphs up.
   */
  isEstimate: boolean("is_estimate").notNull().default(false),
});

export const searchResults = pgTable(
  "search_results",
  {
    id: text("id").primaryKey(),
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
  },
  // Backs the ingestion worker's idempotent link step (RTK-08/RTK-09): a
  // redelivered fetch.source message re-runs the same (search, job) link
  // and must not create a duplicate row, mirroring the jobs table's own
  // (data_source, external_id) uniqueness.
  (table) => [unique().on(table.searchId, table.jobId)],
);

/**
 * The user's own status toward a job (ticket 0c319b2).
 *
 * WHY A SEPARATE TABLE, NOT COLUMNS ON `job_matches`: `job_matches` is a
 * derived cache. Every column on it (match_score, rationale, strengths,
 * gaps) is recomputable — delete the whole table and a rerun of
 * `runDemoMatch` reproduces it for the price of the Claude calls. "I
 * applied to this job" is the opposite: an authored, irreversible fact
 * about something the user did in the world, which nothing in this system
 * can reconstruct once lost. Putting an authored fact in a recomputable
 * table means any future "just re-score from scratch" / "drop the stale
 * cache" operation silently destroys it. Different lifetimes, different
 * tables.
 *
 * WHY THE NAME IS NOT `JobStatus`: `jobs` will plausibly grow its own
 * `status` column for the POSTING's lifecycle (open / filled / expired) —
 * a fact about the employer's listing, not about the user. Two different
 * things called "job status" one join apart is a bug waiting to be typed.
 * `user_job_statuses` names whose status it is, which is the whole
 * distinction. (`job_pipeline` was the other candidate; rejected because
 * "pipeline" implies the multi-stage post-application funnel this table
 * deliberately does NOT model — see the boundary note below.)
 *
 * The Postgres enum is singular (`user_job_status`, the status VALUE) and
 * the table plural (`user_job_statuses`, the rows), matching the repo's
 * plural table convention (`jobs`, `resumes`, `job_matches`,
 * `search_results`) and, more practically, avoiding an outright collision:
 * a table and a type cannot share a name in Postgres, since `CREATE TABLE`
 * also creates a composite type of that name.
 *
 * WHERE THE LIFECYCLE STOPS, AND WHY: exactly four statuses, ending at
 * `applied`. `rejected` / `interviewing` / `offer` / `ghosted` are
 * deliberately NOT modelled. Everything up to and including `applied` is
 * something THIS app observes directly — it showed the posting, it helped
 * optimize the resume against it, the user hit apply from here. Everything
 * after `applied` happens in the user's inbox, on the phone, in someone
 * else's ATS; this app has no signal for any of it and would be reduced to
 * asking the user to hand-maintain a status field. That is a job-tracker
 * product, and it is a separate one. The value of this table is narrow and
 * real: don't show me a job I already dealt with, and tell me when I
 * applied. Adding post-application states would make every row a
 * maintenance burden and every stale row a lie.
 */
export const userJobStatusEnum = pgEnum("user_job_status", [
  // Bookmarked. The user wants this one back, no action taken yet.
  "saved",
  // The user has tailored a resume against this specific posting (the
  // workflow `resume-ab.ts` measures), but has not sent it.
  "resume_optimized",
  // Sent. Terminal as far as this app is concerned — see the boundary note
  // above.
  "applied",
  // Explicitly rejected by the user. Kept as a row rather than deleted so
  // a later search doesn't resurface it as if it were new.
  "dismissed",
]);

export const userJobStatuses = pgTable(
  "user_job_statuses",
  {
    id: text("id").primaryKey(),
    /**
     * Ticket 3fc1e5e (epic 2b9e9dd, child 3): WHOSE status this is -- the
     * column the uniqueness comment below had been asking for since ticket
     * dba885e. NOT NULL, added by migration 0017 in the same "nullable,
     * backfill, then NOT NULL" three-step migrations 0013/0016 already
     * used, because no default could be correct (a real user_id must be a
     * real `users` row).
     *
     * The backfill is NOT a blanket LEGACY_USER_ID: where a row has a
     * `resume_id`, that resume's OWN `user_id` is the honest attribution --
     * the person who had that resume in hand is the person who recorded the
     * status -- and only a row with no `resume_id` at all (nullable, see
     * that column's doc comment) has no evidence to go on and falls back to
     * `LEGACY_USER_ID`. Same "use the best available evidence for a
     * one-time backfill" judgement migration 0014 made for `is_estimate`.
     *
     * EVERY JOIN ONTO THIS TABLE MUST NOW CARRY A `user_id` CONJUNCT, and
     * that is a CORRECTNESS requirement, not only a privacy one. While
     * `unique(job_id)` held, `leftJoin(userJobStatuses, eq(jobId, jobs.id))`
     * could match at most one row; under `unique(user_id, job_id)` the same
     * join matches one row PER USER who has touched that job, which
     * MULTIPLIES the rows of whatever it is joined to. routes/resumes.ts
     * (three joins) and scripts/rescore-existing-matches.ts were both fixed
     * accordingly by this ticket.
     */
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    status: userJobStatusEnum("status").notNull(),
    /**
     * WHICH resume was in hand when this status was recorded. An attribute,
     * deliberately NOT part of the uniqueness key (see the constraint
     * below) — worth knowing ("I applied to Samsara with the tailored
     * version, not the generic one"), never worth keying on.
     *
     * Nullable for two honest reasons: a `saved` or `dismissed` row can
     * predate any resume being involved at all, and a backfilled row may
     * record a real application whose resume version is no longer
     * identifiable. A guessed resume_id is worse than a NULL one.
     */
    resumeId: text("resume_id").references(() => resumes.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    /**
     * When the application was actually sent — the one question this table
     * exists to answer beyond "did I". Separate from `created_at`/
     * `updated_at` because those are row bookkeeping: a row can be created
     * as `saved` weeks before it becomes `applied`, and a backfilled row's
     * `created_at` is when the migration ran, not when the user applied.
     * NULL for every status other than `applied`.
     */
    appliedAt: timestamp("applied_at"),
  },
  /**
   * THE KEY IS THE JOB, NOT (RESUME, JOB). This is the entire point of
   * ticket 0c319b2 and the one thing that must not be "simplified" later
   * into mirroring `job_matches`'s `(resume_id, job_id)`.
   *
   * The failing scenario, concretely: the user applies to job X with
   * resume v1. She then starts a fresh resume — v2 is a genuinely different
   * row with a different id. She searches again; X is still open, gets
   * re-ingested and re-scored under v2. If this table were keyed
   * `(resume_id, job_id)`, the lookup "have I applied to X?" made under v2
   * finds nothing — the only row is filed under v1 — and the app cheerfully
   * recommends she apply to a job she already applied to. Worse, a second
   * application would insert a SECOND row for the same job, so the table can
   * no longer answer "did I apply to X" with one row.
   *
   * "I applied to X" is a fact about (person, job). It must survive every
   * resume rewrite, and it does exactly when the resume is not in the key.
   *
   * TICKET 6ba221e NARROWS HOW THAT SCENARIO IS REACHED, AND CHANGES NOTHING
   * ABOUT THIS KEY. The original wording above argued from
   * content-addressing: `resumes` was keyed on `resume_hash` (ticket
   * 620ca30), so ANY text change produced a different row and the v1/v2 split
   * was unavoidable. 6ba221e dropped that constraint (migration 0019) and
   * added `PUT /resumes/:id/text`, so "rewriting my resume" can now ALSO mean
   * an in-place edit that keeps the same `resumes.id` — and that path would
   * not break a `(resume_id, job_id)` key, because the id does not change.
   *
   * The scenario above is still live, just no longer the only way to rewrite:
   * "Paste a new resume" (ticket 88f11d7's picker) and every first submission
   * still create genuinely new rows, and a user with several resumes applying
   * from one and later searching from another hits it without editing
   * anything. So `resume_id` stays OUT of this key, the standing instruction
   * below stands unchanged, and nothing in 6ba221e touched this table.
   * In-place editing in fact makes this key MORE obviously right: it is the
   * one thing that already guarantees "I applied to X" is unaffected by the
   * text under a resume changing beneath it.
   *
   * DONE (ticket 3fc1e5e, epic 2b9e9dd, child 3). The instruction this
   * comment carried from ticket dba885e onward -- "widen this to
   * `unique().on(table.userId, table.jobId)` and add the `user_id` column
   * -- do NOT add `resume_id` to it at that time" -- has been applied
   * exactly as written, and `resume_id` is still deliberately absent from
   * the key for precisely the reason the failing scenario above gives.
   *
   * What the widening fixed, concretely: while the key was `job_id` ALONE,
   * that single row was shared by every user in the database. Two real
   * users are all it takes -- user B clicking "Applied" on a job user A had
   * dismissed did not create a second row, it OVERWROTE A's (routes/
   * job-status.ts upserts on this key), and `DELETE /jobs/:id/status`
   * deleted whichever user's row happened to exist. The key is now (person,
   * job), which is what "I applied to X" was always a fact about.
   */
  (table) => [unique().on(table.userId, table.jobId)],
);

/**
 * Ticket 9f06f8f (epic 2b9e9dd, child 4): one outstanding magic-link
 * verification attempt. This is the table that turns "I am the same browser
 * as before" (`users`, ticket dba885e) into "I am this real person with this
 * real inbox" -- identity.ts's own doc comment names this ticket as the
 * place real signing/expiry/single-use enforcement arrives, and this table
 * is where the expiry and single-use halves live.
 *
 * WHY `token_hash` AND NOT THE TOKEN ITSELF. This is the one deliberate
 * departure from `handoffs`'s "the row's own UUID id IS the token" shortcut
 * right below, and the difference in kind is the reason: a handoff id grants
 * read access to one point-in-time payload for ten minutes, whereas a
 * magic-link token grants LOGIN AS A USER. Storing only
 * `sha256(token)` means anything that can read this table -- a leaked
 * backup, a `pg_dump` in a support ticket, a SQL-injection read, a DBA
 * glancing at rows -- still cannot produce a working link, because sha256
 * is not invertible and the token carries 256 bits of `randomBytes`
 * entropy (no dictionary/brute-force shortcut, unlike a hashed password).
 * The raw token exists in exactly two places, both outside this database:
 * the email that was sent, and the URL the user clicks. A plain-column
 * token would be a credential at rest for no benefit -- lookup is an
 * equality match either way.
 *
 * Deliberately NOT an HMAC/signed token either (the other reading of
 * identity.ts's "REAL signing"): a signature buys the ability to reject a
 * forged token WITHOUT a database round trip, and this route has to do a
 * round trip regardless -- single-use enforcement is a write (`used_at`),
 * and expiry is a column on the row. Signing would add a second secret to
 * manage and rotate for zero additional rejection power over "the hash is
 * not in the table".
 *
 * `email` is the address the user TYPED (normalized -- lowercased and
 * trimmed, see routes/auth.ts's `normalizeEmail`), stored at REQUEST time,
 * so the token can only ever claim the address it was mailed to. It is
 * deliberately not re-read from anywhere at verify time: if it were a
 * parameter of the verify call instead, a token for alice@ could be
 * replayed to claim bob@.
 *
 * `requesting_user_id` is the anonymous `users.id` of the browser that
 * ASKED for the link -- the thing a brand-new email attaches to ("claiming
 * my anonymous session"). FK'd to `users` because `registerIdentity` has
 * already lazily created that row by the time `POST /auth/magic-link` runs.
 *
 * WHICH BRANCH READS IT, AND WHICH DOES NOT -- corrected in review round 4,
 * because the original wording here ("the verify route reads this column
 * rather than the verifying request's own `x-user-id`") stated as an
 * unqualified design goal the exact premise that turned out to be an account-
 * takeover (fable's round-3 review of ticket 9f06f8f reproduced it end to
 * end; see routes/auth.ts's security property 4):
 *
 *  - The ADOPT branch ("logging in from a second device") ignores this column
 *    entirely. It resolves by EMAIL, so the link may be opened anywhere, by
 *    any browser, which is the whole point of that case.
 *  - The ATTACH branch ("claiming my anonymous session") writes the email
 *    onto THIS row, and therefore now REQUIRES that the verifying request's
 *    own `x-user-id` equals this column -- otherwise it refuses
 *    (`different_browser`) without consuming the token. This value is
 *    client-asserted and unauthenticated (anyone may request a link for
 *    anyone's address), so trusting it to name the account a stranger's
 *    verified email lands on is precisely what must not happen.
 *
 * `used_at` NULL means "never redeemed". It is set exactly once, by a
 * conditional `UPDATE ... WHERE used_at IS NULL`, which is what makes
 * replay rejection atomic rather than a read-then-write race -- see
 * routes/auth.ts's `claimToken`.
 */
export const magicLinkTokens = pgTable("magic_link_tokens", {
  // A plain UUID row id, distinct from the token: safe to log, quote in an
  // error, or join on, none of which is true of the token or its hash.
  id: text("id").primaryKey(),
  // sha256(raw token), lowercase hex. `.unique()` is not decoration: it is
  // the index the verify path's only lookup uses, and it makes a hash
  // collision (or a duplicate insert from a retried request) a loud error
  // rather than two rows racing to be claimed.
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  requestingUserId: text("requesting_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Stored as a concrete instant rather than recomputed from `created_at` at
  // read time, for the same reason `handoffs.expires_at` is (see below): the
  // TTL policy can change later without retroactively extending or
  // shortening links already in someone's inbox.
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
});

/**
 * A short-lived, cross-app handoff (ticket dbfd594): "Optimize Resume"
 * links to Nicole's separate resume-tailoring app with a job description
 * + resume text payload. That app runs on a different origin (its own
 * Vercel deployment), so this app can't write into its localStorage or
 * cram both full texts into the URL itself (resume text alone can run to
 * MAX_RESUME_TEXT_LENGTH, 200K chars — far past any browser's safe URL
 * length). Instead: this row IS the payload, addressed by its own `id`
 * (a UUID, already unguessable — no separate token column needed); the
 * link the user clicks carries only `?import=<GET /handoffs/:id URL>`,
 * and the receiving app does a plain `fetch()` on it.
 *
 * `resumeText`/`jobDescription`/`jobTitle`/`company` are SNAPSHOTTED at
 * creation time, not live-joined from `resumes`/`jobs` at read time —
 * deliberately, so the handoff still resolves correctly even if the
 * underlying resume or job row changes (or, in a future where postings
 * get pruned, is deleted) before the short TTL expires. A handoff is a
 * point-in-time payload, not a live view.
 */
export const handoffs = pgTable("handoffs", {
  id: text("id").primaryKey(),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  resumeId: text("resume_id")
    .notNull()
    .references(() => resumes.id),
  resumeText: text("resume_text").notNull(),
  jobDescription: text("job_description").notNull(),
  jobTitle: text("job_title").notNull(),
  company: text("company").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Fixed short TTL from creation (HANDOFF_TTL_MS in routes/handoffs.ts) —
  // stored as a concrete timestamp, not recomputed from createdAt at read
  // time, so the expiry check is a single indexed-free comparison and the
  // TTL policy can change later without invalidating rows already written
  // under the old one.
  expiresAt: timestamp("expires_at").notNull(),
});

/**
 * Ticket 4f88339 (design c54b9e0 §3.1). One (search, source) pair's
 * terminal state, as observed by `fetchSourceWorker`.
 *
 * - `pending`  — a `fetch.source` message is live for this pair (or was
 *                published and has not been consumed yet).
 * - `complete` — the worker finished this source and linked its jobs.
 * - `failed`   — permanently failed: dead-lettered by the worker, or never
 *                dispatched at all (`POST /searches` could not publish).
 *
 * There is deliberately no `retrying` value: a message riding a retry tier
 * is still legitimately outstanding, which `pending` already says. Adding
 * a fourth value would mean the completion derive had to know which of two
 * non-terminal values also counts as non-terminal.
 */
export const searchSourceStatusEnum = pgEnum("search_source_status", [
  "pending",
  "complete",
  "failed",
]);

/**
 * One row per source a search covers — and, since ticket 4f88339, the
 * per-source half of the fan-in ledger that makes "is this search done?"
 * a terminable question (design c54b9e0 §2/§3.1).
 *
 * The count of rows here IS the fetch fan-out width; `status` is what
 * turns that width into a completion signal. Without it, "every linked job
 * has been scored" is VACUOUSLY TRUE the instant `POST /searches` returns
 * (zero `search_results` rows yet), so a brand-new search reads as
 * complete before it has done anything. See routes/searches.ts's
 * `sourcesSettled` conjunct, and the test that asserts that specific bug
 * cannot come back.
 */
export const searchSources = pgTable(
  "search_sources",
  {
    id: text("id").primaryKey(),
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id),
    sourceDescriptorId: text("source_descriptor_id")
      .notNull()
      .references(() => sourceDescriptors.id),
    status: searchSourceStatusEnum("status").notNull().default("pending"),
    /**
     * Jobs this source linked to this search on its last completed attempt
     * (`ingestJobsForSearch`'s `linkedJobIds.length`). NULL until the
     * source reaches a terminal state.
     *
     * SET, never incremented. That is the whole reason this design has no
     * counters: a redelivered `fetch.source` message re-runs the same
     * fetch and overwrites this with the same (or a superset) value, so
     * at-least-once delivery cannot inflate it. An `x += n` here would be
     * wrong on the second delivery of every message.
     */
    linkedJobCount: integer("linked_job_count"),
    /**
     * How much of the SEARCH-WIDE scoring budget this source has claimed —
     * the number of `score.job` messages `fetchSourceWorker` has published
     * for this (search, source) pair (ticket c9c676d).
     *
     * WHY THIS COLUMN EXISTS AT ALL. Ticket 4f88339 could only afford a
     * PER-SOURCE cap (`DEFAULT_SCORE_THRESHOLD` publishes per message), so
     * a search across N sources could authorize `N x 200` scores against a
     * `POST /searches/estimate` that showed a single 200-job total. The two
     * mechanisms that ticket rejected for a true per-search cap were a
     * running counter (not idempotent under at-least-once redelivery) and a
     * live cross-worker query (racy). This column is neither: it is a
     * per-source CLAIM that is SET, never incremented — exactly the same
     * idempotency posture as `linkedJobCount` right above — and the workers
     * read-then-write it under `pg_advisory_xact_lock(hashtext(search_id))`,
     * which is what makes the sum across sources safe to act on. See
     * fetchSourceWorker.ts's "THE PER-SEARCH SCORING CAP" section for the
     * budget arithmetic and the invariant it maintains.
     *
     * NULL means "this source has not adjudicated its share of the budget
     * yet" and is read as 0 by the arithmetic. That is deliberately
     * OPTIMISTIC (a source that has ingested but not yet adjudicated is not
     * pre-reserved anything), and it is safe only because the advisory lock
     * serializes adjudication: whoever gets the lock first takes what is
     * left, and its claim is committed before the next source can read.
     */
    publishedJobCount: integer("published_job_count"),
    /**
     * `classify()`'s `kind` from fetchSourceWorker ("rate-limited",
     * "unknown-source", "source-search-timeout", ...), or
     * "dispatch-failed" when `POST /searches` could not publish the
     * message at all. NULL unless `status = 'failed'`.
     *
     * This is what makes a dead-lettered source PRODUCT-VISIBLE rather
     * than merely logged — CLAUDE.md's "the UI shows that source as
     * unavailable, and the other sources still return". The DLQ keeps the
     * replayable message; this column keeps the queryable fact.
     */
    errorKind: text("error_kind"),
    errorMessage: text("error_message"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  /**
   * REQUIRED, not an optimization (design c54b9e0 §3.1): it is what makes
   * the row addressable by its natural key, so the worker can do an
   * idempotent `UPDATE ... WHERE search_id = $1 AND source_descriptor_id =
   * $2` with no id on the wire, and makes a duplicate row impossible.
   *
   * Safe to add: `POST /searches`' body schema already enforces
   * `uniqueItems` on `sourceIds` (routes/searches.ts), and `runDemoMatch`
   * inserts one row per distinct adapter (matching/pipeline.ts).
   */
  (table) => [unique().on(table.searchId, table.sourceDescriptorId)],
);

/**
 * "We permanently gave up scoring this (resume, job) pair" — the durable
 * twin of a `score.job.dlq` entry (ticket 4f88339, design c54b9e0 §3.2).
 *
 * WHY THIS TABLE HAS TO EXIST AT ALL: dead-lettering leaves no relational
 * trace. A `score.job` message that exhausts its retries exists only as a
 * message in `score.job.dlq`, whose body is `{jobId}` — no searchId, no
 * resumeId — and reading a queue to find out is destructive. So the
 * otherwise-free completion predicate ("every job this search linked has a
 * `job_matches` row for the search's resume, and no `job_match_failures`
 * row of its own") is correct for success and
 * NON-TERMINATING for failure: a DLQ'd job never gets that row, and the
 * predicate stays false forever. That is the "waiting forever on a DLQ'd
 * job" hang this whole design exists to prevent.
 *
 * WHY A SEPARATE TABLE AND NOT A NULLABLE `status` ON `job_matches` —
 * three reasons, the third blocking:
 *
 *   1. `job_matches.match_score` and `.rationale` are NOT NULL. A failure
 *      row forces both nullable, weakening the constraint for every real
 *      row.
 *   2. `job_matches` is documented above as a derived cache of real
 *      ANSWERS — "delete the whole table and a rerun reproduces it". A
 *      failure is not an answer.
 *   3. It would silently poison two existing read paths.
 *      `matching/pipeline.ts`'s `alreadyScoredIds` and
 *      `scoreJobWorker.ts`'s already-scored check both treat ANY
 *      `job_matches` row for `(resumeId, jobId)` as "already scored". A
 *      failure row living there would make both conclude "already scored"
 *      and NEVER RETRY THE JOB AGAIN, EVER — converting a transient
 *      outage into permanent data loss.
 *
 * Kept out of `job_matches`, this table is ADVISORY FOR COMPLETION ONLY:
 * it never gates scoring, so a manual republish of a DLQ'd message
 * re-scores normally, and the retry policy is simply "delete the failure
 * rows and republish".
 *
 * SCOPED TO ONE SEARCH, NOT TO A (resume, job) PAIR (ticket 9a53485,
 * migration 0013). This is the deliberate decision that ticket asked for,
 * and the alternative — keeping the row resume-wide as a "we already tried
 * and gave up on this job" cache — was considered and REJECTED. The
 * reasoning, in the order it matters:
 *
 *   1. THE ROW IS A STATEMENT ABOUT AN ATTEMPT, NOT ABOUT A PAIR. Every
 *      `kind` this table stores is an accident of one moment: "the API key
 *      was expired", "the retries ran out", "this search's budget was
 *      already spent when this job was adjudicated". None of those is a
 *      durable property of the (resume, job) pair — rotate the key, wait
 *      out the outage, or run a narrower search whose budget has room, and
 *      the same pair scores fine. A cache keyed on the pair would be
 *      caching the weather.
 *   2. IT LATCHED LATER SEARCHES TERMINAL ON AN OLDER SEARCH'S VERDICT.
 *      `deriveSearchState` (routes/searches.ts) counts a linked job as
 *      OUTSTANDING only while it has neither a `job_matches` nor a
 *      `job_match_failures` row. Keyed by (resume, job), a row written by
 *      search A made the same job non-outstanding in search B — even
 *      though B had just published its own fresh `score.job` for it — so B
 *      could latch complete/degraded before its own scoring attempt
 *      resolved, reporting a `cappedForBudget`/`permanentlyFailed` it never
 *      incurred. Reproduced directly in opus's review of ticket c9c676d
 *      ({scored: 0, cappedForBudget: 3, linked: 3} on a search that had
 *      capped nothing); pinned by the regression test in
 *      routes/searches.test.ts.
 *   3. THE BLAST RADIUS WAS GROWING, NOT SHRINKING. c9c676d's per-SEARCH
 *      scoring cap writes strictly more `SCORE_THRESHOLD_CAPPED_KIND` rows
 *      than the per-SOURCE cap it replaced (every search that binds the cap
 *      now, not just some), so every one of those rows was a fresh mine
 *      under the next search for the same resume.
 *   4. SCORE REUSE ALREADY LIVES SOMEWHERE ELSE, AND IS UNAFFECTED. The
 *      thing that legitimately spans searches is a SUCCESS: `job_matches`
 *      is still keyed by (resume, job), so a second search over an
 *      already-scored job reuses the score and never pays for it twice.
 *      Only the give-up rows are per-search. Cost is bounded by the cap,
 *      which is itself per-search.
 *
 * The cost of the decision, stated plainly: a job that genuinely cannot be
 * scored (a description the model refuses, say) is re-attempted once per
 * search rather than once ever. That is the intended behaviour — "a later
 * search gets a genuine fresh attempt" — and it is bounded by
 * `DEFAULT_SCORE_THRESHOLD` per search, not unbounded.
 */
export const jobMatchFailures = pgTable(
  "job_match_failures",
  {
    id: text("id").primaryKey(),
    /**
     * The search whose attempt this row records (ticket 9a53485). NOT NULL
     * and FK'd: a row that names no search is exactly the resume-wide row
     * this column exists to abolish, and the completion derive would have
     * no way to tell whether it applies to the search it is deriving.
     *
     * Every writer has one to hand: `fetchSourceWorker` is handling a
     * `fetch.source` message that names it, and `scoreJobWorker` — whose
     * message body is only `{jobId}` — resolves it the same relational way
     * it already resolves the resumeId, through `search_results`. See
     * `resolveSearchLinks` there.
     */
    searchId: text("search_id")
      .notNull()
      .references(() => searches.id),
    /**
     * Denormalized: functionally determined by `search_id` via
     * `searches.resume_id`. Kept anyway, because the completion derive
     * joins this table on the search's resume and `job_matches` on the same
     * resume, so the two LEFT JOINs stay symmetric and index-served without
     * a second hop through `searches`.
     */
    resumeId: text("resume_id")
      .notNull()
      .references(() => resumes.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    /** `classifyScoringError()`'s `kind` (scoreJobWorker.ts) —
     * "auth-failed", "not-found", "missing-resume", "rate-limited"
     * (retries exhausted), "spend-guard-exceeded", ... */
    kind: text("kind").notNull(),
    errorMessage: text("error_message").notNull(),
    /** The `x-attempt` value the message died on. Diagnostic only —
     * nothing branches on it. */
    attempts: integer("attempts").notNull(),
    failedAt: timestamp("failed_at").notNull().defaultNow(),
  },
  // WAS (resume_id, job_id); now (search_id, resume_id, job_id) — ticket
  // 9a53485, migration 0013. Still what makes the completion derive a plain
  // LEFT JOIN and both workers' inserts idempotent `ON CONFLICT DO NOTHING`;
  // the conflict target is now exactly the tuple the derive joins on, so a
  // redelivery for one search can no longer no-op away another search's row.
  //
  // `resume_id` is redundant in the key (search_id determines it) and is
  // kept in it anyway so the ON CONFLICT target and the join predicate are
  // the same three columns — the index leads on `search_id`, which is
  // constant for the search being derived, so the lookup is strictly better
  // served than the old (resume_id, job_id) one it replaces.
  (table) => [unique().on(table.searchId, table.resumeId, table.jobId)],
);
