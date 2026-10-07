import { createHash, randomUUID } from "node:crypto";
import type {
  CreateResumeResponse,
  GetResumeResponse,
  GetResumeResultsResponse,
  UpdateResumeNicknameResponse,
  UpdateResumeTextResponse,
} from "@app/shared";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestApp as buildApp,
  DEFAULT_TEST_USER_ID,
  injectAs,
} from "../test-support/build-test-app.js";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  searches,
  sourceDescriptors,
  userJobStatuses,
} from "../db/schema.js";
import { createPooledTestDatabase, createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";

// Node 22 can read .env itself — no dotenv dependency needed.
loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see db/test-db.ts. This
// file used to connect straight to the shared dev Postgres.
let testDb: TestDatabase;
let db: NodePgDatabase;

// A real, canonical dataSource id (see db/seed.ts's SOURCE_DESCRIPTORS) —
// NOT a made-up test-only id. Ticket 59fdc52 review round 2 added
// server-side validation that ?source= on GET /resumes/:id/results must be
// one of the six real ids (a 400 on anything else, so a typo doesn't
// silently read as "zero results"), so this test's fixture data has to use
// a real one too, exactly like searches.test.ts's DATA_SOURCE already does.
const DATA_SOURCE = "usajobs" as const;
// A second real id, used only to prove "queried a DIFFERENT real source
// with no matching jobs" is a valid, non-400 "empty" result — as opposed
// to an unrecognized source id, which is the case the 400 check exists for.
const OTHER_REAL_DATA_SOURCE = "greenhouse" as const;

beforeAll(async () => {
  testDb = await createTestDatabase("resumes_test");
  db = testDb.db;
  await db
    .insert(sourceDescriptors)
    .values([
      { id: DATA_SOURCE, displayName: "USAJOBS" },
      { id: OTHER_REAL_DATA_SOURCE, displayName: "Greenhouse" },
    ])
    .onConflictDoNothing({ target: sourceDescriptors.id });
});

afterAll(async () => {
  await testDb?.teardown();
});

function buildTestApp(inferTitles: (resumeText: string) => Promise<string[]> = async () => []) {
  return buildApp({
    db,
    getScoreJob: () => {
      throw new Error("not used by these tests");
    },
    inferTitles,
  });
}

describe("POST /resumes", () => {
  it("creates a resume from pasted text and returns its id", async () => {
    const app = buildTestApp();
    const resumeText = `Resume text ${randomUUID()}`;
    const response = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string };
    expect(typeof body.id).toBe("string");

    const rows = await db.select().from(resumes).where(eq(resumes.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeText).toBe(resumeText);
  });

  // Ticket 38a7598: a genuinely NEW resume gets a real, distinct default
  // nickname at creation time (getOrCreateResumeId in demo-match.ts) --
  // never blank, never a repeated static string.
  describe("resume nickname (ticket 38a7598)", () => {
    it("assigns a real default nickname ('Resume N') to a new resume, persisted on the row", async () => {
      const app = buildTestApp();
      const resumeText = `Nicknamed resume ${randomUUID()}`;
      const response = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });

      const body = response.json() as CreateResumeResponse;
      expect(body.resumeNickname).toMatch(/^Resume \d+$/);

      const rows = await db.select().from(resumes).where(eq(resumes.id, body.id));
      expect(rows[0]?.resumeNickname).toBe(body.resumeNickname);
    });

    it("assigns DISTINCT nicknames to two different new resumes, not a repeated static string", async () => {
      const app = buildTestApp();
      const firstResponse = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `First distinct resume ${randomUUID()}` },
      });
      const secondResponse = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Second distinct resume ${randomUUID()}` },
      });

      const firstNickname = (firstResponse.json() as CreateResumeResponse).resumeNickname;
      const secondNickname = (secondResponse.json() as CreateResumeResponse).resumeNickname;
      expect(firstNickname).toMatch(/^Resume \d+$/);
      expect(secondNickname).toMatch(/^Resume \d+$/);
      expect(secondNickname).not.toBe(firstNickname);
    });

    // Resubmitting a resume's OWN unchanged text (e.g. re-editing just to
    // fix something else) resolves to that same resume and keeps its
    // nickname. Ticket 7701534 needed `currentResumeId` to allow this
    // without tripping its duplicate guardrail; ticket 6ba221e deleted
    // that guardrail, so it works with or without the field -- the
    // behavior under test here is the nickname, which must never be
    // reassigned by a resubmission.
    it("a resubmission of identical text returns the SAME existing nickname", async () => {
      const app = buildTestApp();
      const resumeText = `Idempotent nickname resume ${randomUUID()}`;

      const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
      const { resumeNickname: firstNickname } = first.json() as CreateResumeResponse;
      const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

      expect(second.statusCode).toBe(200);
      const secondNickname = (second.json() as CreateResumeResponse).resumeNickname;
      expect(secondNickname).toBe(firstNickname);
    });

    // Ticket 3db5b35 (adversarial review finding F1, severe): the
    // frontend needs to tell "this request created a fresh row" apart
    // from "this request resolved to an existing one" to avoid treating
    // the latter's real nickname as something a pre-save client guess is
    // free to overwrite. `isNew` is `getOrCreateResumeId`'s own internal
    // answer (apps/api/src/matching/pipeline.ts), carried onto the wire
    // for the first time by this ticket -- see `CreateResumeResponse
    // .isNew`'s doc comment (@app/shared) for the full scenario.
    it("reports isNew: true for a genuinely new resume, and isNew: false for a resubmission that resolves to an existing one", async () => {
      const app = buildTestApp();
      const resumeText = `isNew-tracking resume ${randomUUID()}`;

      const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
      const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

      expect((first.json() as CreateResumeResponse).isNew).toBe(true);
      expect((second.json() as CreateResumeResponse).isNew).toBe(false);
    });
  });

  it("posting identical text twice resolves to the same id rather than a second row", async () => {
    const app = buildTestApp();
    const resumeText = `Repeated resume text ${randomUUID()}`;

    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const firstId = (first.json() as { id: string }).id;
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(second.statusCode).toBe(200);
    const secondId = (second.json() as { id: string }).id;
    expect(secondId).toBe(firstId);
    // And exactly one row exists for that text -- the create path's
    // find-or-create convenience (ticket 6ba221e kept it deliberately;
    // see the route's own comment) rather than a second "Resume N".
    const rows = await db.select().from(resumes).where(eq(resumes.resumeText, resumeText));
    expect(rows).toHaveLength(1);
  });

  // TICKET 6ba221e DELETED THE DUPLICATE-TEXT 409 (ticket 7701534) that
  // this describe block used to assert, along with its three rejection
  // tests. Nicole, reversing her own earlier requirement verbatim: "I know
  // that it was a previous requirement of mine that it wouldn't let the
  // exact same text exist for two resumes before, but now I frankly don't
  // care about that. So I want to remove that requirement. Let them do
  // that. If they want to do that, that's their business."
  //
  // The deleted cases, for the record, so a future reader can tell a
  // removed requirement from a lost test: a fresh paste whose text already
  // belonged to an existing resume 409'd; text matching a DIFFERENT resume
  // than `currentResumeId` 409'd; and neither ran title inference. All
  // three now simply succeed. What replaced them is the
  // "no duplicate-text rejection" block below, which asserts the new
  // behavior rather than leaving its absence untested.
  describe("duplicate resume text is legal (ticket 6ba221e)", () => {
    it("a fresh paste whose text already belongs to an existing resume is accepted, not 409'd", async () => {
      const app = buildTestApp();
      const resumeText = `Already-saved resume ${randomUUID()}`;

      const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
      const { id: firstId, resumeNickname: firstNickname } = first.json() as CreateResumeResponse;

      const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

      expect(second.statusCode).toBe(200);
      const body = second.json() as CreateResumeResponse;
      // Resolves to the resume that already holds this text (the create
      // path's find-or-create convenience), carrying its real nickname --
      // never an error naming a resume the user did not choose, which was
      // the core of the complaint behind this ticket.
      expect(body.id).toBe(firstId);
      expect(body.resumeNickname).toBe(firstNickname);
      expect(second.json()).not.toHaveProperty("duplicateResumeId");
    });

    it("text matching a DIFFERENT resume than the one being edited is accepted too", async () => {
      const app = buildTestApp();
      const resumeTextA = `Resume A text ${randomUUID()}`;
      const resumeTextB = `Resume B text ${randomUUID()}`;

      const respA = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: resumeTextA },
      });
      const { id: idA } = respA.json() as CreateResumeResponse;
      await app.inject({ method: "POST", url: "/resumes", payload: { resumeText: resumeTextB } });

      // Was a 409 under ticket 7701534 ("the exact same text as Resume N").
      const attempt = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: resumeTextA },
      });

      expect(attempt.statusCode).toBe(200);
      expect((attempt.json() as CreateResumeResponse).id).toBe(idA);
    });

    it("does not reject a genuinely new resume's first-ever submission", async () => {
      const app = buildTestApp();
      const response = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Brand new resume ${randomUUID()}` },
      });
      expect(response.statusCode).toBe(200);
    });

    // Genuinely new text POSTed while another resume is active is still a
    // genuinely NEW resume -- POST means "create". Editing an existing
    // resume's text is `PUT /resumes/:id/text` (its own describe block
    // below), and that distinction is the whole of ticket 6ba221e.
    it("POSTing genuinely new text creates a DISTINCT resume, it does not edit any existing one", async () => {
      const app = buildTestApp();
      const first = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Edit-original resume ${randomUUID()}` },
      });
      const { id: originalId } = first.json() as CreateResumeResponse;

      const edited = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Edit-rewritten resume ${randomUUID()}` },
      });

      expect(edited.statusCode).toBe(200);
      const { id: editedId } = edited.json() as CreateResumeResponse;
      expect(editedId).not.toBe(originalId);
    });

    // Ticket 6ba221e: `currentResumeId` is accepted-and-ignored rather
    // than removed from the body schema, which is
    // `additionalProperties: false` -- a cached pre-6ba221e browser bundle
    // still sends it, and dropping the property would 400 every resume
    // creation from such a client. This is that back-compat promise as a
    // test, not an aspiration in a comment.
    it("still ACCEPTS a legacy currentResumeId field, ignoring it rather than 400ing on it", async () => {
      const app = buildTestApp();
      const resumeText = `Legacy currentResumeId resume ${randomUUID()}`;
      const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
      const { id: firstId } = first.json() as CreateResumeResponse;

      // A pre-6ba221e client editing: same id in `currentResumeId`, new
      // text. Under 7701534 this was the "allowed" branch; it must still
      // not be a schema rejection.
      const legacy = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `${resumeText} rewritten`, currentResumeId: firstId },
      });
      expect(legacy.statusCode).toBe(200);
    });
  });

  // Ticket b2f9dfd (epic 2b9e9dd): resume-text uniqueness, nickname
  // uniqueness, and "Resume N" numbering are all now scoped PER USER, not
  // global -- Nicole's own motivating case: using a friend's resume as
  // test data must never collide with that friend's own later, real
  // usage. `injectAs` (test-support/build-test-app.js, from ticket
  // dba885e) is the casing-proof way to act as a specific user within one
  // test.
  describe("per-user scoping (ticket b2f9dfd)", () => {
    it("two different users can submit byte-identical resume text with no collision", async () => {
      const app = buildTestApp();
      const resumeText = `Shared test resume ${randomUUID()}`;
      const userA = randomUUID();
      const userB = randomUUID();

      const respA = await injectAs(app, userA, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const respB = await injectAs(app, userB, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });

      expect(respA.statusCode).toBe(200);
      expect(respB.statusCode).toBe(200);
      const { id: idA } = respA.json() as CreateResumeResponse;
      const { id: idB } = respB.json() as CreateResumeResponse;
      expect(idA).not.toBe(idB);

      // Two REAL rows, not one silently shared or one rejected.
      const rows = await db.select().from(resumes).where(eq(resumes.resumeText, resumeText));
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([userA, userB]));
    });

    it("the SAME user resubmitting their own unchanged text still resolves to the one existing row (unchanged behavior)", async () => {
      const app = buildTestApp();
      const userId = randomUUID();
      const resumeText = `Same user resubmit ${randomUUID()}`;

      const first = await injectAs(app, userId, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const { id: firstId } = first.json() as CreateResumeResponse;
      const second = await injectAs(app, userId, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });

      expect(second.statusCode).toBe(200);
      expect((second.json() as CreateResumeResponse).id).toBe(firstId);
    });

    it("a nickname collision is only rejected within the SAME user -- a different user can reuse it freely", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();

      const respA = await injectAs(app, userA, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `User A resume ${randomUUID()}` },
      });
      const { resumeNickname: nicknameA } = respA.json() as CreateResumeResponse;

      await injectAs(app, userB, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `User B resume ${randomUUID()}` },
      });
      const bList = await injectAs(app, userB, { method: "GET", url: "/resumes" });
      const bResumeId = (bList.json() as { resumes: { id: string }[] }).resumes[0]!.id;

      // User B renames their OWN resume to the exact nickname user A
      // already has -- must succeed, since uniqueness is now per-user.
      const rename = await injectAs(app, userB, {
        method: "PATCH",
        url: `/resumes/${bResumeId}`,
        payload: { resumeNickname: nicknameA },
      });

      expect(rename.statusCode).toBe(200);
      expect((rename.json() as UpdateResumeNicknameResponse).resumeNickname).toBe(nicknameA);
    });

    it("'Resume N' numbering restarts at 1 for each new user, independent of how many resumes other users already have", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();

      for (let i = 0; i < 3; i++) {
        await injectAs(app, userA, {
          method: "POST",
          url: "/resumes",
          payload: { resumeText: `User A resume ${i} ${randomUUID()}` },
        });
      }

      // User B's very first resume must still be "Resume 1", not "Resume 4".
      const respB = await injectAs(app, userB, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `User B first resume ${randomUUID()}` },
      });

      expect((respB.json() as CreateResumeResponse).resumeNickname).toBe("Resume 1");
    });

    it("GET /resumes only lists the requesting user's own resumes", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();

      await injectAs(app, userA, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `User A own resume ${randomUUID()}` },
      });
      await injectAs(app, userB, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `User B own resume ${randomUUID()}` },
      });

      const listA = await injectAs(app, userA, { method: "GET", url: "/resumes" });

      expect((listA.json() as { resumes: unknown[] }).resumes).toHaveLength(1);
    });
  });

  /**
   * Ticket 3fc1e5e: cross-user isolation for every read/write path this
   * file's routes expose, written as "user A must never see or mutate user
   * B's data" rather than as "the query has a WHERE clause" -- each test
   * below asserts the BEHAVIOR that was broken before the fix, so it fails
   * if the scoping is removed for any reason (including a rewritten query
   * that keeps the clause but loses its effect, e.g. an unscoped join).
   */
  describe("cross-user isolation (ticket 3fc1e5e)", () => {
    /** One scored job for `resumeId`, owned by whoever owns that resume. */
    async function seedScoredJobFor(
      resumeId: string,
      matchScore: number,
      title: string,
    ): Promise<string> {
      const jobId = randomUUID();
      await db.insert(jobsTable).values({
        id: jobId,
        externalId: `xuser-test-${jobId}`,
        dataSource: DATA_SOURCE,
        title,
        description: "a job description",
        company: "Test Co",
        linkToApply: `https://example.com/${jobId}`,
        postedAt: new Date("2026-01-01T00:00:00Z"),
      });
      await db.insert(jobMatches).values({
        id: randomUUID(),
        resumeId,
        jobId,
        matchScore,
        rationale: "fake rationale",
        strengths: [],
        gaps: [],
      });
      return jobId;
    }

    /** Creates a resume through the real route as `userId`, returning its id. */
    async function createResumeAs(
      app: ReturnType<typeof buildTestApp>,
      userId: string,
      label: string,
    ): Promise<string> {
      const response = await injectAs(app, userId, {
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `${label} ${randomUUID()}` },
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as CreateResumeResponse).id;
    }

    it("GET /resumes/:id does not return another user's resume text (404, not 403)", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const resumeA = await createResumeAs(app, userA, "User A private resume");

      const asB = await injectAs(app, userB, { method: "GET", url: `/resumes/${resumeA}` });

      // 404 specifically, NOT 403: a caller must not be able to use the
      // status code to confirm that an id they guessed is real.
      expect(asB.statusCode).toBe(404);
      // And the text itself must not appear anywhere in the body.
      expect(asB.body).not.toContain("User A private resume");

      // The owner still reads it perfectly well -- proving the 404 above is
      // the scoping, not a broken route.
      const asA = await injectAs(app, userA, { method: "GET", url: `/resumes/${resumeA}` });
      expect(asA.statusCode).toBe(200);
      expect((asA.json() as { resumeText: string }).resumeText).toContain("User A private resume");
    });

    it("PATCH /resumes/:id cannot rename another user's resume", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const resumeA = await createResumeAs(app, userA, "User A resume");

      const before = await db.select().from(resumes).where(eq(resumes.id, resumeA));
      const originalNickname = before[0]!.resumeNickname;

      const attempt = await injectAs(app, userB, {
        method: "PATCH",
        url: `/resumes/${resumeA}`,
        payload: { resumeNickname: "Renamed by a stranger" },
      });

      expect(attempt.statusCode).toBe(404);
      // The decisive assertion is the DATABASE, not the status code: the
      // pre-fix bug returned 200 and really did write the new nickname.
      const after = await db.select().from(resumes).where(eq(resumes.id, resumeA));
      expect(after[0]!.resumeNickname).toBe(originalNickname);
    });

    it("PATCH /resumes/:id checks nickname collisions against the OWNER's namespace, so it cannot create a duplicate for them", async () => {
      // The precise pre-fix failure: the collision check was scoped to the
      // REQUESTING user (b2f9dfd) while the UPDATE matched on id alone, so
      // user B could rename user A's "Resume 1" to a name A already used --
      // the check passed (B has no such nickname), the write landed, and A
      // was left with two identically-named resumes.
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const firstA = await createResumeAs(app, userA, "User A first");
      const secondA = await createResumeAs(app, userA, "User A second");

      const secondName = (await db.select().from(resumes).where(eq(resumes.id, secondA)))[0]!
        .resumeNickname;

      const attempt = await injectAs(app, userB, {
        method: "PATCH",
        url: `/resumes/${firstA}`,
        payload: { resumeNickname: secondName },
      });

      expect(attempt.statusCode).toBe(404);
      const rowsA = await db.select().from(resumes).where(eq(resumes.userId, userA));
      const names = rowsA.map((r) => r.resumeNickname);
      expect(new Set(names).size).toBe(names.length);
    });

    it("GET /resumes/:id/results does not serve another user's resume's results", async () => {
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const resumeA = await createResumeAs(app, userA, "User A resume");
      await seedScoredJobFor(resumeA, 90, "User A only job");

      const asB = await injectAs(app, userB, {
        method: "GET",
        url: `/resumes/${resumeA}/results`,
      });

      expect(asB.statusCode).toBe(404);
      expect(asB.body).not.toContain("User A only job");

      const asA = await injectAs(app, userA, {
        method: "GET",
        url: `/resumes/${resumeA}/results`,
      });
      expect(asA.statusCode).toBe(200);
      expect((asA.json() as { results: { title: string }[] }).results).toHaveLength(1);
    });

    it("GET /results returns only the caller's own scored jobs, across their own resumes", async () => {
      // THE ticket's named case. Pre-fix this route had no scoping at all,
      // so it returned every job_matches row in the database -- other
      // users' job titles, companies, scores, rationales and resume
      // nicknames -- to any caller, with no id to guess.
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();

      const resumeA1 = await createResumeAs(app, userA, "User A resume one");
      const resumeA2 = await createResumeAs(app, userA, "User A resume two");
      const resumeB = await createResumeAs(app, userB, "User B resume");

      await seedScoredJobFor(resumeA1, 90, "A job from resume one");
      await seedScoredJobFor(resumeA2, 80, "A job from resume two");
      await seedScoredJobFor(resumeB, 95, "B secret job");

      const asA = await injectAs(app, userA, { method: "GET", url: "/results" });
      expect(asA.statusCode).toBe(200);
      const titlesA = (asA.json() as { results: { title: string }[] }).results.map((r) => r.title);

      // Still CROSS-RESUME for the caller (ticket 3f0883f's whole point is
      // preserved) -- both of A's resumes are represented...
      expect(new Set(titlesA)).toEqual(new Set(["A job from resume one", "A job from resume two"]));
      // ...and B's job is absent, along with any trace of B's resume.
      expect(asA.body).not.toContain("B secret job");

      // Symmetric check: B sees only B's.
      const asB = await injectAs(app, userB, { method: "GET", url: "/results" });
      const titlesB = (asB.json() as { results: { title: string }[] }).results.map((r) => r.title);
      expect(titlesB).toEqual(["B secret job"]);
    });

    it("GET /results' hiddenBelowFloor count does not count another user's below-floor jobs", async () => {
      // The count queries were the subtlest part of this fix: they are
      // separate SQL statements from the main SELECT, and one of them had
      // deliberately dropped the `resumes` join as unnecessary (ticket
      // e9a82f3). An unscoped count leaks a real aggregate fact about other
      // users' data even when no row is returned.
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const resumeA = await createResumeAs(app, userA, "User A resume");
      const resumeB = await createResumeAs(app, userB, "User B resume");

      await seedScoredJobFor(resumeA, 90, "A above floor");
      await seedScoredJobFor(resumeA, 10, "A below floor");
      // Three of B's jobs are below the floor; none may be counted for A.
      await seedScoredJobFor(resumeB, 11, "B below floor one");
      await seedScoredJobFor(resumeB, 12, "B below floor two");
      await seedScoredJobFor(resumeB, 13, "B below floor three");

      const asA = await injectAs(app, userA, { method: "GET", url: "/results?minScore=50" });

      expect(asA.statusCode).toBe(200);
      const body = asA.json() as { results: unknown[]; hiddenBelowFloor?: number };
      expect(body.results).toHaveLength(1);
      expect(body.hiddenBelowFloor).toBe(1);
    });

    it("another user's job status neither leaks into nor duplicates the caller's results", async () => {
      // Two failures in one, both caused by joining `user_job_statuses` on
      // job_id alone once its key became (user_id, job_id):
      //   - the caller would see a STRANGER's status on their own job card;
      //   - the row would be DUPLICATED once per other user holding a
      //     status on that job (a left join that can match many rows
      //     multiplies its left side).
      // Both users hold a status on the SAME job here, which is exactly the
      // shape that was impossible under the old unique(job_id) key.
      const app = buildTestApp();
      const userA = randomUUID();
      const userB = randomUUID();
      const resumeA = await createResumeAs(app, userA, "User A resume");
      const resumeB = await createResumeAs(app, userB, "User B resume");

      const sharedJob = await seedScoredJobFor(resumeA, 88, "A shared posting");
      // B has scored the same posting against their own resume, and
      // DISMISSED it. A has saved it.
      await db.insert(jobMatches).values({
        id: randomUUID(),
        resumeId: resumeB,
        jobId: sharedJob,
        matchScore: 70,
        rationale: "fake rationale",
        strengths: [],
        gaps: [],
      });
      await db.insert(userJobStatuses).values([
        { id: randomUUID(), userId: userA, jobId: sharedJob, status: "saved" },
        { id: randomUUID(), userId: userB, jobId: sharedJob, status: "dismissed" },
      ]);

      const asA = await injectAs(app, userA, { method: "GET", url: "/results" });
      const resultsA = (asA.json() as { results: { jobId: string; status: string | null }[] })
        .results;

      // Exactly ONE row for that job (no multiplication), carrying A's OWN
      // status. Pre-fix: two rows, and one of them said "dismissed".
      const forSharedJob = resultsA.filter((r) => r.jobId === sharedJob);
      expect(forSharedJob).toHaveLength(1);
      expect(forSharedJob[0]!.status).toBe("saved");

      // And B's dismissal must not remove the job from B's OWN default
      // view's counterpart for A -- while B, who really did dismiss it,
      // still has it excluded by default.
      const asB = await injectAs(app, userB, { method: "GET", url: "/results" });
      const resultsB = (asB.json() as { results: { jobId: string }[] }).results;
      expect(resultsB.filter((r) => r.jobId === sharedJob)).toHaveLength(0);
    });
  });

  it("rejects an empty resumeText with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a missing resumeText field with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/resumes", payload: {} });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-string resumeText (400) rather than silently coercing it to a string", async () => {
    // Ticket 59fdc52 review round 2: Fastify's AJV coerces types by
    // default, so `{"resumeText": 123}` used to pass the `{ type: "string"
    // }` schema as the STRING "123" — a resume literally containing the
    // three characters "123" got created and hashed, no 400 anywhere.
    // `ajv: { customOptions: { coerceTypes: false } }` (index.ts) is the
    // fix; this proves it end to end rather than just at the unit level.
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: 123 },
    });
    expect(response.statusCode).toBe(400);

    // And, just as importantly: no resume containing "123" got created.
    const rows = await db.select().from(resumes).where(eq(resumes.resumeText, "123"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a resumeText over the length ceiling with 400, not 500", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: "x".repeat(200_001) },
    });
    expect(response.statusCode).toBe(400);
  });
});

// Ticket 39b4a48: resume-based title-keyword inference, replacing the old
// hardcoded software-engineering filter default.
describe("POST /resumes — suggested title inference (ticket 39b4a48)", () => {
  it("returns real suggested titles from the injected inferTitles function", async () => {
    const inferTitles = async () => ["Technical Writer", "Documentation Engineer"];
    const app = buildTestApp(inferTitles);
    const resumeText = `Resume text ${randomUUID()}`;

    const response = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as CreateResumeResponse;
    expect(body.suggestedTitles).toEqual(["Technical Writer", "Documentation Engineer"]);
  });

  it("calls inferTitles at most once per resume: a resubmission of its own identical text reuses the cached suggestions", async () => {
    let calls = 0;
    const inferTitles = async () => {
      calls++;
      return ["Software Engineer"];
    };
    const app = buildTestApp(inferTitles);
    const resumeText = `Resume text ${randomUUID()}`;

    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(calls).toBe(1);
    expect((first.json() as CreateResumeResponse).suggestedTitles).toEqual(["Software Engineer"]);
    expect((second.json() as CreateResumeResponse).suggestedTitles).toEqual(["Software Engineer"]);
  });

  it("resume creation still succeeds (200, real id) even if inferTitles throws", async () => {
    const inferTitles = async (): Promise<string[]> => {
      throw new Error("simulated inference failure");
    };
    const app = buildTestApp(inferTitles);
    const resumeText = `Resume text ${randomUUID()}`;

    const response = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as CreateResumeResponse;
    expect(typeof body.id).toBe("string");
    // The 39b4a48 guarantee: resume creation must never depend on
    // inference succeeding. The RESPONSE still degrades to `[]` (the
    // client-facing shape is never nullable), but see the next assertion
    // for what actually gets persisted.
    expect(body.suggestedTitles).toEqual([]);

    const rows = await db.select().from(resumes).where(eq(resumes.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeText).toBe(resumeText);
    // TICKET 82ae975, THE ACTUAL BUG: the row must be persisted as `null`
    // (not inferred yet), never `[]` (ran, found nothing) -- `[]` is
    // indistinguishable from a genuine empty success and is never `null`,
    // so the `suggestedTitles === null` lazy re-inference gate above never
    // fires again for it. A failure cached as `[]` wipes that resume's
    // chips forever with no self-healing; `null` keeps it retryable.
    expect(rows[0]?.suggestedTitles).toBeNull();
  });

  it("ticket 82ae975: a failed inference self-heals on a later resubmission of the SAME resume text, against real Postgres", async () => {
    // The lazy gate this test proves still works end to end: a resume
    // whose first inference attempt failed (persisted `null`, per the test
    // above) is NOT stuck that way forever -- resubmitting the identical
    // text (the find-or-create path, `POST /resumes`) hits the same row,
    // sees `suggestedTitles === null`, and tries again. This is the exact
    // self-healing path the ticket's acceptance criteria require to be
    // "verified against real Postgres, not a mock" -- `db` here is the
    // real, migrated test database this file already uses throughout.
    let shouldThrow = true;
    const inferTitles = async (): Promise<string[]> => {
      if (shouldThrow) throw new Error("simulated inference failure");
      return ["Recovered Title"];
    };
    const app = buildTestApp(inferTitles);
    const resumeText = `Self-healing resume ${randomUUID()}`;

    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    expect((first.json() as CreateResumeResponse).suggestedTitles).toEqual([]);
    const { id } = first.json() as CreateResumeResponse;
    const rowAfterFailure = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(rowAfterFailure[0]?.suggestedTitles).toBeNull();

    // The underlying API call recovers (e.g. a transient rate limit
    // clears) -- the resume itself was never touched, it's the SAME text.
    shouldThrow = false;
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(second.statusCode).toBe(200);
    expect((second.json() as CreateResumeResponse).id).toBe(id); // same row, find-or-create
    expect((second.json() as CreateResumeResponse).suggestedTitles).toEqual(["Recovered Title"]);
    const rowAfterRecovery = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(rowAfterRecovery[0]?.suggestedTitles).toEqual(["Recovered Title"]);
  });

  it("an empty inference result ([]) is itself cached, not retried on a legitimate resubmission", async () => {
    let calls = 0;
    const inferTitles = async () => {
      calls++;
      return [];
    };
    const app = buildTestApp(inferTitles);
    const resumeText = `Resume text ${randomUUID()}`;

    await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(second.statusCode).toBe(200);
    expect(calls).toBe(1);
  });
});

// Ticket 303cff0 ("My Resumes" tab): lists every saved resume, cheap
// (no `resumeText`) and ordered oldest-first to match nickname numbering.
//
// Ticket c434a6e: this whole FILE shares one test database with no
// truncation between tests (see `GET /results`' own comment on this a
// few describe blocks down) -- every test below asserts against a
// specific, randomUUID-unique resume it just created rather than
// against the list's total contents or length, so it's robust to
// whatever earlier tests in this file have already inserted.
describe("GET /resumes (ticket 303cff0)", () => {
  it("responds 200 with a resumes array", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes" });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray((response.json() as { resumes: unknown }).resumes)).toBe(true);
  });

  it("returns created resumes with id, nickname, and an ISO createdAt -- no resumeText", async () => {
    const app = buildTestApp();
    const resumeText = `Listed resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id, resumeNickname } = created.json() as CreateResumeResponse;

    const response = await app.inject({ method: "GET", url: "/resumes" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { resumes: Array<Record<string, unknown>> };
    const listed = body.resumes.find((r) => r.id === id);
    expect(listed).toBeDefined();
    expect(listed).toMatchObject({ id, resumeNickname });
    expect(typeof listed?.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(listed?.createdAt as string))).toBe(false);
    expect(listed).not.toHaveProperty("resumeText");
  });

  it("orders resumes oldest-first, matching their 'Resume N' nickname numbering", async () => {
    const app = buildTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Ordering-first resume ${randomUUID()}` },
    });
    const second = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Ordering-second resume ${randomUUID()}` },
    });
    const firstId = (first.json() as CreateResumeResponse).id;
    const secondId = (second.json() as CreateResumeResponse).id;

    const response = await app.inject({ method: "GET", url: "/resumes" });
    const ids = (response.json() as { resumes: Array<{ id: string }> }).resumes.map((r) => r.id);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
  });

  it("reflects a rename made via PATCH /resumes/:id", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Renamed-before-listing resume ${randomUUID()}` },
    });
    const { id } = created.json() as CreateResumeResponse;
    await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "Renamed before listing" },
    });

    const response = await app.inject({ method: "GET", url: "/resumes" });
    const listed = (
      response.json() as { resumes: Array<{ id: string; resumeNickname: string }> }
    ).resumes.find((r) => r.id === id);
    expect(listed?.resumeNickname).toBe("Renamed before listing");
  });
});

describe("GET /resumes/:id", () => {
  it("returns a previously created resume, including its nickname", async () => {
    const app = buildTestApp();
    const resumeText = `Fetch-me resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id, resumeNickname } = created.json() as CreateResumeResponse;

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id,
      resumeText,
      resumeNickname,
      isLocked: false,
      suggestedTitles: [],
    });
  });

  it("404s for an unknown id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist" });
    expect(response.statusCode).toBe(404);
  });
});

// Ticket 88f11d7, Nicole: "once that has happened, then a user can't
// change the text on the resume anymore." `isLocked` is `true` once a
// resume has ever had a REAL (non-estimate) search run against it --
// see schema.ts's `searches.isEstimate` doc comment for exactly what
// distinguishes the two and why re-estimating must never lock a resume.
describe("isLocked (ticket 88f11d7)", () => {
  it("is false for a resume with no searches at all", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Never-searched resume ${randomUUID()}` },
    });
    const { id } = created.json() as CreateResumeResponse;

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect((response.json() as { isLocked: boolean }).isLocked).toBe(false);
  });

  it("is false for a resume with only ESTIMATE searches, however many", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Estimate-only resume ${randomUUID()}` },
    });
    const { id } = created.json() as CreateResumeResponse;

    for (let i = 0; i < 3; i++) {
      await db.insert(searches).values({
        id: randomUUID(),
        resumeId: id,
        searchedAt: new Date(),
        status: "complete",
        isEstimate: true,
      });
    }

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect((response.json() as { isLocked: boolean }).isLocked).toBe(false);
  });

  it("is true once a resume has at least one REAL (non-estimate) search, regardless of status", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Really-searched resume ${randomUUID()}` },
    });
    const { id } = created.json() as CreateResumeResponse;

    await db.insert(searches).values({
      id: randomUUID(),
      resumeId: id,
      searchedAt: new Date(),
      status: "running",
      isEstimate: false,
    });

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect((response.json() as { isLocked: boolean }).isLocked).toBe(true);
  });

  it("stays true even after that real search settles to 'complete' -- there is no unlock path", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Settled-search resume ${randomUUID()}` },
    });
    const { id } = created.json() as CreateResumeResponse;

    await db.insert(searches).values({
      id: randomUUID(),
      resumeId: id,
      searchedAt: new Date(),
      status: "complete",
      completedAt: new Date(),
      isEstimate: false,
    });

    const response = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect((response.json() as { isLocked: boolean }).isLocked).toBe(true);
  });

  it("POST /resumes also reports isLocked, for a resubmission of the currently-active resume's own text", async () => {
    const app = buildTestApp();
    const resumeText = `Resubmit-after-search resume ${randomUUID()}`;
    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = first.json() as CreateResumeResponse;
    expect((first.json() as CreateResumeResponse).isLocked).toBe(false);

    await db.insert(searches).values({
      id: randomUUID(),
      resumeId: id,
      searchedAt: new Date(),
      status: "running",
      isEstimate: false,
    });

    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    expect(second.statusCode).toBe(200);
    expect((second.json() as CreateResumeResponse).isLocked).toBe(true);
  });
});

// Ticket 38a7598: "user can rename the nickname... an editable field, not
// read-only." Deliberately minimal endpoint -- only `resumeNickname` is
// writable (see UpdateResumeNicknameRequest's doc comment in @app/shared).
describe("PATCH /resumes/:id (ticket 38a7598)", () => {
  it("renames the nickname and returns the new value", async () => {
    const app = buildTestApp();
    const resumeText = `Rename-me resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = created.json() as CreateResumeResponse;

    const response = await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "Backend-focused resume" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as UpdateResumeNicknameResponse;
    expect(body).toEqual({ id, resumeNickname: "Backend-focused resume" });
  });

  it("persists the rename -- reflected in a SUBSEQUENT GET /resumes/:id, not just the PATCH response", async () => {
    const app = buildTestApp();
    const resumeText = `Persisted-rename resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = created.json() as CreateResumeResponse;

    await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "Renamed for the second search" },
    });

    const refetched = await app.inject({ method: "GET", url: `/resumes/${id}` });
    expect((refetched.json() as { resumeNickname: string }).resumeNickname).toBe(
      "Renamed for the second search",
    );
  });

  it("persists the rename into GET /resumes/:id/results' top-level resumeNickname too", async () => {
    const app = buildTestApp();
    const resumeText = `Renamed-for-results resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = created.json() as CreateResumeResponse;

    await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "Renamed before searching" },
    });

    const results = await app.inject({ method: "GET", url: `/resumes/${id}/results` });
    expect((results.json() as { resumeNickname: string }).resumeNickname).toBe(
      "Renamed before searching",
    );
  });

  it("rejects an empty nickname with 400, not 500", async () => {
    const app = buildTestApp();
    const resumeText = `Empty-rename resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = created.json() as CreateResumeResponse;

    const response = await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "   " },
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a nickname over the length ceiling with 400, not 500", async () => {
    const app = buildTestApp();
    const resumeText = `Long-rename resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id } = created.json() as CreateResumeResponse;

    const response = await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: "x".repeat(201) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown resume id, rather than silently creating one", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/resumes/does-not-exist",
      payload: { resumeNickname: "New name" },
    });
    expect(response.statusCode).toBe(404);
  });

  // Ticket 7701534, Nicole: "if they try to make a nickname that's
  // already been used for that user, it should have an error... This
  // resume nickname is already in use."
  describe("nickname collision (ticket 7701534)", () => {
    it("rejects a nickname already used by a DIFFERENT resume, 409, with the exact requested message", async () => {
      const app = buildTestApp();
      const first = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Collision-first resume ${randomUUID()}` },
      });
      const { id: firstId } = first.json() as CreateResumeResponse;
      await app.inject({
        method: "PATCH",
        url: `/resumes/${firstId}`,
        payload: { resumeNickname: "Taken Nickname" },
      });

      const second = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Collision-second resume ${randomUUID()}` },
      });
      const { id: secondId } = second.json() as CreateResumeResponse;

      const response = await app.inject({
        method: "PATCH",
        url: `/resumes/${secondId}`,
        payload: { resumeNickname: "Taken Nickname" },
      });

      expect(response.statusCode).toBe(409);
      const body = response.json() as { error: string; reason: string };
      expect(body.error).toBe("This resume nickname is already in use.");
      expect(body.reason).toBe("nickname_conflict");

      // And the second resume's nickname was NOT changed by the rejected attempt.
      const refetched = await app.inject({ method: "GET", url: `/resumes/${secondId}` });
      expect((refetched.json() as { resumeNickname: string }).resumeNickname).not.toBe(
        "Taken Nickname",
      );
    });

    it("collision is case-insensitive", async () => {
      const app = buildTestApp();
      const first = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Case-first resume ${randomUUID()}` },
      });
      const { id: firstId } = first.json() as CreateResumeResponse;
      await app.inject({
        method: "PATCH",
        url: `/resumes/${firstId}`,
        payload: { resumeNickname: "MixedCase Nickname" },
      });

      const second = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Case-second resume ${randomUUID()}` },
      });
      const { id: secondId } = second.json() as CreateResumeResponse;

      const response = await app.inject({
        method: "PATCH",
        url: `/resumes/${secondId}`,
        payload: { resumeNickname: "mixedcase nickname" },
      });

      expect(response.statusCode).toBe(409);
    });

    it("does NOT reject renaming a resume to its OWN current nickname (no-op case)", async () => {
      const app = buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Self-rename resume ${randomUUID()}` },
      });
      const { id } = created.json() as CreateResumeResponse;
      await app.inject({
        method: "PATCH",
        url: `/resumes/${id}`,
        payload: { resumeNickname: "My Own Nickname" },
      });

      // Re-saving the exact same nickname it already has must not
      // self-collide.
      const response = await app.inject({
        method: "PATCH",
        url: `/resumes/${id}`,
        payload: { resumeNickname: "My Own Nickname" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("does NOT reject renaming a resume to a nickname only IT has ever had, changing only case", async () => {
      const app = buildTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Case-change resume ${randomUUID()}` },
      });
      const { id } = created.json() as CreateResumeResponse;
      await app.inject({
        method: "PATCH",
        url: `/resumes/${id}`,
        payload: { resumeNickname: "lowercase nickname" },
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/resumes/${id}`,
        payload: { resumeNickname: "LOWERCASE NICKNAME" },
      });

      expect(response.statusCode).toBe(200);
    });

    it("does NOT reject two DIFFERENT nicknames that merely aren't taken", async () => {
      const app = buildTestApp();
      const first = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Distinct-first resume ${randomUUID()}` },
      });
      const { id: firstId } = first.json() as CreateResumeResponse;
      const second = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText: `Distinct-second resume ${randomUUID()}` },
      });
      const { id: secondId } = second.json() as CreateResumeResponse;

      const responseA = await app.inject({
        method: "PATCH",
        url: `/resumes/${firstId}`,
        payload: { resumeNickname: `Unique A ${randomUUID()}` },
      });
      const responseB = await app.inject({
        method: "PATCH",
        url: `/resumes/${secondId}`,
        payload: { resumeNickname: `Unique B ${randomUUID()}` },
      });

      expect(responseA.statusCode).toBe(200);
      expect(responseB.statusCode).toBe(200);
    });
  });
});

/**
 * TICKET 6ba221e: `PUT /resumes/:id/text` -- the in-place text edit this
 * whole ticket exists for.
 *
 * Every assertion below that matters is made against the ROW READ BACK FROM
 * POSTGRES, not against the response body, because the response body is
 * exactly what a broken implementation would still get right: a handler
 * that created a new row and returned the OLD row's nickname would look
 * fine from the outside. The failure these tests exist to catch is Nicole's
 * own report -- "if I'm on resume one and I make an edit and I hit save and
 * it's still called resume one, it actually becomes resume 2" -- which is a
 * fact about the TABLE.
 */
describe("PUT /resumes/:id/text (ticket 6ba221e)", () => {
  /** Creates a resume through the real route, returning its id and nickname. */
  async function createResume(
    app: ReturnType<typeof buildTestApp>,
    resumeText: string,
    userId: string = DEFAULT_TEST_USER_ID,
  ): Promise<{ id: string; resumeNickname: string }> {
    const response = await injectAs(app, userId, {
      method: "POST",
      url: "/resumes",
      payload: { resumeText },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as CreateResumeResponse;
    return { id: body.id, resumeNickname: body.resumeNickname };
  }

  /** One scored job attached to `resumeId`. Returns the job's id. */
  async function seedScoredJobFor(resumeId: string, matchScore: number): Promise<string> {
    const jobId = randomUUID();
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `put-text-${jobId}`,
      dataSource: DATA_SOURCE,
      title: "Senior Backend Engineer",
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
    });
    return jobId;
  }

  it("keeps the same resumes.id and creates no new row -- verified by reading the table", async () => {
    const app = buildTestApp();
    const original = `Original text ${randomUUID()}`;
    const { id } = await createResume(app, original);

    const rowsBefore = await db
      .select()
      .from(resumes)
      .where(eq(resumes.userId, DEFAULT_TEST_USER_ID));
    const countBefore = rowsBefore.length;

    const edited = `Edited text ${randomUUID()}`;
    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: edited },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as UpdateResumeTextResponse).id).toBe(id);

    // THE ROW ITSELF: same id, new text, and no sibling appeared.
    const row = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(row).toHaveLength(1);
    expect(row[0]?.resumeText).toBe(edited);
    const rowsAfter = await db
      .select()
      .from(resumes)
      .where(eq(resumes.userId, DEFAULT_TEST_USER_ID));
    expect(rowsAfter).toHaveLength(countBefore);
    // And the ORIGINAL text exists nowhere any more -- this was an edit,
    // not a copy-on-write that left the old version behind.
    const stale = await db.select().from(resumes).where(eq(resumes.resumeText, original));
    expect(stale).toHaveLength(0);
  });

  it("keeps the resume's nickname across a text edit -- no 'Resume 2'", async () => {
    const app = buildTestApp();
    const { id, resumeNickname } = await createResume(app, `Nickname-keeping ${randomUUID()}`);
    // Rename it first, so this proves the nickname is PRESERVED rather
    // than merely re-derived to the same default by luck.
    const renamed = `Tailored for platform roles ${randomUUID()}`;
    const patch = await app.inject({
      method: "PATCH",
      url: `/resumes/${id}`,
      payload: { resumeNickname: renamed },
    });
    expect(patch.statusCode).toBe(200);
    expect(renamed).not.toBe(resumeNickname);

    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: `Rewritten ${randomUUID()}` },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as UpdateResumeTextResponse).resumeNickname).toBe(renamed);
    const row = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(row[0]?.resumeNickname).toBe(renamed);
  });

  it("recomputes resume_hash to match the new text", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Hash-check original ${randomUUID()}`);
    const before = await db.select().from(resumes).where(eq(resumes.id, id));

    const edited = `Hash-check edited ${randomUUID()}`;
    await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: edited },
    });

    const after = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(after[0]?.resumeHash).not.toBe(before[0]?.resumeHash);
    // Equal to the canonical hash of the new text, not merely "different":
    // a handler that wrote a random value would also pass the line above.
    expect(after[0]?.resumeHash).toBe(createHash("sha256").update(edited, "utf8").digest("hex"));
  });

  it("leaves previously scored jobs attached to the same resume", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Scored-jobs resume ${randomUUID()}`);
    const jobId = await seedScoredJobFor(id, 88);

    await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: `Scored-jobs rewritten ${randomUUID()}` },
    });

    // Ticket 6ba221e explicitly ACCEPTS that these scores now describe
    // text that is no longer there (Nicole, twice). What must not happen
    // is them going MISSING: before this ticket, an "edit" minted a new
    // resume id whose results were empty, which read as "my search
    // vanished".
    const results = await app.inject({ method: "GET", url: `/resumes/${id}/results` });
    expect(results.statusCode).toBe(200);
    const body = results.json() as GetResumeResultsResponse;
    expect(body.results.map((r) => r.jobId)).toEqual([jobId]);
    expect(body.results[0]?.matchScore).toBe(88);
  });

  it("leaves job_statuses rows intact -- 'I applied to X' still answers correctly after a text edit", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Applied-status resume ${randomUUID()}`);
    const jobId = await seedScoredJobFor(id, 70);

    const applied = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/status`,
      payload: { status: "applied" },
    });
    expect(applied.statusCode).toBe(200);

    await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: `Applied-status rewritten ${randomUUID()}` },
    });

    // `user_job_statuses` is keyed (user_id, job_id) with resume_id
    // deliberately absent (db/schema.ts's long comment on that key),
    // precisely so this survives a resume rewrite. Asserted as BEHAVIOR
    // through the results route -- the status the UI actually reads --
    // not just as a row count.
    const results = await app.inject({ method: "GET", url: `/resumes/${id}/results` });
    const body = results.json() as GetResumeResultsResponse;
    expect(body.results[0]?.jobId).toBe(jobId);
    expect(body.results[0]?.status).toBe("applied");

    const statusRows = await db
      .select()
      .from(userJobStatuses)
      .where(eq(userJobStatuses.jobId, jobId));
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]?.status).toBe("applied");
  });

  it("lets the same user hold TWO resumes with byte-identical text, both usable", async () => {
    const app = buildTestApp();
    const userId = randomUUID();
    const sharedText = `Identical text for two resumes ${randomUUID()}`;
    const first = await createResume(app, sharedText, userId);
    const second = await createResume(app, `A different second resume ${randomUUID()}`, userId);

    // Editing the second one INTO the first one's exact text. This was
    // impossible twice over before ticket 6ba221e: the unique index
    // rejected the write, and the route 409'd before even trying.
    const response = await injectAs(app, userId, {
      method: "PUT",
      url: `/resumes/${second.id}/text`,
      payload: { resumeText: sharedText },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db
      .select()
      .from(resumes)
      .where(and(eq(resumes.userId, userId), eq(resumes.resumeText, sharedText)));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual([first.id, second.id].sort());
    // Same hash on both rows -- the column is still maintained, it just
    // isn't unique any more.
    expect(rows[0]?.resumeHash).toBe(rows[1]?.resumeHash);

    // BOTH USABLE, which is the half a bare row count would miss: each is
    // independently readable, independently renameable, and carries its
    // own scored results.
    for (const r of [first, second]) {
      const got = await injectAs(app, userId, { method: "GET", url: `/resumes/${r.id}` });
      expect(got.statusCode).toBe(200);
      expect((got.json() as GetResumeResponse).resumeText).toBe(sharedText);
    }
    const firstJob = await seedScoredJobFor(first.id, 61);
    const secondJob = await seedScoredJobFor(second.id, 62);
    const firstResults = await injectAs(app, userId, {
      method: "GET",
      url: `/resumes/${first.id}/results`,
    });
    const secondResults = await injectAs(app, userId, {
      method: "GET",
      url: `/resumes/${second.id}/results`,
    });
    expect((firstResults.json() as GetResumeResultsResponse).results.map((x) => x.jobId)).toEqual([
      firstJob,
    ]);
    expect((secondResults.json() as GetResumeResultsResponse).results.map((x) => x.jobId)).toEqual([
      secondJob,
    ]);
  });

  it("cannot edit ANOTHER user's resume via a crafted id -- 404, and that row is untouched", async () => {
    const app = buildTestApp();
    const userA = randomUUID();
    const userB = randomUUID();
    const textA = `User A private text ${randomUUID()}`;
    const { id: resumeA } = await createResume(app, textA, userA);

    const attempt = await injectAs(app, userB, {
      method: "PUT",
      url: `/resumes/${resumeA}/text`,
      payload: { resumeText: "user B's overwrite attempt" },
    });

    // 404, never 403 -- same convention every by-id route here uses, so a
    // caller cannot distinguish "not yours" from "never existed".
    expect(attempt.statusCode).toBe(404);
    // Ticket 3fc1e5e's audit found exactly this class of bug in the rename
    // path, where a check and an UPDATE disagreed about whose row was being
    // changed. So assert the ROW, not just the status code.
    const row = await db.select().from(resumes).where(eq(resumes.id, resumeA));
    expect(row[0]?.resumeText).toBe(textA);
    expect(row[0]?.userId).toBe(userA);
  });

  it("404s for an unknown resume id rather than creating one", async () => {
    const app = buildTestApp();
    const unknownId = randomUUID();
    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${unknownId}/text`,
      payload: { resumeText: "text for a resume that does not exist" },
    });
    expect(response.statusCode).toBe(404);
    const rows = await db.select().from(resumes).where(eq(resumes.id, unknownId));
    expect(rows).toHaveLength(0);
  });

  it("rejects empty and whitespace-only text with 400, leaving the stored text alone", async () => {
    const app = buildTestApp();
    const text = `Validation resume ${randomUUID()}`;
    const { id } = await createResume(app, text);

    for (const payload of [{ resumeText: "" }, { resumeText: "   \n\t " }]) {
      const response = await app.inject({ method: "PUT", url: `/resumes/${id}/text`, payload });
      expect(response.statusCode).toBe(400);
    }
    const row = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(row[0]?.resumeText).toBe(text);
  });

  it("rejects text over the length ceiling with 400, not 500", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Length-ceiling resume ${randomUUID()}`);
    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: "x".repeat(200_001) },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain("200000");
  });

  it("rejects a non-string resumeText with 400 rather than coercing it", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Type-check resume ${randomUUID()}`);
    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: 42 },
    });
    expect(response.statusCode).toBe(400);
  });

  describe("suggestedTitles on a text change (ticket 6ba221e's recorded decision)", () => {
    it("re-infers from the NEW text and persists the result", async () => {
      const calls: string[] = [];
      const inferTitles = async (resumeText: string) => {
        calls.push(resumeText);
        return calls.length === 1 ? ["Technical Writer"] : ["Platform Engineer"];
      };
      const app = buildTestApp(inferTitles);
      const { id } = await createResume(app, `Titles original ${randomUUID()}`);
      expect(calls).toHaveLength(1);

      const edited = `Titles rewritten ${randomUUID()}`;
      const response = await app.inject({
        method: "PUT",
        url: `/resumes/${id}/text`,
        payload: { resumeText: edited },
      });

      // Inference ran AGAINST THE NEW TEXT -- the whole point. A handler
      // that re-inferred from the stale row would pass a call-count
      // assertion and fail this one.
      expect(calls).toHaveLength(2);
      expect(calls[1]).toBe(edited);
      expect((response.json() as UpdateResumeTextResponse).suggestedTitles).toEqual([
        "Platform Engineer",
      ]);
      // Cached on the row, so the chips the user sees next time come from
      // the edited text rather than re-paying or reverting.
      const row = await db.select().from(resumes).where(eq(resumes.id, id));
      expect(row[0]?.suggestedTitles).toEqual(["Platform Engineer"]);
    });

    it("does NOT re-infer (and spends nothing) when the saved text is unchanged", async () => {
      let calls = 0;
      const inferTitles = async () => {
        calls++;
        return ["Software Engineer"];
      };
      const app = buildTestApp(inferTitles);
      const text = `Unchanged-save resume ${randomUUID()}`;
      const { id } = await createResume(app, text);
      expect(calls).toBe(1);

      const response = await app.inject({
        method: "PUT",
        url: `/resumes/${id}/text`,
        payload: { resumeText: text },
      });

      expect(response.statusCode).toBe(200);
      // The cost control: a save with nothing changed, or a double-click
      // on Save, must not be billable.
      expect(calls).toBe(1);
      const body = response.json() as UpdateResumeTextResponse;
      expect(body.suggestedTitles).toEqual(["Software Engineer"]);
      const row = await db.select().from(resumes).where(eq(resumes.id, id));
      expect(row[0]?.suggestedTitles).toEqual(["Software Engineer"]);
    });

    it("stores NULL (not []) when inference fails after an edit, so a later attempt can still retry", async () => {
      let shouldThrow = false;
      const inferTitles = async (): Promise<string[]> => {
        if (shouldThrow) throw new Error("simulated inference failure");
        return ["Initial Title"];
      };
      const app = buildTestApp(inferTitles);
      const { id } = await createResume(app, `Inference-failure resume ${randomUUID()}`);

      shouldThrow = true;
      const response = await app.inject({
        method: "PUT",
        url: `/resumes/${id}/text`,
        payload: { resumeText: `Inference-failure rewritten ${randomUUID()}` },
      });

      // The EDIT still succeeds -- the text is what the user asked for.
      expect(response.statusCode).toBe(200);
      expect((response.json() as UpdateResumeTextResponse).suggestedTitles).toEqual([]);
      // But the row records "not inferred yet", NOT an authoritative
      // empty list: ticket 82ae975 fixed `[]` being cached forever behind
      // a `suggestedTitles === null` retry gate on the OTHER write path
      // (`POST /resumes`) specifically by matching the choice this write
      // path already made.
      const row = await db.select().from(resumes).where(eq(resumes.id, id));
      expect(row[0]?.suggestedTitles).toBeNull();
    });

    /**
     * Fable review of 6ba221e, F5b: two overlapping edits of the SAME
     * resume must not leave it wearing the LOSER's chips.
     *
     * The window is real because inference is a network call to Claude: the
     * handler writes text+hash, awaits `inferTitles`, then writes the
     * titles. A second PUT landing inside that await replaces the text, and
     * an unguarded follow-up write would then attach the first request's
     * titles to the second request's text -- titles describing text that is
     * not there, which is precisely what re-inferring on edit exists to
     * prevent.
     *
     * The interleaving is FORCED, not hoped for: `inferTitles` blocks on a
     * promise this test resolves by hand, so the ordering is deterministic
     * and this cannot be a flaky race. Pool-backed for the same reason the
     * concurrency test below is (see `createPooledTestDatabase`).
     */
    it("a slow edit's titles do not overwrite a later edit's -- the follow-up write is hash-guarded", async () => {
      const pooled = createPooledTestDatabase(testDb.testDbName);
      try {
        // Two hand-held promises: one the test awaits to know the first
        // edit has reached `inferTitles`, one the first edit awaits so the
        // test decides when it may finish.
        let announceEntered: () => void = () => {};
        const firstEntered = new Promise<void>((resolve) => {
          announceEntered = resolve;
        });
        let releaseFirst: () => void = () => {};
        const firstMayFinish = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const inferTitles = async (resumeText: string): Promise<string[]> => {
          if (resumeText.endsWith("FIRST EDIT")) {
            announceEntered();
            await firstMayFinish;
            return ["Titles From The First Edit"];
          }
          if (resumeText.endsWith("SECOND EDIT")) return ["Titles From The Second Edit"];
          return [];
        };
        const app = buildApp({
          db: pooled.db,
          getScoreJob: () => {
            throw new Error("not used by these tests");
          },
          inferTitles,
        });
        const base = `Overlapping edits resume ${randomUUID()}`;
        const created = await app.inject({
          method: "POST",
          url: "/resumes",
          payload: { resumeText: base },
        });
        const { id } = created.json() as CreateResumeResponse;

        // First edit starts and parks inside `inferTitles`.
        const first = app.inject({
          method: "PUT",
          url: `/resumes/${id}/text`,
          payload: { resumeText: `${base} FIRST EDIT` },
        });
        await firstEntered;

        // Second edit runs to completion WHILE the first is parked.
        const second = await app.inject({
          method: "PUT",
          url: `/resumes/${id}/text`,
          payload: { resumeText: `${base} SECOND EDIT` },
        });
        expect(second.statusCode).toBe(200);

        releaseFirst();
        expect((await first).statusCode).toBe(200);

        // The row keeps the LAST text to land and ITS titles. Without the
        // `eq(resumes.resumeHash, ...)` guard on the follow-up write, the
        // first edit's titles land here instead -- describing text the row
        // no longer holds.
        const row = await db.select().from(resumes).where(eq(resumes.id, id));
        expect(row[0]?.resumeText).toBe(`${base} SECOND EDIT`);
        expect(row[0]?.suggestedTitles).toEqual(["Titles From The Second Edit"]);
      } finally {
        await pooled.close();
      }
    });
  });

  // Ticket 88f11d7 locks a resume on its first REAL search, and the SEARCH
  // page honors that (its collapsed bar offers "Change", never "Edit").
  // This endpoint deliberately does not, per this ticket's own recorded
  // decision -- Nicole: "I'm confident that I want that text editable,
  // even if it makes things not true anymore... already previously
  // searched things." Asserted so the decision is a tested behavior rather
  // than a comment someone later "fixes".
  it("permits editing a LOCKED resume's text, and reports it as still locked", async () => {
    const app = buildTestApp();
    const { id } = await createResume(app, `Locked resume ${randomUUID()}`);
    await db.insert(searches).values({
      id: randomUUID(),
      resumeId: id,
      searchedAt: new Date(),
      status: "complete",
      isEstimate: false,
    });

    const edited = `Locked resume rewritten ${randomUUID()}`;
    const response = await app.inject({
      method: "PUT",
      url: `/resumes/${id}/text`,
      payload: { resumeText: edited },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as UpdateResumeTextResponse;
    expect(body.isLocked).toBe(true);
    const row = await db.select().from(resumes).where(eq(resumes.id, id));
    expect(row[0]?.resumeText).toBe(edited);
  });

  /**
   * CONCURRENT SUBMISSION OF IDENTICAL TEXT (ticket 6ba221e required this
   * to be established, not assumed).
   *
   * Dropping `unique(user_id, resume_hash)` took the race-free upsert with
   * it: `getOrCreateResumeId` is a SELECT-then-INSERT now, so two
   * simultaneous POSTs of the same text can both miss the SELECT and both
   * insert. Two rows is the ACCEPTED outcome under the new rules -- what
   * must not happen is an ERROR (which is exactly what would happen if the
   * old `ON CONFLICT (user_id, resume_hash)` had been left in place: a
   * conflict target with no matching index raises SQLSTATE 42P10).
   *
   * Runs on a real connection POOL, not this file's shared single client:
   * a single `pg.Client` is one session and serializes everything through
   * it, so a concurrency test written against it cannot tell a correct
   * implementation from a broken one (see `createPooledTestDatabase`'s own
   * doc comment). The assertion is deliberately written to accept EITHER
   * outcome (one row or two), because which one happens depends on real
   * interleaving -- asserting a specific count would be a flaky test
   * asserting something this ticket does not promise.
   */
  it("does not error when identical text is submitted twice concurrently", async () => {
    const pooled = createPooledTestDatabase(testDb.testDbName);
    try {
      const app = buildApp({
        db: pooled.db,
        getScoreJob: () => {
          throw new Error("not used by these tests");
        },
        inferTitles: async () => [],
      });
      const userId = randomUUID();
      const resumeText = `Concurrent identical text ${randomUUID()}`;

      const [a, b] = await Promise.all([
        injectAs(app, userId, { method: "POST", url: "/resumes", payload: { resumeText } }),
        injectAs(app, userId, { method: "POST", url: "/resumes", payload: { resumeText } }),
      ]);

      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);

      const rows = await db
        .select()
        .from(resumes)
        .where(and(eq(resumes.userId, userId), eq(resumes.resumeText, resumeText)));
      // One (one request won the SELECT race) or two (both missed it) --
      // both are legal. Never zero, and never an error.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.length).toBeLessThanOrEqual(2);
      // Every id either response handed back is a real, readable row --
      // the thing a caller actually depends on.
      const ids = new Set(rows.map((r) => r.id));
      for (const response of [a, b]) {
        expect(ids.has((response.json() as CreateResumeResponse).id)).toBe(true);
      }
    } finally {
      await pooled.close();
    }
  });
});

describe("GET /resumes/:id/results", () => {
  async function seedScoredJob(
    resumeId: string,
    matchScore: number,
    title: string,
    // Ticket b182bde: optional, defaults to `undefined` (drizzle writes
    // `NULL`) so every EXISTING call site — none of which cares about level
    // fit — keeps compiling and keeps writing an unjudged row, exactly as
    // before this ticket.
    levelFit?: "underqualified" | "well_matched" | "overqualified",
    levelFitNote?: string,
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `results-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title,
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
      levelFit,
      levelFitNote,
    });
    return jobId;
  }

  // Ticket 38a7598: originally carried ONLY at the top level, alongside
  // `resumeId`. Review fix, same ticket: kept at the top level for
  // convenience/back-compat (this lookup already runs to 404-check
  // `resumeId`), but no longer the canonical source -- see the next test.
  it("carries the resume's real nickname at the top level of the response", async () => {
    const app = buildTestApp();
    const resumeText = `Nickname-in-results resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id: resumeId, resumeNickname } = created.json() as CreateResumeResponse;

    await seedScoredJob(resumeId, 80, "Some job");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { resumeNickname: string };
    expect(body.resumeNickname).toBe(resumeNickname);
    expect(body.resumeNickname).toMatch(/^Resume \d+$/);
  });

  // Ticket 38a7598 review fix: EACH result now carries its own
  // `resumeNickname` too (joined against `resumes` in the query), not just
  // the top-level response field -- this is what `ResultCard.tsx` actually
  // reads now. Today this route is scoped to one `resumeId`, so every row's
  // value is identical to the top-level one, but the join itself (not a
  // value copied from the top-level lookup) is what the next ticket
  // (3f0883f, spanning multiple resumes at once) will depend on being
  // correct.
  it("carries the resume's real nickname on EACH individual result too, not only at the top level", async () => {
    const app = buildTestApp();
    const resumeText = `Per-result nickname resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const { id: resumeId, resumeNickname } = created.json() as CreateResumeResponse;

    await seedScoredJob(resumeId, 80, "Some job");
    await seedScoredJob(resumeId, 70, "Another job");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<{ resumeNickname: string }> };
    expect(body.results).toHaveLength(2);
    for (const result of body.results) {
      expect(result.resumeNickname).toBe(resumeNickname);
    }
  });

  // Ticket 38a7598 review fix: proves a rename on one resume never leaks
  // into a DIFFERENT resume's own results. NOTE (opus re-review, round 2):
  // this does NOT distinguish a real per-row JOIN from the top-level
  // lookup's value copied onto every row -- both queries here are scoped
  // to a single resumeId, so that distinction only becomes observable
  // once results can span multiple resumes at once (ticket 3f0883f).
  it("a rename on one resume never bleeds into a different resume's per-result nicknames", async () => {
    const app = buildTestApp();
    const firstCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `First resume ${randomUUID()}` },
    });
    const { id: firstResumeId } = firstCreated.json() as CreateResumeResponse;
    const secondCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Second resume ${randomUUID()}` },
    });
    const { id: secondResumeId, resumeNickname: secondNickname } =
      secondCreated.json() as CreateResumeResponse;

    await seedScoredJob(firstResumeId, 80, "Job scored against the first resume");
    await seedScoredJob(secondResumeId, 75, "Job scored against the second resume");

    await app.inject({
      method: "PATCH",
      url: `/resumes/${firstResumeId}`,
      payload: { resumeNickname: "Renamed first resume" },
    });

    const secondResults = await app.inject({
      method: "GET",
      url: `/resumes/${secondResumeId}/results`,
    });
    const secondBody = secondResults.json() as { results: Array<{ resumeNickname: string }> };
    expect(secondBody.results[0]?.resumeNickname).toBe(secondNickname);
    expect(secondBody.results[0]?.resumeNickname).not.toBe("Renamed first resume");
  });

  it("returns scored jobs best match first, and applies a minScore floor with a hidden count", async () => {
    const app = buildTestApp();
    const resumeText = `Results resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedScoredJob(resumeId, 90, "High match");
    await seedScoredJob(resumeId, 60, "Mid match");
    await seedScoredJob(resumeId, 30, "Low match");

    const all = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as {
      results: Array<{ matchScore: number }>;
      hiddenBelowFloor?: number;
    };
    expect(allBody.results.map((r) => r.matchScore)).toEqual([90, 60, 30]);
    expect(allBody.hiddenBelowFloor).toBeUndefined();

    const floored = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?minScore=55`,
    });
    expect(floored.statusCode).toBe(200);
    const flooredBody = floored.json() as {
      results: Array<{ matchScore: number }>;
      hiddenBelowFloor: number;
    };
    expect(flooredBody.results.map((r) => r.matchScore)).toEqual([90, 60]);
    expect(flooredBody.hiddenBelowFloor).toBe(1);
  });

  it("filters by source", async () => {
    const app = buildTestApp();
    const resumeText = `Source-filter resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedScoredJob(resumeId, 70, "Matches source");

    const matching = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=${DATA_SOURCE}`,
    });
    expect((matching.json() as { results: unknown[] }).results).toHaveLength(1);

    // A real, known source id with no matching rows for this resume is a
    // valid, honest "empty" result (200) — distinct from an unrecognized
    // source id, which the next test covers.
    const nonMatching = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=${OTHER_REAL_DATA_SOURCE}`,
    });
    expect(nonMatching.statusCode).toBe(200);
    expect((nonMatching.json() as { results: unknown[] }).results).toHaveLength(0);
  });

  it("400s on an unrecognized source id rather than silently returning empty", async () => {
    const app = buildTestApp();
    const resumeText = `Unknown-source resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?source=not-a-real-source`,
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s for an unknown resume id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist/results" });
    expect(response.statusCode).toBe(404);
  });

  it("400s on an unrecognized status value", async () => {
    const app = buildTestApp();
    const resumeText = `Bad status resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?status=not-a-real-status`,
    });
    expect(response.statusCode).toBe(400);
  });

  it(
    "includes each job's status, excludes dismissed by default, and shows them again for " +
      "?status=dismissed (ticket 484889d, 0c319b2 now merged)",
    async () => {
      const app = buildTestApp();
      const resumeText = `Status-view resume ${randomUUID()}`;
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const resumeId = (created.json() as { id: string }).id;

      const untouchedId = await seedScoredJob(resumeId, 80, "Untouched job");
      const savedId = await seedScoredJob(resumeId, 75, "Saved job");
      const dismissedId = await seedScoredJob(resumeId, 70, "Dismissed job");

      await db.insert(userJobStatuses).values([
        {
          id: randomUUID(),
          userId: DEFAULT_TEST_USER_ID,
          jobId: savedId,
          status: "saved",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
          userId: DEFAULT_TEST_USER_ID,
          jobId: dismissedId,
          status: "dismissed",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const byId = (results: Array<{ jobId: string; status: string | null }>) =>
        new Map(results.map((r) => [r.jobId, r.status]));

      const defaultView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results`,
      });
      expect(defaultView.statusCode).toBe(200);
      const defaultBody = defaultView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      const defaultStatuses = byId(defaultBody.results);
      expect(defaultStatuses.get(untouchedId)).toBeNull();
      expect(defaultStatuses.get(savedId)).toBe("saved");
      // Decision #2 (git-bug 484889d): a dismissed job leaves the visible
      // (default) list.
      expect(defaultStatuses.has(dismissedId)).toBe(false);

      const dismissedView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results?status=dismissed`,
      });
      const dismissedBody = dismissedView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      expect(byId(dismissedBody.results).get(dismissedId)).toBe("dismissed");
      expect(dismissedBody.results).toHaveLength(1);
    },
  );

  it(
    "?includeDismissed=true returns every status (including dismissed) in one view, without " +
      "changing the default (ticket bec2f98)",
    async () => {
      const app = buildTestApp();
      const resumeText = `Include-dismissed resume ${randomUUID()}`;
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const resumeId = (created.json() as { id: string }).id;

      const untouchedId = await seedScoredJob(resumeId, 80, "Untouched job");
      const savedId = await seedScoredJob(resumeId, 75, "Saved job");
      const dismissedId = await seedScoredJob(resumeId, 70, "Dismissed job");

      await db.insert(userJobStatuses).values([
        {
          id: randomUUID(),
          userId: DEFAULT_TEST_USER_ID,
          jobId: savedId,
          status: "saved",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
          userId: DEFAULT_TEST_USER_ID,
          jobId: dismissedId,
          status: "dismissed",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const byId = (results: Array<{ jobId: string; status: string | null }>) =>
        new Map(results.map((r) => [r.jobId, r.status]));

      // The existing default view is untouched by this ticket -- still
      // excludes the dismissed job.
      const defaultView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results`,
      });
      const defaultBody = defaultView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      expect(byId(defaultBody.results).has(dismissedId)).toBe(false);

      const includeDismissedView = await app.inject({
        method: "GET",
        url: `/resumes/${resumeId}/results?includeDismissed=true`,
      });
      expect(includeDismissedView.statusCode).toBe(200);
      const includeDismissedBody = includeDismissedView.json() as {
        results: Array<{ jobId: string; status: string | null }>;
      };
      const statuses = byId(includeDismissedBody.results);
      expect(statuses.get(untouchedId)).toBeNull();
      expect(statuses.get(savedId)).toBe("saved");
      expect(statuses.get(dismissedId)).toBe("dismissed");
      expect(includeDismissedBody.results).toHaveLength(3);
    },
  );

  it("an explicit ?status= still wins over ?includeDismissed=true (single-status filter, not a union)", async () => {
    const app = buildTestApp();
    const resumeText = `Status-wins-over-include-dismissed resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const savedId = await seedScoredJob(resumeId, 75, "Saved job");
    const dismissedId = await seedScoredJob(resumeId, 70, "Dismissed job");

    await db.insert(userJobStatuses).values([
      {
        id: randomUUID(),
        userId: DEFAULT_TEST_USER_ID,
        jobId: savedId,
        status: "saved",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        userId: DEFAULT_TEST_USER_ID,
        jobId: dismissedId,
        status: "dismissed",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?status=saved&includeDismissed=true`,
    });
    const body = response.json() as { results: Array<{ jobId: string }> };
    expect(body.results.map((r) => r.jobId)).toEqual([savedId]);
  });

  it("rejects a non-numeric minScore with 400, not 500", async () => {
    const app = buildTestApp();
    const resumeText = `Bad minScore resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?minScore=not-a-number`,
    });
    expect(response.statusCode).toBe(400);
  });

  // Ticket b182bde: `levelFit`/`levelFitNote` come straight off `job_matches`
  // with no coercion — unlike strengths/gaps, a legacy row's `null` must
  // stay `null` (never defaulted to "well_matched", which would fabricate a
  // claim the model never made).
  it("returns levelFit/levelFitNote null (not coerced to well_matched or []) for a legacy row never judged for level fit", async () => {
    const app = buildTestApp();
    const resumeText = `Legacy level-fit resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedScoredJob(resumeId, 80, "Never judged for level fit");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as {
      results: Array<{ levelFit: string | null; levelFitNote: string | null }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]?.levelFit).toBeNull();
    expect(body.results[0]?.levelFitNote).toBeNull();
  });

  it("returns a real levelFit/levelFitNote when the row was judged", async () => {
    const app = buildTestApp();
    const resumeText = `Judged level-fit resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedScoredJob(
      resumeId,
      78,
      "Overqualified job",
      "overqualified",
      "This posting asks for 1.5-2 years; you have far more.",
    );

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as {
      results: Array<{ levelFit: string | null; levelFitNote: string | null }>;
    };
    expect(body.results[0]?.levelFit).toBe("overqualified");
    expect(body.results[0]?.levelFitNote).toBe(
      "This posting asks for 1.5-2 years; you have far more.",
    );
  });
});

// Ticket b182bde: `ORDER BY match_score DESC, level_fit_rank ASC, job_id
// ASC`. The whole point of these tests is the two guarantees git-bug
// b182bde's acceptance criteria call out by name: level fit is a TIEBREAK
// ONLY (never overrides a strictly higher matchScore), and the tiebreak
// order itself (well_matched, then null/unjudged, then underqualified, then
// overqualified) is real and deterministic.
describe("GET /resumes/:id/results — level fit tiebreak (ticket b182bde)", () => {
  async function seedScoredJob(
    resumeId: string,
    matchScore: number,
    title: string,
    levelFit?: "underqualified" | "well_matched" | "overqualified",
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `tiebreak-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title,
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
      levelFit,
    });
    return jobId;
  }

  it(
    "same matchScore, different levelFit: well_matched, then null (unjudged), then " +
      "underqualified, then overqualified",
    async () => {
      const app = buildTestApp();
      const resumeText = `Tiebreak resume ${randomUUID()}`;
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const resumeId = (created.json() as { id: string }).id;

      // Seeded deliberately out of the expected order, so a passing test
      // proves the database is doing the ordering, not fixture insertion
      // order happening to already match it.
      await seedScoredJob(resumeId, 60, "Overqualified", "overqualified");
      await seedScoredJob(resumeId, 60, "Underqualified", "underqualified");
      await seedScoredJob(resumeId, 60, "Never judged");
      await seedScoredJob(resumeId, 60, "Well matched", "well_matched");

      const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
      const body = response.json() as { results: Array<{ title: string }> };
      expect(body.results.map((r) => r.title)).toEqual([
        "Well matched",
        "Never judged",
        "Underqualified",
        "Overqualified",
      ]);
    },
  );

  it(
    "NEVER downranks a higher-scoring overqualified job below a lower-scoring well_matched job " +
      "-- the core 'never hide/downrank overqualified' guarantee, shaped like Nicole's own real " +
      "applied-to postings (high score + leveling mismatch)",
    async () => {
      const app = buildTestApp();
      const resumeText = `Never-downrank resume ${randomUUID()}`;
      const created = await app.inject({
        method: "POST",
        url: "/resumes",
        payload: { resumeText },
      });
      const resumeId = (created.json() as { id: string }).id;

      // Shaped like the real evidence in git-bug b182bde's Context: Samsara
      // SWE II scored 78% and Smartsheet SWE II scored 58%, both flagged
      // overqualified. A well_matched job at a LOWER score must still rank
      // BELOW both of them -- the tiebreak must never win over the primary
      // score sort.
      await seedScoredJob(
        resumeId,
        78,
        "Samsara SWE II (overqualified, high score)",
        "overqualified",
      );
      await seedScoredJob(
        resumeId,
        58,
        "Smartsheet SWE II (overqualified, mid score)",
        "overqualified",
      );
      await seedScoredJob(resumeId, 65, "Well-matched but lower than Samsara", "well_matched");

      const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
      const body = response.json() as { results: Array<{ title: string; matchScore: number }> };

      // Pure score order: 78, then 65, then 58 -- levelFit never moves the
      // 78% overqualified job behind the 65% well_matched job, and never
      // moves the 65% well_matched job behind the 58% overqualified job.
      expect(body.results.map((r) => r.matchScore)).toEqual([78, 65, 58]);
      expect(body.results.map((r) => r.title)).toEqual([
        "Samsara SWE II (overqualified, high score)",
        "Well-matched but lower than Samsara",
        "Smartsheet SWE II (overqualified, mid score)",
      ]);
    },
  );

  it("job_id ASC makes ties within the same (matchScore, levelFit) pair fully deterministic", async () => {
    const app = buildTestApp();
    const resumeText = `Deterministic-tie resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const idA = await seedScoredJob(resumeId, 60, "Tie A", "well_matched");
    const idB = await seedScoredJob(resumeId, 60, "Tie B", "well_matched");
    const expectedOrder = [idA, idB].sort();

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<{ jobId: string }> };
    expect(body.results.map((r) => r.jobId)).toEqual(expectedOrder);
  });
});

// Ticket 8f5a79c: `isContractOrTemp` is a derived signal, computed at read
// time from the job's own `title`/`commitment` (never its own DB column —
// see ScoredJobResult's doc comment for why). Exercised end to end here
// through the real route, not just against `looksLikeContractOrTemp`
// directly (swe-filter.test.ts already covers that unit in isolation), so
// the wiring from `jobs.commitment`/`jobs.title` through the SELECT and into
// the wire response is proven, not just the helper function itself.
describe("GET /resumes/:id/results — isContractOrTemp (ticket 8f5a79c)", () => {
  async function seedJob(
    resumeId: string,
    title: string,
    commitment?: "full-time" | "part-time" | "contract",
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `contract-signal-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title,
      description: "a job description",
      company: "Test Co",
      commitment,
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore: 80,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
    });
    return jobId;
  }

  it('true when the job\'s structured commitment is "contract", even for an ordinary-sounding title', async () => {
    const app = buildTestApp();
    const resumeText = `Contract commitment resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedJob(resumeId, "Backend Software Engineer", "contract");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<{ isContractOrTemp: boolean }> };
    expect(body.results[0]?.isContractOrTemp).toBe(true);
  });

  it("true from title phrasing alone when commitment is absent (e.g. Greenhouse, which never populates commitment at all)", async () => {
    const app = buildTestApp();
    const resumeText = `Contract title resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedJob(resumeId, "Software Engineer (Contract)");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<{ isContractOrTemp: boolean }> };
    expect(body.results[0]?.isContractOrTemp).toBe(true);
  });

  it("false for an ordinary full-time posting with neither signal present", async () => {
    const app = buildTestApp();
    const resumeText = `Ordinary posting resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedJob(resumeId, "Backend Software Engineer", "full-time");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<{ isContractOrTemp: boolean }> };
    expect(body.results[0]?.isContractOrTemp).toBe(false);
  });

  it("does not leak the raw commitment field onto the wire — isContractOrTemp is the only signal exposed", async () => {
    const app = buildTestApp();
    const resumeText = `No commitment leak resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedJob(resumeId, "Backend Software Engineer", "contract");

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    const body = response.json() as { results: Array<Record<string, unknown>> };
    expect(body.results[0]).not.toHaveProperty("commitment");
  });
});

// Ticket 3f0883f (Nicole: "users should see every job that they've ever
// applied for and which resume they used to search" -- "Already Scored
// Jobs" is meant to be the browsable history, silently narrowed to one
// resume today only because every results query happened to be scoped that
// way, not by deliberate design). `GET /resumes/:id/results` above already
// established the per-row `resumeNickname` JOIN this route reuses via
// `fetchScoredResults` -- these tests are the ones that comment at line
// ~452 above says become meaningful once results can genuinely span more
// than one resume.
describe("GET /results (ticket 3f0883f)", () => {
  async function seedJobRow(title: string): Promise<string> {
    const jobId = randomUUID();
    await db.insert(jobsTable).values({
      id: jobId,
      externalId: `all-results-test-${jobId}`,
      dataSource: DATA_SOURCE,
      title,
      description: "a job description",
      company: "Test Co",
      linkToApply: `https://example.com/${jobId}`,
      postedAt: new Date("2026-01-01T00:00:00Z"),
    });
    return jobId;
  }

  async function seedMatch(resumeId: string, jobId: string, matchScore: number): Promise<void> {
    await db.insert(jobMatches).values({
      id: randomUUID(),
      resumeId,
      jobId,
      matchScore,
      rationale: "fake rationale",
      strengths: [],
      gaps: [],
    });
  }

  // Ticket c434a6e: this whole FILE shares one test database, seeded
  // across every describe block above with no truncation between tests --
  // so unlike `GET /resumes/:id/results` (which every other test scopes
  // to a resumeId it just created), a bare `GET /results` genuinely
  // returns every job_matches row every earlier test in this file has
  // ever inserted. Every assertion below is written to be robust to that:
  // filtering `body.results` down to just the fixtures THIS test created
  // before asserting on it, or asserting presence/absence of a specific
  // (randomUUID-unique) jobId rather than an exact total count.

  it("never 404s, unlike the single-resume route -- there is no single resource to 404 on", async () => {
    const app = buildTestApp();

    const response = await app.inject({ method: "GET", url: "/results" });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: unknown[] };
    expect(Array.isArray(body.results)).toBe(true);
  });

  it("returns job_matches rows from every resume, not just one -- and each row carries the resume it was actually scored against", async () => {
    const app = buildTestApp();
    const firstCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `First cross-resume text ${randomUUID()}` },
    });
    const { id: firstResumeId, resumeNickname: firstNickname } =
      firstCreated.json() as CreateResumeResponse;
    const secondCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Second cross-resume text ${randomUUID()}` },
    });
    const { id: secondResumeId, resumeNickname: secondNickname } =
      secondCreated.json() as CreateResumeResponse;
    // Two genuinely different resumeTexts, so `getOrCreateResumeId`'s hash
    // lookup misses and each POST creates its own row.
    expect(firstResumeId).not.toBe(secondResumeId);

    const jobUnderFirst = await seedJobRow("Job only the first resume ever saw");
    const jobUnderSecond = await seedJobRow("Job only the second resume ever saw");
    await seedMatch(firstResumeId, jobUnderFirst, 80);
    await seedMatch(secondResumeId, jobUnderSecond, 70);

    const response = await app.inject({ method: "GET", url: "/results" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: Array<{ jobId: string; resumeId: string; resumeNickname: string }>;
    };

    // Scoped to exactly the two (randomUUID-unique) jobIds this test just
    // created -- a bare length assertion on the full array would break the
    // moment any earlier test in this file has also scored something.
    const byJobId = new Map(
      body.results
        .filter((r) => r.jobId === jobUnderFirst || r.jobId === jobUnderSecond)
        .map((r) => [r.jobId, r]),
    );
    expect(byJobId.size).toBe(2);
    expect(byJobId.get(jobUnderFirst)).toMatchObject({
      resumeId: firstResumeId,
      resumeNickname: firstNickname,
    });
    expect(byJobId.get(jobUnderSecond)).toMatchObject({
      resumeId: secondResumeId,
      resumeNickname: secondNickname,
    });
  });

  // The core acceptance criterion this ticket exists for: the SAME real
  // posting, scored under two different resumes, is two distinct
  // judgments (two different scores are entirely plausible -- a resume
  // tailored one way fits differently than one tailored another), and
  // both must survive as separate, correctly-labeled rows -- never merged
  // or deduplicated down to one just because `jobId` repeats.
  it("the SAME job posting scored under two different resumes appears as two separate, correctly-labeled results -- not merged or deduplicated", async () => {
    const app = buildTestApp();
    const firstCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Backend-flavored resume ${randomUUID()}` },
    });
    const { id: firstResumeId, resumeNickname: firstNickname } =
      firstCreated.json() as CreateResumeResponse;
    const secondCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Frontend-flavored resume ${randomUUID()}` },
    });
    const { id: secondResumeId, resumeNickname: secondNickname } =
      secondCreated.json() as CreateResumeResponse;
    expect(firstResumeId).not.toBe(secondResumeId);
    expect(firstNickname).not.toBe(secondNickname);

    const sharedJobId = await seedJobRow("Full-Stack Engineer (scored by both resumes)");
    // Two genuinely different judgments against the SAME posting -- this
    // is real and expected, not a bug: two different resumes produced two
    // different scores.
    await seedMatch(firstResumeId, sharedJobId, 85);
    await seedMatch(secondResumeId, sharedJobId, 55);

    const response = await app.inject({ method: "GET", url: "/results" });
    const body = response.json() as {
      results: Array<{
        jobId: string;
        resumeId: string;
        resumeNickname: string;
        matchScore: number;
      }>;
    };

    const rowsForThisJob = body.results.filter((r) => r.jobId === sharedJobId);
    expect(rowsForThisJob).toHaveLength(2);

    const byResumeId = new Map(rowsForThisJob.map((r) => [r.resumeId, r]));
    expect(byResumeId.get(firstResumeId)).toMatchObject({
      resumeNickname: firstNickname,
      matchScore: 85,
    });
    expect(byResumeId.get(secondResumeId)).toMatchObject({
      resumeNickname: secondNickname,
      matchScore: 55,
    });
  });

  it("applies the same minScore floor across every resume combined, not per-resume, and sums hiddenBelowFloor across all of them too", async () => {
    const app = buildTestApp();
    const firstCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Floor-test first resume ${randomUUID()}` },
    });
    const { id: firstResumeId } = firstCreated.json() as CreateResumeResponse;
    const secondCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Floor-test second resume ${randomUUID()}` },
    });
    const { id: secondResumeId } = secondCreated.json() as CreateResumeResponse;

    // Review round 1 finding (opus, BLOCKING): `hiddenBelowFloor` on this
    // route was entirely unguarded -- a mutation hard-coding it to 0 for
    // every cross-resume request passed the full suite. `hiddenBelowFloor`
    // is a GLOBAL count across this file's whole shared test database (no
    // resumeId to scope it by), so -- same reasoning as the jobId
    // presence/absence checks below -- this asserts the DELTA this test's
    // own fixtures contribute, not an absolute value other tests' rows
    // would make flaky.
    const beforeFloored = await app.inject({ method: "GET", url: "/results?minScore=55" });
    const hiddenBefore =
      (beforeFloored.json() as { hiddenBelowFloor?: number }).hiddenBelowFloor ?? 0;

    const highFirst = await seedJobRow("High match, first resume");
    const lowFirst = await seedJobRow("Low match, first resume");
    const highSecond = await seedJobRow("High match, second resume");
    const lowSecond = await seedJobRow("Low match, second resume");
    await seedMatch(firstResumeId, highFirst, 90);
    await seedMatch(firstResumeId, lowFirst, 20);
    await seedMatch(secondResumeId, highSecond, 80);
    await seedMatch(secondResumeId, lowSecond, 10);

    const floored = await app.inject({ method: "GET", url: "/results?minScore=55" });
    expect(floored.statusCode).toBe(200);
    const body = floored.json() as {
      results: Array<{ jobId: string; matchScore: number }>;
      hiddenBelowFloor?: number;
    };
    const jobIds = new Set(body.results.map((r) => r.jobId));

    // Both above-floor rows come back, from BOTH resumes -- the floor is
    // not accidentally scoping to whichever resume happened to be queried
    // first -- and both below-floor rows are correctly excluded, from
    // both resumes too. Presence/absence of these specific jobIds, not an
    // exact total count (this file's shared test database means other
    // tests' rows are in the same response).
    expect(jobIds.has(highFirst)).toBe(true);
    expect(jobIds.has(highSecond)).toBe(true);
    expect(jobIds.has(lowFirst)).toBe(false);
    expect(jobIds.has(lowSecond)).toBe(false);

    // This test's own two below-floor rows (one per resume) are exactly
    // what moved the count -- summed across BOTH resumes, not just one.
    const hiddenAfter = body.hiddenBelowFloor ?? 0;
    expect(hiddenAfter - hiddenBefore).toBe(2);
  });

  it("filters by source across every resume, same validation as the single-resume route", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Source-filter-all resume ${randomUUID()}` },
    });
    const { id: resumeId } = created.json() as CreateResumeResponse;
    const jobId = await seedJobRow("Matches the filtered source");
    await seedMatch(resumeId, jobId, 70);

    const unknownSource = await app.inject({ method: "GET", url: "/results?source=not-a-real-id" });
    expect(unknownSource.statusCode).toBe(400);

    const matching = await app.inject({ method: "GET", url: `/results?source=${DATA_SOURCE}` });
    expect(matching.statusCode).toBe(200);
    const matchingIds = new Set(
      (matching.json() as { results: Array<{ jobId: string }> }).results.map((r) => r.jobId),
    );
    expect(matchingIds.has(jobId)).toBe(true);

    const nonMatching = await app.inject({
      method: "GET",
      url: `/results?source=${OTHER_REAL_DATA_SOURCE}`,
    });
    expect(nonMatching.statusCode).toBe(200);
    const nonMatchingIds = new Set(
      (nonMatching.json() as { results: Array<{ jobId: string }> }).results.map((r) => r.jobId),
    );
    // `jobId` was seeded with DATA_SOURCE -- it must not leak into a
    // different source's filtered view, even though this shared test
    // database has plenty of other resumes' rows in it too.
    expect(nonMatchingIds.has(jobId)).toBe(false);
  });

  // Review round 1 (opus, minor): the default dismissed-exclusion has the
  // subtlest SQL of any filter this route shares with the single-resume
  // route (`isNull OR ne`, ticket 484889d) -- worth its own cross-resume
  // check, not just inherited confidence from the single-resume tests.
  it("the default dismissed-exclusion, and ?includeDismissed=true, both apply across every resume", async () => {
    const app = buildTestApp();
    const firstCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Status-filter-all first resume ${randomUUID()}` },
    });
    const { id: firstResumeId } = firstCreated.json() as CreateResumeResponse;
    const secondCreated = await app.inject({
      method: "POST",
      url: "/resumes",
      payload: { resumeText: `Status-filter-all second resume ${randomUUID()}` },
    });
    const { id: secondResumeId } = secondCreated.json() as CreateResumeResponse;

    const dismissedUnderFirst = await seedJobRow("Dismissed under the first resume");
    const dismissedUnderSecond = await seedJobRow("Dismissed under the second resume");
    await seedMatch(firstResumeId, dismissedUnderFirst, 70);
    await seedMatch(secondResumeId, dismissedUnderSecond, 65);
    await db.insert(userJobStatuses).values([
      {
        id: randomUUID(),
        userId: DEFAULT_TEST_USER_ID,
        jobId: dismissedUnderFirst,
        status: "dismissed",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        userId: DEFAULT_TEST_USER_ID,
        jobId: dismissedUnderSecond,
        status: "dismissed",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const defaultView = await app.inject({ method: "GET", url: "/results" });
    const defaultIds = new Set(
      (defaultView.json() as { results: Array<{ jobId: string }> }).results.map((r) => r.jobId),
    );
    // Dismissed under EITHER resume -- both excluded by default, not just
    // whichever resume this route happens to process first.
    expect(defaultIds.has(dismissedUnderFirst)).toBe(false);
    expect(defaultIds.has(dismissedUnderSecond)).toBe(false);

    const withDismissed = await app.inject({
      method: "GET",
      url: "/results?includeDismissed=true",
    });
    const withDismissedIds = new Set(
      (withDismissed.json() as { results: Array<{ jobId: string }> }).results.map((r) => r.jobId),
    );
    expect(withDismissedIds.has(dismissedUnderFirst)).toBe(true);
    expect(withDismissedIds.has(dismissedUnderSecond)).toBe(true);
  });
});

describe("GET /resumes/:id/results — server-side LIMIT (ticket e9a82f3)", () => {
  // Matches RESULTS_LIMIT in apps/api/src/routes/resumes.ts. Not imported
  // directly (that constant isn't exported -- it's route-internal), so this
  // is deliberately kept in sync by comment rather than by reference; a
  // change to the real constant without updating this one would make these
  // tests fail loudly (wrong truncation boundary), not pass silently.
  const RESULTS_LIMIT = 500;

  // Bulk insert (one multi-row VALUES statement per table) rather than
  // `RESULTS_LIMIT + 1` sequential `db.insert` round trips -- this test
  // seeds 501 rows, and one-at-a-time inserts would make the suite
  // noticeably slower for no benefit (nothing here depends on insert
  // order; `matchScore` is set per-row explicitly instead).
  async function seedManyScoredJobs(resumeId: string, count: number): Promise<void> {
    const jobRows = Array.from({ length: count }, (_, i) => {
      const jobId = randomUUID();
      return {
        id: jobId,
        externalId: `limit-test-${jobId}`,
        dataSource: DATA_SOURCE,
        title: `Bulk job ${i}`,
        description: "a job description",
        company: "Test Co",
        linkToApply: `https://example.com/${jobId}`,
        postedAt: new Date("2026-01-01T00:00:00Z"),
      };
    });
    await db.insert(jobsTable).values(jobRows);
    await db.insert(jobMatches).values(
      jobRows.map((job, i) => ({
        id: randomUUID(),
        resumeId,
        jobId: job.id,
        // Descending, distinct scores -- keeps `orderBy(matchScore DESC,
        // ...)` deterministic enough that "first RESULTS_LIMIT rows" is a
        // stable, well-defined set for the boundary test below.
        matchScore: count - i,
        rationale: "fake rationale",
        strengths: [],
        gaps: [],
      })),
    );
  }

  it("truncates to RESULTS_LIMIT and reports the true total via totalMatchingCount when rows exceed the limit", async () => {
    const app = buildTestApp();
    const resumeText = `Limit-truncation resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedManyScoredJobs(resumeId, RESULTS_LIMIT + 1);

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: Array<{ matchScore: number }>;
      totalMatchingCount?: number;
    };
    expect(body.results.length).toBe(RESULTS_LIMIT);
    expect(body.totalMatchingCount).toBe(RESULTS_LIMIT + 1);
    // The truncation drops the LOWEST-ranked row, not an arbitrary one --
    // still best-match-first, just capped.
    expect(body.results[body.results.length - 1]?.matchScore).toBe(2);
  });

  it("a matching count exactly AT the limit is not reported as truncated (boundary: > not >=)", async () => {
    const app = buildTestApp();
    const resumeText = `Limit-boundary resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedManyScoredJobs(resumeId, RESULTS_LIMIT);

    const response = await app.inject({ method: "GET", url: `/resumes/${resumeId}/results` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: unknown[];
      totalMatchingCount?: number;
    };
    expect(body.results.length).toBe(RESULTS_LIMIT);
    expect(body.totalMatchingCount).toBeUndefined();
  });

  it("GET /results (cross-resume) truncates and reports totalMatchingCount the same way", async () => {
    const app = buildTestApp();
    const resumeText = `Limit cross-resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    await seedManyScoredJobs(resumeId, RESULTS_LIMIT + 1);

    const response = await app.inject({ method: "GET", url: "/results" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: unknown[];
      totalMatchingCount?: number;
    };
    // This file shares one test database with no truncation between tests
    // (see the "GET /results" describe block's own comment above), so the
    // cross-resume total here is `>=` this test's own RESULTS_LIMIT + 1
    // fixtures, not necessarily exactly equal to them -- but it must still
    // be truncated and must still be internally consistent.
    expect(body.results.length).toBe(RESULTS_LIMIT);
    expect(body.totalMatchingCount).toBeGreaterThanOrEqual(RESULTS_LIMIT + 1);
  });

  // Opus review, round 1 (coverage gap A): the production `GET /results`
  // call (useAllResults.ts) always sends `minScore`, so `hiddenBelowFloor`
  // and `totalMatchingCount` are computed on every real request together --
  // no existing test pinned that they stay disjoint (each counting its own
  // set, neither double-counting the other) once both apply at once. If a
  // future change made `totalMatchingCount` floor-independent, this would
  // silently start claiming truncation included below-floor rows that no
  // user action can ever reach.
  it("hiddenBelowFloor and totalMatchingCount stay disjoint when both a minScore floor and truncation apply together", async () => {
    const app = buildTestApp();
    const resumeText = `Limit plus floor resume ${randomUUID()}`;
    const created = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const resumeId = (created.json() as { id: string }).id;

    const floor = 55; // MATCH_SCORE_FLOOR (packages/shared)
    const aboveFloorCount = RESULTS_LIMIT + 1; // forces truncation
    const belowFloorCount = 7; // arbitrary, distinct from any limit boundary

    async function seedAt(scores: number[]): Promise<void> {
      const jobRows = scores.map((_, i) => {
        const jobId = randomUUID();
        return {
          id: jobId,
          externalId: `limit-floor-test-${jobId}`,
          dataSource: DATA_SOURCE,
          title: `Floor+limit job ${i}`,
          description: "a job description",
          company: "Test Co",
          linkToApply: `https://example.com/${jobId}`,
          postedAt: new Date("2026-01-01T00:00:00Z"),
        };
      });
      await db.insert(jobsTable).values(jobRows);
      await db.insert(jobMatches).values(
        jobRows.map((job, i) => ({
          id: randomUUID(),
          resumeId,
          jobId: job.id,
          matchScore: scores[i]!,
          rationale: "fake rationale",
          strengths: [],
          gaps: [],
        })),
      );
    }

    // Scores strictly ABOVE the floor (56..56+aboveFloorCount-1) -- none of
    // these can be mistaken for a below-floor row.
    await seedAt(Array.from({ length: aboveFloorCount }, (_, i) => floor + 1 + i));
    // Scores strictly BELOW the floor (1..belowFloorCount).
    await seedAt(Array.from({ length: belowFloorCount }, (_, i) => i + 1));

    const response = await app.inject({
      method: "GET",
      url: `/resumes/${resumeId}/results?minScore=${floor}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: unknown[];
      totalMatchingCount?: number;
      hiddenBelowFloor?: number;
    };
    // Truncated to the limit, from the above-floor set only.
    expect(body.results.length).toBe(RESULTS_LIMIT);
    // The true above-floor total, not inflated by the below-floor rows.
    expect(body.totalMatchingCount).toBe(aboveFloorCount);
    // The below-floor count, not deflated by the truncation applied above.
    expect(body.hiddenBelowFloor).toBe(belowFloorCount);
  });
});
