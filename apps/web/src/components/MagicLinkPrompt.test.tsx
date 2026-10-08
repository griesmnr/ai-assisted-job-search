// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MagicLinkPrompt } from "./MagicLinkPrompt";

/**
 * Ticket 9f06f8f: the post-results sign-in prompt.
 *
 * `../api/client` is mocked wholesale, the same way every other component
 * test in this directory mocks it -- nothing here touches the network. The
 * real identity module is NOT mocked: it reads `localStorage`, which jsdom
 * provides for real, so the "already signed in" branch is exercised through
 * the actual storage key rather than through a stub that could drift from it.
 */
const requestMagicLink = vi.fn();

vi.mock("../api/client", () => ({
  requestMagicLink: (...args: unknown[]) => requestMagicLink(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("MagicLinkPrompt", () => {
  it("offers the email as a choice, not a wall, with a single-sentence pitch (ticket d3a95d1)", async () => {
    render(<MagicLinkPrompt />);

    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
    // Ticket d3a95d1, Nicole (live, once this became a compact floating
    // element): trimmed to one sentence -- the longer "no password /
    // nothing hidden behind it" reassurance is gone. "Not now" being a
    // real, equally-weighted option is what still carries the "not a
    // wall" framing, not the removed sentence.
    // Ticket f199f55, Nicole (live): reworded to name the actual
    // mechanism -- the email ties to the results permanently, rather than
    // implying THIS specific link is what "brings you back" (the exact
    // framing that led to her "why does it expire, then?" confusion).
    expect(
      screen.getByText(/ties these results to your email so that you can get them back anytime/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/already saved to this browser/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not now/i })).toBeInTheDocument();
  });

  it("sends the link and shows the 'check your inbox' state naming the address the server actually mailed", async () => {
    // The SERVER's normalized echo, deliberately different from what is typed
    // here -- the confirmation must name the address the mail really went to,
    // not the raw input.
    requestMagicLink.mockResolvedValue({
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "  Alice@Example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    });
    expect(requestMagicLink).toHaveBeenCalledWith("Alice@Example.com");
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    // Never claims delivery, only that it was sent -- the provider accepting
    // a message is not an inbox receiving it.
    expect(screen.getByText(/we sent a sign-in link/i)).toBeInTheDocument();
    // Ticket f199f55, Nicole (live): the "nothing is lost if you ignore
    // it" reassurance is gone -- her own reasoning was that having it
    // right next to the call to action undercuts the point of sending the
    // link at all.
    expect(screen.queryByText(/nothing is lost if you ignore it/i)).not.toBeInTheDocument();
  });

  /**
   * Ticket a3062b4. Most addresses typed into THIS prompt are brand new to
   * the app, which takes `resolveIdentity`'s ATTACH branch
   * (`apps/api/src/routes/auth.ts`) -- and that branch's `different_browser`
   * check refuses a verification from any browser but the one that asked.
   * The confirmation used to say "open it on any device", which told most of
   * this prompt's users to do the one thing the server would refuse. The
   * replacement, "open it in this browser", is pinned the same way
   * `SignInRecovery.test.tsx` already pins its own copy of that sentence.
   *
   * MUTATION CHECK (reported, not asserted in code): reverting
   * `sentFactsLine()` in `MagicLinkForm.tsx` to drop "Open it in this
   * browser." turns this red (no element contains that text any more) while
   * leaving every other test in this file green -- confirming this is the
   * one test actually pinning the fix.
   */
  it("tells the user to open the link in this browser, not on any device (ticket a3062b4)", async () => {
    requestMagicLink.mockResolvedValue({
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
    await screen.findByRole("heading", { name: /check your inbox/i });

    expect(screen.getByText(/open it in this browser/i)).toBeInTheDocument();
    expect(screen.queryByText(/any device/i)).not.toBeInTheDocument();
    // Owned by `MagicLinkForm`, same as `SignInRecovery` -- the expiry
    // wording must not drift per-caller (ticket f199f55).
    expect(screen.getByText(/works once and expires in about 15 minutes/i)).toBeInTheDocument();
  });

  it("returns to the form (not a silent re-send) when the mail didn't arrive", async () => {
    requestMagicLink.mockResolvedValue({
      email: "typo@exmaple.com",
      expiresAt: new Date().toISOString(),
    });
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "typo@exmaple.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
    await screen.findByRole("heading", { name: /check your inbox/i });

    fireEvent.click(screen.getByRole("button", { name: /use a different address/i }));

    // Back to the editable field with the typo still visible to fix -- the
    // whole reason this is not a "resend" button.
    expect(screen.getByLabelText(/email address/i)).toHaveValue("typo@exmaple.com");
    expect(requestMagicLink).toHaveBeenCalledTimes(1);
  });

  it("surfaces a send failure and clears it as soon as the user edits the address", async () => {
    // Ticket 43423eb: the server no longer promises a retry will succeed
    // (CAUSE CONFIRMED: Jay's deployed failure was a permanent Resend 403,
    // not a transient one, so "try again in a moment" was false) -- it
    // says only that the failure was logged, which auth.ts:287's
    // `request.log.error` makes true unconditionally.
    requestMagicLink.mockRejectedValue(
      new Error(
        "Could not send the sign-in email just now. The failure has been logged on our end.",
      ),
    );
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/failure has been logged/i);
    expect(alert).not.toHaveTextContent(/try again/i);
    // Fix F1 (review round, ticket 43423eb): `MagicLinkForm` used to
    // prefix every message with "Could not send the link:", which against
    // THIS message stuttered into "Could not send the link: Could not
    // send the sign-in email just now..." -- the exact doubled wording
    // Nicole read aloud off her own screen when she filed this ticket.
    // `toHaveTextContent` has NO `exact` option (jest-dom; that option
    // belongs to `getByText`) -- passing one is silently ignored and the
    // match stays substring, which would NOT catch a reintroduced prefix.
    // Found by actually running this mutation rather than trusting the
    // assertion: an earlier version of this test passed `{ exact: true }`
    // to `toHaveTextContent` and stayed green with the prefix restored.
    // Comparing `textContent` directly is real equality and does catch it.
    expect(alert.textContent).toBe(
      "Could not send the sign-in email just now. The failure has been logged on our end.",
    );
    // Still on the form, editable rather than stuck -- whatever the user
    // does next (fix a typo, try the same address, give up) is their call
    // to make, not something this component should nudge by implying a
    // plain retry will succeed (ticket 43423eb: it may well not). What
    // matters here is only that a failed send must not land in the
    // "check your inbox" state as though it had worked.
    expect(screen.queryByRole("heading", { name: /check your inbox/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "bob@example.comm" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cannot be submitted empty, and disables itself while sending", async () => {
    let resolveSend!: (value: unknown) => void;
    requestMagicLink.mockReturnValue(
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
    );
    render(<MagicLinkPrompt />);

    expect(screen.getByRole("button", { name: /email me a link/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "carol@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
    });
    expect(screen.getByLabelText(/email address/i)).toBeDisabled();
    // A second click while in flight must not be able to fire a second send.
    fireEvent.click(screen.getByRole("button", { name: /sending/i }));
    expect(requestMagicLink).toHaveBeenCalledTimes(1);

    resolveSend({ email: "carol@example.com", expiresAt: new Date().toISOString() });
    await screen.findByRole("heading", { name: /check your inbox/i });
  });

  it("'Not now' dismisses it entirely -- it is a real option, not a nag", () => {
    render(<MagicLinkPrompt />);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * Ticket a5c8fa9, Nicole: "I'm not crazy about the pop-up that tells you
   * that these results are saved to <her address>... And no pop-up after a
   * successful magic link." A verified user now gets NOTHING from this
   * component; the reassurance moved to `SignedInCue` in the header (see
   * SignedInCue.test.tsx for the other half).
   *
   * This replaces two older tests -- one asserting the floating "these
   * results are saved to" card rendered here, and one asserting it had a
   * dismiss button (opus review B2 on ticket d3a95d1, which existed only
   * because permanent fixed-position chrome with no close affordance
   * occludes content forever). Both described markup this component no
   * longer produces.
   */
  /**
   * Opus review B1 (ticket 5a7e957). Extracting `MagicLinkForm` moved the sent
   * state from REPLACING this card to nesting inside it, so the pitch survived
   * alongside the confirmation: two `<h3>`s, and a live "Add your email and
   * we'll send you a link" sitting directly above "We sent a sign-in link to
   * ...", pointing at a field that no longer existed. Roughly five extra lines
   * of contradictory copy on a 20rem card.
   *
   * The existing sent-state test could not see it -- it only asserted the
   * outer `section.magic-link-prompt` was present, which stayed true
   * because that section never unmounts any more.
   */
  it("replaces the pitch with the confirmation when sent, rather than showing both", async () => {
    requestMagicLink.mockResolvedValue({
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
    await screen.findByRole("heading", { name: /check your inbox/i });

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Add your email and we'll send you a link/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });

  /**
   * Opus review B2 (ticket 5a7e957). `phase` moved into `MagicLinkForm`, and
   * the first version typed the caller's secondary action as a bare
   * `ReactNode` -- which silently dropped this button's
   * `disabled={phase.status === "sending"}`. Clicking mid-flight then
   * unmounted the whole card while the request was still going: the email
   * sent, and the user was never told it had.
   */
  it("disables 'Not now' while a send is in flight", async () => {
    let release: (value: { email: string; expiresAt: string }) => void = () => {};
    requestMagicLink.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    expect(await screen.findByRole("button", { name: /sending/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /not now/i })).toBeDisabled();

    release({ email: "alice@example.com", expiresAt: new Date().toISOString() });
    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
  });

  it("renders nothing at all for an already-verified user -- no ask, and no confirmation card", () => {
    // Written through the real storage key `identity.ts` uses, so this test
    // fails if that key ever changes without this being updated.
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    const { container } = render(<MagicLinkPrompt />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/these results are saved to/i)).not.toBeInTheDocument();
    // The dismiss affordance B2 required is gone with the card it guarded.
    expect(screen.queryByRole("button", { name: /dismiss/i })).not.toBeInTheDocument();
  });

  // Ticket 931df8a, superseding d3a95d1: d3a95d1 moved this from sitting
  // inline at the end of a potentially long results list to a
  // `position: fixed` floating element, specifically so it stayed visible
  // without scrolling. That traded one placement problem (buried below a
  // long list) for a worse one Jay actually hit: the fixed card appeared
  // right next to the search controls the instant a search finished, while
  // he was still scrolled at the top with no idea results existed. The fix
  // is a third placement (App.tsx portals this component's rendered DOM to
  // a node just after the topmost result), not a return to the original
  // inline-at-the-end design -- so there is no `-floating` modifier class
  // to turn on any more, in ANY rendered state, which is what these two
  // tests pin. `position`/`display` are CSS concerns jsdom can't render or
  // measure; the class name is the one thing that's testable, the same
  // limitation d3a95d1's own version of these tests had in the opposite
  // direction.
  /**
   * Ticket 05ff2a5. `sentFactsLine` is NOT where this lives (see
   * `sentSpamNote`'s doc comment in `MagicLinkForm.tsx` for why it is a
   * sibling paragraph rather than a third sentence tacked onto the existing
   * one) -- but it is still owned by the shared form, not by this caller's
   * `sentBody`, so this prompt should get it for free.
   */
  describe("spam-folder note (ticket 05ff2a5)", () => {
    it("tells the user to check spam, naming FitScore as the sender, once the link is sent", async () => {
      requestMagicLink.mockResolvedValue({
        email: "alice@example.com",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
      render(<MagicLinkPrompt />);

      // Not present before a send -- pre-emptively mentioning spam to someone
      // who has not even tried yet plants doubt for no reason (ticket's own
      // OUT scope).
      expect(screen.queryByText(/check your spam folder/i)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: "alice@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
      await screen.findByRole("heading", { name: /check your inbox/i });

      // Pin the full approved sentence by exact text, same pattern as the
      // existing `sentFactsLine` pin below -- a future reword must fail
      // loudly, not slip past a substring match.
      const note = screen.getByText(/didn't get it\?/i);
      expect(note).toBeVisible();
      expect(note.textContent).toBe(
        "Didn't get it? Give it a minute, then check your spam folder — it'll be from FitScore.",
      );

      // The existing facts sentence must be completely untouched by this
      // addition -- still its own thing, still exactly what it said before.
      expect(screen.getByText(/open it in this browser/i)).toBeVisible();
      expect(screen.getByText(/works once and expires in about 15 minutes/i)).toBeVisible();
    });

    it("does not appear in the idle or sending states", async () => {
      let resolveSend!: (value: { email: string; expiresAt: string }) => void;
      requestMagicLink.mockReturnValue(
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
      );
      render(<MagicLinkPrompt />);

      expect(screen.queryByText(/check your spam folder/i)).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: "alice@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();
      });
      expect(screen.queryByText(/check your spam folder/i)).not.toBeInTheDocument();

      resolveSend({ email: "alice@example.com", expiresAt: new Date().toISOString() });
      await screen.findByRole("heading", { name: /check your inbox/i });
      expect(screen.getByText(/check your spam folder/i)).toBeVisible();
    });

    it("does not appear on a send failure", async () => {
      requestMagicLink.mockRejectedValue(new Error("boom"));
      render(<MagicLinkPrompt />);

      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: "bob@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

      await screen.findByRole("alert");
      expect(screen.queryByText(/check your spam folder/i)).not.toBeInTheDocument();
    });
  });

  describe("sits in the document flow, not floating (ticket 931df8a)", () => {
    it("in the idle/form state", () => {
      const { container } = render(<MagicLinkPrompt />);
      const section = container.querySelector("section.magic-link-prompt");
      expect(section).not.toBeNull();
      // Exactly the base class, nothing else -- a `-floating` (or any
      // other positioning) modifier reappearing would fail this even
      // though `section.magic-link-prompt` itself still matches.
      expect(section!.className.trim().split(/\s+/)).toEqual(["magic-link-prompt"]);
    });

    // Ticket a5c8fa9: the "already-verified state" case that sat here is
    // gone -- there is no card in that state at all any more, floating or
    // otherwise. The verified state's own test is above.

    it("in the 'sent' state", async () => {
      requestMagicLink.mockResolvedValue({
        email: "dana@example.com",
        expiresAt: new Date().toISOString(),
      });
      const { container } = render(<MagicLinkPrompt />);
      fireEvent.change(screen.getByLabelText(/email address/i), {
        target: { value: "dana@example.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
      await screen.findByRole("heading", { name: /check your inbox/i });

      const section = container.querySelector("section.magic-link-prompt");
      expect(section).not.toBeNull();
      expect(section!.className.trim().split(/\s+/)).toEqual(["magic-link-prompt"]);
    });
  });
});
