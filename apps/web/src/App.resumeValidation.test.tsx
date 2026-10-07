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

  /**
   * Fable review of 6ba221e, F1: a REGRESSION this ticket introduced, now
   * fixed and pinned here.
   *
   * `resumeId` survives a reload via sessionStorage, and nothing clears it
   * when the row it names is gone -- the mount-only hydration effect's
   * `getResume` failure is swallowed by design (App.tsx), so `resumeLocked`
   * stays `false` and the collapsed bar still reads "Using Resume 1" with an
   * "Edit" button. A dev-database reset is the realistic way there, and this
   * project's own container-versus-sandbox-Postgres topology makes it
   * routine.
   *
   * Before this ticket the submit from that state was a POST, which created a
   * fresh row and healed the session by accident. Routing edits to
   * `PUT /resumes/:id/text` closed that escape hatch: every submit 404'd, on
   * every retry, with no way out short of clearing sessionStorage by hand.
   *
   * The reload is modelled the way this repo's persistence tests already
   * model it (cleanup, then render again with sessionStorage untouched -- see
   * App.persistence.test.tsx's header). `getResume` is mocked to reject for
   * the whole file, which IS the "that resume is gone" condition.
   */
  it("recovers when a restored resumeId names a row that no longer exists, instead of 404ing forever", async () => {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    render(<App />);
    await submitResume("the text that was saved before the database was reset");
    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());

    // THE RELOAD. sessionStorage still holds resumeId "resume-1"; the row
    // behind it does not exist any more.
    cleanup();
    createResume.mockClear();
    createResume.mockResolvedValue({
      id: "resume-7",
      resumeNickname: "Resume 7",
      suggestedTitles: [],
      isLocked: false,
    });
    const notFound = Object.assign(new Error('No resume with id "resume-1".'), { status: 404 });
    updateResumeText.mockRejectedValue(notFound);
    render(<App />);

    // Restored into the collapsed, unlocked state -- which is precisely what
    // makes the next submit take the edit path.
    expect(await screen.findByText("Using Resume 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "text typed after the reset" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The edit was tried first (correct -- as far as this tab knew, it had a
    // resume), 404'd, and fell back to creating one.
    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-1", "text typed after the reset"),
    );
    await waitFor(() => expect(createResume).toHaveBeenCalledWith("text typed after the reset"));

    // SELF-HEALING, which is the whole point: the session now holds the NEW
    // id, the user sees a real resume, and no error is left on screen.
    await waitFor(() => expect(screen.getByText("Using Resume 7")).toBeInTheDocument());
    expect(screen.queryByText(/Could not save resume/)).not.toBeInTheDocument();
  });

  // The narrowness guard. Converting ANY failed edit into a new resume would
  // reintroduce the surprise this whole ticket removes ("I edited Resume 1
  // and got Resume 2"), so only a 404 -- "the resume I was editing is gone"
  // -- may fall back.
  it("does NOT turn a non-404 edit failure into a new resume", async () => {
    getSources.mockResolvedValue(SOURCES);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    render(<App />);
    await submitResume("first version of the text");
    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());
    createResume.mockClear();

    updateResumeText.mockRejectedValue(
      Object.assign(new Error("resumeText exceeds the 200000-character limit (got 200001)."), {
        status: 400,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "a rewrite the server rejects for its own reasons" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // Surfaces as a real, visible error -- and creates nothing.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save resume: resumeText exceeds the 200000-character limit",
    );
    expect(createResume).not.toHaveBeenCalled();
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
