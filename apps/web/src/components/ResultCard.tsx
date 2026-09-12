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

// Ticket 3d80a85 merged "Open posting" into "Apply" (Apply became the
// link). Dogfooding feedback (2026-09-08) reverted that: Nicole wants
// Apply back as a plain status button, with a SEPARATE real link to the
// posting -- "Open Job Page". So "saved"/"applied"/"dismissed" are all
// plain buttons now; only "resume_optimized" is handled separately below
// (a real navigation to Nicole's resume-tailoring app AND a state change
// together, unlike a bare status button).
const BUTTON_ACTIONS: UserJobStatus[] = ["saved", "applied", "dismissed"];

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
  onClearStatus,
}: {
  result: ScoredJobResult;
  /** Needed for "Optimize Resume" (ticket dbfd594): `POST /handoffs`
   * snapshots THIS resume's text alongside the job description. Always
   * defined in practice — a ResultCard only ever renders once a resume
   * exists (App.tsx gates the whole results section behind `resumeId &&`)
   * — required, not optional, so that invariant is visible in the type. */
  resumeId: string;
  onSetStatus: (jobId: string, status: UserJobStatus) => Promise<void>;
  /** "Untoggle" (dogfooding, 2026-09-08 — Nicole: "you should be able to
   * untoggle the buttons, like undismiss") — clears back to no-action-taken
   * rather than writing a new status value. */
  onClearStatus: (jobId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<UserJobStatus | "clearing" | null>(null);
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

  async function handleClearStatus() {
    setPending("clearing");
    setError(null);
    try {
      await onClearStatus(result.jobId);
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
  //
  // Ticket e367a63: this button is now a toggle like the others. If
  // `resume_optimized` is already the active status, clicking it undoes
  // that status ONLY -- no new handoff, no new tab (Nicole, dogfooding:
  // "if optimize resume or apply are highlighted and you want to undo
  // those, it should not launch the page again"). Re-running the
  // optimize flow against an updated resume still works exactly as
  // before, but only from the not-yet-optimized state.
  async function handleOptimizeResume() {
    if (result.status === "resume_optimized") {
      await handleClearStatus();
      return;
    }
    setPending("resume_optimized");
    setError(null);
    try {
      const handoff = await createHandoff(result.jobId, resumeId);
      const importUrl = `${RESUME_OPTIMIZER_APP_URL}?import=${encodeURIComponent(
        handoffFetchUrl(handoff.id),
      )}`;
      window.open(importUrl, "_blank", "noreferrer");
      await onSetStatus(result.jobId, "resume_optimized");
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
        {/* Ticket e367a63: the top-right Undo control is gone -- Nicole
            wants the status button itself to undo (see the toggle logic
            on BUTTON_ACTIONS and handleOptimizeResume below). This pill
            is now a plain, non-interactive state label; the buttons in
            the action row carry `aria-pressed` + a highlighted style as
            the indication of which one is active. */}
        {result.status && (
          <span className="result-current-status">{STATUS_LABELS[result.status]}</span>
        )}
        {/* Ticket b182bde: visible WITHOUT expanding the card -- before this,
            a leveling mismatch was buried two clicks deep in the gaps list.
            `null`/`"well_matched"` render nothing (an unjudged legacy row
            must never read as either qualified state). `aria-label` carries
            the same note text as `title`, which isn't reliably exposed to
            assistive tech.
            Ticket b182bde review (F3): a bare `<span>` has the ARIA
            `generic` role, on which `aria-label` isn't guaranteed to reach
            assistive tech. `role="note"` permits an accessible name and
            fits this element semantically (supplementary info alongside
            the job), without needing a visually-hidden-text utility class
            this stylesheet doesn't otherwise have. */}
        {result.levelFit === "overqualified" && (
          <span
            className="result-level-fit result-level-fit-over"
            role="note"
            title={result.levelFitNote ?? undefined}
            aria-label={
              result.levelFitNote ? `Above this level: ${result.levelFitNote}` : "Above this level"
            }
          >
            Above this level
          </span>
        )}
        {result.levelFit === "underqualified" && (
          <span
            className="result-level-fit result-level-fit-under"
            role="note"
            title={result.levelFitNote ?? undefined}
            aria-label={
              result.levelFitNote ? `Below this level: ${result.levelFitNote}` : "Below this level"
            }
          >
            Below this level
          </span>
        )}
      </div>

      <button type="button" className="link-button" onClick={() => setExpanded((e) => !e)}>
        {expanded ? "Hide details" : "Why this match?"}
      </button>

      {expanded && (
        <div className="result-details">
          <p>{result.rationale}</p>
          {/* Ticket b182bde: full levelFitNote, above Strengths -- only when
              there's real text to show (empty string for well_matched, null
              for an unjudged row, both render nothing here). */}
          {result.levelFitNote && (
            <div className="result-level-fit-note">
              <strong>Level fit</strong>
              <p>{result.levelFitNote}</p>
            </div>
          )}
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
        {/* Ticket dbfd594-followup (dogfooding, 2026-09-08): reverted
            ticket 3d80a85's merge of "Open posting" into "Apply" -- back
            to two separate elements, per Nicole: "make apply a button
            again... Open job page... have it be a link, and have it be
            separate than the Apply button." A pure navigation link, no
            status side effect at all -- "I looked at the posting" isn't
            the same fact as "I applied," and conflating them was the
            thing being undone here. */}
        <a href={result.applyUrl} target="_blank" rel="noreferrer">
          Open Job Page
        </a>
        {/* Ticket dbfd594: opens Nicole's separate resume-tailoring app
            with this job's description + resume text handed over via a
            short-lived server-side handoff (see handleOptimizeResume
            above and apps/api/src/routes/handoffs.ts's own doc comment
            for why it can't just be a link with the payload inlined).
            Ticket e367a63: this is now a toggle -- while NOT yet
            `resume_optimized`, clicking still re-opens the tailoring app
            (e.g. against an updated base resume) same as before; once it
            IS the active status, clicking it undoes instead of
            re-opening (handleOptimizeResume decides which). Never
            disabled on its own status so the undo path always works. */}
        <button
          type="button"
          className={
            result.status === "resume_optimized"
              ? "result-action result-action-active"
              : "result-action"
          }
          aria-pressed={result.status === "resume_optimized"}
          disabled={pending !== null}
          onClick={() => void handleOptimizeResume()}
        >
          {pending === "resume_optimized"
            ? "Opening..."
            : result.status === "resume_optimized" && pending === "clearing"
              ? "Undoing..."
              : ACTION_LABELS.resume_optimized}
        </button>
        {BUTTON_ACTIONS.map((status) => {
          const isActive = result.status === status;
          return (
            <button
              key={status}
              type="button"
              className={isActive ? "result-action result-action-active" : "result-action"}
              aria-pressed={isActive}
              disabled={pending !== null}
              onClick={() => void (isActive ? handleClearStatus() : handleSetStatus(status))}
            >
              {pending === status
                ? "Saving..."
                : isActive && pending === "clearing"
                  ? "Undoing..."
                  : ACTION_LABELS[status]}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="result-error">
          Could not update status: {error}
        </p>
      )}
    </li>
  );
}
