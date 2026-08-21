ALTER TABLE "job_matches" ADD COLUMN "strengths" jsonb;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "gaps" jsonb;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "resume_hash" text;--> statement-breakpoint
UPDATE "resumes" SET "resume_hash" = encode(sha256(convert_to("resume_text", 'UTF8')), 'hex') WHERE "resume_hash" IS NULL;--> statement-breakpoint
DELETE FROM "job_matches" AS "jm"
USING "resumes" AS "dup"
JOIN (
  SELECT "resume_hash", MIN("id") AS "canonical_id"
  FROM "resumes"
  GROUP BY "resume_hash"
) AS "canon" ON "canon"."resume_hash" = "dup"."resume_hash"
WHERE "jm"."resume_id" = "dup"."id"
  AND "dup"."id" <> "canon"."canonical_id"
  AND EXISTS (
    SELECT 1 FROM "job_matches" AS "jm2"
    WHERE "jm2"."resume_id" = "canon"."canonical_id" AND "jm2"."job_id" = "jm"."job_id"
  );--> statement-breakpoint
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
