import { randomUUID } from "node:crypto";
import type { CreateResumeResponse, UpdateResumeNicknameResponse } from "@app/shared";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../index.js";
import {
  jobMatches,
  jobs as jobsTable,
  resumes,
  sourceDescriptors,
  userJobStatuses,
} from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
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

    it("a resubmission of identical text returns the SAME existing nickname, not a fresh one", async () => {
      const app = buildTestApp();
      const resumeText = `Idempotent nickname resume ${randomUUID()}`;

      const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
      const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

      const firstNickname = (first.json() as CreateResumeResponse).resumeNickname;
      const secondNickname = (second.json() as CreateResumeResponse).resumeNickname;
      expect(secondNickname).toBe(firstNickname);
    });
  });

  it("is content-addressed: posting identical text twice returns the same id", async () => {
    const app = buildTestApp();
    const resumeText = `Repeated resume text ${randomUUID()}`;

    const first = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    const second = await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    const firstId = (first.json() as { id: string }).id;
    const secondId = (second.json() as { id: string }).id;
    expect(secondId).toBe(firstId);
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

  it("calls inferTitles at most once per resume: a resubmission of identical text reuses the cached suggestions", async () => {
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
    expect(body.suggestedTitles).toEqual([]);

    const rows = await db.select().from(resumes).where(eq(resumes.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resumeText).toBe(resumeText);
  });

  it("an empty inference result ([]) is itself cached, not retried on resubmission", async () => {
    let calls = 0;
    const inferTitles = async () => {
      calls++;
      return [];
    };
    const app = buildTestApp(inferTitles);
    const resumeText = `Resume text ${randomUUID()}`;

    await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });
    await app.inject({ method: "POST", url: "/resumes", payload: { resumeText } });

    expect(calls).toBe(1);
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
    expect(response.json()).toEqual({ id, resumeText, resumeNickname });
  });

  it("404s for an unknown id", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/resumes/does-not-exist" });
    expect(response.statusCode).toBe(404);
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
          jobId: savedId,
          status: "saved",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
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
          jobId: savedId,
          status: "saved",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: randomUUID(),
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
        jobId: savedId,
        status: "saved",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
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
    // Same content-addressed resume never collides with itself here --
    // these are two genuinely different resumeTexts, so two real rows.
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
        jobId: dismissedUnderFirst,
        status: "dismissed",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
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
});
