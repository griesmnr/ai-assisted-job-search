// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EstimateSearchResponse } from "@app/shared";
import { SearchFlow } from "./SearchFlow";

/**
 * Ticket 3f05144 — surviving a reload.
 *
 * WHAT "a reload" IS IN THESE TESTS: unmount, then mount again with
 * `sessionStorage` left exactly as the first mount wrote it. That is a
 * faithful model of the real event, because a reload's whole effect on
 * this component is "every piece of React state is gone, storage is not."
 * The mechanism was confirmed in a real browser (see session.ts's header
 * and this branch's commit message) — killing and restarting the Vite dev
 * server under an open tab makes Vite's HMR client log "[vite] server
 * connection lost. Polling for restart..." and then hard-reload the page,
 * and a plain `location.reload()` of a PRODUCTION build (which has no HMR
 * client at all) does exactly the same damage. These tests cover the
 * damage, which is the part that is not dev-only.
 *
 * Same RTL-cleanup reasoning as SearchFlow.test.tsx: no `test.globals`, so
 * `cleanup()` has to be called explicitly. `sessionStorage.clear()` joins
 * it now that this component persists across mounts — without it, one
 * test's in-flight run would be restored by the next test's first render.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();

vi.mock("../api/client", () => ({
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

const ACTIVE_SEARCH_KEY = "jobsearch.web.activeSearch.v1";

function makeEstimate(overrides: Partial<EstimateSearchResponse> = {}): EstimateSearchResponse {
  return {
    resumeId: "resume-1",
    costEstimate: {
      jobCount: 10,
      estimatedInputTokens: 1000,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 200,
      estimatedCostUsd: 0.42,
      maxCostUsd: 0.42,
      probableCostUsd: 0.3,
      basis: "bootstrap",
    },
    candidatesNeedingScore: 10,
    scoreThreshold: 100,
    cappedCount: 0,
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
    ...overrides,
  };
}

function persistedRun(overrides: Record<string, unknown> = {}) {
  return {
    searchId: "search-abc",
    resumeId: "resume-1",
    startedAt: Date.now() - 30_000,
    estimate: makeEstimate(),
    ...overrides,
  };
}

function readRecord(): { searchId?: string; resumeId?: string } | null {
  const raw = sessionStorage.getItem(ACTIVE_SEARCH_KEY);
  return raw === null ? null : (JSON.parse(raw) as { searchId?: string; resumeId?: string });
}

/** Estimate -> "Run search" -> "Search running", the whole happy path, so
 * each test can start from a genuinely-running run rather than from a
 * hand-written storage record where that is what it means to test. */
async function runASearch(resumeId = "resume-1") {
  estimateSearch.mockResolvedValue(makeEstimate({ resumeId }));
  startSearch.mockResolvedValue({ searchId: "search-abc", status: "pending", skippedSources: [] });
  getSearchStatus.mockResolvedValue({
    searchId: "search-abc",
    status: "pending",
    resumeId,
    scoredSoFar: 0,
  });
  const view = render(
    <SearchFlow resumeId={resumeId} sourceIds={["a"]} onSearchComplete={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
  fireEvent.click(await screen.findByRole("button", { name: "Run search" }));
  await screen.findByLabelText("Search running");
  return view;
}

describe("SearchFlow — surviving a reload (git-bug 3f05144)", () => {
  it("persists a real run's searchId the moment POST /searches returns", async () => {
    await runASearch();

    await waitFor(() => expect(readRecord()?.searchId).toBe("search-abc"));
    const record = JSON.parse(sessionStorage.getItem(ACTIVE_SEARCH_KEY)!) as {
      resumeId: string;
      startedAt: number;
      estimate: EstimateSearchResponse;
    };
    expect(record.resumeId).toBe("resume-1");
    // The estimate rides along because the running panel's cost figures and
    // its "of M" denominator cannot be rebuilt from GET /searches/:id.
    expect(record.estimate.costEstimate.jobCount).toBe(10);
    expect(typeof record.startedAt).toBe("number");
  });

  it("re-adopts the run after a reload and keeps polling it by its persisted id", async () => {
    const { unmount } = await runASearch();
    unmount();
    getSearchStatus.mockClear();

    // Nothing but sessionStorage survives — exactly what the browser leaves
    // behind after Vite's HMR client force-reloads the tab.
    getSearchStatus.mockResolvedValue({
      searchId: "search-abc",
      status: "pending",
      resumeId: "resume-1",
      scoredSoFar: 6,
    });
    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    // On screen immediately, before any network round trip: the restore is a
    // state initializer, not an effect, so there is no flash of the idle
    // "Estimate search cost" button for the user to misread as "nothing
    // happened."
    expect(screen.getByLabelText("Search running")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Estimate search cost" })).not.toBeInTheDocument();

    await waitFor(() => expect(getSearchStatus).toHaveBeenCalledWith("search-abc"));
    expect(await screen.findByText("6 of 10 scored so far.")).toBeInTheDocument();
  });

  it("finishes a restored run normally: reports completion and drops the record", async () => {
    sessionStorage.setItem(ACTIVE_SEARCH_KEY, JSON.stringify(persistedRun()));
    const onSearchComplete = vi.fn();
    getSearchStatus.mockResolvedValue({
      searchId: "search-abc",
      status: "complete",
      resumeId: "resume-1",
      scored: 4,
      permanentlyFailed: 0,
      linked: 5,
      sources: [],
      completedAt: "2026-01-01T00:00:00.000Z",
      degraded: false,
    });

    render(
      <SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={onSearchComplete} />,
    );

    expect(await screen.findByLabelText("Search finished")).toBeInTheDocument();
    await waitFor(() => expect(onSearchComplete).toHaveBeenCalled());
    expect(readRecord()).toBeNull();
  });

  it("degrades to a usable idle screen when the persisted id no longer exists (404)", async () => {
    sessionStorage.setItem(ACTIVE_SEARCH_KEY, JSON.stringify(persistedRun()));
    // What a dev-database reset, or an API restart that lost the run's row,
    // actually produces (apps/api/src/routes/searches.ts's GET handler).
    getSearchStatus.mockRejectedValue(
      Object.assign(new Error('No search with id "search-abc".'), { status: 404 }),
    );

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    expect(await screen.findByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    // Not an error panel: the user never asked THIS page load to run that
    // search, so "Could not run the search: No search with id ..." would be
    // a scary non-sequitur.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(readRecord()).toBeNull());
  });

  it("still surfaces a non-404 failure of a restored run as a real error", async () => {
    sessionStorage.setItem(ACTIVE_SEARCH_KEY, JSON.stringify(persistedRun()));
    getSearchStatus.mockRejectedValue(
      Object.assign(new Error("Could not reach the API"), { status: 0 }),
    );

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the API");
  });

  it("ignores an unparseable or wrong-shaped record instead of crashing", async () => {
    sessionStorage.setItem(ACTIVE_SEARCH_KEY, "{not json");
    const { unmount } = render(
      <SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    expect(getSearchStatus).not.toHaveBeenCalled();
    unmount();

    // Structurally valid JSON, but missing the estimate the running panel
    // renders — must be rejected just as firmly as the garbage above.
    sessionStorage.setItem(
      ACTIVE_SEARCH_KEY,
      JSON.stringify({ searchId: "search-abc", resumeId: "resume-1", startedAt: Date.now() }),
    );
    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    expect(getSearchStatus).not.toHaveBeenCalled();
  });

  it("neither restores NOR deletes a run belonging to a different resume", async () => {
    sessionStorage.setItem(ACTIVE_SEARCH_KEY, JSON.stringify(persistedRun({ resumeId: "other" })));

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);

    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeInTheDocument();
    expect(getSearchStatus).not.toHaveBeenCalled();
    // The deletion half is the one that costs money if it's wrong: that run
    // is still scoring jobs somewhere, and a mount for an unrelated resume
    // has no business throwing away the only handle on it.
    await waitFor(() => expect(readRecord()?.resumeId).toBe("other"));
  });

  it("adopts the already-running searchId when POST /searches answers 409", async () => {
    // The one window persistence cannot cover: the tab reloaded between the
    // request leaving and the response arriving, so no id was ever stored.
    // The API's per-resume in-flight guard already refuses the duplicate
    // SPEND; this is about not reporting that refusal as a dead end.
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockRejectedValue(
      Object.assign(new Error("A search is already running for this resume."), {
        status: 409,
        body: { error: "A search is already running for this resume.", searchId: "search-live" },
      }),
    );
    getSearchStatus.mockResolvedValue({
      searchId: "search-live",
      status: "pending",
      resumeId: "resume-1",
      scoredSoFar: 3,
    });

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run search" }));

    expect(await screen.findByLabelText("Search running")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(readRecord()?.searchId).toBe("search-live"));
    // Longer than RTL's 1s default on purpose: unlike the restore path,
    // which polls immediately, an adopted run joins the normal
    // POLL_INTERVAL_MS (2s) loop — the point of this assertion is that the
    // loop targets the ADOPTED id, not how fast its first tick lands.
    await waitFor(() => expect(getSearchStatus).toHaveBeenCalledWith("search-live"), {
      timeout: 4000,
    });
  });

  it("still errors on a 409 with no searchId to adopt", async () => {
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockRejectedValue(
      Object.assign(new Error("Conflict"), { status: 409, body: { error: "Conflict" } }),
    );

    render(<SearchFlow resumeId="resume-1" sourceIds={["a"]} onSearchComplete={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run search" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Conflict");
    expect(readRecord()).toBeNull();
  });
});
