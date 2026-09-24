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
// Ticket 3f0883f: "Already Scored Jobs" reads GET /results now -- see
// App.criteria.test.tsx's identical comment for the full reasoning. This
// file never checks that tab's content, so `mockHappyPath` below gives it
// an empty, unchecked stub.
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
  // Ticket bf2dd0a: SearchFlow now polls this alongside every estimate
  // call. This file never asserts on progress display, so a simple
  // always-rejecting stub (treated as "nothing to show" -- see
  // SearchFlow.tsx's startEstimateProgressPolling) is enough.
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  // Ticket 303cff0 ("My Resumes" tab): useResumesList fetches this
  // unconditionally on every App mount now, regardless of which tab is
  // active -- none of these tests assert on it, so a static empty list
  // (same pattern as getEstimateProgress above) is enough.
  listResumes: () => Promise.resolve({ resumes: [] }),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
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
  getAllResults.mockResolvedValue({ results: [] });
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
    // bounded) real Claude call for a resume it has never seen. Ticket
    // ac141d0: collapsed by default on a reload (resumeEditing isn't
    // persisted -- see App.tsx's doc comment on that state) -- the form
    // itself isn't rendered, but the nickname it would have shown is
    // right here in the summary bar (ticket 0308d7e dropped the separate
    // "Resume ready." text this used to also check for -- redundant once
    // this summary bar already says the same thing).
    expect(await screen.findByText("Using Resume 1")).toBeInTheDocument();
    expect(createResume).not.toHaveBeenCalled();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");
    expect(screen.getByLabelText("Also show fully remote roles")).toBeChecked();

    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();

    // Ticket 38a7598: the nickname is part of PersistedAppState too (bumped
    // to .v4) -- a reload must not show the resume as unnamed even though
    // the server still has a real nickname for it. Verified through Edit,
    // since ticket ac141d0's collapsed bar doesn't expose the form's own
    // nickname field directly.
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    expect(screen.getByLabelText("Paste your resume")).toHaveValue(RESUME_TEXT);
    expect(screen.getByLabelText("Resume Nickname")).toHaveValue("Resume 1");
  });

  // Ticket ac141d0 (Nicole: "I want the sources to all go away again...
  // figuring out what resume we're using is before what sources we want
  // to search"), building on cdc2c39's review round 2, F5 (opus): that
  // fix established clearing `resumeId` on an edit-click wipes this exact
  // sessionStorage record before any new resume exists to replace it. The
  // collapse/expand redesign deliberately hides sources/criteria while
  // editing (a real behavior change from cdc2c39, approved directly:
  // "Yes to the Sources criteria hide") -- but the underlying selections,
  // and the ability to recover them, must not be casualties of that.
  //
  // Review fix (F1/F2): an earlier version of this diff UNMOUNTED this
  // block (`{resumeId && !resumeEditing && (...)}`) instead of hiding it,
  // which silently killed SearchFlow's poll on Edit with no way back --
  // worst case, orphaning an already-started, already-paid-for search with
  // a leaked polling interval nothing could ever clear (see App.tabs
  // .test.tsx for the same-shaped hazard this project already knew about
  // for tab-switching, and the `hidden` fix below for the real one).
  // `not.toBeVisible()`, not `not.toBeInTheDocument()`, is what actually
  // proves the fix: these elements must still be MOUNTED, just hidden.
  it("clicking Edit hides sources/criteria (via `hidden`, not unmounting) without wiping their selections, and a reload mid-edit restores everything (ticket ac141d0)", async () => {
    mockHappyPath();
    await setUpRealState();

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));

    // Sources/criteria hide while the resume section is expanded for a
    // re-edit -- the new, deliberate behavior this ticket asked for --
    // but they're still in the document, not torn down.
    expect(screen.getByLabelText("USAJOBS")).not.toBeVisible();
    expect(screen.getByLabelText(/Locations you'd commute to/)).not.toBeVisible();

    // But nothing underneath was reset: resubmitting (identical text,
    // same resumeId) re-collapses, and the same selections are right
    // back, not defaults.
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");

    // A reload MID-edit (before resubmitting) must not lose the last
    // submitted state either -- same "a reload must not read as start
    // over" reasoning ticket 3f05144 established, now exercised through
    // the edit flow specifically.
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    cleanup();
    createResume.mockClear();
    render(<App />);

    expect(await screen.findByText("Using Resume 1")).toBeInTheDocument();
    expect(createResume).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveValue("seattle, bellevue");
  });

  // Review fix (F1/F2), the direct proof: clicking Edit must not reset an
  // in-progress SearchFlow estimate, the same way switching tabs doesn't
  // (App.tabs.test.tsx) -- and clicking "Cancel" (review fix F3) must get
  // back to it without submitting anything.
  it("an in-progress cost estimate survives clicking Edit and Cancel -- SearchFlow stays mounted, not reset (review fix, ticket ac141d0)", async () => {
    mockHappyPath();
    estimateSearch.mockResolvedValue(makeEstimate());
    await setUpRealState();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByLabelText("Cost estimate");
    createResume.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    // Hidden, not gone -- if this had unmounted SearchFlow, the estimate
    // would be gone entirely rather than merely invisible.
    expect(screen.getByLabelText("Cost estimate")).not.toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Back to collapsed, estimate exactly where it was left -- no
    // redundant re-estimate, and Cancel did not resubmit the resume.
    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Cost estimate")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run search" })).toBeInTheDocument();
    expect(estimateSearch).toHaveBeenCalledTimes(1);
    expect(createResume).not.toHaveBeenCalled();
  });

  // Review round 2 (N1, opus, non-blocking but cheap to close): a failed
  // resubmit's error must not outlive giving up on it -- clicking Cancel
  // (or a later Edit) after "Could not save resume: ..." was shown should
  // not leave that message sitting, stale, under the collapsed bar.
  it("clears a failed resubmit's error when Cancel is clicked, rather than leaving it stale under the collapsed bar (review fix N1, ticket ac141d0)", async () => {
    mockHappyPath();
    await setUpRealState();

    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    createResume.mockRejectedValueOnce(new Error("Network error"));
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save resume: Network error",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

    await screen.findByText("Using Resume 1");
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
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: [
          "Backend Engineer",
          "Program Analyst",
          "IT Specialist",
          "Computer Scientist",
        ],
        nearLocations: ["seattle", "bellevue"],
        remoteOk: true,
      },
      expect.any(String),
    );
  });

  it("keeps an all-sources-off selection off instead of re-checking the defaults", async () => {
    mockHappyPath();
    await setUpRealState();
    fireEvent.click(screen.getByLabelText("USAJOBS"));
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).not.toBeChecked());
    cleanup();

    render(<App />);
    await screen.findByText("Using Resume 1");

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
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();
    expect(sessionStorage.getItem("jobsearch.web.appState.v5")).toBeNull();
  });

  it("ignores a corrupt record and starts clean rather than crashing", async () => {
    // Ticket b9e6251 bumped this key from .v1 to .v2 (CriteriaFormState
    // gained `anyLocationOk`); ticket ffbf9fb bumped it again to .v3
    // (PersistedAppState gained `scoreFloor`); ticket 38a7598 bumped it
    // again to .v4 (PersistedAppState gained `resumeNickname`); ticket
    // 410e1a2 bumped it to .v5 (CriteriaFormState gained
    // `expandMetroAreas`) -- must set
    // the key the app ACTUALLY reads, or this test would silently pass for
    // the wrong reason (never even attempting to read the "corrupt" data
    // because it's under a key nothing reads anymore).
    sessionStorage.setItem("jobsearch.web.appState.v5", '{"resumeId": 42}');
    mockHappyPath();

    render(<App />);

    expect(screen.getByLabelText("Paste your resume")).toHaveValue("");
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();
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
      "jobsearch.web.appState.v5",
      JSON.stringify({
        resumeId: "resume-1",
        resumeNickname: "Resume 1",
        resumeText: RESUME_TEXT,
        selectedSourceIds: ["usajobs"],
        titleChips: ["Backend Engineer"],
        criteriaForm: {
          nearLocations: "",
          expandMetroAreas: false,
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
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();

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
