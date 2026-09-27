ALTER TABLE "resumes" DROP CONSTRAINT "resumes_resume_hash_unique";--> statement-breakpoint
-- HAND-EDITED (ticket b2f9dfd). drizzle-kit generated a single
-- `ADD COLUMN "user_id" text NOT NULL`, which cannot run against a table
-- that already has rows: there is no default, and no default could be
-- correct (a real user_id must be a real row in `users`). The column is
-- added NULLable here, backfilled to LEGACY_USER_ID (schema.ts's own
-- constant -- the well-known nil UUID reserved for data that predates
-- real per-user identity), and only then made NOT NULL -- the same
-- "nullable, backfill, then NOT NULL" shape migrations 0010 and 0013 both
-- already used for an identical reason.
ALTER TABLE "resumes" ADD COLUMN "user_id" text;--> statement-breakpoint
-- The legacy user row itself must exist before any resume can reference
-- it via the FK constraint added below. ON CONFLICT DO NOTHING: safe to
-- re-run, and idempotent if a future migration (or ticket 9f06f8f's
-- magic-link flow) ever independently inserts this same well-known id.
INSERT INTO "users" ("id") VALUES ('00000000-0000-0000-0000-000000000000')
  ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "resumes" SET "user_id" = '00000000-0000-0000-0000-000000000000'
  WHERE "user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "resumes" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_user_id_resume_hash_unique" UNIQUE("user_id","resume_hash");
