import { useEffect, useRef, useState } from "react";
import type { ResumeSummary } from "@app/shared";
import { getResume, updateResumeNickname, updateResumeText } from "../api/client";
import { sortResumesByNickname } from "../resumeSort";

type ResumeTextState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; resumeText: string };

/**
 * Ticket 6ba221e: per-row edit state for the resume text.
 *
 * `"viewing"` is the pre-existing read-only `<pre>`. `"editing"` holds the
 * textarea's own draft -- deliberately local to this state, not pushed back
 * into `ResumeTextState` on every keystroke, so Cancel can restore the
 * saved text by simply dropping it. `"saving"` keeps the draft (a failed
 * save must not lose what the user typed) and carries it straight back into
 * `"editing"` with an error attached.
 */
type ResumeEditState =
  | { mode: "viewing" }
  | { mode: "editing"; draft: string; error?: string }
  | { mode: "saving"; draft: string };

/**
 * Ticket e7666de: per-row rename state for the resume's NICKNAME -- the
 * NAME half of Nicole's "edit both the names of the resumes and the
 * resumes themselves," where `ResumeEditState` above (ticket 6ba221e) is
 * the TEXT half. Same three-state shape and the same reasons: `"editing"`
 * holds a local draft so Cancel can drop it for free, and a failed save
 * lands back in `"editing"` with the draft intact plus an error, never
 * reverted -- there is nothing wrong with the typed value on a transient
 * network failure, and on a genuine collision (`PATCH /resumes/:id`'s
 * `409`) the offending value is exactly what the user needs to see and
 * fix in place. Unlike `handleNicknameCommit` (App.tsx), which auto-
 * commits on blur and therefore has to special-case a collision (keep the
 * value) against every other failure (revert it), this is an explicit
 * Save/Cancel form -- there is no blur-commit to distinguish from, so one
 * rule ("never revert, always show the error") covers every failure mode
 * without needing `isNicknameConflictError`/`apiErrorStatus` (App.tsx) to
 * tell them apart. Those helpers are module-private there anyway (already
 * duplicated once, into SearchFlow.tsx, rather than shared -- see
 * `apiErrorStatus`'s own comment there), and `request()` (api/client.ts)
 * already puts the server's exact `{ error }` text on `err.message` for
 * every failure shape (400 empty/too-long, 409 collision, network), so
 * this file's `err instanceof Error ? err.message : String(err)` (same
 * line `saveText` below already uses) surfaces the right message without
 * re-deriving it from the status code at all.
 */
type NicknameEditState =
  | { mode: "viewing" }
  | { mode: "editing"; draft: string; error?: string }
  | { mode: "saving"; draft: string };

/**
 * Ticket 1e183a4: which resume a result card's "Searched with:" link most
 * recently asked to jump to, plus a `token` that changes on every click
 * (even a repeat click on the SAME resume) -- App.tsx sets this straight
 * off `Date.now()`. The token exists because "My Resumes" stays mounted
 * at all times (see App.tsx's own `hidden`-not-unmounted comment), so a
 * SECOND click on the same card while already on that tab would otherwise
 * be indistinguishable from the first: `focusResume.id` alone wouldn't
 * change, so a `useEffect` keyed on it wouldn't re-fire, and the row
 * wouldn't re-scroll/re-flash. Keying on `token` instead makes every
 * click a fresh, visible event regardless of what was already open.
 */
export type FocusResume = { id: string; token: number };

/** How long the "just jumped here" highlight stays visible (ticket
 * 1e183a4) -- long enough to register as "that one, right there" against
 * a list of otherwise-identical rows, short enough that it reads as a
 * one-time pointer, not a persistent selection state. Not a measured
 * value; a round, deliberately generous number for a purely cosmetic
 * flash with no functional consequence either way. */
const FOCUS_HIGHLIGHT_MS = 2000;

/**
 * One row of the "My Resumes" tab (ticket 303cff0). A native `<details>`,
 * now CONTROLLED (`open` is React state, not left to the DOM) rather than
 * uncontrolled -- ticket 1e183a4 needs to open a specific row
 * programmatically (from a result card's "Searched with:" link, via
 * `focusResume` below), which an uncontrolled `<details>` has no API for.
 * `onToggle` still fires on both open AND close either way (a user's own
 * click included) and is what keeps `open` in sync with the real DOM state
 * -- this is the standard controlled-native-element pattern, not a new
 * one.
 *
 * Fetch-once-then-cache logic is unchanged from ticket 303cff0: guarded to
 * fetch only on the open transition, and to skip re-fetching once a fetch
 * is already in flight or has already succeeded (`loading`/`ready`).
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
function ResumeRow({
  resume,
  focusResume,
  onRenamed,
  isActive,
  onActivate,
  activating,
  searching,
}: {
  resume: ResumeSummary;
  focusResume?: FocusResume;
  /**
   * Ticket e7666de: fires after a rename actually lands on the server.
   * Wired by `MyResumes` to `App.tsx`'s `refreshResumesList` in the real
   * app -- this row's OWN display updates immediately off the PATCH
   * response (`displayNickname` below), but the `resumes` array this
   * component sorts (`sortResumesByNickname`, in `MyResumes` below) lives
   * one level up, in `App.tsx`'s `resumesListState`, and a rename that
   * changes sort position (e.g. "Resume 2" -> "Aardvark resume") needs
   * THAT array refetched to actually move. Optional, and a no-op if
   * omitted, so every existing test render site that doesn't care about
   * sort order keeps compiling unchanged.
   */
  onRenamed?: () => void;
  /**
   * Ticket 11ead86: true for the one row naming the session's CURRENTLY
   * active resume (`App.tsx`'s `resumeId`). See `MyResumes`'s own doc
   * comment for the full argument; this prop just carries the answer down
   * to the one row it affects.
   */
  isActive?: boolean;
  /**
   * Ticket 11ead86: fires with this row's id when its "Use {nickname}"
   * action is clicked -- wired by `MyResumes` straight through to
   * `App.tsx`'s existing `onActivateResume` (`handleActivateResume`), the
   * SAME pure `GET /resumes/:id` "pick, not paste" the search tab's own
   * locked picker already uses (ticket 88f11d7). This row does not fetch,
   * submit, or hold any activation state of its own -- `activating`/
   * `searching` below are the caller's state, read-only here.
   */
  onActivate?: (resumeId: string) => void;
  /** Ticket 11ead86: true while ANY row's activation is in flight (App.tsx's
   * `resumeActivating`) -- global, not per-row, the same as the picker's own
   * `disabled={activating}` on every one of its buttons: a second click on a
   * DIFFERENT row while one activation is already in flight would race it,
   * and there is nothing useful about letting two activations compete. */
  activating?: boolean;
  /** Ticket 11ead86 (acceptance criterion): the same `searching` guard the
   * collapsed bar's "Change"/"Edit" already respects (ticket 88f11d7,
   * Nicole: "I don't think that we should allow a change of resume while a
   * search is in progress") -- this is a SECOND way to reach the same
   * `onActivateResume`, reachable even while a resume IS defined (unlike
   * the no-active-resume picker in ResumeInput.tsx, which the PM's own
   * review there proved unreachable mid-search), so it needs the same gate
   * explicitly, not inherited for free. */
  searching?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [textState, setTextState] = useState<ResumeTextState>({ status: "idle" });
  // Ticket 6ba221e: the resumes page can now edit a resume's TEXT, not just
  // view it. See this file's bottom-of-file component comment for why that
  // reverses ticket 303cff0's deliberate view-only scope.
  const [editState, setEditState] = useState<ResumeEditState>({ mode: "viewing" });
  // Ticket 6ba221e: generation counter for in-flight text saves -- see
  // `saveText` below for the stale-response it rules out.
  const saveTokenRef = useRef(0);
  // Ticket e7666de: the NAME half -- see `NicknameEditState`'s own comment.
  const [nicknameState, setNicknameState] = useState<NicknameEditState>({ mode: "viewing" });
  // The nickname actually displayed by this row. Starts from the prop and
  // tracks it (so a rename that lands via `onRenamed`'s refetch, or from
  // another tab entirely, still shows up here), but a SUCCESSFUL save
  // updates it immediately from the PATCH response -- server-confirmed,
  // not merely optimistic, the same thing `handleNicknameCommit` (App.tsx)
  // already does -- rather than making the user wait on `onRenamed`'s
  // slower `GET /resumes` round trip before the summary line reflects what
  // they just typed.
  const [displayNickname, setDisplayNickname] = useState(resume.resumeNickname);
  useEffect(() => {
    setDisplayNickname(resume.resumeNickname);
  }, [resume.resumeNickname]);
  // Generation counter for in-flight nickname saves, same stale-response
  // guard `saveTokenRef`/`saveText` already use for text: a response that
  // lands after the user has already clicked Cancel must not resurrect the
  // editor, but a save that actually SUCCEEDED must still be recorded in
  // `displayNickname` -- see `saveNickname` below.
  const nicknameSaveTokenRef = useRef(0);
  // Opus review, ticket 1e183a4 (F3): the TOKEN that's currently driving
  // the highlight, not a plain boolean. A boolean can't tell "still
  // highlighted from the last focus" apart from "just focused again" --
  // `setJustFocused(true)` while already `true` is a no-op render, so the
  // cleanup effect below (keyed on the value actually changing) would
  // never restart its timer, and a second click on the same row while its
  // first highlight was still fading would cut the flash SHORT instead of
  // restarting it. Keying on the token itself means every distinct focus
  // event is a real state change, even a repeat one.
  const [highlightToken, setHighlightToken] = useState<number | undefined>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);
  // Which `focusResume.token` this row has already acted on -- without
  // this, the effect below would re-run (and re-scroll/re-flash) on every
  // unrelated render that happens to leave `focusResume` referentially
  // equal-but-not-actually-new, and would never distinguish "still the
  // same click" from "a genuinely new one" the way `token` is meant to.
  const handledTokenRef = useRef<number | undefined>(undefined);

  function fetchTextIfNeeded() {
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
  }

  /**
   * Ticket 6ba221e: saves the edited text via `PUT /resumes/:id/text`,
   * which mutates THIS row -- same `resumes.id`, same nickname, same
   * attached scores. It is deliberately not `createResume`: that is what
   * used to happen on an "edit" and is exactly what produced a surprise
   * "Resume 2" (git-bug 6ba221e).
   *
   * On success the server's OWN stored text is what lands in `textState`,
   * not the local draft: the route echoes back what it wrote, so the
   * `<pre>` below can never show something the database doesn't have. On
   * failure the draft is preserved in `editing` with the message attached
   * -- losing a rewritten resume to a transient network error would be
   * the worst possible behavior here.
   *
   * `saveTokenRef` guards against a response landing AFTER the user has
   * already left the editor (Cancel stays enabled during a save, see the
   * button's own comment). Without it, a save that failed after a Cancel
   * would silently re-open the editor with an error banner for an edit the
   * user had already walked away from -- the same stale-response class
   * App.tsx's `activationTokenRef` exists for, and the same fix: snapshot
   * a counter before the call, and only apply the result if nothing bumped
   * it in between.
   *
   * Nothing is propagated up to App.tsx, and that is deliberate rather
   * than lazy: `GET /resumes` (the list this component renders from)
   * carries no text, so the list is already current; and a SEARCH sends
   * only a `resumeId`, with the API reading the text from the row itself
   * (`loadResumeText`, routes/searches.ts) -- so a search started right
   * after this save uses the new text whether or not App.tsx's cached
   * copy caught up. The one thing that can lag is the chip list seeded
   * from the active resume's titles, which is cosmetic, user-editable
   * anyway, and refreshes on the next activation or reload.
   */
  function saveText(draft: string) {
    const token = ++saveTokenRef.current;
    setEditState({ mode: "saving", draft });
    updateResumeText(resume.id, draft)
      .then((data) => {
        // The SAVE itself landed, so the row's text really did change --
        // record that even if the user walked away from the editor, or the
        // `<pre>` would keep showing text the database no longer has.
        setTextState({ status: "ready", resumeText: data.resumeText });
        if (saveTokenRef.current !== token) return;
        setEditState({ mode: "viewing" });
      })
      .catch((err: unknown) => {
        if (saveTokenRef.current !== token) return;
        setEditState({
          mode: "editing",
          draft,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Ticket e7666de: renames this resume via `PATCH /resumes/:id`. Mirrors
   * `saveText` above exactly, including the stale-response guard --
   * `nicknameSaveTokenRef` plays the same role `saveTokenRef` plays there.
   *
   * On success, `displayNickname` is set from the SERVER's returned
   * `resumeNickname` (the route trims it; see routes/resumes.ts), not the
   * raw draft, so this row can never show a value the database doesn't
   * actually have -- unconditionally, even if the user has already
   * clicked Cancel, for the same reason `saveText` unconditionally updates
   * `textState`: the write really happened. `onRenamed` fires right after,
   * also unconditionally, so the PARENT list -- which is what
   * `sortResumesByNickname` actually sorts -- catches up too; see this
   * function's own `onRenamed` prop comment for why that is a second,
   * necessary step rather than redundant with `displayNickname`.
   *
   * `nicknameState` itself (the editor's open/closed-ness) DOES respect
   * the token: a response landing after Cancel must not resurrect the
   * editor with a stale "viewing" transition the user never asked for, or
   * -- on a late failure -- an error banner for an edit already abandoned.
   *
   * KNOWN GAP (opus review, ticket e7666de, F2 -- recorded, not fixed):
   * `setDisplayNickname` above is deliberately UNGATED by the token (that
   * is the point of F1's fix), but that same lack of gating means two
   * in-flight PATCHes on this row can still land out of order: Save
   * "Aardvark", Cancel, Rename again, Save "Zebra" -- if the FIRST
   * response (Aardvark) resolves after the second (Zebra), this row shows
   * "Aardvark" while the server actually holds "Zebra". `onRenamed`'s
   * refetch usually corrects this on the next render, but there is one
   * interleaving where the prop never actually changes (e.g. the refetch
   * that already ran for "Zebra" raced ahead of "Aardvark" landing) so the
   * sync effect above never re-fires, and the row stays wrong until an
   * unrelated reload. Low probability, display-only, and `saveText`
   * above has the identical shape already -- a carried-forward idiom, not
   * something new here. A real fix would need `saveNickname` to ignore a
   * response order-independent of `nicknameSaveTokenRef` entirely (e.g. a
   * monotonically increasing "last applied" counter kept separately from
   * the cancel token), which is a second idiom this ticket was told not
   * to invent on its own.
   */
  function saveNickname(draft: string) {
    const token = ++nicknameSaveTokenRef.current;
    setNicknameState({ mode: "saving", draft });
    updateResumeNickname(resume.id, draft)
      .then((data) => {
        setDisplayNickname(data.resumeNickname);
        onRenamed?.();
        if (nicknameSaveTokenRef.current !== token) return;
        setNicknameState({ mode: "viewing" });
      })
      .catch((err: unknown) => {
        if (nicknameSaveTokenRef.current !== token) return;
        setNicknameState({
          mode: "editing",
          draft,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  // Ticket 1e183a4: reacts to a NEW `focusResume` naming this row (a
  // result card's "Searched with:" link) by opening it, fetching its text,
  // scrolling it into view, and flashing a brief highlight -- Nicole's own
  // "highlighted and the text already expanded." Deliberately does nothing
  // when `focusResume` names a DIFFERENT row or is absent, so every other
  // row's own open/closed state is untouched by someone else's click.
  //
  // `textState.status` is a real dependency here (not just `focusResume`/
  // `resume.id`) so `fetchTextIfNeeded` always sees the CURRENT status,
  // not a stale closure over whatever it was when this effect was first
  // defined -- `handledTokenRef` is what stops the resulting re-run (status
  // idle -> loading -> ready/error) from re-opening/re-scrolling/re-
  // fetching on every one of those transitions: it only acts the FIRST
  // time a given token is seen.
  useEffect(() => {
    if (focusResume === undefined || focusResume.id !== resume.id) return;
    if (handledTokenRef.current === focusResume.token) return;
    handledTokenRef.current = focusResume.token;

    setOpen(true);
    fetchTextIfNeeded();
    setHighlightToken(focusResume.token);
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusResume, resume.id, textState.status]);

  // Opus review, ticket 1e183a4 (F3): keyed on `highlightToken` itself
  // (not a boolean), so a NEW focus event always restarts this timer --
  // including one that arrives while the previous highlight is still
  // showing -- rather than silently doing nothing because the boolean it
  // would have set was already `true`.
  useEffect(() => {
    if (highlightToken === undefined) return;
    const timer = setTimeout(() => setHighlightToken(undefined), FOCUS_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightToken]);

  return (
    <li
      ref={rowRef}
      className={`resume-list-item${highlightToken !== undefined ? " resume-list-item-focused" : ""}`}
    >
      {/* Ticket 11ead86: the activate action that closes this page's two
          remaining dead ends -- an active-but-UNLOCKED resume's "Edit"
          (ResumeInput.tsx) reopens the paste form, not the picker, so
          there was no path to a DIFFERENT saved resume without submitting
          something; and a stale restored `resumeId` (a failed hydrate
          `GET /resumes/:id`, swallowed by design) left the collapsed bar
          naming a row the server no longer has, with the same dead end.
          `MyResumes` already lists every saved resume regardless of which
          one is active, so wiring THIS list to the existing
          `onActivateResume`/`handleActivateResume` (ticket 88f11d7) fixes
          both at once without depending on what `resumeId` currently is.

          DECISION, ARGUED RATHER THAN COPIED (ticket 11ead86 explicitly
          asks for this): the search tab's own picker excludes the active
          resume from its list (`r.id !== resumeId`, ResumeInput.tsx) --
          that list is a CHOOSER, so an entry with nothing to do is simply
          removed. This list is a browsable INVENTORY of every saved
          resume (ticket 303cff0's own framing, never revised), not a
          chooser: every other row-level feature here (view text, edit
          text, rename) stays available on the active row too, and hiding
          this ONE row the moment it becomes active would make a resume
          look like it vanished from its own inventory, which is a worse
          surprise than a redundant control would be.

          So the active row still renders here -- as a plain, non-
          interactive "Active" marker, not a disabled button and not
          nothing. Disabled-button was considered and rejected: a disabled
          control invites "why won't this work" (there is nothing broken,
          there is just nothing left to do), where a status label just
          says the true thing. This is also already the app's own idiom
          for exactly this fact -- the collapsed summary bar on the search
          tab shows "Using {nickname}" as plain text, never as a dead
          button, for the same resume/session relationship. */}
      <div className="resume-text-actions">
        {isActive ? (
          // Review fix (Required 5, ticket 11ead86): `aria-label` carries
          // the nickname, same convention "Edit {nickname} text" and
          // "Rename {nickname}" already follow two elements below -- every
          // row renders the same bare visible word ("Active"), so without
          // this a screen-reader user gets no way to tell WHICH resume is
          // active from this element alone (unlike those two buttons, a
          // bare `<span>` has no accessible name of its own to even fall
          // back to). The visible text stays the short "Active" -- the
          // row's own `<summary>` already names the resume right next to
          // it for a sighted user.
          <span className="resume-active-marker" aria-label={`Active — ${displayNickname}`}>
            Active
          </span>
        ) : (
          <button
            type="button"
            className="resume-activate-button"
            aria-describedby={searching ? "my-resumes-searching-note" : undefined}
            // Review fix (F5, ticket 11ead86): `.resume-activate-button`
            // sets its own `color`/`background`/`cursor`, which overrides
            // the UA's native disabled-button styling -- without this, a
            // disabled "Use {nickname}" looked IDENTICAL to an enabled
            // one, across a whole uncapped list, for the entire duration
            // of a search (every other row already gets this for free:
            // `index.css`'s `button[aria-disabled="true"]` rule is what
            // actually dims a button here, the same mechanism
            // SearchFlow.tsx's "Estimate search cost" button already
            // relies on for its own click-time-gated disable). Plain
            // boolean, not `? true : undefined`: `aria-disabled="false"`
            // is the explicit, correct value while enabled, not an
            // attribute to omit -- same convention SearchFlow.tsx's own
            // `aria-disabled` follows.
            aria-disabled={activating || searching}
            disabled={activating || searching}
            onClick={() => onActivate?.(resume.id)}
          >
            Use {displayNickname}
          </button>
        )}
      </div>
      <details
        open={open}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setOpen(isOpen);
          if (isOpen) fetchTextIfNeeded();
        }}
      >
        <summary>
          <span className="resume-nickname">{displayNickname}</span>
          <span className="resume-created-at">
            Saved {new Date(resume.createdAt).toLocaleDateString()}
          </span>
        </summary>
        {textState.status === "loading" && <p>Loading resume text...</p>}
        {textState.status === "error" && (
          <p role="alert">Could not load resume text: {textState.message}</p>
        )}
        {/* Ticket 6ba221e: the view/edit split. Both branches are gated on
            `textState.status === "ready"` -- there is nothing to edit until
            the real text has actually loaded, so "Edit text" can never open
            a textarea pre-filled with a placeholder or an empty string that
            a Save would then write over the real resume. */}
        {textState.status === "ready" && editState.mode === "viewing" && (
          <>
            <pre className="resume-text">{textState.resumeText}</pre>
            <div className="resume-text-actions">
              {/* aria-label carries the nickname so a screen-reader user
                  hears WHICH resume this button edits -- every row renders
                  a button with the same visible text. */}
              <button
                type="button"
                className="resume-text-edit-button"
                aria-label={`Edit ${displayNickname} text`}
                onClick={() => setEditState({ mode: "editing", draft: textState.resumeText })}
              >
                Edit text
              </button>
            </div>
          </>
        )}
        {textState.status === "ready" && editState.mode !== "viewing" && (
          <div className="resume-text-editor">
            <label htmlFor={`resume-text-edit-${resume.id}`}>
              Resume text for {displayNickname}
            </label>
            <textarea
              id={`resume-text-edit-${resume.id}`}
              className="resume-text-edit-input"
              value={editState.draft}
              rows={14}
              // Disabled, not unmounted, while the PUT is in flight: the
              // draft stays visible and in place, so a failure lands the
              // user back exactly where they were rather than re-rendering
              // a different control.
              disabled={editState.mode === "saving"}
              onChange={(e) => setEditState({ mode: "editing", draft: e.target.value })}
            />
            <div className="resume-text-actions">
              {/* Save is hidden (not merely disabled) for empty text, the
                  same "controls aren't there before their moment arrives"
                  convention ResumeInput.tsx's submit button follows (ticket
                  5a79aa4). The API rejects an empty resumeText with a 400
                  regardless, so this is about not offering a dead button. */}
              {editState.draft.trim().length > 0 && (
                <button
                  type="button"
                  className="resume-text-save-button"
                  disabled={editState.mode === "saving"}
                  onClick={() => saveText(editState.draft)}
                >
                  {editState.mode === "saving" ? "Saving..." : "Save"}
                </button>
              )}
              {/* Left ENABLED during a save, deliberately: this is a way to
                  walk away from an in-flight request, not a competing one.
                  The request itself is not cancelled -- `saveText`'s own
                  `.then` would still fire -- so this only takes effect for
                  the user's view; the same tradeoff ResumeInput's picker
                  Cancel already makes (ticket 88f11d7, review fix F2). */}
              <button
                type="button"
                className="resume-text-cancel-button"
                onClick={() => {
                  saveTokenRef.current++;
                  setEditState({ mode: "viewing" });
                }}
              >
                Cancel
              </button>
            </div>
            {editState.mode === "editing" && editState.error !== undefined && (
              <p role="alert" className="resume-error">
                Could not save resume text: {editState.error}
              </p>
            )}
          </div>
        )}
      </details>
      {/* Ticket e7666de: the NAME half, deliberately a SIBLING of
          `<details>` rather than nested inside it like "Edit text" is --
          unlike resume text, the nickname is already on hand from
          `GET /resumes` (no per-row fetch to gate on), so there is no
          "ready" state to wait for and no reason to make renaming a
          collapsed resume require expanding it first. Also deliberately
          NOT inside `<summary>`: a native `<summary>`'s own click toggles
          the `<details>` open/closed on ANY click landing inside it
          (calling `preventDefault` on every nested interactive element's
          click to suppress that is exactly the kind of fragile second
          idiom this ticket was told to avoid), so the rename control lives
          here instead, where the existing toggle logic above is
          untouched.

          KNOWN LAYOUT COST (opus review, ticket e7666de, F6 -- recorded,
          not fixed): placing the control AFTER `<details>` means that with
          a row EXPANDED, it renders below the entire resume text (and,
          mid-edit, below that text's own editor too) -- far from the name
          it renames, which is still up in `<summary>`. Putting it BEFORE
          `<details>` instead would fix that distance but reopen the worse
          problem this placement avoids (the `<summary>`-click-toggle
          conflict and the per-row-fetch coupling "Edit text" has and this
          control does not need), so the reviewer judged this placement
          correct on balance; the cost is real on an expanded row with a
          long resume and is just being named rather than solved. */}
      {nicknameState.mode === "viewing" ? (
        // Ticket e7666de review fix (F5): `.resume-text-actions` (not a
        // new, unstyled `.resume-nickname-actions`) -- that class is what
        // right-aligns "Edit text" just above (`index.css:912`,
        // `justify-content: flex-end`), and the editor's own Save/Cancel
        // row below already reuses it. Without this the trigger alone sat
        // flush-left while every other action on this row sits flush-right.
        <div className="resume-text-actions">
          {/* aria-label carries the CURRENT nickname so a screen-reader
              user hears WHICH resume this button renames -- every row
              renders a button with the same visible text. Same shape as
              `Edit ${displayNickname} text` above (ticket 6ba221e). */}
          <button
            type="button"
            className="resume-nickname-rename-button"
            aria-label={`Rename ${displayNickname}`}
            onClick={() => setNicknameState({ mode: "editing", draft: displayNickname })}
          >
            Rename
          </button>
        </div>
      ) : (
        <div className="resume-text-editor resume-nickname-editor">
          <label htmlFor={`resume-nickname-edit-${resume.id}`}>
            New name for {displayNickname}
          </label>
          <div className="resume-nickname-field">
            <input
              id={`resume-nickname-edit-${resume.id}`}
              value={nicknameState.draft}
              // Disabled, not unmounted, while the PATCH is in flight --
              // same reasoning as the text editor's textarea above.
              disabled={nicknameState.mode === "saving"}
              // Ticket e7666de review fix (F4): the same red-outline
              // treatment ResumeInput.tsx's own nickname field gets
              // (ticket 7701534, Nicole: "it should highlight... red
              // outline on the field") -- `index.css:224` keys that rule
              // off `aria-invalid="true"` on an element already inside
              // `.resume-nickname-field`, which this input reuses, so
              // setting the attribute is the only piece this row was
              // missing. True for the SAME condition the error message
              // below renders on, so the two always appear and disappear
              // together.
              aria-invalid={
                nicknameState.mode === "editing" && nicknameState.error !== undefined
                  ? true
                  : undefined
              }
              onChange={(e) => setNicknameState({ mode: "editing", draft: e.target.value })}
            />
          </div>
          <div className="resume-text-actions">
            {/* Save hidden (not merely disabled) for an empty/whitespace-
                only draft -- the same convention the text editor's Save
                follows just above. The API rejects an empty nickname with
                a 400 regardless (routes/resumes.ts); this is about not
                offering a dead button for a value the server would bounce
                anyway. */}
            {nicknameState.draft.trim().length > 0 && (
              <button
                type="button"
                className="resume-nickname-save-button"
                disabled={nicknameState.mode === "saving"}
                onClick={() => saveNickname(nicknameState.draft)}
              >
                {nicknameState.mode === "saving" ? "Saving..." : "Save"}
              </button>
            )}
            {/* Left ENABLED during a save, deliberately -- same walk-away
                tradeoff the text editor's Cancel makes just above. */}
            <button
              type="button"
              className="resume-nickname-cancel-button"
              onClick={() => {
                nicknameSaveTokenRef.current++;
                setNicknameState({ mode: "viewing" });
              }}
            >
              Cancel
            </button>
          </div>
          {nicknameState.mode === "editing" && nicknameState.error !== undefined && (
            <p role="alert" className="resume-error">
              Could not save resume name: {nicknameState.error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * "My Resumes" tab (ticket 303cff0) -- Nicole, live: "there are multiple
 * resumes going on, at least for me... I think it's reasonable that if a
 * user's got a resume on here, they should be able to at least view it."
 *
 * NO LONGER VIEW-ONLY. 303cff0 deliberately shipped with no rename, no
 * delete and no "search again with this" link, because Nicole hadn't
 * decided how she wanted resume management to work ("I haven't determined
 * how I'm going to further manage them"). She has now decided part of it,
 * and ticket 6ba221e is that decision: "On the resume page, I want them to
 * be able to edit both the names of the resumes and the resumes
 * themselves." This component implements the TEXT half (per-row "Edit
 * text", saving through `PUT /resumes/:id/text`, which mutates the
 * existing row rather than creating a new one).
 *
 * The NAME half is HERE NOW too (ticket e7666de, filed separately
 * precisely so the two changes didn't collide in this file while both were
 * in flight): a per-row "Rename" control, saving through the same
 * `PATCH /resumes/:id` ticket 38a7598 already built and nothing had called
 * until now. Delete and "search again with this" remain undecided and
 * absent.
 *
 * `focusResume` (ticket 1e183a4, optional): when set, names the one
 * resume a result card's "Searched with:" link just asked to jump to --
 * passed straight through to every row, which only the matching one acts
 * on (see `ResumeRow`'s own comment).
 *
 * `onRenamed` (ticket e7666de, optional): fires after a rename lands on
 * the server, so `App.tsx` can refetch the list this component sorts --
 * see `ResumeRow`'s own `onRenamed` prop comment for why a per-row local
 * update alone isn't enough to keep sort order correct.
 *
 * Ticket 7da6904 (Nicole, after the "Change" picker got the same fix in
 * ticket 336f1e6: "go ahead and make them alphanumeric on the resume page
 * too"): sorted via `sortResumesByNickname` rather than left in `resumes`'
 * own oldest-created-first order (`ListResumesResponse`'s doc comment) --
 * the same natural/numeric sort the picker uses, from the same shared
 * helper, so the two never drift out of sync with each other again. A
 * rename is exactly the case this sort has to keep working across: see
 * this file's test suite for a rename that crosses another resume's
 * position in the sorted list.
 *
 * ALSO NO LONGER "VIEW, EDIT, RENAME"-ONLY (ticket 11ead86): a per-row
 * "Use {nickname}" activate action, wired by `App.tsx` straight to the
 * EXISTING `handleActivateResume` (ticket 88f11d7) that the search tab's
 * "Change" picker already uses -- no new data path, no new endpoint, no
 * new vocabulary (the button's own label matches the picker's exactly).
 * Raised by opus reviewing ticket e2b5f9c: that ticket let a user pick a
 * saved resume by name only when NO resume was active; the dead end that
 * survived was an active-but-UNLOCKED resume, whose collapsed bar offers
 * "Edit" (not "Change"), which reopens the paste form -- never the picker
 * -- so there was no way to switch to a DIFFERENT saved resume without
 * submitting something first. This list doesn't depend on `resumeId`'s
 * current value at all, which is also what makes it the one place that
 * self-heals a STALE restored `resumeId` naming a row the server no
 * longer has (a separate, pre-existing, swallowed hydrate failure this
 * ticket does not fix -- it only makes that state escapable).
 *
 * `activeResumeId` (optional): `App.tsx`'s own `resumeId`, so exactly one
 * row can tell it's the one currently in use. See `ResumeRow`'s own
 * comment on `isActive` for why that row still renders a visible marker
 * rather than being hidden or merely disabled.
 *
 * `onActivateResume`/`activating`/`activateError` (optional): threaded
 * straight through to every row, read-only here -- `App.tsx` already owns
 * this state for the search tab's picker (ticket 88f11d7) and this is a
 * second caller of the exact same handler, not a second copy of the
 * state. `activateError` renders ONCE, above the list (mirroring the
 * picker's own single error line), rather than per-row, since only one
 * activation can be in flight across this whole list at a time.
 *
 * `searching` (optional, acceptance criterion of ticket 11ead86): the same
 * guard the collapsed bar's "Change"/"Edit" already respects (Nicole: "I
 * don't think that we should allow a change of resume while a search is
 * in progress") -- unlike the no-active-resume picker in ResumeInput.tsx
 * (provably unreachable mid-search, per that file's own comment), THIS
 * list stays reachable throughout a running search (it's a whole separate
 * tab, always mounted), so the gate has to be real here, not inherited.
 */
export function MyResumes({
  resumes,
  focusResume,
  onRenamed,
  activeResumeId,
  onActivateResume,
  activating,
  activateError,
  searching,
}: {
  resumes: ResumeSummary[];
  focusResume?: FocusResume;
  onRenamed?: () => void;
  activeResumeId?: string;
  onActivateResume?: (resumeId: string) => void;
  activating?: boolean;
  activateError?: string | null;
  searching?: boolean;
}) {
  if (resumes.length === 0) {
    return <p>No resumes saved yet.</p>;
  }

  return (
    <>
      {/* Ticket 11ead86: one shared note/error for the whole list, not
          per-row -- only one activation can ever be in flight at once
          (App.tsx's `resumeActivating` is a single boolean, same as the
          search tab's own picker), so a per-row copy would just be the
          same fact repeated once per saved resume. */}
      {searching && (
        <p id="my-resumes-searching-note" className="resume-change-note">
          Can&apos;t change resumes while a search is running.
        </p>
      )}
      {activateError && (
        <p role="alert" className="resume-error">
          Could not load that resume: {activateError}
        </p>
      )}
      <ul className="resume-list">
        {sortResumesByNickname(resumes).map((resume) => (
          <ResumeRow
            key={resume.id}
            resume={resume}
            focusResume={focusResume}
            onRenamed={onRenamed}
            isActive={resume.id === activeResumeId}
            onActivate={onActivateResume}
            activating={activating}
            searching={searching}
          />
        ))}
      </ul>
    </>
  );
}
