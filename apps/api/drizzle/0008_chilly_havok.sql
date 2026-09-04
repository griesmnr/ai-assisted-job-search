CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"resume_id" text NOT NULL,
	"resume_text" text NOT NULL,
	"job_description" text NOT NULL,
	"job_title" text NOT NULL,
	"company" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_resume_id_resumes_id_fk" FOREIGN KEY ("resume_id") REFERENCES "public"."resumes"("id") ON DELETE no action ON UPDATE no action;