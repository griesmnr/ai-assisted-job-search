// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeSummary } from "@app/shared";
import { MyResumes } from "./MyResumes";

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
});
