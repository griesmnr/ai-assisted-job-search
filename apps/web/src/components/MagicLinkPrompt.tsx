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

  // Already signed in: a short reassurance, no ask. Deliberately still
  // rendered (rather than nothing at all) because "are my results actually
  // saved anywhere?" is the exact question this section exists to answer,
  // and it is worth answering for the people who already did the thing.
  if (verifiedEmail !== undefined) {
    return (
      <section className="magic-link-prompt magic-link-prompt-signed-in">
        <p>
          These results are saved to <strong>{verifiedEmail}</strong>. Use a sign-in link from any
          other browser to see them there.
        </p>
      </section>
    );
  }

  if (dismissed) return null;

  if (phase.status === "sent") {
    return (
      <section className="magic-link-prompt" aria-live="polite">
        <h3>Check your inbox</h3>
        <p>
          We sent a sign-in link to <strong>{phase.email}</strong>. Open it on any device to save
          these results to that address. The link works once and expires in about 15 minutes.
        </p>
        <p className="magic-link-note">
          Nothing is lost if you ignore it — these results stay in this browser either way.
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
    <section className="magic-link-prompt">
      <h3>Want to find these results again later?</h3>
      <p>
        Add your email and we'll send you a link that brings you back to this search from any
        browser. No password, and nothing here is hidden behind it — your results are already saved
        to this browser.
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
