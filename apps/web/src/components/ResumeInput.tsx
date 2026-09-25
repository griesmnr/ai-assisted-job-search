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
 *
 * Ticket 88f11d7 (Nicole: "once that has happened [a real search], then
 * a user can't change the text on the resume anymore... if they hit
 * change, I want them to have the option somehow of... toggle buttons.
 * One toggle button says like Use an old resume, and then there's a
 * list of their resumes underneath there... and then there's like
 * something that says Or, and then it says Paste a new resume"). Once
 * `isLocked` is true, the collapsed bar's button becomes "Change"
 * instead of "Edit" and, instead of reopening the paste form directly,
 * opens a THIRD branch: the picker (`changingResume`) -- one button per
 * existing saved resume (`resumes`) plus "Paste a new resume", which is
 * the only path back into the ordinary expanded form for a locked
 * resume. Picking an existing resume fires `onActivateResume` -- a pure
 * client-side "pick, not paste" (Nicole: "already exists in full, use
 * resume 8... it just needs to say the active resume is now 8"), never
 * `onSubmit`/`POST /resumes` -- so it can never trip the ticket
 * 7701534 duplicate-text guardrail (that check only fires on a real
 * POST body). An UNLOCKED resume's "Edit" is completely unchanged:
 * still goes straight to the expanded form, no picker involved.
 *
 * `searching` (Nicole: "I don't think that we should allow a change of
 * resume while a search is in progress"): disables the collapsed bar's
 * action button UNCONDITIONALLY while true -- "Edit" exactly as much as
 * "Change". Review fix (F1, ticket 88f11d7): an earlier version of this
 * gated `searching` behind `isLocked` on the theory that `isLocked`
 * always flips true before a real search actually starts polling — false
 * in practice, since `isLocked` only updates once SearchFlow's
 * `onRealSearchStarted` callback fires (the searchId is adopted into the
 * `"running"` phase), which is strictly AFTER `onRunningChange` already
 * reported `searching = true` for the `"starting"` window (the `POST
 * /searches` request itself in flight). Gating on `searching` alone,
 * with no `isLocked` condition, closes that window for BOTH an
 * already-locked resume and one this very run is about to lock.
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
  isLocked,
  changingResume,
  onChangeResume,
  onCancelChange,
  onStartPasteNew,
  onActivateResume,
  resumes,
  activating,
  activateError,
  searching,
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
  /** Ticket 88f11d7: `GetResumeResponse.isLocked`/`CreateResumeResponse.
   * isLocked`, carried straight through from App.tsx's own state -- picks
   * which word the collapsed bar's button shows ("Change" vs "Edit") and
   * which callback a click fires. `undefined`/falsy behaves exactly like
   * the pre-ticket "Edit" behavior, so every existing caller/test that
   * doesn't pass this keeps working unchanged. */
  isLocked?: boolean;
  /** Ticket 88f11d7: true between a "Change" click and either activating
   * an existing resume, choosing "Paste a new resume", or Cancel -- picks
   * the THIRD branch (the picker) below. Deliberately separate from
   * `editingResume`, same reasoning as that prop's own separation from
   * `resumeId` (see this file's top-of-file doc comment): App.tsx needs
   * to tell "showing the picker" apart from "showing the paste form"
   * without conflating either with "a resume exists". */
  changingResume?: boolean;
  /** Fires on a "Change" click (the locked collapsed bar) -- App.tsx sets
   * `changingResume` true. Mirrors `onEditResume` for the unlocked case. */
  onChangeResume?: () => void;
  /** Fires on the picker's "Cancel" -- App.tsx sets `changingResume` back
   * to false without touching the active resume. */
  onCancelChange?: () => void;
  /** Fires on the picker's "Paste a new resume" -- App.tsx closes the
   * picker and opens the ordinary expanded form (`editingResume = true`),
   * same form an unlocked "Edit" already opens. */
  onStartPasteNew?: () => void;
  /** Fires with an existing resume's id when its picker button is
   * clicked -- App.tsx's `handleActivateResume` fetches it via `GET
   * /resumes/:id` and adopts it directly. Deliberately NOT `onSubmit`:
   * this is a pick of an already-complete record, never a paste (Nicole:
   * "it just needs to say the active resume is now 8... it's a pick, not
   * a paste"), so it can never trip the ticket 7701534 duplicate-text
   * guardrail, which only fires on a real `POST /resumes` body. */
  onActivateResume?: (resumeId: string) => void;
  /** Every other saved resume, for the picker's toggle buttons (ticket
   * 303cff0's `ResumeSummary` shape -- id/nickname only, no text). The
   * currently-active resume is filtered out of this list below (picking
   * "Use Resume 16" while already using Resume 16 has nothing to do).
   * Defaults to `[]` so every existing caller/test that doesn't pass this
   * keeps working unchanged. */
  resumes?: { id: string; resumeNickname: string }[];
  /** True while `onActivateResume`'s `GET /resumes/:id` is in flight --
   * disables the picker's buttons rather than letting a second click race
   * the first. */
  activating?: boolean;
  activateError?: string | null;
  /** Ticket 88f11d7 (Nicole: "I don't think that we should allow a
   * change of resume while a search is in progress"): disables the
   * collapsed bar's action button UNCONDITIONALLY while true -- "Edit"
   * exactly as much as "Change" (review fix F1: an earlier version of
   * this exempted an unlocked "Edit" from the gate, which left a real
   * window open — see this file's top-of-file doc comment for the full
   * story). */
  searching?: boolean;
}) {
  const [text, setText] = useState(initialText);

  // Ticket 88f11d7: the picker branch -- takes priority over the
  // collapsed bar below when `changingResume` is set (only reachable via
  // a "Change" click, which only exists once `isLocked` is true).
  if (resumeId !== undefined && changingResume) {
    // Ticket 336f1e6 (Nicole, dogfooding 88f11d7's shipped picker: "the
    // numbers are seriously hopping around weirdly"): `resumes` arrives
    // in `ListResumesResponse`'s own order (oldest-created first, per
    // that type's doc comment) -- NOT alphanumeric. A plain
    // `.localeCompare` would still sort "Resume 10" before "Resume 2"
    // (lexicographic), so `numeric: true` is required, not optional --
    // that's what actually stops the numbers reordering unexpectedly.
    const otherResumes = (resumes ?? [])
      .filter((r) => r.id !== resumeId)
      .sort((a, b) =>
        a.resumeNickname.localeCompare(b.resumeNickname, undefined, { numeric: true }),
      );
    return (
      <div className="resume-input resume-picker">
        {/* Ticket 336f1e6 (Nicole: "the or and Paste a new resume button
            really clear that up"): the heading used to spell out both
            options ("...or paste a new one:"); the "Or" divider and the
            "Paste a new resume" button below already say that, so
            repeating it here was redundant. */}
        <p className="resume-picker-heading">Use an old resume:</p>
        {otherResumes.length > 0 && (
          <div className="resume-picker-options">
            {otherResumes.map((r) => (
              <button
                key={r.id}
                type="button"
                className="resume-picker-option"
                disabled={activating}
                onClick={() => onActivateResume?.(r.id)}
              >
                Use {r.resumeNickname}
              </button>
            ))}
          </div>
        )}
        {otherResumes.length > 0 && <p className="resume-picker-or">Or</p>}
        <div className="resume-input-actions">
          {/* Review fix (F2, ticket 88f11d7): NOT disabled by `activating`,
              unlike the "Use Resume N" buttons above -- this is a way to
              ABANDON a pending activation (same as "Cancel" below, which
              was already left enabled for exactly this reason), not a
              competing one. App.tsx's `handleStartPasteNew` invalidates
              the in-flight `getResume` the same way `handleCancelChange`
              does, so a click here is always safe regardless of what's
              still in flight. */}
          <button
            type="button"
            className="resume-picker-paste-new"
            onClick={() => onStartPasteNew?.()}
          >
            Paste a new resume
          </button>
          <button
            type="button"
            className="resume-cancel-edit-button"
            onClick={() => onCancelChange?.()}
          >
            Cancel
          </button>
        </div>
        {activateError && (
          <p role="alert" className="resume-error">
            Could not load that resume: {activateError}
          </p>
        )}
      </div>
    );
  }

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
            aria-label keeps the visible text short ("Edit"/"Change")
            while still telling a screen reader what it acts on. */}
        <button
          type="button"
          className="resume-edit-button"
          aria-label={isLocked ? "Change resume" : "Edit resume"}
          aria-describedby={searching ? "resume-change-note" : undefined}
          disabled={searching}
          onClick={() => (isLocked ? onChangeResume?.() : onEditResume?.())}
        >
          {isLocked ? "Change" : "Edit"}
        </button>
        {/* Review fix (F1, ticket 88f11d7): gated on `searching` alone,
            regardless of `isLocked` -- see this file's top-of-file doc
            comment for why an unlocked "Edit" needs this gate too now.
            `aria-describedby` above ties the disabled reason to the
            button itself for a screen-reader user, not just a sighted
            one. */}
        {searching && (
          <span id="resume-change-note" className="resume-change-note">
            Can't change resumes while a search is running.
          </span>
        )}
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
