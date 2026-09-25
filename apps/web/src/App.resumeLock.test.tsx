// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 88f11d7 (Nicole: "once that has happened [a real search], then a
 * user can't change the text on the resume anymore... if they hit change,
 * I want them to have the option somehow of... toggle buttons... Use
 * Resume 16, Use Resume 8, Use Resume 14, and then there's like something
 * that says Or, and then it says Paste a new resume"). Covers:
 *
 *  - the collapsed bar's button swapping "Edit" -> "Change" once the
 *    active resume is `isLocked`
 *  - "Change" opening the picker (other saved resumes + "Paste a new
 *    resume"), never the paste form directly
 *  - activating an existing resume being a pure `GET /resumes/:id` --
 *    NEVER `createResume`/`POST /resumes` (Nicole: "it's a pick, not a
 *    paste") -- so it can never trip the ticket 7701534 duplicate-text
 *    guardrail
 *  - "Change" being disabled (with an explanatory note) while a search is
 *    actively running for the current resume (Nicole: "I don't think that
 *    we should allow a change of resume while a search is in progress")
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
const EMPTY_RESULTS: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [],
};

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

async function submitResume(text = "some resume text") {
  fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
}

/**
 * A promise this test controls the resolution timing of -- same shape as
 * SearchFlow.test.tsx's own `deferred` helper, used here so "the request
 * is still in flight" is a real, held-open state to inspect/act around,
 * not just something inferred from timing.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("App — Edit/Change swap (ticket 88f11d7)", () => {
  it("shows 'Edit' for a resume that has never had a real search run against it", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });

    render(<App />);
    await submitResume();

    expect(await screen.findByRole("button", { name: "Edit resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change resume" })).not.toBeInTheDocument();
  });

  it("shows 'Change' instead of 'Edit' once CreateResumeResponse.isLocked is true", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });

    render(<App />);
    await submitResume();

    expect(await screen.findByRole("button", { name: "Change resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
  });
});

describe("App — the 'Change' picker (ticket 88f11d7)", () => {
  async function getToLockedResumeWithPicker() {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });

    render(<App />);
    await submitResume();
    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
  }

  it("opens a picker -- other saved resumes as toggle buttons, plus 'Paste a new resume' -- not the paste form", async () => {
    await getToLockedResumeWithPicker();

    expect(screen.getByRole("button", { name: "Use Resume 8" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Paste a new resume" })).toBeInTheDocument();
    // The picker, not the ordinary expanded form.
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();
  });

  // The currently-active resume has nothing to do in its own picker.
  it("excludes the currently-active resume from its own picker's list", async () => {
    await getToLockedResumeWithPicker();

    expect(screen.queryByRole("button", { name: "Use Resume 1" })).not.toBeInTheDocument();
  });

  it("'Paste a new resume' opens the ordinary expanded paste form", async () => {
    await getToLockedResumeWithPicker();

    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Resume 8" })).not.toBeInTheDocument();
  });

  it("Cancel returns to the collapsed bar without touching the active resume", async () => {
    await getToLockedResumeWithPicker();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();
    expect(getResume).not.toHaveBeenCalled();
  });

  // Nicole: "already exists in full, use resume 8... doesn't need to
  // submit anything or check anything. It just needs to say the active
  // resume is now 8... it's a pick, not a paste." A pure GET, never a
  // POST -- so it can never trip the ticket 7701534 duplicate-text
  // guardrail, which only fires on a real POST /resumes body.
  it("'Use Resume 8' fetches it via GET /resumes/:id and adopts it directly -- never POST /resumes", async () => {
    await getToLockedResumeWithPicker();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's full text",
      resumeNickname: "Resume 8",
      isLocked: true,
      suggestedTitles: ["Data Analyst"],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-8",
      resumeNickname: "Resume 8",
      results: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    await waitFor(() => expect(getResume).toHaveBeenCalledWith("resume-8"));
    // Adopted: collapsed bar now shows the picked resume, already locked
    // (so "Change" again, not "Edit"), and the picker/form are gone.
    expect(await screen.findByText("Using Resume 8")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Resume 8" })).not.toBeInTheDocument();
    // Never resubmitted as if it were new text.
    expect(createResume).toHaveBeenCalledTimes(1); // only the original submission
    // Its own cached title suggestions repopulate titleChips.
    expect(
      within(screen.getByLabelText("Job title keywords")).getByText("Data Analyst"),
    ).toBeInTheDocument();
  });

  it("shows a blocking error, without adopting anything, if GET /resumes/:id fails", async () => {
    await getToLockedResumeWithPicker();
    getResume.mockRejectedValue(new Error("Could not reach the API"));

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load that resume: Could not reach the API",
    );
    // Still on the picker, still showing Resume 1 as active underneath.
    expect(screen.getByRole("button", { name: "Use Resume 8" })).toBeInTheDocument();
  });

  // Review fix (N1, ticket 88f11d7): reproduced live -- "Change" -> "Use
  // Resume 8" -> "Change" -> "Paste a new resume" rendered the textarea
  // still showing Resume 1's OWN text, because ResumeInput's local `text`
  // state is seeded once at mount and nothing forced a remount when
  // `resumeId` changed via activation (as opposed to a submission, the
  // only path that used to change it). Fixed via `key={resumeId}` on
  // App.tsx's `<ResumeInput>`.
  it("shows the ACTIVATED resume's own text, not the previous resume's, after activating then reopening the paste form", async () => {
    await getToLockedResumeWithPicker();
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own distinct full text",
      resumeNickname: "Resume 8",
      isLocked: true,
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-8",
      resumeNickname: "Resume 8",
      results: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    expect(await screen.findByText("Using Resume 8")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    expect(screen.getByLabelText("Paste your resume")).toHaveValue(
      "resume 8's own distinct full text",
    );
  });
});

describe("App — 'Change' unavailable during an active search (ticket 88f11d7)", () => {
  it("disables 'Change', with an explanatory note, while a real search is running for the locked resume", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    // Stays "pending" -- the run is still actively going the whole time
    // this test inspects the "Change" button.
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

    expect(screen.getByRole("button", { name: "Change resume" })).toBeDisabled();
    expect(screen.getByText("Can't change resumes while a search is running.")).toBeInTheDocument();
  });

  // Review fix (F1, ticket 88f11d7): the primary product path -- a resume
  // that was UNLOCKED when the search started must lock THIS SESSION, the
  // moment the run is confirmed, not only on a later reload. Reproduced
  // (pre-fix) via a repro test that this replaces: the collapsed bar kept
  // showing "Edit", enabled, for the entire duration of a running search,
  // and clicking it reopened the paste textarea mid-run.
  it("locks an UNLOCKED resume the moment its own real search is confirmed running -- no reload required", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false, // starts UNLOCKED -- THIS run is what locks it
    });
    estimateSearch.mockResolvedValue(makeEstimate());
    const { promise: startPromise, resolve: resolveStart } = deferred<{
      searchId: string;
      status: "pending";
      skippedSources: string[];
    }>();
    startSearch.mockReturnValue(startPromise);
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
    expect(await screen.findByRole("button", { name: "Edit resume" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run search" }));

    // "starting": POST /searches is in flight, no searchId adopted yet.
    // The button must ALREADY be unreachable here -- not just once
    // `isLocked` catches up -- otherwise a click in this exact window
    // still reopens the paste form mid-request.
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit resume" })).toBeDisabled());
    expect(screen.getByText("Can't change resumes while a search is running.")).toBeInTheDocument();

    await act(async () => {
      resolveStart({ searchId: "search-1", status: "pending", skippedSources: [] });
      await startPromise;
    });

    // "running": the run is confirmed -- the button itself has flipped to
    // "Change" (isLocked is now true THIS SESSION), still disabled.
    await screen.findByRole("heading", { name: "Search running..." });
    expect(screen.getByRole("button", { name: "Change resume" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Edit resume" })).not.toBeInTheDocument();
  });
});

describe("App — Cancel during an in-flight activation (review fix F2, ticket 88f11d7)", () => {
  it("does not adopt the picked resume if its GET /resumes/:id resolves AFTER Cancel", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    const { promise, resolve } = deferred<{
      id: string;
      resumeText: string;
      resumeNickname: string;
      isLocked: boolean;
      suggestedTitles: string[];
    }>();
    getResume.mockReturnValue(promise);

    render(<App />);
    await submitResume();
    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    // Cancel BEFORE the slow GET resolves -- back to the collapsed bar,
    // Resume 1 still active.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();

    // The stale response now lands.
    await act(async () => {
      resolve({
        id: "resume-8",
        resumeText: "resume 8's full text",
        resumeNickname: "Resume 8",
        isLocked: true,
        suggestedTitles: [],
      });
      await promise;
    });

    // Must NOT have silently adopted Resume 8 after the fact.
    expect(screen.getByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.queryByText("Using Resume 8")).not.toBeInTheDocument();
  });

  it("does not adopt the picked resume if its GET /resumes/:id resolves AFTER 'Paste a new resume'", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    getResults.mockResolvedValue(EMPTY_RESULTS);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    const { promise, resolve } = deferred<{
      id: string;
      resumeText: string;
      resumeNickname: string;
      isLocked: boolean;
      suggestedTitles: string[];
    }>();
    getResume.mockReturnValue(promise);

    render(<App />);
    await submitResume();
    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));

    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();

    await act(async () => {
      resolve({
        id: "resume-8",
        resumeText: "resume 8's full text",
        resumeNickname: "Resume 8",
        isLocked: true,
        suggestedTitles: [],
      });
      await promise;
    });

    // Still on the paste form -- the stale activation must not have
    // yanked the user back to a collapsed "Using Resume 8" bar.
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
    expect(screen.queryByText("Using Resume 8")).not.toBeInTheDocument();
  });
});
