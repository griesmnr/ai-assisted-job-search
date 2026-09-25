import { useState } from "react";

/**
 * Paste-only resume input (decided 2026-08-29 on git-bug a217859 — no file
 * upload; see `POST /resumes`'s actual accepted shape,
 * apps/api/src/routes/resumes.ts, which takes raw `resumeText`, nothing
 * else). Content-addressed server-side, so re-submitting THIS SAME
 * resume's own unchanged text is cheap and idempotent (returns the same
 * resumeId) — this component doesn't need to guard against accidental
 * double-submission for correctness, only for UX. Ticket 7701534: text
 * that instead matches a DIFFERENT already-saved resume is no longer
 * silently accepted as if new — `App.tsx`'s `handleResumeSubmit` sends
 * along the currently-active `resumeId` specifically so the server can
 * tell those two cases apart, and surfaces the DIFFERENT-resume case as a
 * real, blocking `resumeError` this component just renders like any other.
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
 * a read-only lock (textarea stayed visible but uneditable once
 * `resumeId` existed) -- `resumeId` was never cleared anywhere in
 * App.tsx, so with no way back, the lock was a ONE-WAY DOOR. Round 2:
 * the fix attempt of clearing `resumeId` on an "Edit resume" click
 * collapsed the whole app (sources, criteria, results -- everything
 * gated on `resumeId !== undefined`) and wiped sessionStorage mid-edit,
 * reproducing ticket 3f05144 ("it was all clear again"). That shipped
 * as a lock-in-place-plus-always-visible-Edit-button design.
 *
 * Ticket ac141d0 (Nicole, immediately after using cdc2c39's shipped
 * lock-in-place: "instead of making everything not editable and
 * offering an Edit Resume button, which was a little bit of a
 * misunderstanding between the two of us... I think we should hide
 * that whole section, and a little thing should pop up that says
 * Using Resume 8... if they say Edit, it's gonna open again this
 * resume"): replaces the lock-in-place design with COLLAPSE/EXPAND.
 * Once a resume is confirmed (`resumeId` exists) and the user isn't
 * mid-edit, this component renders a compact summary bar instead of
 * the form at all -- not a disabled/readOnly form, a completely
 * different, smaller render. "Edit" swaps back to the full form.
 *
 * `editingResume` is what picks which branch renders, and -- same
 * lesson as cdc2c39's round 2 -- it is deliberately NOT `resumeId`
 * itself. `resumeId` stays set the whole time the user is editing, so
 * anything in App.tsx gated on `resumeId` (sessionStorage, the
 * nickname, an in-flight search's identity) stays intact; only
 * `editingResume` and whatever App.tsx separately chooses to gate on
 * it (the sources/criteria/search sections, per this ticket) react to
 * the expand/collapse. `resumeId` only actually changes on the NEXT
 * successful submit, via the same content-addressed `createResume`
 * call this component always made. `handleResumeSubmit` (App.tsx) is
 * what clears `editingResume` again on success, not this component's
 * click handler -- the edit isn't "done" until a submission lands.
 *
 * The collapsed summary bar's nickname is display-only (Nicole,
 * correcting an early draft of this ticket: "I don't want it
 * renameable right there in line... the only way they can get back to
 * an editable name should be in the collapse-expand") -- renaming only
 * happens through the expanded form's nickname field, same as it
 * always has.
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
  onCancelEdit,
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
  /** Ticket ac141d0: true between an "Edit" click on the collapsed
   * summary bar and the next successful submit. Deliberately separate
   * from `resumeId` -- see this file's top-of-file doc comment for why
   * conflating the two reproduced ticket 3f05144. This is what picks
   * which of the two branches below renders: the collapsed summary bar
   * (`resumeId !== undefined && !editingResume`) or the full form
   * (everything else, including the ordinary pre-first-submission
   * case). */
  editingResume?: boolean;
  /** Fires on an "Edit resume" click -- App.tsx sets `editingResume`
   * true. See that prop's doc comment for what this does and doesn't
   * touch. */
  onEditResume?: () => void;
  /** Review fix (ticket ac141d0): fires on "Cancel" in the expanded
   * form during a re-edit -- App.tsx sets `editingResume` back to
   * false WITHOUT submitting. Only rendered when `resumeId` already
   * exists (there's nothing to cancel back to before a first
   * submission). Exists because without it, clearing the textarea
   * while editing was a genuine dead end: no submit button (empty
   * text), no Edit button (only the collapsed branch has one), and --
   * since this ticket also hides sources/criteria/search while
   * editing -- no way out of the screen at all short of a reload. */
  onCancelEdit?: () => void;
}) {
  const [text, setText] = useState(initialText);

  // Ticket ac141d0: the whole reason this is a branch, not a readOnly
  // toggle -- the collapsed bar is a DIFFERENT, smaller render, not the
  // same form disabled. See this file's top-of-file doc comment.
  if (resumeId !== undefined && !editingResume) {
    return (
      <div className="resume-input resume-input-collapsed">
        <span className="resume-summary">Using {nickname}</span>
        {/* type="button": this sits outside the <form> entirely in this
            branch, but stays explicit anyway -- a future refactor that
            moved it back inside one (as cdc2c39's earlier "Edit resume"
            button briefly was) should not silently regain the implicit
            submit-on-click hazard that ticket's own review had to catch.
            aria-label keeps the visible text short ("Edit") while still
            telling a screen reader what it edits. */}
        <button
          type="button"
          className="resume-edit-button"
          aria-label="Edit resume"
          onClick={() => onEditResume?.()}
        >
          Edit
        </button>
      </div>
    );
  }

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
        {resumeId !== undefined && (
          <div className="resume-nickname-field">
            <label htmlFor="resume-nickname">Resume Nickname</label>
            <input
              id="resume-nickname"
              type="text"
              value={nickname ?? ""}
              disabled={nicknameSaving}
              // Ticket 7701534, Nicole: "it should highlight... red
              // outline on the field." `aria-invalid` is both the
              // standard accessible way to flag an invalid field (a
              // screen reader announces it) and, per index.css, what
              // actually drives the red outline -- one prop does both.
              aria-invalid={nicknameError ? true : undefined}
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
        {/* Review fix (ticket ac141d0): only during a RE-edit -- before a
            first submission there's no collapsed state to cancel back
            to, and the plain "clear the box" behavior that already
            existed is fine. Without this, clearing the textarea while
            editing was a dead end: no submit button (empty text), no
            Edit button (that only exists in the collapsed branch), and
            -- since this ticket also hides sources/criteria/search while
            editing -- no way off the screen at all short of a reload. */}
        {resumeId !== undefined && (
          <button
            type="button"
            className="resume-cancel-edit-button"
            onClick={() => {
              // Discards the in-progress edit, not just the empty-text
              // case -- resets the box back to what was actually last
              // submitted (`initialText`, which only ever changes on a
              // real successful submit, never on a keystroke) rather
              // than leaving a half-typed draft sitting there for the
              // next time this resume is opened for editing.
              setText(initialText);
              onCancelEdit?.();
            }}
          >
            Cancel
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
