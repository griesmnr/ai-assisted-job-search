import { useState } from "react";
import { getVerifiedEmail } from "../identity";
import { MagicLinkForm } from "./MagicLinkForm";

/**
 * The post-results sign-in prompt (ticket 9f06f8f, epic 2b9e9dd child 4).
 *
 * WHERE THIS IS ALLOWED TO APPEAR, AND WHY IT IS THE CALLER'S DECISION:
 * offering the email "right after scored results land, never before" is the
 * whole point of the ticket, and it stays the CALLER's decision -- this
 * component takes no "should I show?" prop and checks no such flag itself,
 * so it cannot be made to appear early by passing the wrong one.
 *
 * Ticket d0a7074 changed the shape of that enforcement, not the rule.
 * Originally this was mounted physically inside the "Results from this
 * search" section, which only exists once `hasFreshSearchResults` is true.
 * Nicole asked for the same offer on "Already Scored Jobs" too, and because
 * every tab panel stays mounted at once (ticket f4a7f07) while this
 * component holds `dismissed`/`email`/`phase` locally, a second mount point
 * would have meant a second independent state -- dismissing on one tab
 * leaving it up on the other, or a submitted address on one tab still
 * showing an empty form on the other. So there is now exactly ONE instance,
 * hoisted to `main.app` level, and App.tsx's `showMagicLinkPrompt` carries
 * the gate that nesting used to carry: a completed search with visible
 * results on the search tab, OR visible scored results on the scored tab,
 * and nothing at all on "My Resumes". Read that gate, not this file, for
 * exactly when the prompt is allowed on screen.
 *
 * WHY IT FLOATS RATHER THAN SITTING INLINE (ticket d3a95d1, Nicole, live
 * design discussion): the original inline placement, at the end of the
 * results list, meant a long list could push it far below the fold --
 * "never reached" is the same practical failure as never offering it at
 * all. Nicole's own framing of the tradeoff: top competes with results and
 * gets skipped past; bottom (inline, long list) is often never scrolled to;
 * "off to the side" is neither -- a small persistent element, visible
 * without scrolling, that doesn't block the first look at results. The
 * `magic-link-prompt-floating` class (index.css) does this with
 * `position: fixed`, which was a pure CSS/presentation change -- d3a95d1
 * itself touched neither when this component mounts nor any of its
 * internal states below. (Ticket d0a7074 later DID change the mounting, as
 * the paragraph above describes; that float-vs-inline reasoning is
 * unaffected by it, and `position: fixed` is in fact why one hoisted
 * instance works at all.)
 *
 * WHY IT IS FRAMED AS "SO YOU CAN FIND THIS AGAIN" AND NOT AS A LOGIN WALL
 * (Nicole's framing, on the ticket): nothing here is gated. The results are
 * already on screen, already saved server-side under this browser's anonymous
 * identity, and stay that way whether or not the user types anything. The
 * email buys ONE thing -- reaching the same results from another browser --
 * and the copy says exactly that rather than implying an account is required.
 * "Not now" is a first-class option, not a grudging link.
 *
 * WHY IT DISAPPEARS ONCE VERIFIED: an already-signed-in user being asked to
 * sign in again is the most common way a prompt like this becomes noise. The
 * check is `getVerifiedEmail()` from local storage -- see that function's own
 * doc comment for why local storage is not merely adequate but exactly
 * correct here (it shares its lifetime with the user id itself, so "storage
 * was cleared" genuinely does mean "this is a new anonymous visitor").
 * Ticket a5c8fa9: verified users now get `null` here and see `SignedInCue`
 * in the header instead -- this component is purely the ASK now.
 *
 * WHAT "SENT" DOES AND DOES NOT CLAIM: the API resolving means the email
 * provider ACCEPTED the message, never that it arrived -- so the confirmation
 * says where it was sent and offers to send another, and does not assert
 * delivery.
 */
export function MagicLinkPrompt() {
  // Read once at mount: this cannot change while the component is alive --
  // the only thing that sets it is `MagicLinkLanding`, which is a full-page
  // takeover that this component is never mounted alongside.
  const [verifiedEmail] = useState(getVerifiedEmail);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // Already signed in: this component renders NOTHING. Ticket a5c8fa9,
  // Nicole, dogfooding right after verifying her own link: "I'm not crazy
  // about the pop-up that tells you that these results are saved to
  // <her address>... let's just make the tiny visual cue in the top right...
  // And no pop-up after a successful magic link."
  //
  // The reassurance itself is NOT dropped -- "are my results actually saved
  // anywhere?" is still a real question worth answering for someone who did
  // the thing, which is why this branch used to render a card at all. It
  // moved to `SignedInCue` (App.tsx's header row), where it is a quiet
  // persistent label instead of floating chrome.
  //
  // That relocation also retires ticket d3a95d1's review finding B2 rather
  // than working around it: B2 existed because a fixed-position signed-in
  // card with no dismiss button was permanent chrome occluding whatever sat
  // behind it, so `dismissed` had to be checked before this branch and the
  // branch needed a `x` of its own. An inline label in the header occludes
  // nothing, needs no dismiss affordance, and needs no clearance padding --
  // so both the button and the ordering dependency are simply gone.
  if (verifiedEmail !== undefined) return null;

  return (
    <section className="magic-link-prompt magic-link-prompt-floating">
      {/* Ticket 5a7e957: the field, the send, the phases and the "check your
          inbox" panel all live in `MagicLinkForm` now, shared with
          `SignInRecovery`. The pitch below is passed IN rather than rendered
          here, because the confirmation has to replace it -- see that prop's
          own comment (opus review B1) for the stacked-copy bug that came from
          rendering it as a sibling. */}
      <MagicLinkForm
        pitch={
          <>
            <h3>Want to find these results again later?</h3>
            {/* Ticket d3a95d1, Nicole (live, while it's now a small floating
                element): trimmed to one sentence -- the "no password /
                nothing hidden behind it" reassurance was true and worth
                having once, but not worth the length in a compact floating
                card.
                Ticket f199f55, Nicole (live, after walking through what this
                feature actually does end to end): reworded again -- "ties
                these results to your email so that you can get them back
                anytime" names the real mechanism (the email is the durable
                identity; any future link is just a fresh proof-of-you)
                instead of implying THIS specific link is what "brings you
                back", which is what led to her original "why does it expire,
                then?" confusion. */}
            <p>
              Add your email and we&apos;ll send you a link that ties these results to your email so
              that you can get them back anytime.
            </p>
          </>
        }
        sentBody={(sentTo) => (
          <>
            We sent a sign-in link to <strong>{sentTo}</strong>. Open it on any device to save these
            results to that address.
          </>
        )}
        secondary={({ sending }) => (
          <button
            type="button"
            className="magic-link-secondary"
            onClick={() => setDismissed(true)}
            // Opus review B2: disabled mid-flight, as on `main`. Without it,
            // dismissing during an in-flight request unmounts the card and the
            // email still sends, with the user never told it went.
            disabled={sending}
          >
            Not now
          </button>
        )}
      />
    </section>
  );
}
