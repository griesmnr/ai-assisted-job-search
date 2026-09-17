ALTER TABLE "resumes" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- Ticket 38a7598: added nullable first, backfilled below, THEN made
-- NOT NULL -- a plain "ADD COLUMN ... NOT NULL" with no default would
-- reject outright against any pre-existing row (there is no single
-- constant value that is a real, distinct nickname for every row at
-- once). See db/schema.ts's doc comment on this column for why every row
-- from this migration forward never sees a blank nickname regardless
-- (getOrCreateResumeId assigns one at insert time; this backfill only
-- has to cover rows that predate this migration).
ALTER TABLE "resumes" ADD COLUMN "resume_nickname" text;--> statement-breakpoint
-- Every PRE-EXISTING row gets a real, distinct default ("Resume 1",
-- "Resume 2", ...), numbered in creation order (`created_at`, tiebroken
-- by `id` since every existing row was just backfilled to the SAME
-- `created_at` instant by the ALTER above -- see that column's own doc
-- comment in schema.ts). A resume created AFTER this migration runs
-- never reaches this UPDATE at all: `getOrCreateResumeId` (demo-match.ts)
-- always inserts a real nickname of its own, so this is a one-time catch
-- -up for rows that predate the column existing, not an ongoing
-- numbering scheme.
UPDATE "resumes" AS "r"
SET "resume_nickname" = 'Resume ' || "numbered"."rn"
FROM (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "created_at" ASC, "id" ASC) AS "rn"
  FROM "resumes"
) AS "numbered"
WHERE "r"."id" = "numbered"."id";--> statement-breakpoint
ALTER TABLE "resumes" ALTER COLUMN "resume_nickname" SET NOT NULL;