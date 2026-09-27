/**
 * The one outbound-email seam in this app (ticket 9f06f8f, epic 2b9e9dd
 * child 4). Exactly one message type is ever sent today -- the magic link --
 * but the seam is `SendEmailFn`, not `sendMagicLink`, so a future
 * transactional email doesn't need a second, differently-shaped integration.
 *
 * WHY RESEND, AND WHY NOT ITS SDK. Resend is the service the ticket names
 * (simple API, workable free tier at this scale; Postmark is the documented
 * fallback if deliverability ever becomes a real problem). It is reached here
 * through one `fetch` POST against its documented HTTP endpoint rather than
 * through the `resend` npm package, deliberately:
 *
 *   - The SDK is a thin wrapper over exactly this request. Node 22 (this
 *     repo's `engines.node`) has global `fetch`, so the wrapper buys nothing
 *     a dozen lines here don't.
 *   - It keeps a credential-handling dependency out of the lockfile.
 *     `apps/api` has seven runtime dependencies; adding an eighth for one
 *     HTTP POST is not a trade this codebase has made anywhere else (compare
 *     `sources/*.ts`, which all call job boards with bare `fetch`).
 *   - Swapping to Postmark later is then a second `makeXSender` in this file
 *     implementing the same `SendEmailFn`, with no dependency swap at all.
 *
 * WHY EVERY ENTRY POINT HERE IS LAZY. Same non-negotiable `BuildAppDeps.
 * getScoreJob` documents for `ANTHROPIC_API_KEY` (apps/api/src/index.ts):
 * nothing in this app may require `RESEND_API_KEY` to exist in order for
 * `pnpm build`, `rtk vitest`, or any unrelated route to work. So the key is
 * read inside `makeResendSenderFromEnv` at FIRST SEND, never at module load
 * and never at server boot -- a machine that has never configured email
 * serves every other route exactly as before, and only `POST
 * /auth/magic-link` fails (loudly, with a message naming the missing
 * variable) on that machine.
 */

export type EmailMessage = {
  /** Single recipient. Deliberately not `string[]`: every email this app
   * sends is addressed to one person who just typed their own address, and a
   * multi-recipient shape on a magic-link sender is a footgun (one bug away
   * from mailing someone else's login link alongside yours). */
  to: string;
  subject: string;
  /** Plain-text alternative. Required, not optional: a text/plain part is
   * what keeps a transactional message out of spam filters that penalize
   * HTML-only mail, and it is the only part some clients render at all. */
  text: string;
  html: string;
};

/**
 * Sends one message, or throws. Resolving means the provider ACCEPTED the
 * message for delivery -- never that it landed in an inbox, which no
 * provider API can tell us synchronously. Callers must not report "email
 * sent" as a guarantee of receipt (routes/auth.ts's response says "we sent
 * it", which is exactly this claim and no more).
 */
export type SendEmailFn = (message: EmailMessage) => Promise<void>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** How long to wait on Resend before giving up. A magic-link request is a
 * synchronous, user-facing POST -- a provider hanging must surface as a
 * clear failure the user can retry, not as a request that never answers. */
const SEND_TIMEOUT_MS = 10_000;

export function makeResendSender(apiKey: string, fromAddress: string): SendEmailFn {
  return async (message) => {
    // `AbortSignal.timeout` rather than a hand-rolled setTimeout+controller:
    // it cannot leak a pending timer when the fetch settles first.
    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // A network-level failure or the timeout above. The message
      // deliberately does NOT include the request body or the key.
      const reason = err instanceof Error ? err.message : String(err);
      // `cause` keeps the original (an AbortError for the timeout, a
      // TypeError for a DNS/TLS failure) attached for the route's own
      // `request.log.error({ err })` without putting it in the message.
      throw new Error(`Resend request failed: ${reason}`, { cause: err });
    }

    if (!response.ok) {
      // Resend answers errors with `{ statusCode, name, message }`. Read the
      // body best-effort for a usable message, but never assume it parses --
      // a proxy/edge error in front of the API answers HTML.
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body: unknown = await response.json();
        const providerMessage = (body as { message?: unknown } | null)?.message;
        if (typeof providerMessage === "string" && providerMessage.length > 0) {
          detail = `${response.status} ${providerMessage}`;
        }
      } catch {
        // Non-JSON body -- the status line stands.
      }
      throw new Error(`Resend rejected the message: ${detail}`);
    }
  };
}

/**
 * Reads `RESEND_API_KEY` and `MAGIC_LINK_FROM_EMAIL` from the environment and
 * builds the real sender. THROWS if either is missing -- which is correct and
 * is why every caller must call this lazily (see this file's header): the
 * throw must happen on an actual send attempt, where it becomes one route's
 * clear 503, never at import or boot time, where it would take the whole
 * server down on a machine that has no email configured.
 *
 * `MAGIC_LINK_FROM_EMAIL` has no default because there cannot be a correct
 * one: Resend only accepts a `from` on a domain the account has verified, so
 * any invented default would fail at the provider with a much more confusing
 * error than "you have not set this".
 */
export function makeResendSenderFromEnv(): SendEmailFn {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.MAGIC_LINK_FROM_EMAIL;
  const missing = [
    apiKey === undefined || apiKey.length === 0 ? "RESEND_API_KEY" : undefined,
    fromAddress === undefined || fromAddress.length === 0 ? "MAGIC_LINK_FROM_EMAIL" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(
      `Email sending is not configured: ${missing.join(", ")} must be set (see .env.example).`,
    );
  }
  return makeResendSender(apiKey!, fromAddress!);
}
