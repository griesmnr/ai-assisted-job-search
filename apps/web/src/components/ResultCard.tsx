import { useState } from "react";
import type { ScoredJobResult, UserJobStatus } from "@app/shared";

// State pill labels (past-tense/state form) -- shown once result.status is
// SET, describing what already happened. Distinct from ACTION_LABELS
// below (ticket bed37bd): a button that DOES the saving should read
// "Save", not "Saved" -- the button is an action, the pill is a state.
//
// `resume_optimized` stays here even though ticket 1bc4ea2 removed the
// button that could ever SET it: existing rows written before that
// removal still carry this status, and this is display of already-
// recorded state, not the action being removed -- GroupedResultsList's
// "Resume Optimized" section has the same reasoning.
const STATUS_LABELS: Record<UserJobStatus, string> = {
  saved: "Saved",
  resume_optimized: "Resume optimized",
  applied: "Applied",
  dismissed: "Dismissed",
};

// Button labels (present-tense action verbs) -- ticket bed37bd, Nicole:
// "Save", "Apply", "Dismiss". "Optimize Resume" removed by ticket 1bc4ea2
// (Nicole: match scores between this app and her separate resume-
// tailoring app diverge, and she doesn't want the two coupled right now)
// -- no button renders it, so no entry belongs here; STATUS_LABELS above
// still needs `resume_optimized` for the reason given there.
const ACTION_LABELS: Record<Exclude<UserJobStatus, "resume_optimized">, string> = {
  saved: "Save",
  applied: "Apply",
  dismissed: "Dismiss",
};

// Ticket 3d80a85 merged "Open posting" into "Apply" (Apply became the
// link). Dogfooding feedback (2026-09-08) reverted that: Nicole wants
// Apply back as a plain status button, with a SEPARATE real link to the
// posting -- "Open Job Page". Ticket 1bc4ea2 removed "Optimize Resume"
// (previously handled separately from this list, since it was a real
// navigation to a second app AND a state change together, unlike a bare
// status button) -- so all three remaining actions are plain buttons now.
const BUTTON_ACTIONS: Exclude<UserJobStatus, "resume_optimized">[] = [
  "saved",
  "applied",
  "dismissed",
];

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
  onClearStatus,
  onViewResume,
}: {
  result: ScoredJobResult;
  /**
   * Review fix, ticket 3f0883f: takes `resumeId` as a third argument now,
   * sourced below from `result.resumeId` -- NOT a caller-supplied prop the
   * way `resumeId` briefly was for the handoff call the now-removed
   * "Optimize Resume" button made (ticket 1bc4ea2 removed the button;
   * this comment's history is kept for context). Same bug, same fix: once a
   * card can belong to a DIFFERENT resume than whichever one is active
   * this session (or none at all), `user_job_statuses.resume_id` -- which
   * exists specifically to answer "which resume version did I apply
   * with" (schema.ts's own doc comment on that column) -- must record
   * the resume that actually produced THIS card, not session state.
   */
  onSetStatus: (jobId: string, status: UserJobStatus, resumeId: string) => Promise<void>;
  /** "Untoggle" (dogfooding, 2026-09-08 — Nicole: "you should be able to
   * untoggle the buttons, like undismiss") — clears back to no-action-taken
   * rather than writing a new status value. */
  onClearStatus: (jobId: string) => Promise<void>;
  /** Ticket 1e183a4: "Searched with: {nickname}" jumps to that resume in
   * My Resumes. Wired in App.tsx to switch tabs and set a focus target —
   * this component has no idea tabs exist, it just reports which resume
   * was clicked. */
  onViewResume: (resumeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<UserJobStatus | "clearing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSetStatus(status: UserJobStatus) {
    setPending(status);
    setError(null);
    try {
      await onSetStatus(result.jobId, status, result.resumeId);
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
          {/* Ticket 38a7598: Nicole -- "normalizing that all these searches
              are done against one resume is gonna be helpful for the
              user." A separate line from `result-meta` above (which is
              about the JOB), since this is a fact about the SEARCH.
              Review fix, same ticket: reads straight off `result` (each
              result now carries its OWN `resumeNickname`, joined
              server-side) rather than a prop threaded down from the
              caller -- see ScoredJobResult.resumeNickname's doc comment
              in @app/shared for why: the next ticket (3f0883f) makes it
              possible for two results in the SAME response to have been
              scored against two DIFFERENT resumes.

              Ticket 1e183a4, Nicole: "the resume 13 should now become a
              link to the My Resumes page with that resume highlighted
              and the text already expanded... super excited about that
              little connection." A `<button>` styled as a link, not a
              real `<a href>` -- there is nothing to navigate TO (no
              router, no URL for "My Resumes"), only in-app tab state to
              change (`onViewResume`, wired in App.tsx). */}
          <p className="result-searched-with">
            Searched with:{" "}
            <button
              type="button"
              className="result-resume-link"
              onClick={() => onViewResume(result.resumeId)}
            >
              {result.resumeNickname}
            </button>
          </p>
        </div>
        {/* Ticket e367a63: the top-right Undo control is gone -- Nicole
            wants the status button itself to undo (see the toggle logic
            on BUTTON_ACTIONS below). This pill
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
            this stylesheet doesn't otherwise have.
            Ticket 8c252ff: text changed from "Above/Below this level" to
            "Maybe overqualified"/"Maybe underqualified" -- Nicole, live:
            "it's not clear to me whether it's saying that I am above this
            level." The new wording matches the `levelFit` value names
            directly instead of requiring the reader to infer whose level
            "this level" refers to. */}
        {result.levelFit === "overqualified" && (
          <span
            className="result-level-fit result-level-fit-over"
            role="note"
            title={result.levelFitNote ?? undefined}
            aria-label={
              result.levelFitNote
                ? `Maybe overqualified: ${result.levelFitNote}`
                : "Maybe overqualified"
            }
          >
            Maybe overqualified
          </span>
        )}
        {result.levelFit === "underqualified" && (
          <span
            className="result-level-fit result-level-fit-under"
            role="note"
            title={result.levelFitNote ?? undefined}
            aria-label={
              result.levelFitNote
                ? `Maybe underqualified: ${result.levelFitNote}`
                : "Maybe underqualified"
            }
          >
            Maybe underqualified
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
        {/* Ticket 1bc4ea2: the "Optimize Resume" button (formerly here,
            ticket dbfd594) is removed -- Nicole decoupled this app from
            her separate resume-tailoring app "for now" (diverging match
            scores, an action here depending on a second app's uptime).
            A job whose status is ALREADY `resume_optimized` from before
            this removal still shows the state pill above
            (STATUS_LABELS) and still groups under GroupedResultsList's
            "Resume Optimized" section -- this only removes the ability
            to SET that status going forward, it does not touch already-
            recorded data. */}
        {BUTTON_ACTIONS.map((status) => {
          const isActive = result.status === status;
          return (
            <button
              key={status}
              type="button"
              className={isActive ? "result-action result-action-active" : "result-action"}
              aria-pressed={isActive}
              disabled={pending !== null}
              onClick={() => {
                if (isActive) {
                  void handleClearStatus();
                  return;
                }
                // Nicole, 2026-10-10, after John pressed "Apply" expecting
                // to land on the job posting and nothing visible happened:
                // "I'd like for the apply button to change the status and
                // open the job page." She named the duplication with the
                // "Open Job Page" link below and accepted it -- "sometimes
                // people just come back around to what's intuitive."
                //
                // This does NOT re-merge the two the way ticket 3d80a85 did
                // and dbfd594-followup undid. That merge made one control
                // mean both things, losing the distinction her own feedback
                // asked for ("'I looked at the posting' isn't the same fact
                // as 'I applied'"). Both controls still exist and still mean
                // what they meant: the link navigates with no status effect,
                // and Apply is now a superset -- status plus navigation.
                // Undoing an already-applied job deliberately does NOT
                // navigate (see the isActive early return above): un-marking
                // is not a reason to open a tab.
                //
                // THE ORDER HERE IS LOAD-BEARING. `window.open` must run
                // synchronously in this handler, BEFORE `handleSetStatus`'
                // first `await`. After an await the call is no longer inside
                // the browser's user-gesture window and the tab is blocked
                // as a popup -- silently, with no error and nothing for the
                // user to see, which is indistinguishable from the bug John
                // just reported. Opening first also reads better: the
                // posting appears immediately and the status catches up.
                if (status === "applied") {
                  window.open(result.applyUrl, "_blank", "noreferrer");
                }
                void handleSetStatus(status);
              }}
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
