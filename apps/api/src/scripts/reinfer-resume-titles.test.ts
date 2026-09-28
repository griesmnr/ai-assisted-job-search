import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resumes, users } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import {
  findInferredResumes,
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
 * be KEYED BY RESUME TEXT and backed by a live DATABASE LOOKUP for anything
 * unrecognized, because `runReinfer` processes every non-null-
 * `suggestedTitles` resume in the WHOLE test database, including ones a
 * PRIOR test in this same file left behind (nothing deletes rows between
 * tests, same shared-database shape `reassign-legacy-resumes.test.ts`
 * already lives with).
 *
 * A naive fixed fallback (e.g. always `[]`) would be actively dangerous
 * here, not just inaccurate: in `--live` mode, `runReinfer` WRITES every
 * resume whose "new" output differs from what's stored, so a fallback that
 * doesn't happen to equal a leftover row's actual stored titles would get
 * that row silently overwritten as a side effect of a LATER, unrelated
 * test -- corrupting state an earlier test already asserted on. Instead,
 * anything this test's own map doesn't recognize gets its OWN
 * already-stored `suggestedTitles` echoed straight back, which is
 * guaranteed to compare equal under `titlesEqual` and therefore never
 * appear in `result.changed` or get written -- a true no-op for every row
 * this test doesn't explicitly target, regardless of execution order or
 * how much earlier tests left behind.
 */
function makeKeyedAnthropicClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  testDb: NodePgDatabase<any>,
  responsesByTextSubstring: Record<string, string[]>,
): Anthropic {
  const fakeClient = {
    messages: {
      create: async (params: { messages: Array<{ content: string }> }) => {
        const prompt = params.messages[0]?.content ?? "";
        const match = Object.entries(responsesByTextSubstring).find(([key]) =>
          prompt.includes(key),
        );
        if (match) {
          return { content: [{ type: "text", text: JSON.stringify({ titles: match[1] }) }] };
        }
        // Unrecognized -- find which stored resume this prompt is FOR (the
        // real prompt is a fixed prefix + the resume's own text verbatim,
        // resume-title-inference.ts's PROMPT_PREFIX) and echo its own
        // current titles back, so this call is a guaranteed no-op.
        const rows = await testDb
          .select({ resumeText: resumes.resumeText, suggestedTitles: resumes.suggestedTitles })
          .from(resumes);
        const owner = rows.find((r) => prompt.endsWith(r.resumeText));
        const titles = owner?.suggestedTitles ?? [];
        return { content: [{ type: "text", text: JSON.stringify({ titles }) }] };
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

describe("findInferredResumes", () => {
  it("only returns resumes with a non-null suggestedTitles", async () => {
    const userId = await seedUser();
    const inferred = await seedResume(userId, { suggestedTitles: ["Backend Engineer"] });
    const neverInferred = await seedResume(userId, { suggestedTitles: null });

    const rows = await findInferredResumes(db);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inferred);
    expect(ids).not.toContain(neverInferred);
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
    const anthropic = makeKeyedAnthropicClient(db, { [resumeText]: ["Backend Engineer"] });

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
    const anthropic = makeKeyedAnthropicClient(db, {
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
    const anthropic = makeKeyedAnthropicClient(db, {
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
    const anthropic = makeKeyedAnthropicClient(db, { [resumeText]: ["Frontend Engineer"] });

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
    const anthropic = makeKeyedAnthropicClient(db, {
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
