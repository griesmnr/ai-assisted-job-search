import type { SearchSourceState } from "@app/shared";

/**
 * Ticket 2e7ba8a: per-source status for a queue-driven search, read off
 * `GET /searches/:id`'s `sources[]` (@app/shared's `SearchSourceState`).
 *
 * Deliberately NOT `SourceOutcomesList` (that component's `SourceOutcome[]`
 * prop type): that shape is the point-in-time result of
 * `POST /searches/estimate` -- richer (`boardCoverage`, `skipRate`,
 * `survivedFilter`) but never persisted, and never `"pending"`, because an
 * estimate call is synchronous and always finishes before it returns.
 * `SearchSourceState` is the opposite: a durable DB row that can be read
 * back at ANY point in a run, including while a source is still
 * `"pending"` (still fetching) -- which is exactly why this list is shown
 * from BOTH the "running" and "done" panels in `SearchFlow.tsx`, not just
 * the final one. Force-fitting the two shapes into one component would mean
 * either faking fields `SearchSourceState` doesn't have, or a `"pending"`
 * branch `SourceOutcome` can never actually reach -- neither is honest.
 *
 * This is also literally CLAUDE.md's stated DLQ product behavior finally
 * reachable end to end: "a source fails repeatedly... it dead-letters, the
 * UI shows that source as unavailable, and the other sources still
 * return." Before this ticket, a `"failed"` source rendered as a plain
 * text line (`sourceId: status`) indistinguishable at a glance from a
 * healthy one; this gives it a badge with real color/status semantics
 * instead of relying on the reader to parse a status word out of a
 * sentence.
 */
export function SearchSourceStatusList({ sources }: { sources: SearchSourceState[] }) {
  if (sources.length === 0) return null;
  return (
    <ul className="search-source-status-list">
      {sources.map((s) => (
        <li key={s.sourceId} className={`search-source-status search-source-status-${s.status}`}>
          <span className="search-source-status-badge">{describeStatus(s.status)}</span>
          <strong>{s.sourceId}</strong>
          {s.status === "complete" && s.linkedJobCount !== null && (
            <span className="search-source-status-detail">
              {" "}
              — {s.linkedJobCount} job{s.linkedJobCount === 1 ? "" : "s"} linked
            </span>
          )}
          {s.status === "pending" && (
            <span className="search-source-status-detail"> — still fetching</span>
          )}
          {s.status === "failed" && (
            <span className="search-source-status-detail">
              {" "}
              — unavailable
              {s.errorKind ? ` (${s.errorKind})` : ""}
              {s.errorMessage ? `: ${s.errorMessage}` : ""}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function describeStatus(status: SearchSourceState["status"]): string {
  switch (status) {
    // Not "Done" -- the "done" phase's own action button already reads
    // "Done" (SearchFlow.tsx), and a per-source badge with the identical
    // label right next to it reads as confusing/duplicated rather than
    // informative. "Fetched" pairs naturally with the "Fetching" pending
    // label below instead.
    case "complete":
      return "Fetched";
    case "failed":
      return "Unavailable";
    case "pending":
      return "Fetching";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
