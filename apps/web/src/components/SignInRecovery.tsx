import { useState } from "react";
import { getVerifiedEmail } from "../identity";
import { MagicLinkForm } from "./MagicLinkForm";

/**
 * The way back in for someone who saved their email and then lost their
 * browser storage (ticket 5a7e957).
 *
 * THE GAP THIS CLOSES. Nicole spotted it by reasoning about a returning user:
 * "what if somebody comes back after a few months and is like, where's all my
 * stuff? Is there going to be a way for them to put in their email and find
 * it?" The answer was no, and the shape of it was ironic -- the only place to
 * type an email was `MagicLinkPrompt`, which only renders once results are on
 * screen. So the one person who most needed it (someone staring at an empty
 * app) was the only person who could not reach it. The prompt's own copy
 * promised "you can get them back anytime", which after storage loss was not
 * true of any path the UI offered.
 *
 * WHY THIS IS NOT A NEW FEATURE, just a second door. The backend already did
 * all of it: `POST /auth/magic-link` with an address that already has an
 * account takes `resolveIdentity`'s ADOPT branch (`apps/api/src/routes/
 * auth.ts`), which hands this browser the existing user id and everything
 * attached to it. That branch is deliberately not bound to the original
 * browser, precisely so a new device or a cleared one can sign back in. This
 * component and `MagicLinkPrompt` post to the same endpoint; they differ only
 * in when they appear and what they say.
 *
 * WHEN IT APPEARS, AND WHY THAT RULE. Nicole's own: "on any site run where
 * there's no data? because if there is data, or they use the site normally,
 * they'll get prompted as we discussed." Exactly right, and the reason is
 * sharper than "avoid clutter" -- since the prompt performs recovery too, a
 * second entry point is only NEEDED in the state where the prompt cannot
 * render. So: nothing scored, and no resume in play (someone who just pasted
 * a resume has "no data" by the results measure but is mid-onboarding, not
 * lost -- offering them a way back would read as the app not noticing what
 * they are doing). The caller owns that half of the gate; see App.tsx.
 *
 * THE LIMIT, STATED SO IT IS NOT MISTAKEN FOR A BUG: a brand-new visitor and
 * a returning-with-cleared-storage visitor are INDISTINGUISHABLE to this app
 * -- both have nothing. So a first-timer sees this too. That is accepted
 * rather than solved: "Been here before?" is a conditional a first-timer
 * reads past, which is different in kind from pitching them an account, and
 * ticket 9f06f8f's "never ask before value is delivered" rule governs the
 * PROMPT (which sells saving your results) rather than a quiet offer aimed at
 * people who already have one.
 *
 * Collapsed to a single line until clicked, for the same reason the signed-in
 * cue is one line: the header earns its place by being quiet. See
 * `SignedInCue` -- these two share this slot and are mutually exclusive by
 * construction (that one renders only WITH a verified email, this one only
 * without).
 */
export function SignInRecovery({ offered }: { offered: boolean }) {
  // Read once at mount, same pattern and same justification as
  // `SignedInCue`/`MagicLinkPrompt`: the only writer is `MagicLinkLanding`,
  // a full-page takeover this is never mounted alongside, so the value
  // cannot change under a live instance.
  const [verifiedEmail] = useState(getVerifiedEmail);
  const [open, setOpen] = useState(false);
  /** Opus review F1: a link having been sent outlives the conditions for
   * OFFERING to send one. The paste box sits right below this panel, so the
   * natural move while waiting for the email is to start on the resume --
   * which gives this browser data, closes `offered`, and would otherwise take
   * the "Check your inbox" confirmation off screen mid-wait. A receipt is not
   * an offer; once one exists it stays until the page does. */
  const [sent, setSent] = useState(false);

  // Already signed in -- there is nothing to recover. `SignedInCue` has this
  // slot instead.
  if (verifiedEmail !== undefined) return null;

  // Withdrawn -- but only while there is no receipt to keep showing. Returning
  // `null` rather than being unmounted by the caller is what preserves `open`,
  // `sent` and the form's own phase if the conditions come back.
  if (!offered && !sent) return null;

  if (!open) {
    return (
      <button type="button" className="sign-in-recovery-link" onClick={() => setOpen(true)}>
        Been here before? Enter your email address
      </button>
    );
  }

  return (
    // Opus review N11: a plain `<div>`, not a `<section>`. A bare `section`
    // picks up the global `section { margin-top: 2rem; padding-top: 1.5rem;
    // border-top: ... }` rule meant for real page sections, which then has to
    // be undone declaration by declaration -- and any future addition to that
    // rule would leak in silently. This is a widget inside the header.
    <div className="sign-in-recovery-open">
      <MagicLinkForm
        submitLabel="Send me a sign-in link"
        onSent={() => setSent(true)}
        // Opus review N6: `h2`, not `h3`. Every real page heading below is an
        // `h2`, and this sits ABOVE all of them in the header -- an `h3` here
        // skips a level in the document outline from the `h1`.
        pitch={
          <>
            <h2>Get your saved results back</h2>
            <p>
              If you saved your results to an email address before, enter it here and we&apos;ll
              send you a link that brings them back to this browser.
            </p>
          </>
        }
        sentBody={(sentTo) => (
          <>
            We sent a sign-in link to <strong>{sentTo}</strong>. Open it in this browser to bring
            your saved results back here.
          </>
        )}
        secondary={({ sending }) => (
          <button
            type="button"
            className="magic-link-secondary"
            onClick={() => setOpen(false)}
            disabled={sending}
          >
            Cancel
          </button>
        )}
      />
    </div>
  );
}
