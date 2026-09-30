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

vi.mock("./navigation", () => ({ reloadTo: vi.fn(), reloadCurrent: vi.fn() }));

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

/**
 * The floating prompt's bottom-clearance rule (index.css), restated.
 *
 * KNOWN LIMIT, STATED SO NOBODY OVER-TRUSTS THIS: because the selector is
 * restated here, these tests pin its SEMANTICS against a real DOM -- they do
 * not detect someone editing `index.css` to something else. Three ways to
 * read the live rule instead were tried and each is a scope change the
 * ticket that added this shouldn't have made: `node:fs` doesn't typecheck
 * (this file is under `apps/web/src`, which `tsconfig.app.json` compiles
 * with the browser's type set, and `@types/node` is a devDependency of
 * `apps/api`/`packages/shared` only); Vite's `?raw` returns an empty string
 * because vitest's default `css: false` stubs CSS imports; and moving the
 * test out of `src` hides it from `vitest.config.ts`'s `include`. Ticket
 * 5c93a51 tracks the stronger version.
 *
 * What these DO catch is ticket d0a7074's F3 logic error and its
 * predecessor, both of which were WRONG selectors rather than absent ones --
 * verified by substituting each historical selector here and watching them
 * fail. The `index.css` rule carries a pointer back to this test so an
 * editor of one sees the other.
 *
 * Module-scoped (ticket a5c8fa9 review) so the verified-user tests can pin
 * clearance too, off ONE definition of the string rather than a second copy.
 * This rule has silently broken twice, which is exactly why it is worth
 * asserting from more than one angle.
 */
const CLEARANCE_SELECTOR =
  ".app:has(> .magic-link-prompt-host:not([hidden]) > .magic-link-prompt) .results-section";

function clearedSections() {
  return document.querySelectorAll(CLEARANCE_SELECTOR).length;
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
/**
 * Ticket a5c8fa9, Nicole: "I'm not crazy about the pop-up that tells you that
 * these results are saved to <her address>. Why don't we just say in the top
 * right of the screen... And no pop-up after a successful magic link."
 *
 * The component-level halves live in SignedInCue.test.tsx and
 * MagicLinkPrompt.test.tsx. What only App can answer -- and what neither of
 * those files can -- is whether the cue actually appears across the whole app
 * rather than only where the old card did, and whether a verified user really
 * sees no floating card anywhere.
 */
/**
 * Ticket 5a7e957. Nicole's rule for when the "been here before?" entry point
 * belongs on screen: "on any site run where there's no data? because if there
 * is data, or they use the site normally, they'll get prompted as we
 * discussed."
 *
 * Only App can answer this -- the component itself only knows whether an
 * email is verified. The gate (nothing scored, no resume in play) lives in
 * App.tsx, and the property worth pinning is that this and the results prompt
 * are never on screen together, since they are two doors into the same
 * endpoint.
 */
describe("the way back in appears only where the results prompt cannot (ticket 5a7e957)", () => {
  it("offers it to an anonymous visitor with nothing scored and no resume", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);

    expect(await screen.findByRole("button", { name: /been here before/i })).toBeInTheDocument();
    // Never both doors at once.
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(0);
  });

  it("withdraws it once a resume is in play -- mid-onboarding is not lost", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    render(<App />);
    expect(await screen.findByRole("button", { name: /been here before/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await vi.waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  it("withdraws it when jobs exist but are all below the match-score floor -- filtered is not empty", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({
      results: [],
      hiddenBelowFloor: 12,
    } satisfies GetAllResultsResponse);

    render(<App />);
    await screen.findByRole("button", { name: /^Already Scored Jobs/ });

    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  it("never shows it alongside the results prompt, even once a search has landed", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);

    await submitResume();
    await runSearchToCompletion();

    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  /**
   * Opus review F2: the `results.length === 0` conjunct -- the one that
   * literally implements Nicole's "where there's no data" rule -- had ZERO
   * coverage. Dropping it killed no tests, because `mockHappyPath` sets
   * `getAllResults` to an empty list and every other gate test re-asserts
   * empty, so the has-scored-jobs-but-no-resume state was never rendered.
   *
   * It is a real state: a returning visitor in a fresh tab, `localStorage`
   * user id intact so their scored jobs load, `sessionStorage` gone so there
   * is no active resume. They plainly have data, so they are plainly not lost.
   */
  it("withdraws it when scored jobs exist even though no resume is active", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({
      results: [
        {
          jobId: "job-old",
          resumeId: "resume-1",
          resumeNickname: "Resume 1",
          externalId: "ext-old",
          title: "Scored Before This Tab",
          company: "Acme",
          dataSource: "usajobs",
          location: null,
          locationType: null,
          applyUrl: "https://example.com/apply",
          matchScore: 71,
          rationale: "Good fit.",
          strengths: [],
          gaps: [],
          levelFit: null,
          levelFitNote: null,
          isContractOrTemp: false,
          status: null,
        },
      ],
    } satisfies GetAllResultsResponse);

    render(<App />);
    expect(
      await screen.findByRole("button", { name: /^Already Scored Jobs \(/ }),
    ).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  /**
   * Opus review N1: `resumeId` is `sessionStorage`-scoped, so on its own it
   * cannot answer "is this person lost?" across a tab close. Resumes are
   * scoped to the `localStorage` user id, so their existence proves that id
   * survived.
   */
  it("withdraws it when the account has saved resumes, even with no active resume and nothing scored", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    listResumes.mockResolvedValue({
      resumes: [
        {
          id: "resume-1",
          resumeNickname: "Resume 1",
          createdAt: "2026-01-01T00:00:00.000Z",
          isLocked: false,
          suggestedTitles: [],
        },
      ],
    });

    render(<App />);
    await screen.findByRole("button", { name: /^My Resumes \(/ });

    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  /**
   * Opus review F1. The paste box sits directly below this panel, so "start
   * filling in my resume while I wait for the email" is the natural thing to
   * do -- and it defines `resumeId`, which closes the gate. With the panel
   * conditionally rendered, that UNMOUNTED the "Check your inbox"
   * confirmation the user was waiting on. Exactly the failure class this
   * project already fixed for the prompt (ticket d0a7074 review F2), whose
   * comment sits forty lines above this gate in App.tsx.
   */
  it("keeps the 'check your inbox' confirmation when the user starts pasting a resume while waiting", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    requestMagicLink.mockResolvedValue({
      email: "returning@example.com",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /been here before/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "returning@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a sign-in link/i }));
    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();

    // Now do the natural thing: start on the resume while waiting.
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
    await vi.waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    // The offer is correctly withdrawn from view, but the record of the link
    // that was already sent must not be destroyed with it.
    expect(screen.getByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledTimes(1);
  });

  it("shows the signed-in cue instead once an email is verified", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    render(<App />);

    expect(await screen.findByText(/these results are saved to/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });
});

describe("a verified user gets a quiet header cue, not a floating card (ticket a5c8fa9)", () => {
  const SCORED_FOR_CUE: GetAllResultsResponse = {
    results: [
      {
        jobId: "job-cue",
        resumeId: "resume-1",
        resumeNickname: "Resume 1",
        externalId: "ext-cue",
        title: "Scored While Signed In",
        company: "Acme",
        dataSource: "usajobs",
        location: null,
        locationType: null,
        applyUrl: "https://example.com/apply",
        matchScore: 74,
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

  it("shows the cue on all three tabs, and renders no floating prompt anywhere", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED_FOR_CUE);
    localStorage.setItem("jobsearch.web.userEmail.v1", "signed-in@example.com");

    render(<App />);

    // New Job Search (the default tab).
    expect(screen.getByText(/these results are saved to/i)).toBeInTheDocument();
    expect(screen.getByText("signed-in@example.com")).toBeInTheDocument();

    // Already Scored Jobs -- the tab whose results would previously have
    // summoned the floating signed-in card via d0a7074's scored arm.
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    expect(await screen.findByText("Scored While Signed In")).toBeInTheDocument();
    expect(screen.getByText(/these results are saved to/i)).toBeInTheDocument();
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(0);
    expect(document.querySelectorAll(".magic-link-prompt-floating")).toHaveLength(0);
    // Acceptance criterion: with nothing floating, nothing is padded for it.
    // Asserted directly rather than inferred from the count above, since this
    // selector has silently broken twice (ticket d0a7074 F3 and its
    // predecessor).
    expect(clearedSections()).toBe(0);

    // My Resumes -- the cue is persistent app chrome, not tied to results.
    fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
    expect(screen.getByText(/these results are saved to/i)).toBeInTheDocument();

    // And exactly one of it, despite three tab panels being mounted at once
    // (ticket f4a7f07) -- it lives in the header, above all of them.
    expect(document.querySelectorAll(".signed-in-cue")).toHaveLength(1);
  });

  it("shows no cue for an anonymous visitor, and still offers the ask", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED_FOR_CUE);
    // No verified email in storage.

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^Already Scored Jobs/ }));
    expect(await screen.findByText("Scored While Signed In")).toBeInTheDocument();

    expect(screen.queryByText(/these results are saved to/i)).not.toBeInTheDocument();
    // The ask is untouched by this ticket -- it must still appear exactly as
    // ticket d0a7074 left it.
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
  });
});

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

  /**
   * Opus review, F1 (BLOCKING). The hoisted gate was transcribed from the
   * old mount's INLINE `results.length > 0` check and dropped the two
   * ancestor wrappers it used to live inside: `{resumeId && ...}` and
   * `hidden={resumeEditing || resumeChanging}` (App.tsx). The card is
   * `position: fixed`, and the clearance rule only pads
   * `.results-section` -- never `.resume-section` -- so with those
   * conditions gone it floated over the resume picker, occluding its
   * bottom rows (and, under the narrow-viewport rule where it goes
   * full-width, the "Use this resume" button itself) with no way to scroll
   * out from under it. Exactly the occlusion class the clearance rule
   * exists to prevent, reintroduced where the clearance cannot reach.
   */
  it("disappears while the resume picker is open, and comes back on cancel (review F1)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();

    // A completed search locks the resume, so the collapsed bar's button is
    // "Change resume" (the picker) rather than "Edit resume".
    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("stays hidden on the search tab while the picker is open, even though Already Scored Jobs would qualify (review F1)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));

    // The scored arm IS ready here, which is what makes this worth its own
    // test: the instance stays mounted (that's F2's fix) and must still be
    // invisible, so `hidden` has to be driven by the ACTIVE tab's arm, not
    // by "either arm is ready".
    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(1);

    openScoredTab();
    expect(await screen.findByText("Previously Scored Engineer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
  });

  /**
   * Opus review, F2 (BLOCKING). The first version rendered the prompt as a
   * bare `{showMagicLinkPrompt && <MagicLinkPrompt />}`, which UNMOUNTS it
   * on any tab switch that fails the gate -- destroying the
   * `dismissed`/`email`/`phase` it holds locally. The old inline mount was
   * immune because it lived inside a `hidden` div. These three tests cover
   * the three states that died, all via a round trip through "My Resumes"
   * (neither arm's tab, so the naive gate goes false).
   */
  function roundTripThroughMyResumes() {
    fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
    fireEvent.click(screen.getByRole("button", { name: /^New Job Search/ }));
  }

  it("keeps a dismissal through a round trip via My Resumes (review F2)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    roundTripThroughMyResumes();

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a half-typed address through a round trip via My Resumes (review F2)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "alice@exam" },
    });

    roundTripThroughMyResumes();

    expect(screen.getByLabelText(/email address/i)).toHaveValue("alice@exam");
  });

  it("keeps the 'check your inbox' confirmation through a round trip via My Resumes, and does not re-arm a second send (review F2)", async () => {
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

    roundTripThroughMyResumes();

    // The worst of the three losses: the app had just said "we sent a link
    // to alice@example.com", and after this trip it showed no record of
    // having sent anything AND offered the send button again, so a
    // reasonable user double-sends.
    expect(screen.getByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email me a link/i })).not.toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledTimes(1);
  });

  it("keeps a dismissal when the scored tab is visited while its own results are still loading (review F2)", async () => {
    mockHappyPath(ONE_RESULT);
    // A promise that never settles: `useAllResults` genuinely sits in
    // `loading` (and can also land in `error`), so `scoredArmReady` is
    // false for that whole window. Switching through it must not destroy
    // the search tab's dismissal.
    getAllResults.mockReturnValue(new Promise(() => {}));

    await submitResume();
    await runSearchToCompletion();
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    openScoredTab();
    expect(await screen.findByText("Loading results...")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^New Job Search/ }));

    expect(
      screen.queryByRole("heading", { name: /find these results again/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * Opus review, F3 (BLOCKING, and a regression introduced by the F2 fix
   * itself). The clearance rule in index.css keeps the last result card
   * from being permanently occluded by the floating prompt. It has now
   * silently broken TWICE -- once because the hoist made its original
   * `.results-section:has(...)` selector unmatchable, and once because
   * keying it on a merely-present, non-hidden HOST kept it matching after
   * `MagicLinkPrompt` returns `null` on dismissal, leaving 8rem of dead
   * space under the results section forever.
   *
   * So this asserts the selector directly, across the whole matrix, rather
   * than just the happy path. jsdom's selector engine (nwsapi) evaluates
   * `:has()`, `>` inside `:has()`, and `:not([attr])` correctly, so the
   * real production selector string can be queried as-is -- the one piece
   * of this feature no rendering assertion can reach, since jsdom computes
   * no layout.
   */
  it("applies bottom clearance only while a card is really on screen (review F3)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();

    // Visible card -> clearance on. Both results sections match; the
    // hidden tab's padding costs nothing (display:none lays out nothing),
    // and that breadth is deliberate -- see the CSS comment.
    expect(clearedSections()).toBe(2);

    // Dismissed -> the host survives UN-hidden but renders no card, which
    // is exactly the case the first version of this selector got wrong.
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(0);
    expect(document.querySelectorAll(".magic-link-prompt-host")).toHaveLength(1);
    expect(clearedSections()).toBe(0);
  });

  it("drops bottom clearance while the host is mounted but hidden (review F3)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(clearedSections()).toBe(2);

    // Picker open: host stays mounted (F2's state preservation) but hidden,
    // so no card is on screen and nothing should be padded for one.
    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    expect(clearedSections()).toBe(0);

    // And back on cancel, proving the rule tracks visibility rather than
    // latching off permanently.
    fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
    expect(clearedSections()).toBe(0);
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
