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
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not save nickname: Network error");
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
// in a different order, and use this resume should be last, horizontally"
// -- plus the still-standing "when I hit use this resume... I want the
// text field to become not editable anymore").
describe("ResumeInput — nickname-first ordering and locked textarea (ticket cdc2c39)", () => {
  it("textarea is editable with no resumeId yet, and becomes read-only once a resumeId exists", () => {
    const { rerender } = render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.getByLabelText("Paste your resume")).not.toHaveAttribute("readonly");

    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
      />,
    );

    expect(screen.getByLabelText("Paste your resume")).toHaveAttribute("readonly");
  });

  it("places the nickname field before the 'Use this resume' button, horizontally, once both are showing", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
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

// Adversarial review of cdc2c39 (opus), round 1: the read-only lock above
// was a ONE-WAY DOOR with `resumeId` never cleared anywhere else -- no way
// to ever submit a different resume for the rest of the session/reload.
// Round 2: the first fix attempt (clearing `resumeId` on click) collapsed
// the whole app and wiped sessionStorage mid-edit (ticket 3f05144 again) --
// see App.persistence.test.tsx's "Edit resume" test for that half. This
// file covers the ResumeInput-local behavior of the actual fix: a separate
// `editingResume` flag App.tsx owns, never `resumeId` itself.
describe("ResumeInput — 'Edit resume' escape hatch from the read-only lock (review fix, ticket cdc2c39)", () => {
  it("does not render 'Edit resume' with no resumeId yet -- nothing locked to escape from", () => {
    render(<ResumeInput onSubmit={() => {}} submitting={false} />);

    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
  });

  it("renders 'Edit resume' once locked, calls onEditResume (not onSubmit) when clicked", () => {
    const onEditResume = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ResumeInput
        onSubmit={onSubmit}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
        onEditResume={onEditResume}
      />,
    );

    const editButton = screen.getByRole("button", { name: "Edit resume" });
    fireEvent.click(editButton);

    expect(onEditResume).toHaveBeenCalledTimes(1);
    // Review round 2, F7: `type="button"` is what stops this from being
    // the form's implicit submit button -- without it, this same click
    // would ALSO re-POST the resume via onSubmit. Regressing that one
    // attribute silently turns "edit" into "edit and resubmit."
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("editingResume (as App.tsx sets via onEditResume) un-readonlys the textarea without touching resumeId-gated content", () => {
    const { rerender } = render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
      />,
    );
    expect(screen.getByLabelText("Paste your resume")).toHaveAttribute("readonly");

    rerender(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
        editingResume={true}
      />,
    );

    expect(screen.getByLabelText("Paste your resume")).not.toHaveAttribute("readonly");
    // Deliberately still visible: the resume being edited still has a
    // nickname, and `resumeId` -- what gates this field -- never changed.
    // This is exactly what round 1's fix got wrong (it cleared resumeId,
    // which hid this).
    expect(screen.getByLabelText("Resume Nickname")).toBeInTheDocument();
  });

  it("hides 'Edit resume' itself once already editing -- a second click would be a no-op", () => {
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

    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
  });

  it("sits between the nickname field and 'Use this resume', so 'Use this resume' stays last horizontally", () => {
    render(
      <ResumeInput
        onSubmit={() => {}}
        submitting={false}
        resumeId="resume-1"
        nickname="Resume 1"
        initialText="some resume text"
      />,
    );

    const nicknameField = screen.getByLabelText("Resume Nickname");
    const editButton = screen.getByRole("button", { name: "Edit resume" });
    const submitButton = screen.getByRole("button", { name: "Use this resume" });

    expect(
      nicknameField.compareDocumentPosition(editButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      editButton.compareDocumentPosition(submitButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
