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
 *
 * Ticket 4f88339: the `"complete"` member's own fields changed (the union
 * is now rebuilt from durable state — see `SearchStatusResponse`'s doc
 * comment), so the fields this function reaches for changed with them.
 * What is being regression-tested is unchanged and is NOT the field names:
 * it is that `status` alone still narrows to exactly one member.
 */
function describeSearchStatus(r: SearchStatusResponse): string {
  if (r.status === "complete") {
    // `cappedForBudget` is read here (ticket c9c676d) for the same reason
    // every other field on this member is: narrowing on `status` alone has
    // to reach it, or the union has regressed.
    return (
      `scored ${r.scored} job(s), ${r.permanentlyFailed} permanently failed, ` +
      `${r.cappedForBudget} not scored (budget)`
    );
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
  it("narrows to the durable 'complete' member's own fields", () => {
    const r: SearchStatusResponse = {
      searchId: "s1",
      resumeId: "r1",
      status: "complete",
      scored: 3,
      permanentlyFailed: 1,
      cappedForBudget: 2,
      linked: 6,
      sources: [
        { sourceId: "usajobs", status: "complete", linkedJobCount: 6 },
        {
          sourceId: "wa-state",
          status: "failed",
          linkedJobCount: null,
          errorKind: "rate-limited",
          errorMessage: "429 from the source",
        },
      ],
      completedAt: "2026-09-22T00:00:00.000Z",
      degraded: true,
    };
    expect(describeSearchStatus(r)).toBe(
      "scored 3 job(s), 1 permanently failed, 2 not scored (budget)",
    );
  });

  it("narrows the 'pending' member's own durable progress fields", () => {
    const r: SearchStatusResponse = {
      searchId: "s1",
      resumeId: "r1",
      status: "pending",
      scoredSoFar: 2,
      linked: 5,
      permanentlyFailed: 0,
      cappedForBudget: 0,
      sourcesSettled: false,
      sources: [{ sourceId: "usajobs", status: "pending", linkedJobCount: null }],
    };
    expect(describeSearchStatus(r)).toBe("pending");
    // `linked` is the denominator a reloaded page needs — previously not
    // rebuildable from GET /searches/:id at all (ticket 4f88339).
    if (r.status === "pending") expect(r.linked).toBe(5);
    if (r.status === "pending") expect(r.cappedForBudget).toBe(0);
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
