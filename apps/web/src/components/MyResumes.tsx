import { useEffect, useRef, useState } from "react";
import type { ResumeSummary } from "@app/shared";
import { getResume, updateResumeText } from "../api/client";
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
function ResumeRow({ resume, focusResume }: { resume: ResumeSummary; focusResume?: FocusResume }) {
  const [open, setOpen] = useState(false);
  const [textState, setTextState] = useState<ResumeTextState>({ status: "idle" });
  // Ticket 6ba221e: the resumes page can now edit a resume's TEXT, not just
  // view it. See this file's bottom-of-file component comment for why that
  // reverses ticket 303cff0's deliberate view-only scope.
  const [editState, setEditState] = useState<ResumeEditState>({ mode: "viewing" });
  // Ticket 6ba221e: generation counter for in-flight text saves -- see
  // `saveText` below for the stale-response it rules out.
  const saveTokenRef = useRef(0);
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
      <details
        open={open}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setOpen(isOpen);
          if (isOpen) fetchTextIfNeeded();
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
                aria-label={`Edit ${resume.resumeNickname} text`}
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
              Resume text for {resume.resumeNickname}
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
 * The NAME half is still not here: `PATCH /resumes/:id` has accepted a
 * rename since ticket 38a7598, but surfacing it on this page is its own
 * ticket (e7666de), filed separately precisely so the two changes don't
 * collide in this file. Delete and "search again with this" remain
 * undecided and absent.
 *
 * `focusResume` (ticket 1e183a4, optional): when set, names the one
 * resume a result card's "Searched with:" link just asked to jump to --
 * passed straight through to every row, which only the matching one acts
 * on (see `ResumeRow`'s own comment).
 *
 * Ticket 7da6904 (Nicole, after the "Change" picker got the same fix in
 * ticket 336f1e6: "go ahead and make them alphanumeric on the resume page
 * too"): sorted via `sortResumesByNickname` rather than left in `resumes`'
 * own oldest-created-first order (`ListResumesResponse`'s doc comment) --
 * the same natural/numeric sort the picker uses, from the same shared
 * helper, so the two never drift out of sync with each other again.
 */
export function MyResumes({
  resumes,
  focusResume,
}: {
  resumes: ResumeSummary[];
  focusResume?: FocusResume;
}) {
  if (resumes.length === 0) {
    return <p>No resumes saved yet.</p>;
  }

  return (
    <ul className="resume-list">
      {sortResumesByNickname(resumes).map((resume) => (
        <ResumeRow key={resume.id} resume={resume} focusResume={focusResume} />
      ))}
    </ul>
  );
}
