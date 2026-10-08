/**
 * Ticket 9f06f8f: the Resend integration's own shape, checked against a
 * stubbed `fetch` rather than the network.
 *
 * WHY THIS FILE EXISTS AT ALL, given routes/auth.test.ts already covers the
 * magic-link flow with a FAKE sender: the fake proves the route calls a
 * sender correctly, and proves nothing whatsoever about whether the real
 * sender talks to Resend correctly. Everything between "the route is right"
 * and "an email actually arrives" -- the endpoint, the auth header, the
 * payload field names, error handling -- lives only here, and a wrong field
 * name in this file would be invisible in every other test while making the
 * feature 100% non-functional in production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeEmailSenderFromEnv,
  makeResendSender,
  makeResendSenderFromEnv,
  makeSendgridSender,
  makeSendgridSenderFromEnv,
} from "./sender.js";

const message = {
  to: "recipient@example.com",
  subject: "Your sign-in link",
  text: "plain text body",
  html: "<p>html body</p>",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("makeResendSender", () => {
  it("POSTs the documented Resend request: endpoint, bearer auth, and payload field names", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await makeResendSender("re_test_key", "FitScore <login@example.com>")(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    // Resend's field names, not ours -- `to` is an ARRAY even for one
    // recipient, which is the single easiest thing to get wrong here.
    expect(JSON.parse(init.body as string)).toEqual({
      from: "FitScore <login@example.com>",
      to: ["recipient@example.com"],
      subject: "Your sign-in link",
      text: "plain text body",
      html: "<p>html body</p>",
    });
    // A timeout is armed, so a hanging provider surfaces as a failure rather
    // than a request that never answers.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws, carrying the provider's own message, when Resend rejects the send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              statusCode: 403,
              name: "validation_error",
              message: "Domain is not verified.",
            }),
            { status: 403 },
          ),
      ),
    );

    await expect(makeResendSender("re_test_key", "login@example.com")(message)).rejects.toThrow(
      /403 Domain is not verified\./,
    );
  });

  it("throws a usable error when the provider answers a non-JSON body (an edge/proxy error page)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    await expect(makeResendSender("re_test_key", "login@example.com")(message)).rejects.toThrow(
      /Resend rejected the message: 502/,
    );
  });

  it("wraps a network-level failure instead of leaking a bare TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(makeResendSender("re_test_key", "login@example.com")(message)).rejects.toThrow(
      /Resend request failed: fetch failed/,
    );
  });

  it("never puts the API key in the error it throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await expect(
      makeResendSender("re_super_secret_key", "login@example.com")(message),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("re_super_secret_key") }),
    );
  });
});

describe("makeResendSenderFromEnv", () => {
  it("names EVERY missing variable, so configuring email is one round trip not two", () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "");

    expect(() => makeResendSenderFromEnv()).toThrow(
      /RESEND_API_KEY, MAGIC_LINK_FROM_EMAIL must be set/,
    );
  });

  it("treats an empty value the same as an unset one", () => {
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "");

    expect(() => makeResendSenderFromEnv()).toThrow(/MAGIC_LINK_FROM_EMAIL/);
  });

  it("builds a sender once both are set", () => {
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "login@example.com");

    expect(typeof makeResendSenderFromEnv()).toBe("function");
  });
});

/**
 * Ticket 184b9ae: the SendGrid integration's own shape, checked the same way
 * as `makeResendSender` above -- against a stubbed `fetch`, never the
 * network. SendGrid is the provider Nicole can actually use today (Resend
 * needs a verified DNS domain; SendGrid's Single Sender Verification does
 * not), so a wrong field name or a 200-only success check here is the
 * difference between "magic links work" and "a dead feature that looks done".
 */
describe("makeSendgridSender", () => {
  it("POSTs the documented SendGrid request: endpoint, bearer auth, and payload shape, with a parsed `from`", async () => {
    const fetchMock = vi.fn(
      async () => new Response(null, { status: 202, statusText: "Accepted" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await makeSendgridSender("sg_test_key", "FitScore <nicole@griesmeyer.org>")(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sg_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    // SendGrid's field names, not Resend's -- `personalizations`/`to` is an
    // array of recipient objects, `from` is split into email+name, and the
    // body carries BOTH content parts (EmailMessage requires text for the
    // same anti-spam reason, see its own comment).
    expect(JSON.parse(init.body as string)).toEqual({
      personalizations: [{ to: [{ email: "recipient@example.com" }] }],
      from: { email: "nicole@griesmeyer.org", name: "FitScore" },
      subject: "Your sign-in link",
      content: [
        { type: "text/plain", value: "plain text body" },
        { type: "text/html", value: "<p>html body</p>" },
      ],
    });
    // A timeout is armed, so a hanging provider surfaces as a failure rather
    // than a request that never answers.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("parses a bare address with no angle brackets as the email with no name", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeSendgridSender("sg_test_key", "nicole@griesmeyer.org")(message);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { from: unknown };
    expect(body.from).toEqual({ email: "nicole@griesmeyer.org" });
  });

  it("treats a 202 Accepted as success, not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 202, statusText: "Accepted" })),
    );

    await expect(
      makeSendgridSender("sg_test_key", "nicole@griesmeyer.org")(message),
    ).resolves.toBeUndefined();
  });

  it("throws, carrying the provider's own message, when SendGrid rejects the send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errors: [{ message: "The from address does not match a verified Sender Identity." }],
            }),
            { status: 403 },
          ),
      ),
    );

    await expect(
      makeSendgridSender("sg_test_key", "nicole@griesmeyer.org")(message),
    ).rejects.toThrow(/403 The from address does not match a verified Sender Identity\./);
  });

  it("throws a usable error when the provider answers a non-JSON body (an edge/proxy error page)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );

    await expect(
      makeSendgridSender("sg_test_key", "nicole@griesmeyer.org")(message),
    ).rejects.toThrow(/SendGrid rejected the message: 502/);
  });

  it("wraps a network-level failure instead of leaking a bare TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(
      makeSendgridSender("sg_test_key", "nicole@griesmeyer.org")(message),
    ).rejects.toThrow(/SendGrid request failed: fetch failed/);
  });

  it("never puts the API key in the error it throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await expect(
      makeSendgridSender("sg_super_secret_key", "nicole@griesmeyer.org")(message),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("sg_super_secret_key") }),
    );
  });
});

describe("makeSendgridSenderFromEnv", () => {
  it("names EVERY missing variable, so configuring email is one round trip not two", () => {
    vi.stubEnv("SENDGRID_API_KEY", "");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "");

    expect(() => makeSendgridSenderFromEnv()).toThrow(
      /SENDGRID_API_KEY, MAGIC_LINK_FROM_EMAIL must be set/,
    );
  });

  it("treats an empty value the same as an unset one", () => {
    vi.stubEnv("SENDGRID_API_KEY", "sg_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "");

    expect(() => makeSendgridSenderFromEnv()).toThrow(/MAGIC_LINK_FROM_EMAIL/);
  });

  it("builds a sender once both are set", () => {
    vi.stubEnv("SENDGRID_API_KEY", "sg_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "nicole@griesmeyer.org");

    expect(typeof makeSendgridSenderFromEnv()).toBe("function");
  });
});

/**
 * Ticket 184b9ae's three provider-selection rules. Each is load-bearing on
 * its own -- get the both-keys-set precedence backwards and Nicole's
 * existing (non-functional, unverified-domain) RESEND_API_KEY would silently
 * keep winning over the SendGrid key she actually needs used.
 */
describe("makeEmailSenderFromEnv", () => {
  it("picks SendGrid when only SENDGRID_API_KEY is set", () => {
    vi.stubEnv("SENDGRID_API_KEY", "sg_real_key");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "nicole@griesmeyer.org");

    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    return makeEmailSenderFromEnv()(message).then(() => {
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    });
  });

  it("falls back to Resend when only RESEND_API_KEY is set", () => {
    vi.stubEnv("SENDGRID_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "nicole@griesmeyer.org");

    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    return makeEmailSenderFromEnv()(message).then(() => {
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.resend.com/emails");
    });
  });

  it("picks SendGrid over Resend when BOTH keys are set", () => {
    vi.stubEnv("SENDGRID_API_KEY", "sg_real_key");
    vi.stubEnv("RESEND_API_KEY", "re_real_key");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "nicole@griesmeyer.org");

    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    return makeEmailSenderFromEnv()(message).then(() => {
      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    });
  });

  it("throws naming both keys when neither is set", () => {
    vi.stubEnv("SENDGRID_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAGIC_LINK_FROM_EMAIL", "nicole@griesmeyer.org");

    expect(() => makeEmailSenderFromEnv()).toThrow(/SENDGRID_API_KEY.*RESEND_API_KEY/);
  });
});
