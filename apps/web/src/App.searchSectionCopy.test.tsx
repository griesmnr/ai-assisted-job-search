// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";

/**
 * The search section's heading, pitch paragraph, and estimate button --
 * pinned because this copy has now been rewritten three times and NOTHING
 * caught any of it.
 *
 * History, which is the reason this file exists: the heading was "Find new
 * matches" and the pitch opened "This isn't a keyword search." Jay (a real
 * user, relayed by Nicole) was confused by the juxtaposition of a heading
 * promising matches and a button underneath asking to estimate a cost --
 * the heading described one thing and the only available action did another.
 * Nicole rewrote all three together: the heading now names BOTH halves of
 * what this section does, the button is the plain "Get estimate", and the
 * pitch explains what the cost actually buys (a real per-job comparison
 * against the resume) rather than what the search is not.
 *
 * Exact text, not substrings. A test asserting the pitch merely CONTAINS
 * "Claude" would pass just as happily against a mangled or truncated version
 * of Nicole's dictated copy, which is the kind of test this project's review
 * bar explicitly calls out as proving nothing. The same reasoning is written
 * up at the top of App.welcomeParagraph.test.tsx and in `sentFactsLine`
 * (MagicLinkForm.tsx), both of which exist because carefully-worded copy
 * had already been quietly reworded once.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const listResumes = vi.fn();
const setJobStatus = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();

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
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const EXACT_HEADING = "Search these jobs — and see the cost first";

const EXACT_PITCH =
  "Claude actually compares your resume against each job description that matches your titles, " +
  "one at a time, and judges how well you'd really fit. That real comparison is what the cost " +
  "below pays for.";

describe("search section copy (ticket 05ff2a5 follow-up: Jay's heading/button confusion)", () => {
  /**
   * The search section only renders once a resume is active, so this mirrors
   * App.criteria.test.tsx's own `submitResume` helper: paste, Submit, then
   * wait for the source checkbox to be CHECKED rather than merely present.
   * That wait is not cosmetic -- see that helper's comment: the checkbox
   * renders one pass before App's auto-select effect populates
   * `selectedSourceIds`, and asserting too early is flaky about 1 run in 3.
   */
  async function renderApp() {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["DevOps Engineer"],
    });
    getResults.mockResolvedValue({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [],
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  }

  it("heads the section with wording that names BOTH the search and the cost, so the heading and the only available action agree", async () => {
    await renderApp();

    // Exact accessible name, not a substring: "Search these jobs" alone would
    // pass against a heading that dropped the cost half, which is the specific
    // mismatch Jay tripped over.
    expect(screen.getByRole("heading", { level: 2, name: EXACT_HEADING })).toBeVisible();
  });

  it("renders the pitch verbatim, em dash and apostrophe included", async () => {
    await renderApp();

    const pitch = document.querySelector(".search-pitch");
    expect(pitch).not.toBeNull();
    // `textContent` + toBe rather than toHaveTextContent: the latter does
    // substring matching and silently ignores an `exact` property (see the
    // warning comment in MagicLinkPrompt.test.tsx), so it cannot pin copy.
    expect(pitch!.textContent).toBe(EXACT_PITCH);
  });

  it("no longer says what the search ISN'T -- the pitch explains what the cost buys instead", async () => {
    await renderApp();

    expect(screen.queryByText(/isn't a keyword search/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: /find new matches/i })).toBeNull();
  });

  it('labels the estimate button "Get estimate", not the old "Estimate search cost"', async () => {
    await renderApp();

    expect(screen.getByRole("button", { name: "Get estimate" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /estimate search cost/i })).toBeNull();
  });
});
