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
 *
 * TICKET 6ba221e REVERSED THE SECOND HALF OF THAT. Duplicate text is legal
 * now ("Let them do that... that's their business"), so the blocking
 * duplicate-text error and its test are GONE -- see the describe block
 * below, which asserts the replacement behavior (an edit saves onto the
 * same resume) rather than leaving the removal untested. The
 * nickname-collision half is untouched and still asserted further down.
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
const updateResumeText = vi.fn();

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
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
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
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

describe("App — editing a resume's text saves onto the SAME resume (ticket 6ba221e)", () => {
  // THE REGRESSION TEST FOR NICOLE'S OWN REPORT: "if I'm on resume one and
  // I make an edit and I hit save and it's still called resume one, it
  // actually becomes resume 2." This test used to assert the opposite
  // behavior (that the resubmit went to `createResume` carrying
  // `currentResumeId`), which is precisely the bug.
  it("routes an unlocked resume's re-submit to updateResumeText, never createResume", async () => {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });
    updateResumeText.mockResolvedValue({
      id: "resume-1",
      resumeText: "second version of the text",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    render(<App />);
    await submitResume("first version of the text");
    // A FIRST paste is still a create, and it no longer passes a second
    // argument at all (`currentResumeId` is gone from the client).
    await waitFor(() => expect(createResume).toHaveBeenCalledWith("first version of the text"));

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "second version of the text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-1", "second version of the text"),
    );
    // The point: no second resume was created. One `createResume` call
    // total, the first paste.
    expect(createResume).toHaveBeenCalledTimes(1);
    // And the nickname is unchanged -- no "Resume 2".
    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());
  });

  // The one case that must stay a CREATE even though a resumeId is active:
  // the locked resume's picker offering "Paste a new resume". Routing this
  // to `updateResumeText` would overwrite the very resume the user just
  // declined to reuse.
  it("the locked picker's 'Paste a new resume' still creates a new resume, it does not overwrite the locked one", async () => {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume
      .mockResolvedValueOnce({
        id: "resume-1",
        resumeNickname: "Resume 1",
        suggestedTitles: [],
        // Already locked on arrival -- the same shape `POST /resumes`
        // returns for text that resolved to an already-searched resume.
        isLocked: true,
      })
      .mockResolvedValueOnce({
        id: "resume-2",
        resumeNickname: "Resume 2",
        suggestedTitles: [],
        isLocked: false,
      });

    render(<App />);
    await submitResume("the locked resume's text");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change resume" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "a brand new resume's text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(createResume).toHaveBeenCalledWith("a brand new resume's text"));
    expect(updateResumeText).not.toHaveBeenCalled();
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
