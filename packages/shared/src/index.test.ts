import { describe, expect, it } from "vitest";
import { ping } from "./index.js";
import type { SearchStatusResponse } from "./index.js";

describe("ping", () => {
  it("returns pong", () => {
    expect(ping()).toBe("pong");
  });
});

/**
 * Ticket 59fdc52 review round 3, F3 (blocking): compiles ONLY if
 * `SearchStatusResponse` is a genuinely discriminated union — every branch
 * below accesses fields that exist on exactly one member. Before the fix,
 * `status === "complete"` matched TWO members (the live, rich result AND
 * the restart-fallback case), so TypeScript narrowed `r` to their
 * intersection-of-access, not either shape individually, and
 * `r.newlyScored` failed with TS2339 — this function is that exact repro,
 * kept as a permanent compile-time regression check rather than a one-off
 * manual verification. `npx tsc --noEmit` on this file is the real
 * assertion; the runtime test below just proves the values flow through.
 */
function describeSearchStatus(r: SearchStatusResponse): string {
  if (r.status === "complete") {
    return `scored ${r.newlyScored} new job(s), ${r.failed} failed`;
  }
  if (r.status === "complete-details-unavailable") {
    return `complete, details unavailable: ${r.note}`;
  }
  if (r.status === "incomplete") {
    return `incomplete: ${r.note}`;
  }
  if (r.status === "failed") {
    return `failed: ${r.error ?? "no error detail"}`;
  }
  return "pending";
}

describe("SearchStatusResponse — discriminated union (ticket 59fdc52 review round 3, F3)", () => {
  it("narrows to the live 'complete' member's own fields", () => {
    const r: SearchStatusResponse = {
      searchId: "s1",
      resumeId: "r1",
      status: "complete",
      newlyScored: 3,
      failed: 1,
      skipped: 0,
      cappedCount: 0,
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0,
        probableCostUsd: 0,
        basis: "bootstrap",
      },
      sourceOutcomes: [],
    };
    expect(describeSearchStatus(r)).toBe("scored 3 new job(s), 1 failed");
  });

  it("narrows the restart-fallback 'complete-details-unavailable' member separately", () => {
    const r: SearchStatusResponse = {
      searchId: "s1",
      resumeId: "r1",
      status: "complete-details-unavailable",
      note: "lost tracking",
    };
    expect(describeSearchStatus(r)).toBe("complete, details unavailable: lost tracking");
  });
});
