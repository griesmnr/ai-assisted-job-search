// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ticket dba885e: `getUserId()` mints a UUID once, persists it to
 * `localStorage` (not `sessionStorage` -- see identity.ts's own doc
 * comment for why this needs to outlive a tab close), and reuses it on
 * every subsequent call, including across a fresh module load (the
 * closest thing to "a real page reload" this test can simulate, since
 * `getUserId`'s own in-memory cache would otherwise mask a bug where it
 * silently stopped reading from storage at all).
 */
describe("getUserId (ticket dba885e)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("mints a real UUID on first call and persists it to localStorage", async () => {
    const { getUserId } = await import("./identity");
    const id = getUserId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(window.localStorage.getItem("userId")).toBe(id);
  });

  it("returns the SAME id on a second call within the same module instance", async () => {
    const { getUserId } = await import("./identity");
    const first = getUserId();
    const second = getUserId();

    expect(second).toBe(first);
  });

  // The real test: a fresh module load (vi.resetModules) is the closest
  // simulation of a page reload available here -- it discards
  // identity.ts's in-memory `cached` variable entirely, so this only
  // passes if the id genuinely came back out of localStorage rather than
  // surviving by accident via the module-level cache.
  it("survives a fresh module load (simulating a page reload) by reading back from localStorage", async () => {
    const first = await import("./identity");
    const original = first.getUserId();

    vi.resetModules();

    const second = await import("./identity");
    const reloaded = second.getUserId();

    expect(reloaded).toBe(original);
  });

  it("does not mint a new id if localStorage already holds one from a previous visit", async () => {
    const existing = "99999999-9999-4999-8999-999999999999";
    window.localStorage.setItem("userId", existing);

    const { getUserId } = await import("./identity");

    expect(getUserId()).toBe(existing);
  });
});
