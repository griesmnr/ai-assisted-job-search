ALTER TABLE "job_matches" ADD COLUMN "strengths" jsonb;--> statement-breakpoint
ALTER TABLE "job_matches" ADD COLUMN "gaps" jsonb;--> statement-breakpoint
ALTER TABLE "resumes" ADD COLUMN "resume_hash" text;--> statement-breakpoint
UPDATE "resumes" SET "resume_hash" = encode(sha256("resume_text"::bytea), 'hex') WHERE "resume_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "resumes" ALTER COLUMN "resume_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_resume_id_job_id_unique" UNIQUE("resume_id","job_id");--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_resume_hash_unique" UNIQUE("resume_hash");