ALTER TABLE "searches" ADD COLUMN "is_estimate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- HAND-EDITED BACKFILL (ticket 88f11d7 review round 2, N2). Every row that
-- existed before this migration reads `is_estimate = false` (the column's
-- own default) unless corrected here -- and for a concrete case review
-- surfaced by checking an actual sandbox database at review time (8
-- pre-existing `searches` rows across 5 resumes, 3 of those 5 with zero
-- `job_matches`), leaving the blanket default stand would permanently lock
-- resumes that were never actually real-searched under this ticket's own
-- definition, only ever estimated -- with no unlock path, by design.
--
-- The best available signal for a HISTORICAL row (the `is_estimate` column
-- did not exist when these were written, so nothing recorded the writer's
-- own intent) is the same one schema.ts's `isEstimate` doc comment
-- explicitly rejects for ONGOING inference -- `job_matches`/
-- `job_match_failures` existing. That rejection is about a live mechanism
-- with a standing gap (a real search that scores literally nothing would
-- misclassify); for a ONE-TIME backfill there is no ongoing gap to worry
-- about, only the best -- and only -- evidence this data will ever carry.
-- `job_matches` has no `search_id` (ticket 620ca30's resume-content-
-- addressed design only keys it by (resume_id, job_id)), so this joins
-- through `search_results` (search_id, job_id) to ask "did any job THIS
-- search linked end up scored for this resume" -- exactly the "ran and
-- produced persisted results" shape a genuinely real historical run (the
-- CLI tool, or an old pre-4f88339 direct run) actually has. `job_match_
-- failures` DOES carry `search_id` directly (ticket 9a53485) and is
-- checked the same way, so a real run that scored nothing but genuinely
-- tried and failed is not mistaken for an estimate either.
--
-- A row with neither trace is reclassified `true` (estimate, unlocks its
-- resume) -- the direction that matches product intent (locking should
-- only ever follow a REAL search) and never reclassifies a row that DOES
-- show real scoring evidence.
UPDATE "searches" "s"
SET "is_estimate" = true
WHERE NOT EXISTS (
	SELECT 1 FROM "search_results" "sr"
	JOIN "job_matches" "jm" ON "jm"."job_id" = "sr"."job_id" AND "jm"."resume_id" = "s"."resume_id"
	WHERE "sr"."search_id" = "s"."id"
)
AND NOT EXISTS (
	SELECT 1 FROM "job_match_failures" "jmf" WHERE "jmf"."search_id" = "s"."id"
);