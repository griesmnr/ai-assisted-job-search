/**
 * Real entry point for the `score.job` worker (ticket b53c422 — closes the
 * "NOT WIRED TO RUN" gap scoreJobWorker.ts's own module doc comment used to
 * describe, filed against this exact file since ticket 4065511 first built
 * the worker itself).
 *
 *   npx tsx apps/api/src/worker/run-score-job-worker.ts
 *   # or, via the package.json script (same command):
 *   pnpm --filter @app/api worker:score-job
 *
 * Long-lived, same shape as run-fetch-source-worker.ts (see that file's own
 * doc comment for why this process legitimately has nothing left to await
 * after `main()`'s setup finishes) — meant to be started manually in the
 * same dev-container shell `pnpm dev` already runs in. No docker-compose
 * service (PM correction, git-bug comment b45c36c on ticket b53c422).
 *
 * Dependency construction:
 *
 *   - Postgres: identical single-`pg.Client` pattern to demo-match.ts's
 *     `main()` and run-fetch-source-worker.ts's `main()` — see that file's
 *     doc comment for why a bare `Client`, not index.ts's `Pool`, is
 *     correct here (this worker never runs overlapping `db.transaction()`
 *     calls; scoreJobWorker.ts's handler is one message at a time under
 *     `prefetch(1)`).
 *   - RabbitMQ: `setupTopology()` — same as run-fetch-source-worker.ts.
 *   - Anthropic / scorer: `new Anthropic()` + `makeClaudeScorer(anthropic)`,
 *     the SAME env-based construction `demo-match.ts`'s `main()` and
 *     index.ts's `cachedAnthropic` already use — this is the one entry
 *     point of the two workers that actually needs `ANTHROPIC_API_KEY`
 *     (run-fetch-source-worker.ts never constructs an Anthropic client at
 *     all).
 *
 * SPEND GUARD (ticket b53c422): a single `ScoringSpendGuard` instance is
 * constructed here, ONCE, and passed into `startScoreJobWorker` — NOT left
 * to `createScoreJobHandler`'s own default (which would still be exactly
 * one instance per `startScoreJobWorker` call, since this file calls it
 * exactly once, but constructing it explicitly here makes that single-
 * instance-for-the-process-lifetime property visible at the call site
 * rather than implicit in a default parameter). See scoreJobWorker.ts's own
 * `ScoringSpendGuard` doc comment for the mechanism and the real numbers
 * behind `DEFAULT_LIFETIME_SPEND_CEILING_USD`.
 */
import { pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { loadEnvFile } from "../load-env.js";
import { makeClaudeScorer } from "../matching/index.js";
import { setupTopology } from "../queue/topology.js";
import { ScoringSpendGuard, startScoreJobWorker } from "./scoreJobWorker.js";

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main(): Promise<void> {
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

  // `connection` itself is intentionally unused below — same "no explicit
  // shutdown hook yet" reasoning as run-fetch-source-worker.ts's `main()`.
  const { connection: _connection, channel } = await setupTopology();

  // Constructed unconditionally, same as demo-match.ts's `main()` and
  // index.ts's own `cachedAnthropic` (lazily there, but this process has no
  // read-only route to protect — every message this worker ever consumes
  // needs a real scoring call, so there is no benefit to deferring
  // construction the way index.ts defers it for HTTP routes that might
  // never score anything). Throws synchronously if ANTHROPIC_API_KEY is
  // unset — fails loudly at startup, not on the first message.
  const anthropic = new Anthropic();
  const scoreJob = makeClaudeScorer(anthropic);

  const spendGuard = new ScoringSpendGuard();

  const consumerTag = await startScoreJobWorker({ channel, db, scoreJob, spendGuard });
  console.log(
    `[run-score-job-worker] consuming score.job (consumerTag=${consumerTag}, lifetime spend ceiling ` +
      `$${spendGuard.ceiling.toFixed(2)}) — Ctrl-C to stop.`,
  );
}

if (isMain) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
