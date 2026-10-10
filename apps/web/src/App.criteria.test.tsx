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
  // Ticket 303cff0 ("My Resumes" tab): useResumesList fetches this
  // unconditionally on every App mount now, regardless of which tab is
  // active -- none of these tests assert on it, so a static empty list
  // (same pattern as getEstimateProgress above) is enough.
  listResumes: () => Promise.resolve({ resumes: [] }),
  getResume: () => Promise.reject(new Error("no resume text fetched in this test")),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

// Ticket 371713d: jsdom does not implement `scrollIntoView` at all -- calling
// it throws `TypeError: ... is not a function`. Most tests in this file
// never trigger it (they check "Any location" or type a location before
// clicking "Get estimate"), but several of the b9e6251 tests below
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
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
    locationWarnings: [],
  };
}

async function submitResume() {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Paste your resume"), {
    target: { value: "some resume text" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  // Wait for CHECKED, not just present: the checkbox renders as soon as
  // sourcesState is "ready", one render BEFORE App.tsx's own auto-select
  // effect populates selectedSourceIds and re-renders it checked. Clicking
  // "Get estimate" in that window hits a still-disabled button
  // (sourceIds.length === 0) -- a real, if narrow, timing race in this
  // test, not the app. Confirmed by 3 consecutive real runs: flaky ~1/3
  // of the time on findByLabelText alone, deterministic once this waits
  // for the checked state that actually gates the button.
  await waitFor(() => expect(screen.getByLabelText("USAJOBS")).toBeChecked());
}

describe("App — resume-inferred title chips (ticket 39b4a48)", () => {
  // Ticket 5c4242d: was "...ticket 8a403ee's extras still populate it" --
  // that framing no longer applies now that 5c4242d deleted the extras
  // mechanism (`mergeTitleChips`/`EXTRA_TITLE_CHIPS`, App.tsx). With
  // nothing appended after `suggestedTitles`, a resume with no suggested
  // titles of its own now lands DIRECTLY in the `titleChips.length === 0`
  // state this test used to be unable to reach without manual removal --
  // folded into one test with what used to be a second, separate test for
  // that same empty-criteria-object property (see this test's own name).
  it("sends a real empty criteria object (never undefined, never omitted) when the resume has no suggested titles of its own", async () => {
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
    // Ticket 39b4a48's original empty-state hint is reachable directly
    // now -- no manual removal needed, since nothing is appended to an
    // empty `suggestedTitles` any more.
    expect(
      screen.getByText(/No title keywords yet.*leave this empty to search every title/),
    ).toBeInTheDocument();

    // Ticket b9e6251: an empty location (no nearLocations, no remoteOk)
    // now requires the explicit "Any location" opt-in before the estimate
    // button is even enabled -- see SearchCriteriaForm's own location
    // warning.
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // The critical assertion: a real `{}`, NOT undefined and NOT omitted
    // -- undefined would silently reproduce the old hardcoded default
    // this ticket exists to remove. `anyLocationOk` itself is a
    // frontend-only gating signal -- it never appears in the criteria
    // payload sent to the API.
    expect(estimateSearch).toHaveBeenCalledWith("resume-1", ["usajobs"], {}, expect.any(String));
  });

  // Review round 1 finding (opus, F2), ticket 8a403ee: that ticket's
  // extras meant titleChips was never empty immediately after a submit,
  // which left this file with no test exercising the
  // `titleChips.length === 0` branch (buildSearchCriteria, App.tsx) via
  // MANUAL removal specifically -- still live and worth its own coverage
  // distinct from "nothing was ever suggested" above, since the code path
  // (remove down to zero) is different from "started at zero." Ticket
  // 5c4242d: rewritten to remove a real resume-inferred chip rather than
  // the now-deleted extras, which is the only way to reach this path
  // post-removal.
  it("sends a real empty criteria object (not undefined, not omitted) once every suggested chip is manually removed", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: 'Remove "Backend Engineer"' }));

    expect(
      screen.getByText(/No title keywords yet.*leave this empty to search every title/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    // Ticket 5c4242d: was followed by the hardcoded "Program
    // Analyst"/"IT Specialist"/"Computer Scientist" trio -- deleted along
    // with `mergeTitleChips`. `titleInclude` is now exactly
    // `suggestedTitles`, unmodified.
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: ["Backend Engineer", "Platform Engineer"],
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: ["Platform Engineer"],
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: ["Backend Engineer", "Site Reliability Engineer"],
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
      // Ticket 5c4242d: non-empty, not `[]` -- this test's own point is
      // `commitmentIn`, but with the extras mechanism deleted an empty
      // `suggestedTitles` would omit `titleInclude` entirely (see the
      // dedicated empty-criteria tests above), which would stop this test
      // from also exercising `titleInclude` alongside `commitmentIn` in
      // the same payload.
      suggestedTitles: ["Backend Engineer"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);
    estimateSearch.mockResolvedValue(makeEstimate());

    await submitResume();

    fireEvent.click(screen.getByLabelText("Full-time"));
    fireEvent.click(screen.getByLabelText("Contract"));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch).toHaveBeenCalledWith(
      "resume-1",
      ["usajobs"],
      {
        titleInclude: ["Backend Engineer"],
        commitmentIn: ["full-time", "contract"],
      },
      expect.any(String),
    );
  });
});

// Ticket b9e6251: an empty location used to mean "search anywhere,
// silently" -- the same shape of never-explicitly-chosen default Nicole's
// own principle already rejected for title keywords. Now it requires a
// real, explicit signal before "Get estimate" is even reachable.
describe("App — explicit any-location opt-in (ticket b9e6251)", () => {
  it("blocks Get estimate (without a real `disabled` attribute) and shows a warning when no location signal is set", async () => {
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

    const button = screen.getByRole("button", { name: "Get estimate" });
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
    const button = screen.getByRole("button", { name: "Get estimate" });
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

    expect(screen.getByRole("button", { name: "Get estimate" })).not.toBeDisabled();
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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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

    expect(screen.getByRole("button", { name: "Get estimate" })).not.toBeDisabled();
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
    expect(screen.getByRole("button", { name: "Get estimate" })).toHaveAttribute(
      "aria-disabled",
      "false",
    );

    fireEvent.click(screen.getByLabelText(/Any location/));

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    await screen.findByRole("button", { name: "Run search" });

    fireEvent.click(screen.getByLabelText(/Any location/));

    // The stale "Run search" confirmation must be gone -- back to a fresh,
    // blocked "Get estimate", not a spendable leftover.
    expect(screen.queryByRole("button", { name: "Run search" })).not.toBeInTheDocument();
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();

    // Ticket 371713d: the button is no longer natively `disabled` for this
    // reason, so this is the regression-proof that a click while invalid
    // still does not fire a SECOND, real estimate call against the
    // now-invalid criteria.
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
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

    expect(screen.getByRole("button", { name: "Get estimate" })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sentCriteria = estimateSearch.mock.calls[0]?.[2];
    // Ticket 5c4242d: was "titleInclude always carries the extra chips
    // now" -- that mechanism is deleted, so a resume with no suggested
    // titles sends a bare `{}`. The real point of this test, unchanged, is
    // the `anyLocationOk` exclusion below.
    expect(sentCriteria).toEqual({});
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
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    const sent = estimateSearch.mock.calls[0]?.[2];
    expect(sent).not.toHaveProperty("expandMetroAreas");
    expect(sent).toMatchObject({ nearLocations: ["Seattle"] });
  });

  it("sends expandMetroAreas: true once the checkbox is checked", async () => {
    await submitAndType("Seattle");
    fireEvent.click(screen.getByLabelText(/Also include nearby cities/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

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
    fireEvent.click(screen.getByLabelText(/Also include nearby cities/));
    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(estimateSearch.mock.calls[0]?.[2]).not.toHaveProperty("expandMetroAreas");
  });
});

// Ticket 09b8e4d, then 8a403ee, then 5c4242d. 09b8e4d's original design: a
// separate "click to add" suggestion row, shown only while USAJOBS was
// selected, deliberately never auto-added. 8a403ee folded a FIXED trio
// ("Program Analyst"/"IT Specialist"/"Computer Scientist") directly into
// `titleChips` at resume-submission time instead, unconditionally,
// regardless of the resume's field.
//
// REMOVED by ticket 5c4242d, 2026-10-10: that frontend-side folding
// mechanism (`EXTRA_TITLE_CHIPS`/`mergeTitleChips`, App.tsx) is gone --
// see that file's own removal doc comment. John (IT/DevOps) got the
// identical trio Nicole always got and correctly cancelled two of three as
// wrong for his field; the AI side (resume-title-inference.ts, ticket
// 17a5c8f) already derives field-appropriate federal titles, so nothing
// is appended on the frontend any more. `titleChips` is now exactly
// `suggestedTitles`.
//
// DELETED along with the mechanism (not just edited), because each test's
// entire premise no longer holds and nothing else depended on it:
//   - "adds the extra chips automatically... no separate suggestion UI" --
//     there is no longer anything automatic to add.
//   - "does not duplicate an extra chip... case-insensitive" -- the
//     case-insensitive dedupe `mergeTitleChips` did was specific to
//     reconciling the fixed trio against inferred titles; with no trio
//     to reconcile against, there is nothing left for this property to
//     describe. (General duplicate-chip handling for USER-typed custom
//     chips, if any exists, is unrelated and untouched by this removal.)
//   - "stays added regardless of USAJOBS toggle" -- asserted the ABSENCE
//     of toggle-reactive removal logic for a mechanism that no longer
//     exists to NOT react.
//   - "is sent to the API like any other title chip" -- fully redundant
//     with "pre-populates chips..." and "removing a suggested chip..."
//     above, which already prove ordinary suggested/custom chips reach
//     the API correctly; nothing in it was specific to the extras.
//   - "removing an extra chip removes it for good" -- general chip-removal
//     persistence (removing a chip doesn't come back on an unrelated
//     re-render) remains covered by "removing a suggested chip changes
//     what's sent" above, which removes a real suggested chip rather than
//     an extra; that test's own property (removal sticks) is unchanged by
//     this deletion.
//
// KEPT below: "shows the explanatory note near the title chips" -- that
// hint renders unconditionally in SearchCriteriaForm regardless of
// `titleChips` content (see that component's own updated comment) and is
// independent of this removed mechanism, so it still has something real
// to prove.
describe("App — title chips (ticket 8a403ee, extras mechanism removed by ticket 5c4242d)", () => {
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

// Ticket 5c4242d acceptance criteria: title chips must depend on the
// resume's OWN field, not a universal frontend-appended set. The AI side
// (resume-title-inference.ts) is what actually derives field-appropriate
// federal titles -- verified separately via a live eval run (see this
// ticket's own report) -- so these tests exercise the FRONTEND's half of
// the contract: `createResume`/`getResume`'s `suggestedTitles` is the
// resume's OWN field-derived set, exactly, with nothing frontend-added and
// nothing frontend-subtracted, regardless of whether that set happens to
// contain a federal title, a different field's federal title, or none at
// all. A regression back to appending a fixed set (the actual bug this
// ticket fixes) would make every one of these fail.
describe("App — title chips reflect the resume's own field exactly (ticket 5c4242d)", () => {
  it("a resume with no federal-equivalent titles in its own suggestions shows none of the software-federal trio", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      // Shaped after the marketing-manager eval shape -- a field with no
      // public-sector history, which the live eval confirms gets no
      // federal title at all.
      suggestedTitles: ["Senior Marketing Manager", "Brand Manager"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    expect(screen.getByText("Senior Marketing Manager")).toBeInTheDocument();
    expect(screen.getByText("Brand Manager")).toBeInTheDocument();
    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
    expect(screen.queryByText("IT Specialist")).not.toBeInTheDocument();
    expect(screen.queryByText("Computer Scientist")).not.toBeInTheDocument();
  });

  it("a non-software resume whose own field has a real federal equivalent shows THAT equivalent, not the software trio", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      // Shaped after the technical-writer eval shape (Jay's actual
      // reported case, ticket 17a5c8f) -- confirmed live to produce the
      // writing-family federal titles, never the software trio.
      suggestedTitles: ["Senior Technical Writer", "Writer-Editor"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    expect(screen.getByText("Senior Technical Writer")).toBeInTheDocument();
    expect(screen.getByText("Writer-Editor")).toBeInTheDocument();
    expect(screen.queryByText("Program Analyst")).not.toBeInTheDocument();
    expect(screen.queryByText("IT Specialist")).not.toBeInTheDocument();
    expect(screen.queryByText("Computer Scientist")).not.toBeInTheDocument();
  });

  it("a software resume whose own suggestions include a software federal title still shows it -- Nicole's own experience must not regress", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      // Confirmed live (this ticket's own eval run): a full-stack
      // engineer resume's raw model output includes "IT Specialist".
      suggestedTitles: ["Backend Engineer", "Senior Full Stack Engineer", "IT Specialist"],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Senior Full Stack Engineer")).toBeInTheDocument();
    expect(screen.getByText("IT Specialist")).toBeInTheDocument();
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

  it("clicking 'Get estimate' with no location signal scrolls the location section (not some unrelated element) into view, moves focus to the location input, and does NOT call the real estimate", async () => {
    getSources.mockResolvedValue(SOURCES);
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
    });
    getResults.mockResolvedValue(RESULTS);
    getAllResults.mockResolvedValue(RESULTS);

    await submitResume();

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

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

    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));

    await waitFor(() => expect(estimateSearch).toHaveBeenCalledTimes(1));
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });
});
