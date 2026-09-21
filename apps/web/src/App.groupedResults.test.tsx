// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GetAllResultsResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  ScoredJobResult,
} from "@app/shared";
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
// Ticket 3f0883f: "Already Scored Jobs" now reads GET /results (every
// resume), not GET /resumes/:id/results -- `useAllResults` calls this
// unconditionally on every mount, same as `getResults`, so every test that
// renders <App /> needs it mocked to resolve or the hook's `.then()` throws
// against an unmocked `undefined` return.
const getAllResults = vi.fn();
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
  getAllResults: (...args: unknown[]) => getAllResults(...args),
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
  // Ticket 3f05144: this app now persists an in-progress resume/search to
  // `sessionStorage`, which — unlike React state — is NOT torn down by
  // `cleanup()`. Without this, one test's submitted resume or in-flight
  // searchId would be restored by the next test's first render.
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

function job(
  overrides: Partial<ScoredJobResult> & Pick<ScoredJobResult, "jobId">,
): ScoredJobResult {
  return {
    // Ticket 3f0883f: see ScoredJobResult.resumeId's own doc comment.
    resumeId: "resume-1",
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
    levelFit: null,
    levelFitNote: null,
    isContractOrTemp: false,
    // Ticket 38a7598 review fix: per-result now, not response-level -- see
    // ScoredJobResult.resumeNickname's doc comment in @app/shared.
    resumeNickname: "Resume 1",
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
  // Ticket b9e6251: an empty location now requires the explicit "Any
  // location" opt-in before "Estimate search cost" is enabled.
  fireEvent.click(screen.getByLabelText(/Any location/));
}

describe("dismissed jobs stay visible in 'Results from this search' (ticket bec2f98)", () => {
  it("a dismissed job appears with a visible 'Dismissed' indicator once a search completes", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        job({ jobId: "job-1", title: "Backend Engineer", status: "dismissed" }),
        job({ jobId: "job-2", title: "Frontend Engineer", status: null }),
      ],
    } satisfies GetResumeResultsResponse);
    // This test only checks "Results from this search" -- "Already Scored
    // Jobs" content doesn't matter here, but useAllResults still fires on
    // mount and needs something to resolve to.
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
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
    resumeNickname: "Resume 1",
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
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    // Ticket 3f0883f: "Already Scored Jobs" reads getAllResults now, not
    // getResults -- getResults is given an unrelated, unchecked value
    // purely so useResults's own fetch has something to resolve to.
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValue(GROUPED_RESULTS);

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    // Job titles ("Saved Job", etc.) also render as level-3 headings
    // (ResultCard's own `<h3>`), so filter down to just the GROUP labels
    // rather than asserting on every level-3 heading in the tree.
    // Ticket bec2f98's original order (Saved, No action taken, Resume
    // Optimized, Applied, Dismissed) was revised in dogfooding feedback
    // (2026-09-08): Applied moved up ahead of No action taken.
    const GROUP_LABELS = ["Saved", "Applied", "No action taken", "Resume Optimized", "Dismissed"];
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
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    // Ticket 3f0883f: "Already Scored Jobs" reads getAllResults now --
    // getResults gets an unrelated, unchecked stable value purely so
    // useResults's own fetch has something to resolve to.
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValueOnce(GROUPED_RESULTS);
    setJobStatus.mockResolvedValue({
      jobId: "job-saved",
      status: "resume_optimized",
      updatedAt: new Date().toISOString(),
    });

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    await screen.findByRole("heading", { name: "Saved" });

    // Refetch after the status write returns job-saved with its status
    // flipped to resume_optimized.
    const afterStatusChange: GetAllResultsResponse = {
      results: GROUPED_RESULTS.results.map((r) =>
        r.jobId === "job-saved" ? { ...r, status: "resume_optimized" } : r,
      ),
    };
    getAllResults.mockResolvedValueOnce(afterStatusChange);
    // Review finding (opus, ticket 3f0883f, non-blocking nit): without a
    // fallback, the mockResolvedValueOnce budget above is EXACTLY what
    // this test currently needs -- any extra getAllResults call a future
    // edit introduces would resolve `undefined`, and
    // `allResultsState.data.results.length` would throw. This fallback
    // keeps every call past the two explicit ones on the same
    // already-settled state, so an extra call degrades to "no visible
    // change" instead of a crash.
    getAllResults.mockResolvedValue(afterStatusChange);

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
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));

    await waitFor(() => {
      const resumeOptimizedSection = screen
        .getByRole("heading", { name: "Resume Optimized" })
        .closest("section")!;
      expect(within(resumeOptimizedSection).getByText("Saved Job")).toBeInTheDocument();
    });
  });
});

describe("'Already Scored Jobs' quick-jump links (ticket 1ea4bf3)", () => {
  const GROUPED_RESULTS: GetResumeResultsResponse = {
    resumeId: "resume-1",
    resumeNickname: "Resume 1",
    results: [
      job({ jobId: "job-saved", title: "Saved Job", status: "saved" }),
      job({ jobId: "job-dismissed", title: "Dismissed Job", status: "dismissed" }),
    ],
  };

  // CRITICAL REGRESSION TEST: this is the scenario the ticket calls out as
  // easy to get wrong -- someone "fixing" the frozen quick-link counts by
  // un-freezing `scoredGroupFor` entirely, which would silently undo ticket
  // bec2f98's card-placement freeze. This test follows the same shape as
  // bec2f98's own "does NOT move it to a new group" test above, but adds
  // assertions on the quick-link counts for BOTH the old and new groups,
  // checked in the SAME render as the frozen-placement assertion -- so a
  // regression in either direction (placement moving, or counts staying
  // stale) fails this one test.
  it("quick-link counts update live off a status change while the card's SECTION PLACEMENT stays frozen at tab-open (bec2f98)", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    // Ticket 3f0883f: "Already Scored Jobs" reads getAllResults now --
    // getResults gets an unrelated, unchecked stable value purely so
    // useResults's own fetch has something to resolve to.
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    getAllResults.mockResolvedValueOnce(GROUPED_RESULTS);
    setJobStatus.mockResolvedValue({
      jobId: "job-saved",
      status: "resume_optimized",
      updatedAt: new Date().toISOString(),
    });

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    await screen.findByRole("heading", { name: "Saved" });

    // Quick-links reflect the initial state: one Saved, one Dismissed, no
    // "Resume Optimized" link yet (that group is empty).
    expect(screen.getByText("Saved (1)")).toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();
    expect(screen.queryByText(/^Resume Optimized/)).not.toBeInTheDocument();

    // Refetch after the status write returns job-saved with its status
    // flipped to resume_optimized -- same as bec2f98's own test above.
    const afterStatusChange: GetAllResultsResponse = {
      results: GROUPED_RESULTS.results.map((r) =>
        r.jobId === "job-saved" ? { ...r, status: "resume_optimized" } : r,
      ),
    };
    getAllResults.mockResolvedValueOnce(afterStatusChange);
    // Review finding (opus, ticket 3f0883f, non-blocking nit): without a
    // fallback, the mockResolvedValueOnce budget above is EXACTLY what
    // this test currently needs -- any extra getAllResults call a future
    // edit introduces would resolve `undefined`, and
    // `allResultsState.data.results.length` would throw. This fallback
    // keeps every call past the two explicit ones on the same
    // already-settled state, so an extra call degrades to "no visible
    // change" instead of a crash.
    getAllResults.mockResolvedValue(afterStatusChange);

    const savedSection = screen.getByRole("heading", { name: "Saved" }).closest("section")!;
    fireEvent.click(within(savedSection).getByRole("button", { name: "Optimize Resume" }));

    // The card's own badge updates in place...
    await waitFor(() =>
      expect(within(savedSection).getByText("Resume optimized")).toBeInTheDocument(),
    );

    // LIVE quick-link counts have already updated, in this same render,
    // without leaving the tab: "Saved" lost its job, "Resume Optimized"
    // gained one, "Dismissed" is unaffected.
    await waitFor(() => expect(screen.getByText("Resume Optimized (1)")).toBeInTheDocument());
    expect(screen.queryByText("Saved (1)")).not.toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();

    // FROZEN card placement, checked in this SAME render as the live counts
    // above: the card is still rendered under "Saved" -- it has NOT moved
    // to a new "Resume Optimized" section. This is ticket bec2f98's
    // guarantee, and it must hold even though the quick-link counts above
    // just changed.
    expect(within(savedSection).getByText("Saved Job")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Resume Optimized" })).not.toBeInTheDocument();
  });
});

// Review round 1 (opus, BLOCKING), ticket 3f0883f: `handleSetStatus` used
// to write `POST /jobs/:id/status` with the SESSION's active resumeId,
// closed over from App state -- silently correct only because, before
// this ticket, a card on "Already Scored Jobs" could never belong to any
// resume but the one active this session. Once a card can belong to a
// DIFFERENT resume (the entire point of this ticket), that was the exact
// same bug the "Optimize Resume" handoff had already been fixed for
// elsewhere -- caught on re-review because the fix wasn't applied
// consistently. This is the direct regression proof: a card scored under
// a resume that is NOT the currently-active one must write status against
// ITS OWN resumeId, not the session's.
describe("A status write on 'Already Scored Jobs' uses the CARD's own resume, not the session's active one (review fix, ticket 3f0883f)", () => {
  it("clicking Save on a card scored under a different resume writes that card's resumeId, not the active session's", async () => {
    getSources.mockResolvedValue(SOURCES);
    // The session's OWN active resume -- deliberately a different id from
    // the card under test below.
    createResume.mockResolvedValue({
      id: "resume-active-session",
      resumeNickname: "Active Session Resume",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-active-session",
      resumeNickname: "Active Session Resume",
      results: [],
    });
    // "Already Scored Jobs" shows a card scored under a WHOLLY DIFFERENT
    // resume than the one just submitted above -- exactly the scenario
    // this ticket makes reachable for the first time.
    getAllResults.mockResolvedValue({
      results: [
        job({
          jobId: "job-from-another-resume",
          resumeId: "resume-from-a-past-session",
          resumeNickname: "An Old Resume",
          title: "Backend Engineer",
        }),
      ],
    });
    setJobStatus.mockResolvedValue({
      jobId: "job-from-another-resume",
      status: "saved",
      updatedAt: new Date().toISOString(),
    });

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    await screen.findByText("Backend Engineer");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(setJobStatus).toHaveBeenCalledTimes(1));
    // The card's OWN resumeId -- not "resume-active-session", the one
    // `submitResume()` just made the session's active resume.
    expect(setJobStatus).toHaveBeenCalledWith(
      "job-from-another-resume",
      "saved",
      "resume-from-a-past-session",
    );
  });
});
