// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MATCH_SCORE_FLOOR,
  type EstimateSearchResponse,
  type GetResumeResultsResponse,
  type GetSourcesResponse,
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
const RESULTS: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [],
};
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
  createResume.mockResolvedValue({
    id: "resume-1",
    resumeNickname: "Resume 1",
    suggestedTitles: ["Backend Engineer"],
  });
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
    // Ticket 38a7598: the nickname is part of PersistedAppState too (bumped
    // to .v4) -- a reload must not show the resume as unnamed even though
    // the server still has a real nickname for it.
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1");
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");
    expect(screen.getByLabelText("Also show fully remote roles")).toBeChecked();

    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
  });

  // Review round 2 of ticket cdc2c39 (opus), F5: the first fix for the
  // textarea's read-only lock cleared `resumeId` on an "Edit resume"
  // click, which collapsed the whole app (everything gated on
  // `resumeId !== undefined`) and wiped this exact sessionStorage record
  // -- reproducing THIS ticket's own header on every Edit click. The
  // actual fix (App.tsx's separate `resumeEditing` flag) must not
  // regress back to that.
  it("clicking 'Edit resume' does not collapse the app or wipe state, and a reload mid-edit restores the last submitted state (review fix round 2, ticket cdc2c39)", async () => {
    mockHappyPath();
    await setUpRealState();

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));

    // Nothing unmounted: the textarea unlocked, but sources/criteria are
    // still right there, not collapsed back to the empty pre-resume view.
    expect(screen.getByLabelText("Paste your resume")).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("USAJOBS")).toBeInTheDocument();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");

    cleanup();
    createResume.mockClear();
    render(<App />);

    // A reload mid-edit must not read as "start over" either -- the last
    // SUBMITTED state comes back (ResumeInput's in-box edit was never
    // persisted in the first place; only a successful submit writes it).
    expect(await screen.findByText("Resume ready.")).toBeInTheDocument();
    expect(createResume).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Paste your resume")).toHaveValue(RESUME_TEXT);
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
  });

  it("restores 'Any location' checked across a reload, with the button enabled and no warning (ticket b9e6251)", async () => {
    mockHappyPath();
    render(<App />);
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: RESUME_TEXT },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    fireEvent.click(screen.getByLabelText(/Any location/));
    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    cleanup();

    render(<App />);

    await screen.findByText("Resume ready.");
    expect(screen.getByLabelText(/Any location/)).toBeChecked();
    expect(screen.queryByText(/No location restriction is set/)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled(),
    );
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
    expect(sessionStorage.getItem("jobsearch.web.appState.v4")).toBeNull();
  });

  it("ignores a corrupt record and starts clean rather than crashing", async () => {
    // Ticket b9e6251 bumped this key from .v1 to .v2 (CriteriaFormState
    // gained `anyLocationOk`); ticket ffbf9fb bumped it again to .v3
    // (PersistedAppState gained `scoreFloor`); ticket 38a7598 bumped it
    // again to .v4 (PersistedAppState gained `resumeNickname`) -- must set
    // the key the app ACTUALLY reads, or this test would silently pass for
    // the wrong reason (never even attempting to read the "corrupt" data
    // because it's under a key nothing reads anymore).
    sessionStorage.setItem("jobsearch.web.appState.v4", '{"resumeId": 42}');
    mockHappyPath();

    render(<App />);

    expect(screen.getByLabelText("Paste your resume")).toHaveValue("");
    expect(screen.queryByText("Resume ready.")).not.toBeInTheDocument();
  });

  it("falls back to the default floor when a persisted scoreFloor is out of the slider's 0-90 range (opus review, ticket ffbf9fb minor)", async () => {
    // Otherwise-valid record (every other field matches what setUpRealState
    // would have written), but `scoreFloor` is a hand-edited/otherwise
    // corrupt value far outside the slider's actual bounds. Before this
    // fix, `readAppState` only checked "is a finite number" -- this would
    // have loaded straight through and gone to `?minScore=` as 1e6, while
    // the slider itself renders clamped at 90 (a visible mismatch between
    // what the UI shows and what's actually sent to the server).
    sessionStorage.setItem(
      "jobsearch.web.appState.v4",
      JSON.stringify({
        resumeId: "resume-1",
        resumeNickname: "Resume 1",
        resumeText: RESUME_TEXT,
        selectedSourceIds: ["usajobs"],
        titleChips: ["Backend Engineer"],
        criteriaForm: {
          nearLocations: "",
          remoteOk: false,
          anyLocationOk: true,
          commitmentIn: [],
        },
        scoreFloor: 1_000_000,
      }),
    );
    mockHappyPath();

    render(<App />);

    // The whole record is treated as invalid (matching how every other
    // rejected field in this file's "corrupt record" test behaves) rather
    // than salvaging the in-range fields — falls back to a clean start.
    expect(screen.getByLabelText("Paste your resume")).toHaveValue("");
    expect(screen.queryByText("Resume ready.")).not.toBeInTheDocument();

    // And once a fresh resume is submitted from this clean state, the
    // floor sent to the server is the real default, not the corrupt value.
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: RESUME_TEXT },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await waitFor(() =>
      expect(getResults).toHaveBeenCalledWith("resume-1", {
        minScore: MATCH_SCORE_FLOOR,
        includeDismissed: true,
      }),
    );
  });
});
