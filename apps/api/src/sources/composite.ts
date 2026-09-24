import type { Job } from "@app/shared";
import type { JobSource, SearchCriteria, SourceSearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fans a single search out across every configured JobSource. Ticket
// d8417b2: until now, exactly one source (Greenhouse) was ever wired into
// `demo-match.ts` — Lever, Ashby, and SmartRecruiters were merged, tested,
// and never called by anything.
//
// DESIGN NOTE — this class deliberately does NOT implement `JobSource`.
// The ticket's own framing suggested it might ("a CompositeSource that
// implements JobSource, fans out, and merges"), but two things about this
// codebase's existing shape make that dishonest, not just inconvenient:
//
//   1. `JobSource.dataSource: Job["dataSource"]` is a closed six-member
//      union (see packages/shared) — every one of them a REAL source. A
//      composite of four sources has no truthful single value to report
//      there; picking one (even a new literal like "composite") either
//      lies about which real source a job came from or requires widening
//      `Job["dataSource"]` for a concern (aggregation) that has nothing to
//      do with what that field means everywhere else it's used (the FK on
//      `jobs.data_source`, the `(data_source, external_id)` uniqueness
//      constraint that makes ingestion idempotent).
//
//   2. `ingestJobsForSearch` (../ingest/ingestJobs.ts) takes ONE
//      `dataSource` string for a whole batch and uses it to look up the
//      rows it just upserted (`where(eq(jobs.dataSource, dataSource), ...)`
//      — see that file). A batch that actually mixes greenhouse/lever/
//      ashby/smartrecruiters rows under one caller-supplied `dataSource`
//      would upsert every row fine (each `NormalizedJob` carries its own
//      correct `dataSource`) but then silently fail to find every row
//      whose real `dataSource` differs from whatever single value the
//      caller passed — `ingestJobsForSearch`'s own "should be impossible"
//      guard would fire for real, on every job from three of the four
//      sources. This is not a style preference; a `CompositeSource` that
//      pretended to be a single `JobSource` and got threaded through
//      `runDemoMatch` unmodified would break ingestion for 3/4 of the
//      postings it collects.
//
// So `runDemoMatch` (demo-match.ts) was changed instead — it now takes
// `sources: JobSource[]` and ingests once per REAL `dataSource` actually
// present in the shortlist, using each `NormalizedJob`'s own `dataSource`,
// never a single source-level label. `CompositeSource` here only does the
// fan-out and per-source isolation; merging jobs for scoring, computing
// per-source funnel health, and per-`dataSource` ingestion all live in
// `runDemoMatch`, which is where the DB-shaped concerns belong.
//
// Also deliberately does NOT merge results into one `SourceSearchResult`
// (one `jobs[]`, one `skipped[]`, one `skipRate`). Ticket b723fb9 built
// `TokenOutcome` for exactly this reason one level down — a single
// aggregate `skipRate` across many Greenhouse *boards* hid which board was
// actually unhealthy. Averaging four whole SOURCES together would recreate
// the identical failure one level up: "1 of 4 sources totally down" and
// "all 4 sources fine" can both present as unremarkable aggregate numbers
// depending on how big the healthy sources' boards are. This class instead
// returns one `PerSourceOutcome` per configured source, untouched.
// ---------------------------------------------------------------------------

/**
 * One configured source's outcome from a single `CompositeSource#search()`
 * call.
 */
export type PerSourceOutcome =
  | { dataSource: Job["dataSource"]; status: "ok"; result: SourceSearchResult }
  /**
   * This source's `search()` call itself rejected — a failure at the
   * WHOLE-SOURCE level (a network outage, or one of an adapter's own
   * "abort the whole search()" error kinds — e.g. Greenhouse's 401/
   * malformed-response/unclassified-4xx boundary; see greenhouse.ts's
   * per-error-kind isolation policy comment on `GreenhouseSource#search`).
   * Every adapter already isolates PER-TOKEN failures internally (one bad
   * board, one rate-limited board) and reports those through a normal
   * "ok" result's `skipped`/`tokenOutcomes` — by the time `search()`
   * itself throws, the adapter has decided the failure isn't safely
   * isolable at a finer grain than "this whole source, this run".
   * `CompositeSource`'s entire job is making sure THAT failure can't also
   * take the other configured sources down with it.
   */
  | { dataSource: Job["dataSource"]; status: "error"; errorMessage: string };

export class CompositeSource {
  readonly #sources: JobSource[];

  constructor(sources: JobSource[]) {
    if (sources.length === 0) {
      throw new Error("CompositeSource requires at least one configured JobSource.");
    }
    this.#sources = sources;
  }

  /**
   * Concurrent across sources (`Promise.allSettled`, not sequential),
   * unlike a single adapter's own internal per-token/per-company loop
   * (deliberately sequential in every adapter here — see greenhouse.ts/
   * lever.ts/ashby.ts's own `search()` comments — because every token
   * WITHIN one source hits the SAME shared, unauthenticated host, and
   * courtesy to that one host argues against hammering it in parallel).
   * These four calls hit four entirely different hosts
   * (boards-api.greenhouse.io, api.lever.co, api.ashbyhq.com,
   * api.smartrecruiters.com) — nothing about rate-limit courtesy to one
   * host says anything about a different host, so there is no reason to
   * pay for four sources' worth of sequential latency (each already
   * several seconds internally at today's token-list sizes) end to end.
   * `allSettled`, specifically, not `all`: the whole point of this class
   * is that one source's rejection must not cancel or discard the
   * others' in-flight results.
   *
   * `onSourceSettled` (ticket bf2dd0a) is the per-source progress hook a
   * slow, multi-source `POST /searches/estimate` needs — see
   * `matching/estimateProgress.ts`'s doc comment for the full story of why
   * it exists. Attached via `.finally()` on each INDIVIDUAL source promise,
   * not read off the aggregate `settled` array below: `Promise.allSettled`
   * itself only resolves once every source is done, so waiting for it
   * before reporting anything would defeat the entire point — a caller
   * watching for incremental progress needs to hear about the fast sources
   * as they land, not all at once at the end alongside the slowest one.
   * `.finally()`, not `.then()`, because a source that REJECTED has still
   * settled — an error is exactly as reportable a "this one's done" event
   * as a success, and the caller already has to interpret a mix of
   * ok/error outcomes from `PerSourceOutcome` itself. Optional and
   * defaults to a no-op so every existing caller (this class's own tests,
   * `runDemoMatch`'s CLI path) keeps working unchanged.
   *
   * The call is wrapped in try/catch (opus review round 1): a `.finally()`
   * callback that throws rejects the promise IT returns, and that returned
   * promise — not the source's own `search()` promise — is what this
   * source's entry in `settled` actually reflects. Without the guard, a bug
   * in the progress-tracking callback would silently turn a source that
   * fetched successfully into a reported `"error"` and drop its real jobs
   * from the estimate — exactly the kind of failure `estimateProgress.ts`'s
   * own `markSourceSettled` doc comment promises can never happen ("must
   * never have its actual fetch/estimate work fail because a progress
   * update landed late"). `markSourceSettled` itself cannot throw today, so
   * this is a belt-and-braces isolation at the one place that promise
   * actually has to be kept, not a fix for an observed bug.
   */
  async search(
    criteria: SearchCriteria,
    onSourceSettled?: (dataSource: Job["dataSource"]) => void,
  ): Promise<PerSourceOutcome[]> {
    const settled = await Promise.allSettled(
      this.#sources.map((source) =>
        source.search(criteria).finally(() => {
          try {
            onSourceSettled?.(source.dataSource);
          } catch {
            // Intentionally swallowed -- see this method's doc comment.
          }
        }),
      ),
    );

    return settled.map((outcome, i): PerSourceOutcome => {
      const dataSource = this.#sources[i]!.dataSource;
      if (outcome.status === "fulfilled") {
        return { dataSource, status: "ok", result: outcome.value };
      }
      const reason: unknown = outcome.reason;
      const errorMessage = reason instanceof Error ? reason.message : String(reason);
      return { dataSource, status: "error", errorMessage };
    });
  }
}
