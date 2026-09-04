import { useState } from "react";
import type { ScoredJobResult, UserJobStatus } from "@app/shared";
import { createHandoff, handoffFetchUrl, RESUME_OPTIMIZER_APP_URL } from "../api/client";

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

// Ticket 3d80a85/dbfd594: "saved"/"dismissed" render as plain buttons
// (pure state changes). "applied" and "resume_optimized" are both handled
// separately below -- each is a real navigation (to the posting, or to
// Nicole's resume-tailoring app) AND a state change together, not just a
// button.
const BUTTON_ACTIONS: UserJobStatus[] = ["saved", "dismissed"];

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
  resumeId,
  onSetStatus,
}: {
  result: ScoredJobResult;
  /** Needed for "Optimize Resume" (ticket dbfd594): `POST /handoffs`
   * snapshots THIS resume's text alongside the job description. Always
   * defined in practice — a ResultCard only ever renders once a resume
   * exists (App.tsx gates the whole results section behind `resumeId &&`)
   * — required, not optional, so that invariant is visible in the type. */
  resumeId: string;
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

  // Ticket dbfd594: unlike Apply, the target URL isn't known up front --
  // it depends on a real handoff being minted first (POST /handoffs), so
  // this can't be a plain `<a href>` the way Apply is. `window.open`
  // (rather than `location.href`) keeps the click's semantics the same as
  // Apply's `target="_blank"`: this app's own tab stays put, the other
  // app opens alongside it.
  async function handleOptimizeResume() {
    setPending("resume_optimized");
    setError(null);
    try {
      const handoff = await createHandoff(result.jobId, resumeId);
      const importUrl = `${RESUME_OPTIMIZER_APP_URL}?import=${encodeURIComponent(
        handoffFetchUrl(handoff.id),
      )}`;
      window.open(importUrl, "_blank", "noreferrer");
      if (result.status !== "resume_optimized") {
        await onSetStatus(result.jobId, "resume_optimized");
      }
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
        {/* Ticket dbfd594: opens Nicole's separate resume-tailoring app
            with this job's description + resume text handed over via a
            short-lived server-side handoff (see handleOptimizeResume
            above and apps/api/src/routes/handoffs.ts's own doc comment
            for why it can't just be a link with the payload inlined).
            Same precedent as Apply above: NOT disabled once already
            `resume_optimized` -- re-opening the tailoring app again
            (e.g. against an updated base resume) is a normal, useful
            thing to do, not a mistake to block. */}
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => void handleOptimizeResume()}
        >
          {pending === "resume_optimized" ? "Opening..." : ACTION_LABELS.resume_optimized}
        </button>
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
