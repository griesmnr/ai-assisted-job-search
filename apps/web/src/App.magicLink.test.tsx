// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetAllResultsResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 9f06f8f (epic 2b9e9dd child 4): the two things about magic-link
 * sign-in that only App can be responsible for, and that neither component's
 * own test file can check.
 *
 *  1. WHEN the prompt is offered. "Right after scored results land, never
 *     before" is the ticket's whole premise, and it is a property of where
 *     App mounts `MagicLinkPrompt`, not of the component. Driven here through
 *     the real flow -- paste a resume, estimate, run, let the poll report
 *     complete -- because every cheaper way of checking it (asserting on a
 *     prop, rendering the component directly) would pass even if the prompt
 *     were mounted at the top of the page.
 *
 *  2. THE FULL-PAGE TAKEOVER when the URL carries a token, and specifically
 *     that `JobSearchApp` is NOT mounted during it -- if it were, its data
 *     hooks would fetch under the very identity the browser is replacing.
 *     Asserted by the absence of any API call, which is the only observable
 *     that distinguishes "not rendered" from "rendered but hidden".
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const listResumes = vi.fn();
const requestMagicLink = vi.fn();
const verifyMagicLink = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: () => Promise.resolve({}),
  clearJobStatus: () => Promise.resolve(),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
  requestMagicLink: (...args: unknown[]) => requestMagicLink(...args),
  verifyMagicLink: (...args: unknown[]) => verifyMagicLink(...args),
  magicLinkRejectionReason: () => undefined,
  updateResumeNickname: () => Promise.reject(new Error("not used in this test")),
  createHandoff: () => Promise.reject(new Error("not used in this test")),
  handoffFetchUrl: (id: string) => `http://localhost:3000/handoffs/${id}`,
  RESUME_OPTIMIZER_APP_URL: "https://example.invalid/",
}));

vi.mock("./navigation", () => ({ reloadTo: vi.fn() }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

const ONE_RESULT: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [
    {
      jobId: "job-1",
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      externalId: "ext-1",
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
      levelFit: null,
      levelFitNote: null,
      isContractOrTemp: false,
      status: null,
    },
  ],
};

const NO_RESULTS: GetResumeResultsResponse = {
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

function mockHappyPath(results: GetResumeResultsResponse) {
  getSources.mockResolvedValue(SOURCES);
  createResume.mockResolvedValue({
    id: "resume-1",
    resumeNickname: "Resume 1",
    suggestedTitles: [],
    isLocked: false,
  });
  getResults.mockResolvedValue(results);
  getAllResults.mockResolvedValue({ results: [] });
  listResumes.mockResolvedValue({ resumes: [] });
  estimateSearch.mockResolvedValue(makeEstimate());
  startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
  getSearchStatus.mockResolvedValue({
    status: "complete",
    scored: 1,
    permanentlyFailed: 0,
    cappedForBudget: 0,
    linked: 1,
    sources: [],
    completedAt: "2026-01-01T00:00:00.000Z",
    degraded: false,
  });
}

/** Paste a resume and get as far as an enabled "Estimate search cost". Mirrors
 * `submitResume` in App.tabs.test.tsx (including the ticket b9e6251 "Any
 * location" opt-in every test in that file also needs). */
async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  await vi.waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  fireEvent.click(screen.getByLabelText(/Any location/));
}

async function runSearchToCompletion() {
  fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
  await screen.findByRole("button", { name: "Run search" });
  fireEvent.click(screen.getByRole("button", { name: "Run search" }));
  await act(async () => {
    await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
  });
  await screen.findByRole("heading", { name: "Results from this search" });
}

describe("the sign-in prompt is offered only after scored results land (ticket 9f06f8f)", () => {
  it("is absent before a resume, before an estimate, and while a search is still running", async () => {
    mockHappyPath(ONE_RESULT);

    render(<App />);
    // Before a resume exists at all.
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
    cleanup();

    await submitResume();
    // A resume is in hand, sources are selected -- still nothing has been
    // searched, so there is no value to ask on the back of yet.
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    // An estimate is not results. This is the boundary the ticket's "never
    // before" is actually about -- the user has been shown a price, not an
    // answer.
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("appears once a real search completes with results", async () => {
    mockHappyPath(ONE_RESULT);

    await submitResume();
    await runSearchToCompletion();

    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });

  it("stays absent when the completed search matched nothing -- there are no results to come back for", async () => {
    mockHappyPath(NO_RESULTS);

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });
    fireEvent.click(screen.getByRole("button", { name: "Run search" }));
    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });
    await screen.findByText("No jobs matched this search.");

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("sends the link from that position, through the real client call", async () => {
    mockHappyPath(ONE_RESULT);
    requestMagicLink.mockResolvedValue({
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    await submitResume();
    await runSearchToCompletion();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));

    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledWith("alice@example.com");
  });
});

/**
 * Ticket d0a7074, Nicole (dogfooding): "is there a magic link opportunity on
 * the already scored jobs page too?" -- then, once told it wasn't: "that's
 * what I was hoping to see."
 *
 * The prompt moved from a mount physically inside the search tab's results
 * section to ONE hoisted instance at `main.app` level, gated by App's
 * `showMagicLinkPrompt`. These tests cover what that hoist has to get right
 * and what the old single-mount tests above could never have caught: the new
 * tab, the new gate's negative cases, and -- the reason it is one instance
 * rather than two mounts -- that state does not fork between the tabs.
 */
describe("the sign-in prompt is offered on Already Scored Jobs too (ticket d0a7074)", () => {
  const SCORED: GetAllResultsResponse = {
    results: [
      {
        jobId: "job-9",
        resumeId: "resume-1",
        resumeNickname: "Resume 1",
        externalId: "ext-9",
        title: "Previously Scored Engineer",
        company: "Acme",
        dataSource: "usajobs",
        location: null,
        locationType: null,
        applyUrl: "https://example.com/apply",
        matchScore: 77,
        rationale: "Good fit.",
        strengths: [],
        gaps: [],
        levelFit: null,
        levelFitNote: null,
        isContractOrTemp: false,
        status: null,
      },
    ],
  };

  function openScoredTab() {
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
  }

  it("appears on Already Scored Jobs when that tab has scored results, with no search run this session", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    render(<App />);
    // Deliberately no resume, no estimate, no search -- "Already Scored
    // Jobs" is the cross-session history tab (ticket 3f0883f), so results
    // being on screen here is exactly the "value already delivered"
    // condition ticket 9f06f8f's placement rule is about, even though
    // nothing was searched in THIS session.
    openScoredTab();

    expect(await screen.findByText("Previously Scored Engineer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
  });

  it("stays absent on Already Scored Jobs when nothing has ever been scored", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);
    openScoredTab();

    expect(await screen.findByText("No jobs scored yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("stays absent on Already Scored Jobs when every scored job is hidden below the match-score floor", async () => {
    mockHappyPath(ONE_RESULT);
    // The gate deliberately requires a VISIBLE result, not merely a job
    // that exists: `hiddenBelowFloor` jobs are ones the user cannot see, so
    // "find these results again later" would point at nothing on screen.
    // This is the same rule the search tab has always had, and it is the
    // case most likely to be got wrong by keying the gate on
    // `scoredJobCount` (which counts below-floor jobs) instead.
    getAllResults.mockResolvedValue({
      results: [],
      hiddenBelowFloor: 12,
    } satisfies GetAllResultsResponse);

    render(<App />);
    openScoredTab();

    expect(
      await screen.findByText(/12 more jobs scored below the match-quality floor/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("never renders on My Resumes, even while both results tabs would qualify", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("is exactly ONE element, never one per tab, even when both results tabs qualify at once", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();

    // Both tabs qualify here (a completed search WITH results, and scored
    // history WITH results) and all three tab panels stay mounted at once
    // (ticket f4a7f07) -- so a per-tab mount would put two of these in the
    // DOM simultaneously. Counting nodes is the only way to see that; every
    // `getByRole` assertion above would pass either way on the visible tab,
    // and would THROW on the duplicate, which is a confusing way to learn
    // about it.
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(1);

    openScoredTab();
    expect(await screen.findByText("Previously Scored Engineer")).toBeInTheDocument();
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(1);
  });

  it("stays dismissed across a tab switch -- 'Not now' means not now, not 'not on this tab'", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();

    // THE reason this is one hoisted instance rather than one mount per tab:
    // `dismissed` lives in the component's own state, so two mounts would be
    // two independent dismissals and this prompt would be right back.
    openScoredTab();
    expect(await screen.findByText("Previously Scored Engineer")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("carries a submitted address across a tab switch, rather than asking again on the other tab", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);
    requestMagicLink.mockResolvedValue({
      email: "alice@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    await submitResume();
    await runSearchToCompletion();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /email me a link/i }));
    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();

    // Same single-instance reasoning as the dismissal test: with two mounts
    // the other tab would show a blank form, which reads as "did that
    // actually send?" right after being told to check the inbox.
    openScoredTab();
    expect(await screen.findByText("Previously Scored Engineer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledTimes(1);
  });
});

describe("the emailed link's landing view takes over the whole page (ticket 9f06f8f)", () => {
  it("renders the sign-in view and NOTHING of the normal app while a token is being redeemed", async () => {
    mockHappyPath(ONE_RESULT);
    verifyMagicLink.mockResolvedValue({
      userId: "99999999-9999-4999-8999-999999999999",
      email: "alice@example.com",
      outcome: "adopted",
    });
    window.history.replaceState(null, "", "/#magicLinkToken=tok_xyz");

    render(<App />);

    expect(await screen.findByRole("heading", { name: /you're signed in/i })).toBeInTheDocument();
    // None of the ordinary UI.
    expect(screen.queryByRole("button", { name: "New Job Search" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Paste your resume")).not.toBeInTheDocument();

    // THE ASSERTION THAT MATTERS, and the only one that can tell "not
    // mounted" apart from "mounted but hidden": JobSearchApp's data hooks
    // fetch unconditionally on mount, so zero calls proves it never mounted
    // -- and therefore that nothing was fetched under the identity this flow
    // is in the middle of replacing.
    expect(getSources).not.toHaveBeenCalled();
    expect(listResumes).not.toHaveBeenCalled();
    expect(getAllResults).not.toHaveBeenCalled();
  });

  it("renders the normal app, untouched, on every ordinary page load", async () => {
    mockHappyPath(ONE_RESULT);

    render(<App />);

    expect(await screen.findByRole("button", { name: "New Job Search" })).toBeInTheDocument();
    expect(verifyMagicLink).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getSources).toHaveBeenCalled());
  });
});

describe("lands on Already Scored Jobs after a successful magic-link verification (ticket bb2f275)", () => {
  it("defaults to Already Scored Jobs when the URL carries the landing marker, and consumes it", async () => {
    mockHappyPath(ONE_RESULT);
    // The state a real page load is in right after MagicLinkLanding's
    // "Continue to your results" reload -- the token is already gone (that
    // happened before the reload), only the landing marker remains.
    window.history.replaceState(null, "", "/#landOnScoredTab=1");

    render(<App />);

    await screen.findByRole("button", { name: "New Job Search" });
    expect(screen.getByRole("button", { name: "New Job Search" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Consumed exactly once: a LATER, unrelated reload must not keep
    // forcing this tab forever.
    expect(window.location.hash).toBe("");
  });

  // Opus review, required fix: App.tsx's own comment on the marker-consuming
  // effect argues at length that a PLAIN effect (not the `activeTab` state
  // initializer) is the StrictMode-safe place to consume this marker --
  // `main.tsx` really does wrap the app in `StrictMode`, which mounts,
  // unmounts and re-mounts every component once in dev specifically to
  // surface exactly this class of bug (see MagicLinkLanding.test.tsx's own
  // "redeems the token EXACTLY ONCE under StrictMode's double mount", the
  // precedent this test follows for the analogous hazard there). Without
  // this test, that 13-line argument had zero coverage.
  it("lands on Already Scored Jobs correctly under StrictMode's double-invoked mount", async () => {
    mockHappyPath(ONE_RESULT);
    window.history.replaceState(null, "", "/#landOnScoredTab=1");

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    await screen.findByRole("button", { name: "New Job Search" });
    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The marker must not survive StrictMode's extra mount/cleanup cycle
    // half-consumed or duplicated -- exactly gone, same as under a single
    // real mount.
    expect(window.location.hash).toBe("");
  });

  it("defaults to New Job Search as usual when the URL carries no marker", async () => {
    mockHappyPath(ONE_RESULT);

    render(<App />);

    await screen.findByRole("button", { name: "New Job Search" });
    expect(screen.getByRole("button", { name: "New Job Search" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Already Scored Jobs/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
