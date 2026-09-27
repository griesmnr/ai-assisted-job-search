import { describe, expect, it } from "vitest";
import { EstimateProgressTracker, PROGRESS_RETENTION_MS } from "./estimateProgress.js";

// Ticket 3fc1e5e: every entry is keyed by (userId, requestId), so every call
// below names a user. These two are deliberately distinct real-shaped UUIDs
// (the same shape identity.ts's UUID_RE accepts) -- USER_A stands in for
// "the caller" in the tests that predate this ticket, and USER_B exists for
// the cross-user isolation test at the bottom.
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

describe("EstimateProgressTracker (ticket bf2dd0a)", () => {
  it("reports incremental progress as sources settle, not all at once", () => {
    const tracker = new EstimateProgressTracker();
    tracker.start("req-1", USER_A, ["greenhouse", "lever", "ashby"]);

    expect(tracker.get("req-1", USER_A)).toMatchObject({ total: 3, completed: 0, done: false });

    tracker.markSourceSettled("req-1", USER_A, "lever");
    expect(tracker.get("req-1", USER_A)).toMatchObject({ total: 3, completed: 1, done: false });

    tracker.markSourceSettled("req-1", USER_A, "greenhouse");
    tracker.markSourceSettled("req-1", USER_A, "ashby");
    expect(tracker.get("req-1", USER_A)).toMatchObject({ total: 3, completed: 3, done: true });
  });

  it("markSourceSettled is a true no-op for a source not started for this id — it must not INSERT and inflate total (opus review round 1, F1)", () => {
    // Map#set on an absent key inserts rather than no-ops; the fix requires
    // an explicit sources.has() check before writing. Reproduces the exact
    // scenario the review found: two overlapping runs sharing a
    // client-minted requestId, where the second run's sources must not leak
    // into the first's still-live snapshot.
    const tracker = new EstimateProgressTracker();
    tracker.start("shared-id", USER_A, ["greenhouse"]);

    // A settle notification for a source this run never started (e.g. a
    // stale callback from a DIFFERENT, unrelated run that happened to reuse
    // the same id) must not add it.
    tracker.markSourceSettled("shared-id", USER_A, "lever");

    const snapshot = tracker.get("shared-id", USER_A);
    expect(snapshot?.total).toBe(1);
    expect(snapshot?.sources.map((s) => s.sourceId)).toEqual(["greenhouse"]);
  });

  it("markSourceSettled is a silent no-op for an unknown requestId", () => {
    const tracker = new EstimateProgressTracker();
    expect(() => tracker.markSourceSettled("never-started", USER_A, "greenhouse")).not.toThrow();
    expect(tracker.get("never-started", USER_A)).toBeUndefined();
  });

  it("get() returns undefined and drops the entry past PROGRESS_RETENTION_MS", () => {
    let now = 1_700_000_000_000;
    const tracker = new EstimateProgressTracker({ now: () => now });
    tracker.start("req-1", USER_A, ["greenhouse"]);

    now += PROGRESS_RETENTION_MS - 1;
    expect(tracker.get("req-1", USER_A)).toBeDefined();

    now += 2;
    expect(tracker.get("req-1", USER_A)).toBeUndefined();
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

    tracker.start("abandoned-1", USER_A, ["greenhouse"]);
    tracker.start("abandoned-2", USER_A, ["lever"]);
    // Neither abandoned id is ever read again -- simulating a caller that
    // mints a progress id and never polls it.
    expect(tracker.size).toBe(2);

    now += PROGRESS_RETENTION_MS + 1;
    // A brand-new estimate starts well after the abandoned ones expired.
    // Its own start() call should sweep them out as a side effect, with
    // no `get()` call on the abandoned ids anywhere in this test.
    tracker.start("new-run", USER_A, ["ashby"]);

    // Only "new-run" should remain -- both abandoned entries were removed
    // by start()'s sweep itself, not merely rendered unreadable by get().
    expect(tracker.size).toBe(1);
    expect(tracker.get("new-run", USER_A)).toMatchObject({ total: 1, completed: 0 });
  });

  describe("per-user isolation (ticket 3fc1e5e)", () => {
    // `estimateRequestId` is CLIENT-minted and accepts any string of length
    // 1-200 (routes/searches.ts's `estimateSearchBodySchema`), so unlike
    // every other id in this app it is NOT unguessable unless the client
    // chooses to make it one. Two clients sending "1" is all it takes, which
    // is what makes this the one route whose scope is a map key rather than a
    // SQL predicate. Both halves of the old failure are pinned below.
    const SHARED_ID = "1";

    it("user A cannot READ user B's progress record for an identical requestId", () => {
      const tracker = new EstimateProgressTracker();
      tracker.start(SHARED_ID, USER_B, ["greenhouse", "lever"]);
      tracker.markSourceSettled(SHARED_ID, USER_B, "greenhouse");

      // B's record is real and readable BY B...
      expect(tracker.get(SHARED_ID, USER_B)).toMatchObject({ total: 2, completed: 1 });
      // ...and simply does not exist for A, who gets the ordinary
      // "nothing to report" undefined (a 404 at the route), with no way to
      // tell "that id is someone else's" from "never started".
      expect(tracker.get(SHARED_ID, USER_A)).toBeUndefined();
    });

    it("user B starting the same requestId does not CLOBBER user A's live record", () => {
      const tracker = new EstimateProgressTracker();
      tracker.start(SHARED_ID, USER_A, ["greenhouse", "lever", "ashby"]);
      tracker.markSourceSettled(SHARED_ID, USER_A, "greenhouse");

      // B starts an unrelated estimate that happens to reuse the id, with a
      // different source selection. Under the old requestId-only key this
      // OVERWROTE A's entry, so A's own poller began reporting B's sources
      // and B's progress as if they were A's -- a wrong answer to the user
      // who owns the request, not merely a leak of someone else's data.
      tracker.start(SHARED_ID, USER_B, ["usajobs"]);

      // A still sees A's own run, untouched: 3 sources, 1 settled.
      expect(tracker.get(SHARED_ID, USER_A)).toMatchObject({ total: 3, completed: 1 });
      expect(tracker.get(SHARED_ID, USER_A)?.sources.map((s) => s.sourceId)).toEqual([
        "greenhouse",
        "lever",
        "ashby",
      ]);
      // And B sees B's own, coexisting rather than replacing.
      expect(tracker.get(SHARED_ID, USER_B)).toMatchObject({ total: 1, completed: 0 });
      expect(tracker.size).toBe(2);
    });

    it("a settle notification from user B never advances user A's identically-named run", () => {
      const tracker = new EstimateProgressTracker();
      tracker.start(SHARED_ID, USER_A, ["greenhouse"]);

      tracker.markSourceSettled(SHARED_ID, USER_B, "greenhouse");

      // A's own source is still pending -- B's callback reached B's
      // (nonexistent) entry, not A's.
      expect(tracker.get(SHARED_ID, USER_A)).toMatchObject({ completed: 0, done: false });
    });
  });
});
