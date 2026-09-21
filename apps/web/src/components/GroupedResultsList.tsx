import { useState } from "react";
import type { GetAllResultsResponse, ScoredJobResult, UserJobStatus } from "@app/shared";
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
  groupFor,
  onSetStatus,
  onClearStatus,
}: {
  // Ticket 3f0883f: widened from `GetResumeResultsResponse` (which this
  // component never actually read the `resumeId`/`resumeNickname` half of
  // anyway) to `GetAllResultsResponse` -- "Already Scored Jobs" spans every
  // resume now, and a `GetResumeResultsResponse` is structurally still
  // assignable here, so nothing about the single-resume caller
  // (App.tsx isn't one anymore -- see that file -- but ResultsList.tsx
  // stayed on the narrower type for its own single-resume case) had to
  // change.
  data: GetAllResultsResponse;
  selectedSourceIds: ReadonlySet<string>;
  groupFor: (result: ScoredJobResult) => ScoredGroupKey;
  // Ticket 3f0883f review fix: passthrough to ResultCard, which now
  // supplies `resumeId` itself (from `result.resumeId`) -- see that
  // component's own doc comment on this prop.
  onSetStatus: (jobId: string, status: UserJobStatus, resumeId: string) => Promise<void>;
  onClearStatus: (jobId: string) => Promise<void>;
}) {
  // Ticket b182bde: opt-in, DEFAULT-OFF client-side filter, same pattern as
  // `selectedSourceIds` -- see ResultsList.tsx's identical filter for the
  // full reasoning (never a silent server-side drop).
  const [hideOverqualified, setHideOverqualified] = useState(false);
  // Ticket 8f5a79c: see ResultsList.tsx's identical state for the full
  // reasoning -- DEFAULT-OFF, contract/temp postings shown unless hidden.
  const [hideContractOrTemp, setHideContractOrTemp] = useState(false);

  const bySource = data.results.filter((r) => selectedSourceIds.has(r.dataSource));
  const overqualifiedCount = bySource.filter((r) => r.levelFit === "overqualified").length;
  const contractOrTempCount = bySource.filter((r) => r.isContractOrTemp).length;
  // Ticket 8f5a79c: see ResultsList.tsx's identical telescoping computation
  // for the full reasoning (sequential source -> level -> contract/temp, so
  // an overlap between the two hide-toggles is never double-counted).
  const afterLevel = hideOverqualified
    ? bySource.filter((r) => r.levelFit !== "overqualified")
    : bySource;
  const visible = hideContractOrTemp ? afterLevel.filter((r) => !r.isContractOrTemp) : afterLevel;
  const hiddenBySourceToggle = data.results.length - bySource.length;
  const hiddenByLevelFilter = bySource.length - afterLevel.length;
  const hiddenByContractFilter = afterLevel.length - visible.length;

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

  // Ticket 8f5a79c: see ResultsList.tsx's identical three-way empty-state
  // logic for the full reasoning.
  let emptyStateMessage: string | null = null;
  if (bySource.length === 0) {
    emptyStateMessage = "No jobs match the current source selection.";
  } else if (visible.length === 0) {
    if (afterLevel.length === 0) {
      emptyStateMessage =
        'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.';
    } else if (hideContractOrTemp) {
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
            (hiddenBySourceToggle > 0
              ? ` (${hiddenBySourceToggle} hidden by source toggles.)`
              : "") +
            // Ticket b182bde review (F1a): see ResultsList.tsx's identical
            // clause for the full reasoning.
            (hiddenByLevelFilter > 0 ? ` (${hiddenByLevelFilter} above your level hidden.)` : "") +
            // Ticket 8f5a79c: see ResultsList.tsx's identical clause.
            (hiddenByContractFilter > 0
              ? ` (${hiddenByContractFilter} contract/temp hidden.)`
              : "")}
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
      {/* Ticket 8f5a79c: same "count always shown" convention. */}
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
      {/* Ticket e9a82f3: see ResultsList.tsx's identical block -- only
          rendered when the server's LIMIT actually truncated the matching
          rows. */}
      {data.totalMatchingCount !== undefined && (
        <p className="results-truncated">
          Showing top {data.results.length} of {data.totalMatchingCount} matching jobs.
        </p>
      )}
      {/* Quick links (dogfooding feedback, 2026-09-08 -- Nicole's own
          suggestion when she punted on the exact group order: "I think
          there should be quick links at the top of the page"). Plain
          in-page anchors (`#group-id`), no JS needed.

          Ticket 1ea4bf3: membership and counts here come from LIVE status
          (`liveBuckets`), while which sections actually exist in the DOM
          below comes from the FROZEN `groupFor` (`buckets`) -- so a link
          can point at `#results-group-X` while no such section is
          currently rendered (a status change made a group non-empty live,
          but the card hasn't moved sections yet), and conversely a
          rendered section can have no link pointing at it (the reverse
          case). This is a known, accepted product tradeoff, not a bug --
          reopening the tab reconciles both. Flagged to Nicole rather than
          silently choosing a different design (e.g. suppressing a link
          whose section doesn't exist yet) when this shipped. */}
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
                // Ticket 3f0883f: composite key, not just `result.jobId` --
                // the same posting can legitimately appear twice here now,
                // once per resume that scored it, and a bare `jobId` key
                // would collide (React would treat the second occurrence
                // as an update to the first, not a distinct list item).
                <ResultCard
                  key={`${result.jobId}-${result.resumeId}`}
                  result={result}
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
