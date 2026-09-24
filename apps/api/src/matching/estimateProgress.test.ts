import { describe, expect, it } from "vitest";
import { EstimateProgressTracker, PROGRESS_RETENTION_MS } from "./estimateProgress.js";

describe("EstimateProgressTracker (ticket bf2dd0a)", () => {
  it("reports incremental progress as sources settle, not all at once", () => {
    const tracker = new EstimateProgressTracker();
    tracker.start("req-1", ["greenhouse", "lever", "ashby"]);

    expect(tracker.get("req-1")).toMatchObject({ total: 3, completed: 0, done: false });

    tracker.markSourceSettled("req-1", "lever");
    expect(tracker.get("req-1")).toMatchObject({ total: 3, completed: 1, done: false });

    tracker.markSourceSettled("req-1", "greenhouse");
    tracker.markSourceSettled("req-1", "ashby");
    expect(tracker.get("req-1")).toMatchObject({ total: 3, completed: 3, done: true });
  });

  it("markSourceSettled is a true no-op for a source not started for this id — it must not INSERT and inflate total (opus review round 1, F1)", () => {
    // Map#set on an absent key inserts rather than no-ops; the fix requires
    // an explicit sources.has() check before writing. Reproduces the exact
    // scenario the review found: two overlapping runs sharing a
    // client-minted requestId, where the second run's sources must not leak
    // into the first's still-live snapshot.
    const tracker = new EstimateProgressTracker();
    tracker.start("shared-id", ["greenhouse"]);

    // A settle notification for a source this run never started (e.g. a
    // stale callback from a DIFFERENT, unrelated run that happened to reuse
    // the same id) must not add it.
    tracker.markSourceSettled("shared-id", "lever");

    const snapshot = tracker.get("shared-id");
    expect(snapshot?.total).toBe(1);
    expect(snapshot?.sources.map((s) => s.sourceId)).toEqual(["greenhouse"]);
  });

  it("markSourceSettled is a silent no-op for an unknown requestId", () => {
    const tracker = new EstimateProgressTracker();
    expect(() => tracker.markSourceSettled("never-started", "greenhouse")).not.toThrow();
    expect(tracker.get("never-started")).toBeUndefined();
  });

  it("get() returns undefined and drops the entry past PROGRESS_RETENTION_MS", () => {
    let now = 1_700_000_000_000;
    const tracker = new EstimateProgressTracker({ now: () => now });
    tracker.start("req-1", ["greenhouse"]);

    now += PROGRESS_RETENTION_MS - 1;
    expect(tracker.get("req-1")).toBeDefined();

    now += 2;
    expect(tracker.get("req-1")).toBeUndefined();
  });

  it("start() sweeps OTHER expired entries even if nothing ever reads them (opus review round 1, F2)", () => {
    // The bug this pins: get()'s expire-on-read alone cannot bound this
    // map's size, because keys are crypto.randomUUID() and never repeat --
    // an id nobody polls again is never read again, so expire-on-read never
    // fires for it. start() must sweep proactively, since it's the one
    // method guaranteed to run once per real estimate regardless of
    // whether anyone polls. Uses `.size` (test-support only) specifically
    // because asserting `get(id) === undefined` alone would pass either
    // way -- that's ALSO true under get()'s own expire-on-read with no
    // proactive sweep at all, so it can't distinguish the two
    // implementations. `.size` can, because it's read WITHOUT ever calling
    // `get()` on the abandoned ids first.
    let now = 1_700_000_000_000;
    const tracker = new EstimateProgressTracker({ now: () => now });

    tracker.start("abandoned-1", ["greenhouse"]);
    tracker.start("abandoned-2", ["lever"]);
    // Neither abandoned id is ever read again -- simulating a caller that
    // mints a progress id and never polls it.
    expect(tracker.size).toBe(2);

    now += PROGRESS_RETENTION_MS + 1;
    // A brand-new estimate starts well after the abandoned ones expired.
    // Its own start() call should sweep them out as a side effect, with
    // no `get()` call on the abandoned ids anywhere in this test.
    tracker.start("new-run", ["ashby"]);

    // Only "new-run" should remain -- both abandoned entries were removed
    // by start()'s sweep itself, not merely rendered unreadable by get().
    expect(tracker.size).toBe(1);
    expect(tracker.get("new-run")).toMatchObject({ total: 1, completed: 0 });
  });
});
