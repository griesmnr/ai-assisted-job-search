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

export const searches = pgTable("searches", {
  id: text("id").primaryKey(),
  resumeId: text("resume_id")
    .notNull()
    .references(() => resumes.id),
  searchedAt: timestamp("searched_at").notNull(),
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

export const searchSources = pgTable("search_sources", {
  id: text("id").primaryKey(),
  searchId: text("search_id")
    .notNull()
    .references(() => searches.id),
  sourceDescriptorId: text("source_descriptor_id")
    .notNull()
    .references(() => sourceDescriptors.id),
});
