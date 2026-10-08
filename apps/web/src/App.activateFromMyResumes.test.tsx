// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  ListResumesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 11ead86 ("Add an activate action to My Resumes"). App-level
 * integration coverage for the two dead ends the ticket's body names, plus
 * its one explicit acceptance-criterion guard -- component-level coverage
 * of the control itself (button vs. "Active" marker, disabled states,
 * error rendering) lives in MyResumes.test.tsx. This file exists to prove
 * the WIRING: that App.tsx's existing `handleActivateResume` (ticket
 * 88f11d7) really is reachable from the "My Resumes" tab and really does
 * leave the user able to act on the resume they picked, for both of the
 * concrete dead ends the ticket names:
 *
 *  1. An active-but-UNLOCKED resume (pasted, never searched): the
 *     collapsed bar on the search tab shows "Edit", which reopens the
 *     paste form -- not the picker -- so there was no path to a
 *     DIFFERENT saved resume without submitting something first.
 *  2. A stale restored `resumeId`: the mount-only hydration effect
 *     (App.tsx) swallows a failed `GET /resumes/:id` and leaves
 *     `resumeId` set, naming a row the server no longer has.
 *
 * Plus the one acceptance criterion that is a real GUARD, not just a
 * wiring check: "Change"'s own `searching` gate must also cover this new
 * entry point, since (unlike the no-active-resume picker in
 * ResumeInput.tsx, which is provably unreachable mid-search) "My Resumes"
 * is a whole separate, always-mounted tab and stays reachable throughout a
 * running search.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResume: (...args: unknown[]) => getResume(...args),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: vi.fn(),
  updateResumeNickname: vi.fn(),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
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

function emptyResultsFor(resumeId: string, nickname: string): GetResumeResultsResponse {
  return { resumeId, resumeNickname: nickname, results: [] };
}

async function submitResume(text = "some resume text") {
  fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

function goToMyResumesTab() {
  fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
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

describe("App — activating a resume from 'My Resumes' (ticket 11ead86)", () => {
  // Dead end 1: an active-but-UNLOCKED resume. "Edit" on the search tab
  // reopens the paste form, never the picker (ResumeInput.tsx's picker
  // branch requires `changingResume`, only reachable from "Change", which
  // only exists once `isLocked`). Before this ticket there was NO path
  // from here to a different saved resume short of submitting new text.
  it("switches to a different saved resume from My Resumes while the active one is still unlocked, and lands back on New Job Search able to act", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false, // UNLOCKED -- the dead end this ticket exists for
    });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-2"
          ? emptyResultsFor("resume-2", "Resume 2")
          : emptyResultsFor("resume-1", "Resume 1"),
      ),
    );

    render(<App />);
    await submitResume();

    // Confirm the dead end actually exists in this state: "Edit", not
    // "Change" -- no picker reachable from the search tab at all.
    expect(await screen.findByRole("button", { name: "Edit resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change resume" })).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();
    expect(screen.getByRole("heading", { name: /My Resumes/ })).toBeInTheDocument();

    getResume.mockResolvedValue({
      id: "resume-2",
      resumeText: "resume 2's own full text",
      resumeNickname: "Resume 2",
      isLocked: false,
      suggestedTitles: ["Data Analyst"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    // Acceptance criterion: lands back on "New Job Search" on success.
    // Resume 2 is unlocked, so that tab now shows the COLLAPSED bar
    // ("Using Resume 2"), not the paste form -- the same render ticket
    // 88f11d7's own "Use Resume 8" test (App.resumeLock.test.tsx) checks
    // for after an activation, not the "Paste your resume" label.
    await waitFor(() => {
      expect(screen.getByText("Using Resume 2")).toBeInTheDocument();
    });
    // And the tab really did switch -- "My Resumes" heading is gone from
    // view (its section is now the one hidden), proving this isn't just
    // the picker's old "Using Resume 2" bar rendering underneath an
    // unmoved tab.
    expect(screen.queryByRole("heading", { name: /My Resumes/ })).not.toBeInTheDocument();
    expect(getResume).toHaveBeenCalledWith("resume-2");
    // A pure pick, never a paste -- the original createResume call is the
    // only one for the whole test.
    expect(createResume).toHaveBeenCalledTimes(1);
  });

  // Dead end 2: a stale restored resumeId. The mount-only hydration effect
  // swallows a failed GET /resumes/:id (App.tsx's own documented,
  // deliberately-out-of-scope gap) and leaves `resumeId` set, naming a row
  // the server no longer has. This ticket doesn't fix THAT swallow -- it
  // only has to prove the user is no longer stuck once it happens.
  it("recovers from a stale restored resumeId by activating a real resume from My Resumes", async () => {
    sessionStorage.setItem(
      "jobsearch.web.appState.v5",
      JSON.stringify({
        resumeId: "resume-gone",
        resumeText: "text the server no longer has",
        resumeNickname: "Resume 1",
        selectedSourceIds: ["usajobs"],
        titleChips: [],
        criteriaForm: {
          nearLocations: "",
          expandMetroAreas: false,
          remoteOk: false,
          anyLocationOk: false,
          commitmentIn: [],
        },
        scoreFloor: 50,
      }),
    );
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-2"
          ? emptyResultsFor("resume-2", "Resume 2")
          : emptyResultsFor("resume-gone", "Resume 1"),
      ),
    );
    // The stale id 404s (hydration's own `getResume`, swallowed by
    // App.tsx); the real saved resume resolves normally.
    getResume.mockImplementation((id: string) => {
      if (id === "resume-gone") return Promise.reject(new Error("Not found"));
      return Promise.resolve({
        id: "resume-2",
        resumeText: "resume 2's own full text",
        resumeNickname: "Resume 2",
        isLocked: false,
        suggestedTitles: [],
      });
    });

    render(<App />);

    // The restored (stale) state renders first, "stuck" exactly as the
    // ticket describes: a resume is "active" that the server can't find,
    // and "Edit" is the only button (never "Change", since the swallowed
    // hydration failure also never sets `resumeLocked`).
    expect(await screen.findByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit resume" })).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    await waitFor(() => {
      expect(screen.getByText("Using Resume 2")).toBeInTheDocument();
    });
    expect(screen.queryByText("Using Resume 1")).not.toBeInTheDocument();
  });
});

describe("App — My Resumes activate action respects the searching guard (ticket 11ead86)", () => {
  // Acceptance criterion: "unlike e2b5f9c's block, this IS reachable
  // mid-search (resumeId is defined), so changing resumes under a running
  // search must be prevented or clearly refused." Mirrors
  // App.resumeLock.test.tsx's own "Change unavailable during an active
  // search" coverage, applied to this new entry point.
  it("disables 'Use {nickname}' on My Resumes while a real search is running", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue(emptyResultsFor("resume-1", "Resume 1"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      scoredSoFar: 0,
      linked: 1,
      cappedForBudget: 0,
      sources: [],
      stalledSince: undefined,
    });

    render(<App />);
    await submitResume();
    await screen.findByRole("button", { name: "Change resume" });

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run search" }));

    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    const useButton = screen.getByRole("button", { name: "Use Resume 2" });
    expect(useButton).toBeDisabled();
    // Scoped to the "My Resumes" section -- the search tab's own,
    // identically-worded note (ticket 88f11d7) is ALSO mounted right now
    // (tabs stay mounted, only `hidden`), so an unscoped match is
    // ambiguous. Both reusing the same sentence is deliberate, not a bug
    // -- see MyResumes.tsx's own comment.
    expect(
      within(screen.getByRole("heading", { name: /My Resumes/ }).closest("section")!).getByText(
        "Can't change resumes while a search is running.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(useButton);
    expect(getResume).not.toHaveBeenCalled();
  });
});
