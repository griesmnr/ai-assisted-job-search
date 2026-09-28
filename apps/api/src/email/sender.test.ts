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
import { makeResendSender, makeResendSenderFromEnv } from "./sender.js";

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

    await makeResendSender("re_test_key", "AI Job Search <login@example.com>")(message);

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
      from: "AI Job Search <login@example.com>",
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
