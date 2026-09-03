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
}: {
  onSubmit: (resumeText: string) => void;
  submitting: boolean;
}) {
  const [text, setText] = useState("");

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
