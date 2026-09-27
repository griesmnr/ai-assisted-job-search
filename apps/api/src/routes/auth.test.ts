/**
 * Ticket 9f06f8f (epic 2b9e9dd, child 4): the magic-link surface, tested
 * against a real Postgres (this repo's convention for DB-backed behavior --
 * see every other file under routes/) and a FAKE email sender.
 *
 * The sender is faked the same way route tests already fake the Anthropic
 * scorer and the AMQP publisher: nothing here sends real mail or needs a real
 * `RESEND_API_KEY`, and the fake records exactly what WOULD have been sent so
 * the "a real email goes out, carrying a working link" criterion is checked
 * on the message itself rather than asserted by inspection.
 */
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ListResumesResponse, VerifyMagicLinkResponse } from "@app/shared";
import { magicLinkTokens, resumes, users } from "../db/schema.js";
import { createPooledTestDatabase, createTestDatabase, type TestDatabase } from "../db/test-db.js";
import type { EmailMessage, SendEmailFn } from "../email/sender.js";
import { loadEnvFile } from "../load-env.js";
import { MAGIC_LINK_TTL_MS } from "./auth.js";
import { buildTestApp as buildApp, injectAs } from "../test-support/build-test-app.js";

loadEnvFile();

let testDb: TestDatabase;
let db: NodePgDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase("auth_magic_link_test");
  db = testDb.db;
});

afterAll(async () => testDb?.teardown());

afterEach(() => {
  vi.unstubAllEnvs();
});

type FakeSender = {
  fn: SendEmailFn;
  sent: EmailMessage[];
};

function fakeSender(): FakeSender {
  const sent: EmailMessage[] = [];
  return {
    sent,
    fn: async (message) => {
      sent.push(message);
    },
  };
}

function failingSender(message: string): SendEmailFn {
  return async () => {
    throw new Error(message);
  };
}

function buildSubject(sender: SendEmailFn, database: NodePgDatabase = db) {
  return buildApp({
    db: database,
    inferTitles: async () => [],
    getScoreJob: () => {
      throw new Error("not used by this test");
    },
    getSendEmail: () => sender,
  });
}

/** The token out of the emailed link -- i.e. the ONLY way a real user ever
 * gets one. Reading it from the message (rather than from the database, which
 * only stores a hash) is deliberate: a test that could not extract a working
 * token from the email is a test that would not have caught a broken link. */
function tokenFromEmail(message: EmailMessage): string {
  const match = /magicLinkToken=([A-Za-z0-9_-]+)/.exec(message.text);
  if (match === null) throw new Error(`no magic-link token in email text: ${message.text}`);
  return match[1]!;
}

async function requestLink(
  app: ReturnType<typeof buildSubject>,
  userId: string,
  email: string,
): Promise<ReturnType<typeof app.inject>> {
  return injectAs(app, userId, {
    method: "POST",
    url: "/auth/magic-link",
    payload: { email },
  });
}

/** A resume owned by `userId`, written straight to the database -- this
 * stands in for "the user already had results before they ever verified",
 * which is what the "visible immediately, no migration step" criterion is
 * about. Read back through the real `GET /resumes` route, never from the
 * table, so the assertion covers the actual per-user read path. */
async function giveUserAResume(userId: string, nickname: string): Promise<string> {
  // The `users` row is normally created lazily by `registerIdentity` on that
  // browser's first request; this fixture runs BEFORE any request, so it has
  // to stand in for that step or `resumes.user_id`'s FK rejects the insert.
  await db.insert(users).values({ id: userId }).onConflictDoNothing({ target: users.id });
  const id = randomUUID();
  await db.insert(resumes).values({
    id,
    userId,
    resumeText: `resume text for ${nickname}`,
    resumeHash: createHash("sha256").update(`${nickname}-${id}`).digest("hex"),
    resumeNickname: nickname,
  });
  return id;
}

describe("POST /auth/magic-link", () => {
  it("sends a real email carrying a working link, and stores only the token's HASH", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "a0000000-0000-4000-8000-000000000001";

    const response = await requestLink(app, userId, "sends@example.com");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: "sends@example.com" });
    const { expiresAt } = response.json() as { expiresAt: string };
    // Within a few seconds of now + TTL -- proves the TTL is real and applied
    // at request time, not left for the verify path to invent.
    const ttlMs = new Date(expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(MAGIC_LINK_TTL_MS - 10_000);
    expect(ttlMs).toBeLessThanOrEqual(MAGIC_LINK_TTL_MS);

    expect(sender.sent).toHaveLength(1);
    const message = sender.sent[0]!;
    expect(message.to).toBe("sends@example.com");
    expect(message.subject).toContain("sign-in link");
    // Both parts carry the link: a text/plain alternative is required, not
    // optional (see EmailMessage's doc comment).
    const token = tokenFromEmail(message);
    expect(message.html).toContain(token);

    const rows = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.requestingUserId, userId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.email).toBe("sends@example.com");
    expect(row.usedAt).toBeNull();
    // THE CREDENTIAL IS NOT AT REST. The stored value is the sha256 of the
    // token and is NOT the token itself -- see magicLinkTokens' doc comment
    // (db/schema.ts) for why this specific property is the whole reason that
    // column exists.
    expect(row.tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(row.tokenHash).not.toBe(token);
    // 32 bytes of randomBytes, base64url -- 43 characters, no padding.
    expect(token).toHaveLength(43);
  });

  it("normalizes the email it stores and echoes (trimmed, lowercased)", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "a0000000-0000-4000-8000-000000000002";

    const response = await requestLink(app, userId, "  MiXeD.Case@Example.COM  ");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ email: "mixed.case@example.com" });
    expect(sender.sent[0]!.to).toBe("mixed.case@example.com");
    const rows = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.requestingUserId, userId));
    expect(rows[0]!.email).toBe("mixed.case@example.com");
  });

  it("rejects an unusable email address without sending anything or writing a token", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "a0000000-0000-4000-8000-000000000003";

    for (const bad of ["not-an-email", "no@tld", "two@@at.example.com", "spaced out@x.com"]) {
      const response = await requestLink(app, userId, bad);
      expect(response.statusCode, bad).toBe(400);
    }

    expect(sender.sent).toHaveLength(0);
    const rows = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.requestingUserId, userId));
    expect(rows).toHaveLength(0);
  });

  it("answers 503, not 500, when the email provider fails", async () => {
    const app = buildSubject(failingSender("Resend rejected the message: 422 domain not verified"));
    const userId = "a0000000-0000-4000-8000-000000000004";

    const response = await requestLink(app, userId, "provider-down@example.com");

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("try again") });
    // The provider's own message must not be echoed to the caller -- it can
    // name internal configuration (the unverified sending domain, here).
    expect(JSON.stringify(response.json())).not.toContain("domain not verified");
  });

  /**
   * THE NON-NEGOTIABLE from BuildAppDeps.getScoreJob's doc comment, applied
   * to email: a machine that has never configured `RESEND_API_KEY` must still
   * boot and serve every other route. Built here with NO `getSendEmail`
   * override at all, so the real `makeResendSenderFromEnv` default is in play
   * -- if it were constructed eagerly (at `buildApp`, or at module load), this
   * test would throw before it could assert anything.
   */
  it("keeps every other route working with no email configuration at all, and fails only this one", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "");
    const app = buildApp({
      db,
      inferTitles: async () => [],
      getScoreJob: () => {
        throw new Error("not used by this test");
      },
      // Deliberately omitted: the production default must be lazy.
    });

    const unrelated = await app.inject({ method: "GET", url: "/sources" });
    expect(unrelated.statusCode).toBe(200);

    const response = await requestLink(
      app,
      "a0000000-0000-4000-8000-000000000005",
      "unconfigured@example.com",
    );
    expect(response.statusCode).toBe(503);
  });

  it("requires the x-user-id header like every other non-exempt route", async () => {
    const app = buildSubject(fakeSender().fn);

    const response = await app.inject({
      method: "POST",
      url: "/auth/magic-link",
      headers: { "x-user-id": "" }, // build-test-app.ts's omit-the-header escape hatch
      payload: { email: "needs-identity@example.com" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("x-user-id") });
  });
});

describe("POST /auth/magic-link/verify -- identity resolution", () => {
  // BRANCH 2 of the ticket: "claiming my anonymous session".
  it("attaches a brand-new email to the REQUESTING anonymous user, whose data is then visible immediately", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "b0000000-0000-4000-8000-000000000001";

    // Something worth protecting existed BEFORE the email did -- which is the
    // whole premise of "offer this only after scored results land".
    await giveUserAResume(userId, "Pre-claim Resume");

    await requestLink(app, userId, "brand-new@example.com");
    const token = tokenFromEmail(sender.sent[0]!);

    const verify = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as VerifyMagicLinkResponse;
    expect(body).toEqual({
      userId,
      email: "brand-new@example.com",
      outcome: "attached",
    });

    // The email landed on that same row -- one identity that gained an email,
    // not a second identity.
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows[0]!.email).toBe("brand-new@example.com");

    // AC: "After claiming, the user's existing resumes/results are visible
    // immediately -- no separate migration/merge step." Read through the real
    // per-user route, as the returned identity.
    const list = await injectAs(app, body.userId, { method: "GET", url: "/resumes" });
    expect(list.statusCode).toBe(200);
    expect((list.json() as ListResumesResponse).resumes.map((r) => r.resumeNickname)).toContain(
      "Pre-claim Resume",
    );
  });

  // BRANCH 1 of the ticket: "logging in from a second device".
  it("re-points the browser to the EXISTING user when that email already has an account, bringing its resumes with it", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const firstDevice = "b0000000-0000-4000-8000-000000000002";
    const secondDevice = "b0000000-0000-4000-8000-000000000003";

    // Device 1 claims the email, and owns a resume.
    await giveUserAResume(firstDevice, "Device One Resume");
    await requestLink(app, firstDevice, "two-devices@example.com");
    const firstVerify = await injectAs(app, firstDevice, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenFromEmail(sender.sent[0]!) },
    });
    expect((firstVerify.json() as VerifyMagicLinkResponse).outcome).toBe("attached");

    // Device 2 is a different browser with its own anonymous id and its own
    // (unrelated) resume, and asks for a link to the SAME address.
    await giveUserAResume(secondDevice, "Device Two Resume");
    await requestLink(app, secondDevice, "two-devices@example.com");
    const token = tokenFromEmail(sender.sent[1]!);

    const verify = await injectAs(app, secondDevice, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as VerifyMagicLinkResponse;
    expect(body.outcome).toBe("adopted");
    // The decisive assertion: the browser is handed a DIFFERENT id than the
    // one it sent -- device 1's -- so it becomes that user.
    expect(body.userId).toBe(firstDevice);
    expect(body.userId).not.toBe(secondDevice);

    // And device 1's data is what it now sees.
    const list = await injectAs(app, body.userId, { method: "GET", url: "/resumes" });
    const nicknames = (list.json() as ListResumesResponse).resumes.map((r) => r.resumeNickname);
    expect(nicknames).toContain("Device One Resume");
    expect(nicknames).not.toContain("Device Two Resume");

    // Device 2's own anonymous row is untouched, not merged or deleted --
    // nothing in this ticket migrates data, by design.
    const secondRows = await db.select().from(users).where(eq(users.id, secondDevice));
    expect(secondRows[0]!.email).toBeNull();
  });

  it("resolves from the TOKEN's requesting user, never from the verifying request's own x-user-id", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const requester = "b0000000-0000-4000-8000-000000000004";
    const unrelatedBrowser = "b0000000-0000-4000-8000-000000000005";

    await requestLink(app, requester, "token-owns-it@example.com");
    const token = tokenFromEmail(sender.sent[0]!);

    // The link is opened somewhere else entirely -- a third browser that has
    // nothing to do with either side. If resolution read the CALLER's header,
    // this would attach the email to `unrelatedBrowser` instead.
    const verify = await injectAs(app, unrelatedBrowser, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });

    expect(verify.statusCode).toBe(200);
    expect((verify.json() as VerifyMagicLinkResponse).userId).toBe(requester);
    const unrelatedRows = await db.select().from(users).where(eq(users.id, unrelatedBrowser));
    expect(unrelatedRows[0]!.email).toBeNull();
  });

  it("two separate tokens for the same new email converge on ONE account (attach, then adopt)", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const browserA = "b0000000-0000-4000-8000-000000000006";
    const browserB = "b0000000-0000-4000-8000-000000000007";

    await requestLink(app, browserA, "converge@example.com");
    await requestLink(app, browserB, "converge@example.com");
    const tokenA = tokenFromEmail(sender.sent[0]!);
    const tokenB = tokenFromEmail(sender.sent[1]!);

    const first = await injectAs(app, browserA, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenA },
    });
    const second = await injectAs(app, browserB, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenB },
    });

    expect((first.json() as VerifyMagicLinkResponse).outcome).toBe("attached");
    expect((second.json() as VerifyMagicLinkResponse).outcome).toBe("adopted");
    expect((second.json() as VerifyMagicLinkResponse).userId).toBe(browserA);
  });

  /**
   * The third case the ticket did not enumerate -- see routes/auth.ts's own
   * long comment in `resolveIdentity`. The important half of this test is the
   * last assertion: the refused token is NOT consumed, because the refusal
   * rolls the whole transaction back. A refusal that burned the token would
   * leave the user with no recovery at all.
   */
  it("refuses to relabel a browser that already carries a DIFFERENT email, and does not consume the token", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "b0000000-0000-4000-8000-000000000008";

    await requestLink(app, userId, "first-address@example.com");
    await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenFromEmail(sender.sent[0]!) },
    });

    await requestLink(app, userId, "second-address@example.com");
    const secondToken = tokenFromEmail(sender.sent[1]!);
    const verify = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: secondToken },
    });

    expect(verify.statusCode).toBe(400);
    expect(verify.json()).toMatchObject({ reason: "browser_already_claimed" });

    // The first email still owns the account -- nothing was relabelled.
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows[0]!.email).toBe("first-address@example.com");

    // And the refused token is still unredeemed, so the same link can be
    // opened somewhere that ISN'T already claimed.
    const tokenRows = await db
      .select({ usedAt: magicLinkTokens.usedAt })
      .from(magicLinkTokens)
      .where(
        eq(
          magicLinkTokens.tokenHash,
          createHash("sha256").update(secondToken, "utf8").digest("hex"),
        ),
      );
    expect(tokenRows[0]!.usedAt).toBeNull();
  });

  it("re-verifying the email this browser already has is a harmless no-op, not a refusal", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "b0000000-0000-4000-8000-000000000009";

    await requestLink(app, userId, "same-again@example.com");
    await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenFromEmail(sender.sent[0]!) },
    });

    await requestLink(app, userId, "same-again@example.com");
    const verify = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: tokenFromEmail(sender.sent[1]!) },
    });

    expect(verify.statusCode).toBe(200);
    const body = verify.json() as VerifyMagicLinkResponse;
    expect(body.userId).toBe(userId);
    expect(body.outcome).toBe("adopted");
  });
});

describe("POST /auth/magic-link/verify -- expiry and single use", () => {
  it("rejects an EXPIRED token with a specific reason, and grants nothing", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "c0000000-0000-4000-8000-000000000001";

    await requestLink(app, userId, "expired@example.com");
    const token = tokenFromEmail(sender.sent[0]!);

    // Rewind `expires_at` past now rather than waiting fifteen real minutes.
    // The route compares the stored column against the clock, so moving the
    // column is exactly equivalent to moving the clock -- and is the same
    // thing a link found in an old inbox tomorrow actually looks like.
    await db
      .update(magicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        eq(magicLinkTokens.tokenHash, createHash("sha256").update(token, "utf8").digest("hex")),
      );

    const verify = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });

    expect(verify.statusCode).toBe(400);
    expect(verify.json()).toMatchObject({
      reason: "expired",
      error: expect.stringContaining("expired"),
    });
    // No identity was granted: the email never attached.
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows[0]!.email).toBeNull();
  });

  it("rejects a REUSED token with a specific reason, having granted the identity exactly once", async () => {
    const sender = fakeSender();
    const app = buildSubject(sender.fn);
    const userId = "c0000000-0000-4000-8000-000000000002";

    await requestLink(app, userId, "replay@example.com");
    const token = tokenFromEmail(sender.sent[0]!);

    const first = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });
    expect(first.statusCode).toBe(200);

    const replay = await injectAs(app, userId, {
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token },
    });

    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({
      reason: "already_used",
      error: expect.stringContaining("already been used"),
    });
    // `used_at` is set once and stays put.
    const rows = await db
      .select({ usedAt: magicLinkTokens.usedAt })
      .from(magicLinkTokens)
      .where(
        eq(magicLinkTokens.tokenHash, createHash("sha256").update(token, "utf8").digest("hex")),
      );
    expect(rows[0]!.usedAt).not.toBeNull();
  });

  it("rejects an unknown token without confirming whether it ever existed", async () => {
    const app = buildSubject(fakeSender().fn);

    const verify = await app.inject({
      method: "POST",
      url: "/auth/magic-link/verify",
      payload: { token: "Zm9yZ2VkLXRva2VuLXRoYXQtbmV2ZXItZXhpc3RlZA" },
    });

    expect(verify.statusCode).toBe(400);
    expect(verify.json()).toMatchObject({ reason: "invalid" });
    // Deliberately says nothing about existence, expiry, or use.
    const error = (verify.json() as { error: string }).error;
    expect(error).not.toMatch(/expired|already been used|does not exist/i);
  });

  /**
   * THE RACE THE SINGLE-USE DESIGN EXISTS FOR: two simultaneous redemptions
   * of the SAME token (a double-tap on the emailed link, a client that fires
   * twice, a forwarded mail opened by two people at once). Exactly one must
   * win.
   *
   * Run on a real connection POOL, because the default single-client test
   * handle cannot host two genuinely concurrent transactions at all (see
   * `createPooledTestDatabase`'s own doc comment) -- on one session they
   * interleave, and this test would pass whether or not the claim is atomic.
   *
   * AND FORCED TO OVERLAP WITH A ROW LOCK, which is the part that gives this
   * test teeth. A plain `Promise.all` of two injects is NOT enough: measured
   * here (2026-09-27), two in-process requests often complete one before the
   * other even reaches its write, so a deliberately-broken SELECT-then-UPDATE
   * implementation PASSED the whole file while failing the same test when run
   * alone -- a false assurance worse than no test. So a third transaction
   * takes `SELECT ... FOR UPDATE` on the token row first, both requests are
   * launched and given time to queue up behind it, and only then is the lock
   * released. Both requests are therefore provably at their write step
   * simultaneously, in both directions:
   *
   *  - Correct (one conditional UPDATE): both block on the UPDATE, Postgres
   *    serializes them, the second re-evaluates `used_at IS NULL` against the
   *    now-committed row and matches nothing -> 400.
   *  - Broken (SELECT, then UPDATE): a plain SELECT does not conflict with
   *    `FOR UPDATE`, so both read `used_at IS NULL` BEFORE blocking, and both
   *    go on to return 200 -> this test fails.
   *
   * Confirmed against that exact mutation before being committed.
   */
  it("lets EXACTLY ONE of two simultaneous redemptions of the same token win", async () => {
    const pooled = createPooledTestDatabase(testDb.testDbName);
    const blockerHandle = createPooledTestDatabase(testDb.testDbName, 1);
    try {
      const sender = fakeSender();
      const app = buildSubject(sender.fn, pooled.db);
      const userId = "c0000000-0000-4000-8000-000000000003";

      await requestLink(app, userId, "double-click@example.com");
      const token = tokenFromEmail(sender.sent[0]!);
      const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");

      let signalLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      let releaseLock!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      const blocker = blockerHandle.db.transaction(async (tx) => {
        await tx
          .select({ id: magicLinkTokens.id })
          .from(magicLinkTokens)
          .where(eq(magicLinkTokens.tokenHash, tokenHash))
          .for("update");
        signalLocked();
        await released;
      });
      await locked;

      const pending = Promise.all([
        injectAs(app, userId, {
          method: "POST",
          url: "/auth/magic-link/verify",
          payload: { token },
        }),
        injectAs(app, userId, {
          method: "POST",
          url: "/auth/magic-link/verify",
          payload: { token },
        }),
      ]);

      // Both requests are now queued behind the row lock. 250ms is far more
      // than two in-process requests need to reach a write they cannot
      // complete; it only has to be generous, never exact, because the lock
      // -- not this delay -- is what guarantees the overlap.
      await new Promise((resolve) => setTimeout(resolve, 250));
      releaseLock();
      await blocker;

      const [a, b] = await pending;
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 400]);
      const loser = a.statusCode === 400 ? a : b;
      expect(loser.json()).toMatchObject({ reason: "already_used" });

      const winner = a.statusCode === 200 ? a : b;
      expect((winner.json() as VerifyMagicLinkResponse).userId).toBe(userId);
    } finally {
      await pooled.close();
      await blockerHandle.close();
    }
  });
});
