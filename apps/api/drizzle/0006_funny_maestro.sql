CREATE TYPE "public"."user_job_status" AS ENUM('saved', 'resume_optimized', 'applied', 'dismissed');--> statement-breakpoint
CREATE TABLE "user_job_statuses" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"status" "user_job_status" NOT NULL,
	"resume_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"applied_at" timestamp,
	CONSTRAINT "user_job_statuses_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "user_job_statuses" ADD CONSTRAINT "user_job_statuses_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_job_statuses" ADD CONSTRAINT "user_job_statuses_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ---------------------------------------------------------------------
-- Backfill of applications already sent before this table existed
-- (ticket 0c319b2).
--
-- WHAT IS GROUNDED AND WHAT IS NOT. `jobs.id` is a `randomUUID()` minted
-- at ingest time (see ingest/ingestJobs.ts) — it is not derivable, not
-- stable across databases, and not knowable from a migration file. So
-- this does NOT hardcode a job id. It resolves the row by the only
-- durable, source-of-truth identity a posting has in this schema,
-- `UNIQUE(data_source, external_id)`, and inserts nothing at all if that
-- posting was never ingested into the database this migration is running
-- against. That is the intended behavior on a fresh or partial database:
-- an application record pointing at a fabricated job id would be worse
-- than no record.
--
-- 1. SAMSARA — "Software Engineer II", applied 2026-08-19. Grounded: the
--    Greenhouse posting id is recorded in the repo at
--    apps/api/src/resume-ab.ts (`const DEFAULT_JOB = "8036387"; //
--    Samsara, Software Engineer II, Remote - US`) — the posting the
--    resume A/B was run against, which is what a tailored resume was
--    produced for. `data_source = 'greenhouse'` because that is the
--    adapter resume-ab.ts fetches it through (GreenhouseSource, board
--    token "samsara").
--
-- 2. SMARTSHEET — "Software Engineer II - Full Stack", applied
--    2026-08-20: NOT BACKFILLED, DELIBERATELY. Nothing in this repo
--    records a posting id, a tailored resume, or an A/B run for it. The
--    only trace of Smartsheet anywhere in the codebase is the board token
--    "smartsheet" in the configured board lists (model-ab.ts,
--    resume-ab.ts) — i.e. evidence that the board is SEARCHED, not
--    evidence that anything was SENT to it. Since there is no external_id
--    to resolve against, an INSERT here could only be written by inventing
--    one, which would put a fabricated application into the one table in
--    this schema whose entire purpose is holding facts that cannot be
--    recomputed. Left out on purpose. If the application was in fact sent,
--    record it through the app (or a one-off INSERT following the exact
--    shape below) once the real posting id is known — the table shape
--    supports it, only the evidence is missing.
--
-- `applied_at` is midnight of the stated date: the date is the precision
-- that is actually confirmable, and no time of day was ever recorded.
-- `resume_id` is NULL — which resume version was sent is not recoverable
-- from anything in the repo, and a guess here is exactly what this
-- column's schema comment says not to write.
INSERT INTO "user_job_statuses" ("id", "job_id", "status", "resume_id", "applied_at")
SELECT gen_random_uuid()::text, "j"."id", 'applied', NULL, TIMESTAMP '2026-08-19 00:00:00'
FROM "jobs" AS "j"
WHERE "j"."data_source" = 'greenhouse' AND "j"."external_id" = '8036387'
ON CONFLICT ("job_id") DO NOTHING;