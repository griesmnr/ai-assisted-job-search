/**
 * Stable entry point for the matching pipeline (ticket 690c838). Every
 * consumer that needs the pipeline itself — routes, the REST layer's tests,
 * the future scoring worker (4065511), and demo-match.ts's own CLI tail —
 * imports from here, not from an individual file under this directory.
 *
 * Exception: scripts that only need `swe-filter.ts`'s job-preference filter
 * (the board-checker scripts, sources/criteria.ts) import
 * "./matching/swe-filter.js" directly instead of this barrel, specifically
 * to avoid pulling in pipeline.ts's much heavier import graph (Drizzle,
 * `pg`, the Anthropic SDK, and its top-level `loadEnvFile()` call) for code
 * that has nothing to do with any of that — see swe-filter.ts's own
 * doc comment.
 */
export * from "./scoring.js";
export * from "./usage-cost.js";
export * from "./pipeline.js";
export * from "./swe-filter.js";
