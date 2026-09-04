// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoredJobResult } from "@app/shared";
import { ResultCard } from "./ResultCard";

afterEach(cleanup);

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
  it("shows all four actions as present-tense verbs, regardless of current status -- Apply as a link (ticket 3d80a85), the rest as buttons", () => {
    render(<ResultCard result={makeResult()} onSetStatus={async () => {}} />);

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Apply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    // Old past-tense button wording must be gone.
    expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Applied" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismissed" })).not.toBeInTheDocument();
    // No separate "Open posting" link duplicating Apply's job.
    expect(screen.queryByRole("link", { name: "Open posting" })).not.toBeInTheDocument();
  });

  it("shows the state pill in past-tense/state form once a status is set, alongside unchanged present-tense actions", () => {
    render(<ResultCard result={makeResult({ status: "applied" })} onSetStatus={async () => {}} />);

    // The pill: state form.
    expect(screen.getByText("Applied")).toBeInTheDocument();
    // The action: still present-tense, unaffected by the current status
    // (Nicole: "there should be no reason why there is not an option to
    // do anything you want").
    expect(screen.getByRole("link", { name: "Apply" })).toBeInTheDocument();
  });

  it("calls onSetStatus with the right status when a present-tense action button is clicked", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(<ResultCard result={makeResult()} onSetStatus={onSetStatus} />);

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    expect(onSetStatus).toHaveBeenCalledWith("job-1", "resume_optimized");
  });
});

// Ticket 3d80a85: Apply is a real link to the posting AND a status write,
// together, from one click.
describe("ResultCard — Apply is a real posting link + status write (ticket 3d80a85)", () => {
  it("links to the real applyUrl and opens it in a new tab", () => {
    render(
      <ResultCard
        result={makeResult({ applyUrl: "https://boards.example.com/jobs/42" })}
        onSetStatus={async () => {}}
      />,
    );

    const link = screen.getByRole("link", { name: "Apply" });
    expect(link).toHaveAttribute("href", "https://boards.example.com/jobs/42");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("records status=applied when clicked", () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(<ResultCard result={makeResult()} onSetStatus={onSetStatus} />);

    fireEvent.click(screen.getByRole("link", { name: "Apply" }));

    expect(onSetStatus).toHaveBeenCalledWith("job-1", "applied");
  });

  it("does not re-write status when clicked again after already applied (still navigable)", () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(<ResultCard result={makeResult({ status: "applied" })} onSetStatus={onSetStatus} />);

    const link = screen.getByRole("link", { name: "Apply" });
    fireEvent.click(link);

    expect(onSetStatus).not.toHaveBeenCalled();
    // Still a real, functional link -- re-opening a posting you already
    // applied to is a normal thing to do.
    expect(link).toHaveAttribute("href", "https://example.com/apply");
  });
});

describe("ResultCard — explicit labeled metadata (ticket 3d80a85)", () => {
  it("labels company and data source explicitly", () => {
    render(
      <ResultCard
        result={makeResult({ company: "Wealthfront", dataSource: "lever" })}
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
        onSetStatus={async () => {}}
      />,
    );

    expect(screen.queryByText(/Location:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Work arrangement:/)).not.toBeInTheDocument();
  });
});
