/**
 * Score floor for the results view (git-bug 484889d, decision from
 * 2026-08-22: "score floor of 55 ... with hidden-count shown").
 *
 * NOT imported from @app/shared, even though as of this writing it now
 * COULD be: ticket 1b9f81e (running in a parallel worktree while this
 * ticket was being written, per its Notes) merged into `main` as commit
 * 8012287 partway through this ticket's own implementation and exports
 * `MATCH_SCORE_FLOOR = 55` from `packages/shared/src/index.ts` — same
 * value, confirmed by reading that commit directly. This branch's base
 * predates that merge (branched from 63606dd), so `@app/shared` here still
 * doesn't have it; picking up the import means merging/rebasing onto the
 * post-1b9f81e `main`, which is this ticket's PM's call, not this branch's
 * to make unilaterally. That same 1b9f81e merge commit's own message
 * confirms the other half of this file's original claim still holds:
 * "`GET /resumes/:id/results` has no default floor of its own" — so this
 * app must keep passing `minScore` explicitly regardless of which constant
 * backs it (see api/client.ts's `getResults` and hooks/useResults.ts).
 *
 * FOLLOW-UP for whoever next touches this branch: once merged/rebased past
 * 8012287, delete this local constant and `import { MATCH_SCORE_FLOOR as
 * SCORE_FLOOR } from "@app/shared"` instead, so the value lives in exactly
 * one place.
 */
export const SCORE_FLOOR = 55;
