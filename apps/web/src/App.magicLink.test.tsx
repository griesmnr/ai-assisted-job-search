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

/** Paste a resume and get as far as an enabled "Get estimate". Mirrors
 * `submitResume` in App.tabs.test.tsx (including the ticket b9e6251 "Any
 * location" opt-in every test in that file also needs). */
async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  await vi.waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
  fireEvent.click(screen.getByLabelText(/Any location/));
}

async function runSearchToCompletion() {
  fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
  await screen.findByRole("button", { name: "Run search" });
  fireEvent.click(screen.getByRole("button", { name: "Run search" }));
  await act(async () => {
    await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
  });
  await screen.findByRole("heading", { name: "Results from this search" });
}

/**
 * Ticket 931df8a's replacement for the old floating prompt's bottom-
 * clearance rule (ticket d0a7074), restated the same way that rule was.
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
 * The old rule decided whether to PAD `.results-section`; this one decides
 * whether to COLLAPSE `.magic-link-prompt-anchor` (the portal target just
 * after the topmost result -- see App.tsx's `magicLinkAnchor` and
 * `ResultsList.tsx`'s `onFirstResultAnchorChange`), but the underlying
 * question -- and the two-part reasoning behind it -- is identical:
 * `:not([hidden])` because the host survives MOUNTED-but-`hidden` across
 * tab switches (ticket d0a7074 review F2), so merely EXISTING is not
 * enough; `> .magic-link-prompt` because `MagicLinkPrompt` returns `null`
 * once dismissed or verified while its host div survives un-hidden, so a
 * merely-unhidden host is not enough either (ticket d0a7074 review F3,
 * which broke this exact conjunction's predecessor once already). The
 * `index.css` rule carries a pointer back to this test so an editor of one
 * sees the other.
 *
 * Module-scoped (ticket a5c8fa9 review, carried forward) so the
 * verified-user tests can pin this too, off ONE definition of the string
 * rather than a second copy.
 */
const ANCHOR_VISIBLE_SELECTOR =
  ".magic-link-prompt-anchor:has(> .magic-link-prompt-host:not([hidden]) > .magic-link-prompt)";

function visibleAnchorCount() {
  return document.querySelectorAll(ANCHOR_VISIBLE_SELECTOR).length;
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await vi.waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("button", { name: /been here before/i })).not.toBeInTheDocument();
  });

  /**
   * Opus review round 4 (FIX 2): the two `status === "error"` arms added for
   * S2 had NO coverage -- reverting both to the pre-fix `status === "ready"`
   * form passed all 357 web tests. That is the same defect class as round 1's
   * F2, and it shipped in the very commit where the same gap was caught and
   * closed for the S1 fix.
   *
   * Asserted once per arm, deliberately: a single both-fetches-failed test
   * would still pass with either arm reverted on its own.
   */
  it("still offers it when the scored-results fetch fails -- an error is not evidence of data", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockRejectedValue(new Error("results unavailable"));

    render(<App />);

    expect(await screen.findByRole("button", { name: /been here before/i })).toBeInTheDocument();
  });

  it("still offers it when the resume-list fetch fails", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    listResumes.mockRejectedValue(new Error("resumes unavailable"));

    render(<App />);

    expect(await screen.findByRole("button", { name: /been here before/i })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await vi.waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    // The offer is correctly withdrawn from view, but the record of the link
    // that was already sent must not be destroyed with it.
    expect(screen.getByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(requestMagicLink).toHaveBeenCalledTimes(1);
  });

  /**
   * Opus review round 3 (B3) -- the hole in the F1 fix itself. F1 kept the
   * receipt alive once it EXISTED, but latched on success, leaving a window the
   * width of the request. If the gate closed while the send was still in
   * flight, the panel returned null, the form unmounted and `phase: "sending"`
   * died with it; the response then re-mounted a FRESH form. Captured before
   * the fix: the email had been sent, the field was empty, the offer form was
   * back, and no confirmation was anywhere -- so the natural read is "my click
   * didn't work" and the user sends a second link. Exactly the failure B2 was
   * blocked on.
   *
   * The fix latches at submit instead. This test pins the in-flight ordering
   * specifically: resume lands BEFORE the magic-link response resolves.
   */
  it("keeps the receipt when the gate closes while the send is still in flight", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    let release: (value: { email: string; expiresAt: string }) => void = () => {};
    requestMagicLink.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /been here before/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: "returning@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send me a sign-in link/i }));
    expect(await screen.findByRole("button", { name: /sending/i })).toBeInTheDocument();

    // Gate closes MID-FLIGHT -- the request has not come back yet.
    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "some resume text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await vi.waitFor(() => expect(getResults).toHaveBeenCalledTimes(1));

    release({ email: "returning@example.com", expiresAt: new Date().toISOString() });

    // The receipt must arrive and stay -- not a fresh empty offer.
    expect(await screen.findByRole("heading", { name: /check your inbox/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
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

  it("shows the cue on all three tabs, and renders no sign-in prompt anywhere", async () => {
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
    // Acceptance criterion (ticket 931df8a): with no card anywhere, no
    // anchor is expanded for one either. Asserted directly rather than
    // inferred from the count above, since this selector has silently
    // broken twice in its previous life as the clearance rule (ticket
    // d0a7074 F3 and its predecessor).
    expect(visibleAnchorCount()).toBe(0);

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
   * Opus review, F1 (BLOCKING), ticket d0a7074. The hoisted gate was
   * transcribed from the old mount's INLINE `results.length > 0` check and
   * dropped the two ancestor wrappers it used to live inside: `{resumeId &&
   * ...}` and `hidden={resumeEditing || resumeChanging}` (App.tsx). At the
   * time, the card was `position: fixed`, and the clearance rule only
   * padded `.results-section` -- never `.resume-section` -- so with those
   * conditions gone it floated over the resume picker, occluding its
   * bottom rows (and, under the narrow-viewport rule where it went
   * full-width, the paste form's own submit button) with no way to scroll
   * out from under it. Deliberately described by role rather than by label:
   * that button read "Use this resume" when this comment was written and
   * reads "Submit" since ticket 342a0da, and this narration should not need
   * editing again the next time the copy changes.
   *
   * Ticket 931df8a removed `position: fixed` and the clearance rule
   * outright, so THAT specific failure mode is no longer physically
   * possible: the card now lives in flow, inside the results list itself,
   * which is a different region of the DOM from the resume picker's own
   * section -- it cannot overlap something it is not a sibling of. This
   * test still earns its place for an orthogonal reason: `searchArmReady`
   * (the gate itself, untouched by 931df8a -- see that ticket's own note on
   * App.tsx) still requires `!resumeEditing && !resumeChanging`, and the
   * picker reopening is still the natural way to get there. Keeping this
   * test pins that the trigger's own "don't ask while results might be
   * about to change" rule survived the placement rewrite intact, even
   * though the specific occlusion bug that motivated adding it originally
   * can no longer occur.
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
   * Ticket 931df8a's analog of the old "review F3" coverage (ticket
   * d0a7074) for the NEW mechanism: the anchor-collapse rule in index.css
   * keeps an invisible or dismissed card from leaving a permanent ~1rem
   * gap between the first and second result (see that rule's own
   * comment). This asserts the selector directly, across the whole
   * matrix, rather than just the happy path -- jsdom's selector engine
   * (nwsapi) evaluates `:has()`, `>` inside `:has()`, and `:not([attr])`
   * correctly, so the real production selector string can be queried
   * as-is, the one piece of this feature no rendering assertion reaches
   * on its own.
   *
   * Exactly ONE anchor expands, not both results sections' worth the way
   * the old clearance rule padded both (that rule targeted `.results-
   * section` broadly on purpose, "costs nothing" for the hidden tab's own
   * copy -- see its deleted comment). This mechanism has no such
   * redundancy: there is exactly one portaled prompt, so exactly one
   * anchor (`magicLinkAnchor`'s target) can ever match.
   */
  it("expands the anchor only while a card is really on screen (ticket 931df8a)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();

    // Visible card -> exactly the active (search) tab's anchor expands.
    expect(visibleAnchorCount()).toBe(1);

    // Dismissed -> the host survives UN-hidden but renders no card, which
    // is exactly the case the `> .magic-link-prompt` half of the selector
    // exists to catch.
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(document.querySelectorAll(".magic-link-prompt")).toHaveLength(0);
    expect(document.querySelectorAll(".magic-link-prompt-host")).toHaveLength(1);
    expect(visibleAnchorCount()).toBe(0);
  });

  it("collapses the anchor while the host is mounted but hidden (ticket 931df8a)", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(visibleAnchorCount()).toBe(1);

    // Picker open: host stays mounted (F2's state preservation) but hidden,
    // so no card is on screen and no anchor should be expanded for one.
    fireEvent.click(screen.getByRole("button", { name: "Change resume" }));
    expect(visibleAnchorCount()).toBe(0);

    // And back on cancel, proving the rule tracks visibility rather than
    // latching off permanently.
    fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
    expect(visibleAnchorCount()).toBe(0);
  });

  /**
   * Ticket 931df8a. `searchArmReady` checks the UNFILTERED fetch
   * (`resultsState.data.results.length > 0`), but `ResultsList`'s own
   * hide-overqualified/underqualified/contract-temp checkboxes can filter
   * that down to zero VISIBLE cards -- no `<ResultCard>`, and therefore no
   * anchor, is rendered in that state (see `ResultsList.tsx`'s
   * `onFirstResultAnchorChange`). Without `fallbackMagicLinkAnchor` to fall
   * back to, `magicLinkPortalRoot` would have nowhere VISIBLE to be
   * attached, which has the same practical effect as unmounting it -- a
   * filter checkbox would wipe whatever MagicLinkPrompt was holding, the
   * exact class of bug ticket d0a7074's review F2 already fixed once.
   *
   * Review round 2, required fix: the first version of this test left
   * `getAllResults` returning an EMPTY list, which made `scoredResultsAnchor`
   * null too -- the one condition under which the ORIGINAL (buggy) anchor
   * chain and the fixed one compute the exact same thing, so the test could
   * not tell them apart (it passed against both). This version gives the
   * scored tab a real, live anchor -- inside ITS OWN `hidden` panel, since
   * the active tab is still "search" -- which is the reviewer's own
   * reproduction: the buggy chain (`searchResultsAnchor ?? scoredResultsAnchor
   * ?? fallbackMagicLinkAnchor`) borrows that hidden anchor before ever
   * reaching the fallback, attaching `magicLinkPortalRoot` inside a
   * `display: none` subtree while `magicLinkPortalRoot.hidden` stays
   * `false` -- on screen by the app's own bookkeeping, invisible and out
   * of the accessibility tree in fact. `getByRole` (unlike a bare DOM
   * query) is what actually tells these apart: a heading inside a
   * `[hidden]` ancestor is not in the accessibility tree, so this query
   * fails under the borrow and only passes once the card is genuinely
   * reachable via the always-visible fallback.
   */
  it("stays mounted and ACCESSIBLY visible when the active tab's own list is filtered to zero cards, even with a live anchor sitting in the other (hidden) tab", async () => {
    mockHappyPath({
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [{ ...ONE_RESULT.results[0]!, levelFit: "overqualified" }],
    });
    // The scored tab has a real result too -- so `scoredResultsAnchor` is
    // live, sitting inside that tab's `hidden` panel, while "search" stays
    // the active tab throughout this test.
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
    // The normal in-list anchor is in use before the filter is touched.
    expect(visibleAnchorCount()).toBe(1);

    // Filter the one result out entirely -- zero VISIBLE cards on the
    // active (search) tab, even though the underlying fetch still has one,
    // so `searchArmReady` (and therefore `showMagicLinkPrompt`) stays true
    // throughout. `scoredResultsAnchor` remains live and non-null the
    // whole time, inside the scored tab's own `hidden` panel.
    fireEvent.click(screen.getByRole("checkbox", { name: /hide roles i'm overqualified for/i }));
    await screen.findByText(/uncheck "hide roles i'm overqualified for" to see them/i);

    // Still on screen, and -- the point of this test -- genuinely
    // ACCESSIBLE: `getByRole` throws if the heading is inside a `[hidden]`
    // ancestor, which is exactly where the borrow used to leave it.
    expect(screen.getByRole("heading", { name: /find these results again/i })).toBeInTheDocument();
    // No in-list anchor is active anywhere: the search tab's own anchor is
    // gone (filtered to zero), and the scored tab's anchor -- live but
    // never borrowed -- correctly never expands for a card it isn't
    // hosting.
    expect(visibleAnchorCount()).toBe(0);
  });

  /**
   * Ticket 931df8a's actual acceptance criterion: the host must never
   * render ABOVE the topmost result. Checked as DOM order within the
   * results region, which is the one piece of "where does this appear"
   * jsdom can answer without a real layout engine -- see the ticket's own
   * note that visual placement at desktop/phone widths could not be
   * screenshotted in this environment (no working headless browser; see
   * ticket 9c78da1) and must be eyeballed separately.
   */
  it("never renders above the topmost result on the search tab", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    await submitResume();
    await runSearchToCompletion();

    const resultsSection = screen
      .getByRole("heading", { name: "Results from this search" })
      .closest(".results-section");
    expect(resultsSection).not.toBeNull();

    const inOrder = Array.from(
      resultsSection!.querySelectorAll(".result-card, .magic-link-prompt-host"),
    );
    const firstResultIndex = inOrder.findIndex((el) => el.classList.contains("result-card"));
    const hostIndex = inOrder.findIndex((el) => el.classList.contains("magic-link-prompt-host"));
    expect(firstResultIndex).toBe(0);
    expect(hostIndex).toBeGreaterThan(firstResultIndex);
  });

  it("never renders above the topmost result on Already Scored Jobs either", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue(SCORED);

    render(<App />);
    openScoredTab();
    await screen.findByText("Previously Scored Engineer");

    const resultsSection = screen
      .getByRole("heading", { name: /^Already Scored Jobs/ })
      .closest(".results-section");
    expect(resultsSection).not.toBeNull();

    const inOrder = Array.from(
      resultsSection!.querySelectorAll(".result-card, .magic-link-prompt-host"),
    );
    const firstResultIndex = inOrder.findIndex((el) => el.classList.contains("result-card"));
    const hostIndex = inOrder.findIndex((el) => el.classList.contains("magic-link-prompt-host"));
    expect(firstResultIndex).toBe(0);
    expect(hostIndex).toBeGreaterThan(firstResultIndex);
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
  /**
   * Ticket e2b5f9c. The state right after a magic-link sign-in is the one that
   * matters: `MagicLinkLanding` calls `clearAppState()` on an identity switch,
   * so there is no active resume, and before this fix the New Job Search tab
   * offered a blank textarea with the adopted account's resumes unreachable.
   * Nicole hit exactly this on the live deployment -- she signed in to recover
   * her work and could not get to it.
   *
   * Asserted at App level rather than only on the component, because the gap
   * was in the WIRING: `resumesListState` was already fetched and already in
   * scope; nothing passed it anywhere a user with no active resume could see.
   */
  it("offers the adopted account's saved resumes on New Job Search, with no active resume", async () => {
    mockHappyPath(ONE_RESULT);
    getAllResults.mockResolvedValue({ results: [] } satisfies GetAllResultsResponse);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1" },
        { id: "resume-2", resumeNickname: "Resume 2" },
      ],
    });
    // Signed in, and no session state -- exactly what clearAppState() leaves.
    localStorage.setItem("jobsearch.web.userEmail.v1", "alice@example.com");
    sessionStorage.clear();

    render(<App />);

    expect(await screen.findByRole("button", { name: "Use Resume 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Resume 2" })).toBeInTheDocument();
    // Pasting is still available -- this adds a path, it does not replace one.
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
  });

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
