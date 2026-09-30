// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInRecovery } from "./SignInRecovery";

/**
 * Ticket 5a7e957. Nicole, reasoning about a returning user: "what if somebody
 * comes back after a few months and is like, where's all my stuff? Is there
 * going to be a way for them to put in their email and find it?"
 *
 * WHAT THIS FILE COVERS: the component's own behavior -- collapsed by default,
 * expands to a working form, absent once signed in. WHEN it is allowed on
 * screen at all is App.tsx's gate, not this component's, so it is tested in
 * App.magicLink.test.tsx instead (the same split as `MagicLinkPrompt`).
 */
const requestMagicLink = vi.fn();

vi.mock("../api/client", () => ({
  requestMagicLink: (...args: unknown[]) => requestMagicLink(...args),
}));

beforeEach(() => {
  requestMagicLink.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SignInRecovery (ticket 5a7e957)", () => {
  it("starts collapsed as a single quiet line, with no form on screen", () => {
    render(<SignInRecovery />);

    expect(screen.getByRole("button", { name: /been here before/i })).toBeInTheDocument();
    // The header earns its place by being quiet -- no field until asked for.
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
  });

  it("expands to a form, and collapses again on cancel", () => {
    render(<SignInRecovery />);

    fireEvent.click(screen.getByRole("button", { name: /been here before/i }));
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /get your saved results back/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /been here before/i })).toBeInTheDocument();
  });

  it("sends the link through the real client call and confirms where it went", async () => {
    requestMagicLink.mockResolvedValue({
      email: "returning@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<SignInRecovery />);

    fireEvent.click(screen.getByRole("button", { name: /been here before/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "returning@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a sign-in link/i }));

    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledWith("returning@example.com");
    // The address shown is the one the SERVER echoed, not the raw input --
    // see MagicLinkForm's comment on why that distinction matters.
    expect(screen.getByText("returning@example.com")).toBeInTheDocument();
  });

  /**
   * The recovery copy must say "open it in THIS browser", not "on any
   * device". The point of this flow is moving an existing account onto the
   * browser the user is sitting at; a link opened elsewhere adopts the
   * account somewhere else and leaves them exactly as stuck as before.
   */
  it("tells the user to open the link in this browser, and states the link's real limits", async () => {
    requestMagicLink.mockResolvedValue({
      email: "returning@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });
    render(<SignInRecovery />);

    fireEvent.click(screen.getByRole("button", { name: /been here before/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "returning@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a sign-in link/i }));
    await screen.findByRole("heading", { name: /check your inbox/i });

    expect(screen.getByText(/open it in this browser/i)).toBeInTheDocument();
    // Owned by MagicLinkForm rather than by this caller, deliberately -- the
    // expiry wording took a live back-and-forth to get right (ticket f199f55)
    // and must not drift per-caller.
    expect(screen.getByText(/works once and expires in about 15 minutes/i)).toBeInTheDocument();
  });

  it("renders nothing at all once an email is verified -- SignedInCue owns the slot then", () => {
    localStorage.setItem("jobsearch.web.userEmail.v1", "already@example.com");

    const { container } = render(<SignInRecovery />);

    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a send failure without losing what was typed", async () => {
    requestMagicLink.mockRejectedValue(new Error("network down"));
    render(<SignInRecovery />);

    fireEvent.click(screen.getByRole("button", { name: /been here before/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "returning@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a sign-in link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("network down");
    // Still editable, still holding the address -- a failed send that also
    // wiped the field would make a typo unfixable without retyping.
    expect(screen.getByLabelText(/email address/i)).toHaveValue("returning@example.com");
  });
});
