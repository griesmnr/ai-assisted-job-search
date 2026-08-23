import { describe, expect, it, vi } from "vitest";
import { checkBoard, TIMEOUT_MS, type BoardCheckResult } from "./check-lever-board.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("checkBoard (ticket d8417b2)", () => {
  it("reports 'not-found' on a 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Document not found", { status: 404 }));

    const result = await checkBoard("does-not-exist", fetchImpl);

    expect(result).toEqual({ slug: "does-not-exist", status: "not-found" });
  });

  it("reports 'ok' with postingCount 0 and survivingCount 0 for a real board with zero postings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));

    const result = await checkBoard("quiet-board", fetchImpl);

    expect(result).toEqual({
      slug: "quiet-board",
      status: "ok",
      postingCount: 0,
      survivingCount: 0,
    });
  });

  it("computes survivingCount via the real filter, using the union of location and allLocations", async () => {
    const postings = [
      // Survives: title matches, and the ONLY matching location lives in
      // allLocations, not the single `location` field — proves the union
      // (not just `location` alone) is what's checked.
      {
        text: "Senior Software Engineer",
        categories: {
          location: "Remote (Canada)",
          allLocations: ["Remote (Canada)", "Seattle, WA"],
        },
      },
      // Does not survive: right title, but neither location nor
      // allLocations mentions WA/Seattle/remote-US.
      {
        text: "Backend Engineer",
        categories: { location: "Remote (Poland)", allLocations: ["Remote (Poland)"] },
      },
      // Does not survive: title fails NOT (recruit).
      {
        text: "Technical Recruiter",
        categories: { location: "Seattle, WA" },
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(postings));

    const result = await checkBoard("acme", fetchImpl);

    expect(result).toEqual({ slug: "acme", status: "ok", postingCount: 3, survivingCount: 1 });
  });

  it("reports 'error' for a non-2xx, non-404 status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const result = await checkBoard("flaky", fetchImpl);

    expect(result).toEqual({ slug: "flaky", status: "error", message: "HTTP 503" });
  });

  it("reports 'error' for a response that isn't valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json{{{", { status: 200 }));

    const result = await checkBoard("garbled", fetchImpl);

    expect(result.status).toBe("error");
    expect((result as Extract<BoardCheckResult, { status: "error" }>).message).toMatch(
      /not valid JSON/,
    );
  });

  it("reports 'error' for well-formed JSON that isn't an array (Lever's bare-array shape violated)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ notWhatWeExpected: true }));

    const result = await checkBoard("wrong-shape", fetchImpl);

    expect(result).toEqual({
      slug: "wrong-shape",
      status: "error",
      message: "response was not a JSON array",
    });
  });

  it("reports 'error' when fetch itself rejects (network failure)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await checkBoard("unreachable", fetchImpl);

    expect(result).toEqual({ slug: "unreachable", status: "error", message: "ECONNRESET" });
  });

  it("reports 'error' (not a hang) when the request exceeds TIMEOUT_MS — the abort signal is honored", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });

      const resultPromise = checkBoard("slow-board", fetchImpl as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.status).toBe("error");
      expect((result as Extract<BoardCheckResult, { status: "error" }>).message).toMatch(
        /aborted/i,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
