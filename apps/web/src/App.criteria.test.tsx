// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetResumeResultsResponse, GetSourcesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 957bc22: the money-critical behavior is that an untouched
 * criteria form sends NO criteria (undefined), not an empty `{}` -- see
 * App.tsx's `buildSearchCriteria` doc comment for why `{}` would be a
 * silent, expensive regression (compileFilter treats it as "no title
 * restriction at all", not "use the safe default"). This file locks that
 * in against the real component tree, not just the pure function in
 * isolation.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();

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
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const RESULTS: GetResumeResultsResponse = { resumeId: "resume-1", results: [] };

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  // Wait for CHECKED, not just present: the checkbox renders as soon as
  // sourcesState is "ready", one render BEFORE App.tsx's own auto-select
  // effect populates selectedSourceIds and re-renders it checked. Clicking
  // "Estimate search cost" in that window hits a still-disabled button
  // (sourceIds.length === 0) -- a real, if narrow, timing race in this
  // test, not the app. Confirmed by 3 consecutive real runs: flaky ~1/3
  // of the time on findByLabelText alone, deterministic once this waits
  // for the checked state that actually gates the button.
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
}

describe("App — search criteria form (ticket 957bc22)", () => {
  it("sends NO criteria (undefined) when the form is left untouched", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1" });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue({
      resumeId: "resume-1",
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0,
        probableCostUsd: 0,
        basis: "bootstrap",
      },
      candidatesNeedingScore: 0,
      scoreThreshold: 100,
      cappedCount: 0,
      alreadyScored: 0,
      sourceOutcomes: [],
      skippedSources: [],
    });

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], undefined);
  });

  it("sends a real, non-empty criteria object once the form has real input", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1" });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue({
      resumeId: "resume-1",
      costEstimate: {
        jobCount: 0,
        estimatedInputTokens: 0,
        estimatedCacheReadTokens: 0,
        estimatedCacheCreationTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
        maxCostUsd: 0,
        probableCostUsd: 0,
        basis: "bootstrap",
      },
      candidatesNeedingScore: 0,
      scoreThreshold: 100,
      cappedCount: 0,
      alreadyScored: 0,
      sourceOutcomes: [],
      skippedSources: [],
    });

    await submitResume();

    fireEvent.change(screen.getByLabelText(/Job titles to include/), {
      target: { value: "backend, platform engineer" },
    });
    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["backend", "platform engineer"],
      remoteOk: true,
    });
  });
});
