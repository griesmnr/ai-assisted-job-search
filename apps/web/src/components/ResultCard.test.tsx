// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoredJobResult } from "@app/shared";
import { ResultCard } from "./ResultCard";

const createHandoff = vi.fn();

// Ticket dbfd594: "Optimize Resume" now mints a real server-side handoff
// before navigating anywhere -- mocked here the same way App-level tests
// mock ./api/client, so this component-level test never makes a real
// network call.
vi.mock("../api/client", () => ({
  createHandoff: (...args: unknown[]) => createHandoff(...args),
  handoffFetchUrl: (id: string) => `https://api.example.com/handoffs/${id}`,
  RESUME_OPTIMIZER_APP_URL: "https://optimizer.example.com/",
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeResult(overrides: Partial<ScoredJobResult> = {}): ScoredJobResult {
  return {
    jobId: "job-1",
    externalId: "ext-1",
    title: "Backend Engineer",
    company: "Acme",
    dataSource: "greenhouse",
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
    ...overrides,
  };
}

// Ticket bed37bd: buttons are present-tense ACTIONS ("Save"), the state
// pill (once a status is set) stays past-tense/state form ("Saved") --
// two different labels for the same status, deliberately.
describe("ResultCard — present-tense action buttons vs. state pill (ticket bed37bd)", () => {
  it("shows all four actions as present-tense verbs, regardless of current status -- Open Job Page as a separate link (dogfooding revert of 3d80a85), the rest as buttons", () => {
    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Job Page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    // Old past-tense button wording must be gone.
    expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Applied" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismissed" })).not.toBeInTheDocument();
  });

  it("shows the state pill in past-tense/state form once a status is set, alongside unchanged present-tense actions", () => {
    render(
      <ResultCard
        result={makeResult({ status: "applied" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    // The pill: state form.
    expect(screen.getByText("Applied")).toBeInTheDocument();
    // The action: still present-tense, unaffected by the current status
    // (Nicole: "there should be no reason why there is not an option to
    // do anything you want").
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });

  it("calls onSetStatus with the right status when a present-tense action button is clicked", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSetStatus).toHaveBeenCalledWith("job-1", "saved");
  });

  it("Optimize Resume mints a handoff, opens the optimizer app with it, and records resume_optimized (ticket dbfd594)", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    createHandoff.mockResolvedValue({ id: "handoff-1", expiresAt: new Date().toISOString() });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    await waitFor(() => expect(createHandoff).toHaveBeenCalledWith("job-1", "resume-1"));
    expect(openSpy).toHaveBeenCalledWith(
      "https://optimizer.example.com/?import=" +
        encodeURIComponent("https://api.example.com/handoffs/handoff-1"),
      "_blank",
      "noreferrer",
    );
    expect(onSetStatus).toHaveBeenCalledWith("job-1", "resume_optimized");
  });
});

// Dogfooding revert of ticket 3d80a85 (2026-09-08): Nicole asked for Apply
// and Open Job Page to be split back into two separate elements -- a
// pure-navigation link (no status side effect) and a pure status button
// (no navigation), rather than one element doing both.
describe("ResultCard — Open Job Page (pure link) and Apply (pure status button) are separate", () => {
  it("Open Job Page links to the real applyUrl and opens it in a new tab, with no status side effect", () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult({ applyUrl: "https://boards.example.com/jobs/42" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={onSetStatus}
      />,
    );

    const link = screen.getByRole("link", { name: "Open Job Page" });
    expect(link).toHaveAttribute("href", "https://boards.example.com/jobs/42");
    expect(link).toHaveAttribute("target", "_blank");

    fireEvent.click(link);
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it("Apply is a plain button that records status=applied and does not navigate", () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={async () => {}}
      />,
    );

    const applyButton = screen.getByRole("button", { name: "Apply" });
    expect(applyButton).not.toHaveAttribute("href");
    fireEvent.click(applyButton);

    expect(onSetStatus).toHaveBeenCalledWith("job-1", "applied");
  });

  it("Apply stays enabled once already applied -- it's a toggle now (ticket e367a63), not a disabled state", () => {
    render(
      <ResultCard
        result={makeResult({ status: "applied" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Apply" })).not.toBeDisabled();
  });

  it("Open Job Page stays fully navigable regardless of status (re-opening a posting you already applied to is normal)", () => {
    render(
      <ResultCard
        result={makeResult({ status: "applied" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    const link = screen.getByRole("link", { name: "Open Job Page" });
    expect(link).toHaveAttribute("href", "https://example.com/apply");
    expect(link).not.toHaveAttribute("aria-disabled");
  });
});

describe("ResultCard — explicit labeled metadata (ticket 3d80a85)", () => {
  it("labels company and data source explicitly", () => {
    render(
      <ResultCard
        result={makeResult({ company: "Wealthfront", dataSource: "lever" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.getByText(/Company: Wealthfront/)).toBeInTheDocument();
    expect(screen.getByText(/Data source: lever/)).toBeInTheDocument();
  });

  it("labels location and work arrangement explicitly when present", () => {
    render(
      <ResultCard
        result={makeResult({ location: "Seattle, WA", locationType: "hybrid" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.getByText(/Location: Seattle, WA/)).toBeInTheDocument();
    expect(screen.getByText(/Work arrangement: hybrid/)).toBeInTheDocument();
  });

  it("omits location/work-arrangement labels entirely when the job has neither", () => {
    render(
      <ResultCard
        result={makeResult({ location: null, locationType: null })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.queryByText(/Location:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Work arrangement:/)).not.toBeInTheDocument();
  });
});

// Ticket e367a63 (dogfooding, 2026-09-12) -- Nicole: "I do not want an undo
// button in the top right... What I want is an undoable toggle button. I
// should be able to hit the save button again and have it undo the save."
// This replaces the separate top-right Undo control (ticket 3c603ef) with
// the status buttons themselves acting as toggles.
describe("ResultCard — status buttons are undo-able toggles, no separate Undo control", () => {
  it("has no Undo control anywhere in the card, whether or not a status is set", () => {
    const { rerender } = render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Undo/ })).not.toBeInTheDocument();

    rerender(
      <ResultCard
        result={makeResult({ status: "dismissed" })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Undo/ })).not.toBeInTheDocument();
  });

  it("clicking the already-active status's own button clears it (calls onClearStatus, not onSetStatus)", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    const onClearStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult({ status: "dismissed" })}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={onClearStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(onClearStatus).toHaveBeenCalledWith("job-1"));
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it("clicking a different, non-active status button still sets that new status (regression: switching statuses is untouched)", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    const onClearStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult({ status: "saved" })}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={onClearStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(onSetStatus).toHaveBeenCalledWith("job-1", "dismissed"));
    expect(onClearStatus).not.toHaveBeenCalled();
  });

  it("marks the active status's button aria-pressed=true, and the others aria-pressed=false", () => {
    render(
      <ResultCard
        result={makeResult({ status: "saved" })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it('clicking "Optimize Resume" while already resume_optimized clears the status only -- no new handoff, no new tab', async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    const onClearStatus = vi.fn().mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <ResultCard
        result={makeResult({ status: "resume_optimized" })}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={onClearStatus}
      />,
    );

    expect(screen.getByRole("button", { name: "Optimize Resume" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    await waitFor(() => expect(onClearStatus).toHaveBeenCalledWith("job-1"));
    expect(createHandoff).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it('clicking "Optimize Resume" while NOT yet optimized still mints a handoff, opens a tab, and sets the status (unchanged path)', async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    createHandoff.mockResolvedValue({ id: "handoff-1", expiresAt: new Date().toISOString() });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={onSetStatus}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    await waitFor(() => expect(createHandoff).toHaveBeenCalledWith("job-1", "resume-1"));
    expect(openSpy).toHaveBeenCalledWith(
      "https://optimizer.example.com/?import=" +
        encodeURIComponent("https://api.example.com/handoffs/handoff-1"),
      "_blank",
      "noreferrer",
    );
    expect(onSetStatus).toHaveBeenCalledWith("job-1", "resume_optimized");
  });
});

// Ticket b182bde: matchScore alone conflated capability fit with leveling
// fit. This adds a separate levelFit + levelFitNote pill/detail, visible
// WITHOUT expanding the card, and null/well_matched must render nothing.
describe("ResultCard — level fit pill and detail (ticket b182bde)", () => {
  it('shows "Above this level" without expanding the card when levelFit is overqualified, carrying the note as both title and aria-label', () => {
    render(
      <ResultCard
        result={makeResult({
          levelFit: "overqualified",
          levelFitNote: "This posting asks for 1.5-2 years; you have far more.",
        })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    const pill = screen.getByText("Above this level");
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveAttribute("title", "This posting asks for 1.5-2 years; you have far more.");
    expect(pill).toHaveAttribute(
      "aria-label",
      "Above this level: This posting asks for 1.5-2 years; you have far more.",
    );
    // No need to expand the card to see it.
    expect(screen.getByRole("button", { name: "Why this match?" })).toBeInTheDocument();
  });

  it('shows "Below this level" when levelFit is underqualified', () => {
    render(
      <ResultCard
        result={makeResult({
          levelFit: "underqualified",
          levelFitNote: "This posting is written for a Staff-level candidate.",
        })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.getByText("Below this level")).toBeInTheDocument();
    expect(screen.queryByText("Above this level")).not.toBeInTheDocument();
  });

  it("shows no pill at all when levelFit is well_matched", () => {
    render(
      <ResultCard
        result={makeResult({ levelFit: "well_matched", levelFitNote: "" })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.queryByText("Above this level")).not.toBeInTheDocument();
    expect(screen.queryByText("Below this level")).not.toBeInTheDocument();
  });

  // Regression: a legacy pre-migration row has levelFit: null. It must
  // render exactly like well_matched (nothing) -- NOT get coerced into
  // either qualified state anywhere in the render path.
  it("shows no pill when levelFit is null (legacy row, never judged) -- not coerced to a qualified state", () => {
    render(
      <ResultCard
        result={makeResult({ levelFit: null, levelFitNote: null })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.queryByText("Above this level")).not.toBeInTheDocument();
    expect(screen.queryByText("Below this level")).not.toBeInTheDocument();
  });

  it("shows the full levelFitNote in the expanded details, above Strengths", () => {
    render(
      <ResultCard
        result={makeResult({
          levelFit: "overqualified",
          levelFitNote: "This may hurt at screening for a role this junior.",
          strengths: ["TypeScript"],
        })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Why this match?" }));

    expect(screen.getByText("Level fit")).toBeInTheDocument();
    expect(
      screen.getByText("This may hurt at screening for a role this junior."),
    ).toBeInTheDocument();
  });

  it("shows no Level fit block in expanded details when levelFitNote is absent or empty", () => {
    render(
      <ResultCard
        result={makeResult({ levelFit: null, levelFitNote: null })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Why this match?" }));

    expect(screen.queryByText("Level fit")).not.toBeInTheDocument();
  });
});
