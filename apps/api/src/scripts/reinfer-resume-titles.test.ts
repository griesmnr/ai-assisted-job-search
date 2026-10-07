import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resumes, users } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  findCandidateResumes,
  parseArgs,
  runReinfer,
  titlesEqual,
} from "./reinfer-resume-titles.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("reinfer_resume_titles_test");
  db = testDb.db;
});

afterAll(async () => testDb?.teardown());

/**
 * Same no-network fake-client pattern resume-title-inference.test.ts and
 * demo-match.test.ts already establish for this codebase -- adapted here to
 * be KEYED BY RESUME TEXT, because `runReinfer` processes EVERY resume in
 * the WHOLE test database -- widened by ticket 82ae975, which made failures
 * persist `null` and so put them out of reach of the old non-null filter --
 * including ones a
 * PRIOR test in this same file left behind (nothing deletes rows between
 * tests, same shared-database shape `reassign-legacy-resumes.test.ts`
 * already lives with).
 *
 * Opus review, B2: an earlier version of this fake made an unrecognized
 * prompt's fallback a live DB lookup that echoed the resume's OWN stored
 * `suggestedTitles` back, reasoned as "guaranteed to compare equal and
 * therefore never written." That guarantee was false -- the echoed value
 * still passes through `inferTitleKeywords`'s real `splitConjoinedTitles`
 * step, which is NOT the identity function (`["Billing"]` -> `[]`,
 * `["Software Engineer, Microservices"]` -> `["Software Engineer"]`), so an
 * unrecognized leftover row with an unsplit-shaped stored value could still
 * come back different and get WRITTEN by a later `--live` test, corrupting
 * state an earlier test had already asserted on. This version instead
 * THROWS for anything unrecognized -- simulating a real API failure, the
 * exact scenario the runReinfer-level B1 fix now exists to handle safely
 * (an empty/failed result is skipped and reported, never compared or
 * written). A leftover row from an earlier test now provably cannot be
 * touched by a later test's run, and if a test's OWN target resume text
 * fails to match its own key, the test fails loudly (a thrown error
 * propagating out of `runReinfer`) instead of silently asserting on the
 * wrong thing.
 */
function makeKeyedAnthropicClient(responsesByTextSubstring: Record<string, string[]>): Anthropic {
  const fakeClient = {
    messages: {
      create: async (params: { messages: Array<{ content: string }> }) => {
        const prompt = params.messages[0]?.content ?? "";
        const match = Object.entries(responsesByTextSubstring).find(([key]) =>
          prompt.includes(key),
        );
        if (!match) {
          throw new Error(
            "makeKeyedAnthropicClient: no response configured for this prompt -- simulates a " +
              "real API failure for any resume this test doesn't explicitly target, which " +
              "runReinfer's own failure handling (opus review, B1) makes safe: the row is " +
              "skipped and reported, never written.",
          );
        }
        return { content: [{ type: "text", text: JSON.stringify({ titles: match[1] }) }] };
      },
    },
  };
  return fakeClient as unknown as Anthropic;
}

let userCounter = 0;
async function seedUser(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id });
  userCounter++;
  return id;
}

async function seedResume(
  userId: string,
  opts: { resumeText?: string; suggestedTitles: string[] | null },
): Promise<string> {
  const id = randomUUID();
  await db.insert(resumes).values({
    id,
    userId,
    resumeText: opts.resumeText ?? `Resume text ${randomUUID()}`,
    resumeHash: randomUUID(),
    resumeNickname: `Resume ${userCounter}-${id.slice(0, 8)}`,
    suggestedTitles: opts.suggestedTitles,
  });
  return id;
}

describe("parseArgs", () => {
  it("rejects any argument other than --live", () => {
    expect(() => parseArgs(["some-resume-id"])).toThrow(/Unrecognized argument/);
    expect(() => parseArgs(["--force"])).toThrow(/Unrecognized argument/);
  });

  it("defaults live to false, true only with --live", () => {
    expect(parseArgs([])).toEqual({ live: false });
    expect(parseArgs(["--live"])).toEqual({ live: true });
  });
});

describe("titlesEqual", () => {
  it("is true for the same titles in a different order", () => {
    expect(
      titlesEqual(["Backend Engineer", "Cloud Engineer"], ["Cloud Engineer", "Backend Engineer"]),
    ).toBe(true);
  });

  it("is false for different lengths", () => {
    expect(titlesEqual(["Backend Engineer"], ["Backend Engineer", "Cloud Engineer"])).toBe(false);
  });

  it("is false for a genuinely different title set", () => {
    expect(titlesEqual(["Backend Engineer"], ["Backend Software Engineer"])).toBe(false);
  });

  it("is true for two empty arrays", () => {
    expect(titlesEqual([], [])).toBe(true);
  });
});

describe("findCandidateResumes", () => {
  it("returns resumes with a null suggestedTitles too (ticket 82ae975) — coerced to [] for comparison", async () => {
    const userId = await seedUser();
    const inferred = await seedResume(userId, { suggestedTitles: ["Backend Engineer"] });
    const neverInferredOrFailed = await seedResume(userId, { suggestedTitles: null });

    const rows = await findCandidateResumes(db);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(inferred)).toBe(true);
    // A `null` row is now a candidate too -- a failed inference (ticket
    // 82ae975 fixed both `POST /resumes` and `PUT /resumes/:id/text` to
    // persist `null`, not `[]`, on failure) is indistinguishable here from
    // a resume that was never touched, and this script does not need to
    // tell them apart: either way, a successful re-run improves the row.
    expect(byId.has(neverInferredOrFailed)).toBe(true);
    expect(byId.get(neverInferredOrFailed)?.suggestedTitles).toEqual([]);
  });
});

describe("runReinfer", () => {
  it("dry run reports what would change but writes nothing", async () => {
    const userId = await seedUser();
    const resumeText = "Backend engineer with 5 years of Java and Node.js experience.";
    const resumeId = await seedResume(userId, {
      resumeText,
      suggestedTitles: ["Backend Software Engineer (Java/Node.js)"],
    });
    const anthropic = makeKeyedAnthropicClient({ [resumeText]: ["Backend Engineer"] });

    const result = await runReinfer(db, anthropic, { live: false });

    expect(result.written).toBe(false);
    const outcome = result.changed.find((c) => c.id === resumeId);
    expect(outcome).toBeDefined();
    expect(outcome?.oldTitles).toEqual(["Backend Software Engineer (Java/Node.js)"]);
    expect(outcome?.newTitles).toEqual(["Backend Engineer"]);

    // Nothing written -- the row still carries the OLD, stale chips.
    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    expect(row[0]?.suggestedTitles).toEqual(["Backend Software Engineer (Java/Node.js)"]);
  });

  it("--live actually updates a resume whose re-inferred output differs", async () => {
    const userId = await seedUser();
    const resumeText = "Cloud-focused software developer, microservices background.";
    const resumeId = await seedResume(userId, {
      resumeText,
      suggestedTitles: ["Software Developer - Cloud & Microservices"],
    });
    const anthropic = makeKeyedAnthropicClient({
      [resumeText]: ["Cloud Engineer", "Software Developer"],
    });

    const result = await runReinfer(db, anthropic, { live: true });

    expect(result.written).toBe(true);
    const outcome = result.changed.find((c) => c.id === resumeId);
    expect(outcome?.newTitles).toEqual(["Cloud Engineer", "Software Developer"]);

    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    expect(row[0]?.suggestedTitles).toEqual(["Cloud Engineer", "Software Developer"]);
  });

  it("leaves a resume untouched (not even reported) when the re-inferred output is identical", async () => {
    const userId = await seedUser();
    const resumeText = "A resume whose chips are already clean.";
    const resumeId = await seedResume(userId, {
      resumeText,
      suggestedTitles: ["Backend Engineer", "Cloud Engineer"],
    });
    // Same titles, different order -- a real thing a non-deterministic
    // model call can do against literally unchanged input.
    const anthropic = makeKeyedAnthropicClient({
      [resumeText]: ["Cloud Engineer", "Backend Engineer"],
    });

    const result = await runReinfer(db, anthropic, { live: true });

    expect(result.changed.map((c) => c.id)).not.toContain(resumeId);
    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    // Untouched: still the ORIGINAL order, not silently rewritten to the
    // new call's order.
    expect(row[0]?.suggestedTitles).toEqual(["Backend Engineer", "Cloud Engineer"]);
  });

  it("is a genuine no-op (no writes) in dry-run mode even when every candidate would change", async () => {
    const userId = await seedUser();
    const resumeText = "Stale chips resume.";
    const resumeId = await seedResume(userId, {
      resumeText,
      suggestedTitles: ["React/Angular Frontend Developer"],
    });
    const anthropic = makeKeyedAnthropicClient({ [resumeText]: ["Frontend Engineer"] });

    await runReinfer(db, anthropic, { live: false });

    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    expect(row[0]?.suggestedTitles).toEqual(["React/Angular Frontend Developer"]);
  });

  it("processes multiple candidate resumes independently", async () => {
    const userId = await seedUser();
    const idA = await seedResume(userId, {
      resumeText: "Resume A",
      suggestedTitles: ["Backend Software Engineer (Java/Node.js)"],
    });
    const idB = await seedResume(userId, {
      resumeText: "Resume B",
      suggestedTitles: ["Cloud Engineer"], // already clean
    });
    const anthropic = makeKeyedAnthropicClient({
      "Resume A": ["Backend Engineer"], // changes
      "Resume B": ["Cloud Engineer"], // unchanged
    });

    const result = await runReinfer(db, anthropic, { live: true });

    const changedIds = result.changed.map((c) => c.id);
    expect(changedIds).toContain(idA);
    expect(changedIds).not.toContain(idB);

    const rowA = await db.select().from(resumes).where(eq(resumes.id, idA));
    expect(rowA[0]?.suggestedTitles).toEqual(["Backend Engineer"]);
    const rowB = await db.select().from(resumes).where(eq(resumes.id, idB));
    expect(rowB[0]?.suggestedTitles).toEqual(["Cloud Engineer"]);
  });
});

/**
 * Opus review, B1 (BLOCKING, the finding this whole describe block exists to
 * pin): `inferTitleKeywords` swallows every real failure into `[]`, and an
 * earlier version of this script treated that `[]` as a genuine
 * re-inference result -- comparing it against the stored titles (always
 * "different" unless the stored value was already `[]`) and, in `--live`
 * mode, WRITING it over the resume's real chips. Proven during review
 * against real Postgres: a throwing fake client's `--live` run left a real
 * row's chips silently wiped to `[]`. Worse than the staleness bug this
 * script exists to fix, and NOT self-healing (`[]` is not `null`, so
 * routes/resumes.ts's lazy re-inference never re-triggers on it).
 */
describe("runReinfer treats an empty re-inference result as a FAILURE, never a value (ticket 1e09c1b, opus review B1)", () => {
  it("a resume whose inference fails is reported in `failed`, not `changed`, and is never written even with --live", async () => {
    const userId = await seedUser();
    const resumeText = "A resume the fake client has no configured response for.";
    const resumeId = await seedResume(userId, {
      resumeText,
      suggestedTitles: ["Backend Engineer", "Cloud Engineer"],
    });
    // No entry for `resumeText` -- the fake client throws for it, simulating
    // a real API failure (bad key, rate limit, network drop, ...).
    const anthropic = makeKeyedAnthropicClient({});

    const result = await runReinfer(db, anthropic, { live: true });

    expect(result.failed.map((f) => f.id)).toContain(resumeId);
    expect(result.changed.map((c) => c.id)).not.toContain(resumeId);

    // The real assertion: the row's ORIGINAL chips are completely untouched,
    // not overwritten with `[]` or anything else.
    const row = await db.select().from(resumes).where(eq(resumes.id, resumeId));
    expect(row[0]?.suggestedTitles).toEqual(["Backend Engineer", "Cloud Engineer"]);
  });

  it("one resume's failure does not block another resume in the same run from succeeding", async () => {
    const userId = await seedUser();
    const failingText = "This one fails.";
    const succeedingText = "This one succeeds.";
    const failingId = await seedResume(userId, {
      resumeText: failingText,
      suggestedTitles: ["Old Title"],
    });
    const succeedingId = await seedResume(userId, {
      resumeText: succeedingText,
      suggestedTitles: ["Stale Title"],
    });
    // Only the succeeding one has a configured response -- the other throws.
    const anthropic = makeKeyedAnthropicClient({ [succeedingText]: ["Fresh Title"] });

    const result = await runReinfer(db, anthropic, { live: true });

    expect(result.failed.map((f) => f.id)).toContain(failingId);
    expect(result.changed.map((c) => c.id)).toContain(succeedingId);

    const failingRow = await db.select().from(resumes).where(eq(resumes.id, failingId));
    expect(failingRow[0]?.suggestedTitles).toEqual(["Old Title"]); // untouched

    const succeedingRow = await db.select().from(resumes).where(eq(resumes.id, succeedingId));
    expect(succeedingRow[0]?.suggestedTitles).toEqual(["Fresh Title"]); // updated
  });
});
