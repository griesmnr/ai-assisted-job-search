import { useId, useState } from "react";
import { requestMagicLink } from "../api/client";
import { getVerifiedEmail } from "../identity";

/**
 * The post-results sign-in prompt (ticket 9f06f8f, epic 2b9e9dd child 4).
 *
 * WHERE THIS IS ALLOWED TO APPEAR, AND WHY IT IS THE CALLER'S DECISION:
 * App.tsx renders this inside the "Results from this search" section, which
 * only exists once a real search has completed (`hasFreshSearchResults`). The
 * placement is the whole point of the ticket -- offer the email "right after
 * scored results land, never before" -- and it is enforced by WHERE this is
 * mounted rather than by a prop this component checks, so there is no way to
 * render it early by passing the wrong flag.
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
 * `position: fixed`, which is a pure CSS/presentation change -- it does NOT
 * touch WHEN this component is allowed to mount (still gated exactly as
 * before, in App.tsx) or any of its internal states below.
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
 *
 * WHAT "SENT" DOES AND DOES NOT CLAIM: the API resolving means the email
 * provider ACCEPTED the message, never that it arrived -- so the confirmation
 * says where it was sent and offers to send another, and does not assert
 * delivery.
 */
type Phase =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

export function MagicLinkPrompt() {
  const fieldId = useId();
  // Read once at mount: this cannot change while the component is alive --
  // the only thing that sets it is `MagicLinkLanding`, which is a full-page
  // takeover that this component is never mounted alongside.
  const [verifiedEmail] = useState(getVerifiedEmail);
  const [dismissed, setDismissed] = useState(false);
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  // Opus review, B2 (BLOCKING): `dismissed` must be checked BEFORE the
  // signed-in branch below, not after -- floating made the signed-in
  // confirmation a fixed-position card sitting in the corner of every
  // results view, and inline it had never needed a dismiss button (nothing
  // to close, just a line scrolled past once), so this check used to come
  // too late for that branch to ever reach it. Without this reordering, a
  // signed-in user would have permanent, undismissable chrome occluding
  // whatever's behind it -- see that branch's own dismiss button below.
  if (dismissed) return null;

  // Already signed in: a short reassurance, no ask. Deliberately still
  // rendered (rather than nothing at all) because "are my results actually
  // saved anywhere?" is the exact question this section exists to answer,
  // and it is worth answering for the people who already did the thing.
  if (verifiedEmail !== undefined) {
    return (
      <section className="magic-link-prompt magic-link-prompt-floating magic-link-prompt-signed-in">
        <p>
          These results are saved to <strong>{verifiedEmail}</strong>. Use a sign-in link from any
          other browser to see them there.
        </p>
        <button
          type="button"
          className="magic-link-prompt-signed-in-dismiss"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </section>
    );
  }

  if (phase.status === "sent") {
    return (
      <section className="magic-link-prompt magic-link-prompt-floating" aria-live="polite">
        <h3>Check your inbox</h3>
        <p>
          We sent a sign-in link to <strong>{phase.email}</strong>. Open it on any device to save
          these results to that address. The link works once and expires in about 15 minutes.
        </p>
        <button
          type="button"
          className="magic-link-secondary"
          // Back to the form rather than straight to a second send: if the
          // mail has not arrived, the most likely reason by far is a typo in
          // the address, so the useful next step is seeing and fixing what
          // was actually typed -- not silently re-sending to the same wrong
          // inbox.
          onClick={() => setPhase({ status: "idle" })}
        >
          Use a different address
        </button>
      </section>
    );
  }

  async function handleSubmit() {
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    setPhase({ status: "sending" });
    try {
      // The server normalizes and echoes the address it actually mailed
      // (lowercased, trimmed) -- showing THAT, rather than the raw input, is
      // what makes "check your inbox" name the same string the mail was
      // addressed to.
      const { email: sentTo } = await requestMagicLink(trimmed);
      setPhase({ status: "sent", email: sentTo });
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section className="magic-link-prompt magic-link-prompt-floating">
      <h3>Want to find these results again later?</h3>
      {/* Ticket d3a95d1, Nicole (live, while it's now a small floating
          element): trimmed to one sentence -- the "no password / nothing
          hidden behind it" reassurance was true and worth having once, but
          not worth the length in a compact floating card.
          Ticket f199f55, Nicole (live, after walking through what this
          feature actually does end to end): reworded again -- "ties these
          results to your email so that you can get them back anytime"
          names the real mechanism (the email is the durable identity; any
          future link is just a fresh proof-of-you) instead of implying
          THIS specific link is what "brings you back", which is what led
          to her original "why does it expire, then?" confusion. */}
      <p>
        Add your email and we'll send you a link that ties these results to your email so that you
        can get them back anytime.
      </p>
      <form
        className="magic-link-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <label htmlFor={fieldId}>Email address</label>
        <input
          id={fieldId}
          // `type="email"` gives mobile keyboards the right layout and gives
          // the browser's own validation a chance before a round trip. The
          // API validates independently and is the real authority (see
          // routes/auth.ts's EMAIL_RE and why it is deliberately permissive).
          type="email"
          autoComplete="email"
          value={email}
          placeholder="you@example.com"
          onChange={(event) => {
            setEmail(event.target.value);
            // Clear a previous failure the moment the user starts fixing the
            // thing that failed -- a stale error under a field being edited
            // reads as though the new value had failed too.
            if (phase.status === "error") setPhase({ status: "idle" });
          }}
          disabled={phase.status === "sending"}
        />
        <button type="submit" disabled={phase.status === "sending" || email.trim().length === 0}>
          {phase.status === "sending" ? "Sending..." : "Email me a link"}
        </button>
        <button
          type="button"
          className="magic-link-secondary"
          onClick={() => setDismissed(true)}
          disabled={phase.status === "sending"}
        >
          Not now
        </button>
      </form>
      {phase.status === "error" && (
        <p role="alert" className="magic-link-error">
          Could not send the link: {phase.message}
        </p>
      )}
    </section>
  );
}
