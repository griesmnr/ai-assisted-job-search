// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetResumeResultsResponse, GetSourcesResponse, ScoredJobResult } from "@app/shared";
import App from "./App";

/**
 * Ticket bec2f98: (1) a dismissed job stays visible in "Results from this
 * search", marked "Dismissed" rather than silently missing; (2) "Already
 * Scored Jobs" groups by status in a fixed order; (3) that grouping is a
 * SNAPSHOT taken at tab-open, not live -- a status change updates a card's
 * own badge/actions in place without moving it to a different group until
 * the tab is next opened.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();
// Ticket dbfd594: ResultCard's "Optimize Resume" now calls these -- not
// exercised by this file's own tests, but must exist so a click doesn't
// throw "createHandoff is not a function" from the mocked module.
const createHandoff = vi.fn().mockResolvedValue({ id: "handoff-1", expiresAt: "2026-01-01" });

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
  createHandoff: (...args: unknown[]) => createHandoff(...args),
  handoffFetchUrl: (id: string) => `https://api.example.com/handoffs/${id}`,
  RESUME_OPTIMIZER_APP_URL: "https://optimizer.example.com/",
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

function job(
  overrides: Partial<ScoredJobResult> & Pick<ScoredJobResult, "jobId">,
): ScoredJobResult {
  return {
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
}

describe("dismissed jobs stay visible in 'Results from this search' (ticket bec2f98)", () => {
  it("a dismissed job appears with a visible 'Dismissed' indicator once a search completes", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      results: [
        job({ jobId: "job-1", title: "Backend Engineer", status: "dismissed" }),
        job({ jobId: "job-2", title: "Frontend Engineer", status: null }),
      ],
    } satisfies GetResumeResultsResponse);
    estimateSearch.mockResolvedValue({
      resumeId: "resume-1",
      costEstimate: {
        jobCount: 2,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0.1,
        probableCostUsd: 0.05,
        basis: "bootstrap",
      },
      candidatesNeedingScore: 2,
      scoreThreshold: 100,
      cappedCount: 0,
      alreadyScored: 0,
      sourceOutcomes: [],
      skippedSources: [],
    });
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "complete",
      newlyScored: 2,
      failed: 0,
      skipped: 0,
      costEstimate: {
        jobCount: 2,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0.1,
        probableCostUsd: 0.05,
        basis: "bootstrap",
      },
      sourceOutcomes: [],
    });

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));

    // Poll fires on an interval; advance past it inside act() so React
    // processes the resulting state updates (same pattern as
    // App.tabs.test.tsx).
    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });

    const heading = await screen.findByRole("heading", { name: "Results from this search" });
    // Both tabs stay mounted and share the same underlying result data
    // (ticket f4a7f07), so a plain screen-wide text query would also match
    // the ("Already Scored Jobs") tab's own copy -- scope to this
    // section's own container.
    const freshResultsSection = heading.closest("section")!;

    // Both jobs show, including the dismissed one -- it never left the
    // list, it's just marked.
    expect(within(freshResultsSection).getByText("Backend Engineer")).toBeInTheDocument();
    expect(within(freshResultsSection).getByText("Frontend Engineer")).toBeInTheDocument();
    expect(within(freshResultsSection).getByText("Dismissed")).toBeInTheDocument();
    // getResults was called with includeDismissed: true.
    expect(getResults).toHaveBeenCalledWith(
      "resume-1",
      expect.objectContaining({ includeDismissed: true }),
    );
  });
});

describe("'Already Scored Jobs' groups by status (ticket bec2f98)", () => {
  const GROUPED_RESULTS: GetResumeResultsResponse = {
    resumeId: "resume-1",
    results: [
      job({ jobId: "job-saved", title: "Saved Job", status: "saved" }),
      job({ jobId: "job-none", title: "Untouched Job", status: null }),
      job({ jobId: "job-optimized", title: "Optimized Job", status: "resume_optimized" }),
      job({ jobId: "job-applied", title: "Applied Job", status: "applied" }),
      job({ jobId: "job-dismissed", title: "Dismissed Job", status: "dismissed" }),
    ],
  };

  it("renders labeled groups in order: Saved, No action taken, then the rest", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(GROUPED_RESULTS);

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));

    // Job titles ("Saved Job", etc.) also render as level-3 headings
    // (ResultCard's own `<h3>`), so filter down to just the GROUP labels
    // rather than asserting on every level-3 heading in the tree.
    const GROUP_LABELS = ["Saved", "No action taken", "Resume Optimized", "Applied", "Dismissed"];
    const headings = await screen.findAllByRole("heading", { level: 3 });
    const groupHeadings = headings
      .map((h) => h.textContent)
      .filter((text): text is string => GROUP_LABELS.includes(text ?? ""));
    expect(groupHeadings).toEqual(GROUP_LABELS);

    expect(screen.getByRole("heading", { name: "Saved" }).closest("section")).toContainElement(
      screen.getByText("Saved Job"),
    );
    expect(
      screen.getByRole("heading", { name: "No action taken" }).closest("section"),
    ).toContainElement(screen.getByText("Untouched Job"));
    expect(screen.getByRole("heading", { name: "Dismissed" }).closest("section")).toContainElement(
      screen.getByText("Dismissed Job"),
    );
  });

  it("a status change updates the card in place but does NOT move it to a new group until the tab is next opened", async () => {
    // "Optimize Resume" (ticket dbfd594) calls window.open -- jsdom has no
    // real implementation of it, so this stubs it rather than letting it
    // log a "not implemented" error.
    vi.spyOn(window, "open").mockImplementation(() => null);
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValueOnce(GROUPED_RESULTS);
    setJobStatus.mockResolvedValue({
      jobId: "job-saved",
      status: "resume_optimized",
      updatedAt: new Date().toISOString(),
    });

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));
    await screen.findByRole("heading", { name: "Saved" });

    // Refetch after the status write returns job-saved with its status
    // flipped to resume_optimized.
    const afterStatusChange: GetResumeResultsResponse = {
      resumeId: "resume-1",
      results: GROUPED_RESULTS.results.map((r) =>
        r.jobId === "job-saved" ? { ...r, status: "resume_optimized" } : r,
      ),
    };
    getResults.mockResolvedValueOnce(afterStatusChange);

    const savedSection = screen.getByRole("heading", { name: "Saved" }).closest("section")!;
    fireEvent.click(within(savedSection).getByRole("button", { name: "Optimize Resume" }));

    // The card's own badge updates in place...
    await waitFor(() =>
      expect(within(savedSection).getByText("Resume optimized")).toBeInTheDocument(),
    );
    // ...but it's still rendered under "Saved" for this render -- it has
    // NOT moved to "Resume Optimized" yet.
    expect(within(savedSection).getByText("Saved Job")).toBeInTheDocument();

    // Now leave and re-open the tab -- THIS is when the snapshot
    // recomputes, and the card should move.
    fireEvent.click(screen.getByRole("button", { name: "New Job Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Already Scored Jobs" }));

    await waitFor(() => {
      const resumeOptimizedSection = screen
        .getByRole("heading", { name: "Resume Optimized" })
        .closest("section")!;
      expect(within(resumeOptimizedSection).getByText("Saved Job")).toBeInTheDocument();
    });
  });
});
