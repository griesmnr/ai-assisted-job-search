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

// Ticket 303cff0 ("My Resumes" tab): mocked the same way ResultCard.test.tsx
// mocks ../api/client, so this component-level test never makes a real
// network call -- only `getResume` (fetched lazily on row-expand) is
// exercised here; `listResumes` is App.tsx's own concern, tested there.
vi.mock("../api/client", () => ({
  getResume: (...args: unknown[]) => getResume(...args),
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
