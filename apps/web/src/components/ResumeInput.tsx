import { useState } from "react";
import { sortResumesByNickname } from "../resumeSort";

/**
 * Paste-only resume input (decided 2026-08-29 on git-bug a217859 — no file
 * upload; see `POST /resumes`'s actual accepted shape,
 * apps/api/src/routes/resumes.ts, which takes raw `resumeText`, nothing
 * else).
 *
 * Ticket 6ba221e: `onSubmit` no longer always means "create a resume".
 * `App.tsx`'s `handleResumeSubmit` routes a submit for an already-active,
 * unlocked resume to `PUT /resumes/:id/text` (an in-place text edit,
 * keeping the id and the nickname) and only a first-ever paste — or the
 * locked picker's explicit "Paste a new resume" — to `POST /resumes`. See
 * that function for the branch. As of d7d3d59 `resumeLocked` is no longer
 * the whole story: a `pastingNewResume` flag names the picker's intent
 * directly, and `resumeLocked` decides edit-vs-create on the ordinary
 * paths.
 * This component is unchanged by that and deliberately knows nothing about
 * it: it collects text and hands it up.
 *
 * Re-submitting unchanged text stays cheap and idempotent either way (the
 * PUT short-circuits a no-change save; the POST finds the existing row by
 * hash), so this component still doesn't need to guard against accidental
 * double-submission for correctness, only for UX. Ticket 7701534's
 * duplicate-text 409 — text matching a DIFFERENT already-saved resume
 * being rejected outright — is GONE as of 6ba221e: two resumes with
 * identical text are legal now (Nicole: "Let them do that... that's their
 * business"), so there is no such `resumeError` to render any more.
 *
 * Ticket 38a7598 (Nicole: "right next to the 'use this resume' button...
 * when they use this resume, they should be at that moment... choosing the
 * resume nickname"): the nickname field lives in THIS form, next to the
 * submit button, not a separate settings screen.
 *
 * Ticket 5a79aa4 (Nicole, live dogfooding right after 38a7598 shipped:
 * "let's hide the resume nickname and the attempted helper text until
 * they use the resume... let's hide even the submit [button]
 * also"): both controls were ABSENT, not disabled-with-explanation, until
 * they were actually actionable -- "Submit" only once there was real
 * text to submit, the nickname field only once a real resumeId (and with
 * it, the server's real default nickname) existed to attach a rename to.
 * No placeholder text explaining an ordering the user couldn't act on yet;
 * the controls simply weren't there before their moment arrived.
 *
 * Ticket cdc2c39 (Nicole, live dogfooding again, after actually using
 * 5a79aa4's shipped ordering -- "I don't need anything below anything...
 * they can all show up together, but they're just showing up in a
 * different order, and use this resume should be last, horizontally"):
 * pure horizontal reorder, same gating as 5a79aa4 above, unchanged --
 * the nickname field rendered BEFORE the button (once both were showing,
 * which only ever happened after a first successful submission, since
 * that's what made `resumeId` exist). That ticket ALSO made the textarea
 * read-only once `resumeId` existed, so the submitted text stayed visible
 * as a reference but couldn't be edited into a silent identity change:
 * resumes were content-addressed by their text, so editing the box
 * post-submission would, on the next submit, look like an entirely
 * different resume rather than an update to this one.
 *
 * TICKET 3db5b35 (2026-10-07) REVERSES THE NICKNAME-VISIBILITY HALF OF
 * 5a79aa4/cdc2c39 ABOVE -- recorded here, not silently, because leaving
 * the paragraphs above as the only explanation would read as still-current
 * design. Jay's user feedback, relayed by Nicole: "I'm confident now that
 * at all stages, I want users to be able to see the field where the
 * nickname is pasted, put in whatever your suggestion is, but then let
 * them edit it even before saving it." Nicole, on being reminded she'd
 * said the opposite in 5a79aa4: "I heard you say before that I said it the
 * other way before, but I can't really fathom why now. So I'm happy
 * moving forward with it." The nickname field in the form branch below is
 * now UNCONDITIONAL -- it renders before `resumeId` exists too, pre-filled
 * with a client-side best-effort suggestion (App.tsx's `handleResumeSubmit`
 * comment has the full argument for why that's a suggestion, not the real
 * server default, and why that's an accepted tradeoff rather than a new
 * endpoint). 5a79aa4's OTHER half -- hiding "Submit" itself until there's
 * real text -- is UNCHANGED; Jay's feedback was about the nickname
 * specifically. cdc2c39's ordering and read-only-textarea decisions are
 * also unaffected (the read-only half is itself long superseded, below).
 *
 * BOTH HALVES OF THAT ARE NOW HISTORY, and this comment is kept only so
 * the removals read as decisions. Ticket ac141d0 replaced the read-only
 * lock with the collapse/expand design below (the textarea in the
 * expanded form has been plainly editable since), and ticket 6ba221e
 * removed the PREMISE: a resume is identified by its id, not its text, so
 * an edited box is no longer a different resume -- `handleResumeSubmit`
 * saves it onto the same row. There is nothing left here to guard.
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
 * the expand/collapse. `resumeId` only ever changes on the NEXT
 * successful submit -- and as of ticket 6ba221e an unlocked resume's
 * submit does not change it at all, since it UPDATEs that same row
 * (`updateResumeText`) rather than creating one.
 * `handleResumeSubmit` (App.tsx) is what clears `editingResume` again
 * on success, not this component's click handler -- the edit isn't
 * "done" until a submission lands.
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
 * `onSubmit`/`POST /resumes`. (That also kept it clear of ticket
 * 7701534's duplicate-text guardrail, which only ever fired on a real
 * POST body -- moot since ticket 6ba221e deleted the guardrail, but the
 * "pick, not paste" shape stands on its own: there is nothing to submit.)
 * An UNLOCKED resume's "Edit" is completely unchanged: still goes
 * straight to the expanded form, no picker involved -- though as of
 * 6ba221e its Submit saves ONTO that resume instead of creating a new
 * one (App.tsx's `handleResumeSubmit`), which is also why the LOCKED
 * path's "Paste a new resume" has to stay a POST: see that function.
 * (d7d3d59: that POST is now driven by `pastingNewResume` as well as
 * `resumeLocked`, which are redundant there and deliberately so.)
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
  pastingNewResume,
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
   * (POST /resumes resolved) this session/reload.
   *
   * Ticket 5a79aa4 USED TO gate whether the nickname field rendered at all
   * on this being defined — "there's nothing to attach a rename to before a
   * real resumeId exists." Ticket 3db5b35 (2026-10-07) REVERSES that: Jay's
   * feedback, relayed by Nicole, was that people want to name the thing as
   * they create it, not only after -- "I'm confident now that at all
   * stages, I want users to be able to see the field... put in whatever
   * your suggestion is, but then let them edit it even before saving it."
   * The nickname field in the form below no longer reads this prop at all
   * (see that render branch) -- it is unconditional now. `resumeId` still
   * decides which of the THREE top-level branches renders (picker,
   * collapsed bar, or this form), which is unrelated to the nickname
   * field's own visibility within the form branch. */
  resumeId?: string;
  /**
   * The resume's current (or, before a first save, SUGGESTED) nickname —
   * genuinely CONTROLLED, unlike `text` above.
   *
   * Ticket 38a7598's original reasoning doesn't hold any more: this used to
   * say the real value "doesn't exist until the server assigns a default
   * (`CreateResumeResponse.resumeNickname`)," which landed well after this
   * component's first render, so a "seed once" `initialText`-style pattern
   * couldn't work. Ticket 3db5b35 (2026-10-07) needs a value to show BEFORE
   * that response ever exists, and the chosen answer is NOT a new endpoint
   * (see App.tsx's `handleResumeSubmit` and its own comment for the full
   * argument): App.tsx derives a client-side best-effort guess ("Resume
   * N", from the already-loaded saved-resumes list) and pushes it in here
   * the same way it pushes in the real post-save default -- this component
   * still doesn't know or care which kind of value it's holding, typed-
   * over suggestion or server-confirmed fact; it stays "controlled," full
   * stop.
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
   * same form an unlocked "Edit" already opens. The two look identical
   * here but save DIFFERENTLY as of ticket 6ba221e (new resume vs. edit
   * in place); `handleResumeSubmit` tells them apart by `resumeLocked`
   * AND, since d7d3d59, by `pastingNewResume` -- which this callback is
   * what sets. Only a locked resume has a picker to reach this from, so
   * the two agree today; the flag exists because three other readers in
   * App.tsx need the intent stated rather than inferred. */
  onStartPasteNew?: () => void;
  /** Fires with an existing resume's id when its picker button is
   * clicked -- App.tsx's `handleActivateResume` fetches it via `GET
   * /resumes/:id` and adopts it directly. Deliberately NOT `onSubmit`:
   * this is a pick of an already-complete record, never a paste (Nicole:
   * "it just needs to say the active resume is now 8... it's a pick, not
   * a paste"). It therefore writes nothing at all -- which is what keeps
   * it from being confusable with either save path, and which also kept
   * it clear of ticket 7701534's duplicate-text guardrail back when that
   * existed (deleted by ticket 6ba221e). */
  onActivateResume?: (resumeId: string) => void;
  /** Every other saved resume, for the picker's toggle buttons (ticket
   * 303cff0's `ResumeSummary` shape -- id/nickname only, no text). The
   * currently-active resume is filtered out of this list below (picking
   * "Use Resume 16" while already using Resume 16 has nothing to do) --
   * ticket 582ee40 extends that same filter to the ordinary form branch's
   * "Use a saved resume" list, now that it too can render with an active
   * resume; see that branch's own comment for the full active-row argument.
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
  /** Ticket 582ee40: App.tsx's own `pastingNewResume` -- "the form on
   * screen is composing a resume that does not exist yet" (see that
   * state's doc comment in App.tsx). The ordinary form branch below reads
   * this directly rather than re-deriving it, because it is the ONE signal
   * that tells apart the two routes that land on that branch WITH a
   * `resumeId` already set: an unlocked "Edit" (composing an UPDATE to the
   * active resume -- `pastingNewResume` false) versus the locked picker's
   * "Paste a new resume" (composing a resume that doesn't exist yet --
   * `pastingNewResume` true). Those two need opposite answers to "should
   * the saved-resume list reappear here" -- see the form branch's own
   * comment on `savedResumes` for why. `undefined` behaves like `false`
   * (the ordinary, no-active-resume case this prop didn't exist for
   * before), so every existing caller/test that doesn't pass this keeps
   * working unchanged. */
  pastingNewResume?: boolean;
}) {
  const [text, setText] = useState(initialText);

  // Ticket 88f11d7: the picker branch -- takes priority over the
  // collapsed bar below when `changingResume` is set (only reachable via
  // a "Change" click, which only exists once `isLocked` is true).
  if (resumeId !== undefined && changingResume) {
    // Ticket 336f1e6 (Nicole, dogfooding 88f11d7's shipped picker: "the
    // numbers are seriously hopping around weirdly"): `resumes` arrives
    // in `ListResumesResponse`'s own order (oldest-created first, per
    // that type's doc comment) -- NOT alphanumeric. `sortResumesByNickname`
    // (ticket 7da6904: extracted so MyResumes.tsx can sort the exact same
    // way) is what actually stops the numbers reordering unexpectedly --
    // see its own doc comment for why `numeric: true` specifically.
    const otherResumes = sortResumesByNickname((resumes ?? []).filter((r) => r.id !== resumeId));
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

  // Ticket e2b5f9c (Nicole, live, right after completing a magic-link
  // sign-in): "now I'm on the new job search page, and it just says paste
  // your resume. It doesn't offer me to choose an old resume."
  //
  // She was right, and the gap was total: the picker branch above requires
  // `resumeId !== undefined`, and it is only reachable from the collapsed
  // bar's "Change" button, which requires the same. `MyResumes` has no
  // activate affordance at all. So with NO active resume there was no path to
  // a SAVED one -- pasting text was the only way in, for someone whose
  // account already held several.
  //
  // The no-active-resume state is not an edge case: it is the GUARANTEED
  // state right after a magic-link sign-in, because `MagicLinkLanding` calls
  // `clearAppState()` when the adopted user id differs (correct -- a cached
  // `resumeId` names a row the adopted user does not own). So someone signing
  // in specifically to recover their work landed on a blank textarea with
  // their resumes unreachable. Ticket 5a7e957 built that whole way-back-in
  // flow; this was the step immediately after it, dead-ending.
  //
  // Rendered ABOVE the paste form rather than as a separate branch, and
  // deliberately NOT a copy of the picker above: there is nothing to "Cancel"
  // back to, and no need for a "Paste a new resume" button because the paste
  // form is right here. Reuses that branch's `sortResumesByNickname` (ticket
  // 336f1e6 -- see its own doc comment for why `numeric: true`), its classes,
  // and the same `onActivateResume`/`activating`/`activateError` wiring, so
  // there is one activation path, not two.
  //
  // TICKET 582ee40 WIDENS THE GATE. It used to be `resumeId === undefined`,
  // which was "the whole point" of e2b5f9c above and which a first draft of
  // THAT fix omitted -- caught by the existing App.resumeLock.test.tsx case
  // "'Paste a new resume' opens the ordinary expanded paste form". That gate
  // was also the dead end Nicole hit live, standing in the resume form,
  // pressing "Edit" on an active-but-UNLOCKED resume: this branch is exactly
  // where "Edit" lands, and with the old gate it showed the paste form with
  // no way to switch resumes at all -- ticket 11ead86 gave My Resumes its own
  // "Use {nickname}" action as A path off that dead end, but its own review
  // judged that acceptable as *a* path, not *the* path, because the click she
  // actually made was still a dead end. This ticket is the fix for that click.
  //
  // The gate is now `!pastingNewResume`, not `resumeId !== undefined`,
  // because `resumeId !== undefined` is reachable by TWO routes that need
  // OPPOSITE answers to "should the saved list show here" -- `pastingNewResume`
  // (App.tsx) is the one signal that already tells them apart (see that prop's
  // own doc comment above):
  //   - an unlocked "Edit" (`pastingNewResume` false) -- the fix this ticket
  //     exists for. The list must show.
  //   - the locked picker's "Paste a new resume" (`pastingNewResume` true) --
  //     e2b5f9c's own guard, UNCHANGED: the user just explicitly declined the
  //     saved list one click ago (on the picker branch above), and
  //     re-offering it here would contradict that choice. Still covered by
  //     the same App.resumeLock.test.tsx case cited above, which this ticket
  //     does not touch.
  // `resumeId === undefined` (the original, no-active-resume case) is folded
  // into the same condition for free: `pastingNewResume` can only ever be
  // `true` once a resume already exists to decline reusing (it is set from
  // the locked picker alone), so it is always falsy here, same as before.
  //
  // THE ACTIVE-ROW DISAGREEMENT, DECIDED. Once this list can render WITH an
  // active resume, it has the same question MyResumes.tsx answered for
  // itself (ticket 11ead86): does the active resume's own row appear.
  // MyResumes says yes, as a non-interactive "Active" marker, because it is a
  // browsable INVENTORY (ticket 303cff0's own framing) where every other
  // row-level action stays available on the active row too, and hiding it
  // would look like the resume vanished from its own inventory.
  //
  // This list is not an inventory. It has exactly one job -- offering a
  // DIFFERENT resume to switch to -- and that was already this file's own
  // answer before this ticket ever touched it: the `changingResume` picker
  // branch above excludes the active resume outright (`r.id !== resumeId`,
  // with the comment "picking 'Use Resume 16' while already using Resume 16
  // has nothing to do"). This list is the SAME kind of control reached from
  // the SAME component for the SAME reason (an unlocked "Edit" is the direct
  // counterpart of a locked "Change"), so it gets the SAME answer: EXCLUDE
  // the active resume, not an "Active" marker. Diverging from MyResumes here
  // is not an oversight needing reconciliation -- MyResumes and this list are
  // answering two different questions ("what exists" vs. "what else can I
  // switch to"), and a chooser that includes a dead "Active" entry among its
  // live "Use X" buttons would be the inconsistent choice, not this one.
  //
  // RE-PROVING THE MISSING `searching` GUARD, NOT JUST CARRYING IT FORWARD.
  // The ORIGINAL proof below (opus review of e2b5f9c) only covered
  // `resumeId === undefined`, which this gate is no longer limited to -- it
  // needs re-checking for the NEW route (an unlocked "Edit"), not inherited
  // for free. `searching` disables the collapsed bar's "Edit" button itself
  // (see that branch above), so this form cannot be ENTERED via "Edit" while
  // a search is running. And once entered, nothing in it can make
  // `searching` become true: the sources/criteria/search section -- the only
  // place a search is started -- is `hidden` (not merely inert) for as long
  // as `editingResume` is true (App.tsx), and this branch only renders while
  // exactly that is true. So `searching` is provably `false` for the entire
  // time this branch can be showing via "Edit", same conclusion as the
  // original proof, now covering both routes that reach this list.
  //
  // Original proof, for `resumeId === undefined` specifically, still holds
  // unchanged: `setResumeId` has exactly two call sites, both with real ids,
  // and `resumeId` is never cleared -- while `SearchFlow` is mounted only
  // inside `{resumeId && ...}`. So `searchRunning` cannot be true while
  // `resumeId === undefined` either.
  const savedResumes = sortResumesByNickname((resumes ?? []).filter((r) => r.id !== resumeId));

  return (
    <form
      className="resume-input"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim().length > 0) onSubmit(text);
      }}
    >
      {!pastingNewResume && savedResumes.length > 0 && (
        <div className="resume-pick-saved">
          <p className="resume-picker-heading">Use a saved resume:</p>
          {/* Opus review (D1): disabled by `submitting` too, not just
              `activating`. Before this block existed there were no buttons
              here while a paste was in flight, so the interleaving was
              impossible; now a click during an in-flight POST /resumes runs
              both handlers. The end state stays self-consistent, but a
              `createResume` that then FAILS sets `resumeError` AFTER
              `handleActivateResume` already cleared it -- rendering "Could
              not save resume" under a collapsed bar correctly reading "Using
              Resume 1". That is the stale-error class ac141d0 review round 2
              (N1) exists to prevent. (The concrete failure originally named
              here was ticket 7701534's duplicate-text 409, deleted by ticket
              6ba221e; the interleaving is unchanged for every other failure,
              e.g. a network error or the length-limit 400.) */}
          <div className="resume-picker-options">
            {savedResumes.map((r) => (
              <button
                key={r.id}
                type="button"
                className="resume-picker-option"
                disabled={activating || submitting}
                onClick={() => onActivateResume?.(r.id)}
              >
                Use {r.resumeNickname}
              </button>
            ))}
          </div>
          {activateError && (
            <p role="alert" className="resume-error">
              Could not load that resume: {activateError}
            </p>
          )}
          {/* Same "Or" divider the picker branch uses, for the same reason
              (ticket 336f1e6, Nicole: "the or and Paste a new resume button
              really clear that up") -- here it separates the saved list from
              the paste form below rather than from a button. */}
          <p className="resume-picker-or">Or paste a new one</p>
        </div>
      )}
      <label htmlFor="resume-text">Paste your resume</label>
      <textarea
        id="resume-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        placeholder="Paste resume text here..."
      />
      <div className="resume-input-actions">
        {/* Ticket 3db5b35 (reversing 5a79aa4): no longer gated on
            `resumeId !== undefined` -- Jay's feedback, relayed by Nicole,
            was that people want to name the thing as they create it, not
            only after. The field now renders in this branch unconditionally,
            pre-filled with App.tsx's best-effort pre-save suggestion (see
            `nickname`'s own doc comment below) and editable immediately,
            with nothing yet to attach a PATCH to -- `handleNicknameCommit`
            (App.tsx) still no-ops on blur while `resumeId` is undefined, so
            typing here before the first save is purely local state until
            `handleResumeSubmit` captures it at submit time.

            Ticket d7d3d59: that "purely local until submit" behavior now also
            covers the SECOND and later resumes of a session. This same branch
            is reached with a `resumeId` already set when the locked picker's
            "Paste a new resume" opens it, and the resume being named there
            does not exist yet either -- so App.tsx's `pastingNewResume` makes
            `handleNicknameCommit` no-op for that case too. Before that, a blur
            here PATCHed the PREVIOUS resume's id and silently renamed it. This
            component is unchanged by the fix and still knows nothing about
            which case it is in; it collects a nickname and hands it up. */}
        <div className="resume-nickname-field">
          <label htmlFor="resume-nickname">Resume Nickname</label>
          <input
            id="resume-nickname"
            type="text"
            value={nickname ?? ""}
            // Ticket 3db5b35 review finding (minor): also disabled while
            // `submitting` -- not just `nicknameSaving`. Before this, a
            // keystroke typed into this field WHILE the resume text POST
            // was still in flight was silently dropped: App.tsx's
            // `handleResumeSubmit` captures the field's value once, at
            // the moment it starts, and never re-reads it after the
            // await -- so anything typed in that window simply vanished
            // with no error and no visual sign anything was wrong.
            // Disabling the field for that same window turns "silently
            // dropped" into "visibly can't type yet," which is honest
            // rather than merely less bad.
            disabled={nicknameSaving || submitting}
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
            // nickname edit. That resubmission resolved to the SAME resume
            // id carrying its OLD nickname, silently overwriting whatever
            // was just typed with zero error or explanation. (Still true
            // after ticket 6ba221e, by a different route: the resubmit now
            // goes to `PUT /resumes/:id/text`, whose response carries the
            // row's stored `resumeNickname` -- which App.tsx pushes back
            // into state exactly as before.) `preventDefault` stops the
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
            {submitting ? "Saving..." : "Submit"}
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
