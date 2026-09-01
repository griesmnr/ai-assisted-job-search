CREATE TYPE "public"."search_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "status" "search_status" DEFAULT 'running' NOT NULL;--> statement-breakpoint
-- Ticket 59fdc52 review round 3, N1: every row that exists at the moment
-- this migration runs predates the `status` column entirely — the column
-- didn't exist yet, so by definition every one of these rows is a
-- historical run from before this ticket (a CLI `demo-match.ts` invocation,
-- or an earlier version of this API). All of them genuinely finished
-- (that's the only way a `searches` row gets created at all — see
-- runDemoMatch), so backfilling them to 'running' via the column default
-- above and leaving them there is wrong, not merely imprecise: the owner's
-- real search that produced her actual `job_matches` (a live, populated
-- database, not a fresh one) would read as permanently unfinished via
-- GET /searches/:id's DB-fallback branch. From this point forward, ONLY
-- the application (runDemoMatch / POST /searches's catch handler) writes
-- 'running' or 'failed' for a NEW row — this UPDATE only touches rows that
-- already existed before this migration ran.
UPDATE "searches" SET "status" = 'complete' WHERE "status" = 'running';
