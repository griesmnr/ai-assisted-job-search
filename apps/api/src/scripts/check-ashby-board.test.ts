import { describe, expect, it, vi } from "vitest";
import { checkBoard, TIMEOUT_MS, type BoardCheckResult } from "./check-ashby-board.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("checkBoard (ticket d8417b2)", () => {
  it("reports 'not-found' on a 404 (Ashby's plain-text 404 body)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

    const result = await checkBoard("does-not-exist", fetchImpl);

    expect(result).toEqual({ boardName: "does-not-exist", status: "not-found" });
  });

  it("reports 'ok' with postingCount 0 for a real board with zero postings — distinct from 'not-found'", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jobs: [], apiVersion: "1" }));

    const result = await checkBoard("quiet-board", fetchImpl);

    expect(result).toEqual({
      boardName: "quiet-board",
      status: "ok",
      postingCount: 0,
      survivingCount: 0,
    });
  });

  it("computes survivingCount via the real filter, using the union of location and secondaryLocations[].location", async () => {
    const jobs = [
      // Survives: title matches, and the ONLY matching location lives in
      // secondaryLocations, not the primary `location` field.
      {
        title: "Senior Software Engineer",
        location: "New York, NY (HQ)",
        secondaryLocations: [{ location: "Remote (Canada)" }, { location: "Seattle, WA" }],
      },
      // Does not survive: right title, no WA/Seattle/remote-US anywhere.
      {
        title: "Backend Engineer",
        location: "London, UK",
        secondaryLocations: [{ location: "Remote (UK)" }],
      },
      // Does not survive: title fails NOT (manager).
      { title: "Engineering Manager", location: "Seattle, WA" },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jobs, apiVersion: "1" }));

    const result = await checkBoard("acme", fetchImpl);

    expect(result).toEqual({ boardName: "acme", status: "ok", postingCount: 3, survivingCount: 1 });
  });

  it("reports 'error' for a non-2xx, non-404 status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const result = await checkBoard("flaky", fetchImpl);

    expect(result).toEqual({ boardName: "flaky", status: "error", message: "HTTP 503" });
  });

  it("reports 'error' for a response that isn't valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json{{{", { status: 200 }));

    const result = await checkBoard("garbled", fetchImpl);

    expect(result.status).toBe("error");
    expect((result as Extract<BoardCheckResult, { status: "error" }>).message).toMatch(
      /not valid JSON/,
    );
  });

  it("reports 'error' for well-formed JSON missing a 'jobs' array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ notWhatWeExpected: true }));

    const result = await checkBoard("wrong-shape", fetchImpl);

    expect(result).toEqual({
      boardName: "wrong-shape",
      status: "error",
      message: "response did not have a jobs array",
    });
  });

  it("reports 'error' when fetch itself rejects (network failure)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await checkBoard("unreachable", fetchImpl);

    expect(result).toEqual({ boardName: "unreachable", status: "error", message: "ECONNRESET" });
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
