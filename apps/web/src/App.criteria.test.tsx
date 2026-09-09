// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 39b4a48: resume-inferred title chips replace ticket 957bc22's
 * "leave everything blank = undefined" design. The money-critical behavior
 * now is the OPPOSITE direction from before: criteria must be a REAL
 * object from the moment a resume exists — including when suggestedTitles
 * comes back empty — never `undefined` (which would silently reproduce
 * the old hardcoded software-engineering/staff-excluding default). Nicole,
 * live: "I'd rather have it be a really expensive search offered than a
 * blind default."
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
  // Ticket 3f05144: this app now persists an in-progress resume/search to
  // `sessionStorage`, which — unlike React state — is NOT torn down by
  // `cleanup()`. Without this, one test's submitted resume or in-flight
  // searchId would be restored by the next test's first render.
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const RESULTS: GetResumeResultsResponse = { resumeId: "resume-1", results: [] };

function makeEstimate(): EstimateSearchResponse {
  return {
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
  };
}

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

describe("App — resume-inferred title chips (ticket 39b4a48)", () => {
  it("sends a REAL empty criteria object (never undefined) when the resume has no suggested titles", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    expect(
      screen.getByText(/No title keywords yet.*leave this empty to search every title/),
    ).toBeInTheDocument();

    // Ticket b9e6251: an empty location (no nearLocations, no remoteOk)
    // now requires the explicit "Any location" opt-in before the estimate
    // button is even enabled -- see SearchCriteriaForm's own location
    // warning.
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // The critical assertion: {} (a real, empty, permissive object), NOT
    // undefined -- undefined would silently reproduce the old hardcoded
    // default this ticket exists to remove. `anyLocationOk` itself is a
    // frontend-only gating signal -- it never appears in the criteria
    // payload sent to the API.
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {});
  });

  it("pre-populates chips from the resume's real suggestedTitles and sends them as titleInclude", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Backend Engineer", "Platform Engineer"],
    });
  });

  it("removing a suggested chip changes what's sent", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: 'Remove "Backend Engineer"' }));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Platform Engineer"],
    });
  });

  it("adding a custom chip includes it alongside the suggestions", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: ["Backend Engineer"] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.change(screen.getByLabelText("Add a job title keyword"), {
      target: { value: "Site Reliability Engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Backend Engineer", "Site Reliability Engineer"],
      remoteOk: true,
    });
  });

  it("commitment checkboxes (ticket 18c9f18) are omitted from criteria when unchecked and sent as commitmentIn when checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Contract"));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      commitmentIn: ["full-time", "contract"],
    });
  });
});

// Ticket b9e6251: an empty location used to mean "search anywhere,
// silently" -- the same shape of never-explicitly-chosen default Nicole's
// own principle already rejected for title keywords. Now it requires a
// real, explicit signal before "Estimate search cost" is even reachable.
describe("App — explicit any-location opt-in (ticket b9e6251)", () => {
  it("disables Estimate search cost and shows a warning when no location signal is set", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();

    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/No location restriction is set/);
  });

  it("checking 'Any location' enables the button and clears the warning", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Any location/));

    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
  });

  it("typing a commute location enables the button without needing 'Any location' checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
      target: { value: "seattle" },
    });

    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("checking 'Also show fully remote roles' enables the button without needing 'Any location' checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("unchecking 'Any location' again re-disables the button (not a one-way opt-in)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();

    fireEvent.click(screen.getByLabelText(/Any location/));

    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/No location restriction is set/);
  });

  it("'Any location' does not appear in the criteria payload sent to the API -- it's a frontend-only gate", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: [] });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sentCriteria = estimateSearch.mock.calls[0]?.[2];
    expect(sentCriteria).toEqual({});
    expect(sentCriteria).not.toHaveProperty("anyLocationOk");
  });
});
