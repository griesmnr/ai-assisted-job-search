// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetResumeResultsResponse,
  GetSourcesResponse,
  ListResumesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 582ee40 -- Nicole hit this live: standing in the resume form,
 * pressed "Edit" on an active-but-UNLOCKED resume, and got the paste form
 * back with no way to switch which resume she was using. Ticket 11ead86 gave
 * "My Resumes" its own "Use {nickname}" action, which is a real fix for a
 * DIFFERENT dead end (a stale restored `resumeId`) but, per that ticket's own
 * review, "acceptable as *a* path, not *the* path" -- it does not touch the
 * click she actually made. This file is the integration coverage for the fix
 * that does: widening ResumeInput.tsx's existing "Use a saved resume" picker
 * (ticket e2b5f9c) so it also renders once a resume is already active, via
 * an unlocked "Edit".
 *
 * Component-level coverage of the widened gate itself (including the
 * active-row exclusion and the still-excluded "Paste a new resume" case)
 * lives in ResumeInput.test.tsx. This file proves the WIRING: that the
 * picker really appears from "Edit" in the real app, that picking a
 * different resume there really activates it and leaves the user able to
 * search, and that `handleActivateResume`'s state resets -- re-audited for
 * this ticket per its own instructions, not assumed from the other two
 * callers -- hold for this third entry point too.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const updateResumeNickname = vi.fn();
const updateResumeText = vi.fn();
const estimateSearch = vi.fn();

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
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
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

function emptyResultsFor(resumeId: string, nickname: string): GetResumeResultsResponse {
  return { resumeId, resumeNickname: nickname, results: [] };
}

async function submitResume(text = "some resume text") {
  fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

/**
 * Gets to the exact state Nicole hit live: one other saved resume exists,
 * "resume-1" is active and UNLOCKED (never searched), and "Edit" has just
 * been clicked -- the dead end this ticket exists to close.
 */
async function getToEditFormWithOtherSavedResume() {
  getSources.mockResolvedValue(SOURCES);
  listResumes.mockResolvedValue({
    resumes: [
      { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
    ],
  } satisfies ListResumesResponse);
  getAllResults.mockResolvedValue({ results: [] });
  getResults.mockImplementation((id: string) =>
    Promise.resolve(
      id === "resume-8"
        ? emptyResultsFor("resume-8", "Resume 8")
        : emptyResultsFor("resume-1", "Resume 1"),
    ),
  );
  createResume.mockResolvedValue({
    id: "resume-1",
    resumeNickname: "Resume 1",
    suggestedTitles: [],
    isLocked: false, // UNLOCKED -- this is the route that dead-ended
  });

  render(<App />);
  await submitResume();
  fireEvent.click(await screen.findByRole("button", { name: "Edit resume" }));
  expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
}

describe("App — the saved-resume picker reappears on 'Edit' (ticket 582ee40)", () => {
  it("shows the saved-resume picker in the paste form after 'Edit' on an active UNLOCKED resume", async () => {
    await getToEditFormWithOtherSavedResume();

    expect(screen.getByText("Use a saved resume:")).toBeVisible();
    expect(screen.getByRole("button", { name: "Use Resume 8" })).toBeVisible();
    // Addition, not replacement -- the paste form is still right there too.
    expect(screen.getByLabelText("Paste your resume")).toBeVisible();
  });

  // The active-row decision this ticket had to make and comment: this list
  // is a CHOOSER (same as the locked "Change" picker elsewhere in this same
  // component), not a browsable inventory like My Resumes -- so the active
  // resume itself is excluded, not shown with a non-interactive marker.
  it("excludes the active resume itself from the reappeared picker", async () => {
    await getToEditFormWithOtherSavedResume();

    expect(screen.queryByRole("button", { name: "Use Resume 1" })).not.toBeInTheDocument();
  });

  it("picking a different resume from the reappeared picker activates it via GET /resumes/:id, never a new POST", async () => {
    await getToEditFormWithOtherSavedResume();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own full text",
      resumeNickname: "Resume 8",
      isLocked: false,
      suggestedTitles: ["Data Analyst"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    await waitFor(() => expect(getResume).toHaveBeenCalledWith("resume-8"));
    // Acceptance criterion: lands back on a usable collapsed bar for the
    // newly-picked resume -- the edit form and its picker are both gone.
    expect(await screen.findByText("Using Resume 8")).toBeVisible();
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Resume 8" })).not.toBeInTheDocument();
    // A pure pick, never a paste.
    expect(createResume).toHaveBeenCalledTimes(1);
  });

  // Acceptance criterion: "Selecting a resume activates it and the user can
  // run a search with it" -- not just that the collapsed bar updates.
  it("leaves the sources/criteria/search section usable after activating from the reappeared picker", async () => {
    await getToEditFormWithOtherSavedResume();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own full text",
      resumeNickname: "Resume 8",
      isLocked: false,
      suggestedTitles: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    await screen.findByText("Using Resume 8");

    // The whole sources/criteria/search block is `hidden` while editing
    // (ac141d0) -- proving it is reachable and functional now is the real
    // test, not just that the collapsed bar's text changed.
    fireEvent.click(screen.getByLabelText(/Any location/));
    const estimateButton = screen.getByRole("button", { name: "Estimate search cost" });
    expect(estimateButton).toBeVisible();
    expect(estimateButton).not.toBeDisabled();
  });

  /**
   * Re-audit of `handleActivateResume`'s state resets against this THIRD
   * entry point (ticket 582ee40's own instruction, after ticket 11ead86's
   * blocking review found the handler didn't clear `pastingNewResume` for
   * the second one). `pastingNewResume` is already `false` for every click
   * reachable through this picker -- it is gated on `!pastingNewResume` --
   * so there is no live bug here the way there was for the second caller.
   * These two tests prove that holds, not just assert it: a rename and a
   * text edit on the newly-activated resume both still reach the server,
   * which is exactly what a resurrected `pastingNewResume === true` would
   * have silently broken (ticket 6ba221e's own report, restored through
   * ticket 11ead86's door).
   */
  it("lets a rename on the resume activated via the reappeared picker actually reach the server", async () => {
    await getToEditFormWithOtherSavedResume();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own full text",
      resumeNickname: "Resume 8",
      isLocked: false,
      suggestedTitles: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    await screen.findByText("Using Resume 8");

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    updateResumeNickname.mockResolvedValue({ id: "resume-8", resumeNickname: "Backend resume" });
    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Backend resume" } });
    fireEvent.blur(nicknameField);

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-8", "Backend resume"),
    );
  });

  it("routes a text edit on the resume activated via the reappeared picker through updateResumeText, not a surprise createResume", async () => {
    await getToEditFormWithOtherSavedResume();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own full text",
      resumeNickname: "Resume 8",
      isLocked: false,
      suggestedTitles: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    await screen.findByText("Using Resume 8");

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    updateResumeText.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's edited text",
      resumeNickname: "Resume 8",
      suggestedTitles: [],
      isLocked: false,
    });
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "resume 8's edited text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-8", "resume 8's edited text"),
    );
    // Only the ORIGINAL resume-1 submission ever called createResume.
    expect(createResume).toHaveBeenCalledTimes(1);
  });

  // Regression guard: the locked picker's OWN "Paste a new resume" exit
  // (pastingNewResume === true) must still NOT re-offer this list -- the
  // user just explicitly declined it one click ago. Already covered by
  // App.resumeLock.test.tsx; re-asserted here because it is the one case
  // this ticket's widened gate must NOT also open.
  it("still does not show the saved list after the locked picker's 'Paste a new resume'", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue(emptyResultsFor("resume-1", "Resume 1"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true, // LOCKED -- "Change" is the only route in
    });

    render(<App />);
    await submitResume();
    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
    expect(screen.queryByText("Use a saved resume:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Resume 8" })).not.toBeInTheDocument();
  });
});
