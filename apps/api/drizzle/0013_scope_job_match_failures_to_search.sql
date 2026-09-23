ALTER TABLE "job_match_failures" DROP CONSTRAINT "job_match_failures_resume_id_job_id_unique";--> statement-breakpoint
-- HAND-EDITED (ticket 9a53485). drizzle-kit generated a single
-- `ADD COLUMN "search_id" text NOT NULL`, which cannot run against a table
-- that already has rows: there is no default, and no default could be
-- correct. The column is added NULLable here, backfilled by the
-- hand-written statement below, and only then made NOT NULL.
ALTER TABLE "job_match_failures" ADD COLUMN "search_id" text;--> statement-breakpoint
-- THE BACKFILL, AND WHY IT EXPANDS ROWS RATHER THAN PICKING ONE SEARCH.
--
-- Before this migration a row meant "(resume, job) is given up on, for
-- every search, forever" — the defect ticket 9a53485 exists to fix. The
-- honest translation of that statement into the new, search-scoped shape is
-- therefore one row per search that had already linked the job for that
-- resume, because those are exactly the searches the old row was speaking
-- for. Picking a single arbitrary search instead (the first, the newest)
-- would silently REVIVE the job as `outstanding` in every other search that
-- linked it — including a still-pending one, which would then hang waiting
-- on a `score.job` that was dead-lettered long ago. This migration must not
-- change what any existing search reports; it only changes what FUTURE
-- searches inherit, which is nothing.
--
-- `DELETE ... RETURNING` in a CTE feeding the INSERT is what makes this one
-- atomic statement rather than an insert-then-delete pair with a window in
-- which both shapes exist. The CTE reads the pre-statement snapshot, so the
-- rows it re-inserts are never re-read by its own DELETE.
--
-- `search_results` is unique on (search_id, job_id) and the old constraint
-- made the source rows unique on (resume_id, job_id), so the product below
-- is unique on (search_id, resume_id, job_id) — the key added at the end of
-- this migration cannot be violated by its own backfill.
--
-- A legacy row whose (resume, job) pair has NO `search_results` link at all
-- is dropped rather than carried: nothing can join to it, no search reads
-- it, and it has no search to be scoped to. Not reachable through either
-- writer (both only ever record a job some search has linked); handled
-- because a NOT NULL column cannot be added over a row the backfill skipped.
WITH "legacy" AS (
	DELETE FROM "job_match_failures" WHERE "search_id" IS NULL
	RETURNING "resume_id", "job_id", "kind", "error_message", "attempts", "failed_at"
)
INSERT INTO "job_match_failures"
	("id", "search_id", "resume_id", "job_id", "kind", "error_message", "attempts", "failed_at")
SELECT gen_random_uuid()::text, "s"."id", "l"."resume_id", "l"."job_id",
       "l"."kind", "l"."error_message", "l"."attempts", "l"."failed_at"
FROM "legacy" "l"
JOIN "searches" "s" ON "s"."resume_id" = "l"."resume_id"
JOIN "search_results" "sr" ON "sr"."search_id" = "s"."id" AND "sr"."job_id" = "l"."job_id";--> statement-breakpoint
ALTER TABLE "job_match_failures" ALTER COLUMN "search_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_match_failures" ADD CONSTRAINT "job_match_failures_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_match_failures" ADD CONSTRAINT "job_match_failures_search_id_resume_id_job_id_unique" UNIQUE("search_id","resume_id","job_id");
