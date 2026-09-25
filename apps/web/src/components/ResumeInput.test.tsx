// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeInput } from "./ResumeInput";

/**
 * `nickname` is genuinely controlled (see ResumeInput's own doc comment on
 * that prop) -- a caller that doesn't feed keystrokes back in as the next
 * render's `nickname` would see the DOM input snap back to the old value
 * the instant React re-renders, exactly like any other controlled input
 * with no owning state. This wrapper mirrors what the REAL caller
 * (App.tsx's `handleNicknameChange`) does, so `fireEvent.blur` below reads
 * the value the user actually typed rather than the stale initial prop.
 */
function ControlledNicknameHarness({
  onSubmit,
  onNicknameCommit,
  onNicknameChange,
}: {
  onSubmit?: (resumeText: string) => void;
  onNicknameCommit?: (nickname: string) => void;
  onNicknameChange?: (nickname: string) => void;
}) {
  const [nickname, setNickname] = useState("Resume 1");
  return (
    <ResumeInput
      onSubmit={onSubmit ?? (() => {})}
      submitting={false}
      resumeId="resume-1"
      nickname={nickname}
      onNicknameChange={(next) => {
        setNickname(next);
        onNicknameChange?.(next);
      }}
      onNicknameCommit={onNicknameCommit}
      // Ticket ac141d0: with a resumeId and no editingResume, this would
      // render the collapsed summary bar instead of the form -- these
      // tests are specifically about the nickname FIELD, which only
      // exists in the expanded form.
      editingResume={true}
    />
  );
}

// See SourceToggles.test.tsx's comment on this same line: this repo's root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// never runs on its own.
afterEach(cleanup);

// Ticket 38a7598 acceptance criteria: "a nickname field appears next to
// the resume-selection control, pre-filled with a real, distinct default
// per resume" and "the nickname is editable." These tests cover the field
// living in ResumeInput itself (the resume-submission flow, per Nicole's
// explicit "right next to the button... at that moment" instruction), not
// a separate screen.
// Ticket ac141d0: every test below that supplies a `resumeId` also passes
// `editingResume={true}` -- with a resumeId and no editingResume, this
// component now renders the collapsed summary bar instead, and the
// nickname field (like the rest of the form) only exists in the expanded
// state. See the "collapsed summary bar" describe block further down for
// the collapsed state's own (deliberately non-editable) nickname display.
describe("ResumeInput — Resume Nickname field (ticket 38a7598)", () => {
  // Ticket 5a79aa4 (review of 38a7598's shipped UI, live dogfooding): the
  // field used to render disabled-with-a-placeholder before a resumeId
  // existed; Nicole asked for it to be ABSENT instead, matching "Use this
  // resume"'s own not-yet-actionable treatment.
  it("does not render the nickname field at all with no resumeId yet -- nothing to attach a rename to before a resume exists", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.queryByLabelText("Resume Nickname")).not.toBeInTheDocument();
  });

  it("is enabled and pre-filled with the real default once a resumeId + nickname are supplied", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        editingResume={true}
      />,
    );

    const nicknameField = screen.getByLabelText("Resume Nickname");
    expect(nicknameField).not.toBeDisabled();
    expect(nicknameField).toHaveValue("Resume 1");
  });

  it("calls onNicknameChange on every keystroke, without waiting for blur", () => {
    const onNicknameChange = vi.fn();
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        onNicknameChange={onNicknameChange}
        editingResume={true}
      />,
    );

    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Backend-focused resume" },
    });

    expect(onNicknameChange).toHaveBeenCalledWith("Backend-focused resume");
  });

  it("calls onNicknameCommit only on blur -- the actual PATCH round-trip happens once, not per keystroke", () => {
    const onNicknameCommit = vi.fn();
    render(<ControlledNicknameHarness onNicknameCommit={onNicknameCommit} />);

    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Renamed" } });
    expect(onNicknameCommit).not.toHaveBeenCalled();
    expect(nicknameField).toHaveValue("Renamed");

    fireEvent.blur(nicknameField);
    expect(onNicknameCommit).toHaveBeenCalledWith("Renamed");
  });

  // Ticket 38a7598 review fix: the nickname <input> sits INSIDE the resume
  // <form> (which has its own submit button), so without a keydown guard,
  // pressing Enter here triggered the form's implicit submit -- silently
  // RESUBMITTING the resume text instead of committing the rename. Because
  // `createResume` is content-addressed, that resubmission would return the
  // SAME resume id carrying its OLD nickname, discarding whatever was just
  // typed with zero error or explanation.
  it("pressing Enter in the nickname field commits the rename and does not submit the resume", () => {
    const onSubmit = vi.fn();
    const onNicknameCommit = vi.fn();
    render(<ControlledNicknameHarness onSubmit={onSubmit} onNicknameCommit={onNicknameCommit} />);

    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Renamed via Enter" } });
    expect(onNicknameCommit).not.toHaveBeenCalled();

    // dispatchEvent returns false when a cancelable event's default action
    // (here, the form's implicit submit-on-Enter) was prevented -- the
    // direct proof `e.preventDefault()` actually ran, not just an
    // assumption from `onSubmit` never firing (jsdom doesn't implement
    // browser-default submit-on-Enter at all, so that assertion alone
    // wouldn't distinguish a real fix from no guard existing).
    const dispatched = fireEvent.keyDown(nicknameField, { key: "Enter" });
    expect(dispatched).toBe(false);

    expect(onNicknameCommit).toHaveBeenCalledWith("Renamed via Enter");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the nickname field and shows a saving indicator while a rename is in flight", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        nicknameSaving={true}
        editingResume={true}
      />,
    );

    expect(screen.getByLabelText("Resume Nickname")).toBeDisabled();
    expect(screen.getByText("Saving...")).toBeInTheDocument();
  });

  it("shows a nickname-specific error message distinct from the resume-submission error", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        nicknameError="Network error"
        editingResume={true}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not save nickname: Network error");
  });

  // Ticket 7701534, Nicole: "it should do the red outline on the field."
  // `aria-invalid` is what index.css's red-outline rule keys on.
  describe("aria-invalid (ticket 7701534)", () => {
    it("marks the nickname field invalid when there's a nicknameError", () => {
      render(
        <ResumeInput
          onSubmit={() => {}}
          submitting={false}
          resumeId="resume-1"
          nickname="Resume 1"
          nicknameError="This resume nickname is already in use."
          editingResume={true}
        />,
      );

      expect(screen.getByLabelText("Resume Nickname")).toHaveAttribute("aria-invalid", "true");
    });

    it("does not mark the nickname field invalid when there's no nicknameError", () => {
      render(
        <ResumeInput
          onSubmit={() => {}}
          submitting={false}
          resumeId="resume-1"
          nickname="Resume 1"
          editingResume={true}
        />,
      );

      expect(screen.getByLabelText("Resume Nickname")).not.toHaveAttribute("aria-invalid");
    });
  });

  it("still submits the pasted resume text via onSubmit, unaffected by the nickname field's presence", () => {
    const onSubmit = vi.fn();
    render(<ResumeInput onSubmit={onSubmit} submitting={false} />);

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));

    expect(onSubmit).toHaveBeenCalledWith("some resume text");
  });
});

// Ticket 5a79aa4: "Use this resume" itself follows the same not-yet-
// actionable-means-absent treatment as the nickname field, not merely
// disabled-with-nothing-to-explain-why.
describe("ResumeInput — 'Use this resume' visibility (ticket 5a79aa4)", () => {
  it("does not render 'Use this resume' with an empty textarea", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.queryByRole("button", { name: "Use this resume" })).not.toBeInTheDocument();
  });

  it("does not render 'Use this resume' for whitespace-only text", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "   " },
    });

    expect(screen.queryByRole("button", { name: "Use this resume" })).not.toBeInTheDocument();
  });

  it("renders 'Use this resume' once real text is typed, and it disappears again if the text is cleared", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);
    const textarea = screen.getByLabelText("Paste your resume");

    fireEvent.change(textarea, { target: { value: "real resume text" } });
    expect(screen.getByRole("button", { name: "Use this resume" })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "Use this resume" })).not.toBeInTheDocument();
  });
});

// Ticket cdc2c39 (Nicole, live dogfooding: "I don't need anything below
// anything... they can all show up together, but they're just showing up
// in a different order, and use this resume should be last, horizontally").
// The lock-in-place half of that ticket (textarea readOnly) was replaced by
// ticket ac141d0's collapse/expand design -- see that ticket's describe
// blocks below -- but the ordering requirement itself still holds, now
// inside the expanded form specifically (the only place nickname field and
// "Use this resume" ever render together).
describe("ResumeInput — nickname-first ordering in the expanded form (ticket cdc2c39)", () => {
  it("places the nickname field before the 'Use this resume' button, horizontally, once both are showing", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
        editingResume={true}
      />,
    );

    const nicknameField = screen.getByLabelText("Resume Nickname");
    const button = screen.getByRole("button", { name: "Use this resume" });

    // DOCUMENT_POSITION_FOLLOWING means `button` comes AFTER `nicknameField`
    // in document order -- the direct proof of "nickname first, button last
    // horizontally" rather than an assumption from separate presence checks.
    expect(
      nicknameField.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// Ticket ac141d0 (Nicole, immediately after using cdc2c39's shipped
// lock-in-place design: "instead of making everything not editable and
// offering an Edit Resume button... I think we should hide that whole
// section, and a little thing should pop up that says Using Resume 8...
// if they say Edit, it's gonna open again this resume, and then you can
// say Use this resume again, and then it will collapse it"). Replaces
// cdc2c39's lock-in-place + always-visible-Edit-button design entirely.
describe("ResumeInput — collapsed summary bar (ticket ac141d0)", () => {
  it("does not render a summary bar with no resumeId yet -- nothing to summarize", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
  });

  it("collapses to 'Using {nickname}' once a resume is confirmed and not being edited", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
      />,
    );

    expect(screen.getByText("Using Resume 8")).toBeInTheDocument();
    // The full form is GONE, not disabled -- this is a different, smaller
    // render, not the same form locked in place (that was cdc2c39's
    // approach, which this ticket replaced).
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resume Nickname")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use this resume" })).not.toBeInTheDocument();
  });

  // Nicole, correcting an early draft of this ticket before any code was
  // written: "I don't want it renameable right there in line... the only
  // way they can get back to an editable name should be in the
  // collapse-expand." The summary bar's nickname is plain text, not an
  // input -- renaming only happens through the expanded form.
  it("does not render the collapsed nickname as an editable field", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
      />,
    );

    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });

  it("renders 'Edit' on the collapsed bar, and clicking it calls onEditResume (not onSubmit)", () => {
    const onEditResume = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ResumeInput
        onSubmit={onSubmit}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
        onEditResume={onEditResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));

    expect(onEditResume).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("editingResume (as App.tsx sets via onEditResume) expands the full form again, with the existing text and an editable nickname field, and no 'Edit' button", () => {
    const { rerender } = render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
      />,
    );
    expect(screen.getByText("Using Resume 8")).toBeInTheDocument();

    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
        editingResume={true}
      />,
    );

    // Same component instance across the rerender (not a remount), so the
    // text that was submitted is still right there, now editable again --
    // this is the mechanism the whole design leans on: `text` is local
    // state that only ever gets set from `initialText` ONCE, at first
    // mount, regardless of which branch renders on any given render.
    expect(screen.getByLabelText("Paste your resume")).toHaveValue("some resume text");
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 8");
    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
    expect(screen.queryByText("Using Resume 8")).not.toBeInTheDocument();
  });

  // Review fix (F4): the test above passes `initialText` UNCHANGED across
  // the rerender, so it can't actually distinguish "state persisted" from
  // "a remount re-seeded useState(initialText) with the same value" -- a
  // remount would pass it too. This one diverges `text` from `initialText`
  // BEFORE collapsing, which only a genuine no-remount can survive.
  it("really does preserve un-submitted, un-collapsed text edits across a collapse/expand cycle (not just the same initialText being re-seeded)", () => {
    const { rerender } = render(
      <ResumeInput onSubmit={() => {}} submitting={false} initialText="original text" />,
    );

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "diverged text nobody submitted" },
    });

    // Simulates a resume existing now (e.g. from an unrelated App render)
    // while this component's own `text` still holds the divergent value
    // above -- collapses, per the usual gate.
    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="original text"
      />,
    );
    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();

    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="original text"
        editingResume={true}
      />,
    );

    // If this were a remount, `useState(initialText)` would have re-seeded
    // to "original text" -- seeing the diverged value is the actual proof.
    expect(screen.getByLabelText("Paste your resume")).toHaveValue(
      "diverged text nobody submitted",
    );
  });

  it("re-submitting from the expanded state re-collapses back to the summary bar", () => {
    const { rerender } = render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
        editingResume={true}
      />,
    );
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();

    // Mirrors what App.tsx actually does on a successful resubmit:
    // `handleResumeSubmit` clears `resumeEditing` back to false (this
    // component itself never clears it -- an edit isn't "done" until a
    // submission lands, same lesson cdc2c39's review established).
    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 8"
        initialText="some resume text"
        editingResume={false}
      />,
    );

    expect(screen.getByText("Using Resume 8")).toBeInTheDocument();
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();
  });
});

// Review fix (F3): without "Cancel", clearing the textarea during a
// re-edit was a genuine dead end -- no submit button (empty text), no
// Edit button (only the collapsed branch has one), and since this ticket
// also hides sources/criteria/search while editing, no way off the
// screen short of a reload.
describe("ResumeInput — 'Cancel' escape hatch during a re-edit (review fix, ticket ac141d0)", () => {
  it("does not render Cancel before any resume exists -- nothing to cancel back to yet", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("renders Cancel during a re-edit, and clicking it calls onCancelEdit (not onSubmit)", () => {
    const onCancelEdit = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ResumeInput
        onSubmit={onSubmit}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
        editingResume={true}
        onCancelEdit={onCancelEdit}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancelEdit).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("discards an uncommitted edit -- Cancel reverts the textarea to the last actually-submitted text", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="the real submitted resume"
        editingResume={true}
      />,
    );

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "a half-finished edit nobody asked to keep" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByLabelText("Paste your resume")).toHaveValue("the real submitted resume");
  });

  // The actual dead-end scenario the review caught: clearing the box
  // removes "Use this resume" (empty text), and this branch has no Edit
  // button at all (that only exists in the collapsed branch) -- Cancel
  // must survive regardless of what's in the box, or there is no way out.
  it("stays available even when the textarea is cleared to empty -- the actual dead end this fix closes", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
        editingResume={true}
      />,
    );

    fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: "" } });

    expect(screen.queryByRole("button", { name: "Use this resume" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

// Ticket 88f11d7 (Nicole: "once that has happened [a real search], then a
// user can't change the text on the resume anymore... if they hit change,
// I want them to have the option somehow of... toggle buttons"). The
// collapsed bar's "Edit"/"Change" swap and the picker's own rendering --
// App.tsx's own tests (App.resumeLock.test.tsx) cover the end-to-end
// wiring (GET vs POST, title-chip repopulation, the search-running gate);
// these are the component-level cases for ResumeInput's own branching.
describe("ResumeInput — locked 'Change' button (ticket 88f11d7)", () => {
  it("shows 'Edit', not 'Change', when isLocked is not set -- unchanged default behavior", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
      />,
    );

    expect(screen.getByRole("button", { name: "Edit resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change resume" })).not.toBeInTheDocument();
  });

  it("shows 'Change', not 'Edit', once isLocked is true, and clicking it calls onChangeResume (not onEditResume)", () => {
    const onChangeResume = vi.fn();
    const onEditResume = vi.fn();
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        isLocked={true}
        onChangeResume={onChangeResume}
        onEditResume={onEditResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));

    expect(onChangeResume).toHaveBeenCalledTimes(1);
    expect(onEditResume).not.toHaveBeenCalled();
  });

  it("disables 'Change' and shows an explanatory note while searching is true", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        isLocked={true}
        searching={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Change resume" })).toBeDisabled();
    expect(screen.getByText("Can't change resumes while a search is running.")).toBeInTheDocument();
  });

  // Review fix (F1, ticket 88f11d7): an earlier version of this exempted
  // an unlocked resume's "Edit" from the `searching` gate, on the theory
  // that `isLocked` always flips true before a real search starts
  // polling -- false in practice (App.tsx's `resumeLocked` only updates
  // once SearchFlow confirms the run, which is strictly AFTER
  // `onRunningChange` already reports `searching = true` for the
  // `POST /searches` request itself being in flight). "Edit" must be
  // gated on `searching` exactly like "Change" is, with no `isLocked`
  // exemption, to actually close that window.
  it("also disables 'Edit' for an UNLOCKED resume while searching is true -- no isLocked exemption", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        searching={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Edit resume" })).toBeDisabled();
    expect(screen.getByText("Can't change resumes while a search is running.")).toBeInTheDocument();
  });

  it("ties the disabled reason to the button via aria-describedby", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        isLocked={true}
        searching={true}
      />,
    );

    const button = screen.getByRole("button", { name: "Change resume" });
    const note = screen.getByText("Can't change resumes while a search is running.");
    expect(button).toHaveAttribute("aria-describedby", note.id);
  });
});

describe("ResumeInput — the picker branch (ticket 88f11d7)", () => {
  const RESUMES = [
    { id: "resume-1", resumeNickname: "Resume 1" },
    { id: "resume-8", resumeNickname: "Resume 8" },
    { id: "resume-14", resumeNickname: "Resume 14" },
  ];

  it("renders one toggle button per OTHER saved resume, excluding the currently active one, plus 'Paste a new resume' and 'Cancel'", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        resumes={RESUMES}
      />,
    );

    expect(screen.queryByRole("button", { name: "Use Resume 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Resume 8" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Resume 14" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste a new resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // The picker, not the paste form or the collapsed bar.
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();
  });

  it("clicking an existing resume's button fires onActivateResume with its id -- never onSubmit", () => {
    const onActivateResume = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ResumeInput
        onSubmit={onSubmit}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        resumes={RESUMES}
        onActivateResume={onActivateResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    expect(onActivateResume).toHaveBeenCalledWith("resume-8");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clicking 'Paste a new resume' fires onStartPasteNew, not onActivateResume", () => {
    const onStartPasteNew = vi.fn();
    const onActivateResume = vi.fn();
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        resumes={RESUMES}
        onStartPasteNew={onStartPasteNew}
        onActivateResume={onActivateResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    expect(onStartPasteNew).toHaveBeenCalledTimes(1);
    expect(onActivateResume).not.toHaveBeenCalled();
  });

  it("clicking 'Cancel' fires onCancelChange", () => {
    const onCancelChange = vi.fn();
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        onCancelChange={onCancelChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancelChange).toHaveBeenCalledTimes(1);
  });

  it("disables the 'Use Resume N' buttons while activating is true, to prevent a second competing activation", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        resumes={RESUMES}
        activating={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Use Resume 8" })).toBeDisabled();
  });

  // Review fix (F2, ticket 88f11d7): unlike "Use Resume N" above, these
  // two are ways to ABANDON a pending activation, not compete with it --
  // same reasoning "Cancel" already had, extended to "Paste a new resume".
  it("does NOT disable 'Paste a new resume' or 'Cancel' while activating is true -- both are valid ways to abandon it", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        resumes={RESUMES}
        activating={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Paste a new resume" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).not.toBeDisabled();
  });

  it("shows activateError as a blocking alert", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        changingResume={true}
        activateError="Could not reach the API"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load that resume: Could not reach the API",
    );
  });
});
