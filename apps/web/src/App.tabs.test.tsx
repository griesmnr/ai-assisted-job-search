// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket f4a7f07: two tabs (New Job Search / Already Scored Jobs), and
 * two behaviors that must hold simultaneously:
 *
 *  1. Switching tabs must NEVER unmount SearchFlow -- an in-progress
 *     "estimated" phase must survive a round trip to the other tab and
 *     back (tied to ticket 3f05144's state-loss concern).
 *  2. The "New Job Search" tab's own results section ("Results from this
 *     search") only ever shows the MOST RECENT completed search's
 *     results -- cleared the instant a new estimate starts or a
 *     source/criteria toggle changes, populated only once a search
 *     actually completes. Nicole, live: "results should be reserved for
 *     results from the most recent search... cleared every time a new
 *     search is estimated or a filter is toggled."
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
// Ticket 3f0883f: "Already Scored Jobs" reads GET /results now -- see
// App.criteria.test.tsx's identical comment for the full reasoning.
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
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Ticket 3f05144: this app now persists an in-progress resume/search to
  // `sessionStorage`, which — unlike React state — is NOT torn down by
  // `cleanup()`. Without this, one test's submitted resume or in-flight
  // searchId would be restored by the next test's first render.
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const EMPTY_RESULTS: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [],
};

function makeEstimate(): EstimateSearchResponse {
  return {
    resumeId: "resume-1",
    costEstimate: {
      jobCount: 1,
      estimatedInputTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      maxCostUsd: 0.1,
      probableCostUsd: 0.05,
      basis: "bootstrap",
    },
    candidatesNeedingScore: 1,
    scoreThreshold: 100,
    cappedCount: 0,
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
  };
}

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  // Ticket b9e6251: an empty location (no nearLocations, no remoteOk) now
  // requires the explicit "Any location" opt-in before "Estimate search
  // cost" is even enabled -- every test in this file estimates without
  // ever setting a location, so this is needed unconditionally here.
  fireEvent.click(screen.getByLabelText(/Any location/));
}

describe("App tabs (ticket f4a7f07)", () => {
  it("defaults to the New Job Search tab", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);

    await submitResume();

    expect(screen.getByRole("button", { name: "New Job Search" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("switching to Already Scored Jobs and back does not unmount SearchFlow -- an in-progress estimate survives the round trip", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    expect(screen.getByLabelText("Cost estimate")).toBeInTheDocument();

    // Round trip to the other tab and back.
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    fireEvent.click(screen.getByRole("button", { name: "New Job Search" }));

    // The estimate must still be showing -- if the tab switch had
    // unmounted SearchFlow, this would have reset to "idle" and the
    // estimate would be gone, forcing a wasted re-estimate.
    expect(screen.getByLabelText("Cost estimate")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run search" })).toBeInTheDocument();
    // Only ONE estimateSearch call ever happened -- switching tabs did not
    // trigger a redundant re-estimate.
    expect(estimateSearch).toHaveBeenCalledTimes(1);
  });

  it("'Results from this search' does not appear until a search actually completes", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    expect(
      screen.queryByRole("heading", { name: "Results from this search" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });

    // Still not shown -- only an ESTIMATE has happened, not a completed
    // search.
    expect(
      screen.queryByRole("heading", { name: "Results from this search" }),
    ).not.toBeInTheDocument();
  });

  it("shows 'Results from this search' once a search completes, and hides it again the instant a new estimate starts", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        {
          jobId: "job-1",
          externalId: "ext-1",
          title: "Backend Engineer",
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
        },
      ],
    });
    // "Already Scored Jobs" content isn't what this test checks.
    getAllResults.mockResolvedValue({ results: [] });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "complete",
      scored: 1,
      permanentlyFailed: 0,
      linked: 1,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Poll fires on an interval; advance past it inside act() so React
    // processes the resulting state updates.
    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });

    expect(
      await screen.findByRole("heading", { name: "Results from this search" }),
    ).toBeInTheDocument();

    // Now start a NEW estimate -- the just-shown results must disappear
    // immediately, per Nicole: "cleared every time a new search is
    // estimated".
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    expect(
      screen.queryByRole("heading", { name: "Results from this search" }),
    ).not.toBeInTheDocument();
  });
});
