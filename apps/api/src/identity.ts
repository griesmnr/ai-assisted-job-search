/**
 * Ticket dba885e (epic 2b9e9dd, child 1): the anonymous per-browser
 * identity every route (with two narrow exemptions -- see
 * `registerIdentity`'s own doc comment) now requires. Every other
 * request carries an `x-user-id` header -- a `crypto.randomUUID()`
 * minted client-side (apps/web/src/identity.ts) the first time a browser
 * needs one, never a server-generated value -- and this hook is the ONE
 * place that turns that header into `request.userId` for a route handler
 * to read.
 *
 * Deliberately a plain, unsigned UUID, not a signed session token: at
 * this stage nothing behind it is more sensitive than "which browser is
 * this" (see epic 2b9e9dd's own design -- nothing before a resume is
 * scored is worth protecting), and a UUID's 122 bits of randomness is
 * already unguessable in practice, the same trust level this app already
 * places in `estimateRequestId` (SearchFlow.tsx) and `handoffs.id`
 * (routes/handoffs.ts's own doc comment: "a UUID is already unguessable:
 * a separate token column would be the same amount of secrecy for more
 * schema"). Ticket 9f06f8f's magic-link tokens get REAL signing/expiry/
 * single-use enforcement, because that step is what actually asserts "I
 * am this real person" -- this one only ever asserts "I am the same
 * browser as before."
 *
 * `onConflictDoNothing` on the lazy-create makes this idempotent and
 * race-safe: two near-simultaneous first requests from a brand-new
 * browser (e.g. the frontend firing `GET /sources` and `POST /resumes`
 * close together) both attempt the insert; exactly one lands, neither
 * fails.
 */
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import { users } from "./db/schema.js";

export const USER_ID_HEADER = "x-user-id";

// A real crypto.randomUUID() (versions 1-5 all fit this shape) -- loose
// enough to accept any UUID variant/version the frontend might ever mint,
// strict enough to reject "anything at all", e.g. an empty string or a
// guessable short id someone hand-typed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `registerIdentity`'s `onRequest` hook -- see that function's
     * own doc comment. Present on every request that goes through the
     * normal header check. Review fix (B1): genuinely `undefined`, not
     * merely "never happens", on this hook's own two exemptions --
     * `OPTIONS` and `GET /handoffs/:id` both return from the hook BEFORE
     * this is ever assigned, and both DO reach a route handler. Any
     * future handler on an exempt route (there is currently only one:
     * `GET /handoffs/:id`) must not assume this is set. */
    userId?: string;
  }
}

/**
 * Registers the global `onRequest` hook. Two deliberate exemptions:
 *
 *  - `OPTIONS` (CORS preflight): `@fastify/cors` answers these itself,
 *    but Fastify still runs global `onRequest` hooks for every request
 *    Fastify handles, preflight included. Rejecting a preflight for a
 *    missing application header would fail EVERY real cross-origin
 *    request the browser makes right after, since the browser never even
 *    attempts the real request once preflight fails.
 *  - `GET /handoffs/:id`: fetched cross-origin by Nicole's entirely
 *    separate resume-tailoring app (routes/handoffs.ts's own doc
 *    comment) -- that app has no way to know this app's anonymous-id
 *    header scheme, and was never meant to. Its real access control is
 *    already the unguessable handoff id plus a short TTL, not this
 *    header.
 */
export function registerIdentity(
  app: FastifyInstance,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") return;
    if (request.method === "GET" && /^\/handoffs\/[^/]+$/.test(request.url.split("?")[0]!)) {
      return;
    }

    // Review fix: `x-user-id` is not one of the handful of headers Node's
    // HTTP parser arrays up on repetition (that list is short and fixed --
    // `set-cookie` is the main one) -- a request sending this header twice
    // arrives here as ONE comma-joined string, which simply fails
    // `UUID_RE` below like any other malformed value. `typeof raw ===
    // "string"` (not an `Array.isArray` branch that can never actually
    // run over real HTTP) is what that verified behavior actually looks
    // like in code.
    const raw = request.headers[USER_ID_HEADER];
    const userId = typeof raw === "string" ? raw : undefined;
    if (userId === undefined || !UUID_RE.test(userId)) {
      await reply.code(400).send({ error: `Missing or malformed "${USER_ID_HEADER}" header.` });
      return;
    }

    await db.insert(users).values({ id: userId }).onConflictDoNothing({ target: users.id });
    request.userId = userId;
  });
}
