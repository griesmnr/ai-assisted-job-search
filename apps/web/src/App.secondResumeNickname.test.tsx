// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * TICKET d7d3d59 -- the SECOND resume of a session.
 *
 * Found by the opus adversarial review of 3db5b35. Both halves came from one
 * cause: `resumeId` is never cleared, so the locked picker's "Paste a new
 * resume" ran the whole expanded form -- nickname field included -- against a
 * `resumeId` that still named the PREVIOUS resume.
 *
 *   1. The nickname field showed the previous resume's REAL nickname instead
 *      of a "Resume N+1" suggestion, because 3db5b35's seeding effect refused
 *      to run while `resumeId` was defined and its one-shot ref never re-armed.
 *   2. (The data-loss half, pre-existing rather than introduced by 3db5b35.)
 *      Typing a name there and blurring PATCHed `resumeId` -- renaming the
 *      resume the user had just declined to reuse, with no error and no sign
 *      anything had happened.
 *
 * The fix keeps `resumeId` meaning "the resume this session is actively using"
 * and adds `pastingNewResume` for the new distinction -- see that state's own
 * doc comment in App.tsx for why clearing `resumeId` instead would reproduce
 * ticket 3f05144 (sessionStorage wiped), unmount SearchFlow mid-poll, and
 * delete the form's only "Cancel".
 *
 * These tests live in their own file deliberately: ticket d7d3d59's acceptance
 * criteria require 3db5b35's and 6ba221e's own tests to keep passing
 * UNMODIFIED, so neither of those files is touched here, not even to append.
 *
 * Every assertion about a rename reads what `updateResumeNickname` actually
 * RECEIVED, never what the field displays -- the displayed value was never the
 * broken part.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const updateResumeNickname = vi.fn();
const updateResumeText = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResume: (...args: unknown[]) => getResume(...args),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: vi.fn(),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
  estimateSearch: vi.fn(),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  startSearch: vi.fn(),
  getSearchStatus: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

/**
 * The owner's real starting point for this bug: two saved resumes, the first
 * of which she renamed herself (so a rename of it is visibly destructive, not
 * just a "Resume 1" -> "Resume 1" no-op), and that first one is the ACTIVE,
 * LOCKED resume -- locked being the only way the picker's "Paste a new
 * resume" is reachable at all (ticket 88f11d7).
 */
const TWO_SAVED_RESUMES: ListResumesResponse = {
  resumes: [
    { id: "resume-1", resumeNickname: "My federal resume", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
  ],
};

/**
 * Gets to the state the bug lives in: the locked "My federal resume" active,
 * the picker open, then the ordinary expanded paste form reached via "Paste a
 * new resume".
 */
async function openPasteNewForm() {
  getSources.mockResolvedValue(SOURCES);
  getAllResults.mockResolvedValue({ results: [] });
  getResults.mockResolvedValue({
    resumeId: "resume-1",
    resumeNickname: "My federal resume",
    results: [],
  });
  listResumes.mockResolvedValue(TWO_SAVED_RESUMES);
  // `isNew: false` -- this paste resolved to the row she already had, which is
  // also why `resumeNickname` is her own chosen name rather than a default.
  createResume.mockResolvedValueOnce({
    id: "resume-1",
    resumeNickname: "My federal resume",
    suggestedTitles: [],
    isLocked: true,
    isNew: false,
  });

  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "the text of the resume she already saved" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));

  expect(await screen.findByText("Using My federal resume")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
  fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));
}

describe("App — the second resume's nickname suggestion (ticket d7d3d59)", () => {
  it("suggests the NEXT nickname when 'Paste a new resume' opens, not the previous resume's own name", async () => {
    await openPasteNewForm();

    // "Resume 3": two already-saved resumes + 1, via the shared
    // `nextResumeNicknameFor` the server itself uses at insert time. Before
    // this ticket the field showed "My federal resume" here -- the ACTIVE
    // resume's real name, offered as the name for a resume that does not
    // exist yet.
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));
    expect(screen.getByLabelText("Resume Nickname")).not.toHaveValue("My federal resume");
  });

  // The suggestion must be re-armed, not one-shot: 3db5b35's ref was set once
  // at mount and never again, which is half of why the second resume got
  // nothing. Cancelling back out and reopening the form proves the re-arming
  // happens per paste-new, not once per session.
  it("re-arms the suggestion on a SECOND 'Paste a new resume', and Cancel restores the active resume's real name in between", async () => {
    await openPasteNewForm();
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));

    // Cancel: nothing was created, so the active resume -- and its own real
    // nickname -- are back, suggestion discarded.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Using My federal resume")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));
  });
});

describe("App — naming the new resume never touches the previous one (ticket d7d3d59)", () => {
  // THE DATA-LOSS HALF. The whole proof is in what the API received: before
  // the fix, this blur fired `PATCH /resumes/resume-1` and renamed "My federal
  // resume" to "Backend 2026" -- the resume the user had explicitly declined
  // to reuse one click earlier.
  it("typing a nickname for the new resume and blurring sends NO rename request at all", async () => {
    await openPasteNewForm();
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));

    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Backend 2026" } });
    fireEvent.blur(nicknameField);

    // A PATCH, if one were fired, is fired synchronously from the blur handler
    // -- but flush anyway so "nothing happened" cannot just mean "nothing has
    // happened YET" (the failure mode an earlier ticket's review caught in a
    // test that asserted before the promise under test had settled).
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updateResumeNickname).not.toHaveBeenCalled();
    // Stated the second way too, so the assertion names the actual hazard
    // rather than only its symptom: resume-1 specifically was never the
    // target of a rename.
    expect(updateResumeNickname.mock.calls.map((call) => call[0])).not.toContain("resume-1");
    // The typed value stays in the field -- it is local state now, waiting for
    // the submit to give it a real row to attach to, exactly as it already
    // behaved before a FIRST save.
    expect(nicknameField).toHaveValue("Backend 2026");
  });

  it("submitting the new resume then saves it under the typed name, against the NEW resume's id", async () => {
    await openPasteNewForm();
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));

    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Backend 2026" },
    });
    fireEvent.blur(screen.getByLabelText("Resume Nickname"));

    // The genuinely new row: `isNew: true` is the server's own proof that THIS
    // request inserted it (3db5b35's F1 fix), which is what makes applying the
    // typed name safe.
    createResume.mockResolvedValueOnce({
      id: "resume-2",
      resumeNickname: "Resume 3",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });
    updateResumeNickname.mockResolvedValue({ id: "resume-2", resumeNickname: "Backend 2026" });
    getResults.mockResolvedValue({
      resumeId: "resume-2",
      resumeNickname: "Backend 2026",
      results: [],
    });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "a brand new resume's text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // A CREATE, not an overwrite of the locked resume (6ba221e's rule, still
    // holding), and the rename lands on the new id.
    await waitFor(() => expect(createResume).toHaveBeenCalledWith("a brand new resume's text"));
    expect(updateResumeText).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-2", "Backend 2026"),
    );
    expect(updateResumeNickname).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Using Backend 2026")).toBeInTheDocument();
  });

  // The flag that says "a human typed in this field" used to latch `true`
  // forever, on the documented grounds that its only reader could not be
  // reached twice. Widening that reader to the second resume broke the
  // premise: a name typed for the FIRST resume would otherwise be read as
  // intent for the SECOND, and the client's own stale guess would be PATCHed
  // over whatever the server actually assigned.
  it("does not rename the new resume to a stale guess just because the user named the PREVIOUS resume earlier", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "My federal resume",
      results: [],
    });
    // Empty at first, so the pre-save suggestion is "Resume 1"; refreshed
    // after the first save to the one real row.
    listResumes.mockResolvedValueOnce({ resumes: [] } satisfies ListResumesResponse);
    listResumes.mockResolvedValue({
      resumes: [
        {
          id: "resume-1",
          resumeNickname: "My federal resume",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } satisfies ListResumesResponse);
    createResume.mockResolvedValueOnce({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      // Locked on arrival -- the shape `POST /resumes` returns for text that
      // resolved to an already-searched resume, and the only way to reach the
      // picker below.
      isLocked: true,
      isNew: true,
    });
    updateResumeNickname.mockResolvedValueOnce({
      id: "resume-1",
      resumeNickname: "My federal resume",
    });

    render(<App />);
    // FIRST resume: she types her own name for it. This is what latches the
    // "user edited the nickname" flag.
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "My federal resume" },
    });
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "her first resume's text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "My federal resume"),
    );
    expect(await screen.findByText("Using My federal resume")).toBeInTheDocument();

    // SECOND resume, via the picker. The field seeds "Resume 2" and she never
    // touches it.
    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 2"));

    // The server disagrees with the guess -- another session inserted a row in
    // between, so the real default is "Resume 3". That disagreement is NOT
    // evidence of intent (3db5b35's F1), and with the field untouched for this
    // resume there is no intent to act on at all.
    createResume.mockResolvedValueOnce({
      id: "resume-2",
      resumeNickname: "Resume 3",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });
    getResults.mockResolvedValue({ resumeId: "resume-2", resumeNickname: "Resume 3", results: [] });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "her second resume's text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The server's real default stands, and the only rename this session ever
    // sent is the one she actually asked for, on the first resume.
    expect(await screen.findByText("Using Resume 3")).toBeInTheDocument();
    expect(updateResumeNickname).toHaveBeenCalledTimes(1);
    expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "My federal resume");
  });

  // The flow has to END when the save lands, not merely start correctly: from
  // that moment `resumeId` names the resume the form was composing, so the
  // nickname field is editing a real row again and a submit is an edit of it.
  // A `pastingNewResume` left `true` here would silently swallow every later
  // rename AND route every later text edit to `POST /resumes`, minting a
  // duplicate row each time -- the exact regression ticket 6ba221e exists to
  // have fixed.
  it("once the new resume is saved, editing it behaves as an ordinary edit -- a text PUT and a working rename", async () => {
    await openPasteNewForm();
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));

    createResume.mockResolvedValueOnce({
      id: "resume-2",
      resumeNickname: "Resume 3",
      suggestedTitles: [],
      isLocked: false,
      isNew: true,
    });
    getResults.mockResolvedValue({ resumeId: "resume-2", resumeNickname: "Resume 3", results: [] });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "a brand new resume's text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Using Resume 3")).toBeInTheDocument();
    expect(createResume).toHaveBeenCalledTimes(2);

    // A rename of the resume that now exists DOES reach the API.
    updateResumeNickname.mockResolvedValue({ id: "resume-2", resumeNickname: "Backend 2026" });
    updateResumeText.mockResolvedValue({
      id: "resume-2",
      resumeText: "the new resume's revised text",
      resumeNickname: "Backend 2026",
      suggestedTitles: [],
      isLocked: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Backend 2026" } });
    fireEvent.blur(nicknameField);
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-2", "Backend 2026"),
    );

    // And a text edit saves ONTO that resume rather than creating a third.
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "the new resume's revised text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-2", "the new resume's revised text"),
    );
    expect(createResume).toHaveBeenCalledTimes(2);
  });

  // Cancelling out of "paste a new resume" has to put the nickname field back
  // in working order, not just restore its value: the flag that makes the
  // field refuse to commit is session state, and a stale `true` would silently
  // swallow every later rename. Reachable because activating an UNLOCKED
  // resume gives the collapsed bar an "Edit" button again.
  it("after cancelling out of 'paste a new resume', renaming a later-activated resume still reaches the API", async () => {
    await openPasteNewForm();
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Using My federal resume")).toBeInTheDocument();

    // Pick the other saved resume, which has never been searched -- so it is
    // editable, and its nickname is renameable through the expanded form.
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own text",
      resumeNickname: "Resume 8",
      isLocked: false,
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({ resumeId: "resume-8", resumeNickname: "Resume 8", results: [] });
    updateResumeNickname.mockResolvedValue({ id: "resume-8", resumeNickname: "Analyst resume" });

    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    expect(await screen.findByText("Using Resume 8")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    const nicknameField = screen.getByLabelText("Resume Nickname");
    expect(nicknameField).toHaveValue("Resume 8");
    fireEvent.change(nicknameField, { target: { value: "Analyst resume" } });
    fireEvent.blur(nicknameField);

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-8", "Analyst resume"),
    );
  });
});
