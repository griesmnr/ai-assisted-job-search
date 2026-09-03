import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDescriptors } from "./schema.js";
import { seedSourceDescriptors, SOURCE_DESCRIPTORS } from "./seed.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

// Isolated, per-run database (ticket c434a6e) — see test-db.ts. This file
// used to connect straight to the shared dev Postgres.
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("seed_test");
});

afterAll(async () => {
  await testDb.teardown();
});

describe("seedSourceDescriptors (ticket 620ca30)", () => {
  // Deliberately does NOT delete the seeded rows: usajobs, wa-state, and
  // greenhouse are real, permanent source_descriptors rows — the same ones
  // `jobs.data_source` needs as a valid FK target for any real ingest —
  // not throwaway test fixtures. Running this test is equivalent to
  // running `db:seed` once. They die with this file's own isolated
  // database in `afterAll` above, same as everything else in it.
  it("is idempotent: calling it twice leaves exactly one row per id", async () => {
    const db = testDb.db;
    await seedSourceDescriptors(db);
    await seedSourceDescriptors(db);

    const ids = SOURCE_DESCRIPTORS.map((s) => s.id);
    const rows = await db
      .select()
      .from(sourceDescriptors)
      .where(inArray(sourceDescriptors.id, ids));

    expect(rows).toHaveLength(SOURCE_DESCRIPTORS.length);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(ids));
  });
});
