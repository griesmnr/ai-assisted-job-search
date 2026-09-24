// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 303cff0 ("My Resumes" tab). Opus review flagged this as the one
 * acceptance criterion ("live count in the tab button... mirrors 'Already
 * Scored Jobs (N)'") with zero test coverage -- every other App-level test
 * file stubs `listResumes` to a static empty list, so nothing pinned the
 * count actually reading real data, updating on tab switch, or refreshing
 * after a resume is created/renamed. This file is the App.scoredJobCount
 * .test.tsx counterpart for that same pattern, applied to this tab.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();
const listResumes = vi.fn();
const updateResumeNickname = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: (...args: unknown[]) => listResumes(...args),
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

describe("App 'My Resumes' tab (ticket 303cff0)", () => {
  it("shows the real resume count in the tab button once loaded, and the list on switching to it", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
        {
          id: "resume-2",
          resumeNickname: "Backend-focused resume",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    } satisfies ListResumesResponse);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (2)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "My Resumes (2)" }));

    expect(screen.getByRole("heading", { name: "My Resumes (2)" })).toBeInTheDocument();
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
    expect(screen.getByText("Backend-focused resume")).toBeInTheDocument();
  });

  it("shows no count (not '(0)') while the resumes list hasn't loaded yet", () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockReturnValue(new Promise(() => {})); // never resolves

    render(<App />);

    expect(screen.getByRole("button", { name: "My Resumes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /My Resumes \(/ })).not.toBeInTheDocument();
  });

  it("re-fetches the resumes list (and the count updates) after a new resume is submitted", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    listResumes.mockResolvedValueOnce({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (0)" })).toBeInTheDocument();
    });

    listResumes.mockResolvedValueOnce({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (1)" })).toBeInTheDocument();
    });
    expect(listResumes).toHaveBeenCalledTimes(2);
  });
});
