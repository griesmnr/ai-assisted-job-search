ALTER TABLE "job_matches" ADD COLUMN "strengths" jsonb;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "gaps" jsonb;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "resume_hash" text;--> statement-breakpoint
UPDATE "resumes" SET "resume_hash" = encode(sha256(convert_to("resume_text", 'UTF8')), 'hex') WHERE "resume_hash" IS NULL;--> statement-breakpoint
-- Duplicate resumes (same resume_text, different rows -- nothing prevented
-- that before resume_hash existed, which is the entire reason this
-- migration adds it) get merged onto one canonical row (MIN(id) per
-- resume_hash) below, ahead of the UNIQUE constraints this migration adds.
-- Where two duplicate resumes were BOTH already scored against the same
-- job, only one (resume_id, job_id) row can survive the job_matches
-- uniqueness constraint added further down -- this DELETE keeps exactly
-- one per (canonical resume, job) group (lowest job_matches.id wins,
-- preferring a row that was already on the canonical resume) and discards
-- the other's match_score/rationale. That loss is deliberate, not
-- accidental: it's the same resume text scored against the same job, so
-- the discarded score is redundant, not new information -- and
-- strengths/gaps are NULL on every pre-existing row regardless, since this
-- migration is what adds those columns. Nothing logs or archives the
-- discarded row; if that ever needs to be recoverable, capture it before
-- running this migration, not after.
DELETE FROM "job_matches" AS "jm"
USING (
  SELECT "m"."id",
         row_number() OVER (
           PARTITION BY "canon"."canonical_id", "m"."job_id"
           ORDER BY ("dup"."id" <> "canon"."canonical_id"), "m"."id"
         ) AS "rn"
  FROM "job_matches" AS "m"
  JOIN "resumes" AS "dup" ON "dup"."id" = "m"."resume_id"
  JOIN (
    SELECT "resume_hash", MIN("id") AS "canonical_id"
    FROM "resumes" GROUP BY "resume_hash"
  ) AS "canon" ON "canon"."resume_hash" = "dup"."resume_hash"
) AS "ranked"
WHERE "jm"."id" = "ranked"."id" AND "ranked"."rn" > 1;--> statement-breakpoint
UPDATE "job_matches" AS "jm"
SET "resume_id" = "canon"."canonical_id"
FROM "resumes" AS "dup"
JOIN (
  SELECT "resume_hash", MIN("id") AS "canonical_id"
  FROM "resumes"
  GROUP BY "resume_hash"
) AS "canon" ON "canon"."resume_hash" = "dup"."resume_hash"
WHERE "jm"."resume_id" = "dup"."id"
  AND "dup"."id" <> "canon"."canonical_id";--> statement-breakpoint
UPDATE "searches" AS "s"
SET "resume_id" = "canon"."canonical_id"
FROM "resumes" AS "dup"
JOIN (
  SELECT "resume_hash", MIN("id") AS "canonical_id"
  FROM "resumes"
  GROUP BY "resume_hash"
) AS "canon" ON "canon"."resume_hash" = "dup"."resume_hash"
WHERE "s"."resume_id" = "dup"."id"
  AND "dup"."id" <> "canon"."canonical_id";--> statement-breakpoint
DELETE FROM "resumes" AS "dup"
USING (
  SELECT "resume_hash", MIN("id") AS "canonical_id"
  FROM "resumes"
  GROUP BY "resume_hash"
) AS "canon"
WHERE "dup"."resume_hash" = "canon"."resume_hash"
  AND "dup"."id" <> "canon"."canonical_id";--> statement-breakpoint
ALTER TABLE "resumes" ALTER COLUMN "resume_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_resume_id_job_id_unique" UNIQUE("resume_id","job_id");--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_resume_hash_unique" UNIQUE("resume_hash");
