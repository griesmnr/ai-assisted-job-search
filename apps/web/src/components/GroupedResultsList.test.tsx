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
