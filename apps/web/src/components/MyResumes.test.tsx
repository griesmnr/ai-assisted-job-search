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

// Ticket 303cff0 ("My Resumes" tab): mocked the same way ResultCard.test.tsx
// mocks ../api/client, so this component-level test never makes a real
// network call -- only `getResume` (fetched lazily on row-expand) is
// exercised here; `listResumes` is App.tsx's own concern, tested there.
vi.mock("../api/client", () => ({
  getResume: (...args: unknown[]) => getResume(...args),
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
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
