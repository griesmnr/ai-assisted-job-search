// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 3db5b35 (reverses 5a79aa4/cdc2c39 -- see ResumeInput.tsx's
 * top-of-file doc comment and App.tsx's `handleResumeSubmit` comment for
 * the full argument). Jay's feedback, relayed by Nicole: "I want users to
 * be able to see the field where the nickname is pasted, put in whatever
 * your suggestion is, but then let them edit it even before saving it."
 *
 * These tests cover the NEW behavior end to end, through `App`, not just
 * `ResumeInput` in isolation: a pre-save suggestion derived from the
 * already-loaded resumes list, an edited nickname actually reaching
 * `updateResumeNickname` (not just the field's own displayed value), the
 * no-op case where the suggestion is left alone, and a first-save
 * nickname collision staying visible instead of being silently swallowed
 * by the post-save collapse.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const updateResumeNickname = vi.fn();
const updateResumeText = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
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
const EMPTY_RESULTS = { results: [] };

function mockBaseline() {
  getSources.mockResolvedValue(SOURCES);
  getAllResults.mockResolvedValue(EMPTY_RESULTS);
  getResults.mockResolvedValue({ resumeId: "resume-3", resumeNickname: "Resume 3", results: [] });
}

describe("App — pre-save nickname suggestion (ticket 3db5b35)", () => {
  it("pre-fills the nickname field with a suggestion derived from the already-loaded resumes list, before any resume is ever saved", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);

    render(<App />);

    // Before any submission -- no resumeId exists yet, and no createResume
    // call has happened. The suggestion is "Resume 3": one more than the
    // two already-loaded resumes, the same formula the server itself uses
    // (apps/api/src/matching/pipeline.ts's `getOrCreateResumeId`).
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 3"));
    expect(createResume).not.toHaveBeenCalled();
  });

  it("falls back to no suggestion rather than crashing when the resumes list is still loading or failed", async () => {
    mockBaseline();
    listResumes.mockRejectedValue(new Error("resumes unavailable"));

    render(<App />);

    // The field is still there (ticket 3db5b35's whole point) -- it just
    // has nothing to suggest yet if the list never loads.
    expect(await screen.findByLabelText("Resume Nickname")).toBeInTheDocument();
  });
});

describe("App — an edited pre-save nickname is what actually gets saved (ticket 3db5b35)", () => {
  it("saves the EDITED nickname via updateResumeNickname, not the server's own default -- verified by what the API received, not the field's display", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });
    updateResumeNickname.mockResolvedValue({ id: "resume-1", resumeNickname: "Backend resume" });

    render(<App />);

    // Wait for the suggestion to seed ("Resume 1", 0 existing resumes + 1),
    // THEN edit it -- this is the "pre-populated, but editable before
    // saving" half of the acceptance criteria.
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Backend resume" },
    });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // THE REAL PROOF: the PATCH body, not what the field happens to show.
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "Backend resume"),
    );
    // And the end state reflects it too.
    await waitFor(() => expect(screen.getByText("Using Backend resume")).toBeInTheDocument());
  });

  it("does NOT call updateResumeNickname when the pre-save suggestion is left unedited", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByText("Using Resume 1")).toBeInTheDocument());
    expect(updateResumeNickname).not.toHaveBeenCalled();
  });

  it("a collision on the first-save nickname PATCH surfaces the error and keeps the field's typed value, instead of collapsing to the summary bar", async () => {
    mockBaseline();
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });
    updateResumeNickname.mockRejectedValue(
      Object.assign(new Error("This resume nickname is already in use."), {
        status: 409,
        body: { error: "This resume nickname is already in use.", reason: "nickname_conflict" },
      }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1"));
    fireEvent.change(screen.getByLabelText("Resume Nickname"), {
      target: { value: "Taken Nickname" },
    });
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Taken Nickname");

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-1", "Taken Nickname"),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not save nickname: This resume nickname is already in use.",
      );
    });
    // Stays visible and editable -- not swallowed by a collapse to "Using
    // Resume 1", and not reverted (same non-reverting treatment a
    // post-save collision already gets).
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Taken Nickname");
    expect(screen.getByLabelText("Resume Nickname")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Using Resume 1")).not.toBeInTheDocument();
  });
});
