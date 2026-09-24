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
// Ticket 3f0883f: "Already Scored Jobs" reads GET /results now, not
// GET /resumes/:id/results -- useAllResults calls this unconditionally on
// every mount, same as getResults, so every test in this file (none of
// which care about that tab's content) needs it mocked to resolve or the
// hook's `.then()` throws against an unmocked `undefined` return.
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
const setJobStatus = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: (...args: unknown[]) => setJobStatus(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  // Ticket bf2dd0a: SearchFlow now polls this alongside every estimate
  // call. This file never asserts on progress display, so a simple
  // always-rejecting stub (treated as "nothing to show" -- see
  // SearchFlow.tsx's startEstimateProgressPolling) is enough.
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
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
  it("sends a REAL criteria object (never undefined) when the resume has no suggested titles of its own -- ticket 8a403ee's extras still populate it", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    // Ticket 8a403ee: titleChips is never truly empty once a resume is
    // submitted -- the extra chips populate it even with zero
    // resume-inferred titles -- so the "no title keywords yet" empty
    // state from ticket 39b4a48 is no longer reachable this way. That's
    // fine: this test's real point (never a silent hidden-default
    // fallback) is proven by the exact payload assertion below either way.

    // Ticket b9e6251: an empty location (no nearLocations, no remoteOk)
    // now requires the explicit "Any location" opt-in before the estimate
    // button is even enabled -- see SearchCriteriaForm's own location
    // warning.
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // The critical assertion: exactly what's in titleChips, NOT undefined
    // -- undefined would silently reproduce the old hardcoded default
    // this ticket exists to remove. `anyLocationOk` itself is a
    // frontend-only gating signal -- it never appears in the criteria
    // payload sent to the API.
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      { titleInclude: ["Program Analyst", "IT Specialist", "Computer Scientist"] },
      expect.any(String),
    );
  });

  // Review round 1 finding (opus, F2): ticket 8a403ee means titleChips is
  // never empty immediately after a submit (the extras always populate
  // it), which left this file with no test at all exercising the
  // `titleChips.length === 0` branch (buildSearchCriteria, App.tsx) --
  // still live and reachable any time a user removes every chip by hand.
  // Restores that coverage explicitly, now via manual removal rather than
  // "nothing was ever suggested."
  it("sends a real empty criteria object (not undefined, not omitted) once every chip -- including the extras -- is manually removed", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "Program Analyst"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Remove "IT Specialist"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Remove "Computer Scientist"' }));

    // Ticket 39b4a48's original empty-state hint is reachable again, same
    // as before this ticket ever added anything automatically.
    expect(
      screen.getByText(/No title keywords yet.*leave this empty to search every title/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {}, expect.any(String));
  });

  it("pre-populates chips from the resume's real suggestedTitles and sends them as titleInclude", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: [
          "Backend Engineer",
          "Platform Engineer",
          "Program Analyst",
          "IT Specialist",
          "Computer Scientist",
        ],
      },
      expect.any(String),
    );
  });

  it("removing a suggested chip changes what's sent", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer", "Platform Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: 'Remove "Backend Engineer"' }));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: [
          "Platform Engineer",
          "Program Analyst",
          "IT Specialist",
          "Computer Scientist",
        ],
      },
      expect.any(String),
    );
  });

  it("adding a custom chip includes it alongside the suggestions", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.change(screen.getByLabelText("Add a job title keyword"), {
      target: { value: "Site Reliability Engineer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByLabelText("Also show fully remote roles"));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: [
          "Backend Engineer",
          "Program Analyst",
          "IT Specialist",
          "Computer Scientist",
          "Site Reliability Engineer",
        ],
        remoteOk: true,
      },
      expect.any(String),
    );
  });

  it("commitment checkboxes (ticket 18c9f18) are omitted from criteria when unchecked and sent as commitmentIn when checked", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Contract"));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: ["Program Analyst", "IT Specialist", "Computer Scientist"],
        commitmentIn: ["full-time", "contract"],
      },
      expect.any(String),
    );
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
    getAllResults.mockResolvedValue(RESULTS);

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
    getAllResults.mockResolvedValue(RESULTS);
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
    getAllResults.mockResolvedValue(RESULTS);
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
    getAllResults.mockResolvedValue(RESULTS);

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
    getAllResults.mockResolvedValue(RESULTS);
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
    getAllResults.mockResolvedValue(RESULTS);

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
    getAllResults.mockResolvedValue(RESULTS);
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
    getAllResults.mockResolvedValue(RESULTS);

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
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sentCriteria = estimateSearch.mock.calls[0]?.[2];
    // Ticket 8a403ee: titleInclude always carries the extra chips now --
    // the real point of this test is the `anyLocationOk` exclusion below.
    expect(sentCriteria).toEqual({
      titleInclude: ["Program Analyst", "IT Specialist", "Computer Scientist"],
    });
    expect(sentCriteria).not.toHaveProperty("anyLocationOk");
  });
});

describe("App — opt-in metro-area expansion (ticket 410e1a2)", () => {
  async function submitAndType(location: string) {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.change(screen.getByLabelText(/Locations you'd commute to/), {
      target: { value: location },
    });
  }

  it("does not send the flag unless the user checks the box — the default stays strict all the way to the wire", async () => {
    await submitAndType("Seattle");
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sent = estimateSearch.mock.calls[0]?.[2];
    expect(sent).not.toHaveProperty("expandMetroAreas");
    expect(sent).toMatchObject({ nearLocations: ["Seattle"] });
  });

  it("sends expandMetroAreas: true once the checkbox is checked", async () => {
    await submitAndType("Seattle");
    fireEvent.click(screen.getByLabelText(/Also include nearby cities in the same metro area/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch.mock.calls[0]?.[2]).toMatchObject({
      nearLocations: ["Seattle"],
      expandMetroAreas: true,
    });
  });

  it("omits the flag when it is checked but there is no location to expand", async () => {
    // It only ever widens `nearLocations` entries. With none, sending it
    // would put a flag on the wire that cannot change a single result.
    await submitAndType("");
    fireEvent.click(screen.getByLabelText(/Also include nearby cities in the same metro area/));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch.mock.calls[0]?.[2]).not.toHaveProperty("expandMetroAreas");
  });
});

// Ticket 09b8e4d, superseded by ticket 8a403ee. 09b8e4d's original design:
// a separate "click to add" suggestion row, shown only while USAJOBS was
// selected, deliberately never auto-added ("suggest, don't silently
// default"). Nicole, dogfooding after actually using it: "you never know
// if somebody's going to zone out" past a suggestion they had to notice
// and click -- and on discussion, explicitly rejected keeping any
// source-toggle-aware add/remove logic at all: "I don't want to build all
// the functionality for... they should just behave the same as every
// other chips, get added automatically." These titles are now folded
// directly into `titleChips` at resume-submission time (App.tsx), exactly
// like the resume-inferred ones -- no separate suggestion UI, no
// dependency on which sources are toggled, ever.
describe("App — extra title chips folded in automatically at resume-submission time (ticket 8a403ee, superseding 09b8e4d)", () => {
  it("adds the extra chips automatically once a resume is submitted, appended after the resume-inferred ones -- no separate suggestion UI at all", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["Backend Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    // Real, ordinary chips -- not a separate suggestion row (which no
    // longer exists at all).
    expect(screen.queryByRole("list", { name: "Suggested federal job titles" })).toBeNull();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Program Analyst")).toBeInTheDocument();
    expect(screen.getByText("IT Specialist")).toBeInTheDocument();
    expect(screen.getByText("Computer Scientist")).toBeInTheDocument();
    // Each is removable like any other chip -- indistinguishable from a
    // resume-inferred one once added.
    expect(screen.getByRole("button", { name: 'Remove "Program Analyst"' })).toBeInTheDocument();
  });

  // Review round 1 finding (opus, F1): the original version of this test
  // used an EXACT-case match ("Program Analyst"), which a case-SENSITIVE
  // dedupe would also have passed -- not a real proof of the
  // case-insensitive comparison App.tsx's own comment claims. Claude
  // (the real source of `suggestedTitles`) can plausibly return "Program
  // analyst" or "program Analyst"; a mismatched-case fixture is what
  // actually exercises that path. Mutation-verified: dropping the
  // `.toLowerCase()` calls in App.tsx's dedupe made this exact test fail
  // (two "Program Analyst"-ish chips instead of one), while it silently
  // passed against the old exact-case fixture.
  it("does not duplicate an extra chip the resume's own inferred titles already include, even in a different case", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: ["program analyst"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    // Exactly one chip for this title -- whichever casing the resume
    // inference returned, not a second "Program Analyst" alongside it.
    expect(screen.getByText("program analyst")).toBeInTheDocument();
    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
    // The other two extras still get added -- de-dupe is per-title, not
    // "skip the whole list if anything overlaps."
    expect(screen.getByText("IT Specialist")).toBeInTheDocument();
    expect(screen.getByText("Computer Scientist")).toBeInTheDocument();
  });

  it("stays added regardless of USAJOBS being toggled off -- no source-toggle-aware add/remove logic exists", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();
    expect(screen.getByText("Program Analyst")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("USAJOBS"));

    // Nicole was explicit this should NOT be re-synced to toggle state --
    // deselecting USAJOBS must not silently remove it.
    expect(screen.getByText("Program Analyst")).toBeInTheDocument();
  });

  it("is sent to the API like any other title chip", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      { titleInclude: ["Program Analyst", "IT Specialist", "Computer Scientist"] },
      expect.any(String),
    );
  });

  it("removing an extra chip removes it for good -- it is not re-added on a later render", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();
    fireEvent.click(screen.getByRole("button", { name: 'Remove "Program Analyst"' }));

    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
    expect(screen.getByText("IT Specialist")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("USAJOBS"));
    fireEvent.click(screen.getByLabelText("USAJOBS"));

    // Toggling sources -- the one thing the old design's removed logic
    // reacted to -- must not resurrect a chip the user just removed.
    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
  });

  it("shows the explanatory note near the title chips", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    expect(screen.getByText(/title variations some employers use/)).toBeInTheDocument();
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
    getAllResults.mockResolvedValue(RESULTS);

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
    getAllResults.mockResolvedValue(RESULTS);
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
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();
    fireEvent.click(screen.getByLabelText(/Any location/));

    fireEvent.click(screen.getByRole("button", { name: "Estimate search cost" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
