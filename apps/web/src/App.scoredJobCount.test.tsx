// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetAllResultsResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  ScoredJobResult,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 03f5e8b: the "Already Scored Jobs (N)" tab heading must show the
 * true matching count when GET /results is truncated (more than 500 above-
 * floor matches), not the capped results.length. Uses totalMatchingCount
 * (present only when truncation occurs) to fix the discrepancy.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  // Ticket bf2dd0a: SearchFlow now polls this alongside every estimate
  // call. This file never asserts on progress display, so a simple
  // always-rejecting stub (treated as "nothing to show" -- see
  // SearchFlow.tsx's startEstimateProgressPolling) is enough.
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  // Ticket 303cff0 ("My Resumes" tab): useResumesList fetches this
  // unconditionally on every App mount now, regardless of which tab is
  // active -- none of these tests assert on it, so a static empty list
  // (same pattern as getEstimateProgress above) is enough.
  listResumes: () => Promise.resolve({ resumes: [] }),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
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

function makeJob(
  overrides: Partial<ScoredJobResult> & Pick<ScoredJobResult, "jobId">,
): ScoredJobResult {
  return {
    resumeId: "resume-1",
    externalId: overrides.jobId,
    title: "A Job",
    company: "Acme",
    dataSource: "usajobs",
    location: null,
    locationType: null,
    applyUrl: "https://example.com/apply",
    matchScore: 80,
    rationale: "Good fit.",
    strengths: [],
    gaps: [],
    status: null,
    levelFit: null,
    levelFitNote: null,
    isContractOrTemp: false,
    resumeNickname: "Resume 1",
    ...overrides,
  };
}

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  fireEvent.click(screen.getByLabelText(/Any location/));
}

describe("App scored job count (ticket 03f5e8b)", () => {
  it("shows correct count when no truncation (totalMatchingCount absent)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [],
    } satisfies GetResumeResultsResponse);
    // No truncation: totalMatchingCount is absent, results.length < 500
    getAllResults.mockResolvedValue({
      results: [makeJob({ jobId: "job-1" }), makeJob({ jobId: "job-2" })],
      // totalMatchingCount absent -- no truncation
    } satisfies GetAllResultsResponse);

    await submitResume();

    // Navigate to Already Scored Jobs tab
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    // Should show "(2)" since there are 2 results and no truncation
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Already Scored Jobs (2)" })).toBeInTheDocument();
    });

    // Tab heading should also show the same count
    expect(screen.getByRole("heading", { name: "Already Scored Jobs (2)" })).toBeInTheDocument();
  });

  it("shows correct count when truncated (uses totalMatchingCount)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [],
    } satisfies GetResumeResultsResponse);
    // Truncation: results capped at 50, but totalMatchingCount shows 150
    const truncatedResults = Array.from({ length: 50 }, (_, i) => makeJob({ jobId: `job-${i}` }));
    getAllResults.mockResolvedValue({
      results: truncatedResults,
      totalMatchingCount: 150, // 150 total matches, but only 50 returned
    } satisfies GetAllResultsResponse);

    await submitResume();

    // Navigate to Already Scored Jobs tab
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    // Should show "(150)" (the totalMatchingCount), not "(50)" (the results.length)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Already Scored Jobs (150)" })).toBeInTheDocument();
    });

    // Tab heading should also show the same truncated count
    expect(screen.getByRole("heading", { name: "Already Scored Jobs (150)" })).toBeInTheDocument();
  });

  it("shows correct count when truncated with hiddenBelowFloor", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [],
    } satisfies GetResumeResultsResponse);
    // Truncation + hidden below floor: 150 matching, 50 above floor + 7 below floor
    const truncatedResults = Array.from({ length: 50 }, (_, i) => makeJob({ jobId: `job-${i}` }));
    getAllResults.mockResolvedValue({
      results: truncatedResults,
      totalMatchingCount: 150,
      hiddenBelowFloor: 7,
    } satisfies GetAllResultsResponse);

    await submitResume();

    // Navigate to Already Scored Jobs tab
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    // Should show "(157)" = totalMatchingCount (150) + hiddenBelowFloor (7)
    // NOT "(57)" = results.length (50) + hiddenBelowFloor (7)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Already Scored Jobs (157)" })).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: "Already Scored Jobs (157)" })).toBeInTheDocument();
  });

  it("shows correct count with only hiddenBelowFloor (no truncation)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [],
    } satisfies GetResumeResultsResponse);
    // 10 above floor, 3 below floor, no truncation
    const results = Array.from({ length: 10 }, (_, i) => makeJob({ jobId: `job-${i}` }));
    getAllResults.mockResolvedValue({
      results,
      hiddenBelowFloor: 3,
      // totalMatchingCount absent -- no truncation
    } satisfies GetAllResultsResponse);

    await submitResume();

    // Navigate to Already Scored Jobs tab
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    // Should show "(13)" = results.length (10) + hiddenBelowFloor (3)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Already Scored Jobs (13)" })).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: "Already Scored Jobs (13)" })).toBeInTheDocument();
  });
});
