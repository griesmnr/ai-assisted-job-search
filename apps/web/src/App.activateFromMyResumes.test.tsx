// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  EstimateSearchResponse,
  GetResumeResultsResponse,
  GetSourcesResponse,
  ListResumesResponse,
} from "@app/shared";
import App from "./App";

/**
 * Ticket 11ead86 ("Add an activate action to My Resumes"). App-level
 * integration coverage for the two dead ends the ticket's body names, plus
 * its one explicit acceptance-criterion guard -- component-level coverage
 * of the control itself (button vs. "Active" marker, disabled states,
 * error rendering) lives in MyResumes.test.tsx. This file exists to prove
 * the WIRING: that App.tsx's existing `handleActivateResume` (ticket
 * 88f11d7) really is reachable from the "My Resumes" tab and really does
 * leave the user able to act on the resume they picked, for both of the
 * concrete dead ends the ticket names:
 *
 *  1. An active-but-UNLOCKED resume (pasted, never searched): the
 *     collapsed bar on the search tab shows "Edit", which reopens the
 *     paste form -- not the picker -- so there was no path to a
 *     DIFFERENT saved resume without submitting something first.
 *  2. A stale restored `resumeId`: the mount-only hydration effect
 *     (App.tsx) swallows a failed `GET /resumes/:id` and leaves
 *     `resumeId` set, naming a row the server no longer has.
 *
 * Plus the one acceptance criterion that is a real GUARD, not just a
 * wiring check: "Change"'s own `searching` gate must also cover this new
 * entry point, since (unlike the no-active-resume picker in
 * ResumeInput.tsx, which is provably unreachable mid-search) "My Resumes"
 * is a whole separate, always-mounted tab and stays reachable throughout a
 * running search.
 */
const getSources = vi.fn();
const createResume = vi.fn();
const getResume = vi.fn();
const listResumes = vi.fn();
const getResults = vi.fn();
const getAllResults = vi.fn();
const estimateSearch = vi.fn();
const startSearch = vi.fn();
const getSearchStatus = vi.fn();
// Ticket 11ead86 (review fix F1 regression tests): controllable, unlike
// the earlier bare `vi.fn()` inline in the mock factory below -- these
// two are read by `handleNicknameCommit`/`saveResumeText` (App.tsx) on
// the exact two paths F1's repro walks (rename a just-activated resume;
// edit its text and submit), so the F1 regression tests need to assert
// against them directly.
const updateResumeNickname = vi.fn();
const updateResumeText = vi.fn();

vi.mock("./api/client", () => ({
  getSources: (...args: unknown[]) => getSources(...args),
  createResume: (...args: unknown[]) => createResume(...args),
  getResume: (...args: unknown[]) => getResume(...args),
  listResumes: (...args: unknown[]) => listResumes(...args),
  getResults: (...args: unknown[]) => getResults(...args),
  getAllResults: (...args: unknown[]) => getAllResults(...args),
  setJobStatus: vi.fn(),
  updateResumeNickname: (...args: unknown[]) => updateResumeNickname(...args),
  updateResumeText: (...args: unknown[]) => updateResumeText(...args),
  estimateSearch: (...args: unknown[]) => estimateSearch(...args),
  getEstimateProgress: () => Promise.reject(new Error("no progress tracked in this test")),
  startSearch: (...args: unknown[]) => startSearch(...args),
  getSearchStatus: (...args: unknown[]) => getSearchStatus(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionStorage.clear();
});

const SOURCES: GetSourcesResponse = {
  sources: [{ id: "usajobs", displayName: "USAJOBS", configured: true }],
};

function emptyResultsFor(resumeId: string, nickname: string): GetResumeResultsResponse {
  return { resumeId, resumeNickname: nickname, results: [] };
}

async function submitResume(text = "some resume text") {
  fireEvent.change(screen.getByLabelText("Paste your resume"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
}

function goToMyResumesTab() {
  fireEvent.click(screen.getByRole("button", { name: /^My Resumes/ }));
}

/** Same shape as SearchFlow.test.tsx's own `deferred` helper -- a promise
 * this test controls the resolution timing of, so "the request is still
 * in flight" is a real, held-open state to navigate around, not just
 * something inferred from timing. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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
    alreadyScored: 0,
    sourceOutcomes: [],
    skippedSources: [],
  };
}

describe("App — activating a resume from 'My Resumes' (ticket 11ead86)", () => {
  // Dead end 1: an active-but-UNLOCKED resume. "Edit" on the search tab
  // reopens the paste form, never the picker (ResumeInput.tsx's picker
  // branch requires `changingResume`, only reachable from "Change", which
  // only exists once `isLocked`). Before this ticket there was NO path
  // from here to a different saved resume short of submitting new text.
  it("switches to a different saved resume from My Resumes while the active one is still unlocked, and lands back on New Job Search able to act", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false, // UNLOCKED -- the dead end this ticket exists for
    });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-2"
          ? emptyResultsFor("resume-2", "Resume 2")
          : emptyResultsFor("resume-1", "Resume 1"),
      ),
    );

    render(<App />);
    await submitResume();

    // Confirm the dead end actually exists in this state: "Edit", not
    // "Change" -- no picker reachable from the search tab at all.
    expect(await screen.findByRole("button", { name: "Edit resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change resume" })).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();
    expect(screen.getByRole("heading", { name: /My Resumes/ })).toBeInTheDocument();

    getResume.mockResolvedValue({
      id: "resume-2",
      resumeText: "resume 2's own full text",
      resumeNickname: "Resume 2",
      isLocked: false,
      suggestedTitles: ["Data Analyst"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    // Acceptance criterion: lands back on "New Job Search" on success.
    // Resume 2 is unlocked, so that tab now shows the COLLAPSED bar
    // ("Using Resume 2"), not the paste form -- the same render ticket
    // 88f11d7's own "Use Resume 8" test (App.resumeLock.test.tsx) checks
    // for after an activation, not the "Paste your resume" label.
    //
    // Review fix (Required 3): `toBeVisible()`, not `toBeInTheDocument()`.
    // Tabs stay mounted with only `hidden` (ticket f4a7f07) -- ResumeInput
    // keeps rendering "Using Resume 2" even while its tab is the HIDDEN
    // one, so a plain `getByText` here is satisfied whether or not the
    // tab actually switched. `toBeVisible()` additionally walks ancestors
    // for `hidden`/`display:none`/`visibility:hidden`, which is the
    // property this assertion actually means to pin.
    await waitFor(() => {
      expect(screen.getByText("Using Resume 2")).toBeVisible();
    });
    // And the tab really did switch -- "My Resumes" heading is no longer
    // VISIBLE (its section is now the hidden one), proving this isn't
    // just the picker's old "Using Resume 2" bar rendering underneath an
    // unmoved tab.
    //
    // Review fix (Required 3): `getByRole(..., { hidden: true })` +
    // `not.toBeVisible()`, not `queryByRole(...).not.toBeInTheDocument()`.
    // `byRole` excludes inaccessible (hidden) elements by DEFAULT, so the
    // old assertion passed by never finding the heading at all -- true,
    // but for a reason the assertion's own wording didn't say: the
    // heading never left the DOM, only its tab's `hidden` wrapper made it
    // inaccessible. `hidden: true` opts back into finding it regardless,
    // so this now asserts the actual claim ("not visible"), not an
    // accident of the query's default filtering.
    expect(screen.getByRole("heading", { name: /My Resumes/, hidden: true })).not.toBeVisible();
    expect(getResume).toHaveBeenCalledWith("resume-2");
    // A pure pick, never a paste -- the original createResume call is the
    // only one for the whole test.
    expect(createResume).toHaveBeenCalledTimes(1);

    // Ticket 5c4242d, added by PM review of that ticket: the activated
    // resume's chips are EXACTLY the server's `suggestedTitles`, with none
    // of the software-federal trio bolted on.
    //
    // This assertion exists because the trio could be re-added at THIS call
    // site and no test would have noticed. 5c4242d deleted
    // `EXTRA_TITLE_CHIPS`/`mergeTitleChips` from both `setTitleChips` sites
    // in App.tsx, but only the submit-path deletion was mutation-covered:
    // re-introducing `[...suggestedTitles, "Program Analyst", "IT
    // Specialist", "Computer Scientist"]` at the ACTIVATION site (App.tsx's
    // `setTitleChips(data.suggestedTitles ?? [])`) left the full suite green
    // at 1844/1844. Verified by running exactly that mutation.
    //
    // That is the gap worth closing rather than any other, because this is
    // the path Nicole uses to switch resumes (tickets 11ead86 / 582ee40),
    // and a silent reappearance here is precisely the bug John reported --
    // every resume getting the same three government chips regardless of
    // field.
    expect(screen.getByRole("button", { name: 'Remove "Data Analyst"' })).toBeInTheDocument();
    for (const notMine of ["Program Analyst", "IT Specialist", "Computer Scientist"]) {
      expect(screen.queryByRole("button", { name: `Remove "${notMine}"` })).toBeNull();
    }
  });

  // Dead end 2: a stale restored resumeId. The mount-only hydration effect
  // swallows a failed GET /resumes/:id (App.tsx's own documented,
  // deliberately-out-of-scope gap) and leaves `resumeId` set, naming a row
  // the server no longer has. This ticket doesn't fix THAT swallow -- it
  // only has to prove the user is no longer stuck once it happens.
  it("recovers from a stale restored resumeId by activating a real resume from My Resumes", async () => {
    sessionStorage.setItem(
      "jobsearch.web.appState.v5",
      JSON.stringify({
        resumeId: "resume-gone",
        resumeText: "text the server no longer has",
        resumeNickname: "Resume 1",
        selectedSourceIds: ["usajobs"],
        titleChips: [],
        criteriaForm: {
          nearLocations: "",
          expandMetroAreas: false,
          remoteOk: false,
          anyLocationOk: false,
          commitmentIn: [],
        },
        scoreFloor: 50,
      }),
    );
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-2"
          ? emptyResultsFor("resume-2", "Resume 2")
          : emptyResultsFor("resume-gone", "Resume 1"),
      ),
    );
    // The stale id 404s (hydration's own `getResume`, swallowed by
    // App.tsx); the real saved resume resolves normally.
    getResume.mockImplementation((id: string) => {
      if (id === "resume-gone") return Promise.reject(new Error("Not found"));
      return Promise.resolve({
        id: "resume-2",
        resumeText: "resume 2's own full text",
        resumeNickname: "Resume 2",
        isLocked: false,
        suggestedTitles: [],
      });
    });

    render(<App />);

    // The restored (stale) state renders first, "stuck" exactly as the
    // ticket describes: a resume is "active" that the server can't find,
    // and "Edit" is the only button (never "Change", since the swallowed
    // hydration failure also never sets `resumeLocked`).
    expect(await screen.findByText("Using Resume 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit resume" })).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    // Review fix (Required 3): `toBeVisible()`, same reasoning as the
    // other test's identical pair above -- `getByText` alone would be
    // satisfied by the collapsed bar sitting under a HIDDEN search tab,
    // which is exactly what an undetected tab-switch regression would
    // leave in place.
    await waitFor(() => {
      expect(screen.getByText("Using Resume 2")).toBeVisible();
    });
    // Left as `not.toBeInTheDocument()`, deliberately NOT `toBeVisible()`:
    // this is checking genuine ABSENCE (the nickname display changed from
    // "Resume 1" to "Resume 2" outright, the same ResumeInput instance
    // under the same, now-visible tab), not merely invisibility -- a
    // stronger claim that visibility alone can't express, and
    // `toBeVisible()` throws outright on a `null` (not-found) element,
    // so it's also the wrong matcher mechanically for an expected miss.
    expect(screen.queryByText("Using Resume 1")).not.toBeInTheDocument();
  });
});

describe("App — My Resumes activate action respects the searching guard (ticket 11ead86)", () => {
  // Acceptance criterion: "unlike e2b5f9c's block, this IS reachable
  // mid-search (resumeId is defined), so changing resumes under a running
  // search must be prevented or clearly refused." Mirrors
  // App.resumeLock.test.tsx's own "Change unavailable during an active
  // search" coverage, applied to this new entry point.
  it("disables 'Use {nickname}' on My Resumes while a real search is running", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue(emptyResultsFor("resume-1", "Resume 1"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    estimateSearch.mockResolvedValue(makeEstimate());
    startSearch.mockResolvedValue({ searchId: "search-1", status: "pending", skippedSources: [] });
    getSearchStatus.mockResolvedValue({
      status: "pending",
      scoredSoFar: 0,
      linked: 1,
      sources: [],
      stalledSince: undefined,
    });

    render(<App />);
    await submitResume();
    await screen.findByRole("button", { name: "Change resume" });

    fireEvent.click(screen.getByLabelText(/Any location/));
    fireEvent.click(screen.getByRole("button", { name: "Get estimate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Run search" }));

    await act(async () => {
      await vi.waitFor(() => expect(getSearchStatus).toHaveBeenCalled(), { timeout: 3000 });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    const useButton = screen.getByRole("button", { name: "Use Resume 2" });
    expect(useButton).toBeDisabled();
    // Scoped to the "My Resumes" section -- the search tab's own,
    // identically-worded note (ticket 88f11d7) is ALSO mounted right now
    // (tabs stay mounted, only `hidden`), so an unscoped match is
    // ambiguous. Both reusing the same sentence is deliberate, not a bug
    // -- see MyResumes.tsx's own comment.
    expect(
      within(screen.getByRole("heading", { name: /My Resumes/ }).closest("section")!).getByText(
        "Can't change resumes while a search is running.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(useButton);
    expect(getResume).not.toHaveBeenCalled();
  });
});

/**
 * Review fix (F2, ticket 11ead86). `handleActivateResume`'s tab switch
 * used to fire unconditionally on success, on the claim that it was "a
 * no-op when this fires from the search tab's own picker, already on
 * that tab." That claim only holds if the tab hasn't changed since the
 * click -- the `await` on `getResume` gives the user a real window to
 * navigate elsewhere before it resolves, and an unconditional switch back
 * to "New Job Search" would yank them away from wherever they went.
 */
describe("App — My Resumes activate action does not yank the user back mid-navigation (review fix F2, ticket 11ead86)", () => {
  it("does not switch back to New Job Search if the user already moved to a different tab while the activation was in flight", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-2"
          ? emptyResultsFor("resume-2", "Resume 2")
          : emptyResultsFor("resume-1", "Resume 1"),
      ),
    );
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });
    const { promise, resolve } = deferred<{
      id: string;
      resumeText: string;
      resumeNickname: string;
      isLocked: boolean;
      suggestedTitles: string[];
    }>();
    getResume.mockReturnValue(promise);

    render(<App />);
    await submitResume();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    // Click "Use Resume 2" -- the GET is now in flight, held open by the
    // deferred promise above.
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));

    // Navigate away from BOTH the tab the click happened on (My Resumes)
    // and the tab the old, unconditional version would have forced --
    // "Already Scored Jobs" is neither.
    fireEvent.click(screen.getByRole("button", { name: /Already Scored Jobs/ }));
    expect(screen.getByRole("heading", { name: /Already Scored Jobs/ })).toBeVisible();

    // The slow activation now lands.
    await act(async () => {
      resolve({
        id: "resume-2",
        resumeText: "resume 2's own full text",
        resumeNickname: "Resume 2",
        isLocked: false,
        suggestedTitles: [],
      });
      await promise;
    });

    // Must still be on "Already Scored Jobs" -- not yanked back to "New
    // Job Search" out from under the navigation that happened while this
    // was in flight. The activation itself still landed (resumeId really
    // did change, proven by the collapsed bar's own text once it's found
    // regardless of visibility); only the forced tab switch is what had
    // to stop, proven by that same text staying NOT visible.
    expect(screen.getByRole("heading", { name: /Already Scored Jobs/ })).toBeVisible();
    expect(screen.getByText("Using Resume 2")).not.toBeVisible();
    expect(getResume).toHaveBeenCalledWith("resume-2");
  });
});

/**
 * Adversarial review fix (F1, ticket 11ead86, blocker). The exact repro:
 * locked resume -> "Change" -> "Paste a new resume" (sets `pastingNewResume`
 * true) -> think better of it and switch to "My Resumes" INSTEAD OF
 * clicking Cancel (which would have reset the flag) -> "Use Resume 8" ->
 * "Edit" -> act on the now-active Resume 8.
 *
 * Before the fix, `pastingNewResume` survived the activation untouched, so
 * every subsequent action on Resume 8 was still routed as though the form
 * were composing a brand-new resume that doesn't exist yet:
 *   - a rename was silently swallowed by `handleNicknameCommit`'s
 *     `if (pastingNewResume) return;`, with no error and the typed name
 *     still sitting in the field, looking saved.
 *   - a text edit went through `createResume` instead of `updateResumeText`
 *     -- ticket 6ba221e's own user report ("I make an edit and I hit save
 *     and it's still called resume one, it actually becomes resume 2")
 *     restored through a door that fix never anticipated.
 */
describe("App — activating from My Resumes after an abandoned 'Paste a new resume' (review fix F1, ticket 11ead86, blocker)", () => {
  async function getToUnlockedActivatedResumeViaAbandonedPasteNew() {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockImplementation((id: string) =>
      Promise.resolve(
        id === "resume-8"
          ? emptyResultsFor("resume-8", "Resume 8")
          : emptyResultsFor("resume-1", "Resume 1"),
      ),
    );
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true, // locked -- "Change" is the only way back in
    });
    getResume.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's own original text",
      resumeNickname: "Resume 8",
      isLocked: false, // unlocked once activated -- "Edit" reopens directly
      suggestedTitles: [],
    });

    render(<App />);
    await submitResume();

    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste a new resume" }));
    // `pastingNewResume` is now true -- confirmed by the ordinary paste
    // form being open, exactly the state the repro requires.
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();

    // Think better of it -- navigate to "My Resumes" INSTEAD OF Cancel,
    // which is the one click that would have reset the flag.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));
    await waitFor(() => expect(screen.getByText("Using Resume 8")).toBeVisible());

    // Resume 8 is unlocked -- "Edit" reopens the ordinary form directly
    // (never the picker), which is dead end 1 this whole ticket exists
    // for, now navigated past.
    fireEvent.click(screen.getByRole("button", { name: "Edit resume" }));
    expect(screen.getByLabelText("Paste your resume")).toBeInTheDocument();
  }

  it("lets a rename on the activated resume actually save, instead of being silently swallowed", async () => {
    await getToUnlockedActivatedResumeViaAbandonedPasteNew();
    updateResumeNickname.mockResolvedValue({ id: "resume-8", resumeNickname: "Backend resume" });

    const nicknameField = screen.getByLabelText("Resume Nickname");
    fireEvent.change(nicknameField, { target: { value: "Backend resume" } });
    fireEvent.blur(nicknameField);

    // Without the fix, `handleNicknameCommit` returns early on
    // `pastingNewResume` and this call never happens at all -- the field
    // would still show "Backend resume" (nothing reverts it), looking
    // saved while the server was never asked.
    await waitFor(() =>
      expect(updateResumeNickname).toHaveBeenCalledWith("resume-8", "Backend resume"),
    );
  });

  it("routes a text edit on the activated resume through updateResumeText, not a surprise second createResume", async () => {
    await getToUnlockedActivatedResumeViaAbandonedPasteNew();
    updateResumeText.mockResolvedValue({
      id: "resume-8",
      resumeText: "resume 8's edited text",
      resumeNickname: "Resume 8",
      suggestedTitles: [],
      isLocked: false,
    });

    fireEvent.change(screen.getByLabelText("Paste your resume"), {
      target: { value: "resume 8's edited text" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      expect(updateResumeText).toHaveBeenCalledWith("resume-8", "resume 8's edited text"),
    );
    // THE PART THAT MATTERS: only the ORIGINAL resume-1 submission ever
    // called `createResume` -- without the fix, this edit would ALSO
    // call it, minting a surprise new resume out of what the user did as
    // an ordinary edit (ticket 6ba221e's own report, restored).
    expect(createResume).toHaveBeenCalledTimes(1);
  });
});

/**
 * Review fix (F3, ticket 11ead86). `resumeActivateError` is one shared
 * piece of state, now rendered by TWO surfaces (the search tab's "Change"
 * picker, and My Resumes) that previously each had their own idea of when
 * to clear it. A failure from one surface used to plant a `role="alert"`
 * that the OTHER surface had no way to dismiss, and that outlived
 * whatever produced it for the rest of the session.
 */
describe("App — My Resumes activate error does not leak across tabs (review fix F3, ticket 11ead86)", () => {
  it("does not carry a search-tab picker's activation error onto My Resumes", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-8", resumeNickname: "Resume 8", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue(emptyResultsFor("resume-1", "Resume 1"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: true,
    });
    getResume.mockRejectedValue(new Error("Could not reach the API"));

    render(<App />);
    await submitResume();
    fireEvent.click(await screen.findByRole("button", { name: "Change resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Resume 8" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load that resume: Could not reach the API",
    );

    goToMyResumesTab();

    // The error belonged to the picker, which this tab change just left --
    // it must not still be sitting above the My Resumes list.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a My Resumes activation error once the user navigates to a different tab", async () => {
    getSources.mockResolvedValue(SOURCES);
    listResumes.mockResolvedValue({
      resumes: [
        { id: "resume-1", resumeNickname: "Resume 1", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "resume-2", resumeNickname: "Resume 2", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } satisfies ListResumesResponse);
    getAllResults.mockResolvedValue({ results: [] });
    getResults.mockResolvedValue(emptyResultsFor("resume-1", "Resume 1"));
    createResume.mockResolvedValue({
      id: "resume-1",
      resumeNickname: "Resume 1",
      suggestedTitles: [],
      isLocked: false,
    });
    getResume.mockRejectedValue(new Error("Could not reach the API"));

    render(<App />);
    await submitResume();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /My Resumes/ })).toBeInTheDocument(),
    );
    goToMyResumesTab();

    fireEvent.click(screen.getByRole("button", { name: "Use Resume 2" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load that resume: Could not reach the API",
    );

    // Navigate away, then back -- My Resumes has no Cancel-equivalent to
    // dismiss this with (see App.tsx's own comment on the clearing
    // effect), so a tab change is the only thing that should drop it.
    fireEvent.click(screen.getByRole("button", { name: /Already Scored Jobs/ }));
    goToMyResumesTab();

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
