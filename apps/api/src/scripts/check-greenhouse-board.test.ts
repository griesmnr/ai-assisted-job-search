import { describe, expect, it, vi } from "vitest";
import { checkBoard, TIMEOUT_MS, type BoardCheckResult } from "./check-greenhouse-board.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("checkBoard (ticket b723fb9 review fix #4)", () => {
  it("reports 'not-found' on a 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }));

    const result = await checkBoard("does-not-exist", fetchImpl);

    expect(result).toEqual({ token: "does-not-exist", status: "not-found" });
  });

  it("reports 'ok' with postingCount 0 and survivingCount 0 for a real board with zero postings (not confused with 'not-found')", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jobs: [] }));

    const result = await checkBoard("quiet-board", fetchImpl);

    expect(result).toEqual({
      token: "quiet-board",
      status: "ok",
      postingCount: 0,
      survivingCount: 0,
      companyName: undefined,
    });
  });

  it("reports 'ok' with postingCount and survivingCount computed via the real filterSoftwareEngineeringJobs filter — not every posting survives", async () => {
    const jobs = [
      // Survives: title matches, location matches.
      {
        title: "Senior Software Engineer",
        company_name: "Acme",
        location: { name: "Seattle, WA" },
      },
      // Does not survive: title matches SOFTWARE ("front-end") but also
      // matches NOT ("sales").
      {
        title: "Front-End Engineer, Sales Engineering",
        company_name: "Acme",
        location: { name: "Seattle, WA" },
      },
      // Does not survive: right title, wrong location (Remote - Canada).
      { title: "Backend Engineer", company_name: "Acme", location: { name: "Remote - Canada" } },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ jobs }));

    const result = await checkBoard("acme", fetchImpl);

    expect(result).toEqual({
      token: "acme",
      status: "ok",
      postingCount: 3,
      survivingCount: 1,
      companyName: "Acme",
    });
  });

  it("reports 'error' for a non-2xx status other than 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const result = await checkBoard("flaky", fetchImpl);

    expect(result).toEqual({ token: "flaky", status: "error", message: "HTTP 503" });
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
      token: "wrong-shape",
      status: "error",
      message: "response did not have a jobs array",
    });
  });

  it("reports 'error' when fetch itself rejects (network failure)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await checkBoard("unreachable", fetchImpl);

    expect(result).toEqual({ token: "unreachable", status: "error", message: "ECONNRESET" });
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
