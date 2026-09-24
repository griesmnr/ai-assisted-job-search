// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  GetAllResultsResponse,
  GetSourcesResponse,
  ListResumesResponse,
  ScoredJobResult,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 1e183a4, Nicole: "the resume 13 should now become a link to the
 * My Resumes page with that resume highlighted and the text already
 * expanded. Super excited about that little connection." End-to-end
 * through the real App: click a result card's "Searched with:" link,
 * land on My Resumes with the right row expanded and scrolled to.
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
const getResume = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResume: (...args: unknown[]) => getResume(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

// jsdom does not implement `scrollIntoView` -- see MyResumes.test.tsx's
// identical stub for the same reason.
let scrollIntoViewMock: Mock<typeof Element.prototype.scrollIntoView>;
beforeEach(() => {
  scrollIntoViewMock = vi.fn<typeof Element.prototype.scrollIntoView>();
  Element.prototype.scrollIntoView = scrollIntoViewMock;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

function makeJob(overrides: Partial<ScoredJobResult> = {}): ScoredJobResult {
  return {
    jobId: "job-1",
    resumeId: "resume-13",
    externalId: "job-1",
    title: "Backend Engineer",
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
    resumeNickname: "Resume 13",
    ...overrides,
  };
}

describe("App — 'Searched with' resume link (ticket 1e183a4)", () => {
  it("clicking the resume link on an Already Scored Jobs card jumps to My Resumes, expanded and scrolled to", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue({
      results: [makeJob()],
    } satisfies GetAllResultsResponse);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-13", resumeNickname: "Resume 13", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-08-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getResume.mockResolvedValue({
      id: "resume-13",
      resumeText: "Resume 13's full text.",
      resumeNickname: "Resume 13",
    });

    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume 13" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Resume 13" }));

    // Switched tabs: the My Resumes heading is now the visible one.
    expect(screen.getByRole("heading", { name: /^My Resumes/ })).toBeVisible();

    // The right row expanded and fetched its text.
    await waitFor(() => {
      expect(screen.getByText("Resume 13's full text.")).toBeInTheDocument();
    });
    expect(getResume).toHaveBeenCalledWith("resume-13");

    // Scrolled to.
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  });

  it("clicking a second card's resume link re-scrolls even while already on My Resumes", async () => {
    getSources.mockResolvedValue(SOURCES);
    getAllResults.mockResolvedValue({
      results: [
        makeJob({ jobId: "job-1", resumeId: "resume-13", resumeNickname: "Resume 13" }),
        makeJob({ jobId: "job-2", resumeId: "resume-1", resumeNickname: "Resume 1" }),
      ],
    } satisfies GetAllResultsResponse);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-13", resumeNickname: "Resume 13", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-08-01T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getResume.mockImplementation((id: string) =>
      Promise.resolve({ id, resumeText: `${id} full text.`, resumeNickname: id }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Resume 13" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Resume 13" }));
    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledTimes(1));

    // Back to Already Scored Jobs (still mounted underneath, per the
    // `hidden`-not-unmounted tab pattern), click the OTHER card's resume
    // link -- My Resumes stays mounted too, so this must still register
    // as a fresh jump even though that tab is already the active one.
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    fireEvent.click(screen.getByRole("button", { name: "Resume 1" }));

    await waitFor(() => expect(scrollIntoViewMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByText("resume-1 full text.")).toBeInTheDocument();
    });
  });
});
