import type { GetResumeResultsResponse, UserJobStatus } from "@app/shared";
import { ResultCard } from "./ResultCard";

/**
 * Renders the curated (score-floor-applied) result set, filtered by the
 * currently toggled-on sources — client-side, per decision #3: source
 * toggles filter an already-fetched corpus instantly, they never trigger a
 * new fetch. `data` is always the FULL floor-applied set for the resume
 * (see hooks/useResults.ts); `selectedSourceIds` narrows it here.
 *
 * "Short curated list, not an unbounded ranked table" (decision #1,
 * 2026-08-22/29): `hiddenBelowFloor` is always shown when present, even at
 * 0, so an empty-looking short list never reads as a broken run — it says
 * outright how many real, scored jobs are sitting below the floor.
 */
export function ResultsList({
  data,
  selectedSourceIds,
  onSetStatus,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
}) {
  const visible = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const hiddenBySourceToggle = data.results.length - visible.length;

  return (
    <div className="results-list">
      <p className="results-summary">
        {visible.length === 0
          ? "No jobs match the current source selection."
          : `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected.` +
            // Only worth stating when it's a PARTIAL hide — if visible.length
            // is already 0, "no jobs match the current source selection"
            // already says everything is hidden; repeating the count here
            // would be redundant, not additionally informative.
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "")}
      </p>
      {data.hiddenBelowFloor !== undefined && (
        <p className="results-hidden-floor">
          {data.hiddenBelowFloor} more job{data.hiddenBelowFloor === 1 ? "" : "s"} scored below the
          match-quality floor and {data.hiddenBelowFloor === 1 ? "is" : "are"} not shown.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="result-cards">
          {visible.map((result) => (
            <ResultCard key={result.jobId} result={result} onSetStatus={onSetStatus} />
          ))}
        </ul>
      )}
    </div>
  );
}
