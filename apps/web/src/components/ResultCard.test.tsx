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

  it("Apply is disabled once already applied, same as Save/Dismiss disable once set", () => {
    render(
      <ResultCard
        result={makeResult({ status: "applied" })}
        resumeId="resume-1"
        onClearStatus={async () => {}}
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
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

// Dogfooding feedback, 2026-09-08 -- Nicole: "you should be able to
// untoggle the buttons, like undismiss."
describe("ResultCard — undo a status back to no-action-taken", () => {
  it("shows no Undo control when no status is set", () => {
    render(
      <ResultCard
        result={makeResult()}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={async () => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
  });

  it("calls onClearStatus for the right job when Undo is clicked on a set status", async () => {
    const onClearStatus = vi.fn().mockResolvedValue(undefined);
    render(
      <ResultCard
        result={makeResult({ status: "dismissed" })}
        resumeId="resume-1"
        onSetStatus={async () => {}}
        onClearStatus={onClearStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: 'Undo "Dismissed"' }));

    expect(onClearStatus).toHaveBeenCalledWith("job-1");
  });
});
