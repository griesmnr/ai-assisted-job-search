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
    expect(
      screen.getByText(/send you a link that brings you back to this search from any browser/i),
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
    // And still says nothing is lost by ignoring it.
    expect(screen.getByText(/nothing is lost if you ignore it/i)).toBeInTheDocument();
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
    requestMagicLink.mockRejectedValue(
      new Error("Could not send the sign-in email just now. Please try again in a moment."),
    );
    render(<MagicLinkPrompt />);

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "bob@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/try again in a moment/i);
    // Still on the form, so a retry is one click away -- a failed send must
    // not land in the "check your inbox" state.
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

  it("never asks an already-verified user to sign in again, and says where their results live", () => {
    // Written through the real storage key `identity.ts` uses, so this test
    // fails if that key ever changes without this being updated.
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    render(<MagicLinkPrompt />);

    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.getByText("signed-in@example.com")).toBeInTheDocument();
    expect(screen.getByText(/these results are saved to/i)).toBeInTheDocument();
  });

  // Ticket d3a95d1, Nicole (live design discussion): moved from sitting
  // inline at the end of a potentially long results list (where it could
  // sit below the fold and never get seen) to a floating element that
  // stays visible without scrolling. `position: fixed` is a CSS concern
  // jsdom can't render/measure, so this pins the one thing that IS testable
  // -- the class that drives it -- present in every rendered state, not
  // just the default idle one.
  describe("floats instead of sitting inline (ticket d3a95d1)", () => {
    it("in the idle/form state", () => {
      const { container } = render(<MagicLinkPrompt />);
      expect(container.querySelector(".magic-link-prompt-floating")).not.toBeNull();
    });

    it("in the already-verified state", () => {
      localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");
      const { container } = render(<MagicLinkPrompt />);
      expect(container.querySelector(".magic-link-prompt-floating")).not.toBeNull();
    });

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

      expect(container.querySelector(".magic-link-prompt-floating")).not.toBeNull();
    });
  });
});
