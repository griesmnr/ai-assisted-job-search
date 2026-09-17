// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 39b4a48: resume-inferred title chips replace ticket 957bc22's
 * "leave everything blank = undefined" design. The money-critical behavior
 * now is the OPPOSITE direction from before: criteria must be a REAL
 * object from the moment a resume exists — including when suggestedTitles
 * comes back empty — never `undefined` (which would silently reproduce
 * the old hardcoded software-engineering/staff-excluding default). Nicole,
 * live: "I'd rather have it be a really expensive search offered than a
 * blind default."
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

// Ticket 371713d: jsdom does not implement `scrollIntoView` at all -- calling
// it throws `TypeError: ... is not a function`. Most tests in this file
// never trigger it (they check "Any location" or type a location before
// clicking "Estimate search cost"), but several of the b9e6251 tests below
// deliberately click it WHILE invalid to prove the click is blocked, which
// (as of this ticket) now also calls App.tsx's `handleInvalidEstimateAttempt`
// -> `locationSectionRef.current?.scrollIntoView(...)`. A file-level
// `beforeEach` (not nested in any one `describe`) stubs it for every test
// here, so an incidental invalid click anywhere in this file can't crash
// with an unrelated jsdom gap; the dedicated ticket-371713d `describe` below
// re-stubs it locally too, to get its own fresh mock reference to assert on.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn<typeof Element.prototype.scrollIntoView>();
});

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

const RESULTS: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [],
};

function makeEstimate(): EstimateSearchResponse {
  return {
    resumeId: "resume-1",
    costEstimate: {
      jobCount: 0,
      estimatedInputTokens: 0,
      estimatedCacheReadTokens: 0,
      estimatedCacheCreationTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
      maxCostUsd: 0,
      probableCostUsd: 0,
      basis: "bootstrap",
    },
    candidatesNeedingScore: 0,
    scoreThreshold: 100,
    cappedCount: 0,
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
  };
}

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Use this resume" }));
  // Wait for CHECKED, not just present: the checkbox renders as soon as
  // sourcesState is "ready", one render BEFORE App.tsx's own auto-select
  // effect populates selectedSourceIds and re-renders it checked. Clicking
  // "Estimate search cost" in that window hits a still-disabled button
  // (sourceIds.length === 0) -- a real, if narrow, timing race in this
  // test, not the app. Confirmed by 3 consecutive real runs: flaky ~1/3
  // of the time on findByLabelText alone, deterministic once this waits
  // for the checked state that actually gates the button.
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
}

describe("App — resume-inferred title chips (ticket 39b4a48)", () => {
  it("sends a REAL empty criteria object (never undefined) when the resume has no suggested titles", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    expect(
      screen.getByText(/No title keywords yet.*leave this empty to search every title/),
    ).toBeInTheDocument();

    // Ticket b9e6251: an empty location (no nearLocations, no remoteOk)
    // now requires the explicit "Any location" opt-in before the estimate
    // button is even enabled -- see SearchCriteriaForm's own location
    // warning.
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // The critical assertion: {} (a real, empty, permissive object), NOT
    // undefined -- undefined would silently reproduce the old hardcoded
    // default this ticket exists to remove. `anyLocationOk` itself is a
    // frontend-only gating signal -- it never appears in the criteria
    // payload sent to the API.
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {});
  });

  it("pre-populates chips from the resume's real suggestedTitles and sends them as titleInclude", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Backend Engineer", "Platform Engineer"],
    });
  });

  it("removing a suggested chip changes what's sent", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: 'Remove "Backend Engineer"' }));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Platform Engineer"],
    });
  });

  it("adding a custom chip includes it alongside the suggestions", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.change(screen.getByLabelText("Add a job title keyword"), {
      target: { value: "Site Reliability Engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Backend Engineer", "Site Reliability Engineer"],
      remoteOk: true,
    });
  });

  it("commitment checkboxes (ticket 18c9f18) are omitted from criteria when unchecked and sent as commitmentIn when checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Contract"));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      commitmentIn: ["full-time", "contract"],
    });
  });
});

// Ticket b9e6251: an empty location used to mean "search anywhere,
// silently" -- the same shape of never-explicitly-chosen default Nicole's
// own principle already rejected for title keywords. Now it requires a
// real, explicit signal before "Estimate search cost" is even reachable.
describe("App — explicit any-location opt-in (ticket b9e6251)", () => {
  it("blocks Estimate search cost (without a real `disabled` attribute) and shows a warning when no location signal is set", async () => {
    // Ticket 371713d: the button is no longer natively `disabled` for THIS
    // reason (see SearchFlow.tsx's own comment on why -- a real `disabled`
    // button can't fire onClick, which is needed for the "attempted click
    // scrolls back to the location section" behavior). The functional
    // gate must still hold: clicking it must not call the real estimate.
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();

    const button = screen.getByRole("button", { name: "Estimate search cost" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(estimateSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();
  });

  it("checking 'Any location' allows the button to actually estimate, and clears the warning", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    const button = screen.getByRole("button", { name: "Estimate search cost" });
    fireEvent.click(button);
    expect(estimateSearch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(/Any location/));

    expect(button).toHaveAttribute("aria-disabled", "false");
    expect(screen.queryByText(/No location restriction is set/)).not.toBeInTheDocument();

    fireEvent.click(button);
    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
  });

  it("typing a commute location enables the button without needing 'Any location' checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
      target: { value: "seattle" },
    });

    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    expect(screen.queryByText(/No location restriction is set/)).not.toBeInTheDocument();
  });

  it("a lone comma in the commute-locations field does NOT count as a location signal (opus review F3)", async () => {
    // Real bug this closes: `nearLocations.trim().length > 0` alone would
    // have treated "," as a genuine signal (a non-empty string), silently
    // enabling the exact unrestricted search this ticket exists to
    // prevent. `splitPhrases(",")` correctly yields zero real phrases.
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();

    fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
      target: { value: "," },
    });

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    expect(estimateSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();
  });

  it("checking 'Also show fully remote roles' enables the button without needing 'Any location' checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    expect(screen.getByRole("button", { name: "Estimate search cost" })).not.toBeDisabled();
    expect(screen.queryByText(/No location restriction is set/)).not.toBeInTheDocument();
  });

  it("unchecking 'Any location' again re-blocks the button (not a one-way opt-in)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    expect(screen.getByRole("button", { name: "Estimate search cost" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );

    fireEvent.click(screen.getByLabelText(/Any location/));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    expect(estimateSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();
  });

  it("unchecking 'Any location' AFTER a real estimate invalidates it back to idle (opus review F1, blocking)", async () => {
    // Real bug this closes: `anyLocationOk` is deliberately not part of
    // `criteria` (it never reaches the API), so SearchFlow's own
    // estimate-invalidation effect (keyed on resumeId/sourceIds/criteria)
    // couldn't see it change on its own -- a stale, still-confirmable
    // "Run search" button was left on screen for the exact unrestricted
    // search the warning simultaneously said was disabled, and clicking
    // through actually spent money on it.
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    await screen.findByRole("button", { name: "Run search" });

    fireEvent.click(screen.getByLabelText(/Any location/));

    // The stale "Run search" confirmation must be gone -- back to a fresh,
    // blocked "Estimate search cost", not a spendable leftover.
    expect(screen.queryByRole("button", { name: "Run search" })).not.toBeInTheDocument();
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();

    // Ticket 371713d: the button is no longer natively `disabled` for this
    // reason, so this is the regression-proof that a click while invalid
    // still does not fire a SECOND, real estimate call against the
    // now-invalid criteria.
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));
    expect(estimateSearch).toHaveBeenCalledTimes(1);
  });

  it("checking 'Any location' with zero sources selected still explains why the button is disabled (opus review F2)", async () => {
    // Real bug this closes: the location warning disappears once "Any
    // location" is checked, but if zero sources are ALSO selected, the
    // button stays disabled with (before this fix) no explanation
    // anywhere on screen -- a dead end after doing exactly what the only
    // visible instruction said to do.
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();
    fireEvent.click(screen.getByLabelText("USAJOBS")); // uncheck the only source

    fireEvent.click(screen.getByLabelText(/Any location/));

    expect(screen.getByRole("button", { name: "Estimate search cost" })).toBeDisabled();
    expect(screen.getByText(/Select at least one source/)).toBeInTheDocument();
  });

  it("'Any location' does not appear in the criteria payload sent to the API -- it's a frontend-only gate", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sentCriteria = estimateSearch.mock.calls[0]?.[2];
    expect(sentCriteria).toEqual({});
    expect(sentCriteria).not.toHaveProperty("anyLocationOk");
  });
});

// Ticket 09b8e4d: follow-up from d1fc9e2's Scope section. d1fc9e2 fixed
// USAJOBS to actually search on whatever title chips the user has, which
// makes the gap concrete -- a private-sector resume's inferred titles
// ("Software Engineer" etc, ticket 39b4a48) never contain OPM job-series
// names, so a user searching USAJOBS off resume-inferred chips alone
// silently misses federal postings. These suggestions are gated on
// `selectedSourceIds.has("usajobs")` in App.tsx (SearchCriteriaForm itself
// stays "dumb" about source IDs), and -- same "suggest, don't silently
// default" principle as the resume-inferred chips -- are never auto-added.
describe("App — federal job-series title suggestions when USAJOBS is selected (ticket 09b8e4d)", () => {
  it("surfaces the federal suggestions once USAJOBS is selected, distinct from resume-inferred chips, and does NOT auto-add them", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);

    // `submitResume` waits for the USAJOBS toggle to be checked, so by the
    // time it resolves the suggestion row must already be showing.
    await submitResume();

    expect(screen.getByRole("list", { name: "Suggested federal job titles" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Program Analyst" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ IT Specialist" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Computer Scientist" })).toBeInTheDocument();

    // Resume-inferred chip is present, but none of the federal suggestions
    // were silently folded into the active chip list just because USAJOBS
    // is selected -- suggesting is not the same as adding.
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
    expect(screen.queryByText("IT Specialist")).not.toBeInTheDocument();
    expect(screen.queryByText("Computer Scientist")).not.toBeInTheDocument();
  });

  it("hides the federal suggestions once USAJOBS is deselected", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();
    expect(screen.getByRole("list", { name: "Suggested federal job titles" })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("USAJOBS"));

    expect(
      screen.queryByRole("list", { name: "Suggested federal job titles" }),
    ).not.toBeInTheDocument();
  });

  it("clicking a suggestion adds it as a real title chip, sent to the API like any other", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "+ Program Analyst" }));

    // Now a real chip -- rendered with its own remove button, same as a
    // resume-inferred or manually-typed one.
    expect(screen.getByRole("button", { name: 'Remove "Program Analyst"' })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {
      titleInclude: ["Program Analyst"],
    });
  });

  it("clicking an already-added suggestion again does not duplicate the chip (the button disables instead)", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Program Analyst"],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();

    // Already present via resume-inferred titles -- the matching suggestion
    // button must reflect that immediately, not just after a click.
    const suggestionButton = screen.getByRole("button", { name: "+ Program Analyst" });
    expect(suggestionButton).toBeDisabled();

    fireEvent.click(suggestionButton);

    // Still exactly one "Program Analyst" chip -- no duplicate got through.
    expect(screen.getAllByText("Program Analyst")).toHaveLength(1);
  });
});

// Ticket 371713d: Nicole, live -- "when they go to try to do the next
// step, it should force them to do that [set a location]." These tests
// exercise the actual cross-component mechanism (App.tsx holds a ref into
// SIBLING SearchCriteriaForm's location section, and hands a callback that
// reads it down into SIBLING SearchFlow -- see both components' own doc
// comments on `locationSectionRef`/`onInvalidEstimateAttempt`), through the
// real App tree rather than either component in isolation, since the
// mechanism's whole point is the link BETWEEN them.
describe("App — attempting to estimate without a location scrolls back to it (ticket 371713d)", () => {
  // jsdom does not implement `scrollIntoView` at all (calling it throws
  // "not a function" without this) -- a plain spy is the standard
  // workaround and also doubles as the "real, verifiable signal" the
  // ticket's acceptance criteria explicitly asks for, rather than a purely
  // visual claim.
  let scrollIntoViewMock: Mock<typeof Element.prototype.scrollIntoView>;

  beforeEach(() => {
    scrollIntoViewMock = vi.fn<typeof Element.prototype.scrollIntoView>();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it("clicking 'Estimate search cost' with no location signal scrolls the location section (not some unrelated element) into view, moves focus to the location input, and does NOT call the real estimate", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    // Opus review F1 (blocking): asserting the CALL alone doesn't prove
    // WHICH element scrolled -- the reviewer proved this by moving the ref
    // to an unrelated element and confirming the old assertion still
    // passed. `mock.contexts[0]` is the actual `this` the spy was invoked
    // on (i.e. the real element `scrollIntoView` was called against, since
    // it's stubbed on `Element.prototype`), so asserting on it is a real
    // check of which element scrolled.
    expect(scrollIntoViewMock.mock.contexts[0]).toHaveClass("search-criteria-location-section");
    // Opus review F4: scrolling alone leaves focus on the button itself
    // (which is AFTER the location section in DOM order); moving real DOM
    // focus onto the location input as well gives a keyboard user a
    // sensible next Tab target and gives a screen reader user a
    // re-announcement of the invalid, labeled field.
    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveFocus();
    expect(estimateSearch).not.toHaveBeenCalled();
  });

  it("a valid location (typed, not the checkbox) does not trigger the scroll and lets the estimate proceed normally", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
      target: { value: "seattle" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("'Any location' checked also lets the estimate proceed without triggering the scroll", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
