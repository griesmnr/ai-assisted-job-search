// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetAllResultsResponse, GetSourcesResponse, ListResumesResponse } from "@app/shared";
import App from "./App";
import { setVerifiedEmail } from "./identity";

/**
 * Ticket 9e00bc9: the welcome paragraph below the `<h1>`, and the decision
 * (recorded in App.tsx next to `showWelcomeParagraph`) that it shows until
 * this browser/account has real evidence of use -- a saved resume, or a
 * scored result actually visible on screen -- and disappears after that,
 * rather than on a one-time "seen it" flag. This file is the only coverage
 * for that behavior; everything else in this app's test suite happens to
 * leave the paragraph on screen (empty account, nothing scored) without ever
 * asserting it is there OR pinning its exact wording.
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

  it("does not render once the account has a saved resume, even with nothing scored yet", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [{ id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00Z" }],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);

    // Let both fetches settle before asserting an absence -- otherwise a
    // false "not found" could just mean the loading state hasn't resolved.
    await waitFor(() => expect(listResumes).toHaveBeenCalled());
    await waitFor(() => expect(getAllResults).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "FitScore" })).toBeInTheDocument(),
    );

    expect(screen.queryByText(/Welcome to FitScore/)).toBeNull();
  });

  it("does not render once a scored result is actually visible, even with no saved resume", async () => {
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

    expect(screen.queryByText(/Welcome to FitScore/)).toBeNull();
  });

  it("never flashes for a verified user, even in the loading window before the resume/results fetches settle", async () => {
    // Opus review round 1 (F2): measured in real Chromium, a default of
    // "visible while loading" produces a real layout jump on every load for
    // a returning, already-verified user -- 146.3px at 1280px wide, 235.9px
    // at 390px -- because `useResumesList`/`useAllResults` both start
    // `loading` and only resolve in a post-mount effect. This proves the fix
    // directly: `listResumes`/`getAllResults` are left PENDING forever below
    // (never resolved), holding the component in exactly that loading
    // window, and the assertion runs with no `await` at all -- on the very
    // first render/commit. `verifiedEmail` is read synchronously
    // (`useState(getVerifiedEmail)`, the same pattern `SignedInCue` uses),
    // so it has to win this race regardless of what the fetches are doing.
    setVerifiedEmail("owner@example.com");
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockReturnValue(new Promise<ListResumesResponse>(() => {}));
    getAllResults.mockReturnValue(new Promise<GetAllResultsResponse>(() => {}));

    render(<App />);

    expect(screen.queryByText(/Welcome to FitScore/)).toBeNull();
  });
});
