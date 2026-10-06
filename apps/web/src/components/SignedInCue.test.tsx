// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignedInCue } from "./SignedInCue";

/**
 * Ticket a5c8fa9. Nicole, dogfooding right after verifying her own magic
 * link: "I'm not crazy about the pop-up that tells you that these results
 * are saved to <her address>. Why don't we just say in the top right of the
 * screen... And no pop-up after a successful magic link."
 *
 * The half this file covers is the new quiet label. The half it does NOT is
 * the absence of the old floating card, which is asserted where that card
 * used to come from (`MagicLinkPrompt.test.tsx` -- "renders nothing at all
 * for an already-verified user").
 */

// Same reason as every other component test file here: the root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// (which needs a GLOBAL `afterEach`) never runs on its own.
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SignedInCue (ticket a5c8fa9)", () => {
  it("shows the verified address when one is stored", () => {
    // Written through the real storage key `identity.ts` uses, so this test
    // fails if that key ever changes without this being updated -- same
    // convention as MagicLinkPrompt.test.tsx.
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    render(<SignedInCue />);

    expect(screen.getByText(/these results are saved to/i)).toBeInTheDocument();
    expect(screen.getByText("signed-in@example.com")).toBeInTheDocument();
  });

  it("renders nothing for an anonymous visitor", () => {
    const { container } = render(<SignedInCue />);

    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The point of the ticket was to stop this being floating chrome. `position:
   * fixed` is a CSS concern jsdom cannot render or measure, so what is
   * testable is that the element does NOT carry the markup of the full
   * sign-in prompt card, and is NOT a dismissible panel.
   *
   * Ticket 931df8a retired the `.magic-link-prompt-floating` modifier class
   * this test used to check for outright (that whole concept -- a
   * `position: fixed` card -- is gone from the app, not just from here), so
   * checking for its absence here would now be true unconditionally and
   * prove nothing. `.magic-link-prompt` (the base class MagicLinkPrompt
   * still uses, in flow) is the meaningful thing to rule out instead: it
   * would only appear here if this component started rendering the OTHER
   * component's markup, which is the actual bug this test guards against.
   */
  it("is a plain in-flow label, not the sign-in prompt card", () => {
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    const { container } = render(<SignedInCue />);

    expect(container.querySelector(".magic-link-prompt")).toBeNull();
    expect(container.querySelector(".signed-in-cue")).not.toBeNull();
    // Nothing to close, so nothing that offers to close it -- this is what
    // retires opus review finding B2 (ticket d3a95d1) rather than re-solving
    // it: an in-flow label occludes nothing, so it needs no escape hatch.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
