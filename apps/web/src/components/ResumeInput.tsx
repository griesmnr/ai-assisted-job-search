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
 * submit button, not a separate settings screen.
 *
 * Ticket 5a79aa4 (Nicole, live dogfooding right after 38a7598 shipped:
 * "let's hide the resume nickname and the attempted helper text until
 * they use the resume... let's hide even the use this resume [button]
 * also"): both controls are ABSENT, not disabled-with-explanation, until
 * they're actually actionable -- "Use this resume" only once there's real
 * text to submit, the nickname field only once a real resumeId (and with
 * it, the server's real default nickname) exists to attach a rename to.
 * No placeholder text explaining an ordering the user can't act on yet;
 * the controls simply aren't there before their moment arrives.
 *
 * Ticket cdc2c39 (Nicole, live dogfooding again, after actually using
 * 5a79aa4's shipped ordering -- "I don't need anything below anything...
 * they can all show up together, but they're just showing up in a
 * different order, and use this resume should be last, horizontally"):
 * pure horizontal reorder, same gating as 5a79aa4 above, unchanged --
 * the nickname field renders BEFORE the button (once both are showing,
 * which only ever happens after a first successful submission, since
 * that's what makes `resumeId` exist). Also: the textarea becomes
 * read-only once `resumeId` exists, so the submitted text stays visible
 * as a reference but can't be edited into a silent identity change
 * (this app's resumes are content-addressed by resumeText -- editing
 * the box post-submission would, on the next submit, look like an
 * entirely different resume, not an update to this one).
 *
 * Adversarial review of cdc2c39 (opus), round 1: caught a real gap in
 * the read-only lock above -- `resumeId` was never cleared anywhere in
 * App.tsx, so with no way back, the lock was a ONE-WAY DOOR. First fix
 * attempt cleared `resumeId` on an "Edit resume" click; round 2 of
 * review caught that THAT collapses the whole app (sources, criteria,
 * results -- everything gated on `resumeId !== undefined`) and wipes
 * sessionStorage mid-edit, before any new resume exists to replace it --
 * reproducing ticket 3f05144 (Nicole: "it was all clear again") on every
 * Edit click plus a reload.
 *
 * The actual fix: `editingResume` is a SEPARATE flag from `resumeId`.
 * "I want to change what's in the box" and "I have switched resumes"
 * are different moments -- only the second should un-mount anything.
 * `resumeId` stays set the whole time the user is editing, so nothing
 * unmounts, sessionStorage keeps the last-submitted state, and an
 * in-flight search (SearchFlow.tsx) keeps polling underneath. The
 * textarea unlocks (`readOnly` below), the resume stays associated with
 * its current nickname, and `resumeId` only actually changes on the
 * NEXT successful submit -- the same content-addressed `createResume`
 * call this component always made, which returns the same id back for
 * unchanged text or a new one for changed text. That's also why
 * `handleResumeSubmit` (App.tsx) is what clears `editingResume` again,
 * not this click handler: the edit isn't "done" until a submission
 * actually lands.
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
  editingResume,
  onEditResume,
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
   * (POST /resumes resolved) this session/reload. Ticket 5a79aa4: gates
   * whether the nickname field RENDERS AT ALL, not just whether it's
   * editable — there's nothing to attach a rename to before a real
   * resumeId exists, so the field simply isn't shown yet. */
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
  /** Review fix round 2 (ticket cdc2c39): true between an "Edit resume"
   * click and the next successful submit. Deliberately separate from
   * `resumeId` -- see this file's top-of-file doc comment for why
   * conflating the two reproduced ticket 3f05144. Un-readonlys the
   * textarea without touching anything gated on `resumeId` itself (the
   * nickname field included -- it stays visible while editing, since
   * the resume being edited still has one). */
  editingResume?: boolean;
  /** Fires on an "Edit resume" click -- App.tsx sets `editingResume`
   * true. See that prop's doc comment for what this does and doesn't
   * touch. */
  onEditResume?: () => void;
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
        // Ticket cdc2c39: locked once a real resume exists, UNLESS the
        // user is actively editing it via "Edit resume" below -- see
        // this file's top-of-file doc comment for why `editingResume`
        // is a separate flag from `resumeId` rather than clearing it.
        readOnly={resumeId !== undefined && !editingResume}
        rows={10}
        placeholder="Paste resume text here..."
      />
      <div className="resume-input-actions">
        {resumeId !== undefined && (
          <div className="resume-nickname-field">
            <label htmlFor="resume-nickname">Resume Nickname</label>
            <input
              id="resume-nickname"
              type="text"
              value={nickname ?? ""}
              disabled={nicknameSaving}
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
        )}
        {resumeId !== undefined && !editingResume && (
          <button type="button" className="resume-edit-button" onClick={() => onEditResume?.()}>
            Edit resume
          </button>
        )}
        {text.trim().length > 0 && (
          <button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Use this resume"}
          </button>
        )}
      </div>
      {nicknameError && (
        <p role="alert" className="resume-nickname-error">
          Could not save nickname: {nicknameError}
        </p>
      )}
    </form>
  );
}
