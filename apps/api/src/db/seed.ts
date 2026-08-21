/**
 * Idempotently seeds `source_descriptors` with the ids every adapter
 * actually stamps onto the jobs it produces (`Job["dataSource"]` in
 * packages/shared — "usajobs" | "wa-state" | "greenhouse").
 *
 * `jobs.data_source` is a foreign key into this table, so inserting a job
 * under any of these ids fails with a foreign key violation until the
 * matching row exists here. This table was never seeded (an unshipped
 * acceptance criterion on an earlier, closed ticket), which is exactly why
 * a real insert — e.g. from demo-match.ts — used to fail. `demo-match.ts`
 * calls this before it ingests anything so a fresh database doesn't need a
 * separate manual step; it's also runnable standalone (see the `isMain`
 * block below) for `pnpm db:seed`.
 *
 * `onConflictDoNothing` on the primary key makes repeated calls free —
 * safe to run on every `demo-match.ts` invocation, not just once per
 * environment.
 */
import { pathToFileURL } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { sourceDescriptors } from "./schema.js";

export const SOURCE_DESCRIPTORS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: "usajobs", displayName: "USAJOBS" },
  { id: "wa-state", displayName: "Washington State Careers" },
  { id: "greenhouse", displayName: "Greenhouse" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function seedSourceDescriptors(db: NodePgDatabase<any>): Promise<void> {
  await db
    .insert(sourceDescriptors)
    .values([...SOURCE_DESCRIPTORS])
    .onConflictDoNothing({
      target: sourceDescriptors.id,
    });
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  // `pnpm db:seed` (and any other direct `tsx src/db/seed.ts` invocation)
  // runs with cwd = apps/api, but .env lives at the repo root — a bare
  // `process.loadEnvFile()` looks for `apps/api/.env`, which doesn't
  // exist, and throws ENOENT before a single env var is read. Anchoring
  // the path to this file's own URL (not cwd) makes the script work from
  // any cwd, not just when invoked from the repo root by coincidence.
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();
  try {
    await seedSourceDescriptors(drizzle(client));
    console.log(`Seeded source_descriptors: ${SOURCE_DESCRIPTORS.map((s) => s.id).join(", ")}`);
  } finally {
    await client.end();
  }
}
