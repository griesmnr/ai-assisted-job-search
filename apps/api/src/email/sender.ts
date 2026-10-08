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
 *
 * WHY SENDGRID TOO (ticket 184b9ae). Exactly the swap anticipated above, just
 * forced by deliverability rather than cost: Resend only accepts a `from` on
 * a domain the account has verified, verifying a domain needs DNS records,
 * and that DNS task turned out to be genuinely hostile for this account's
 * registrar (confirmed on the ticket) rather than a knowledge gap. SendGrid's
 * Single Sender Verification needs no DNS -- it verifies one address by
 * emailing it a link -- so `makeSendgridSender` below is a second `SendEmailFn`
 * implementation, reached the same way (one bare `fetch`, no SDK dependency).
 * `makeEmailSenderFromEnv` picks a provider by which API key is present in
 * the environment (`SENDGRID_API_KEY` wins if both are set) rather than a new
 * `EMAIL_PROVIDER` variable, so turning this on is one variable added and
 * nothing removed -- and switching back to Resend, once a domain is
 * eventually verified, is just as cheap because `makeResendSender` was never
 * touched.
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

/** How long to wait on the email provider before giving up -- shared by both
 * senders below, Resend and SendGrid alike (review F4: this said "on Resend"
 * while SendGrid was already using it). A magic-link request is a
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

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

/**
 * Splits `MAGIC_LINK_FROM_EMAIL`'s existing `"Name <addr>"` format (Resend
 * takes that string directly) into SendGrid's `from: { email, name }` shape.
 * A bare address with no angle brackets is the email with no name -- the
 * variable's format itself does not change for this (see this file's header
 * and `.env.example`), only how the SendGrid sender reads it.
 *
 * An EMPTY display name (`<addr>`) omits `name` rather than sending `name: ""`.
 * SendGrid's reference marks `name` optional (`required: ["email"]`) and says
 * nothing about empty-string handling, so omitting it is the only
 * documented-safe option rather than a guess.
 *
 * KNOWN COSMETIC LIMIT, disclosed rather than discovered later: an RFC 5322
 * QUOTED display name (`"FitScore" <addr>`) keeps its literal quote
 * characters, so the recipient's From line would read `"FitScore"` with
 * visible quotes. Not a send failure, and not reachable from the current
 * configuration -- `MAGIC_LINK_FROM_EMAIL` is set to an unquoted
 * `FitScore <addr>`. Strip the quotes here if a quoted form is ever needed.
 */
function parseFromAddress(fromAddress: string): { email: string; name?: string } {
  const match = /^(.*)<([^>]+)>\s*$/.exec(fromAddress);
  if (match === null) {
    return { email: fromAddress.trim() };
  }
  const name = match[1]!.trim();
  const email = match[2]!.trim();
  return name.length > 0 ? { email, name } : { email };
}

export function makeSendgridSender(apiKey: string, fromAddress: string): SendEmailFn {
  const from = parseFromAddress(fromAddress);
  return async (message) => {
    // Same `AbortSignal.timeout` discipline as `makeResendSender`, and the
    // same reasoning: a provider hanging must surface as a clear, retryable
    // failure rather than a request that never answers.
    let response: Response;
    try {
      response = await fetch(SENDGRID_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from,
          subject: message.subject,
          // Both parts, in this order, for the same anti-spam reason
          // `EmailMessage.text` is required at all (see its own comment).
          content: [
            { type: "text/plain", value: message.text },
            { type: "text/html", value: message.html },
          ],
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // A network-level failure or the timeout above. Deliberately does NOT
      // include the request body or the key -- matches `makeResendSender`.
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`SendGrid request failed: ${reason}`, { cause: err });
    }

    // A successful send answers 202 Accepted, NOT 200 -- `response.ok` is
    // true for any 2xx status, so this already handles that correctly. A
    // check written against `response.status === 200` specifically would
    // make every successful send look like a failure.
    if (!response.ok) {
      // SendGrid's error shape is `{ errors: [{ message, field, help }] }` --
      // different from Resend's `{ message }`. Same best-effort read as the
      // Resend sender: never assume it parses, since a proxy/edge error in
      // front of the API answers HTML, not JSON.
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body: unknown = await response.json();
        const errors = (body as { errors?: unknown } | null)?.errors;
        const first = Array.isArray(errors) ? (errors[0] as unknown) : undefined;
        const providerMessage = (first as { message?: unknown } | undefined)?.message;
        if (typeof providerMessage === "string" && providerMessage.length > 0) {
          detail = `${response.status} ${providerMessage}`;
        }
      } catch {
        // Non-JSON body -- the status line stands.
      }
      throw new Error(`SendGrid rejected the message: ${detail}`);
    }
  };
}

/**
 * Reads `SENDGRID_API_KEY` and `MAGIC_LINK_FROM_EMAIL` from the environment
 * and builds the real sender. THROWS if either is missing, for the same
 * reason `makeResendSenderFromEnv` does -- the throw must happen on an
 * actual send attempt, where it becomes one route's clear 503, never at
 * import or boot time.
 */
export function makeSendgridSenderFromEnv(): SendEmailFn {
  const apiKey = process.env.SENDGRID_API_KEY;
  const fromAddress = process.env.MAGIC_LINK_FROM_EMAIL;
  const missing = [
    apiKey === undefined || apiKey.length === 0 ? "SENDGRID_API_KEY" : undefined,
    fromAddress === undefined || fromAddress.length === 0 ? "MAGIC_LINK_FROM_EMAIL" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    throw new Error(
      `Email sending is not configured: ${missing.join(", ")} must be set (see .env.example).`,
    );
  }
  return makeSendgridSender(apiKey!, fromAddress!);
}

/**
 * Picks the real sender by which API key is present in the environment
 * (ticket 184b9ae) -- NOT a new `EMAIL_PROVIDER` variable, so enabling
 * SendGrid is one variable added and nothing removed, and an existing
 * `RESEND_API_KEY` can stay in place harmlessly:
 *
 *   - `SENDGRID_API_KEY` set -> SendGrid, via `makeSendgridSenderFromEnv`.
 *   - else `RESEND_API_KEY` set -> Resend, via `makeResendSenderFromEnv`,
 *     behaviour unchanged.
 *   - neither -> throws naming both, lazily, at first send.
 *
 * SendGrid wins when both keys are set. This is the function `index.ts`
 * wires in as the default `getSendEmail` -- passed as the function itself,
 * not called there, which is what keeps this lazy: nothing here reads the
 * environment until `routes/auth.ts` calls `getSendEmail()` inside the
 * `POST /auth/magic-link` handler, never at module load or server boot.
 */
export function makeEmailSenderFromEnv(): SendEmailFn {
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (sendgridKey !== undefined && sendgridKey.length > 0) {
    return makeSendgridSenderFromEnv();
  }
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey !== undefined && resendKey.length > 0) {
    return makeResendSenderFromEnv();
  }
  throw new Error(
    "Email sending is not configured: set SENDGRID_API_KEY or RESEND_API_KEY (see .env.example).",
  );
}
