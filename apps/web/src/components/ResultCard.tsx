import { useState } from "react";
import type { ScoredJobResult, UserJobStatus } from "@app/shared";

// State pill labels (past-tense/state form) -- shown once result.status is
// SET, describing what already happened. Distinct from ACTION_LABELS
// below (ticket bed37bd): a button that DOES the saving should read
// "Save", not "Saved" -- the button is an action, the pill is a state.
const STATUS_LABELS: Record<UserJobStatus, string> = {
  saved: "Saved",
  resume_optimized: "Resume optimized",
  applied: "Applied",
  dismissed: "Dismissed",
};

// Button labels (present-tense action verbs) -- ticket bed37bd, Nicole:
// "Save", "Optimize Resume", "Apply", "Dismiss".
const ACTION_LABELS: Record<UserJobStatus, string> = {
  saved: "Save",
  resume_optimized: "Optimize Resume",
  applied: "Apply",
  dismissed: "Dismiss",
};

// Ticket 3d80a85: "saved"/"resume_optimized"/"dismissed" render as plain
// buttons (pure state changes). "applied" is handled separately below --
// it's a real link to the posting AND a state change together, not just
// a button.
const BUTTON_ACTIONS: UserJobStatus[] = ["saved", "resume_optimized", "dismissed"];

/**
 * One job in the curated list. Status buttons call the caller's
 * `onSetStatus` (wired to `POST /jobs/:id/status` in App.tsx) and rely on
 * the caller to refresh the results list afterward — a "dismissed" write in
 * particular must make this card disappear from the default view (ticket
 * 484889d decision #2), which only the results refetch (not local state
 * here) can actually do, since the default view's dismissed-exclusion is
 * server-side (routes/resumes.ts).
 */
export function ResultCard({
  result,
  onSetStatus,
}: {
  result: ScoredJobResult;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<UserJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSetStatus(status: UserJobStatus) {
    setPending(status);
    setError(null);
    try {
      await onSetStatus(result.jobId, status);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  return (
    <li className="result-card">
      <div className="result-card-header">
        <span className="result-score" aria-label="Match score">
          {result.matchScore}%
        </span>
        <div className="result-title-block">
          <h3 className="result-title">{result.title}</h3>
          {/* Ticket 3d80a85: explicit "Label: value" pairs -- the old bare
              bullet-separated list ("Acme · greenhouse · Seattle, WA ·
              onsite") didn't say which value was which. */}
          <p className="result-meta">
            Company: {result.company}
            {" · "}
            Data source: {result.dataSource}
            {result.location && <> · Location: {result.location}</>}
            {result.locationType && <> · Work arrangement: {result.locationType}</>}
          </p>
        </div>
        {result.status && (
          <span className="result-current-status">{STATUS_LABELS[result.status]}</span>
        )}
      </div>

      <button type="button" className="link-button" onClick={() => setExpanded((e) => !e)}>
        {expanded ? "Hide details" : "Why this match?"}
      </button>

      {expanded && (
        <div className="result-details">
          <p>{result.rationale}</p>
          {result.strengths.length > 0 && (
            <div>
              <strong>Strengths</strong>
              <ul>
                {result.strengths.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {result.gaps.length > 0 && (
            <div>
              <strong>Gaps</strong>
              <ul>
                {result.gaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="result-actions">
        {/* Ticket 3d80a85: "Apply" IS the link to the real posting now --
            Nicole: "apply should be a link to apply for the job... That
            should have come through in the job description, or in the
            job from the data source." Absorbs the old separate "Open
            posting" link rather than duplicating it. Clicking it opens
            the real posting (a normal link navigation, never blocked)
            AND records status=applied -- both happen from the one click,
            matching her framing that clicking Apply means "I'm going to
            apply." The status write is fire-and-forget from the link's
            own click handler: a failure to RECORD the status must not
            stop the real-world navigation the user's browser has already
            started (the `error` state below still surfaces it). */}
        {/* Deliberately NOT aria-disabled/blocked once already applied --
            the link stays genuinely navigable (re-opening a posting you
            already applied to is a normal, useful thing to do); only the
            STATUS WRITE is skipped on a repeat click, to avoid a
            redundant PATCH, not the navigation itself. */}
        <a
          href={result.applyUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            if (result.status !== "applied") void handleSetStatus("applied");
          }}
        >
          {pending === "applied" ? "Applying..." : ACTION_LABELS.applied}
        </a>
        {BUTTON_ACTIONS.map((status) => (
          <button
            key={status}
            type="button"
            disabled={pending !== null || result.status === status}
            onClick={() => void handleSetStatus(status)}
          >
            {pending === status ? "Saving..." : ACTION_LABELS[status]}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="result-error">
          Could not update status: {error}
        </p>
      )}
    </li>
  );
}
