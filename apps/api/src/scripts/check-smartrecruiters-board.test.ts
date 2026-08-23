import { describe, expect, it, vi } from "vitest";
import { checkCompany, type BoardCheckResult } from "./check-smartrecruiters-board.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const CAREERS_BASE_URL = "https://careers.example.test";
const POSTINGS_BASE = "https://api.smartrecruiters.com/v1/companies";

describe("checkCompany (ticket d8417b2)", () => {
  it("reports 'ok' with real postings directly — no careers-site check needed when totalFound > 0", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/postings")) {
        return Promise.resolve(
          jsonResponse({
            totalFound: 2,
            content: [
              { name: "Senior Software Engineer", location: { fullLocation: "Seattle, WA, US" } },
              { name: "Sales Manager", location: { fullLocation: "Seattle, WA, US" } },
            ],
          }),
        );
      }
      throw new Error(`unexpected careers-site request in a totalFound>0 case: ${u}`);
    });

    const result = await checkCompany("RealCo", fetchImpl, CAREERS_BASE_URL);

    expect(result).toEqual({
      company: "RealCo",
      status: "ok",
      postingCount: 2,
      // "Sales Manager" fails both SOFTWARE and NOT.
      survivingCount: 1,
    });
    // Confirms the careers-site check is skipped when postings already
    // prove the identifier real (Finding 1's own "only ambiguous when
    // empty" rule).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports 'ok' with 0 postings when totalFound is 0 but the careers-site check confirms a real, valid company", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/postings")) {
        return Promise.resolve(jsonResponse({ totalFound: 0, content: [] }));
      }
      if (u.startsWith(CAREERS_BASE_URL)) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      throw new Error(`unexpected request: ${u}`);
    });

    const result = await checkCompany("QuietRealCo", fetchImpl, CAREERS_BASE_URL);

    expect(result).toEqual({
      company: "QuietRealCo",
      status: "ok",
      postingCount: 0,
      survivingCount: 0,
    });
  });

  it("reports 'invalid' when totalFound is 0 and the careers-site check redirects to the generic homepage", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/postings")) {
        return Promise.resolve(jsonResponse({ totalFound: 0, content: [] }));
      }
      if (u.startsWith(CAREERS_BASE_URL)) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: "https://jobs.smartrecruiters.com" },
          }),
        );
      }
      throw new Error(`unexpected request: ${u}`);
    });

    const result = await checkCompany("TotallyBogusXYZ123", fetchImpl, CAREERS_BASE_URL);

    expect(result.status).toBe("invalid");
  });

  it("reports 'unknown' (not 'ok') when the careers-site check itself can't complete — never silently trusted as valid", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = url.toString();
      if (u.includes("/postings")) {
        return Promise.resolve(jsonResponse({ totalFound: 0, content: [] }));
      }
      if (u.startsWith(CAREERS_BASE_URL)) {
        return Promise.reject(new Error("ECONNRESET"));
      }
      throw new Error(`unexpected request: ${u}`);
    });

    const result = await checkCompany("Ambiguous", fetchImpl, CAREERS_BASE_URL);

    expect(result.status).toBe("unknown");
  });

  it("paginates through every summary page and computes survivingCount over the full set, not just the first page", async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => ({
      name: i === 0 ? "Software Engineer" : "Sales Rep",
      location: { fullLocation: "Seattle, WA, US" },
    }));
    const page1 = [{ name: "Backend Engineer", location: { fullLocation: "Bellevue, WA, US" } }];

    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = new URL(url.toString());
      const offset = Number(u.searchParams.get("offset"));
      if (offset === 0) {
        return Promise.resolve(jsonResponse({ totalFound: 101, content: page0 }));
      }
      if (offset === 100) {
        return Promise.resolve(jsonResponse({ totalFound: 101, content: page1 }));
      }
      throw new Error(`unexpected offset ${offset}`);
    });

    const result = await checkCompany("BigCo", fetchImpl, CAREERS_BASE_URL);

    expect(result).toMatchObject({ status: "ok", postingCount: 101, survivingCount: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports 'error' when the first postings-page request itself fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const result = await checkCompany("Unreachable", fetchImpl, CAREERS_BASE_URL);

    expect(result).toEqual({ company: "Unreachable", status: "error", message: "ECONNRESET" });
  });

  it("reports 'ok' with the postings collected so far when a LATER page fails, instead of discarding them", async () => {
    const page0 = Array.from({ length: 100 }, () => ({
      name: "Software Engineer",
      location: { fullLocation: "Seattle, WA, US" },
    }));

    const fetchImpl = vi.fn().mockImplementation((url: string | URL) => {
      const u = new URL(url.toString());
      const offset = Number(u.searchParams.get("offset"));
      if (offset === 0) {
        return Promise.resolve(jsonResponse({ totalFound: 250, content: page0 }));
      }
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    });

    const result = await checkCompany("PartiallyBrokenCo", fetchImpl, CAREERS_BASE_URL);

    // filterSoftwareEngineeringJobs dedupes by (company, title) — all 100
    // share the identical placeholder company + identical title, so only 1
    // survives dedup. The real point of this test is postingCount: 100 (the
    // page that succeeded was kept, not discarded because a later page
    // failed).
    expect(result).toMatchObject({ status: "ok", postingCount: 100, survivingCount: 1 });
  });

  it("uses the real POSTINGS_BASE host by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ totalFound: 0, content: [] }));
    // Force the careers-site check down the "unknown" path so this test
    // doesn't depend on real network access — the point here is only to
    // confirm the postings request itself hits the real API host.
    vi.spyOn(global, "fetch").mockImplementation(() => {
      throw new Error("careers-site fetch should not use the global fetch in this test");
    });

    await checkCompany("AnyCo", fetchImpl, CAREERS_BASE_URL).catch(() => {});

    const calledUrl = (fetchImpl.mock.calls[0]?.[0] as URL | string | undefined)?.toString();
    expect(calledUrl).toContain(POSTINGS_BASE);

    vi.restoreAllMocks();
  });

  it("BoardCheckResult type covers all four outcomes distinctly (compile-time smoke check)", () => {
    const results: BoardCheckResult[] = [
      { company: "a", status: "invalid", reason: "x" },
      { company: "a", status: "unknown", reason: "x" },
      { company: "a", status: "error", message: "x" },
      { company: "a", status: "ok", postingCount: 0, survivingCount: 0 },
    ];
    expect(new Set(results.map((r) => r.status)).size).toBe(4);
  });
});
