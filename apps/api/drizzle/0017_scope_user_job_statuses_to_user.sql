-- Ticket 3fc1e5e (epic 2b9e9dd, child 3): `user_job_statuses` becomes
-- per-user. schema.ts's own doc comment on this table has carried the
-- instruction for this migration since ticket dba885e -- "widen this to
-- `unique().on(table.userId, table.jobId)` and add the `user_id` column --
-- do NOT add `resume_id` to it at that time" -- and this applies it
-- verbatim. `resume_id` stays OUT of the key; see that comment's own
-- failing scenario (apply with resume v1, rewrite the resume, re-search,
-- and a (resume, job) key answers "have I applied to X?" wrongly).
--
-- WHY THE OLD KEY HAD TO GO. `unique("job_id")` meant ONE row per job for
-- the WHOLE database. Two real users is all it took: user B clicking
-- "Applied" on a job user A had dismissed did not create a second row, it
-- overwrote A's (routes/job-status.ts upserts on this key), and
-- `DELETE /jobs/:id/status` deleted whichever user's row happened to exist.
ALTER TABLE "user_job_statuses" DROP CONSTRAINT "user_job_statuses_job_id_unique";--> statement-breakpoint
-- HAND-EDITED (ticket 3fc1e5e). drizzle-kit generated a single
-- `ADD COLUMN "user_id" text NOT NULL`, which cannot run against a table
-- that already has rows: there is no default, and no default could be
-- correct (a real user_id must be a real row in `users`). The column is
-- added NULLable here, backfilled below, and only then made NOT NULL --
-- the same "nullable, backfill, then NOT NULL" shape migrations 0010, 0013
-- and 0016 all already used for an identical reason.
ALTER TABLE "user_job_statuses" ADD COLUMN "user_id" text;--> statement-breakpoint
-- The legacy user row must exist before the FK below can accept it.
-- Migration 0016 already inserts this same well-known id (schema.ts's
-- `LEGACY_USER_ID`, the nil UUID reserved for data predating real per-user
-- identity), so this is belt-and-braces: it keeps THIS migration
-- self-contained rather than silently depending on an earlier one's side
-- effect, and `ON CONFLICT DO NOTHING` makes it a no-op in the normal case
-- where 0016 already ran.
INSERT INTO "users" ("id") VALUES ('00000000-0000-0000-0000-000000000000')
  ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- THE BACKFILL, AND WHY IT IS NOT A BLANKET LEGACY_USER_ID.
--
-- A status row records something a PERSON did, so guessing its owner when
-- real evidence exists would be inventing an attribution this migration can
-- actually look up. `user_job_statuses.resume_id` is exactly that evidence:
-- it is "WHICH resume was in hand when this status was recorded" (schema.ts),
-- and since migration 0016 every resume carries its owner's `user_id`. The
-- person holding that resume is the person who recorded the status, so that
-- resume's owner IS this row's owner.
--
-- Only a row with NO `resume_id` at all (the column is nullable -- a `saved`
-- or `dismissed` row can predate any resume being involved, per its own doc
-- comment) has nothing to go on, and those fall back to LEGACY_USER_ID. Same
-- "use the best available evidence for a ONE-TIME backfill" judgement
-- migration 0014 made for `is_estimate`, and the same reason: for a
-- pre-existing row the column default is not a fail-safe, it is a guess.
--
-- This backfill CANNOT violate the new `unique(user_id, job_id)` key added
-- at the end of this migration: the constraint being dropped above made
-- `job_id` unique across the entire table, so every row already has a
-- distinct `job_id` and therefore a distinct (user_id, job_id) pair no
-- matter which user_id each row receives here.
UPDATE "user_job_statuses" AS "ujs"
SET "user_id" = COALESCE(
	(SELECT "r"."user_id" FROM "resumes" "r" WHERE "r"."id" = "ujs"."resume_id"),
	'00000000-0000-0000-0000-000000000000'
)
WHERE "ujs"."user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "user_job_statuses" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_job_statuses" ADD CONSTRAINT "user_job_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_job_statuses" ADD CONSTRAINT "user_job_statuses_user_id_job_id_unique" UNIQUE("user_id","job_id");
