import { useState } from "react";
import type { ResumeSummary } from "@app/shared";
import { getResume } from "../api/client";

type ResumeTextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; resumeText: string };

/**
 * One row of the "My Resumes" tab (ticket 303cff0). A native `<details>`
 * so expand/collapse needs no state of its own beyond the fetch itself --
 * `onToggle` fires on both open AND close, so it's guarded to fetch only
 * on the open transition, and to skip re-fetching once a fetch is already
 * in flight or has already succeeded (`loading`/`ready`):
 * re-collapsing and re-expanding the same row re-shows the already-fetched
 * text instead of re-fetching it.
 *
 * Opus review (ticket 303cff0, required fix): the FIRST version of this
 * guard excluded every non-`idle` status, including `error` -- a single
 * transient failure (API restart, dropped connection) permanently latched
 * that row's text as unrecoverable for the rest of the session, with no
 * retry path (collapsing and re-expanding did nothing; `refreshResumesList`
 * doesn't touch this per-row state either, since rows stay mounted across
 * a resumes-list refresh, keyed by `resume.id`). Excluding only
 * `loading`/`ready` (not `error`) makes the next expand after a failure
 * retry the fetch, same as if it had never been attempted.
 */
function ResumeRow({ resume }: { resume: ResumeSummary }) {
  const [textState, setTextState] = useState<ResumeTextState>({ status: "idle" });

  return (
    <li className="resume-list-item">
      <details
        onToggle={(e) => {
          if (!e.currentTarget.open) return;
          if (textState.status === "loading" || textState.status === "ready") return;
          setTextState({ status: "loading" });
          getResume(resume.id)
            .then((data) => setTextState({ status: "ready", resumeText: data.resumeText }))
            .catch((err: unknown) => {
              setTextState({
                status: "error",
                message: err instanceof Error ? err.message : String(err),
              });
            });
        }}
      >
        <summary>
          <span className="resume-nickname">{resume.resumeNickname}</span>
          <span className="resume-created-at">
            Saved {new Date(resume.createdAt).toLocaleDateString()}
          </span>
        </summary>
        {textState.status === "loading" && <p>Loading resume text...</p>}
        {textState.status === "error" && (
          <p role="alert">Could not load resume text: {textState.message}</p>
        )}
        {textState.status === "ready" && <pre className="resume-text">{textState.resumeText}</pre>}
      </details>
    </li>
  );
}

/**
 * "My Resumes" tab (ticket 303cff0) -- Nicole, live: "there are multiple
 * resumes going on, at least for me... I think it's reasonable that if a
 * user's got a resume on here, they should be able to at least view it."
 *
 * View-only, deliberately: no rename, no delete, no "search again with
 * this" link from here. The ticket's own Scope excludes all three --
 * Nicole hasn't decided how she wants resume management to work yet
 * ("I haven't determined how I'm going to further manage them"), so this
 * makes the existing data visible without foreclosing any of that.
 */
export function MyResumes({ resumes }: { resumes: ResumeSummary[] }) {
  if (resumes.length === 0) {
    return <p>No resumes saved yet.</p>;
  }

  return (
    <ul className="resume-list">
      {resumes.map((resume) => (
        <ResumeRow key={resume.id} resume={resume} />
      ))}
    </ul>
  );
}
