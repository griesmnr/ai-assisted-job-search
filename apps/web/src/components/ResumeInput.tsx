import { useState } from "react";

/**
 * Paste-only resume input (decided 2026-08-29 on git-bug a217859 — no file
 * upload; see `POST /resumes`'s actual accepted shape,
 * apps/api/src/routes/resumes.ts, which takes raw `resumeText`, nothing
 * else). Content-addressed server-side, so re-submitting identical text is
 * cheap and idempotent (returns the same resumeId) — this component doesn't
 * need to guard against double-submission for correctness, only for UX.
 *
 * Ticket 38a7598 (Nicole: "right next to the 'use this resume' button...
 * when they use this resume, they should be at that moment... choosing the
 * resume nickname"): the nickname field lives in THIS form, next to the
 * submit button, not a separate settings screen. It renders from the very
 * first paint (so it's visibly part of "using this resume", not a
 * follow-up step reached some other way), but only becomes editable once a
 * real resume id — and with it, the server's real default nickname — exists.
 * Before that, it shows a placeholder explaining the ordering rather than
 * accepting free text no `resumeId` exists yet to attach it to.
 */
export function ResumeInput({
  onSubmit,
  submitting,
  initialText = "",
  resumeId,
  nickname,
  onNicknameChange,
  onNicknameCommit,
  nicknameSaving,
  nicknameError,
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
  /** Ticket 38a7598: undefined until a resume has actually been created
   * (POST /resumes resolved) this session/reload — gates whether the
   * nickname field is editable at all, since there's nothing to attach a
   * rename to before then. */
  resumeId?: string;
  /**
   * The resume's current nickname — genuinely CONTROLLED, unlike `text`
   * above: its real value doesn't exist until the server assigns a default
   * (`CreateResumeResponse.resumeNickname`), which lands well after this
   * component's first render, so a "seed once" `initialText`-style pattern
   * can't work here — the caller (App.tsx) has to be able to push the real
   * default in once it arrives.
   */
  nickname?: string;
  /** Fires on every keystroke — updates the caller's local/persisted state
   * only, no network call (same "don't fire a request per character"
   * reasoning `session.ts`'s own comments apply to `resumeText`). */
  onNicknameChange?: (nickname: string) => void;
  /** Fires on blur — this is what actually persists the rename via
   * `PATCH /resumes/:id` (App.tsx). Separated from `onNicknameChange` so
   * typing stays purely local/instant and the network round-trip happens
   * once, when the user is done editing, not once per keystroke. */
  onNicknameCommit?: (nickname: string) => void;
  /** True while a rename PATCH is in flight (App.tsx) — disables the field
   * rather than letting a second edit race the first. */
  nicknameSaving?: boolean;
  nicknameError?: string | null;
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
      <div className="resume-input-actions">
        <button type="submit" disabled={submitting || text.trim().length === 0}>
          {submitting ? "Saving..." : "Use this resume"}
        </button>
        <div className="resume-nickname-field">
          <label htmlFor="resume-nickname">Resume Nickname</label>
          <input
            id="resume-nickname"
            type="text"
            value={nickname ?? ""}
            disabled={resumeId === undefined || nicknameSaving}
            placeholder={resumeId === undefined ? "Assigned once you use this resume" : undefined}
            onChange={(e) => onNicknameChange?.(e.target.value)}
            onBlur={(e) => onNicknameCommit?.(e.target.value)}
            // Ticket 38a7598 review fix: this input sits INSIDE the resume
            // <form> (which has its own submit button), so without this,
            // pressing Enter here triggered the form's implicit submit --
            // RESUBMITTING the resume text -- instead of committing the
            // nickname edit. Because `createResume` is content-addressed,
            // that resubmission returned the SAME resume id carrying its
            // OLD nickname, silently overwriting whatever was just typed
            // with zero error or explanation. `preventDefault` stops the
            // keypress from reaching the form's submit; committing
            // explicitly here (rather than just letting blur handle it)
            // means Enter behaves the same way a real "save" action would,
            // whether or not the field happens to lose focus afterward.
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onNicknameCommit?.(e.currentTarget.value);
              }
            }}
          />
          {nicknameSaving && <span className="resume-nickname-status">Saving...</span>}
        </div>
      </div>
      {nicknameError && (
        <p role="alert" className="resume-nickname-error">
          Could not save nickname: {nicknameError}
        </p>
      )}
    </form>
  );
}
