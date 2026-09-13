// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCORE_FLOOR,
  type EstimateSearchResponse,
  type GetResumeResultsResponse,
  type GetSourcesResponse,
  type ScoredJobResult,
} from "@app/shared";
import App from "./App";

/**
 * Ticket ffbf9fb: `MATCH_SCORE_FLOOR` (`@app/shared`) used to be a fixed
 * constant baked into `useResults.ts` -- every fetch of `GET
 * /resumes/:id/results` always passed exactly that value as `?minScore=`,
 * with no way for Nicole to move it. That param was already fully flexible
 * server-side (apps/api/src/routes/resumes.ts's `minScoreNum` parsing,
 * verified before this ticket started) -- the missing piece was purely the
 * frontend control. This file covers the ticket's own acceptance criteria:
 * moving the slider re-fetches with the new floor, the visible list updates
 * to reflect it, the value survives a reload, and the default matches
 * `MATCH_SCORE_FLOOR` until the user actually moves it. Mocking approach
 * mirrors App.sourceToggle.test.tsx / App.persistence.test.tsx.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const setJobStatus = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
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

function makeJob(jobId: string, title: string): ScoredJobResult {
  return {
    jobId,
    externalId: jobId,
    title,
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
  };
}

async function submitResumeAndOpenScoredTab() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  await waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));
}

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

/**
 * Drives a REAL completed search end to end (estimate -> run -> poll to
 * "complete"), the same sequence App.tabs.test.tsx uses to reach
 * `hasFreshSearchResults`. That flag is what makes "New Job Search" render
 * its OWN `ScoreFloorControl` instance -- "Already Scored Jobs" always
 * renders its instance once a `resumeId` exists, but the search tab's copy
 * only appears after a search has actually completed. Both instances are
 * simultaneously in the DOM the moment this resolves (App.tsx keeps both
 * tabs mounted at all times via `hidden`, not conditional rendering) --
 * this is the exact shape the opus review's duplicate-id finding needed a
 * real reproduction for, since every other test in this file only ever
 * reaches the scored tab WITHOUT completing a search first, so only one
 * `ScoreFloorControl` instance was ever mounted.
 */
async function submitResumeAndCompleteASearch() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  fireEvent.click(screen.getByLabelText(/Any location/));

  fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
  await screen.findByRole("button", { name: "Run search" });
  fireEvent.click(screen.getByRole("button", { name: "Run search" }));

  await act(async () => {
    await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
  });

  await screen.findByRole("heading", { name: "Results from this search" });
}

describe("Score floor slider (ticket ffbf9fb)", () => {
  it("defaults to MATCH_SCORE_FLOOR when nothing has been persisted", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });

    await submitResumeAndOpenScoredTab();

    expect(getResults).toHaveBeenCalledWith("resume-1", {
      minScore: MATCH_SCORE_FLOOR,
      includeDismissed: true,
    });
    const slider = await screen.findByLabelText("Minimum match score to show");
    expect(slider).toHaveValue(String(MATCH_SCORE_FLOOR));
    expect(screen.getByText(`${MATCH_SCORE_FLOOR}%`)).toBeInTheDocument();
  });

  it("moving the slider re-fetches results with the new minScore value", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });

    await submitResumeAndOpenScoredTab();
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    const slider = screen.getByLabelText("Minimum match score to show");
    fireEvent.change(slider, { target: { value: "40" } });

    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(2));
    expect(getResults).toHaveBeenLastCalledWith("resume-1", {
      minScore: 40,
      includeDismissed: true,
    });
  });

  it("updates the visible results list to reflect the new floor", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    // A smaller result set at the default floor, a larger one once the
    // floor is lowered -- mirrors what the real server-side `gte(matchScore,
    // minScore)` filter does: a lower floor can surface a job that was
    // never sent to the client at the old floor at all.
    getResults.mockImplementation((_resumeId: string, params: { minScore?: number }) => {
      const results =
        (params.minScore ?? 0) >= MATCH_SCORE_FLOOR
          ? [makeJob("job-1", "Backend Engineer")]
          : [makeJob("job-1", "Backend Engineer"), makeJob("job-2", "Support Engineer")];
      return Promise.resolve({ resumeId: "resume-1", results } satisfies GetResumeResultsResponse);
    });

    await submitResumeAndOpenScoredTab();
    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Support Engineer")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Minimum match score to show"), {
      target: { value: "30" },
    });

    expect(await screen.findByText("Support Engineer")).toBeInTheDocument();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
  });

  it("survives a reload", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });

    await submitResumeAndOpenScoredTab();
    fireEvent.change(screen.getByLabelText("Minimum match score to show"), {
      target: { value: "25" },
    });
    await waitFor(() =>
      expect(getResults).toHaveBeenLastCalledWith("resume-1", {
        minScore: 25,
        includeDismissed: true,
      }),
    );

    cleanup();
    getResults.mockClear();
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });

    render(<App />);

    // The restored resumeId fires useResults's fetch immediately on mount,
    // before any tab is clicked -- the slider itself only renders once the
    // "Already Scored Jobs" tab is opened.
    await waitFor(() =>
      expect(getResults).toHaveBeenCalledWith("resume-1", {
        minScore: 25,
        includeDismissed: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));
    expect(await screen.findByLabelText("Minimum match score to show")).toHaveValue("25");
  });

  describe("two simultaneously-mounted instances (opus review, ticket ffbf9fb BLOCKING)", () => {
    /**
     * Every OTHER test in this file reaches the "Already Scored Jobs" tab
     * via `submitResumeAndOpenScoredTab`, which never completes a real
     * search -- so `hasFreshSearchResults` stays false, "New Job Search"
     * never renders its own `ScoreFloorControl`, and only ONE instance is
     * ever mounted. That's exactly why the opus review's duplicate-id bug
     * slipped past every existing test: with a hardcoded
     * `id="score-floor-slider"`, a single mounted instance can never
     * collide with itself. This test drives a REAL completed search
     * (`submitResumeAndCompleteASearch`), the app's primary path, so BOTH
     * tabs' `ScoreFloorControl` instances are actually in the DOM at once
     * (App.tsx keeps both tabs mounted simultaneously via `hidden`, not
     * conditional rendering -- see its own comment on that).
     */
    it("gives each mounted slider a distinct id whose label truly resolves to it", async () => {
      getSources.mockResolvedValue(SOURCES);
      createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
      getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });
      estimateSearch.mockResolvedValue(makeEstimate());
      startSearch.mockResolvedValue({
        searchId: "search-1",
        status: "pending",
        skippedSources: [],
      });
      getSearchStatus.mockResolvedValue({
        status: "complete",
        newlyScored: 0,
        failed: 0,
        skipped: 0,
        costEstimate: makeEstimate().costEstimate,
        sourceOutcomes: [],
      });

      await submitResumeAndCompleteASearch();

      // Both instances are mounted now: the visible "New Job Search" tab's
      // (active tab by default) and the hidden "Already Scored Jobs" tab's.
      // `getAllByLabelText` does not filter by the `hidden` attribute (only
      // role-based queries do), so this genuinely proves both are in the
      // DOM at once -- not just that one query happens to find one of them.
      const sliders = screen.getAllByLabelText("Minimum match score to show");
      expect(sliders).toHaveLength(2);
      const [searchTabSlider, scoredTabSlider] = sliders as [HTMLInputElement, HTMLInputElement];

      // BLOCKING bug: a hardcoded `id="score-floor-slider"` would make
      // these equal.
      expect(searchTabSlider.id).not.toBe(scoredTabSlider.id);
      expect(searchTabSlider.id.length).toBeGreaterThan(0);
      expect(scoredTabSlider.id.length).toBeGreaterThan(0);

      // Each slider's label must resolve back to THAT SAME slider, not the
      // other tab's -- scoped with `within()` per instance so this can't
      // accidentally pass by matching the wrong tab's copy.
      const searchTabContainer = searchTabSlider.closest(".score-floor-control");
      const scoredTabContainer = scoredTabSlider.closest(".score-floor-control");
      if (searchTabContainer === null || scoredTabContainer === null) {
        throw new Error("expected each slider to be wrapped in .score-floor-control");
      }
      const searchTabLabel = within(searchTabContainer as HTMLElement).getByText(
        "Minimum match score to show",
      );
      const scoredTabLabel = within(scoredTabContainer as HTMLElement).getByText(
        "Minimum match score to show",
      );
      expect((searchTabLabel as HTMLLabelElement).control).toBe(searchTabSlider);
      expect((scoredTabLabel as HTMLLabelElement).control).toBe(scoredTabSlider);
      // And explicitly NOT cross-wired to the other tab's slider -- this is
      // the precise failure mode the bug produced (visible tab's label
      // pointing at the other, hidden tab's control).
      expect((searchTabLabel as HTMLLabelElement).control).not.toBe(scoredTabSlider);
      expect((scoredTabLabel as HTMLLabelElement).control).not.toBe(searchTabSlider);
    });
  });
});
