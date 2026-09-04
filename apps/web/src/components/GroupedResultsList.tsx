import type { GetResumeResultsResponse, ScoredJobResult, UserJobStatus } from "@app/shared";
import { ResultCard } from "./ResultCard";

/**
 * "Already Scored Jobs" grouping (ticket bec2f98). Nicole: "saved can
 * maybe be on the top, no action taken, and then the other statuses at
 * your discretion." Ordering below is this component's own discretion
 * call, applying that instruction: Saved first, then untouched, then the
 * three statuses that represent something already having happened to the
 * job, roughly least-to-most "done with it".
 */
export type ScoredGroupKey = "saved" | "no_action" | "resume_optimized" | "applied" | "dismissed";

const GROUP_ORDER: ScoredGroupKey[] = [
  "saved",
  "no_action",
  "resume_optimized",
  "applied",
  "dismissed",
];

const GROUP_LABELS: Record<ScoredGroupKey, string> = {
  saved: "Saved",
  no_action: "No action taken",
  resume_optimized: "Resume Optimized",
  applied: "Applied",
  dismissed: "Dismissed",
};

export function groupKeyForStatus(status: UserJobStatus | null): ScoredGroupKey {
  return status === null ? "no_action" : status;
}

/**
 * Same summary/floor copy as `ResultsList`, but renders `visible` split
 * into labeled group sections instead of one flat ranked list.
 *
 * Which group a card renders under is decided ENTIRELY by the caller's
 * `groupFor`, not by reading `result.status` directly here — that's the
 * hook for the caller's snapshot-at-tab-open behavior (App.tsx): a status
 * change still updates a card's own badge/actions in place (this
 * component always renders the live `result` it's given), but must not
 * move the card to a different group until the caller's snapshot says so.
 * Real UX problem Nicole caught herself, live: "if somebody clicks
 * optimize resume on a saved job, it's going to suddenly disappear...
 * from that current state."
 */
export function GroupedResultsList({
  data,
  selectedSourceIds,
  resumeId,
  groupFor,
  onSetStatus,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  resumeId: string;
  groupFor: (result: ScoredJobResult) => ScoredGroupKey;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
}) {
  const visible = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const hiddenBySourceToggle = data.results.length - visible.length;

  const buckets = new Map<ScoredGroupKey, ScoredJobResult[]>(GROUP_ORDER.map((k) => [k, []]));
  for (const result of visible) {
    buckets.get(groupFor(result))!.push(result);
  }

  return (
    <div className="results-list">
      <p className="results-summary">
        {visible.length === 0
          ? "No jobs match the current source selection."
          : `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected.` +
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
      {GROUP_ORDER.map((key) => {
        const results = buckets.get(key)!;
        if (results.length === 0) return null;
        return (
          <section key={key} className="results-group">
            <h3>{GROUP_LABELS[key]}</h3>
            <ul className="result-cards">
              {results.map((result) => (
                <ResultCard
                  key={result.jobId}
                  result={result}
                  resumeId={resumeId}
                  onSetStatus={onSetStatus}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
