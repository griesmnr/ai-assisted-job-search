// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GetResumeResultsResponse } from "@app/shared";
import { ResultsList } from "./ResultsList";

// See SourceToggles.test.tsx's comment on this same line: this repo's root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// (which needs a GLOBAL `afterEach`) never runs on its own.
afterEach(cleanup);

const DATA: GetResumeResultsResponse = {
  resumeId: "resume-1",
  hiddenBelowFloor: 4,
  results: [
    {
      jobId: "job-1",
      externalId: "ext-1",
      title: "Senior Backend Engineer",
      company: "Samsara",
      dataSource: "greenhouse",
      location: "Seattle, WA",
      locationType: "hybrid",
      applyUrl: "https://example.com/job-1",
      matchScore: 91,
      rationale: "Strong TypeScript + Postgres overlap.",
      strengths: ["TypeScript", "Postgres"],
      gaps: ["Kafka"],
      status: null,
      levelFit: null,
      levelFitNote: null,
    },
    {
      jobId: "job-2",
      externalId: "ext-2",
      title: "Platform Engineer",
      company: "Stripe",
      dataSource: "usajobs",
      location: null,
      locationType: "remote",
      applyUrl: "https://example.com/job-2",
      matchScore: 78,
      rationale: "Good infra overlap.",
      strengths: [],
      gaps: [],
      status: "saved",
      levelFit: "overqualified",
      levelFitNote: "This posting is written below your level, which may hurt at screening.",
    },
  ],
};

describe("ResultsList", () => {
  it("renders a result set, best match first, with title/employer/source/score and the hidden-below-floor count", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.getByText("91%")).toBeInTheDocument();
    expect(screen.getByText("78%")).toBeInTheDocument();
    expect(screen.getByText(/Samsara/)).toBeInTheDocument();
    expect(screen.getByText(/greenhouse/)).toBeInTheDocument();

    // The curated-list decision (git-bug 484889d): a short list must state
    // how many real, scored jobs are hidden below the floor, never just go
    // quiet about them.
    expect(
      screen.getByText(/4 more jobs scored below the match-quality floor/),
    ).toBeInTheDocument();
  });

  it("filters by the selected sources client-side, without dropping results from a source that IS selected", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse"])}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.getByText(/1 hidden by source toggles/)).toBeInTheDocument();
  });

  it("shows an honest empty state when no selected source has any results, not a blank screen", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set()}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("No jobs match the current source selection.")).toBeInTheDocument();
  });
});

// Ticket b182bde: opt-in, default-off client-side filter. Of DATA's two
// jobs, only "Platform Engineer" (job-2) is levelFit "overqualified" —
// "Senior Backend Engineer" (job-1) has levelFit null (an unjudged row),
// which must behave like "not overqualified", never get swept into the
// hidden set alongside a real overqualified job.
describe('ResultsList — "Hide roles above my level" filter (ticket b182bde)', () => {
  it("defaults unchecked, shows every job (including the one above-level), and states the live overqualified count", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        resumeId="resume-1"
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
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    // Never a silent server-side drop -- the summary line still reflects
    // what's actually rendered.
    expect(
      screen.getByText("Showing 1 of 2 scored jobs from the sources you've selected."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles above my level/ }));

    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });
});
