import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sourceDescriptors } from "./schema.js";
import { seedSourceDescriptors, SOURCE_DESCRIPTORS } from "./seed.js";

// Node 22 can read .env itself — no dotenv dependency needed.
process.loadEnvFile();

const client = new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const db = drizzle(client);

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("seedSourceDescriptors (ticket 620ca30)", () => {
  // Deliberately does NOT delete the seeded rows in afterAll: usajobs,
  // wa-state, and greenhouse are real, permanent source_descriptors rows —
  // the same ones `jobs.data_source` needs as a valid FK target for any
  // real ingest — not throwaway test fixtures. Running this test is
  // equivalent to running `db:seed` once.
  it("is idempotent: calling it twice leaves exactly one row per id", async () => {
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
