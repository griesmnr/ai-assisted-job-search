// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetAllResultsResponse, GetResumeResultsResponse, ScoredJobResult } from "@app/shared";
import { GroupedResultsList, groupKeyForStatus } from "./GroupedResultsList";

// See SourceToggles.test.tsx's comment on this same line: this repo's root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// (which needs a GLOBAL `afterEach`) never runs on its own.
afterEach(cleanup);

function job(
  overrides: Partial<ScoredJobResult> & Pick<ScoredJobResult, "jobId">,
): ScoredJobResult {
  return {
    // Ticket 3f0883f: default resume identity for every fixture job --
    // see ScoredJobResult.resumeId's own doc comment. Tests that actually
    // need two different resumes (the cross-resume describe block below)
    // override this explicitly per job.
    resumeId: "resume-1",
    externalId: overrides.jobId,
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
    // Ticket 38a7598 review fix: per-result now, not response-level -- see
    // ScoredJobResult.resumeNickname's doc comment in @app/shared.
    resumeNickname: "Resume 1",
    ...overrides,
  };
}

const DATA: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  results: [
    job({ jobId: "job-1", title: "Senior Backend Engineer" }),
    job({
      jobId: "job-2",
      title: "Platform Engineer",
      levelFit: "overqualified",
      levelFitNote: "This posting is written below your level.",
    }),
  ],
};

// Ticket b182bde: opt-in, default-off client-side filter, same guarantees as
// ResultsList's identical checkbox (see that file's tests) -- exercised here
// too since GroupedResultsList duplicates the filtering logic rather than
// sharing it with ResultsList.
describe('GroupedResultsList — "Hide roles above my level" filter (ticket b182bde)', () => {
  it("defaults unchecked, shows every job, and states the live overqualified count", () => {
    render(
      <GroupedResultsList
        data={DATA}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Hide roles above my level/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hide roles above my level (1)")).toBeInTheDocument();
    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });

  it("checking the box hides only the overqualified job, client-side, and unchecking restores it", () => {
    render(
      <GroupedResultsList
        data={DATA}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));

    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });

  it("shows a level-filter-specific empty state (not the generic source-selection one) when every source-visible job is above level and the checkbox is checked (ticket b182bde review F1b)", () => {
    // Same regression as ResultsList.test.tsx's identical case: with every
    // source-visible job overqualified and the checkbox checked,
    // `visible.length` is 0, but the old code blamed source selection
    // ("No jobs match the current source selection.") when the level
    // filter -- not source selection -- is what hid them.
    const ALL_OVERQUALIFIED: GetResumeResultsResponse = {
      ...DATA,
      results: DATA.results.map((r) => ({ ...r, levelFit: "overqualified" as const })),
    };

    render(
      <GroupedResultsList
        data={ALL_OVERQUALIFIED}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));

    expect(screen.queryByText("Senior Backend Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.',
      ),
    ).toBeInTheDocument();
  });
});

// Ticket 8f5a79c: same guarantees as ResultsList's identical checkbox (see
// that file's tests) -- exercised here too since GroupedResultsList
// duplicates the filtering logic rather than sharing it with ResultsList.
describe('GroupedResultsList — "Hide contract/temp roles" filter (ticket 8f5a79c)', () => {
  const WITH_CONTRACT: GetResumeResultsResponse = {
    resumeId: "resume-1",
    resumeNickname: "Resume 1",
    results: [
      job({ jobId: "job-1", title: "Senior Backend Engineer" }),
      job({
        jobId: "job-2",
        title: "Platform Engineer",
        levelFit: "overqualified",
        levelFitNote: "This posting is written below your level.",
      }),
      job({ jobId: "job-3", title: "Software Engineer (Contract)", isContractOrTemp: true }),
    ],
  };

  it("defaults unchecked, shows every job (including the contract/temp one), and states the live contract/temp count", () => {
    render(
      <GroupedResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hide contract/temp roles (1)")).toBeInTheDocument();
    expect(screen.getByText("Software Engineer (Contract)")).toBeInTheDocument();
  });

  it("checking the box hides only the contract/temp job, client-side, and unchecking restores it", () => {
    render(
      <GroupedResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Software Engineer (Contract)")).toBeInTheDocument();
  });

  it("shows a contract-filter-specific empty state (not the generic source-selection one) when every source-visible job is contract/temp and the checkbox is checked", () => {
    const ALL_CONTRACT: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        job({ jobId: "job-a", title: "Contract Software Engineer", isContractOrTemp: true }),
        job({ jobId: "job-b", title: "Software Engineer, Temp", isContractOrTemp: true }),
      ],
    };

    render(
      <GroupedResultsList
        data={ALL_CONTRACT}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.queryByText("Contract Software Engineer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Every job from the selected sources is contract/temp — uncheck "Hide contract/temp roles" to see them.',
      ),
    ).toBeInTheDocument();
  });

  it("composes correctly with the level filter active simultaneously, without double-counting a job hidden by more than one filter", () => {
    render(
      <GroupedResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 1 of 3 scored jobs from the sources you've selected. (1 above your level hidden.) (1 contract/temp hidden.)",
      ),
    ).toBeInTheDocument();
  });

  it("shows the COMBINED level+contract empty-state message (not either single-filter message, and not the source-selection message) when the only two source-visible jobs are one overqualified-but-not-contract job and one contract-but-not-overqualified job, and BOTH checkboxes are checked (reviewer finding: this message had zero test coverage; ticket b182bde already shipped one empty-state-blames-wrong-filter bug, so this combination is worth covering directly)", () => {
    const ONLY_OVERQUALIFIED_AND_CONTRACT: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        job({
          jobId: "job-2",
          title: "Platform Engineer",
          levelFit: "overqualified",
          levelFitNote: "This posting is written below your level.",
        }),
        job({ jobId: "job-3", title: "Software Engineer (Contract)", isContractOrTemp: true }),
      ],
    };

    render(
      <GroupedResultsList
        data={ONLY_OVERQUALIFIED_AND_CONTRACT}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Every remaining job (after hiding roles above your level) is contract/temp — uncheck "Hide contract/temp roles" to see them.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        'Every job from the selected sources is above your level — uncheck "Hide roles above my level" to see them.',
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
  });

  it("a job that is BOTH overqualified AND contract/temp is claimed by the level filter (which runs first) and is not double-counted in the contract-filter's own clause", () => {
    const DATA_BOTH: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        job({ jobId: "job-1", title: "Senior Backend Engineer" }),
        job({
          jobId: "job-2",
          title: "Software Engineer (Contract)",
          levelFit: "overqualified",
          levelFitNote: "Overqualified for this contract role.",
          isContractOrTemp: true,
        }),
      ],
    };

    render(
      <GroupedResultsList
        data={DATA_BOTH}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 1 of 2 scored jobs from the sources you've selected. (1 above your level hidden.)",
      ),
    ).toBeInTheDocument();
  });
});

// Ticket 1ea4bf3: (1) the quick-links need visible spacing between them
// (cosmetic -- they rendered as one contiguous run of text), and (2) their
// counts/which-groups-get-a-link must be computed LIVE from each result's
// current status, not from the (possibly frozen, per bec2f98) `groupFor`
// prop used for card placement.
describe("GroupedResultsList — quick-jump links (ticket 1ea4bf3)", () => {
  const GROUPED: GetResumeResultsResponse = {
    resumeId: "resume-1",
    resumeNickname: "Resume 1",
    results: [
      job({ jobId: "job-saved", title: "Saved Job", status: "saved" }),
      job({ jobId: "job-dismissed", title: "Dismissed Job", status: "dismissed" }),
    ],
  };

  it("renders the quick-links nav with the spacing class applied", () => {
    render(
      <GroupedResultsList
        data={GROUPED}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    // `.results-group-quicklinks` (index.css) is the rule that gives the
    // anchors a `gap` so they don't render as one contiguous run of text --
    // asserting the class is applied is the class-based check for that CSS
    // fix (jsdom doesn't compute layout, so there's no rendered gap to
    // measure directly).
    expect(screen.getByRole("navigation", { name: "Jump to group" })).toHaveClass(
      "results-group-quicklinks",
    );
  });

  it("quick-link counts update live off current status, even when `groupFor` (card placement) is frozen to a stale snapshot", () => {
    // `groupFor` frozen to whatever each job's group was at DATA's own
    // initial statuses -- this stands in for App.tsx's `scoredGroupFor`
    // once a snapshot has been taken (ticket bec2f98). It never changes for
    // the rest of this test, exactly like the real frozen snapshot doesn't
    // change until the tab is reopened.
    const frozenGroupFor = (r: ScoredJobResult) =>
      r.jobId === "job-saved" ? "saved" : groupKeyForStatus(r.status);

    const { rerender } = render(
      <GroupedResultsList
        data={GROUPED}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={frozenGroupFor}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Saved (1)")).toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();
    // Card still renders under its frozen "Saved" section.
    expect(screen.getByRole("heading", { name: "Saved" }).closest("section")).toContainElement(
      screen.getByText("Saved Job"),
    );

    // job-saved's status flips to "applied" -- `frozenGroupFor` (standing in
    // for the frozen snapshot) still says "saved" for this job, so card
    // placement must not move. But the LIVE quick-link counts must reflect
    // the new status immediately, without any tab close/reopen.
    const afterStatusChange: GetResumeResultsResponse = {
      ...GROUPED,
      results: GROUPED.results.map((r) =>
        r.jobId === "job-saved" ? { ...r, status: "applied" as const } : r,
      ),
    };

    rerender(
      <GroupedResultsList
        data={afterStatusChange}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={frozenGroupFor}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    // Live counts updated: "Saved" lost its one job, "Applied" gained one.
    expect(screen.queryByText("Saved (1)")).not.toBeInTheDocument();
    expect(screen.getByText("Applied (1)")).toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();

    // CRITICAL REGRESSION CHECK: card placement is UNCHANGED -- "Saved Job"
    // still renders under the "Saved" heading (frozen groupFor), not under
    // a newly-created "Applied" section. This is the check that would catch
    // someone "fixing" this ticket by un-freezing `groupFor` entirely
    // instead of adding a separate live computation, which would silently
    // undo ticket bec2f98.
    expect(screen.getByRole("heading", { name: "Saved" }).closest("section")).toContainElement(
      screen.getByText("Saved Job"),
    );
    expect(screen.queryByRole("heading", { name: "Applied" })).not.toBeInTheDocument();
  });

  it("a group gains a live quick-link when it goes from empty to non-empty, and loses it when it goes from non-empty to empty -- under a FROZEN groupFor, so this actually proves liveness rather than just re-deriving from live data", () => {
    // `groupFor` frozen to "saved" for this one job for the whole test,
    // exactly like the test above -- if this used an unfrozen groupFor
    // (`(r) => groupKeyForStatus(r.status)`), it would pass even with the
    // bug this ticket exists to fix (liveBuckets accidentally reading the
    // frozen groupFor instead of live status), since both would agree.
    const frozenGroupFor = () => "saved" as const;

    // Only "saved" is non-empty at first -- no other group (including
    // "dismissed") should have a quick-link yet.
    const ONLY_SAVED: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [job({ jobId: "job-saved", title: "Saved Job", status: "saved" })],
    };

    const { rerender } = render(
      <GroupedResultsList
        data={ONLY_SAVED}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={frozenGroupFor}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Saved (1)")).toBeInTheDocument();
    expect(screen.queryByText("Dismissed (1)")).not.toBeInTheDocument();

    // Status flips to "dismissed": `frozenGroupFor` still says "saved" for
    // card placement, but the LIVE quick-links must react to the new
    // status -- "saved" should lose its link (now empty live), "dismissed"
    // should gain one (now non-empty live) -- both live, despite groupFor
    // never changing.
    const NOW_DISMISSED: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [job({ jobId: "job-saved", title: "A Job Title", status: "dismissed" })],
    };

    rerender(
      <GroupedResultsList
        data={NOW_DISMISSED}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={frozenGroupFor}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.queryByText("Saved (1)")).not.toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();
  });

  it("live quick-link counts respect source toggles -- a job hidden by a deselected source is not counted", () => {
    const TWO_SOURCES: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [
        job({ jobId: "job-a", title: "Job A", status: "saved", dataSource: "usajobs" }),
        job({ jobId: "job-b", title: "Job B", status: "saved", dataSource: "greenhouse" }),
      ],
    };

    render(
      <GroupedResultsList
        data={TWO_SOURCES}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    // Only job-a's source is selected -- the live count must reflect just
    // the source-filtered set, not both jobs. If the live computation read
    // `data.results` directly instead of the already-source-filtered
    // `visible` array, this would incorrectly show "Saved (2)".
    expect(screen.getByText("Saved (1)")).toBeInTheDocument();
    expect(screen.queryByText("Saved (2)")).not.toBeInTheDocument();
  });
});

// Ticket 3f0883f: "Already Scored Jobs" spans every resume now, not just
// the active one -- the SAME jobId can legitimately appear twice, once
// per resume that scored it, with two different match scores and two
// different nicknames. This is the direct proof that GroupedResultsList
// renders both as separate cards rather than one clobbering the other.
describe("GroupedResultsList — the same job scored under two different resumes (ticket 3f0883f)", () => {
  it("renders BOTH cards, correctly labeled by their own resume, when the same jobId appears under two resumeIds", () => {
    const CROSS_RESUME: GetAllResultsResponse = {
      results: [
        job({
          jobId: "shared-job",
          resumeId: "resume-1",
          resumeNickname: "Resume 1",
          title: "Full-Stack Engineer",
          matchScore: 85,
        }),
        job({
          jobId: "shared-job",
          resumeId: "resume-2",
          resumeNickname: "Resume 2",
          title: "Full-Stack Engineer",
          matchScore: 55,
        }),
      ],
    };

    render(
      <GroupedResultsList
        data={CROSS_RESUME}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    // Both scores render, each attributed to the resume that actually
    // produced it -- content correctness, independent of the list-key
    // mechanism itself (verified with a mutation: a colliding bare-`jobId`
    // key does NOT drop a card on first render here, React only warns --
    // the test below is what actually catches that regression).
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    // Both nicknames render -- each card correctly labeled by the
    // resume that actually produced ITS judgment, not both showing the
    // same one.
    expect(screen.getByText(/Resume 1/)).toBeInTheDocument();
    expect(screen.getByText(/Resume 2/)).toBeInTheDocument();
  });

  it("does not throw a React duplicate-key warning for the same jobId under two different resumes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const CROSS_RESUME: GetAllResultsResponse = {
      results: [
        job({ jobId: "shared-job", resumeId: "resume-1", resumeNickname: "Resume 1" }),
        job({ jobId: "shared-job", resumeId: "resume-2", resumeNickname: "Resume 2" }),
      ],
    };

    render(
      <GroupedResultsList
        data={CROSS_RESUME}
        selectedSourceIds={new Set(["usajobs"])}
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    const duplicateKeyWarning = consoleError.mock.calls.some((args) =>
      String(args[0]).includes("same key"),
    );
    expect(duplicateKeyWarning).toBe(false);
    consoleError.mockRestore();
  });
});
