import { describe, expect, it } from "vitest";
import {
  AuthFailedError,
  RateLimitedError,
  TransientSourceError,
  UnexpectedStatusError,
  type JobSource,
  type NormalizedJob,
  type SourceSearchResult,
} from "./types.js";
import { CompositeSource, type PerSourceOutcome } from "./composite.js";

function job(dataSource: NormalizedJob["dataSource"], externalId: string): NormalizedJob {
  return {
    externalId,
    dataSource,
    title: "Software Engineer",
    description: "desc",
    company: "Acme",
    payType: undefined,
    commitment: undefined,
    locationType: undefined,
    location: "Remote - US",
    linkToApply: `https://example.com/${dataSource}/${externalId}`,
    postedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

class FakeSource implements JobSource {
  constructor(
    readonly dataSource: NormalizedJob["dataSource"],
    private readonly result: SourceSearchResult,
  ) {}
  async search(): Promise<SourceSearchResult> {
    return this.result;
  }
}

class ThrowingSource implements JobSource {
  constructor(
    readonly dataSource: NormalizedJob["dataSource"],
    private readonly error: unknown,
  ) {}
  async search(): Promise<SourceSearchResult> {
    throw this.error;
  }
}

describe("CompositeSource (ticket d8417b2)", () => {
  it("throws synchronously when constructed with zero sources", () => {
    expect(() => new CompositeSource([])).toThrow(/at least one/);
  });

  it("returns one 'ok' PerSourceOutcome per healthy source, each carrying that source's own untouched SourceSearchResult", async () => {
    const greenhouse = new FakeSource("greenhouse", {
      jobs: [job("greenhouse", "gh-1")],
      skipped: [],
      skipRate: 0,
    });
    const lever = new FakeSource("lever", {
      jobs: [job("lever", "lv-1"), job("lever", "lv-2")],
      skipped: [{ externalId: "lv-3", reason: "missing id" }],
      skipRate: 1 / 3,
    });

    const composite = new CompositeSource([greenhouse, lever]);
    const outcomes = await composite.search({});

    expect(outcomes).toEqual([
      {
        dataSource: "greenhouse",
        status: "ok",
        result: { jobs: [job("greenhouse", "gh-1")], skipped: [], skipRate: 0 },
      },
      {
        dataSource: "lever",
        status: "ok",
        result: {
          jobs: [job("lever", "lv-1"), job("lever", "lv-2")],
          skipped: [{ externalId: "lv-3", reason: "missing id" }],
          skipRate: 1 / 3,
        },
      },
    ]);
  });

  // "One source failing (404, rate limit, timeout, outage) must not
  // prevent the other three returning jobs" — acceptance criterion,
  // exercised as one failure mode per test, matching the four named in the
  // ticket. Every adapter isolates a per-token 404/429/timeout internally
  // (see greenhouse.ts/lever.ts/ashby.ts) and only lets search() itself
  // reject for a whole-source-level failure — these tests simulate exactly
  // that boundary: search() rejecting, not a per-token event inside it.
  const failureModes: Array<{ label: string; error: unknown }> = [
    {
      label: "a whole-source-level 404 (e.g. UnexpectedStatusError bubbling out of search())",
      error: new UnexpectedStatusError("board does not exist", 404),
    },
    {
      label: "a rate limit that aborted the whole search()",
      error: new RateLimitedError("rate limit exceeded", 30_000),
    },
    {
      label: "a request timeout",
      error: new TransientSourceError("request timed out after 15000ms"),
    },
    {
      label: "a total outage (plain network error, not a SourceError subclass)",
      error: new Error("getaddrinfo ENOTFOUND api.example.com"),
    },
  ];

  for (const { label, error } of failureModes) {
    it(`isolates ${label}: the other three sources still return their jobs`, async () => {
      const healthy1 = new FakeSource("greenhouse", {
        jobs: [job("greenhouse", "gh-1")],
        skipped: [],
        skipRate: 0,
      });
      const healthy2 = new FakeSource("ashby", {
        jobs: [job("ashby", "as-1")],
        skipped: [],
        skipRate: 0,
      });
      const healthy3 = new FakeSource("smartrecruiters", {
        jobs: [job("smartrecruiters", "sr-1")],
        skipped: [],
        skipRate: 0,
      });
      const broken = new ThrowingSource("lever", error);

      const composite = new CompositeSource([healthy1, broken, healthy2, healthy3]);
      const outcomes = await composite.search({});

      expect(outcomes).toHaveLength(4);
      const byDataSource = new Map(outcomes.map((o) => [o.dataSource, o]));

      // The broken source is isolated, not silently dropped: it still has
      // an entry, distinctly marked "error" with the real message.
      const leverOutcome = byDataSource.get("lever")!;
      expect(leverOutcome.status).toBe("error");
      expect((leverOutcome as Extract<PerSourceOutcome, { status: "error" }>).errorMessage).toBe(
        error instanceof Error ? error.message : String(error),
      );

      // The other three are completely unaffected — their real jobs are
      // still present, not discarded because one source failed.
      for (const dataSource of ["greenhouse", "ashby", "smartrecruiters"] as const) {
        const outcome = byDataSource.get(dataSource)!;
        expect(outcome.status).toBe("ok");
        expect((outcome as Extract<PerSourceOutcome, { status: "ok" }>).result.jobs).toHaveLength(
          1,
        );
      }
    });
  }

  it("classifies a rejection with a non-Error reason using String(), without throwing", async () => {
    const broken = new ThrowingSource("lever", "a plain string rejection");
    const composite = new CompositeSource([broken]);

    const outcomes = await composite.search({});

    expect(outcomes).toEqual([
      { dataSource: "lever", status: "error", errorMessage: "a plain string rejection" },
    ]);
  });

  it("also isolates an AuthFailedError (Greenhouse/Lever/Ashby's own 'abort the whole search()' boundary)", async () => {
    const healthy = new FakeSource("greenhouse", { jobs: [], skipped: [], skipRate: 0 });
    const broken = new ThrowingSource("lever", new AuthFailedError("credentials rejected"));

    const outcomes = await new CompositeSource([healthy, broken]).search({});

    expect(outcomes[0]).toEqual({
      dataSource: "greenhouse",
      status: "ok",
      result: { jobs: [], skipped: [], skipRate: 0 },
    });
    expect(outcomes[1]).toEqual({
      dataSource: "lever",
      status: "error",
      errorMessage: "credentials rejected",
    });
  });

  it("runs every source's search() concurrently, not sequentially — no source waits for an earlier one to settle", async () => {
    const started: string[] = [];
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });

    function slowSource(dataSource: NormalizedJob["dataSource"]): JobSource {
      return {
        dataSource,
        async search(): Promise<SourceSearchResult> {
          started.push(dataSource);
          // Every source blocks on the SAME gate — this can only resolve
          // for all of them if every `search()` call was already issued
          // (i.e. run concurrently) before any one of them is allowed to
          // finish. A sequential implementation would hang here forever,
          // since the second source's `search()` would never even be
          // called until the first one resolved.
          await gate;
          return { jobs: [], skipped: [], skipRate: 0 };
        },
      };
    }

    const composite = new CompositeSource([
      slowSource("greenhouse"),
      slowSource("lever"),
      slowSource("ashby"),
    ]);

    const resultPromise = composite.search({});
    // Give every microtask/macrotask a chance to reach the `await gate`
    // line before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started.sort()).toEqual(["ashby", "greenhouse", "lever"]);

    releaseAll();
    const outcomes = await resultPromise;
    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.status === "ok")).toBe(true);
  });
});
