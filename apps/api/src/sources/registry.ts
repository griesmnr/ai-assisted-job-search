/**
 * Central catalog of the job sources the REST API (ticket 59fdc52) can talk
 * about — every real `Job["dataSource"]` id, whether an adapter exists for
 * it, and whether that adapter is currently configured (env vars present).
 *
 * Exists because `demo-match.ts`'s `main()` used to be the only place that
 * knew "these five ids have `createXSourceFromEnv` factories, try each and
 * skip the ones that throw" — duplicating that list (and its skip-on-throw
 * behavior) inside a route handler would drift from `main()`'s the moment
 * either changed. This module is the one place both the CLI's underlying
 * list and the API's route handlers can share, built from
 * `db/seed.ts`'s `SOURCE_DESCRIPTORS` (the canonical six-id list already
 * used to seed the `source_descriptors` table) rather than a third
 * hand-maintained copy.
 */
import type { Job } from "@app/shared";
import { SOURCE_DESCRIPTORS } from "../db/seed.js";
import { createAshbySourceFromEnv } from "./ashby.js";
import { createGreenhouseSourceFromEnv } from "./greenhouse.js";
import { createLeverSourceFromEnv } from "./lever.js";
import { createSmartRecruitersSourceFromEnv } from "./smartrecruiters.js";
import { createUsajobsSourceFromEnv } from "./usajobs.js";
import type { JobSource } from "./types.js";

/**
 * One entry per adapter that actually exists. `"wa-state"` is a real,
 * seeded `Job["dataSource"]` value (see db/seed.ts) with no adapter class
 * yet (see sources/wa-state-findings.md) — deliberately absent from this
 * map rather than pointed at a stub, so it shows up as "no adapter
 * implemented yet" everywhere below instead of a misleading "misconfigured".
 */
const BUILDERS: Partial<Record<Job["dataSource"], () => JobSource>> = {
  usajobs: createUsajobsSourceFromEnv,
  greenhouse: createGreenhouseSourceFromEnv,
  lever: createLeverSourceFromEnv,
  ashby: createAshbySourceFromEnv,
  smartrecruiters: createSmartRecruitersSourceFromEnv,
};

export type SourceHealth = {
  id: Job["dataSource"];
  displayName: string;
  /** True when this source has an adapter AND its `createXSourceFromEnv()`
   * succeeded (required env vars are set). False either way otherwise —
   * `error` says which. */
  configured: boolean;
  /** Why `configured` is false. `undefined` when `configured` is true. */
  error: string | undefined;
};

/**
 * GET /sources — a config-time check only (no network calls; every
 * `createXSourceFromEnv` just reads env vars and constructs an object). This
 * is what makes a source with a missing/typo'd env var visible to the UI
 * instead of "silently absent" the way it was when only the CLI's `main()`
 * caught and logged the same throw to a terminal nobody watching the API
 * would see.
 */
export function checkSourceHealth(): SourceHealth[] {
  return SOURCE_DESCRIPTORS.map(({ id, displayName }) => {
    const build = BUILDERS[id];
    if (!build) {
      return { id, displayName, configured: false, error: "no adapter implemented yet" };
    }
    try {
      build();
      return { id, displayName, configured: true, error: undefined };
    } catch (err) {
      return {
        id,
        displayName,
        configured: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export type SkippedSource = { id: string; reason: string };

/**
 * Builds real `JobSource` instances for exactly the requested ids, isolating
 * one bad/unconfigured id from the rest — the same "one source's problem
 * can't take the others down" principle `demo-match.ts`'s `main()` and
 * `CompositeSource` already apply, extended to cover "the id isn't a real
 * `dataSource` at all" (a typo from the client) too.
 */
export function buildSourceSelection(sourceIds: string[]): {
  sources: JobSource[];
  skipped: SkippedSource[];
} {
  const knownIds = new Map(SOURCE_DESCRIPTORS.map((d) => [d.id as string, d.id]));
  const sources: JobSource[] = [];
  const skipped: SkippedSource[] = [];

  for (const rawId of sourceIds) {
    const knownId = knownIds.get(rawId);
    if (!knownId) {
      skipped.push({
        id: rawId,
        reason: `unknown source id (known ids: ${[...knownIds.keys()].join(", ")})`,
      });
      continue;
    }
    const build = BUILDERS[knownId];
    if (!build) {
      skipped.push({ id: rawId, reason: "no adapter implemented for this source yet" });
      continue;
    }
    try {
      sources.push(build());
    } catch (err) {
      skipped.push({ id: rawId, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return { sources, skipped };
}
