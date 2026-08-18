import { pgTable, text } from "drizzle-orm/pg-core";
import { timestamp } from "drizzle-orm/pg-core";
import { pgEnum } from "drizzle-orm/pg-core";
import { integer } from "drizzle-orm/pg-core";
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
    locationType: locationTypeEnum("location_type").notNull(),
    location: text("location"),
    linkToApply: text("link_to_apply").notNull(),
    postedAt: timestamp("posted_at").notNull(),
  },
  (table) => [unique().on(table.dataSource, table.externalId)],
);

export const resumes = pgTable("resumes", {
  id: text("id").primaryKey(),
  resumeText: text("resume_text").notNull(),
});

export const jobMatches = pgTable("job_matches", {
  id: text("id").primaryKey(),
  resumeId: text("resume_id")
    .notNull()
    .references(() => resumes.id),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id),
  matchScore: integer("match_score").notNull(),
  rationale: text("rationale").notNull(),
});

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
