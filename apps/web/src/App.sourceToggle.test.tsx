// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCORE_FLOOR,
  type GetResumeResultsResponse,
  type GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Review round, F6 (git-bug 484889d): "Nothing fails if a future edit adds
 * `selectedSourceIds` to `useResults`'s deps or passes `source` to
 * `getResults`." Decision #3 (2026-08-29, this ticket's git-bug) is that
 * toggling a source filters an ALREADY-FETCHED corpus client-side —
 * hooks/useResults.ts fetches once per resumeId/refresh and App.tsx narrows
 * by `selectedSourceIds` in memory (see ResultsList's own filtering test for
 * the "narrows correctly" half of this). This file locks in the OTHER half:
 * that toggling never triggers a second `getResults` call at all. Mocks
 * `../api/client` (well, `./api/client` from this file's own location) so
 * this never touches a real network/API process, matching the mocking
 * approach `demo-match.test.ts` etc. already use for network boundaries.
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

// `App` is a plain top-level import above — Vitest hoists `vi.mock` calls
// above all imports in the module regardless of source order, so `./App`
// (which imports `./api/client`) already sees the mocked module by the
// time it's evaluated.
//
// Same reasoning as SourceToggles.test.tsx / ResultsList.test.tsx: this
// repo's root vitest.config.ts doesn't enable `test.globals`, so RTL's
// auto-cleanup (which needs a GLOBAL afterEach) never fires on its own.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SOURCES: GetSourcesResponse = {
  sources: [
    { id: "usajobs", displayName: "USAJOBS", configured: true },
    { id: "greenhouse", displayName: "Greenhouse", configured: true },
    {
      id: "wa-state",
      displayName: "Washington State Jobs",
      configured: false,
      error: "no adapter implemented yet",
    },
  ],
};

const RESULTS: GetResumeResultsResponse = {
  resumeId: "resume-1",
  results: [],
};

describe("App — toggling a source never re-fetches results (F6, review round)", () => {
  it("calls getResults exactly once for a resume load, and not again after a source toggle", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);

    render(<App />);

    // Ticket e493085: page title and sources heading wording.
    expect(screen.getByRole("heading", { name: "AI-Assisted Job Search" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));

    // Resume submitted -> resumeId set -> useResults fires its one fetch.
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));
    expect(getResults).toHaveBeenCalledWith("resume-1", { minScore: MATCH_SCORE_FLOOR });

    // Sources loaded and rendered as toggles.
    await screen.findByLabelText("Greenhouse");
    expect(
      screen.getByRole("heading", { name: "Which sources do you want to search?" }),
    ).toBeInTheDocument();

    // The unconfigured source (wa-state, no adapter) must not appear in the
    // rendered toggle list at all -- ticket d480357. GET /sources still
    // reports it (the mocked `getSources` above returns it, same as the
    // real API's `checkSourceHealth` would); only App.tsx's render path to
    // SourceToggles narrows it away.
    expect(screen.queryByLabelText("Washington State Jobs")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Greenhouse"));

    // The toggle changed `selectedSourceIds` (App.tsx state) and re-rendered
    // — give any accidental effect a real tick to fire before asserting it
    // didn't, rather than asserting synchronously right after the click.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // This is the assertion the whole test exists for: the toggle must not
    // have produced a second getResults call. A future edit that adds
    // `selectedSourceIds` to useResults's dependency array, or that passes
    // `source` through to `getResults`, would fail this.
    expect(getResults).toHaveBeenCalledTimes(1);
  });
});

// Ticket f4a7f07 moved the whole results section into its own
// "Already Scored Jobs" tab, hidden by default (activeTab starts
// "search") -- these tests now switch tabs before asserting on its
// content. Superseded from ticket 093d9fe's original design: that tab
// ALWAYS shows its "Results" heading now (it's somewhere the user
// deliberately navigates to, not an inline surprise), only the CONTENT
// varies -- see App.tsx's own comment on this exact change.
describe("App — Already Scored Jobs tab always shows a heading, content varies (ticket f4a7f07, superseding 093d9fe)", () => {
  async function submitResumeAndOpenScoredTab() {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));
  }

  it("shows a 'no jobs scored yet' message when zero results and nothing hidden below the floor", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [] });

    await submitResumeAndOpenScoredTab();

    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByText("No jobs scored yet.")).toBeInTheDocument();
  });

  it("shows real results once a hiddenBelowFloor count exists, even with zero visible results", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({ resumeId: "resume-1", results: [], hiddenBelowFloor: 3 });

    await submitResumeAndOpenScoredTab();

    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.queryByText("No jobs scored yet.")).not.toBeInTheDocument();
  });

  it("shows real results once they exist", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      results: [
        {
          jobId: "job-1",
          externalId: "ext-1",
          title: "Backend Engineer",
          company: "Acme",
          dataSource: "greenhouse",
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

    await submitResumeAndOpenScoredTab();

    expect(await screen.findByText("Backend Engineer")).toBeInTheDocument();
  });

  it("still surfaces a real fetch error", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockRejectedValue(new Error("network down"));

    await submitResumeAndOpenScoredTab();

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load results");
  });
});
