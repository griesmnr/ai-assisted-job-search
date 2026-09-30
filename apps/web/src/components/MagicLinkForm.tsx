import { useId, useState, type ReactNode } from "react";
import { requestMagicLink } from "../api/client";

/**
 * The email-and-send mechanics shared by every place this app asks for an
 * address (ticket 5a7e957).
 *
 * WHY THIS WAS EXTRACTED RATHER THAN DUPLICATED. Until 5a7e957 there was
 * exactly one asker, `MagicLinkPrompt`, and the form lived inside it. That
 * ticket adds a second (`SignInRecovery`, the "been here before?" entry point
 * for someone whose browser storage is gone), and the two are the SAME
 * mechanism: one `POST /auth/magic-link`, and an address that already has an
 * account is *adopted* rather than attached (see `resolveIdentity`'s adopt
 * branch in `apps/api/src/routes/auth.ts`). So recovery is not a second
 * feature, it is the same door with different words on it.
 *
 * Two copies of this form would therefore be two copies of security-relevant
 * wording -- what a link does, how long it lasts, whether it can be reused --
 * drifting apart silently. That is the specific drift worth preventing, and
 * it is why the duplication was not simply accepted for a smaller diff.
 *
 * WHAT CALLERS STILL OWN: their own framing. The pitch above the field and
 * the body of the confirmation differ by situation (one is "save these
 * results", the other is "get your results back"), so those arrive as props
 * rather than being flattened into one compromise sentence. What is NOT
 * negotiable per caller, deliberately, is anything factual about the link
 * itself -- see `sentFactsLine` below.
 */
type Phase =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

/**
 * The one sentence about how the link BEHAVES, owned here rather than by
 * callers. Ticket f199f55 spent a live back-and-forth with Nicole getting
 * the expiry framing right (she read "expires in 15 minutes" as "the link is
 * how you come back", concluded the feature was pointless, and it took an
 * explanation that the EMAIL is the durable identity to resolve it). A
 * per-caller copy of that sentence is exactly how that hard-won wording gets
 * quietly reworded by someone who doesn't know the history.
 */
function sentFactsLine(): ReactNode {
  return "The link works once and expires in about 15 minutes.";
}

export function MagicLinkForm({
  pitch,
  sentBody,
  secondary,
  onSent,
  submitLabel = "Email me a link",
}: {
  /** The caller's framing above the field -- heading and explanation.
   *
   * Opus review B1 (ticket 5a7e957): this is a PROP rather than something the
   * caller renders itself, because the sent panel has to REPLACE it. The
   * first version of this extraction had callers render their own pitch as a
   * sibling, which turned the confirmation state into the pitch AND the
   * confirmation stacked together -- two `<h3>`s, and a live "Add your email
   * and we'll send you a link" sitting directly above "We sent a sign-in link
   * to alice@example.com", pointing at a field that no longer existed. On
   * `main` the sent state early-returned the whole card, so that could not
   * happen. Owning the pitch here restores that. */
  pitch: ReactNode;
  /** The situation-specific explanation shown after a send succeeds, above
   * the fixed facts line. Receives the address the server actually mailed. */
  sentBody: (email: string) => ReactNode;
  /** An optional caller-owned action rendered beside submit -- "Not now" for
   * the results prompt, a cancel for the recovery panel.
   *
   * Opus review B2: a function of `{ sending }`, not a bare node, because the
   * caller's action usually must be disabled mid-flight and `phase` lives in
   * here. The first version typed this as `ReactNode`, which silently dropped
   * `MagicLinkPrompt`'s `disabled={phase.status === "sending"}` on "Not now"
   * -- so dismissing during an in-flight request unmounted the card, and the
   * email sent with the user never told. A `ReactNode` simply cannot express
   * that, which is why the signature changed rather than the call site. */
  secondary?: (state: { sending: boolean }) => ReactNode;
  /** Called once a send succeeds. Exists so a caller whose VISIBILITY is
   * controlled from outside can keep itself on screen afterwards: a
   * confirmation that a link was sent is a receipt, not an offer, and must not
   * disappear because the surrounding conditions for *offering* stopped
   * holding. See `SignInRecovery`. */
  onSent?: (email: string) => void;
  submitLabel?: string;
}) {
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

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
      onSent?.(sentTo);
    } catch (err) {
      setPhase({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // Opus review N7: the live region wraps BOTH phases, so it is present in
  // the DOM before the confirmation text appears inside it. A region inserted
  // together with its own content is not announced by most screen readers --
  // and on `main` this worked only by accident, because the region happened
  // to be the `<section>` React reconciled in place across idle -> sent.
  // Layout-neutral: `.magic-link-prompt` and `.sign-in-recovery-open` are
  // plain blocks, not flex containers, and every selector that reaches inside
  // them is a class or a descendant selector rather than a child one.
  return (
    <div aria-live="polite">
      {phase.status === "sent" ? (
        <>
          <h3>Check your inbox</h3>
          <p>
            {sentBody(phase.email)} {sentFactsLine()}
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
        </>
      ) : (
        <>
          {pitch}
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
              // `type="email"` gives mobile keyboards the right layout and
              // gives the browser's own validation a chance before a round
              // trip. The API validates independently and is the real
              // authority (see routes/auth.ts's EMAIL_RE and why it is
              // deliberately permissive).
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@example.com"
              onChange={(event) => {
                setEmail(event.target.value);
                // Clear a previous failure the moment the user starts fixing
                // the thing that failed -- a stale error under a field being
                // edited reads as though the new value had failed too.
                if (phase.status === "error") setPhase({ status: "idle" });
              }}
              disabled={phase.status === "sending"}
            />
            <button
              type="submit"
              disabled={phase.status === "sending" || email.trim().length === 0}
            >
              {phase.status === "sending" ? "Sending..." : submitLabel}
            </button>
            {secondary?.({ sending: phase.status === "sending" })}
          </form>
          {phase.status === "error" && (
            <p role="alert" className="magic-link-error">
              Could not send the link: {phase.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
