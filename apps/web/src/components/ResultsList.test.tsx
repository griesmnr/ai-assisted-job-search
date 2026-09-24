// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { GetResumeResultsResponse, ScoredJobResult } from "@app/shared";
import { ResultsList } from "./ResultsList";

// See SourceToggles.test.tsx's comment on this same line: this repo's root
// vitest.config.ts doesn't enable `test.globals`, so RTL's auto-cleanup
// (which needs a GLOBAL `afterEach`) never runs on its own.
afterEach(cleanup);

const DATA: GetResumeResultsResponse = {
  resumeId: "resume-1",
  resumeNickname: "Resume 1",
  hiddenBelowFloor: 4,
  results: [
    {
      jobId: "job-1",
      resumeId: "resume-1",
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
      isContractOrTemp: false,
      // Ticket 38a7598 review fix: per-result now, not response-level --
      // see ScoredJobResult.resumeNickname's doc comment in @app/shared.
      resumeNickname: "Resume 1",
    },
    {
      jobId: "job-2",
      resumeId: "resume-1",
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
      isContractOrTemp: false,
      resumeNickname: "Resume 1",
    },
  ],
};

describe("ResultsList", () => {
  it("renders a result set, best match first, with title/employer/source/score and the hidden-below-floor count", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
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

  // Opus review, round 1 (coverage gap B): the truncation paragraph
  // (ticket e9a82f3) had no component test -- the existing fixture simply
  // omits `totalMatchingCount`, so it passed trivially without ever
  // exercising the render branch. Mirrors the hidden-below-floor test
  // above, which is the direct precedent for "a real, scored-but-not-shown
  // count must render as visible text, not go quiet."
  it("shows an honest 'only the top N of M were loaded' notice when the server truncated the results", () => {
    render(
      <ResultsList
        data={{ ...DATA, totalMatchingCount: 650 }}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    expect(
      screen.getByText(/Only the top 2 of 650 matching jobs were loaded\./),
    ).toBeInTheDocument();
  });

  it("does not show a truncation notice when the response has no totalMatchingCount", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    expect(screen.queryByText(/matching jobs were loaded/)).not.toBeInTheDocument();
  });

  it("filters by the selected sources client-side, without dropping results from a source that IS selected", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
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
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
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
describe(`ResultsList — "Hide roles I'm overqualified for" filter (ticket b182bde)`, () => {
  it("defaults unchecked, shows every job (including the one above-level), and states the live overqualified count", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hide roles I'm overqualified for (1)")).toBeInTheDocument();
    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });

  it("checking the box hides only the overqualified job, client-side, and unchecking restores it", () => {
    render(
      <ResultsList
        data={DATA}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    // Never a silent server-side drop -- the summary line still reflects
    // what's actually rendered, AND (fixed, ticket b182bde review F1a)
    // correctly attributes the hide to the level filter, not to source
    // toggles -- the count itself was always honest here, but before the
    // fix this scenario's missing job had NO explanatory clause at all
    // (only the "hidden by source toggles" clause existed, and it hadn't
    // hidden anything).
    expect(
      screen.getByText(
        "Showing 1 of 2 scored jobs from the sources you've selected. (1 hidden as maybe overqualified.)",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));

    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
  });

  it("shows a level-filter-specific empty state (not the generic source-selection one) when every source-visible job is above level and the checkbox is checked (ticket b182bde review F1b)", () => {
    // Regression for the reviewer's false-empty-state finding: if EVERY
    // source-visible job happens to be overqualified and the checkbox is
    // checked, `visible.length` becomes 0. The old code fired "No jobs
    // match the current source selection." here, which is false -- the
    // jobs DO match the source selection; the level filter hid them.
    const ALL_OVERQUALIFIED: GetResumeResultsResponse = {
      ...DATA,
      results: DATA.results.map((r) => ({ ...r, levelFit: "overqualified" as const })),
    };

    render(
      <ResultsList
        data={ALL_OVERQUALIFIED}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));

    expect(screen.queryByText("Senior Backend Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `Every job from the selected sources is one you may be overqualified for — uncheck "Hide roles I'm overqualified for" to see them.`,
      ),
    ).toBeInTheDocument();
  });
});

// Ticket a340074: symmetric filter for the OTHER `levelFit` value, added
// directly on Nicole's request once the overqualified toggle's wording was
// fixed: "why doesn't that also exist." Same DEFAULT-OFF/client-side-only
// pattern as the overqualified filter above.
describe(`ResultsList — "Hide roles I'm underqualified for" filter (ticket a340074)`, () => {
  // Of DATA's two jobs, job-2 is "overqualified", neither is
  // "underqualified" -- a third job is added here so both directions (has
  // the underqualified tag / doesn't) are exercised.
  const UNDERQUALIFIED_JOB: ScoredJobResult = {
    jobId: "job-4",
    resumeId: "resume-1",
    externalId: "ext-4",
    title: "Staff Backend Engineer",
    company: "Databricks",
    dataSource: "greenhouse",
    location: "Seattle, WA",
    locationType: "hybrid",
    applyUrl: "https://example.com/job-4",
    matchScore: 70,
    rationale: "Strong overlap, but this role is a level above what the resume evidences.",
    strengths: [],
    gaps: [],
    status: null,
    levelFit: "underqualified",
    levelFitNote: "This posting is written for a Staff-level candidate.",
    isContractOrTemp: false,
    resumeNickname: "Resume 1",
  };
  const DATA_WITH_UNDERQUALIFIED: GetResumeResultsResponse = {
    ...DATA,
    results: [...DATA.results, UNDERQUALIFIED_JOB],
  };

  it("defaults unchecked, shows every job (including the underqualified one), and states the live underqualified count", () => {
    render(
      <ResultsList
        data={DATA_WITH_UNDERQUALIFIED}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Hide roles I'm underqualified for/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hide roles I'm underqualified for (1)")).toBeInTheDocument();
    expect(screen.getByText("Staff Backend Engineer")).toBeInTheDocument();
  });

  it("checking the box hides only the underqualified job, client-side, and unchecking restores it, independently of the overqualified toggle", () => {
    render(
      <ResultsList
        data={DATA_WITH_UNDERQUALIFIED}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm underqualified for/ }));

    // The overqualified job (Platform Engineer) is untouched -- these two
    // filters are independent, checking one must never affect the other.
    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Staff Backend Engineer")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 2 of 3 scored jobs from the sources you've selected. (1 hidden as maybe underqualified.)",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm underqualified for/ }));

    expect(screen.getByText("Staff Backend Engineer")).toBeInTheDocument();
  });

  it("shows an underqualified-filter-specific empty state when every source-visible job is underqualified and the checkbox is checked", () => {
    const ALL_UNDERQUALIFIED: GetResumeResultsResponse = {
      ...DATA,
      results: DATA.results.map((r) => ({ ...r, levelFit: "underqualified" as const })),
    };

    render(
      <ResultsList
        data={ALL_UNDERQUALIFIED}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm underqualified for/ }));

    expect(screen.queryByText("Senior Backend Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `Every job from the selected sources is one you may be underqualified for — uncheck "Hide roles I'm underqualified for" to see them.`,
      ),
    ).toBeInTheDocument();
  });

  it("composes correctly with the overqualified filter active at the same time, without double-counting a job hidden by either", () => {
    render(
      <ResultsList
        data={DATA_WITH_UNDERQUALIFIED}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm underqualified for/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Staff Backend Engineer")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 1 of 3 scored jobs from the sources you've selected. (1 hidden as maybe overqualified.) (1 hidden as maybe underqualified.)",
      ),
    ).toBeInTheDocument();
  });
});

// Ticket 8f5a79c: opt-in, DEFAULT-OFF client-side filter, same pattern as
// "Hide roles I'm overqualified for" (ticket b182bde) -- contract/temp postings are
// shown by default (Nicole's explicit "just another job to apply for"
// framing), this checkbox is for hiding them, never an opt-in gate.
describe('ResultsList — "Hide contract/temp roles" filter (ticket 8f5a79c)', () => {
  // Of DATA's two jobs, neither is contract/temp -- a third job is added
  // here so both directions (has the tag / doesn't) are exercised, and so
  // this third job can ALSO be marked overqualified in some tests below to
  // exercise the three-filter interaction the ticket's own acceptance
  // criteria calls out.
  const CONTRACT_JOB: ScoredJobResult = {
    jobId: "job-3",
    resumeId: "resume-1",
    externalId: "ext-3",
    title: "Software Engineer (Contract)",
    company: "Acme",
    dataSource: "greenhouse",
    location: "Seattle, WA",
    locationType: "hybrid",
    applyUrl: "https://example.com/job-3",
    matchScore: 85,
    rationale: "Good fit for a contract role.",
    strengths: [],
    gaps: [],
    status: null,
    levelFit: null,
    levelFitNote: null,
    isContractOrTemp: true,
    resumeNickname: "Resume 1",
  };

  const WITH_CONTRACT: GetResumeResultsResponse = {
    ...DATA,
    results: [...DATA.results, CONTRACT_JOB],
  };

  it("defaults unchecked, shows every job (including the contract/temp one), and states the live contract/temp count", () => {
    render(
      <ResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Hide contract/temp roles (1)")).toBeInTheDocument();
    expect(screen.getByText("Software Engineer (Contract)")).toBeInTheDocument();
  });

  it("checking the box hides only the contract/temp job, client-side, and unchecking restores it", () => {
    render(
      <ResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.getByText("Platform Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 2 of 3 scored jobs from the sources you've selected. (1 contract/temp hidden.)",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Software Engineer (Contract)")).toBeInTheDocument();
  });

  it("shows a contract-filter-specific empty state (not the generic source-selection one) when every source-visible job is contract/temp and the checkbox is checked", () => {
    const ALL_CONTRACT: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [CONTRACT_JOB, { ...CONTRACT_JOB, jobId: "job-4", externalId: "ext-4" }],
    };

    render(
      <ResultsList
        data={ALL_CONTRACT}
        selectedSourceIds={new Set(["greenhouse"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'Every job from the selected sources is contract/temp — uncheck "Hide contract/temp roles" to see them.',
      ),
    ).toBeInTheDocument();
  });

  it("composes correctly with source toggles AND the level filter all active simultaneously, without double-counting a job hidden by more than one filter", () => {
    // job-2 (Platform Engineer) is overqualified; the contract job is
    // separately contract/temp -- both hide-toggles checked at once must
    // list BOTH clauses, with counts that sum exactly to what's actually
    // hidden (no double count, no contradiction).
    render(
      <ResultsList
        data={WITH_CONTRACT}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 1 of 3 scored jobs from the sources you've selected. (1 hidden as maybe overqualified.) (1 contract/temp hidden.)",
      ),
    ).toBeInTheDocument();
  });

  it("shows the COMBINED level+contract empty-state message (not either single-filter message, and not the source-selection message) when the only two source-visible jobs are one overqualified-but-not-contract job and one contract-but-not-overqualified job, and BOTH checkboxes are checked (reviewer finding: this message had zero test coverage; ticket b182bde already shipped one empty-state-blames-wrong-filter bug, so this combination is worth covering directly)", () => {
    const ONLY_OVERQUALIFIED_AND_CONTRACT: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [DATA.results[1]!, CONTRACT_JOB],
    };

    render(
      <ResultsList
        data={ONLY_OVERQUALIFIED_AND_CONTRACT}
        selectedSourceIds={new Set(["greenhouse", "usajobs"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    expect(screen.queryByText("Platform Engineer")).not.toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        `Every remaining job (after hiding roles you may be overqualified for) is contract/temp — uncheck "Hide contract/temp roles" to see them.`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        `Every job from the selected sources is one you may be overqualified for — uncheck "Hide roles I'm overqualified for" to see them.`,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No jobs match the current source selection."),
    ).not.toBeInTheDocument();
  });

  it("a job that is BOTH overqualified AND contract/temp is claimed by the level filter (which runs first) and is not double-counted in the contract-filter's own clause -- this is the edge case that would silently mis-add if the two counts weren't telescoped off each other", () => {
    const OVERQUALIFIED_AND_CONTRACT = {
      ...CONTRACT_JOB,
      levelFit: "overqualified" as const,
      levelFitNote: "Overqualified for this contract role.",
    };
    const DATA_BOTH: GetResumeResultsResponse = {
      resumeId: "resume-1",
      resumeNickname: "Resume 1",
      results: [DATA.results[0]!, OVERQUALIFIED_AND_CONTRACT],
    };

    render(
      <ResultsList
        data={DATA_BOTH}
        selectedSourceIds={new Set(["greenhouse"])}
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
        onViewResume={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Hide roles I'm overqualified for/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Hide contract\/temp roles/ }));

    // The one overqualified+contract job is hidden by the level filter
    // (which runs first) -- the contract filter's own marginal removal is
    // 0, so its clause must NOT also appear (that would double-count the
    // same job as if two jobs were hidden when only one was).
    expect(screen.getByText("Senior Backend Engineer")).toBeInTheDocument();
    expect(screen.queryByText("Software Engineer (Contract)")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Showing 1 of 2 scored jobs from the sources you've selected. (1 hidden as maybe overqualified.)",
      ),
    ).toBeInTheDocument();
  });
});
