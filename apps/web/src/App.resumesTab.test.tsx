// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * Ticket 303cff0 ("My Resumes" tab). Opus review flagged this as the one
 * acceptance criterion ("live count in the tab button... mirrors 'Already
 * Scored Jobs (N)'") with zero test coverage -- every other App-level test
 * file stubs `listResumes` to a static empty list, so nothing pinned the
 * count actually reading real data, updating on tab switch, or refreshing
 * after a resume is created/renamed. This file is the App.scoredJobCount
 * .test.tsx counterpart for that same pattern, applied to this tab.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();
const listResumes = vi.fn();
const updateResumeNickname = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

afterEach(() => {
  cleanup();
  // Opus review (ticket e7666de, F8): `vi.clearAllMocks()` only clears call
  // history (`mock.calls`/`mock.results`) -- it does NOT drain a
  // `mockResolvedValueOnce`/`mockReturnValueOnce` queue, which is part of a
  // mock's IMPLEMENTATION state, not its history. The rename-persistence
  // test above queues three `listResumes` resolutions in one test; any left
  // undrained (e.g. if that test fails before consuming all three) would
  // leak into whichever test runs next and could fail or pass it for the
  // wrong reason -- exactly what happened when the reviewer broke an
  // unrelated test here and this file's OWN collision test failed
  // alongside it, even though it passes cleanly in isolation.
  // `vi.resetAllMocks()` does everything `clearAllMocks()` does, plus
  // drains that queue and resets each mock to a bare `vi.fn()` -- safe
  // here because every test in this file sets up its own
  // `mockResolvedValue`/`mockResolvedValueOnce`/`mockRejectedValue` from
  // scratch before using a mock, never relying on a default left over from
  // a previous test.
  vi.resetAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const EMPTY_RESULTS = { results: [] };

describe("App 'My Resumes' tab (ticket 303cff0)", () => {
  it("shows the real resume count in the tab button once loaded, and the list on switching to it", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
        {
          id: "resume-2",
          resumeNickname: "Backend-focused resume",
          createdAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    } satisfies ListResumesResponse);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (2)" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "My Resumes (2)" }));

    expect(screen.getByRole("heading", { name: "My Resumes (2)" })).toBeInTheDocument();
    expect(screen.getByText("Resume 1")).toBeInTheDocument();
    expect(screen.getByText("Backend-focused resume")).toBeInTheDocument();
  });

  it("shows no count (not '(0)') while the resumes list hasn't loaded yet", () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockReturnValue(new Promise(() => {})); // never resolves

    render(<App />);

    expect(screen.getByRole("button", { name: "My Resumes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /My Resumes \(/ })).not.toBeInTheDocument();
  });

  // Ticket 368b6cc, Nicole (dogfooding): "when there are no resumes and no
  // already scored jobs, I don't want to see the parentheses zero." Same
  // "no count" treatment as the loading state above, but for the list
  // having genuinely finished loading with zero in it -- a real state, not
  // a timing window.
  it("shows no count (not '(0)') once the resumes list has loaded with zero in it", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /My Resumes \(/ })).not.toBeInTheDocument();
  });

  it("re-fetches the resumes list (and the count updates) after a new resume is submitted", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    getResults.mockResolvedValue({ resumeId: "resume-1", resumeNickname: "Resume 1", results: [] });
    listResumes.mockResolvedValueOnce({ resumes: [] } satisfies ListResumesResponse);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });

    render(<App />);
    // Ticket 368b6cc: loaded with zero resumes now shows NO count (not
    // "(0)") -- the dedicated test above covers this directly; this wait
    // just needs to know the initial (empty) fetch has settled before
    // triggering the second one below.
    await waitFor(() => {
      expect(listResumes).toHaveBeenCalledTimes(1);
    });

    listResumes.mockResolvedValueOnce({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (1)" })).toBeInTheDocument();
    });
    expect(listResumes).toHaveBeenCalledTimes(2);
  });
});

/**
 * Ticket e7666de: renaming a saved resume from the "My Resumes" tab.
 * `PATCH /resumes/:id` has accepted a rename since ticket 38a7598; this is
 * the first test exercising it through the UI MyResumes.tsx now offers.
 *
 * "Persists across a reload" is unmount-and-remount `<App />` with a FRESH
 * `listResumes` mock answering as the server now would -- the same
 * standard this file already holds the "new resume" case to just above
 * (`listResumes` called again, with a different resolved value, and the
 * NEW data is what renders). A real reload cannot happen inside jsdom; a
 * full unmount is the closest thing to it that exists, and it is strictly
 * stronger than asserting against the row's own optimistic post-save
 * state, which a real `F5` would wipe out and this does not rely on at
 * all -- `cleanup()` destroys every component (and its state) before the
 * remount below ever runs.
 */
describe("App 'My Resumes' tab — renaming a resume (ticket e7666de)", () => {
  it("renames a resume and the new name is still there after the tab's own refetch, not just the optimistic update", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockResolvedValueOnce({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (1)" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "My Resumes (1)" }));
    expect(screen.getByText("Resume 1")).toBeInTheDocument();

    updateResumeNickname.mockResolvedValue({ id: "resume-1", resumeNickname: "Backend Resume" });
    // The refetch App.tsx's `onRenamed -> refreshResumesList` triggers --
    // what the real server now has, post-PATCH.
    listResumes.mockResolvedValueOnce({
      resumes: [
        { id: "resume-1", resumeNickname: "Backend Resume", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "Backend Resume" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(listResumes).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("Backend Resume")).toBeInTheDocument());

    // Now the actual reload-equivalent: tear the whole app down and bring
    // up a FRESH instance, with its own fresh component state, that has
    // never seen the rename's optimistic update at all -- only a
    // `listResumes` answering as the (simulated) server now does.
    cleanup();
    listResumes.mockResolvedValueOnce({
      resumes: [
        { id: "resume-1", resumeNickname: "Backend Resume", createdAt: "2026-09-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (1)" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "My Resumes (1)" }));

    expect(screen.getByText("Backend Resume")).toBeInTheDocument();
    expect(screen.queryByText("Resume 1")).not.toBeInTheDocument();
  });

  it("shows a visible error and leaves the list showing the OLD name when the rename is rejected (collision)", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue(EMPTY_RESULTS);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-09-01T00:00:00.000Z" },
        {
          id: "resume-2",
          resumeNickname: "Resume 2",
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    } satisfies ListResumesResponse);
    updateResumeNickname.mockRejectedValue(new Error("This resume nickname is already in use."));

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "My Resumes (2)" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "My Resumes (2)" }));

    fireEvent.click(screen.getByRole("button", { name: "Rename Resume 1" }));
    fireEvent.change(screen.getByLabelText("New name for Resume 1"), {
      target: { value: "Resume 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save resume name: This resume nickname is already in use.",
    );
    // The list was never left showing the rejected name under either
    // resume -- "Resume 1" still identifies the first row (now mid-edit,
    // in its own input), and the SECOND row's "Resume 2" is still exactly
    // one row, not two.
    expect(screen.getAllByText("Resume 2")).toHaveLength(1);
    // Only one real network call -- the list was never refetched off a
    // rejected rename.
    expect(listResumes).toHaveBeenCalledTimes(1);
  });
});
