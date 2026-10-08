// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetAllResultsResponse, GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";
import { setVerifiedEmail } from "./identity";

/**
 * Ticket 9e00bc9 built the welcome paragraph below the `<h1>` and gated it to
 * disappear once this browser/account had real evidence of use -- a saved
 * resume, or a scored result actually visible on screen. Ticket 0a378a5
 * removed that gate at Nicole's explicit instruction ("make that paragraph
 * always visible") and this file's three absence tests below are inverted
 * to match: the paragraph now renders unconditionally, in every state. This
 * file remains the only coverage for that behavior; everything else in this
 * app's test suite happens to leave the paragraph on screen (empty account,
 * nothing scored) without ever asserting it is there OR pinning its exact
 * wording.
 *
 * The exact text matters here, not a substring: a test asserting the
 * paragraph merely CONTAINS "FitScore" would pass just as happily against
 * a mangled or truncated version of Nicole's dictated copy, which is exactly
 * the kind of test this ticket's own review bar calls out as proving nothing.
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

const EXACT_WELCOME_TEXT =
  "Welcome to FitScore! Find jobs that fit your experience—not just your search terms. " +
  "We take the pain out of job hunting by searching open roles for you and comparing them " +
  "directly with your resume. Each job gets a match score from 1–100, so you can quickly " +
  "spot the opportunities that best align with your skills and experience. Spend less time " +
  "searching and more time applying!";

describe("App welcome paragraph (ticket 9e00bc9)", () => {
  it("renders the exact copy, with an em dash and an en dash, for a brand-new browser/account", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);

    const paragraph = await screen.findByText(/Welcome to FitScore/);
    expect(paragraph.textContent).toBe(EXACT_WELCOME_TEXT);
  });

  it("sits directly above the tab nav -- h1, then paragraph, then nav", async () => {
    // Opus review round 1: none of the three tests above pin WHERE the
    // paragraph lands. Moving it below `.tab-nav` (which would satisfy none
    // of the "first thing a first-time visitor reads" reasoning this
    // component's own comment argues for) would leave every one of them
    // green, because they only check whether the text exists on the page at
    // all. This asserts position directly: the paragraph is `.tab-nav`'s
    // immediately preceding sibling.
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);

    const paragraph = await screen.findByText(/Welcome to FitScore/);
    const nav = document.querySelector(".tab-nav");
    expect(nav).not.toBeNull();
    expect(nav!.previousElementSibling).toBe(paragraph);
  });

  it("still renders once the account has a saved resume, even with nothing scored yet", async () => {
    // Ticket 0a378a5: this used to assert absence -- the gate it was pinning
    // (`showWelcomeParagraph`) is gone at Nicole's explicit instruction, so a
    // saved resume must no longer hide the paragraph.
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [{ id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00Z" }],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);

    // Let both fetches settle before asserting presence survives past the
    // loading window too, not only during it.
    await waitFor(() => expect(listResumes).toHaveBeenCalled());
    await waitFor(() => expect(getAllResults).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "FitScore" })).toBeInTheDocument(),
    );

    expect(screen.queryByText(/Welcome to FitScore/)).not.toBeNull();
  });

  it("still renders once a scored result is actually visible, even with no saved resume", async () => {
    // Ticket 0a378a5: this used to assert absence -- same inversion as the
    // saved-resume case above, this time against the `scoredArmReady`-shaped
    // condition the old gate also keyed off.
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({ resumes: [] } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({
      results: [
        {
          resumeId: "resume-1",
          jobId: "job-1",
          externalId: "job-1",
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
          resumeNickname: "Resume 1",
        },
      ],
    } satisfies GetAllResultsResponse);

    render(<App />);

    await waitFor(() => expect(listResumes).toHaveBeenCalled());
    await waitFor(() => expect(getAllResults).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "FitScore" })).toBeInTheDocument(),
    );

    expect(screen.queryByText(/Welcome to FitScore/)).not.toBeNull();
  });

  it("is visible for a verified user in the loading window before the resume/results fetches settle", async () => {
    // Ticket 9e00bc9 built this test to pin the ABSENCE of a flash: a verified
    // user's `showWelcomeParagraph` gate read `verifiedEmail` synchronously
    // so the paragraph was never shown even for one frame during the loading
    // window, avoiding a measured layout jump (146.3px at 1280px wide,
    // 235.9px at 390px -- see the history comment next to
    // `signInRecoveryEverShownRef` in App.tsx) that an unconditionally-visible
    // default would have caused while that gate still existed.
    //
    // Ticket 0a378a5 removed the gate at Nicole's explicit instruction. The
    // original subject of this test -- a flash that needed preventing -- can
    // no longer occur, because there is no hidden state left to flash FROM:
    // the paragraph is unconditional. So this test now pins the new
    // requirement instead: a verified user sees the paragraph from the very
    // first render (no `await` below, same as the original -- the assertion
    // still runs with `listResumes`/`getAllResults` left permanently PENDING,
    // inside the exact loading window the old gate used to hide it in).
    // Visibility surviving PAST this window, once those fetches settle, is
    // what the two inverted tests above already cover -- this one is
    // deliberately scoped to the loading window alone, matching its title.
    setVerifiedEmail("owner@example.com");
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockReturnValue(new Promise<ListResumesResponse>(() => {}));
    getAllResults.mockReturnValue(new Promise<GetAllResultsResponse>(() => {}));

    render(<App />);

    expect(screen.queryByText(/Welcome to FitScore/)).not.toBeNull();
  });
});
