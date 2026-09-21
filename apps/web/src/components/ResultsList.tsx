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
  onSetStatus,
  onClearStatus,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  // Ticket 3f0883f review fix: passthrough to ResultCard, which now
  // supplies `resumeId` itself (from `result.resumeId`) -- see that
  // component's own doc comment on this prop.
  onSetStatus: (jobId: string, status: UserJobStatus, resumeId: string) => Promise<void>;
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
  // Ticket 8f5a79c: second, independent opt-in client-side filter, same
  // pattern as `hideOverqualified` above. DEFAULT-OFF/unchecked, per
  // Nicole's explicit "just another job to apply for" framing (git-bug
  // 8f5a79c correction) -- contract/temp postings are shown by default,
  // this checkbox is for hiding them if she wants to, never an opt-in gate.
  const [hideContractOrTemp, setHideContractOrTemp] = useState(false);

  const bySource = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const overqualifiedCount = bySource.filter((r) => r.levelFit === "overqualified").length;
  const contractOrTempCount = bySource.filter((r) => r.isContractOrTemp).length;
  // Ticket 8f5a79c: filters applied SEQUENTIALLY (source -> level ->
  // contract/temp), each producing its own "hidden by this step" count as
  // the delta from the PREVIOUS step, not from `bySource` independently of
  // the other filter. This is what keeps three simultaneously-active
  // filters honest in the summary text below: `hiddenBySourceToggle +
  // hiddenByLevelFilter + hiddenByContractFilter` telescopes exactly to
  // `data.results.length - visible.length`, so a job hidden by BOTH the
  // level filter and the contract filter is never counted twice (it's
  // "claimed" by whichever filter's step actually removed it — here, the
  // level filter, since it runs first). The CHECKBOX LABEL counts
  // (`overqualifiedCount`/`contractOrTempCount` above) deliberately do NOT
  // use this same post-other-filter set — they're both computed straight
  // off `bySource`, independent of the other checkbox's state, so checking
  // one filter's box never makes the OTHER box's own displayed count jump
  // around. The two kinds of number answer different questions on purpose:
  // the label says "how many roles like this exist in your source-filtered
  // results," the summary sentence says "how many did this specific filter
  // actually just hide."
  const afterLevel = hideOverqualified
    ? bySource.filter((r) => r.levelFit !== "overqualified")
    : bySource;
  const visible = hideContractOrTemp ? afterLevel.filter((r) => !r.isContractOrTemp) : afterLevel;
  const hiddenBySourceToggle = data.results.length - bySource.length;
  const hiddenByLevelFilter = bySource.length - afterLevel.length;
  const hiddenByContractFilter = afterLevel.length - visible.length;

  // Ticket 8f5a79c: extends ticket b182bde's F1b empty-state fix to a THIRD
  // filter. `bySource.length === 0` is the only case that's genuinely about
  // source selection; everything else with `visible.length === 0` means one
  // (or both) of the two hide-toggles emptied an otherwise non-empty
  // source-filtered set, and the message must name the toggle actually
  // responsible rather than falling back to the source-selection message
  // (which would be false — the jobs DO match the selected sources).
  let emptyStateMessage: string | null = null;
  if (bySource.length === 0) {
    emptyStateMessage = "No jobs match the current source selection.";
  } else if (visible.length === 0) {
    if (afterLevel.length === 0) {
      // The level filter alone already emptied the source-filtered set —
      // true regardless of whether the contract filter is ALSO checked,
      // since its own marginal contribution here is necessarily 0 (there
      // was nothing left for it to remove).
      emptyStateMessage =
        'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.';
    } else if (hideContractOrTemp) {
      // afterLevel.length > 0 here, so the contract filter is what emptied
      // the remainder. Names the level filter too when it already narrowed
      // the set on the way there, so the message doesn't imply the level
      // filter did nothing when it may have removed some jobs upstream.
      emptyStateMessage = hideOverqualified
        ? 'Every remaining job (after hiding roles above your level) is contract/temp — uncheck "Hide contract/temp roles" to see them.'
        : 'Every job from the selected sources is contract/temp — uncheck "Hide contract/temp roles" to see them.';
    }
  }

  return (
    <div className="results-list">
      <p className="results-summary">
        {emptyStateMessage ??
          `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected.` +
            // Only worth stating when it's a PARTIAL hide — if visible.length
            // is already 0, `emptyStateMessage` above already says
            // everything is hidden; repeating the count here would be
            // redundant, not additionally informative.
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "") +
            // Ticket b182bde review (F1a): the level filter is a SEPARATE
            // hiding mechanism from source toggles and needs its own
            // clause, or a partial level-filter hide reads as fully
            // unexplained (e.g. 20 of 25, checkbox on, 5 overqualified --
            // old text blamed source toggles for zero of the missing 5).
            (hiddenByLevelFilter > 0 ? ` (${hiddenByLevelFilter} above your level hidden.)` : "") +
            // Ticket 8f5a79c: third independent clause, same reasoning —
            // `hiddenByContractFilter` is telescoped off `afterLevel`, not
            // `bySource`, so this never double-counts a job the level
            // filter already removed.
            (hiddenByContractFilter > 0
              ? ` (${hiddenByContractFilter} contract/temp hidden.)`
              : "")}
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
      {/* Ticket 8f5a79c: same "count always shown" convention as the level
          filter above. */}
      <label className="hide-contract-toggle">
        <input
          type="checkbox"
          checked={hideContractOrTemp}
          onChange={() => setHideContractOrTemp((v) => !v)}
        />
        Hide contract/temp roles ({contractOrTempCount})
      </label>
      {data.hiddenBelowFloor !== undefined && (
        <p className="results-hidden-floor">
          {data.hiddenBelowFloor} more job{data.hiddenBelowFloor === 1 ? "" : "s"} scored below the
          match-quality floor and {data.hiddenBelowFloor === 1 ? "is" : "are"} not shown.
        </p>
      )}
      {/* Ticket e9a82f3: only rendered when the server's LIMIT actually
          truncated the matching rows -- untruncated responses never carry
          `totalMatchingCount`, so this never appears when everything that
          matched is already in `data.results`. */}
      {data.totalMatchingCount !== undefined && (
        <p className="results-truncated">
          Showing top {data.results.length} of {data.totalMatchingCount} matching jobs.
        </p>
      )}
      {visible.length > 0 && (
        <ul className="result-cards">
          {visible.map((result) => (
            <ResultCard
              key={result.jobId}
              result={result}
              onSetStatus={onSetStatus}
              onClearStatus={onClearStatus}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
