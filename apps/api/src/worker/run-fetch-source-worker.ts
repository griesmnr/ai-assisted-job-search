/**
 * Real entry point for the `fetch.source` worker (ticket b53c422 — closes
 * the "NOT WIRED TO RUN" gap fetchSourceWorker.ts's own module doc comment
 * used to describe, filed against this exact file since ticket 568cc5f
 * first built the worker itself).
 *
 *   npx tsx apps/api/src/worker/run-fetch-source-worker.ts
 *   # or, via the package.json script (same command):
 *   pnpm --filter @app/api worker:fetch-source
 *
 * Long-lived, not a one-shot script like demo-match.ts: `startFetchSourceWorker`
 * registers a RabbitMQ consumer and returns immediately (the consumer tag),
 * so this process stays alive for as long as the AMQP connection stays open
 * — there is no work loop to await here, `main()` genuinely finishes after
 * setup and the process keeps running only because Node's event loop still
 * has the open TCP connection to RabbitMQ keeping it non-empty. Meant to be
 * started manually in the same dev-container shell `pnpm dev` (apps/api's
 * own `dev` script) already runs in — see the PM correction on ticket
 * b53c422 (git-bug comment b45c36c): no docker-compose service for this,
 * same as apps/api/apps/web themselves don't get one.
 *
 * Dependency construction mirrors two existing, already-reviewed patterns
 * rather than inventing a third:
 *
 *   - Postgres connection: identical to demo-match.ts's `main()` — a single
 *     `pg.Client` (not index.ts's `Pool`), since this process, like
 *     demo-match.ts, never runs two overlapping `db.transaction()` calls
 *     concurrently (fetchSourceWorker.ts's handler is one message at a time
 *     under `prefetch(1)` — see startFetchSourceWorker's own doc comment).
 *     index.ts's Pool exists specifically for concurrent HTTP requests,
 *     which don't apply here.
 *   - RabbitMQ connection/channel: `setupTopology()` (queue/topology.ts) —
 *     the SAME topology-declaring call every test file and (once
 *     routes/searches.ts's sibling ticket lands) the API itself will use,
 *     so this worker can never start against a differently-shaped topology
 *     than what it will actually consume from.
 *   - Job sources: `buildAllSources` (sources/registry.ts) — reuses the
 *     SAME per-source try/catch construction `demo-match.ts`'s `main()`
 *     pioneered and `sources/registry.ts`'s own doc comment already
 *     designates the one shared place for, rather than a fourth
 *     independently-typed copy of the five-source list. One misconfigured
 *     source (a missing env var) is logged and skipped; the rest still
 *     work. Note this list differs from demo-match.ts's own four
 *     (Greenhouse/Lever/Ashby/SmartRecruiters) by including USAJOBS —
 *     registry.ts's list is the current canonical one (ticket 59fdc52),
 *     demo-match.ts's own four-source list predates USAJOBS being wired in
 *     anywhere and is now the narrower, legacy list.
 *   - Anthropic client / scorer: NOT needed here — this worker never
 *     scores anything (that's scoreJobWorker.ts's job, via
 *     run-score-job-worker.ts). Only run-score-job-worker.ts constructs an
 *     Anthropic client.
 *
 * Fails loudly and exits non-zero on any setup error (bad DB credentials,
 * unreachable RabbitMQ, zero sources configured) rather than silently
 * running as a worker that can never do anything — same "fail fast at
 * startup" posture demo-match.ts's `main()` and index.ts's `main()` both
 * already take for their own dependency construction.
 */
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { loadEnvFile } from "../load-env.js";
import { setupTopology } from "../queue/topology.js";
import { buildAllSources } from "../sources/registry.js";
import { startFetchSourceWorker } from "./fetchSourceWorker.js";

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main(): Promise<void> {
  // See load-env.ts: harmless no-op outside a checkout that has a local
  // .env (e.g. the dev container, where docker-compose.yml's `env_file`
  // already populated process.env).
  loadEnvFile();

  const client = new Client({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
  await client.connect();
  const db = drizzle(client);

  // `connection` itself is intentionally unused below — see the "No
  // explicit shutdown hook" comment near the end of this function for why
  // this process doesn't need to hold onto it for anything today.
  const { connection: _connection, channel } = await setupTopology();

  const sources = buildAllSources((id, error) => {
    console.warn(`[run-fetch-source-worker] skipping source "${id}": ${error}`);
  });
  const configuredCount = Object.keys(sources).length;
  if (configuredCount === 0) {
    throw new Error(
      "No job sources are configured — set at least one of USAJOBS_API_KEY/" +
        "GREENHOUSE_BOARD_TOKENS/LEVER_COMPANIES/ASHBY_BOARD_NAMES/SMARTRECRUITERS_COMPANIES " +
        "in .env (see .env.example). A fetch.source worker with zero adapters can never do anything.",
    );
  }
  console.log(
    `[run-fetch-source-worker] configured sources: ${Object.keys(sources).sort().join(", ")}`,
  );

  const consumerTag = await startFetchSourceWorker({ channel, db, sources });
  console.log(
    `[run-fetch-source-worker] consuming fetch.source (consumerTag=${consumerTag}) — Ctrl-C to stop.`,
  );

  // No explicit shutdown hook: same posture index.ts's `main()` takes for
  // its own long-lived Fastify server — a manually-run dev process, and
  // Ctrl-C/SIGINT's default Node behavior (close the process, which drops
  // the AMQP connection and lets RabbitMQ redeliver whatever was unacked)
  // is an acceptable exit path for a personal, single-operator project.
}

if (isMain) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
