// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GetResumeResultsResponse, ScoredJobResult } from "@app/shared";
import { GroupedResultsList, groupKeyForStatus } from "./GroupedResultsList";

// See SourceToggles.test.tsx's comment on this same line: this repo's root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// (which needs a GLOBAL `afterEach`) never runs on its own.
afterEach(cleanup);

function job(
  overrides: Partial<ScoredJobResult> & Pick<ScoredJobResult, "jobId">,
): ScoredJobResult {
  return {
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
    ...overrides,
  };
}

const DATA: GetResumeResultsResponse = {
  resumeId: "resume-1",
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
        resumeId="resume-1"
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
        resumeId="resume-1"
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
        resumeId="resume-1"
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

// Ticket 1ea4bf3: (1) the quick-links need visible spacing between them
// (cosmetic -- they rendered as one contiguous run of text), and (2) their
// counts/which-groups-get-a-link must be computed LIVE from each result's
// current status, not from the (possibly frozen, per bec2f98) `groupFor`
// prop used for card placement.
describe("GroupedResultsList — quick-jump links (ticket 1ea4bf3)", () => {
  const GROUPED: GetResumeResultsResponse = {
    resumeId: "resume-1",
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
        resumeId="resume-1"
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
        resumeId="resume-1"
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
        resumeId="resume-1"
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

  it("a group gains a live quick-link when it goes from empty to non-empty, and loses it when it goes from non-empty to empty", () => {
    // Only "saved" is non-empty at first -- no other group (including
    // "dismissed") should have a quick-link yet.
    const ONLY_SAVED: GetResumeResultsResponse = {
      resumeId: "resume-1",
      results: [job({ jobId: "job-saved", title: "Saved Job", status: "saved" })],
    };

    const { rerender } = render(
      <GroupedResultsList
        data={ONLY_SAVED}
        selectedSourceIds={new Set(["usajobs"])}
        resumeId="resume-1"
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Saved (1)")).toBeInTheDocument();
    expect(screen.queryByText("Dismissed (1)")).not.toBeInTheDocument();

    // Status flips to "dismissed": "saved" should lose its link (now
    // empty), "dismissed" should gain one (now non-empty) -- both live.
    // Card title text is unrelated to the job's title -- use a distinct
    // title here so it can't be confused with the "Saved (1)"/"Dismissed
    // (1)" quick-link text below.
    const NOW_DISMISSED: GetResumeResultsResponse = {
      resumeId: "resume-1",
      results: [job({ jobId: "job-saved", title: "A Job Title", status: "dismissed" })],
    };

    rerender(
      <GroupedResultsList
        data={NOW_DISMISSED}
        selectedSourceIds={new Set(["usajobs"])}
        resumeId="resume-1"
        groupFor={(r) => groupKeyForStatus(r.status)}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.queryByText("Saved (1)")).not.toBeInTheDocument();
    expect(screen.getByText("Dismissed (1)")).toBeInTheDocument();
  });
});
