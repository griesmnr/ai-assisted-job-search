import { pgTable, text } from "drizzle-orm/pg-core";
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

export const resumes = pgTable("resumes", {
  id: text("id").primaryKey(),
  resumeText: text("resume_text").notNull(),
  // Content hash (sha256 hex) of resumeText, used as the find-or-create key
  // in demo-match.ts's getOrCreateResumeId. NOT `unique()` on resumeText
  // itself: a real resume's text can exceed Postgres's ~2704-byte btree
  // index row limit, which would fail at insert time for a long resume.
  // Hashing first keeps the unique key small and fixed-size regardless of
  // resume length, while still making "two identical resumes" resolve to
  // one row under concurrent inserts (ON CONFLICT (resume_hash) DO
  // NOTHING). See ticket 620ca30.
  resumeHash: text("resume_hash").notNull().unique(),
});

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
   * resume v1. She then rewrites her resume — `resumes` is content-
   * addressed by `resume_hash` (ticket 620ca30), so v2 is a genuinely
   * different row with a different id, not an edit of v1. She searches
   * again; X is still open, gets re-ingested and re-scored under v2. If
   * this table were keyed `(resume_id, job_id)`, the lookup "have I applied
   * to X?" made under v2 finds nothing — the only row is filed under v1 —
   * and the app cheerfully recommends she apply to a job she already
   * applied to. Worse, a second application would insert a SECOND row for
   * the same job, so the table can no longer answer "did I apply to X"
   * with one row.
   *
   * "I applied to X" is a fact about (person, job). It must survive every
   * resume rewrite, and it does exactly when the resume is not in the key.
   *
   * There is no `users` table yet (single-user app today), so `job_id`
   * alone IS the effective (user, job) key. WHEN A `users` TABLE LANDS:
   * widen this to `unique().on(table.userId, table.jobId)` and add the
   * `user_id` column — do NOT add `resume_id` to it at that time.
   */
  (table) => [unique().on(table.jobId)],
);

export const searchSources = pgTable("search_sources", {
  id: text("id").primaryKey(),
  searchId: text("search_id")
    .notNull()
    .references(() => searches.id),
  sourceDescriptorId: text("source_descriptor_id")
    .notNull()
    .references(() => sourceDescriptors.id),
});
