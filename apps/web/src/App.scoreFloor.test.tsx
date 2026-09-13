// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCORE_FLOOR,
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
});
