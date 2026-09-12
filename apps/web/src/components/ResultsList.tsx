import { useState } from "react";
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
  resumeId,
  onSetStatus,
  onClearStatus,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  resumeId: string;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
  onClearStatus: (jobId: string) => Promise<void>;
}) {
  // Ticket b182bde: opt-in, DEFAULT-OFF client-side filter on already-
  // fetched results, same pattern as `selectedSourceIds` above -- never a
  // silent server-side drop (both of Nicole's real applied-to postings are
  // in the "overqualified" bucket; hiding them by default would have hidden
  // her own real choices). Local state, not lifted to a caller prop:
  // nothing else in the app needs to know this filter is on, unlike
  // `selectedSourceIds`, which is also scoped by the search flow.
  const [hideOverqualified, setHideOverqualified] = useState(false);

  const bySource = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const overqualifiedCount = bySource.filter((r) => r.levelFit === "overqualified").length;
  const visible = hideOverqualified
    ? bySource.filter((r) => r.levelFit !== "overqualified")
    : bySource;
  const hiddenBySourceToggle = data.results.length - bySource.length;
  // Ticket b182bde review (F1): how many of the source-filtered set the
  // "hide overqualified" checkbox itself removed. 0 when the checkbox is
  // off, even though `overqualifiedCount` may be nonzero — the summary must
  // only blame the level filter for jobs it actually hid.
  const hiddenByLevelFilter = hideOverqualified ? overqualifiedCount : 0;

  return (
    <div className="results-list">
      <p className="results-summary">
        {visible.length === 0
          ? // Ticket b182bde review (F1b): `bySource.length > 0` here means
            // every source-visible job was hidden by the level filter, not
            // by source selection -- the old generic message ("no jobs
            // match the current source selection") was FALSE in that case,
            // since the jobs do match the source selection. Only fall back
            // to the generic message when there really are zero jobs from
            // the selected sources regardless of the level filter.
            hideOverqualified && bySource.length > 0
            ? 'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.'
            : "No jobs match the current source selection."
          : `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected.` +
            // Only worth stating when it's a PARTIAL hide — if visible.length
            // is already 0, the branch above already says everything is
            // hidden; repeating the count here would be redundant, not
            // additionally informative.
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "") +
            // Ticket b182bde review (F1a): the level filter is a SEPARATE
            // hiding mechanism from source toggles and needs its own
            // clause, or a partial level-filter hide reads as fully
            // unexplained (e.g. 20 of 25, checkbox on, 5 overqualified --
            // old text blamed source toggles for zero of the missing 5).
            (hiddenByLevelFilter > 0 ? ` (${hiddenByLevelFilter} above your level hidden.)` : "")}
      </p>
      {/* Ticket b182bde: the count is shown regardless of whether the
          checkbox is checked -- same pattern as the "(N hidden by source
          toggles.)" text above. */}
      <label className="hide-overqualified-toggle">
        <input
          type="checkbox"
          checked={hideOverqualified}
          onChange={() => setHideOverqualified((v) => !v)}
        />
        Hide roles above my level ({overqualifiedCount})
      </label>
      {data.hiddenBelowFloor !== undefined && (
        <p className="results-hidden-floor">
          {data.hiddenBelowFloor} more job{data.hiddenBelowFloor === 1 ? "" : "s"} scored below the
          match-quality floor and {data.hiddenBelowFloor === 1 ? "is" : "are"} not shown.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="result-cards">
          {visible.map((result) => (
            <ResultCard
              key={result.jobId}
              result={result}
              resumeId={resumeId}
              onSetStatus={onSetStatus}
              onClearStatus={onClearStatus}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
