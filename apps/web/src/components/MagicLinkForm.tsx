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
  onSendStarted,
  sentHeadingLevel: SentHeading = "h3",
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
  /** Called when a send STARTS -- deliberately at submit, not on success.
   * Exists so a caller whose VISIBILITY is controlled from outside can keep
   * itself on screen for the rest of the exchange: a link the user has already
   * asked for is not an offer, and neither is the receipt that follows, so
   * neither may vanish because the surrounding conditions for *offering*
   * stopped holding.
   *
   * Opus review round 3 (B3): latching on SUCCESS left a window the width of
   * the request. `SignInRecovery` unmounted mid-flight when the gate closed,
   * destroying `phase: "sending"`; the response then re-mounted a fresh form
   * and showed an empty offer where the receipt belonged -- the email sent,
   * and the user never told, which is the exact failure B2 was blocked on. */
  onSendStarted?: () => void;
  /** Heading level for the confirmation, so it matches where the caller sits in
   * the document outline. Opus review round 3 (S1): N6 moved the recovery
   * panel's pitch to `h2` and renamed the `.sign-in-recovery-open h3` rule with
   * it, but the confirmation heading lives HERE and stayed an `h3` -- so in that
   * panel it both skips a level under the `h1` (N6's own reason) and, after the
   * rename, matched no rule in index.css at all, falling back to the UA's
   * 1.17em and 1em top margin inside a 0.75rem-padded card. */
  sentHeadingLevel?: "h2" | "h3";
  submitLabel?: string;
}) {
  const fieldId = useId();
  const [email, setEmail] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });

  async function handleSubmit() {
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    onSendStarted?.();
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
          <SentHeading>Check your inbox</SentHeading>
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
            // Ticket 43423eb, fix F1: this used to prefix every message
            // with "Could not send the link:", which stuttered against the
            // 503 copy's own "Could not send the sign-in email just now" --
            // the exact doubled wording Nicole read aloud off her screen
            // when she filed the ticket. `phase.message` is already a
            // complete, caller-facing sentence for every realistic path
            // into this state: the API's 503 ("Could not send the sign-in
            // email just now. The failure has been logged on our end."),
            // its 400 (`"x" is not a usable email address.`), and the
            // client's own network-unreachable message (`Could not reach
            // the API at ${API_BASE_URL}: ${reason}`, client.ts). The one
            // degenerate case -- a non-JSON error body falling back to the
            // bare `${status} ${statusText}` at client.ts's `request()` --
            // is not meaningfully improved by the prefix either ("Could not
            // send the link: 503 Service Unavailable" is no clearer than
            // "503 Service Unavailable" alone), so it is not a reason to
            // keep stuttering the common case to patch an uncommon one.
            <p role="alert" className="magic-link-error">
              {phase.message}
            </p>
          )}
        </>
      )}
    </div>
  );
}
