import type { SkippedSource, SourceOutcome } from "@app/shared";

/**
 * Per-RUN source health (decision #5) — distinct from the static
 * `GET /sources` health shown on the toggle list itself (SourceToggles.tsx):
 * this reflects what actually happened on THIS estimate/run — rate limits,
 * zero postings, a board that 404'd — without breaking the rest of the
 * list. `skippedSources` covers a requested sourceId that couldn't even be
 * resolved (unconfigured/unknown); `sourceOutcomes` covers one that WAS
 * queried and reports what it found.
 */
export function SourceOutcomesList({
  sourceOutcomes,
  skippedSources,
}: {
  sourceOutcomes: SourceOutcome[];
  skippedSources: SkippedSource[];
}) {
  if (sourceOutcomes.length === 0 && skippedSources.length === 0) return null;
  return (
    <div className="source-outcomes">
      {skippedSources.length > 0 && (
        <ul className="skipped-sources">
          {skippedSources.map((s) => (
            <li key={s.id}>
              <strong>{s.id}</strong> unavailable — {s.reason}
            </li>
          ))}
        </ul>
      )}
      {sourceOutcomes.length > 0 && (
        <ul className="source-outcome-list">
          {sourceOutcomes.map((o) => (
            <li key={o.dataSource} className={`source-outcome-${o.status}`}>
              <strong>{o.dataSource}</strong>: {o.status}
              {o.status !== "error"
                ? ` — ${o.jobsFound} found, ${o.survivedFilter} passed filtering`
                : o.errorMessage
                  ? ` — ${o.errorMessage}`
                  : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
