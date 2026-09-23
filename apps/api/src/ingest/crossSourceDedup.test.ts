import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jobs, resumes, searches, searchResults, sourceDescriptors } from "../db/schema.js";
import { createTestDatabase, type TestDatabase } from "../db/test-db.js";
import { loadEnvFile } from "../load-env.js";
import type { NormalizedJob } from "../sources/types.js";
import {
  DIFFERENT_REQ_SAME_COMPANY,
  SAME_REQ_ATS_A,
  SAME_REQ_ATS_B,
  UNRELATED_POSTING,
} from "./textSimilarity.fixtures.js";

/**
 * GATE 2 IS SPIED ON, NOT REPLACED. The real implementation still runs (so
 * every behavioral assertion below is about the shipped algorithm, not a
 * stub); `vi.fn` only counts the calls. That is what makes the "the
 * description check never runs unless company + title + location already
 * match exactly" test an assertion about the MECHANISM rather than about an
 * outcome that happened to come out right.
 *
 * Hoisted above the imports by vitest, hence the dynamic `importOriginal`.
 */
vi.mock("./textSimilarity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./textSimilarity.js")>();
  return { ...actual, descriptionSimilarity: vi.fn(actual.descriptionSimilarity) };
});

// Imported AFTER the mock declaration for readability only - vitest hoists
// `vi.mock` above every import regardless.
import { ingestJobsForSearch } from "./ingestJobs.js";
import { descriptionSimilarity } from "./textSimilarity.js";

loadEnvFile();

let testDb: TestDatabase;

// Two real, distinct sources - the entire point of this file. `string` (not
// the const-inferred literal) for the same reason ingestJobs.test.ts does
// it: so it can be cast to NormalizedJob["dataSource"].
const SOURCE_A: string = "dedup-test-source-a";
const SOURCE_B: string = "dedup-test-source-b";
const RESUME_ID = "dedup-test-resume";
const SEARCH_ID = "dedup-test-search";

const similaritySpy = vi.mocked(descriptionSimilarity);

function job(dataSource: string, overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    externalId: "ext-1",
    dataSource: dataSource as NormalizedJob["dataSource"],
    title: "Senior Software Engineer",
    description: SAME_REQ_ATS_A,
    company: "Northwind Robotics",
    payType: "salary",
    commitment: "full-time",
    locationType: "hybrid",
    location: "Seattle, WA",
    linkToApply: "https://example.com/apply",
    postedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function jobRowsFor(company: string) {
  return testDb.db.select().from(jobs).where(eq(jobs.company, company));
}

beforeAll(async () => {
  testDb = await createTestDatabase("cross_source_dedup_test");
  const db = testDb.db;
  await db.insert(sourceDescriptors).values([
    { id: SOURCE_A, displayName: "Dedup Test Source A" },
    { id: SOURCE_B, displayName: "Dedup Test Source B" },
  ]);
  await db.insert(resumes).values({
    id: RESUME_ID,
    resumeText: "resume text",
    resumeHash: "dedup-test-resume-hash",
    resumeNickname: "Resume 1",
  });
  await db.insert(searches).values({ id: SEARCH_ID, resumeId: RESUME_ID, searchedAt: new Date() });
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(() => {
  similaritySpy.mockClear();
});

describe("cross-source duplicate detection: the true-duplicate case", () => {
  it("does not create a second jobs row when the same req arrives from a second source", async () => {
    const db = testDb.db;
    const company = "Northwind Robotics";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "a-1", company, description: SAME_REQ_ATS_A }),
    ]);
    expect(first.newlyInsertedJobIds).toHaveLength(1);

    // Same real posting, different ATS: a different externalId under a
    // different dataSource, description lightly reworded the way an
    // employer actually re-pastes it.
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "b-1", company, description: SAME_REQ_ATS_B }),
    ]);

    // NOT newly inserted - so no second `score.job` is published and the
    // job is not re-scored (a real Claude call saved, ticket 6bf2196).
    expect(second.newlyInsertedJobIds).toEqual([]);
    // Linked to the EXISTING row, via the same search_results path an exact
    // (dataSource, externalId) repeat uses.
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);

    // One row in the database, not two.
    expect(await jobRowsFor(company)).toHaveLength(1);

    // No orphan row was written under source B for that externalId.
    const bRows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dataSource, SOURCE_B), eq(jobs.externalId, "b-1")));
    expect(bRows).toHaveLength(0);
  });

  it("links the search to the existing job exactly once", async () => {
    const db = testDb.db;
    const company = "Linkcheck Industries";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "link-a", company, description: SAME_REQ_ATS_A }),
    ]);
    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "link-b", company, description: SAME_REQ_ATS_B }),
    ]);

    const links = await db
      .select()
      .from(searchResults)
      .where(eq(searchResults.jobId, first.linkedJobIds[0]));
    expect(links).toHaveLength(1);
  });

  it("matches through case and whitespace differences in company, title and location", async () => {
    const db = testDb.db;
    const company = "Casefold Systems";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, {
        externalId: "case-a",
        company,
        title: "Senior Software Engineer",
        location: "Seattle, WA",
        description: SAME_REQ_ATS_A,
      }),
    ]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, {
        externalId: "case-b",
        company: "  casefold   SYSTEMS ",
        title: "senior  software\tengineer",
        location: "SEATTLE,  wa",
        description: SAME_REQ_ATS_B,
      }),
    ]);

    expect(second.newlyInsertedJobIds).toEqual([]);
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);
  });

  it("matches when both sources publish no location at all", async () => {
    const db = testDb.db;
    const company = "Nolocation Labs";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "noloc-a", company, location: undefined }),
    ]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, {
        externalId: "noloc-b",
        company,
        location: undefined,
        description: SAME_REQ_ATS_B,
      }),
    ]);

    expect(second.newlyInsertedJobIds).toEqual([]);
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);
  });
});

describe("cross-source duplicate detection: the false-merge case (the one that matters)", () => {
  /**
   * The owner's own stated worry (98844f1): one company, two genuinely
   * different open reqs, identical title, identical city. A naive
   * company+title+location implementation merges these and silently deletes
   * a real opening from her results forever.
   *
   * The two descriptions share every boilerplate section VERBATIM (About,
   * Compensation, EEO) and differ only in what the job actually is, so this
   * is a real test of the description check, not a strawman with two
   * unrelated texts.
   */
  it("inserts a SEPARATE row for a different req with the same company, title and location", async () => {
    const db = testDb.db;
    const company = "Northwind Robotics Two";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "diff-a", company, description: SAME_REQ_ATS_A }),
    ]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "diff-b", company, description: DIFFERENT_REQ_SAME_COMPANY }),
    ]);

    // A genuinely new job: inserted, reported as new, and therefore scored.
    expect(second.newlyInsertedJobIds).toHaveLength(1);
    expect(second.linkedJobIds).not.toEqual(first.linkedJobIds);
    expect(second.linkedJobIds[0]).not.toBe(first.linkedJobIds[0]);

    // Two rows, one per real opening.
    const rows = await jobRowsFor(company);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dataSource))).toEqual(new Set([SOURCE_A, SOURCE_B]));

    // The description check DID run - this is not passing by accident of
    // the gate rejecting the pair before comparison.
    expect(similaritySpy).toHaveBeenCalled();
  });

  it("proves this test would fail against a company+title+location-only implementation", async () => {
    // Guards the test above from rotting into a tautology: the two postings
    // really are identical on every field a naive implementation would key
    // on, so the ONLY thing separating them is the description comparison.
    const a = job(SOURCE_A, { externalId: "proof-a", description: SAME_REQ_ATS_A });
    const b = job(SOURCE_B, { externalId: "proof-b", description: DIFFERENT_REQ_SAME_COMPANY });
    expect(a.company).toBe(b.company);
    expect(a.title).toBe(b.title);
    expect(a.location).toBe(b.location);
    expect(a.dataSource).not.toBe(b.dataSource);
  });

  it("does not merge when descriptions are unrelated", async () => {
    const db = testDb.db;
    const company = "Unrelated Holdings";

    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "unrel-a", company, description: SAME_REQ_ATS_A }),
    ]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "unrel-b", company, description: UNRELATED_POSTING }),
    ]);

    expect(second.newlyInsertedJobIds).toHaveLength(1);
    expect(await jobRowsFor(company)).toHaveLength(2);
  });

  it("does not merge two blank descriptions", async () => {
    const db = testDb.db;
    const company = "Blankdesc Corp";

    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "blank-a", company, description: "" }),
    ]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "blank-b", company, description: "" }),
    ]);

    // Absence of evidence is not evidence of sameness - see
    // descriptionSimilarity's doc comment.
    expect(second.newlyInsertedJobIds).toHaveLength(1);
    expect(await jobRowsFor(company)).toHaveLength(2);
  });

  it("an existing row absorbs at most one posting from a single batch", async () => {
    const db = testDb.db;
    const company = "Claimonce Inc";

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "claim-a", company, description: SAME_REQ_ATS_A }),
    ]);

    // Two DIFFERENT postings in one source-B response, both of which look
    // like the same job as source A's row. They are two postings, so they
    // must not collapse onto one row - and the returned ids must stay
    // distinct, or `linkedJobIds` would contain a duplicate.
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "claim-b1", company, description: SAME_REQ_ATS_A }),
      job(SOURCE_B, { externalId: "claim-b2", company, description: SAME_REQ_ATS_B }),
    ]);

    expect(second.linkedJobIds).toHaveLength(2);
    expect(new Set(second.linkedJobIds).size).toBe(2);
    expect(second.linkedJobIds).toContain(first.linkedJobIds[0]);
    expect(second.newlyInsertedJobIds).toHaveLength(1);
    expect(await jobRowsFor(company)).toHaveLength(2);
  });
});

describe("cross-source duplicate detection: gate 2 is genuinely gated by gate 1", () => {
  /**
   * The ticket asks for proof that the description comparison NEVER RUNS
   * for postings whose company/title/location don't already match — not
   * merely that the end result happens to be "not merged". So these assert
   * the call count on the similarity function itself.
   */
  const gateCases: [string, Partial<NormalizedJob>][] = [
    ["a different company", { company: "Southwind Robotics" }],
    ["a different title", { title: "Staff Software Engineer" }],
    ["a different location", { location: "Portland, OR" }],
    ["a location on one side only", { location: undefined }],
    ["a title differing by one word", { title: "Senior Software Engineers" }],
  ];

  for (const [label, difference] of gateCases) {
    it(`never calls the description check for ${label}`, async () => {
      const db = testDb.db;
      const company = `Gate ${label}`;
      const base = { company, description: SAME_REQ_ATS_A };

      await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
        job(SOURCE_A, { ...base, externalId: `gate-a-${label}` }),
      ]);
      similaritySpy.mockClear();

      // Byte-identical description: if the gate leaked at all, this pair
      // would score 1.0 and merge. It must not even be compared.
      const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
        job(SOURCE_B, { ...base, externalId: `gate-b-${label}`, ...difference }),
      ]);

      expect(similaritySpy).not.toHaveBeenCalled();
      expect(second.newlyInsertedJobIds).toHaveLength(1);
    });
  }

  it("DOES call the description check exactly once when company, title and location all match", async () => {
    // The contrast case. Without it, the assertions above would also pass
    // against an implementation that never calls the check at all.
    const db = testDb.db;
    const company = "Gate Positive Control";

    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "gatepos-a", company }),
    ]);
    similaritySpy.mockClear();

    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "gatepos-b", company, description: SAME_REQ_ATS_B }),
    ]);

    expect(similaritySpy).toHaveBeenCalledTimes(1);
  });

  it("never compares a posting against rows from its own source", async () => {
    const db = testDb.db;
    const company = "Samesource Ltd";

    // Two identical-looking postings from the SAME source. Within one
    // source, (dataSource, externalId) is the authority and two externalIds
    // are two jobs - the description check must not run at all, let alone
    // merge them.
    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "same-1", company }),
    ]);
    similaritySpy.mockClear();
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "same-2", company }),
    ]);

    expect(similaritySpy).not.toHaveBeenCalled();
    expect(second.newlyInsertedJobIds).toHaveLength(1);
    expect(await jobRowsFor(company)).toHaveLength(2);
  });

  it("does no description work at all when nothing in the batch matches anything", async () => {
    const db = testDb.db;
    // The overwhelmingly common case (0 cross-source collisions across
    // 2,304 live jobs, 98844f1): the gate query returns nothing and the
    // similarity function is never entered.
    similaritySpy.mockClear();
    const result = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
      job(SOURCE_B, { externalId: "nomatch-1", company: "Entirely Novel Company" }),
      job(SOURCE_B, { externalId: "nomatch-2", company: "Another Novel Company" }),
    ]);

    expect(similaritySpy).not.toHaveBeenCalled();
    expect(result.newlyInsertedJobIds).toHaveLength(2);
  });
});

describe("cross-source duplicate detection: the existing (dataSource, externalId) path is untouched", () => {
  it("still dedupes a redelivery of the same posting from the same source", async () => {
    const db = testDb.db;
    const company = "Redelivery Co";
    const posting = job(SOURCE_A, { externalId: "redeliver-1", company });

    const first = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [posting]);
    const second = await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [posting]);

    expect(first.newlyInsertedJobIds).toHaveLength(1);
    expect(second.newlyInsertedJobIds).toEqual([]);
    expect(second.linkedJobIds).toEqual(first.linkedJobIds);
    expect(await jobRowsFor(company)).toHaveLength(1);
  });

  it("still throws (and rolls back) when the caller's dataSource doesn't match the job's own", async () => {
    const db = testDb.db;
    // A cross-source merge must never mask this - the merge path resolves
    // postings WITHOUT inserting them, so if it fired here the "should be
    // impossible" throw would never happen and a real dispatch bug would
    // ack as a success. `findCrossSourceDuplicates` excludes rows from the
    // posting's OWN dataSource for exactly this reason.
    //
    // CORRECTION (ticket 78d31b7, adversarial review). This ticket's own
    // commit message claimed the equivalent pre-existing test in
    // ingestJobs.test.ts ("rolls back the insert when the caller's
    // dataSource doesn't match...") would have been MASKED by this change,
    // i.e. that it had been passing for the wrong reason and this test
    // replaced it. That is backwards, and re-measured here on 2026-09-23:
    // deleting the own-source exclusion in crossSourceDuplicates.ts fails
    // BOTH tests, not just this one. The pre-existing test was already a
    // real guard against this regression; this one is a second, closer
    // guard at the layer where the exclusion actually lives, not a
    // replacement for a test that wasn't working.
    const company = "Mismatch Co";
    await ingestJobsForSearch(db, SEARCH_ID, SOURCE_A, [
      job(SOURCE_A, { externalId: "mismatch-seed", company }),
    ]);

    await expect(
      ingestJobsForSearch(db, SEARCH_ID, SOURCE_B, [
        job(SOURCE_A, { externalId: "mismatch-1", company }),
      ]),
    ).rejects.toThrow(/no jobs row found/);

    const rows = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.dataSource, SOURCE_A), inArray(jobs.externalId, ["mismatch-1"])));
    expect(rows).toHaveLength(0);
  });
});
