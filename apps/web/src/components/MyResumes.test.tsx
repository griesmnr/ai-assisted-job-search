// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ResumeSummary } from "@app/shared";
import { MyResumes } from "./MyResumes";

// Ticket 1e183a4: jsdom does not implement `scrollIntoView` at all -- see
// App.criteria.test.tsx's identical stub/comment for `locationSectionRef`.
// Declared here, assigned fresh in `beforeEach` below (not once at module
// scope) so each test gets its own call history without `vi.clearAllMocks()`
// (already used in this file's `afterEach`) needing to know about it.
let scrollIntoViewMock: Mock<typeof Element.prototype.scrollIntoView>;
beforeEach(() => {
  scrollIntoViewMock = vi.fn<typeof Element.prototype.scrollIntoView>();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

const getResume = vi.fn();
// Ticket 6ba221e: the resumes page can edit a resume's TEXT now, through
// `PUT /resumes/:id/text` -- see MyResumes.tsx's `saveText`.
const updateResumeText = vi.fn();
// Ticket e7666de: the NAME half, through `PATCH /resumes/:id` -- see
// MyResumes.tsx's `saveNickname`.
const updateResumeNickname = vi.fn();

// Ticket 303cff0 ("My Resumes" tab): mocked the same way ResultCard.test.tsx
// mocks ../api/client, so this component-level test never makes a real
// network call -- only `getResume` (fetched lazily on row-expand) is
// exercised here; `listResumes` is App.tsx's own concern, tested there.
vi.mock("../api/client", () => ({
  getResume: (...args: unknown[]) => getResume(...args),
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeSummary(overrides: Partial<ResumeSummary> = {}): ResumeSummary {
  return {
    id: "resume-1",
    resumeNickname: "Resume 1",
    createdAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("MyResumes (ticket 303cff0)", () => {
  it("shows a 'no resumes saved yet' message when the list is empty", () => {
    render(<MyResumes resumes={[]} />);
    expect(screen.getByText("No resumes saved yet.")).toBeInTheDocument();
  });

  it("lists every resume's nickname and created date, without fetching any text up front", () => {
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Backend-focused resume" }),
        ]}
      />,
    );
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
    expect(screen.getByText("Backend-focused resume")).toBeInTheDocument();
    expect(getResume).not.toHaveBeenCalled();
  });

  it("fetches and shows a resume's full text only once its row is expanded", async () => {
    getResume.mockResolvedValue({
      id: "resume-1",
      resumeText: "Experienced backend engineer...",
      resumeNickname: "Resume 1",
    });
    render(<MyResumes resumes={[makeSummary()]} />);

    expect(getResume).not.toHaveBeenCalled();
    expect(screen.queryByText("Experienced backend engineer...")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Resume 1"));

    await waitFor(() => {
      expect(screen.getByText("Experienced backend engineer...")).toBeInTheDocument();
    });
    expect(getResume).toHaveBeenCalledTimes(1);
    expect(getResume).toHaveBeenCalledWith("resume-1");
  });

  it("does not re-fetch on a second expand of the same row -- fetches once, then reuses it", async () => {
    getResume.mockResolvedValue({
      id: "resume-1",
      resumeText: "Cached resume text.",
      resumeNickname: "Resume 1",
    });
    render(<MyResumes resumes={[makeSummary()]} />);

    const summary = screen.getByText("Resume 1");
    fireEvent.click(summary); // expand
    await waitFor(() => expect(screen.getByText("Cached resume text.")).toBeInTheDocument());

    fireEvent.click(summary); // collapse
    fireEvent.click(summary); // expand again

    await waitFor(() => expect(screen.getByText("Cached resume text.")).toBeInTheDocument());
    expect(getResume).toHaveBeenCalledTimes(1);
  });

  it("shows an error message, not a crash, when the text fetch fails", async () => {
    getResume.mockRejectedValue(new Error("network down"));
    render(<MyResumes resumes={[makeSummary()]} />);

    fireEvent.click(screen.getByText("Resume 1"));

    await waitFor(() => {
      expect(screen.getByText("Could not load resume text: network down")).toBeInTheDocument();
    });
  });

  // Opus review, required fix: a failed fetch used to latch the row as
  // permanently broken for the rest of the session -- re-collapsing and
  // re-expanding kept showing the same stale error forever, with no way
  // to recover short of a full page reload. Collapsing and re-expanding
  // must retry.
  it("retries the fetch on a later expand after a failure, rather than latching the error forever", async () => {
    getResume.mockRejectedValueOnce(new Error("network down"));
    getResume.mockResolvedValueOnce({
      id: "resume-1",
      resumeText: "Recovered text.",
      resumeNickname: "Resume 1",
    });
    render(<MyResumes resumes={[makeSummary()]} />);

    const summaryEl = screen.getByText("Resume 1");
    fireEvent.click(summaryEl); // expand -- fails
    await waitFor(() => {
      expect(screen.getByText("Could not load resume text: network down")).toBeInTheDocument();
    });

    fireEvent.click(summaryEl); // collapse
    fireEvent.click(summaryEl); // expand again -- should retry, not stay latched

    await waitFor(() => {
      expect(screen.getByText("Recovered text.")).toBeInTheDocument();
    });
    expect(screen.queryByText("Could not load resume text: network down")).not.toBeInTheDocument();
    expect(getResume).toHaveBeenCalledTimes(2);
  });
});

// Ticket 7da6904, Nicole: "the numbers are seriously hopping around
// weirdly for me... go ahead and make them alphanumeric on the resume
// page too" (same fix ticket 336f1e6 already made to the "Change" picker,
// via the shared `sortResumesByNickname` helper).
describe("MyResumes — natural/numeric sort order (ticket 7da6904)", () => {
  it("renders resumes in natural/numeric nickname order, regardless of the input (createdAt) order", () => {
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-14", resumeNickname: "Resume 14" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
          makeSummary({ id: "resume-10", resumeNickname: "Resume 10" }),
        ]}
      />,
    );

    const nicknames = document.querySelectorAll(".resume-nickname");
    // Numeric order (1, 2, 10, 14) -- NOT the input order above, and NOT
    // plain string order, which would put "Resume 10"/"Resume 14" before
    // "Resume 2".
    expect(Array.from(nicknames, (el) => el.textContent)).toEqual([
      "Resume 1",
      "Resume 2",
      "Resume 10",
      "Resume 14",
    ]);
  });
});

// Ticket 1e183a4, Nicole: "the resume 13 should now become a link to the
// My Resumes page with that resume highlighted and the text already
// expanded." These tests exercise the `focusResume` prop a result card's
// link drives (via App.tsx) -- see FocusResume's own doc comment for why
// it carries a `token`, not just an id.
describe("MyResumes — focusResume (ticket 1e183a4)", () => {
  it("expands and fetches the named resume's text, and scrolls it into view", async () => {
    getResume.mockResolvedValue({
      id: "resume-2",
      resumeText: "Backend-focused resume text.",
      resumeNickname: "Backend-focused resume",
    });
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Backend-focused resume" }),
        ]}
        focusResume={{ id: "resume-2", token: 1 }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Backend-focused resume text.")).toBeInTheDocument();
    });
    expect(getResume).toHaveBeenCalledWith("resume-2");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    // Opus review, ticket 1e183a4 (required F1): "the text already
    // expanded" is Nicole's own explicit ask, not just "the text is
    // somewhere in the DOM" -- jsdom keeps a collapsed <details>'s children
    // in the DOM regardless of `open`, so the assertion above alone would
    // pass even if the row never actually expanded. This is the one that
    // actually pins it.
    expect(screen.getByText("Backend-focused resume").closest("details")).toHaveAttribute("open");
  });

  it("does not touch a row that isn't the focus target", () => {
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Backend-focused resume" }),
        ]}
        focusResume={{ id: "resume-2", token: 1 }}
      />,
    );

    expect(getResume).not.toHaveBeenCalledWith("resume-1");
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("applies a highlight class to the focused row, and removes it after the flash", async () => {
    vi.useFakeTimers();
    try {
      getResume.mockResolvedValue({
        id: "resume-1",
        resumeText: "Some text.",
        resumeNickname: "Resume 1",
      });
      render(
        <MyResumes
          resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
          focusResume={{ id: "resume-1", token: 1 }}
        />,
      );

      expect(screen.getByText("Resume 1").closest("li")).toHaveClass("resume-list-item-focused");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(screen.getByText("Resume 1").closest("li")).not.toHaveClass(
        "resume-list-item-focused",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole reason FocusResume carries a `token`, not just an id (ticket
  // 1e183a4): "My Resumes" stays mounted at all times, so clicking a
  // DIFFERENT card's link to the SAME resume while already on this tab
  // must still re-scroll/re-flash -- a naive effect keyed only on the id
  // would see no change and do nothing the second time.
  it("re-scrolls and re-flashes on a NEW token for the same resume id, even if already expanded", async () => {
    getResume.mockResolvedValue({
      id: "resume-1",
      resumeText: "Some text.",
      resumeNickname: "Resume 1",
    });
    const { rerender } = render(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        focusResume={{ id: "resume-1", token: 1 }}
      />,
    );
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledTimes(1));

    rerender(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        focusResume={{ id: "resume-1", token: 2 }}
      />,
    );

    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledTimes(2));
    // Only one fetch, though: the row was already expanded/loaded from the
    // first focus, and the fetch-once guard (ticket 303cff0) still applies.
    expect(getResume).toHaveBeenCalledTimes(1);
  });

  it("does not re-scroll on a re-render with the SAME token", async () => {
    getResume.mockResolvedValue({
      id: "resume-1",
      resumeText: "Some text.",
      resumeNickname: "Resume 1",
    });
    const focusResume = { id: "resume-1", token: 1 };
    const { rerender } = render(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        focusResume={focusResume}
      />,
    );
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledTimes(1));

    rerender(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        focusResume={focusResume}
      />,
    );

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ticket 6ba221e: editing a resume's TEXT from the resumes page. Nicole:
 * "On the resume page, I want them to be able to edit both the names of the
 * resumes and the resumes themselves."
 *
 * The NAME half is a separate ticket (e7666de) and is deliberately absent
 * here. These tests cover the text half, including the two things that make
 * an edit UI either trustworthy or not: a failed save must not lose the
 * user's typing, and a response that lands after Cancel must not resurrect
 * the editor.
 */
describe("MyResumes — editing resume text (ticket 6ba221e)", () => {
  /** Expands the one row and waits for its text to load. */
  async function expandAndLoad(text: string, nickname = "Resume 1") {
    getResume.mockResolvedValue({
      id: "resume-1",
      resumeText: text,
      resumeNickname: nickname,
      isLocked: false,
      suggestedTitles: [],
    });
    render(<MyResumes resumes={[makeSummary({ resumeNickname: nickname })]} />);
    fireEvent.click(screen.getByText(nickname));
    await waitFor(() => expect(screen.getByText(text)).toBeInTheDocument());
  }

  it("offers no editor until the row is expanded and its text has actually loaded", async () => {
    // Guards the specific hazard of opening a textarea over text that
    // hasn't arrived: a Save from there would write a placeholder (or an
    // empty string) over the real resume.
    getResume.mockReturnValue(new Promise(() => {})); // never resolves
    render(<MyResumes resumes={[makeSummary()]} />);
    expect(screen.queryByRole("button", { name: "Edit Resume 1 text" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Resume 1"));
    await waitFor(() => expect(screen.getByText("Loading resume text...")).toBeInTheDocument());
    // Still loading -- still no editor.
    expect(screen.queryByRole("button", { name: "Edit Resume 1 text" })).not.toBeInTheDocument();
  });

  it("saves edited text through updateResumeText and shows the server's own stored result", async () => {
    await expandAndLoad("the original resume text");
    updateResumeText.mockResolvedValue({
      id: "resume-1",
      resumeText: "the rewritten resume text",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "the rewritten resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-1", "the rewritten resume text"),
    );
    // Back to the read-only view, showing what the server says it stored.
    await waitFor(() => expect(screen.getByText("the rewritten resume text")).toBeInTheDocument());
    expect(screen.queryByLabelText("Resume text for Resume 1")).not.toBeInTheDocument();
    // The nickname is untouched -- the headline guarantee of this ticket.
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
  });

  it("Cancel discards the draft and restores the saved text, without saving anything", async () => {
    await expandAndLoad("the original resume text");

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "a draft the user abandons" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateResumeText).not.toHaveBeenCalled();
    expect(screen.getByText("the original resume text")).toBeInTheDocument();
    expect(screen.queryByText("a draft the user abandons")).not.toBeInTheDocument();
  });

  it("keeps the user's typing when a save fails, and shows why", async () => {
    await expandAndLoad("the original resume text");
    updateResumeText.mockRejectedValue(new Error("Network error"));

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "a long and hard-won rewrite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save resume text: Network error",
    );
    // THE PART THAT MATTERS: the rewrite is still in the box, editable.
    // Dropping it back to the saved text on failure would throw away work
    // the user cannot get back.
    expect(screen.getByLabelText("Resume text for Resume 1")).toHaveValue(
      "a long and hard-won rewrite",
    );
  });

  it("offers no Save button for empty text", async () => {
    await expandAndLoad("the original resume text");

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "   " },
    });

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("does not resurrect the editor when a save FAILS after the user already cancelled", async () => {
    await expandAndLoad("the original resume text");
    // A save that is still in flight when Cancel is clicked.
    let rejectSave: (err: Error) => void = () => {};
    updateResumeText.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "an abandoned rewrite" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Cancel stays enabled during a save deliberately (see the button's own
    // comment) -- this is the walk-away path.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      rejectSave(new Error("Network error"));
      await Promise.resolve();
    });

    // No error banner for an edit the user already walked away from, and no
    // textarea reopened under them.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resume text for Resume 1")).not.toBeInTheDocument();
    expect(screen.getByText("the original resume text")).toBeInTheDocument();
  });

  it("still records a save that SUCCEEDS after a cancel, rather than showing stale text", async () => {
    await expandAndLoad("the original resume text");
    let resolveSave: (value: unknown) => void = () => {};
    updateResumeText.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 1 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 1"), {
      target: { value: "a rewrite that lands late" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      resolveSave({
        id: "resume-1",
        resumeText: "a rewrite that lands late",
        resumeNickname: "Resume 1",
        suggestedTitles: [],
        isLocked: false,
      });
      await Promise.resolve();
    });

    // Cancel abandons the EDITOR, not the request -- the write really did
    // happen, so the view must show the new text rather than confidently
    // displaying text the database no longer has.
    expect(screen.getByText("a rewrite that lands late")).toBeInTheDocument();
    expect(screen.queryByLabelText("Resume text for Resume 1")).not.toBeInTheDocument();
  });

  it("edits the row it was clicked on, not another row with the same button label", async () => {
    // Every row renders a button with the same VISIBLE text ("Edit text"),
    // which is exactly how a per-row control gets wired to the wrong row.
    // The accessible names carry the nickname to make them distinguishable.
    getResume.mockImplementation((id: string) =>
      Promise.resolve({
        id,
        resumeText: `text of ${id}`,
        resumeNickname: id === "resume-1" ? "Resume 1" : "Resume 2",
        isLocked: false,
        suggestedTitles: [],
      }),
    );
    updateResumeText.mockResolvedValue({
      id: "resume-2",
      resumeText: "rewritten text of resume-2",
      resumeNickname: "Resume 2",
      suggestedTitles: [],
      isLocked: false,
    });
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Resume 1"));
    fireEvent.click(screen.getByText("Resume 2"));
    await waitFor(() => expect(screen.getByText("text of resume-2")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit Resume 2 text" }));
    fireEvent.change(screen.getByLabelText("Resume text for Resume 2"), {
      target: { value: "rewritten text of resume-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-2", "rewritten text of resume-2"),
    );
    // Resume 1 was never opened for editing and never saved.
    expect(updateResumeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText("text of resume-1")).toBeInTheDocument();
  });
});

/**
 * Ticket e7666de: the NAME half of Nicole's "edit both the names of the
 * resumes and the resumes themselves" -- ticket 6ba221e (tested above) did
 * the TEXT half. `PATCH /resumes/:id` has accepted a rename since ticket
 * 38a7598; nothing in the web app called it until now.
 *
 * Deliberately a SIBLING of `<details>`, not nested inside it like "Edit
 * text" -- the nickname needs no per-row fetch to gate on, so the control
 * is visible without expanding the row at all (first test below pins
 * that), and it is also not inside `<summary>`, which would need every
 * nested interactive element to suppress the native open/close toggle on
 * click.
 */
describe("MyResumes — renaming a resume's name (ticket e7666de)", () => {
  it("shows a Rename control for a COLLAPSED row, with an accessible name identifying which resume", () => {
    render(<MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} />);

    // Not expanded -- no text fetch, no open <details> -- and the control
    // is still there and keyboard-reachable.
    expect(getResume).not.toHaveBeenCalled();
    const renameButton = screen.getByRole("button", { name: "Rename Resume 1" });
    expect(renameButton).toBeInTheDocument();
    // The control sits OUTSIDE <details> as a sibling, deliberately (see
    // this describe block's own comment) -- confirm the row is genuinely
    // still collapsed, not merely that the button exists somewhere.
    expect(renameButton.closest("li")?.querySelector("details")).not.toHaveAttribute("open");
  });

  it("opens an editable field pre-filled with the current name, and Cancel discards it without saving", () => {
    render(<MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    const input = screen.getByLabelText("New name for Resume 1");
    expect(input).toHaveValue("Resume 1");

    fireEvent.change(input, { target: { value: "a name the user abandons" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateResumeNickname).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("New name for Resume 1")).not.toBeInTheDocument();
    // Back to showing the ORIGINAL name, not the abandoned draft.
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
  });

  it("offers no Save button for an empty/whitespace-only draft", () => {
    render(<MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "   " },
    });

    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("saves through updateResumeNickname and shows the server's own returned name, and refreshes the parent list", async () => {
    updateResumeNickname.mockResolvedValue({ id: "resume-1", resumeNickname: "Backend Resume" });
    const onRenamed = vi.fn();
    render(
      <MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} onRenamed={onRenamed} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "Backend Resume" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "Backend Resume"),
    );
    await waitFor(() => expect(screen.getByText("Backend Resume")).toBeInTheDocument());
    expect(screen.queryByLabelText("New name for Resume 1")).not.toBeInTheDocument();
    // The list-level refresh this row cannot do by itself (sort order lives
    // one level up, in App.tsx's `resumesListState`) -- see `onRenamed`'s
    // own doc comment in MyResumes.tsx.
    expect(onRenamed).toHaveBeenCalledTimes(1);
  });

  it("keeps the user's typed name and shows the error on a failed save (e.g. a collision), and does not refresh the parent list", async () => {
    updateResumeNickname.mockRejectedValue(new Error("This resume nickname is already in use."));
    const onRenamed = vi.fn();
    render(
      <MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} onRenamed={onRenamed} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "Resume 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save resume name: This resume nickname is already in use.",
    );
    // THE PART THAT MATTERS: the offending value is still in the box,
    // visible and fixable (the label itself still reads the OLD
    // committed name, since the rejected value never actually landed).
    expect(screen.getByLabelText("New name for Resume 1")).toHaveValue("Resume 2");
    expect(onRenamed).not.toHaveBeenCalled();
    // Ticket 7701534, Nicole: "it should do the red outline on the field."
    // `aria-invalid` is what index.css's red-outline rule keys on, so this
    // attribute IS the outline -- without it the collision shows only the
    // text alert here while the identical collision reddens the field on the
    // search page (ResumeInput.tsx). Asserted rather than assumed: the
    // re-review found that deleting the attribute left the entire web suite
    // green. Same idiom as `describe("aria-invalid (ticket 7701534)")` in
    // ResumeInput.test.tsx, which pins both directions.
    expect(screen.getByLabelText("New name for Resume 1")).toHaveAttribute("aria-invalid", "true");
  });

  // The other half of the pair. `aria-invalid="false"` is NOT the same as an
  // absent attribute -- it tells assistive tech "checked, and valid", and it
  // would also miss index.css's `[aria-invalid="true"]` selector. The
  // component uses `? true : undefined` so React omits it entirely; this
  // pins that rather than leaving it to survive a future refactor by luck.
  it("does not mark the rename field invalid when there is no error", () => {
    render(<MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));

    expect(screen.getByLabelText("New name for Resume 1")).not.toHaveAttribute("aria-invalid");
  });

  it("does not resurrect the editor when a save FAILS after the user already cancelled", async () => {
    let rejectSave: (err: Error) => void = () => {};
    updateResumeNickname.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    render(<MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "an abandoned rename" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      rejectSave(new Error("Network error"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("New name for Resume 1")).not.toBeInTheDocument();
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
  });

  it("still records a rename that SUCCEEDS after a cancel, rather than showing the stale name -- AND still tells the parent to refetch so sort order follows", async () => {
    let resolveSave: (value: unknown) => void = () => {};
    updateResumeNickname.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    // Opus review (ticket e7666de, F1): `onRenamed` must fire on this path
    // too, UNGATED by the cancel token, same as `displayNickname` just
    // below -- the token only gates the EDITOR's own open/closed state,
    // never the record of a write that actually landed. Without this, the
    // single most plausible "tidy-up" (moving `onRenamed?.()` below the
    // token check, to "match" the other two calls in `saveNickname`) slips
    // past every other test in this file: resume-2 ("Apple resume") renamed
    // to "Zebra resume" then Cancelled on a slow network would still show
    // "Zebra resume" in ITS OWN row (that part doesn't need `onRenamed`),
    // but `App.tsx`'s `resumesListState` -- the array `sortResumesByNickname`
    // actually sorts -- would never refetch, so the list would render
    // "Zebra resume" above "Banana resume" and stay wrong until something
    // UNRELATED happened to refetch it.
    const onRenamed = vi.fn();
    render(
      <MyResumes resumes={[makeSummary({ resumeNickname: "Resume 1" })]} onRenamed={onRenamed} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "a rename that lands late" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await act(async () => {
      resolveSave({ id: "resume-1", resumeNickname: "a rename that lands late" });
      await Promise.resolve();
    });

    expect(screen.getByText("a rename that lands late")).toBeInTheDocument();
    expect(screen.queryByLabelText("New name for Resume 1")).not.toBeInTheDocument();
    expect(onRenamed).toHaveBeenCalledTimes(1);
  });

  it("renames the row it was clicked on, not another row with the same button label", async () => {
    updateResumeNickname.mockResolvedValue({ id: "resume-2", resumeNickname: "Renamed Two" });
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 2" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 2"), {
      target: { value: "Renamed Two" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-2", "Renamed Two"),
    );
    // Found during this round's own verification (not a mutation --
    // flaked under load with no code change): `updateResumeNickname` is
    // called SYNCHRONOUSLY inside `saveNickname`, so the `waitFor` above
    // can resolve before the mocked promise's `.then()` has flushed
    // `setDisplayNickname` into the DOM. Waiting for the RENDERED result
    // (not just the mock call) before asserting against the DOM removes
    // that race, the same way the "saves through updateResumeNickname"
    // test above already does.
    await waitFor(() => expect(screen.getByText("Renamed Two")).toBeInTheDocument());
    expect(updateResumeNickname).toHaveBeenCalledTimes(1);
    // Resume 1 was never touched.
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
    expect(screen.queryByText("Resume 2")).not.toBeInTheDocument();
  });

  // Ticket 7da6904's natural/numeric sort has to keep working after a
  // rename moves a resume's position -- the row itself cannot do this (the
  // array `sortResumesByNickname` sorts lives one level up), so this pins
  // that the sort re-runs correctly once the PARENT passes down the
  // refreshed array (simulated here with `rerender`, standing in for
  // App.tsx's `onRenamed -> refreshResumesList -> GET /resumes` round trip).
  it("sorts the list correctly after a rename moves a resume's alphabetical position", async () => {
    updateResumeNickname.mockResolvedValue({ id: "resume-2", resumeNickname: "Zebra resume" });
    const onRenamed = vi.fn();
    const { rerender } = render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Banana resume" }),
          makeSummary({ id: "resume-2", resumeNickname: "Apple resume" }),
        ]}
        onRenamed={onRenamed}
      />,
    );
    // Pre-rename order: Apple, Banana.
    expect(
      Array.from(document.querySelectorAll(".resume-nickname"), (el) => el.textContent),
    ).toEqual(["Apple resume", "Banana resume"]);

    fireEvent.click(screen.getByRole("button", { name: "Rename Apple resume" }));
    fireEvent.change(screen.getByLabelText("New name for Apple resume"), {
      target: { value: "Zebra resume" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledTimes(1));

    // The parent refetches (App.tsx's `refreshResumesList`) and passes down
    // the updated array -- "resume-2" now sorts LAST. Deliberately handed
    // down in the OLD (now-wrong) order, "resume-2" first, so this only
    // passes if `MyResumes` actually re-sorts on this render rather than
    // happening to already be in the right order.
    rerender(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-2", resumeNickname: "Zebra resume" }),
          makeSummary({ id: "resume-1", resumeNickname: "Banana resume" }),
        ]}
        onRenamed={onRenamed}
      />,
    );

    expect(
      Array.from(document.querySelectorAll(".resume-nickname"), (el) => el.textContent),
    ).toEqual(["Banana resume", "Zebra resume"]);
  });

  // Opus review (ticket e7666de, F3): App.tsx's tabs are `hidden`, not
  // unmounted (ticket 303cff0) -- so a row here can stay mounted while the
  // user renames the SAME resume through a different surface (e.g.
  // ResumeInput.tsx's own nickname field, on the Search tab) and switches
  // back. Without the prop-sync effect this pins, this row would keep
  // showing whatever `displayNickname` was seeded with on mount, forever,
  // since nothing in THIS row's own code would ever run again for a rename
  // that happened somewhere else.
  it("updates the displayed name when the resumeNickname prop changes externally, without this row doing the renaming itself", () => {
    const { rerender } = render(
      <MyResumes resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]} />,
    );
    expect(screen.getByText("Resume 1")).toBeInTheDocument();

    // The SAME resume id, a new nickname -- as if App.tsx's `resumesListState`
    // had just refetched after a rename made elsewhere, with this row never
    // touching its own Rename control at all.
    rerender(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Renamed Elsewhere" })]}
      />,
    );

    expect(screen.getByText("Renamed Elsewhere")).toBeInTheDocument();
    expect(screen.queryByText("Resume 1")).not.toBeInTheDocument();
    // The Rename button's own accessible name tracks it too -- it is
    // sourced from the same `displayNickname`, not the stale prop value.
    expect(screen.getByRole("button", { name: "Rename Renamed Elsewhere" })).toBeInTheDocument();
  });
});

/**
 * Ticket 11ead86: the "Use {nickname}" activate action -- closes the two
 * dead ends recorded in that ticket's body (an active-but-unlocked
 * resume's "Edit" never reopens the picker; a stale restored `resumeId`
 * has no recovery path) by giving `MyResumes` its own activate affordance,
 * wired by `App.tsx` to the EXISTING `handleActivateResume` (ticket
 * 88f11d7) -- this component never calls any API itself for activation,
 * it only calls the `onActivateResume` prop, so these tests exercise the
 * prop contract directly rather than mocking `../api/client` a second way.
 *
 * `activeResumeId`/`isActive` decision, argued rather than copied from the
 * search-tab picker's `r.id !== resumeId` exclusion (see MyResumes.tsx's
 * own comment): the active row stays in the list as a plain "Active"
 * marker, not a button and not hidden.
 */
describe("MyResumes — activate action (ticket 11ead86)", () => {
  it("shows a 'Use {nickname}' button for every resume when none is active", () => {
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Use Resume 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Resume 2" })).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("shows a non-interactive 'Active' marker for the active resume's row, not a button", () => {
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
        activeResumeId="resume-1"
      />,
    );

    // The non-active row still offers the ordinary action.
    expect(screen.getByRole("button", { name: "Use Resume 2" })).toBeInTheDocument();
    // The active row does not -- it is NOT simply absent from the page
    // (this ticket's own argument against hiding it, unlike the search
    // tab's chooser), it renders a marker instead of a button.
    expect(screen.queryByRole("button", { name: "Use Resume 1" })).not.toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    // The row itself -- nickname, created date -- is still fully present.
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
  });

  it("fires onActivateResume with the clicked row's id, and that row's id alone", () => {
    const onActivateResume = vi.fn();
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
        onActivateResume={onActivateResume}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    expect(onActivateResume).toHaveBeenCalledTimes(1);
    expect(onActivateResume).toHaveBeenCalledWith("resume-2");
  });

  it("disables every 'Use' button while an activation is already in flight", () => {
    const onActivateResume = vi.fn();
    render(
      <MyResumes
        resumes={[
          makeSummary({ id: "resume-1", resumeNickname: "Resume 1" }),
          makeSummary({ id: "resume-2", resumeNickname: "Resume 2" }),
        ]}
        onActivateResume={onActivateResume}
        activating
      />,
    );

    const button = screen.getByRole("button", { name: "Use Resume 2" });
    expect(button).toBeDisabled();
    // A disabled native button does not fire its click handler at all --
    // pinning the END RESULT (handler never called), not just the
    // `disabled` attribute, so a future change that disables the button
    // only visually (e.g. CSS `pointer-events`) without the real
    // attribute would still be caught.
    fireEvent.click(button);
    expect(onActivateResume).not.toHaveBeenCalled();
  });

  // Acceptance criterion (ticket 11ead86): "Respects the same guards the
  // collapsed bar's 'Change' has where they apply -- in particular,
  // searching... changing resumes under a running search must be
  // prevented or clearly refused." Unlike the no-active-resume picker in
  // ResumeInput.tsx (provably unreachable mid-search per that file's own
  // comment), this list is a whole separate, always-mounted tab, so it
  // needs this gate for real.
  it("disables every 'Use' button and shows an explanatory note while a search is running", () => {
    const onActivateResume = vi.fn();
    render(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        onActivateResume={onActivateResume}
        searching
      />,
    );

    const button = screen.getByRole("button", { name: "Use Resume 1" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Can't change resumes while a search is running.")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onActivateResume).not.toHaveBeenCalled();
  });

  it("does not show the searching note or disable anything when a search is not running", () => {
    render(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        searching={false}
      />,
    );

    expect(
      screen.queryByText("Can't change resumes while a search is running."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Resume 1" })).not.toBeDisabled();
  });

  it("shows a single activation error as an alert, matching the search tab's own picker wording", () => {
    render(
      <MyResumes
        resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]}
        activateError="Could not reach the API"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load that resume: Could not reach the API",
    );
  });

  it("shows no error and no searching note when neither is set", () => {
    render(<MyResumes resumes={[makeSummary({ id: "resume-1", resumeNickname: "Resume 1" })]} />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
