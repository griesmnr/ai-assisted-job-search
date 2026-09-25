// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 7701534, Nicole: nickname collisions and duplicate resume text
 * both need to become real, visible, blocking errors on the paste form --
 * "This resume nickname is already in use" with a red-outlined field, and
 * "This resume has the exact same text as Resume 8... you can't save an
 * identical resume."
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();
const updateResumeNickname = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: () => Promise.resolve({ resumes: [] }),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};
const EMPTY_RESULTS = { results: [] };

async function submitResume(text = "some resume text") {
  fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
}

describe("App — duplicate resume text (ticket 7701534)", () => {
  it("passes the currently active resumeId as currentResumeId on a resubmission", async () => {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });

    render(<App />);
    await submitResume("first version of the text");
    await waitFor(() =>
      expect(createResume).toHaveBeenCalledWith("first version of the text", undefined),
    );

    // Re-open for editing and resubmit -- the second call must carry the
    // resumeId this same session already has active.
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "second version of the text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));

    await waitFor(() =>
      expect(createResume).toHaveBeenCalledWith("second version of the text", "resume-1"),
    );
  });

  it("shows a blocking, red-styled error naming the existing resume, and does NOT adopt it as active", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockRejectedValue(
      Object.assign(
        new Error(
          'This resume has the exact same text as an already-saved resume, "Resume 8". You can\'t save it again as a new resume.',
        ),
        {
          status: 409,
          body: {
            error:
              'This resume has the exact same text as an already-saved resume, "Resume 8". You can\'t save it again as a new resume.',
            duplicateResumeId: "resume-8",
            duplicateResumeNickname: "Resume 8",
          },
        },
      ),
    );

    render(<App />);
    await submitResume();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      'Could not save resume: This resume has the exact same text as an already-saved resume, "Resume 8"',
    );
    expect(alert).toHaveClass("resume-error");

    // Not adopted: the sources/criteria section (gated on a real resumeId)
    // never appears, and the paste box is still the full editable form.
    expect(screen.queryByText(/Which sources do you want to search/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
  });

  it("a genuinely new resume's first submission is unaffected", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });

    render(<App />);
    await submitResume();

    await waitFor(() => {
      expect(screen.getByText(/Which sources do you want to search/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Could not save resume/)).not.toBeInTheDocument();
  });
});

describe("App — nickname collision (ticket 7701534)", () => {
  async function getToNicknameField() {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });

    render(<App />);
    await submitResume();
    // A successful submit collapses the form to the "Using {nickname}"
    // summary bar (ticket ac141d0) -- the nickname field only renders in
    // the expanded form, reached via "Edit".
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit resume" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toBeInTheDocument());
  }

  it("does NOT revert the field, and marks it invalid, on a nickname-collision failure", async () => {
    await getToNicknameField();
    updateResumeNickname.mockRejectedValue(
      Object.assign(new Error("This resume nickname is already in use."), {
        status: 409,
        body: { error: "This resume nickname is already in use.", reason: "nickname_conflict" },
      }),
    );

    const input = screen.getByLabelText("Resume Nickname");
    fireEvent.change(input, { target: { value: "Taken Nickname" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save nickname: This resume nickname is already in use.",
      );
    });
    // The offending value stays, visible and fixable -- not reverted.
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Taken Nickname");
    expect(screen.getByLabelText("Resume Nickname")).toHaveAttribute("aria-invalid", "true");
  });

  // Opus review round 1, required F1: Cancelling out of a rejected
  // nickname collision used to strand it -- the collapsed summary bar
  // confidently read "Using Taken Nickname" (a value the server never
  // accepted), with the error gone too (it only renders inside the
  // expanded form, which Cancel unmounts). Cancel must discard the
  // unsaved nickname exactly as it already discards unsaved resume text.
  it("Cancel after a rejected nickname collision reverts to the last SAVED nickname, not the rejected one", async () => {
    await getToNicknameField();
    updateResumeNickname.mockRejectedValue(
      Object.assign(new Error("This resume nickname is already in use."), {
        status: 409,
        body: { error: "This resume nickname is already in use.", reason: "nickname_conflict" },
      }),
    );

    const input = screen.getByLabelText("Resume Nickname");
    fireEvent.change(input, { target: { value: "Taken Nickname" } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Collapsed bar shows the real, server-confirmed nickname -- never
    // the rejected attempt.
    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.queryByText(/Taken Nickname/)).not.toBeInTheDocument();

    // And re-opening for another edit starts clean -- no stale error, no
    // stale rejected value sitting in the field.
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("DOES revert the field on a non-collision nickname failure (e.g. a network error)", async () => {
    await getToNicknameField();
    updateResumeNickname.mockRejectedValue(new Error("Could not reach the API"));

    const input = screen.getByLabelText("Resume Nickname");
    fireEvent.change(input, { target: { value: "Attempted Rename" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save nickname: Could not reach the API",
      );
    });
    // Unlike a collision, there's nothing wrong with THIS value -- only
    // the request -- so the existing revert-to-last-saved behavior stands.
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1");
  });

  it("a successful rename is unaffected -- no error, no invalid marking", async () => {
    await getToNicknameField();
    updateResumeNickname.mockResolvedValue({ id: "resume-1", resumeNickname: "New Name" });

    const input = screen.getByLabelText("Resume Nickname");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("New Name"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Resume Nickname")).not.toHaveAttribute("aria-invalid");
  });
});
