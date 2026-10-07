/**
 * `POST /auth/magic-link` + `POST /auth/magic-link/verify` (ticket 9f06f8f,
 * epic 2b9e9dd child 4) -- real email verification layered on top of the
 * anonymous per-browser identity ticket dba885e established.
 *
 * WHY MAGIC LINK AND NOT OAUTH (decision made live with Nicole, recorded on
 * the ticket): she had previously shipped "Login with Google" on another
 * project and never got around to adding a second provider, plausibly losing
 * users without a Google account silently. A magic link needs exactly one
 * integration, ever, and works for anyone with an inbox; OAuth needs a new
 * provider integration every time a user turns up without the one you already
 * built.
 *
 * WHEN THIS IS OFFERED: only after scored results land, never before (epic
 * 2b9e9dd's reasoning -- nothing before that point is worth protecting, and
 * "verify after value" is where PLG practice and NN/g's reciprocity principle
 * happen to give the same answer). That placement is enforced in the
 * frontend, not here; this file would happily mint a link at any time, and
 * deliberately does not try to police when the UI asks.
 *
 * ================= THE FOUR SECURITY PROPERTIES ==================
 *
 * 1. UNGUESSABILITY. A token is 32 bytes of `randomBytes` (256 bits),
 *    base64url-encoded. Only its sha256 is stored (see `magicLinkTokens`'s own
 *    doc comment in db/schema.ts for why the raw value is never persisted),
 *    so the database is not a credential store.
 *
 * 2. EXPIRY. `MAGIC_LINK_TTL_MS`, checked as part of the same conditional
 *    UPDATE that claims the token, so there is no window where a token is
 *    "checked valid" and then acted on after it has lapsed.
 *
 * 3. SINGLE USE. `used_at` is set by `UPDATE ... WHERE token_hash = $1 AND
 *    used_at IS NULL AND expires_at > now`, and the row count of THAT
 *    statement is the authorization decision. This is the one part of this
 *    file that must not be refactored into a SELECT-then-UPDATE: two
 *    simultaneous clicks of the same emailed link (a real thing -- a
 *    double-tap, a client that prefetches, a user forwarding the mail to
 *    themselves) would both read `used_at IS NULL` and both succeed. As a
 *    single conditional UPDATE, Postgres serializes them on the row and
 *    exactly one gets a row back.
 *
 * 4. NO ACCOUNT FIXATION. The ATTACH branch -- and only that branch -- also
 *    requires that the browser VERIFYING is the browser that REQUESTED
 *    (`resolveIdentity`'s `different_browser` refusal). Added in review round
 *    4 after fable reproduced a full account-takeover end to end without it:
 *    nothing authenticates who requests a link, so an attacker could POST
 *    `/auth/magic-link` for `victim@` carrying their OWN `x-user-id`, and the
 *    victim's click on a perfectly genuine email would then attach `victim@`
 *    to the ATTACKER's user row and hand that id back for the victim's
 *    browser to adopt -- permanently, since the victim's own later link for
 *    their own address just adopts the same attacker-controlled row. The
 *    ADOPT branch stays reachable from any browser: that is second-device
 *    sign-in, it only ever requires control of the inbox, and it is not part
 *    of the attack (it points the verifier at the address's OWN pre-existing
 *    account, never at an id the attacker chose).
 *
 * WHY VERIFY IS A POST WITH THE TOKEN IN THE BODY. The emailed link points at
 * the SPA (`#magicLinkToken=...`), which reads the token and POSTs it here.
 * Four things fall out of that, all deliberate:
 *   - A GET endpoint carrying the token in its path/query would land the
 *     credential in this app's own request logs, in any intermediary's logs,
 *     and in the `Referer` of every subsequent request from that page.
 *   - The token rides in the URL FRAGMENT, not a query parameter (review
 *     round 4, F2). The API-side design above keeps it out of THIS server's
 *     logs, but `?magicLinkToken=...` would still be logged by whatever
 *     static host serves the SPA, in full, before any of this app's code
 *     runs. A fragment is never sent to any server, proxy, or `Referer`
 *     header at all -- only the browser ever sees it.
 *   - Consuming a token requires running JavaScript and issuing a POST, so
 *     the link scanners and prefetchers that follow URLs in mail (SafeLinks
 *     and friends) do not burn the user's one-shot token by looking at it.
 *   - The frontend strips the fragment with `history.replaceState` as soon as
 *     the response lands, so the token does not linger in the address bar or
 *     in browser history.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DO: rate limiting or abuse
 * prevention beyond correctness (explicitly out of scope per the ticket --
 * "a real security review of the email-sending surface is worth its own pass
 * if this gets real usage"). As it stands, one caller can ask for many links
 * for many addresses. That is a real, known gap, recorded here rather than
 * half-fixed: the honest fix is a per-IP and per-address limiter plus a
 * provider-side send cap, which is its own ticket.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type {
  MagicLinkOutcome,
  MagicLinkRejectionReason,
  RequestMagicLinkResponse,
  VerifyMagicLinkResponse,
} from "@app/shared";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { magicLinkTokens, users } from "../db/schema.js";
import type { SendEmailFn } from "../email/sender.js";
import { requireUserId } from "../identity.js";

/**
 * Fifteen minutes. Long enough to walk to another device, open a mail client
 * that syncs on a timer, and click; short enough that a link sitting in an
 * inbox someone else later gains access to is usually already dead. Not
 * backed by a measurement -- it is the industry-conventional window (Slack,
 * Notion, and Postmark's own guidance all sit in the 10-30 minute band) and
 * the shortest value in that band that does not punish a slow mail sync.
 */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;

/**
 * Where the emailed link points. The API cannot derive this: it is a
 * different origin from this server by design (CLAUDE.md's "separate app
 * forces a real REST contract boundary"), and the `Origin`/`Referer` of the
 * requesting call is attacker-controlled -- building the link from it would
 * let anyone who can reach this route mail a victim a link pointing at a site
 * of their choosing, with a valid token attached. So it comes from
 * configuration, with the local Vite dev default, and never from the request.
 */
function webAppBaseUrl(): string {
  return process.env.WEB_APP_BASE_URL ?? "http://localhost:5173";
}

/**
 * Deliberately permissive and deliberately not an RFC 5322 parser. The real
 * validator for an email address is "a message to it was accepted", which
 * happens a few lines later at the provider; the job here is only to reject
 * obvious nonsense (no `@`, whitespace, an empty local part) before spending
 * a send on it. An over-strict regex here rejects real addresses -- the
 * classic own-goal of this exact check -- which is a worse failure than
 * letting a typo reach Resend and come back as a clear error.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Bounds the stored/compared value. 254 is the maximum length of a
 * deliverable address (RFC 5321's 256-octet path minus the angle brackets),
 * so anything longer cannot be a real inbox. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Lowercased and trimmed. The local part of an address is, strictly,
 * case-SENSITIVE per RFC 5321, but no mail provider in practice treats
 * `Alice@` and `alice@` as two inboxes, and `users.email` is `.unique()` --
 * so preserving case would let the same real person hold two accounts that
 * can never be merged, purely on how they capitalized their own address the
 * first time. Every write and every comparison in this file goes through
 * this one function so the two can never drift.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const requestMagicLinkBodySchema = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: MAX_EMAIL_LENGTH },
  },
  additionalProperties: false,
} as const;

const verifyMagicLinkBodySchema = {
  type: "object",
  required: ["token"],
  properties: {
    // A base64url encoding of 32 bytes is always 43 characters. Bounded on
    // both sides so a caller cannot make this route hash megabytes of input.
    token: { type: "string", minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
} as const;

/**
 * Thrown from inside the verify transaction to roll it back -- crucially
 * including the `used_at` claim, so a refusal never burns the user's token.
 * See the `browser_already_claimed` branch for why this case exists at all.
 */
class MagicLinkRefusal extends Error {
  constructor(
    readonly reason: MagicLinkRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = "MagicLinkRefusal";
  }
}

/**
 * Postgres's unique-violation SQLSTATE, walked through the `cause` chain
 * because drizzle-orm wraps driver errors (`DrizzleQueryError`) rather than
 * rethrowing the `pg` error object directly -- checking `err.code` alone
 * silently never matches, which would turn the recoverable race in
 * `resolveIdentity` into a 500.
 */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  /**
   * Lazily produces the real email sender. A factory, not a value, for
   * exactly the reason `BuildAppDeps.getScoreJob` is one (see index.ts): the
   * Resend client needs `RESEND_API_KEY`, and no other route -- nor `pnpm
   * build`, nor `rtk vitest` -- may be made to depend on that secret
   * existing. Called on the first actual send, and the failure to configure
   * it is therefore one route's 503, never a boot failure.
   */
  getSendEmail: () => SendEmailFn,
): void {
  app.post<{ Body: { email: string } }>(
    "/auth/magic-link",
    { schema: { body: requestMagicLinkBodySchema } },
    async (request, reply) => {
      const email = normalizeEmail(request.body.email);
      if (!EMAIL_RE.test(email) || email.length > MAX_EMAIL_LENGTH) {
        return reply
          .code(400)
          .send({ error: `"${request.body.email}" is not a usable email address.` });
      }

      // The browser that ASKED. This is what a brand-new email attaches to
      // ("claiming my anonymous session"), captured now rather than at verify
      // time -- the link may well be opened on a different device, whose own
      // anonymous id is irrelevant to whose session is being claimed.
      const requestingUserId = requireUserId(request);

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

      // Written BEFORE the send, deliberately: a token that reaches an inbox
      // but is not in the database is a link that cannot ever work, which is
      // strictly worse than the opposite failure (a row nobody can redeem,
      // which expires on its own in fifteen minutes and is not a credential
      // -- only its hash is stored).
      await db.insert(magicLinkTokens).values({
        id: randomUUID(),
        tokenHash: hashToken(token),
        email,
        requestingUserId,
        expiresAt,
      });

      const linkUrl = new URL(webAppBaseUrl());
      // A FRAGMENT, not a query parameter -- see this file's header (property
      // 4's sibling note on WHY VERIFY IS A POST). Assigned as one string
      // rather than via `searchParams` so it cannot end up on the wrong side
      // of the `#`. Safe without encoding: the token is base64url (A-Z a-z
      // 0-9 `-` `_`), none of which means anything in a fragment.
      linkUrl.hash = `magicLinkToken=${token}`;
      const link = linkUrl.toString();
      const minutes = Math.round(MAGIC_LINK_TTL_MS / 60_000);

      try {
        // Ticket 5130866 (opus notes N3/N4 on ticket 5a7e957's review). This
        // request now comes from two origins that get the exact same email:
        // `MagicLinkPrompt`, saving fresh results under a brand-new address,
        // and `SignInRecovery`, someone whose browser storage is gone trying
        // to get an EXISTING account back. The old opening line --
        // "save your job search results to this email address" -- read as
        // though clicking would overwrite the recovery user's account with
        // this (empty) browser's nothing, which is backwards and alarming for
        // the one person who most needs to click. "Sign in and connect" is
        // true of both: a brand-new address gets tied to these results
        // (attach), an existing one gets its results back (adopt), and
        // neither word implies which. Deliberately NOT branched by an
        // `intent` the client would have to assert on this request (see the
        // route's own doc comment on `resolveIdentity`'s two branches) --
        // this route must not become an account-enumeration oracle, and a
        // single neutral sentence serves both origins for free.
        await getSendEmail()({
          to: email,
          subject: "Your sign-in link for AI-Assisted Job Search",
          text: [
            "Click this link to sign in and connect your job search results to this email address:",
            "",
            link,
            "",
            `The link works once and expires in ${minutes} minutes.`,
            "If you didn't ask for this, you can ignore this email — nothing has changed.",
          ].join("\n"),
          html: [
            `<p>Click this link to sign in and connect your job search results to this email address:</p>`,
            `<p><a href="${escapeHtmlAttribute(link)}">Sign in to AI-Assisted Job Search</a></p>`,
            `<p>The link works once and expires in ${minutes} minutes.</p>`,
            `<p>If you didn't ask for this, you can ignore this email — nothing has changed.</p>`,
          ].join("\n"),
        });
      } catch (err) {
        // 503, not 500: this is a dependency we could not reach or are not
        // configured for. Logged with the real provider message (never the
        // token or the link, both of which are credentials) -- that log
        // line is the ONLY place the provider's real error goes; the
        // response below stays generic on purpose (see the comment there).
        request.log.error({ err }, "magic-link email send failed");
        // Ticket 43423eb: "Please try again in a moment" was a transience
        // claim the system could not back up. CAUSE CONFIRMED (ticket
        // comment, 2026-10-06): the deployed failure was Resend's 403 for
        // an unverified sender domain, which is permanent until someone
        // changes configuration -- every retry a real user made was
        // guaranteed to fail, and the UI told him to keep making them.
        // This route cannot tell a transient dependency hiccup apart from a
        // permanent one (that classification is a separate, larger ticket:
        // it needs Resend's error taxonomy, and guessing wrong is worse
        // than one honest generic message), so the replacement copy makes
        // no claim about whether trying again will help either way. It
        // states only what is true unconditionally: the attempt failed,
        // and it is in the log line just above -- not a status page, an
        // email, or a human already on it, none of which exist.
        return reply.code(503).send({
          error:
            "Could not send the sign-in email just now. The failure has been logged on our end.",
        });
      }

      // Identical for a brand-new address and for one that already owns an
      // account -- see `RequestMagicLinkResponse`'s doc comment (@app/shared)
      // on why this route must not be an account-enumeration oracle.
      const response: RequestMagicLinkResponse = { email, expiresAt: expiresAt.toISOString() };
      return reply.code(200).send(response);
    },
  );

  app.post<{ Body: { token: string } }>(
    "/auth/magic-link/verify",
    { schema: { body: verifyMagicLinkBodySchema } },
    async (request, reply) => {
      const tokenHash = hashToken(request.body.token);
      // The browser doing the VERIFYING, which is a different question from
      // the browser that requested the link. Both are needed: the ADOPT
      // branch ignores this one (second-device sign-in is the feature), the
      // ATTACH branch requires it to match (security property 4 -- account
      // fixation).
      const verifierUserId = requireUserId(request);

      let resolved: { userId: string; email: string; outcome: MagicLinkOutcome };
      try {
        resolved = await claimAndResolve(db, tokenHash, verifierUserId);
      } catch (err) {
        if (err instanceof MagicLinkRefusal) {
          return reply.code(400).send({ error: err.message, reason: err.reason });
        }
        throw err;
      }

      const response: VerifyMagicLinkResponse = resolved;
      return reply.code(200).send(response);
    },
  );
}

/**
 * Claims the token and resolves which `users` row the verifying browser
 * should be from now on, atomically -- one transaction, so a refusal or a
 * failure ANYWHERE in the resolution rolls the `used_at` claim back too and
 * leaves the user's link still usable. Burning a one-shot token on a
 * transient database error would be a genuinely unrecoverable dead end for
 * the user (their only recourse is a whole new email), which is why the
 * claim is not committed separately from the resolution it authorizes.
 *
 * Retries ONCE on a unique violation, which has exactly one reachable cause
 * here: two verifications for the SAME new email, in flight at the same
 * moment, from two different anonymous browsers (each redeeming its OWN
 * link from its OWN browser, so both clear the `different_browser` check).
 * Both pass the "no users row has this email" check, then the second one's
 * `UPDATE users SET email` collides on `users_email_unique`. Because the
 * loser's transaction rolls back, its token is un-claimed, and the retry
 * takes the ADOPT branch instead (the email now demonstrably exists) -- which
 * is the correct outcome for it: both browsers end up pointed at the same
 * single account, which is what one person verifying the same address twice
 * means. Raced for real in auth.test.ts ("two SIMULTANEOUS first
 * verifications..."), not merely reasoned about.
 *
 * `verifierUserId` is the `x-user-id` of the request being served -- passed
 * all the way down because only `resolveIdentity`'s attach branch may consult
 * it, and it must be compared INSIDE this transaction so a mismatch rolls the
 * `used_at` claim back with everything else.
 */
async function claimAndResolve(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  tokenHash: string,
  verifierUserId: string,
): Promise<{ userId: string; email: string; outcome: MagicLinkOutcome }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const now = new Date();

        // THE AUTHORIZATION DECISION, and it is this statement's row count --
        // see this file's header, property 3. Expiry and single-use are both
        // conjuncts here rather than separate checks, so neither can be true
        // "as of a moment ago".
        const claimed = await tx
          .update(magicLinkTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(magicLinkTokens.tokenHash, tokenHash),
              isNull(magicLinkTokens.usedAt),
              gt(magicLinkTokens.expiresAt, now),
            ),
          )
          .returning({
            email: magicLinkTokens.email,
            requestingUserId: magicLinkTokens.requestingUserId,
          });

        if (claimed.length === 0) {
          throw await classifyClaimFailure(tx, tokenHash, now);
        }

        const { email, requestingUserId } = claimed[0]!;
        return await resolveIdentity(tx, email, requestingUserId, verifierUserId);
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

/**
 * Turns "the conditional UPDATE matched nothing" into the specific reason,
 * for the error message ONLY. This read happens AFTER the authorization
 * decision has already been made (and made negatively), so the fact that it
 * races -- a token could be claimed by someone else between the UPDATE and
 * this SELECT -- cannot grant anyone anything; at worst it mislabels a
 * refusal that was already a refusal.
 */
async function classifyClaimFailure(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: NodePgDatabase<any>,
  tokenHash: string,
  now: Date,
): Promise<MagicLinkRefusal> {
  const rows = await tx
    .select({ usedAt: magicLinkTokens.usedAt, expiresAt: magicLinkTokens.expiresAt })
    .from(magicLinkTokens)
    .where(eq(magicLinkTokens.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    // Phrased so it neither confirms nor denies that such a token ever
    // existed -- the one place in this file where being vague is the point.
    return new MagicLinkRefusal(
      "invalid",
      "That sign-in link isn't valid. Request a new one to sign in.",
    );
  }
  if (row.usedAt !== null) {
    return new MagicLinkRefusal(
      "already_used",
      "That sign-in link has already been used. Sign-in links work only once — request a new one.",
    );
  }
  // Only expiry is left: the row exists, is unused, so `expires_at > now`
  // must be what failed.
  const minutesAgo = Math.max(1, Math.round((now.getTime() - row.expiresAt.getTime()) / 60_000));
  return new MagicLinkRefusal(
    "expired",
    `That sign-in link expired ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago. Request a new one to sign in.`,
  );
}

/**
 * The two identity-resolution branches this ticket exists for, plus the two
 * cases the ticket did not enumerate (a browser that already carries a
 * different email, and a link redeemed from a browser that did not ask for
 * it).
 *
 * THE TWO BRANCHES TRUST DIFFERENT THINGS, AND THAT ASYMMETRY IS THE WHOLE
 * SECURITY DESIGN:
 *
 *  - ADOPT trusts the INBOX only. The address already has an account, so the
 *    only thing redemption can do is point the verifier at that account --
 *    an id chosen by nobody, already carrying that address's own data. Any
 *    browser may do this; that IS second-device sign-in.
 *  - ATTACH trusts the inbox AND the browser. It writes an address onto a
 *    `users` row named by `requesting_user_id`, which is a client-asserted,
 *    unauthenticated value captured from whoever POSTed `/auth/magic-link`.
 *    Anyone can request a link for anyone's address, so if this branch
 *    accepted a click from an arbitrary browser, the requester would get to
 *    CHOOSE which account a stranger's verified email lands on. See
 *    `different_browser` below.
 */
async function resolveIdentity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: NodePgDatabase<any>,
  email: string,
  requestingUserId: string,
  /** The `x-user-id` of the request being served right now -- NOT the one
   * stored on the token. Consulted by the attach branch only. */
  verifierUserId: string,
): Promise<{ userId: string; email: string; outcome: MagicLinkOutcome }> {
  // BRANCH 1 -- "logging in from a second device". A `users` row already
  // carries this email, so this browser adopts THAT user, and every resume,
  // search and result already attached to it comes with it. Nothing is
  // copied or migrated: per-user scoping (ticket 3fc1e5e) is by `user_id`
  // everywhere, so being that user IS having that data.
  //
  // Checked FIRST, before anything about the requesting browser, and that
  // order is load-bearing: it is what makes "sign in as a different person
  // on a browser that already has an account" work as a plain account
  // switch, with no data touched on either side.
  const existing = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    return { userId: existing[0]!.id, email, outcome: "adopted" };
  }

  // BRANCH 2 -- "claiming my anonymous session". No row has this email, so
  // it attaches to the anonymous user that requested the link. `userId` does
  // not change, which is precisely why the ticket's "existing resumes/results
  // are visible immediately, no separate migration step" criterion is
  // satisfied by construction: there were never two identities, only one
  // gaining an email.
  //
  // FIRST, THE GUARD THAT MAKES THAT SAFE (security property 4, review round
  // 4). This branch is the only place in the app where an unauthenticated,
  // client-chosen id (`requesting_user_id`, captured from whoever POSTed
  // `/auth/magic-link`, which requires no authentication of any kind) gets an
  // email written onto it and is then handed back as the caller's identity.
  // Without this check, fable's round-3 review took a full account over end
  // to end: attacker POSTs `/auth/magic-link {email: "victim@"}` with their
  // own `x-user-id` A, the victim gets a genuine email and clicks it in their
  // own browser, this branch writes `victim@` onto row A, and the victim's
  // browser adopts A -- so every resume and search the victim makes from then
  // on is readable and deletable by the attacker, with no recovery (the
  // victim's own later link for their own address now takes the ADOPT branch
  // into that same row A).
  //
  // Requiring the verifier to be the requester closes it completely: an
  // attacker can still make a stranger's inbox receive a link, but the only
  // browser that link can attach anything from is the attacker's own, where
  // it attaches the attacker's OWN address to the attacker's OWN row and
  // grants nothing. Note this costs the legitimate user nothing after the
  // first attach -- from then on the address HAS an account, so every other
  // device takes the ADOPT branch, which is deliberately unbound.
  //
  // Thrown, so it rolls the whole transaction back INCLUDING the `used_at`
  // claim: the real requester's link must still work afterward, exactly like
  // the `browser_already_claimed` refusal below.
  //
  // Compared in constant time, for a reason specific to this check: a refusal
  // here does NOT consume the token, so an attacker holding one may retry it
  // an unlimited number of times, which is exactly the condition a statistical
  // timing attack needs -- and the value being compared against
  // (`requesting_user_id`) is not merely an identifier in this app, it IS the
  // bearer credential (`x-user-id`, identity.ts). A naive `!==` on two strings
  // is not constant time in V8.
  if (!constantTimeEquals(verifierUserId, requestingUserId)) {
    throw new MagicLinkRefusal(
      "different_browser",
      "Open this sign-in link in the browser you asked for it from. Once your email address is attached there, you can sign in from any other browser or device.",
    );
  }

  const requesting = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, requestingUserId))
    .limit(1);

  // THE THIRD CASE, WHICH THE TICKET DID NOT ENUMERATE, AND WHY IT REFUSES.
  // The requesting browser's own user row ALREADY carries a different email
  // (it verified alice@ earlier, and is now redeeming a link for bob@, where
  // bob@ is new to this app). Plain `UPDATE users SET email = 'bob@'` would
  // silently RELABEL alice's whole account -- her resumes, searches and
  // results -- as belonging to bob, and alice could never sign in again
  // because her address would no longer exist anywhere. That is data theft by
  // typo, so it must not be the default.
  //
  // The rejected alternative was to mint a FRESH `users` row for bob@ and
  // point the browser at it. It fails on a documented invariant: `users.id`
  // is "NEVER server-generated" (db/schema.ts, ticket dba885e) -- ids are
  // minted client-side and the server only ever lazily inserts one it was
  // shown. Breaking that here, inside the one route that hands out an
  // identity, is a bigger change than this ticket should make on its own.
  //
  // So this refuses, with a reason the frontend can explain and a token that
  // is NOT consumed (the throw rolls the whole transaction back, `used_at`
  // included -- so the same link still works from a browser that isn't
  // already claimed, e.g. a private window). A proper answer needs an
  // explicit sign-out, which is its own ticket.
  const currentEmail = requesting[0]?.email ?? null;
  if (currentEmail !== null && !constantTimeEquals(currentEmail, email)) {
    throw new MagicLinkRefusal(
      "browser_already_claimed",
      `This browser is already signed in as ${currentEmail}. Open this link in a different browser (or a private window) to sign in as ${email}.`,
    );
  }

  // `requesting[0]` being absent is unreachable in practice -- the row is
  // FK-referenced by the token that got us here -- but an `UPDATE` matching
  // nothing would silently report success, so the attach is verified by its
  // own returned row rather than assumed.
  const attached = await tx
    .update(users)
    .set({ email })
    .where(eq(users.id, requestingUserId))
    .returning({ id: users.id });
  if (attached.length === 0) {
    throw new MagicLinkRefusal(
      "invalid",
      "That sign-in link isn't valid. Request a new one to sign in.",
    );
  }
  return { userId: attached[0]!.id, email, outcome: "attached" };
}

/**
 * Constant-time string equality, used by both of `resolveIdentity`'s
 * refusal decisions:
 *
 *  - two already-normalized email addresses. Not because an email is secret
 *    -- it is not -- but because that comparison decides whether the caller is
 *    told the OTHER address on the account (`browser_already_claimed`'s
 *    message names it), and a length/prefix-timing side channel on that
 *    decision is free to remove here.
 *  - the verifying browser's id against the token's `requesting_user_id`,
 *    where the value on the other side genuinely IS a credential -- see that
 *    call site's own note.
 *
 * Length is compared first and short-circuits, which is not a leak worth
 * caring about at either call site (a UUID's length is fixed; an address's
 * length is already implied by the message that names it).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Minimal escaping for interpolating a URL into an `href="..."`. The URL is
 * built from configuration plus a base64url token (no `<`, `>`, `&`, or
 * quotes possible in either), so this is belt-and-braces against a future
 * `WEB_APP_BASE_URL` containing something surprising -- not a general-purpose
 * HTML escaper, and it must not be reused as one. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
