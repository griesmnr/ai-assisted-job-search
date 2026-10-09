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
 * WHERE THIS RENDERS, THREE ROUNDS IN (ticket 042db32, superseding 931df8a,
 * which superseded d3a95d1): d3a95d1 made this `position: fixed`,
 * bottom-right of the viewport, precisely to avoid the ORIGINAL inline-at-
 * the-end-of-the-list placement, where a long results list could push it
 * below the fold -- "never reached" in practice. That traded one failure
 * for a worse one: Jay's search finished while he was still scrolled at
 * the top, at the search controls, and the fixed card appeared right next
 * to them -- "out of nowhere," before he had any idea results existed.
 * Nicole, after first hearing this mis-read as a timing bug: "the timing
 * was correct. The placement was not... When he happens to scroll down is
 * when he should start being able to see that email message." 931df8a's
 * fix was to stop floating at all: a node sitting just after the TOPMOST
 * result (never above it, never at the list's end), in the normal
 * document flow. That fixed Jay's round-1 complaint and cost Nicole the
 * one thing she'd liked about the fixed card -- a visual cue, distinct
 * from sitting between two specific postings, that the search had actually
 * produced something. It also, per Jay's round 2, did not fully fix his
 * complaint either: "embedded among results, he couldn't tell which
 * results it meant."
 *
 * 042db32's fix floats it again, deliberately NOT back to `position:
 * fixed` (see index.css's comment at `.magic-link-prompt-anchor`, both the
 * long one above the base rule and the N1/N2/N3 occlusion history above
 * that, for why that stays retired): on a viewport wide enough, CSS takes
 * the anchor out of the results list's flex flow (`position: absolute`)
 * and places it in `.app`'s own right-hand gutter, top-aligned with the
 * first result card -- beside the results, not fixed to the viewport and
 * not sandwiched between two of them. On a narrow viewport with no "side"
 * to float to, it stays a normal member of the results flex column
 * (occupying the same slot 931df8a gave it) but becomes `position: sticky`,
 * so scrolling detaches it from that slot and pins it to the screen's top
 * edge instead, reading as a page-level aside rather than commentary on
 * card 1 specifically, for as long as the results list is still on screen.
 * Both are plain CSS on the same DOM node this component has used since
 * d0a7074/931df8a -- nothing here changed to make it possible.
 *
 * `createPortal` is what makes ANY of this compatible with the one-
 * hoisted-instance requirement below: the component's position in the
 * REACT TREE does not move (it still mounts once, where d0a7074 put it),
 * only its rendered DOM does -- so this stays exactly one instance with
 * exactly one local `dismissed`/`email`/`phase`, same as when it was
 * `position: fixed`, same as when it was in-flow, same now that it floats
 * beside the results again. See App.tsx's own comment at the mount site
 * for the portal wiring, and index.css's comment at
 * `.magic-link-prompt-anchor` for the full placement history and the
 * current CSS mechanism in detail.
 *
 * WHY IT IS FRAMED AS "SO YOU CAN FIND THIS AGAIN" AND NOT AS A LOGIN WALL
 * (Nicole's framing, on the ticket): nothing here is gated. The results are
 * already on screen, already saved server-side under this browser's anonymous
 * identity, and stay that way whether or not the user types anything. The
 * email buys ONE thing -- tying these results to that address so they
 * survive this browser being lost -- and the copy says exactly that rather
 * than implying an account is required. "Not now" is a first-class option,
 * not a grudging link. (That "ONE thing" claim itself has a branch-dependent
 * exception -- see the paragraph below, review round 1 F4.)
 *
 * WHAT THE EMAIL DOES NOT BUY YET: cross-device reach, for most visitors of
 * THIS prompt specifically. Most addresses typed here are brand new to the
 * app, which takes `resolveIdentity`'s ATTACH branch -- and that branch's
 * `different_browser` check (security property 4, `apps/api/src/routes/
 * auth.ts`) requires the first link to be opened in the SAME browser that
 * requested it, precisely to block the account-fixation attack fable found
 * in review round 1. Only after that first confirmation does the address
 * have an account, at which point every later link for it takes the
 * unbound ADOPT branch and "any device" becomes true. Ticket a3062b4: this
 * component's own copy used to claim the cross-device version was true
 * immediately, which told most of its users to do the one thing the server
 * would refuse. See `MagicLinkForm`'s `sentFactsLine` for the corrected,
 * branch-agnostic instruction ("open it in this browser") this component
 * now relies on instead.
 *
 * THAT WAS ONLY THE DEVICE DIMENSION OF ATTACH/ADOPT. THERE IS A SEPARATE,
 * WHOSE-RESULTS DIMENSION THIS COMPONENT IS ALSO BLIND TO (review round 1,
 * F4): "tying these results to that address" above is only true on the
 * ATTACH branch. If the address typed here already has an account, the
 * request takes the ADOPT branch instead -- `resolveIdentity` returns the
 * EXISTING row, `setUserId` reports `switchedAccount`, and
 * `MagicLinkLanding` then calls `clearAppState()` and tells whoever lands
 * there, explicitly, that they are now looking at a DIFFERENT account's
 * resumes and results. The results that were on screen when this prompt was
 * typed into stay behind on the abandoned anonymous row -- not tied to that
 * address at all. The `sentBody` text below ("which will tie these results
 * to that address") inherits this same half-truth; it is not new to this
 * diff (main's "save these results to that address" was false the same
 * way) and is not fixed by it -- a sentence accurate on both branches needs
 * the whose-results caveat spelled out, which is a bigger rewrite than
 * fixing the device-dimension claim this ticket was actually scoped to.
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
    <section className="magic-link-prompt">
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
            {/* Ticket a3062b4: used to say "open it on any device", which is
                exactly what the ATTACH branch's `different_browser` check
                refuses for most visitors of this prompt (a brand-new
                address). "Open it in this browser" is the shared,
                branch-agnostic instruction now -- see `sentFactsLine`. */}
            We sent a sign-in link to <strong>{sentTo}</strong>, which will tie these results to
            that address.
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
