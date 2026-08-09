CREATE TYPE "public"."commitment" AS ENUM('full-time', 'part-time', 'contract');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('remote', 'onsite', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."pay_type" AS ENUM('hourly', 'salary');--> statement-breakpoint
CREATE TABLE "job_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"resume_id" text NOT NULL,
	"job_id" text NOT NULL,
	"match_score" integer NOT NULL,
	"rationale" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"data_source" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"company" text NOT NULL,
	"pay_type" "pay_type" NOT NULL,
	"commitment" "commitment" NOT NULL,
	"location_type" "location_type" NOT NULL,
	"location" text,
	"link_to_apply" text NOT NULL,
	"posted_at" timestamp NOT NULL,
	CONSTRAINT "jobs_data_source_external_id_unique" UNIQUE("data_source","external_id")
);
--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" text PRIMARY KEY NOT NULL,
	"resume_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_results" (
	"id" text PRIMARY KEY NOT NULL,
	"search_id" text NOT NULL,
	"job_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"search_id" text NOT NULL,
	"source_descriptor_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" text PRIMARY KEY NOT NULL,
	"resume_id" text NOT NULL,
	"searched_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_descriptors" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_data_source_source_descriptors_id_fk" FOREIGN KEY ("data_source") REFERENCES "public"."source_descriptors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_sources" ADD CONSTRAINT "search_sources_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_sources" ADD CONSTRAINT "search_sources_source_descriptor_id_source_descriptors_id_fk" FOREIGN KEY ("source_descriptor_id") REFERENCES "public"."source_descriptors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;