// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "jobsearch.web.userId.v1";

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
    vi.restoreAllMocks();
  });

  it("mints a real UUID on first call and persists it to localStorage", async () => {
    const { getUserId } = await import("./identity");
    const id = getUserId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(id);
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
    window.localStorage.setItem(STORAGE_KEY, existing);

    const { getUserId } = await import("./identity");

    expect(getUserId()).toBe(existing);
  });

  // Review fix (S1). A stray, non-UUID value under this key -- most
  // plausibly left by an unrelated local project sharing this origin
  // (localhost:5173), or hand-edited storage -- must not be sent to the
  // server as-is: apps/api/src/identity.ts would reject it every single
  // request, forever, with no self-recovery. Re-minting is the correct
  // response, same as "nothing stored at all".
  it("re-mints a fresh id if the stored value doesn't look like a real UUID", async () => {
    window.localStorage.setItem(STORAGE_KEY, "not-a-real-uuid");

    const { getUserId } = await import("./identity");
    const id = getUserId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(id).not.toBe("not-a-real-uuid");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(id);
  });

  // Review fix (S1). session.ts's own readRaw/writeRaw already established
  // that `localStorage` can throw on ACCESS, not just on write, in a
  // browser configured to block site data -- without a guard, that throw
  // used to propagate out of client.ts's own try/catch as a misleading
  // "Could not reach the API" message on every request, for a failure
  // that has nothing to do with the network.
  it("still returns a usable id for this page load even if localStorage.getItem throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    const { getUserId } = await import("./identity");
    const id = getUserId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // Still cached/reusable for the rest of this page load even though
    // nothing could be persisted.
    expect(getUserId()).toBe(id);
  });

  it("still returns a usable id for this page load even if localStorage.setItem throws (e.g. quota exceeded)", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const { getUserId } = await import("./identity");

    expect(getUserId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

/**
 * Ticket 9f06f8f: adopting a SERVER-resolved identity, and remembering the
 * verified email. Same `vi.resetModules()` discipline as above -- the module's
 * in-memory `cached` would otherwise mask whether storage was really written.
 */
const EMAIL_KEY = "jobsearch.web.userEmail.v1";
const ADOPTED = "99999999-9999-4999-8999-999999999999";

describe("setUserId (ticket 9f06f8f)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("replaces a self-minted id, persists the new one, and reports that it CHANGED", async () => {
    const { getUserId, setUserId } = await import("./identity");
    const minted = getUserId();

    const changed = setUserId(ADOPTED);

    expect(changed).toBe(true);
    expect(getUserId()).toBe(ADOPTED);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(ADOPTED);
    expect(ADOPTED).not.toBe(minted);
  });

  it("reports NOT changed when the server hands back the id this browser already had", async () => {
    // The "claiming my anonymous session" case -- the caller branches on this
    // to decide whether cached app state still belongs to this user.
    const existing = "11111111-1111-4111-8111-111111111111";
    window.localStorage.setItem(STORAGE_KEY, existing);
    const { setUserId } = await import("./identity");

    expect(setUserId(existing)).toBe(false);
  });

  it("survives a module reload, the same way a minted id does", async () => {
    const { setUserId } = await import("./identity");
    setUserId(ADOPTED);

    vi.resetModules();
    const { getUserId } = await import("./identity");

    expect(getUserId()).toBe(ADOPTED);
  });

  it("REFUSES a malformed id rather than storing one the API would reject on every request", async () => {
    const existing = "11111111-1111-4111-8111-111111111111";
    window.localStorage.setItem(STORAGE_KEY, existing);
    const { getUserId, setUserId } = await import("./identity");

    expect(() => setUserId("not-a-uuid")).toThrow(/malformed user id/i);
    // The browser's existing, working identity is left completely untouched:
    // a bad adoption must present as one failed sign-in, never as "the whole
    // app broke afterwards".
    expect(getUserId()).toBe(existing);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(existing);
  });
});

describe("getVerifiedEmail / setVerifiedEmail (ticket 9f06f8f)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips through localStorage, and is undefined before anything is verified", async () => {
    const { getVerifiedEmail, setVerifiedEmail } = await import("./identity");

    expect(getVerifiedEmail()).toBeUndefined();
    setVerifiedEmail("alice@example.com");
    expect(getVerifiedEmail()).toBe("alice@example.com");
    expect(window.localStorage.getItem(EMAIL_KEY)).toBe("alice@example.com");
  });

  it("reads blocked storage as 'nothing verified' rather than throwing into the caller", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked by policy");
    });
    const { getVerifiedEmail } = await import("./identity");

    // Review fix S1's rule, applied to this key too: a storage THROW must
    // never surface as a broken page -- the prompt simply reappears, which is
    // the honest consequence of unavailable storage (the user id is gone with
    // it, so this genuinely IS a new anonymous visitor).
    expect(getVerifiedEmail()).toBeUndefined();
  });

  it("does not throw when storage cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const { setVerifiedEmail } = await import("./identity");

    expect(() => setVerifiedEmail("alice@example.com")).not.toThrow();
  });
});
