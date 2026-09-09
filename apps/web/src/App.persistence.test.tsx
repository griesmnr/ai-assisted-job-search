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
 * Ticket 3f05144 — a reload must not read as "start over".
 *
 * "A reload" here is: unmount, then render `<App />` again with
 * `sessionStorage` untouched. See SearchFlow.persistence.test.tsx's header
 * for why that is a faithful model, and session.ts's for the real-browser
 * reproduction that established the mechanism.
 *
 * This file covers App's half — resume, source toggles, title chips,
 * criteria — which is what Nicole actually saw vanish ("it was all clear
 * again"). SearchFlow's half (the money-relevant in-flight searchId) is
 * covered in that component's own persistence test.
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
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [
    { id: "usajobs", displayName: "USAJOBS", configured: true },
    { id: "greenhouse", displayName: "Greenhouse", configured: true },
  ],
};
const RESULTS: GetResumeResultsResponse = { resumeId: "resume-1", results: [] };
const RESUME_TEXT = "ten years of backend engineering, mostly Node and Postgres";

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

function mockHappyPath() {
  getSources.mockResolvedValue(SOURCES);
  createResume.mockResolvedValue({ id: "resume-1", suggestedTitles: ["Backend Engineer"] });
  getResults.mockResolvedValue(RESULTS);
}

/** Gets the app into the state Nicole was in when she put the laptop
 * down: a submitted resume, a non-default source selection, and edited
 * criteria. */
async function setUpRealState() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: RESUME_TEXT },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  // Wait for CHECKED, not merely present — same race App.criteria.test.tsx
  // documents: the toggles render one render before the auto-select effect
  // populates them.
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());

  fireEvent.click(screen.getByLabelText("Greenhouse"));
  fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
    target: { value: "seattle, bellevue" },
  });
  fireEvent.click(screen.getByLabelText("Also show fully remote roles"));
  await waitFor(() => expect(screen.getByLabelText("Greenhouse")).not.toBeChecked());
}

describe("App — surviving a reload (git-bug 3f05144)", () => {
  it("restores the resume, its title chips, the source selection and the criteria", async () => {
    mockHappyPath();
    await setUpRealState();
    cleanup();
    createResume.mockClear();

    render(<App />);

    // The resume comes back WITHOUT re-POSTing it — a reload must not
    // silently re-submit anything, and `POST /resumes` makes a (small,
    // bounded) real Claude call for a resume it has never seen.
    expect(await screen.findByText("Resume ready.")).toBeInTheDocument();
    expect(createResume).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Paste your resume")).toHaveValue(RESUME_TEXT);
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");
    expect(screen.getByLabelText("Also show fully remote roles")).toBeChecked();

    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
  });

  it("sends the restored criteria on the next estimate, not the defaults", async () => {
    mockHappyPath();
    estimateSearch.mockResolvedValue(makeEstimate());
    await setUpRealState();
    cleanup();

    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // Restoring the toggles without restoring what they MEAN would be the
    // worst of both worlds: a screen that looks right pricing a search it
    // isn't describing.
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Backend Engineer"],
      nearLocations: ["seattle", "bellevue"],
      remoteOk: true,
    });
  });

  it("keeps an all-sources-off selection off instead of re-checking the defaults", async () => {
    mockHappyPath();
    await setUpRealState();
    fireEvent.click(screen.getByLabelText("USAJOBS"));
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).not.toBeChecked());
    cleanup();

    render(<App />);
    await screen.findByText("Resume ready.");

    // The `prev.size > 0` guard alone cannot tell "the user unchecked
    // everything" from "nothing has been chosen yet", so without the
    // restored-selection flag this reload would silently turn every source
    // back on — starting over while looking like it hadn't.
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeInTheDocument());
    expect(screen.getByLabelText("USAJOBS")).not.toBeChecked();
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
  });

  it("starts clean when nothing has been submitted yet", async () => {
    mockHappyPath();
    render(<App />);
    await waitFor(() => expect(getSources).toHaveBeenCalled());
    cleanup();

    render(<App />);

    // No resume means nothing worth restoring; the empty screen IS the
    // right state, and no record should have been written to resurrect.
    expect(screen.queryByText("Resume ready.")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("jobsearch.web.appState.v2")).toBeNull();
  });

  it("ignores a corrupt record and starts clean rather than crashing", async () => {
    // Ticket b9e6251 bumped this key from .v1 to .v2 (CriteriaFormState
    // gained `anyLocationOk`) -- must set the key the app ACTUALLY reads,
    // or this test would silently pass for the wrong reason (never even
    // attempting to read the "corrupt" data because it's under a key
    // nothing reads anymore).
    sessionStorage.setItem("jobsearch.web.appState.v2", '{"resumeId": 42}');
    mockHappyPath();

    render(<App />);

    expect(screen.getByLabelText("Paste your resume")).toHaveValue("");
    expect(screen.queryByText("Resume ready.")).not.toBeInTheDocument();
  });
});
