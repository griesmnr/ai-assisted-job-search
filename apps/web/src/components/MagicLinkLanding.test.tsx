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
    return ["invalid", "expired", "already_used", "browser_already_claimed"].find(
      (candidate) => candidate === reason,
    );
  },
}));

vi.mock("../navigation", () => ({
  reloadTo: (...args: unknown[]) => reloadTo(...args),
}));

const ADOPTED_USER_ID = "99999999-9999-4999-8999-999999999999";
const OWN_USER_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  window.history.replaceState(null, "", "/?magicLinkToken=tok_abc123");
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

describe("readMagicLinkTokenFromUrl", () => {
  it("finds the token, and reports none once the parameter is gone", () => {
    expect(readMagicLinkTokenFromUrl()).toBe("tok_abc123");

    window.history.replaceState(null, "", "/");
    expect(readMagicLinkTokenFromUrl()).toBeUndefined();
  });

  it("treats an empty parameter as absent", () => {
    window.history.replaceState(null, "", "/?magicLinkToken=");
    expect(readMagicLinkTokenFromUrl()).toBeUndefined();
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
    expect(window.location.search).toBe("");
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

  it("reloads to the token-free URL on Continue", async () => {
    verifyMagicLink.mockResolvedValue({
      userId: ADOPTED_USER_ID,
      email: "alice@example.com",
      outcome: "adopted",
    });
    render(<MagicLinkLanding token="tok_abc123" />);
    await screen.findByRole("heading", { name: /you're signed in/i });

    fireEvent.click(screen.getByRole("button", { name: /continue to your results/i }));

    expect(reloadTo).toHaveBeenCalledTimes(1);
    expect(reloadTo.mock.calls[0]![0]).not.toContain("magicLinkToken");
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
    expect(window.location.search).toBe("");
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
   * A transport failure is the one refusal that is NOT adjudicated: the token
   * has not been consumed, so the link is still worth retrying -- which means
   * it must stay in the URL, unlike every spent-token case above.
   */
  it("keeps the token in the URL when the API was simply unreachable, and says the link is still good", async () => {
    verifyMagicLink.mockRejectedValue(
      new Error("Could not reach the API at http://localhost:3000: fetch failed"),
    );

    render(<MagicLinkLanding token="tok_abc123" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the api/i);
    expect(
      screen.getByText(/still worth trying again once you're back online/i),
    ).toBeInTheDocument();
    expect(window.location.search).toBe("?magicLinkToken=tok_abc123");
  });

  it("refuses a malformed user id rather than storing one the API would reject on every request", async () => {
    verifyMagicLink.mockResolvedValue({
      userId: "not-a-uuid",
      email: "alice@example.com",
      outcome: "adopted",
    });

    render(<MagicLinkLanding token="tok_abc123" />);

    // Presents as one failed verification, not as "the whole app broke after
    // signing in" -- which is what storing an id the API rejects would look
    // like on every subsequent request.
    expect(await screen.findByRole("alert")).toHaveTextContent(/malformed user id/i);
    expect(localStorage.getItem("jobsearch.web.userId.v1")).toBeNull();
    expect(localStorage.getItem("jobsearch.web.userEmail.v1")).toBeNull();
  });

  it("shows a spinner-equivalent while the verification is in flight", async () => {
    verifyMagicLink.mockReturnValue(new Promise(() => {}));

    render(<MagicLinkLanding token="tok_abc123" />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /signing you in/i })).toBeInTheDocument();
    });
  });
});
