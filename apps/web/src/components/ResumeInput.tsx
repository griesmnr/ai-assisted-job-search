import { useState } from "react";

/**
 * Paste-only resume input (decided 2026-08-29 on git-bug a217859 — no file
 * upload; see `POST /resumes`'s actual accepted shape,
 * apps/api/src/routes/resumes.ts, which takes raw `resumeText`, nothing
 * else). Content-addressed server-side, so re-submitting identical text is
 * cheap and idempotent (returns the same resumeId) — this component doesn't
 * need to guard against double-submission for correctness, only for UX.
 */
export function ResumeInput({
  onSubmit,
  submitting,
  initialText = "",
}: {
  onSubmit: (resumeText: string) => void;
  submitting: boolean;
  /**
   * What the box starts with (ticket 3f05144). Read ONCE, as the initial
   * value of this component's own state — deliberately not a controlled
   * `value`/`onChange` pair. The caller (App.tsx) only knows the text of
   * the resume that was actually SUBMITTED, so making this controlled
   * would either throw away every keystroke before the next submit or
   * force App to persist a draft on every character. "Seed the box after a
   * reload, then get out of the way" is the whole job.
   */
  initialText?: string;
}) {
  const [text, setText] = useState(initialText);

  return (
    <form
      className="resume-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length > 0) onSubmit(text);
      }}
    >
      <label htmlFor="resume-text">Paste your resume</label>
      <textarea
        id="resume-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder="Paste resume text here..."
      />
      <button type="submit" disabled={submitting || text.trim().length === 0}>
        {submitting ? "Saving..." : "Use this resume"}
      </button>
    </form>
  );
}
