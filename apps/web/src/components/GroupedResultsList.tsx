import { useState } from "react";
import type { GetResumeResultsResponse, ScoredJobResult, UserJobStatus } from "@app/shared";
import { ResultCard } from "./ResultCard";

/**
 * "Already Scored Jobs" grouping (ticket bec2f98). Nicole: "saved can
 * maybe be on the top, no action taken, and then the other statuses at
 * your discretion." Order revised in dogfooding feedback (2026-09-08):
 * "let's put applied before no action taken" -- when asked for the FULL
 * order, she deferred back ("I just don't know what I want here... gonna
 * let you decide"), so Applied simply moves up one slot from its old
 * position rather than being reshuffled further -- the smallest change
 * that satisfies the literal request.
 */
export type ScoredGroupKey = "saved" | "no_action" | "resume_optimized" | "applied" | "dismissed";

const GROUP_ORDER: ScoredGroupKey[] = [
  "saved",
  "applied",
  "no_action",
  "resume_optimized",
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
 *
 * Ticket 1ea4bf3: the quick-links nav above the sections is the one
 * exception -- its counts and which groups get a link are computed LIVE
 * (`groupKeyForStatus(result.status)` applied directly), not from
 * `groupFor`. See `liveBuckets` below.
 */
export function GroupedResultsList({
  data,
  selectedSourceIds,
  resumeId,
  groupFor,
  onSetStatus,
  onClearStatus,
}: {
  data: GetResumeResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  resumeId: string;
  groupFor: (result: ScoredJobResult) => ScoredGroupKey;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
  onClearStatus: (jobId: string) => Promise<void>;
}) {
  // Ticket b182bde: opt-in, DEFAULT-OFF client-side filter, same pattern as
  // `selectedSourceIds` -- see ResultsList.tsx's identical filter for the
  // full reasoning (never a silent server-side drop).
  const [hideOverqualified, setHideOverqualified] = useState(false);

  const bySource = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const overqualifiedCount = bySource.filter((r) => r.levelFit === "overqualified").length;
  const visible = hideOverqualified
    ? bySource.filter((r) => r.levelFit !== "overqualified")
    : bySource;
  const hiddenBySourceToggle = data.results.length - bySource.length;
  // Ticket b182bde review (F1): see ResultsList.tsx's identical variable for
  // the full reasoning.
  const hiddenByLevelFilter = hideOverqualified ? overqualifiedCount : 0;

  const buckets = new Map<ScoredGroupKey, ScoredJobResult[]>(GROUP_ORDER.map((k) => [k, []]));
  for (const result of visible) {
    buckets.get(groupFor(result))!.push(result);
  }

  // Ticket 1ea4bf3: the quick-links nav needs LIVE counts (Nicole,
  // dogfooding: "they need to update because I just updated one and the
  // shortcut links didn't get updated"), but card placement above must stay
  // frozen per bec2f98 -- so this is a SECOND, separate bucket computation
  // over the same `visible` array, keyed by `groupKeyForStatus(result.status)`
  // directly instead of the caller's (possibly snapshot-frozen) `groupFor`.
  // Do NOT merge this with `buckets` above -- that's exactly the trap the
  // ticket calls out ("easy to accidentally fix by just un-freezing
  // `groupFor` entirely, which would silently undo bec2f98"). The known,
  // accepted consequence (see ticket 1ea4bf3 Scope) is that a quick-link's
  // live count can then differ from the number of cards actually visible
  // under its (frozen) target section for the rest of the tab-open session.
  const liveBuckets = new Map<ScoredGroupKey, ScoredJobResult[]>(GROUP_ORDER.map((k) => [k, []]));
  for (const result of visible) {
    liveBuckets.get(groupKeyForStatus(result.status))!.push(result);
  }

  return (
    <div className="results-list">
      <p className="results-summary">
        {visible.length === 0
          ? // Ticket b182bde review (F1b): see ResultsList.tsx's identical
            // branch for the full reasoning -- don't blame source selection
            // for a hide the level filter actually did.
            hideOverqualified && bySource.length > 0
            ? 'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.'
            : "No jobs match the current source selection."
          : `Showing ${visible.length} of ${data.results.length} scored jobs from the sources you've selected.` +
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "") +
            // Ticket b182bde review (F1a): see ResultsList.tsx's identical
            // clause for the full reasoning.
            (hiddenByLevelFilter > 0 ? ` (${hiddenByLevelFilter} above your level hidden.)` : "")}
      </p>
      {/* Ticket b182bde: count always shown, same pattern as the source-
          toggle hidden count above. */}
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
      {/* Quick links (dogfooding feedback, 2026-09-08 -- Nicole's own
          suggestion when she punted on the exact group order: "I think
          there should be quick links at the top of the page"). Only
          non-empty groups get a link -- jumping to an empty group's
          heading would be pointless. Plain in-page anchors (`#group-id`),
          no JS needed. */}
      {GROUP_ORDER.some((key) => liveBuckets.get(key)!.length > 0) && (
        <nav className="results-group-quicklinks" aria-label="Jump to group">
          {GROUP_ORDER.filter((key) => liveBuckets.get(key)!.length > 0).map((key) => (
            <a key={key} href={`#results-group-${key}`}>
              {GROUP_LABELS[key]} ({liveBuckets.get(key)!.length})
            </a>
          ))}
        </nav>
      )}
      {GROUP_ORDER.map((key) => {
        const results = buckets.get(key)!;
        if (results.length === 0) return null;
        return (
          <section key={key} id={`results-group-${key}`} className="results-group">
            <h3>{GROUP_LABELS[key]}</h3>
            <ul className="result-cards">
              {results.map((result) => (
                <ResultCard
                  key={result.jobId}
                  result={result}
                  resumeId={resumeId}
                  onSetStatus={onSetStatus}
                  onClearStatus={onClearStatus}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
