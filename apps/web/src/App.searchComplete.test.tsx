// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 9e5fcf3: John's testing session (relayed by Nicole) hit three
 * problems in the same moment -- a search finishing -- and this file covers
 * all three fixes:
 *
 *  (c) Finishing a search must update "Already Scored Jobs" (list AND tab
 *      count) with no reload. Cause: `handleSearchComplete` called `refresh()`
 *      but never `refreshAllResults()`.
 *  (b) "Results from this search" must show ONLY the most recent search's
 *      results -- a second search on the same resume must not pool with the
 *      first's. Fixed server-side: `GET /resumes/:id/results?searchId=`.
 *  (a) Completion must be noticeable, and the results reachable without
 *      being told to scroll -- a "View N results" button next to "Search
 *      complete".
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
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: () => Promise.resolve({ resumes: [] }),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

// Ticket 371713d's own comment (App.criteria.test.tsx) explains why this is
// needed file-wide: jsdom has no `scrollIntoView` at all, and this file's
// whole "View N results" story (part (a)) exercises App.tsx's
// `handleViewResults` -> `resultsSectionRef.current?.scrollIntoView(...)`.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn<typeof Element.prototype.scrollIntoView>();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
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
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
  };
}

function job(id: string, title: string, company: string): GetResumeResultsResponse["results"][0] {
  return {
    jobId: id,
    resumeId: "resume-1",
    externalId: `ext-${id}`,
    title,
    company,
    dataSource: "usajobs",
    location: null,
    locationType: null,
    applyUrl: "https://example.com/apply",
    matchScore: 80,
    rationale: "Good fit.",
    strengths: [],
    gaps: [],
    status: null,
    resumeNickname: "Resume 1",
    levelFit: null,
    levelFitNote: null,
    isContractOrTemp: false,
  };
}

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  fireEvent.click(screen.getByLabelText(/Any location/));
}

/** Runs one estimate->confirm->poll-to-completion cycle. Returns once the
 * "Search complete" panel is on screen. The poll interval is real (2s),
 * matching the existing pattern in App.tabs.test.tsx -- `enterRunning`
 * schedules a genuine `setInterval`, not a fake-timer-driven one, so the
 * wait below is real wall-clock time, not fast-forwarded. */
async function runSearchToCompletion() {
  // Counted, not a bare `toHaveBeenCalled()` -- this helper is called TWICE
  // in the (b) test below, for two separate runs in the SAME test (mocks
  // are never cleared mid-test), so a bare "has this mock ever been called"
  // check would already be true the instant the second run starts, from the
  // FIRST run's poll. Waiting for the call count to grow past its
  // snapshot-at-start instead makes this helper actually wait for THIS run's
  // own first poll tick, not an earlier one.
  const callsBefore = getSearchStatus.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
  await screen.findByRole("button", { name: "Run search" });
  fireEvent.click(screen.getByRole("button", { name: "Run search" }));
  await act(async () => {
    await vi.waitFor(() => expect(getSearchStatus.mock.calls.length).toBeGreaterThan(callsBefore), {
      timeout: 3000,
    });
  });
  await screen.findByRole("heading", { name: "Search complete" }, { timeout: 3000 });
}

describe("after a search completes (ticket 9e5fcf3)", () => {
  it("(c) updates the Already Scored Jobs list AND its tab count with no reload", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      searchId: "search-1",
      resumeId: "resume-1",
      status: "complete",
      scored: 1,
      failed: 0,
      linked: 1,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    // Before the search: nothing scored yet.
    getAllResults.mockResolvedValue({ results: [] });

    await submitResume();

    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveTextContent(
      "Already Scored Jobs",
    );
    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).not.toHaveTextContent(
      "(1)",
    );

    // The search's own completion adds exactly one real scored job --
    // `refreshAllResults()` is what's supposed to pick this up.
    getAllResults.mockResolvedValue({ results: [job("job-1", "Backend Engineer", "Acme")] });

    await runSearchToCompletion();

    // The tab button's count updates...
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveTextContent(
        "Already Scored Jobs (1)",
      ),
    );

    // ...and so does the list itself, with NO click, NO reload -- switching
    // tabs here only reveals what's already there (ticket f4a7f07: all three
    // tab panels stay mounted, `hidden` only toggles visibility), it doesn't
    // trigger a fresh fetch.
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    expect(await screen.findByText("Backend Engineer")).toBeVisible();

    // Both the list AND the count are driven by the SAME refetch -- not two
    // independent mechanisms that happen to agree here.
    expect(getAllResults).toHaveBeenCalledTimes(2);
  });

  it("(b) scopes 'Results from this search' to the most recent search only -- a second search's results replace the first's", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getAllResults.mockResolvedValue({ results: [] });
    estimateSearch.mockResolvedValue(makeEstimate());

    startSearch
      .mockResolvedValueOnce({ searchId: "search-1", status: "pending", skippedSources: [] })
      .mockResolvedValueOnce({ searchId: "search-2", status: "pending", skippedSources: [] });

    // `getSearchStatus` is polled with whatever searchId this run adopted --
    // answer each according to which one is actually being asked about,
    // not by call order, since it's on a real interval and either could in
    // principle be asked about more than once.
    getSearchStatus.mockImplementation((searchId: string) =>
      Promise.resolve({
        searchId,
        resumeId: "resume-1",
        status: "complete",
        scored: 1,
        failed: 0,
        linked: 1,
        sources: [],
        completedAt: "2026-01-01T00:00:00.000Z",
        degraded: false,
      }),
    );

    // The one assertion this test exists for: `getResults` must receive
    // `searchId` on the wire, and the SERVER (simulated here) answers each
    // search's own job, not the union of both.
    getResults.mockImplementation(
      (
        _resumeId: string,
        params: { searchId?: string } = {},
      ): Promise<GetResumeResultsResponse> => {
        const results =
          params.searchId === "search-1"
            ? [job("job-1", "Backend Engineer", "Acme")]
            : params.searchId === "search-2"
              ? [job("job-2", "Platform Engineer", "Globex")]
              : [];
        return Promise.resolve({ resumeId: "resume-1", resumeNickname: "Resume 1", results });
      },
    );

    await submitResume();
    await runSearchToCompletion();

    expect(await screen.findByText("Backend Engineer")).toBeVisible();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(getResults).toHaveBeenLastCalledWith(
      "resume-1",
      expect.objectContaining({ searchId: "search-1" }),
    );

    // Start and finish a SECOND search on the SAME resume.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await runSearchToCompletion();

    // The first search's job is GONE -- not pooled alongside the second's.
    expect(await screen.findByText("Platform Engineer")).toBeVisible();
    expect(screen.queryByText("Backend Engineer")).not.toBeInTheDocument();
    expect(getResults).toHaveBeenLastCalledWith(
      "resume-1",
      expect.objectContaining({ searchId: "search-2" }),
    );
  });

  it('(a) shows a "View N results" button beside the completion heading, and it scrolls to the results section', async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [job("job-1", "Backend Engineer", "Acme")],
    });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      searchId: "search-1",
      resumeId: "resume-1",
      status: "complete",
      scored: 1,
      failed: 0,
      linked: 1,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    await submitResume();
    await runSearchToCompletion();

    const viewResultsButton = await screen.findByRole("button", { name: "View 1 result" });
    expect(viewResultsButton).toBeVisible();

    fireEvent.click(viewResultsButton);

    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "smooth" }),
    );
  });

  it('(a) withholds the "View N results" button when the search found nothing', async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      searchId: "search-1",
      resumeId: "resume-1",
      status: "complete",
      scored: 0,
      failed: 0,
      linked: 0,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    await submitResume();
    await runSearchToCompletion();

    expect(screen.queryByRole("button", { name: /View \d+ results?/ })).not.toBeInTheDocument();
  });
});
