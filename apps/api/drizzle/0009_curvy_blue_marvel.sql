CREATE TYPE "public"."level_fit" AS ENUM('underqualified', 'well_matched', 'overqualified');--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "level_fit" "level_fit";--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "level_fit_note" text;