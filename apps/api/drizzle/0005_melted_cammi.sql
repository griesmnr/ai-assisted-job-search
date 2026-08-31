CREATE TYPE "public"."search_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "status" "search_status" DEFAULT 'running' NOT NULL;