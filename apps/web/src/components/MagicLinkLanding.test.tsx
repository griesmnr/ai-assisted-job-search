// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MagicLinkLanding, readMagicLinkTokenFromUrl } from "./MagicLinkLanding";
import { writeAppState } from "../session";

/**
 * Ticket 9f06f8f: the landing view the emailed link opens to -- the one place
 * this app adopts an identity it did not mint itself.
 *
 * `../navigation` is mocked because jsdom does not implement navigation (see
 * navigation.ts's own doc comment for why that seam exists at all). `../api/
 * client` is mocked as every component test here does. `../identity` and
 * `../session` are REAL: both are thin wrappers over `localStorage`/
 * `sessionStorage`, which jsdom provides for real, so the storage-level
 * consequences of a sign-in (the adopted id, the remembered email, the
 * cleared app state) are asserted against actual storage rather than against
 * a stub that could drift from the module under test.
 */
const verifyMagicLink = vi.fn();
const reloadTo = vi.fn();
const reloadCurrent = vi.fn();

vi.mock("../api/client", () => ({
  verifyMagicLink: (...args: unknown[]) => verifyMagicLink(...args),
  // The real implementation, duplicated rather than imported, because this
  // factory cannot reference the module it is replacing. Kept in step with
  // client.ts by the shape of what the tests below feed it.
  magicLinkRejectionReason: (err: unknown) => {
    if (typeof err !== "object" || err === null) return undefined;
    const body = (err as { body?: unknown }).body;
    if (typeof body !== "object" || body === null) return undefined;
    const reason = (body as { reason?: unknown }).reason;
    return [
      "invalid",
      "expired",
      "already_used",
      "browser_already_claimed",
      "different_browser",
    ].find((candidate) => candidate === reason);
  },
  // Ticket c719af2, review round 2: real `client.ts` assigns `status: 0`
  // in exactly one place (the `catch` around `fetch` itself, when no
  // `Response` was ever received), so "the POST never got a response at
  // all" is the only thing this returns `true` for.
  neverLanded: (err: unknown) => {
    if (typeof err !== "object" || err === null) return false;
    return (err as { status?: unknown }).status === 0;
  },
}));

vi.mock("../navigation", () => ({
  reloadTo: (...args: unknown[]) => reloadTo(...args),
  reloadCurrent: () => reloadCurrent(),
}));

const ADOPTED_USER_ID = "99999999-9999-4999-8999-999999999999";
const OWN_USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  window.history.replaceState(null, "", "/#magicLinkToken=tok_abc123");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

/** A rejection shaped like the one `client.ts` throws for an adjudicated
 * refusal: an `ApiError`-like object whose `body` carries the reason code. */
function rejection(reason: string, message: string): Error & { body: unknown } {
  return Object.assign(new Error(message), { status: 400, body: { error: message, reason } });
}

/**
 * A rejection shaped like the one `client.ts`'s `request()` throws when
 * `fetch` itself rejects -- `new ApiError(0, ...)`, no `body`. `status: 0`
 * is the field the mocked `neverLanded` above (and the real one in
 * client.ts) keys on; ticket c719af2 review round 2 flagged that the
 * PREVIOUS version of this test used a bare `Error` with no `status` at
 * all, which would pass today's assertions for the wrong reason -- any
 * `status` other than exactly `0` must NOT read as a transport failure.
 */
function transportRejection(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 0 });
}

describe("readMagicLinkTokenFromUrl", () => {
  it("finds the token in the fragment, and reports none once it is gone", () => {
    expect(readMagicLinkTokenFromUrl()).toBe("tok_abc123");

    window.history.replaceState(null, "", "/");
    expect(readMagicLinkTokenFromUrl()).toBeUndefined();
  });

  it("treats an empty parameter as absent", () => {
    window.history.replaceState(null, "", "/#magicLinkToken=");
    expect(readMagicLinkTokenFromUrl()).toBeUndefined();
  });

  /**
   * REVIEW ROUND 4, F2: the token lives in the FRAGMENT, which no server ever
   * receives, precisely so the static host serving this bundle cannot log a
   * live credential. Reading a query parameter too would quietly re-open that
   * hole the moment anything produced a `?`-shaped link again, so this pins
   * fragment-only -- a query-string token is not a sign-in link here.
   */
  it("ignores a token in the query string -- the fragment is the only place it lives", () => {
    window.history.replaceState(null, "", "/?magicLinkToken=tok_in_the_query");
    expect(readMagicLinkTokenFromUrl()).toBeUndefined();
  });

  it("keeps any other fragment parameter when stripping the token", async () => {
    window.history.replaceState(null, "", "/#keep=me&magicLinkToken=tok_abc123");
    verifyMagicLink.mockResolvedValue({
      userId: ADOPTED_USER_ID,
      email: "alice@example.com",
      outcome: "adopted",
    });

    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("heading", { name: /you're signed in/i });

    // Ticket bb2f275: a successful verification also bakes in the "land on
    // Already Scored Jobs" marker (see that ticket) -- `keep=me` survives
    // alongside it, which is the actual property this test is about.
    expect(window.location.hash).toBe("#keep=me&landOnScoredTab=1");
  });
});

describe("MagicLinkLanding -- success", () => {
  it("adopts the returned identity, remembers the email, and strips the token from the URL", async () => {
    // "Claiming my anonymous session": the id is UNCHANGED, so nothing
    // cached belongs to someone else.
    localStorage.setItem("jobsearch.web.userId.v1", OWN_USER_ID);
    verifyMagicLink.mockResolvedValue({
      userId: OWN_USER_ID,
      email: "alice@example.com",
      outcome: "attached",
    });

    render(<MagicLinkLanding token="tok_abc123" />);

    await screen.findByRole("heading", { name: /you're signed in/i });
    expect(verifyMagicLink).toHaveBeenCalledWith("tok_abc123");
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBe(OWN_USER_ID);
    expect(localStorage.getItem("jobsearch.web.userEmail.v1")).toBe("alice@example.com");

    // THE CREDENTIAL IS OUT OF THE URL. A single-use token must not survive
    // in the address bar or in browser history once it has been redeemed.
    // Ticket bb2f275: the ONLY thing left in the fragment is the "land on
    // Already Scored Jobs" marker a successful verification bakes in --
    // never the token itself.
    expect(window.location.hash).toBe("#landOnScoredTab=1");
  });

  it("does NOT reset persisted app state when the id is unchanged -- an in-progress search survives claiming it", async () => {
    localStorage.setItem("jobsearch.web.userId.v1", OWN_USER_ID);
    writeAppState({
      resumeId: "resume-1",
      resumeText: "text",
      resumeNickname: "Resume 1",
      selectedSourceIds: ["usajobs"],
      titleChips: [],
      criteriaForm: {
        nearLocations: "",
        expandMetroAreas: false,
        remoteOk: true,
        anyLocationOk: false,
        commitmentIn: [],
      },
      scoreFloor: 55,
    });
    const before = sessionStorage.length;
    expect(before).toBeGreaterThan(0);

    verifyMagicLink.mockResolvedValue({
      userId: OWN_USER_ID,
      email: "alice@example.com",
      outcome: "attached",
    });
    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("heading", { name: /you're signed in/i });

    // Same person, one identity that gained an email -- there is nothing to
    // migrate and nothing to throw away.
    expect(sessionStorage.length).toBe(before);
    expect(
      screen.queryByText(/this browser is now signed in to the account/i),
    ).not.toBeInTheDocument();
  });

  it("switches identity AND clears persisted app state when the returned id is different", async () => {
    localStorage.setItem("jobsearch.web.userId.v1", OWN_USER_ID);
    writeAppState({
      resumeId: "resume-owned-by-the-old-anonymous-user",
      resumeText: "text",
      resumeNickname: "Resume 1",
      selectedSourceIds: ["usajobs"],
      titleChips: [],
      criteriaForm: {
        nearLocations: "",
        expandMetroAreas: false,
        remoteOk: true,
        anyLocationOk: false,
        commitmentIn: [],
      },
      scoreFloor: 55,
    });
    expect(sessionStorage.length).toBeGreaterThan(0);

    // "Logging in from a second device": the server hands back a DIFFERENT
    // user.
    verifyMagicLink.mockResolvedValue({
      userId: ADOPTED_USER_ID,
      email: "alice@example.com",
      outcome: "adopted",
    });

    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("heading", { name: /you're signed in/i });

    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBe(ADOPTED_USER_ID);
    // THE POINT OF THIS TEST: a `resumeId` cached for the identity we just
    // left names a row the adopted user does not own. Keeping it would
    // render another account's leftovers as this account's own resume, and
    // every fetch for it would 404.
    expect(sessionStorage.length).toBe(0);
    // And the user is told their view changed, rather than silently seeing
    // someone else's resumes.
    expect(screen.getByText(/this browser is now signed in to the account/i)).toBeInTheDocument();
  });

  /**
   * Ticket a90095b: this used to assert `reloadTo` was called with a URL
   * containing the marker -- and passed, while the button was DEAD in a real
   * browser. Nicole, testing: "Continue to your results button unfortunately
   * is not doing anything."
   *
   * The reason the old assertion could not see it: the success handler had
   * already `replaceState`d the URL to exactly the string being passed to
   * `reloadTo`, and navigating to a URL identical to the current one
   * (fragment included) is a same-document fragment navigation -- no reload.
   * jsdom implements no navigation at all, so "was called with the right
   * URL" and "the browser actually goes somewhere" are indistinguishable
   * here. That gap is precisely why `navigation.ts` exists as a mockable
   * seam, and it is a permanent limit of this file, not something this test
   * closes.
   *
   * So the assertions moved to where the guarantee now lives: `reloadCurrent`
   * (a real `location.reload()`), `reloadTo` NOT called, and the destination
   * proven on `window.location` -- the URL the reload will preserve -- rather
   * than on an argument.
   */
  it("reloads the current URL on Continue, with the token gone and the scored-tab marker already in place", async () => {
    verifyMagicLink.mockResolvedValue({
      userId: ADOPTED_USER_ID,
      email: "alice@example.com",
      outcome: "adopted",
    });
    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("heading", { name: /you're signed in/i });

    fireEvent.click(screen.getByRole("button", { name: /continue to your results/i }));

    expect(reloadCurrent).toHaveBeenCalledTimes(1);
    // A `reloadTo` here would be the regression: same-URL navigation, no
    // reload, dead button.
    expect(reloadTo).not.toHaveBeenCalled();
    // The destination lives in the URL being reloaded, not on an argument.
    expect(window.location.href).not.toContain("magicLinkToken");
    // Ticket bb2f275: a successful "Continue" carries the "land on Already
    // Scored Jobs" marker App.tsx reads on its next mount.
    expect(window.location.href).toContain("landOnScoredTab=1");
  });

  /**
   * THE STRICTMODE DEFECT THIS GUARD EXISTS FOR, pinned. `main.tsx` wraps the
   * app in `StrictMode`, which mounts, unmounts and re-mounts every component
   * once in development. Without the `startedRef` guard, that redeems the
   * token TWICE -- and the second attempt comes back `already_used`, so a
   * perfectly good sign-in reports itself as broken, in dev, for the one flow
   * that is hardest to retry.
   */
  it("redeems the token EXACTLY ONCE under StrictMode's double mount", async () => {
    verifyMagicLink.mockResolvedValue({
      userId: ADOPTED_USER_ID,
      email: "alice@example.com",
      outcome: "adopted",
    });

    render(
      <StrictMode>
        <MagicLinkLanding token="tok_abc123" />
      </StrictMode>,
    );

    await screen.findByRole("heading", { name: /you're signed in/i });
    expect(verifyMagicLink).toHaveBeenCalledTimes(1);
  });
});

describe("MagicLinkLanding -- refusals", () => {
  it("shows the server's own specific message for an expired link, and offers a way onward", async () => {
    verifyMagicLink.mockRejectedValue(
      rejection(
        "expired",
        "That sign-in link expired 3 minutes ago. Request a new one to sign in.",
      ),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/expired 3 minutes ago/i);
    // Not a dead end: the results are still there, unsigned-in.
    expect(
      screen.getByRole("button", { name: /continue without signing in/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing you've already searched has been lost/i)).toBeInTheDocument();
    // No identity was adopted on a refusal.
    expect(localStorage.getItem("jobsearch.web.userEmail.v1")).toBeNull();
    // A spent link comes out of the URL like a successful one.
    expect(window.location.hash).toBe("");
  });

  // Ticket bb2f275: landing on "Already Scored Jobs" only makes sense once
  // there IS a verified identity to show results for -- a refusal must NOT
  // carry the marker forward.
  it("does NOT carry the 'land on Already Scored Jobs' marker on Continue after a refusal", async () => {
    verifyMagicLink.mockRejectedValue(
      rejection("expired", "That sign-in link expired. Request a new one to sign in."),
    );

    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: /continue without signing in/i }));

    expect(reloadTo).toHaveBeenCalledTimes(1);
    expect(reloadTo.mock.calls[0]![0]).not.toContain("landOnScoredTab");
  });

  it("shows the reused-link message for a replayed token", async () => {
    verifyMagicLink.mockRejectedValue(
      rejection(
        "already_used",
        "That sign-in link has already been used. Sign-in links work only once — request a new one.",
      ),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/already been used/i);
  });

  it("explains the already-claimed-browser refusal without adopting anything", async () => {
    verifyMagicLink.mockRejectedValue(
      rejection(
        "browser_already_claimed",
        "This browser is already signed in as first@example.com. Open this link in a different browser (or a private window) to sign in as second@example.com.",
      ),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already signed in as first@example/i,
    );
    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBeNull();
  });

  /**
   * REVIEW ROUND 4, F1. The refusal that closes account fixation: a link
   * redeemed somewhere other than the browser that asked for it, for an
   * address with no account yet. The copy matters more here than for any other
   * reason code, because this is the ONE refusal a completely innocent user can
   * hit (they asked on their phone and clicked on their laptop) -- and their
   * recovery is NOT "ask for a new link", since this link was never spent.
   */
  it("explains the different-browser refusal, adopts nothing, and says the link is still good", async () => {
    verifyMagicLink.mockRejectedValue(
      rejection(
        "different_browser",
        "Open this sign-in link in the browser you asked for it from. Once your email address is attached there, you can sign in from any other browser or device.",
      ),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/browser you asked for it from/i);
    // Not the generic spent-link note: this link still works elsewhere.
    expect(screen.getByText(/this link hasn't been used up/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/you can ask for a new link from the bottom of your results/i),
    ).not.toBeInTheDocument();
    // NOTHING was adopted -- the whole point of the server-side refusal is
    // that this browser does not become somebody else's account.
    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBeNull();
    expect(localStorage.getItem("jobsearch.web.userEmail.v1")).toBeNull();
  });

  /**
   * A transport failure is the one refusal that is NOT adjudicated: the token
   * has not been consumed, so the link is still worth retrying -- which means
   * it must stay in the URL, unlike every spent-token case above.
   *
   * Ticket c719af2, review round 2: this is the ONLY case `transportFailure`
   * is true for, and it is a real invariant now, not a guess -- real
   * `client.ts` assigns `status: 0` in exactly one place (the `catch` around
   * `fetch` itself, when no `Response` was ever received), so
   * `transportRejection()` (carrying `status: 0`, no `body`) is what that
   * case actually looks like. The PREVIOUS version of this test used a bare
   * `Error` with no `status` field at all, which happened to pass the same
   * assertions for the wrong reason (the old code treated `reason ===
   * undefined` alone as proof of a transport failure) -- `status: 0` is the
   * one thing that still has to be true here once that bug is fixed.
   */
  it("keeps the token in the URL when the API was simply unreachable, and says the link is still good", async () => {
    verifyMagicLink.mockRejectedValue(
      transportRejection("Could not reach the API at http://localhost:3000: fetch failed"),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the api/i);
    expect(
      screen.getByText(/still worth trying again once you're back online/i),
    ).toBeInTheDocument();
    // Not the spent-token recovery note -- the token here was never touched.
    expect(
      screen.queryByText(/you can ask for a new link from the bottom of your results/i),
    ).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#magicLinkToken=tok_abc123");
  });

  /**
   * TICKET c719af2. The server returns 200 -- `claimAndResolve`'s conditional
   * UPDATE committed, so the token IS spent -- and `setUserId` then throws on
   * the malformed `userId` inside that 200 body. Before this ticket, this
   * case was indistinguishable from a transport failure (both leave
   * `magicLinkRejectionReason` undefined) and rendered "it's still worth
   * trying again once you're back online" -- which invited a retry that was
   * guaranteed to end in `already_used`, since the token was already gone by
   * the time the panel rendered.
   *
   * This pins BOTH halves: the alert text proves this is the malformed-id
   * path (not a mislabelled transport failure), and the explicit absence of
   * the transport-failure copy -- replaced by the same "ask for a new link"
   * note every other spent-token refusal uses -- proves the panel no longer
   * claims this link can be used again.
   */
  it("tells the user to request a new link -- not to retry -- when a 200 response carries a malformed userId", async () => {
    verifyMagicLink.mockResolvedValue({
      userId: "not-a-uuid",
      email: "alice@example.com",
      outcome: "adopted",
    });

    render(<MagicLinkLanding token="tok_abc123" />);

    // Presents as one failed verification, not as "the whole app broke after
    // signing in" -- which is what storing an id the API rejects would look
    // like on every subsequent request.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('Refusing to adopt a malformed user id: "not-a-uuid"');
    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBeNull();
    expect(localStorage.getItem("jobsearch.web.userEmail.v1")).toBeNull();

    // THE BUG: this must NOT say the link is still usable. The token was
    // already spent server-side (the 200 is proof) before this client-side
    // throw ever happened.
    expect(
      screen.queryByText(/still worth trying again once you're back online/i),
    ).not.toBeInTheDocument();
    // THE FIX: the same honest "request a new one" recovery every other
    // spent-token refusal gets.
    expect(
      screen.getByText(/you can ask for a new link from the bottom of your results/i),
    ).toBeInTheDocument();
  });

  /**
   * TICKET c719af2, REVIEW ROUND 2 (F1 -- blocking). Opus's adversarial
   * review reproduced a second way to land on `reason === undefined`
   * without a transport failure: `client.ts`'s `request()` does
   * `await response.text()` then `JSON.parse(text)` OUTSIDE any try/catch
   * on the ok-response branch. A 200 whose body isn't valid JSON (a
   * captive portal or proxy answering 200 with an HTML page; a connection
   * reset after the status line but before the body finishes) makes
   * `JSON.parse` throw a bare `SyntaxError` -- `verifyMagicLink`'s promise
   * REJECTS, `.then` never runs, and the rejection has no `status` field at
   * all (it isn't an `ApiError`), so the fix built only around "did
   * `verifyMagicLink` resolve" would have missed this: the promise never
   * resolved here EITHER, yet the 2xx status line alone already proves
   * `claimAndResolve`'s transaction committed (routes/auth.ts) -- the token
   * is just as spent as the malformed-userId case above, by a route with no
   * response schema to stop it from answering 200 with something unparseable
   * in the first place.
   *
   * This is what actually exercises `neverLanded`'s negative case end to
   * end: a rejection with NO `status` property at all (not `0`, not `400`,
   * not `500` -- simply absent, exactly like a real `SyntaxError`), which
   * must NOT read as "never landed" the way `transportRejection()`'s
   * `status: 0` does.
   */
  it("tells the user to request a new link -- not to retry -- when a 200 response's body fails to parse", async () => {
    verifyMagicLink.mockRejectedValue(new SyntaxError("Unexpected token < in JSON at position 0"));

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/unexpected token/i);

    // THE BUG (F1): an unparseable 200 body must not be told the link still
    // works -- the status line alone already proves the token is spent.
    expect(
      screen.queryByText(/still worth trying again once you're back online/i),
    ).not.toBeInTheDocument();
    // THE FIX: the same honest "request a new one" recovery every other
    // spent-token refusal gets.
    expect(
      screen.getByText(/you can ask for a new link from the bottom of your results/i),
    ).toBeInTheDocument();
    // And the dead token must come OUT of the URL -- otherwise a reload
    // resubmits it and it comes back `already_used`, which is the "reads as
    // a second, unrelated bug" symptom the ticket describes.
    expect(window.location.hash).not.toContain("magicLinkToken");
  });

  it("shows a spinner-equivalent while the verification is in flight", async () => {
    verifyMagicLink.mockReturnValue(new Promise(() => {}));

    render(<MagicLinkLanding token="tok_abc123" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /signing you in/i })).toBeInTheDocument();
    });
  });
});
