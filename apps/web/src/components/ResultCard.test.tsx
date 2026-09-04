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
  it("shows all four actions as present-tense verbs, regardless of current status", () => {
    render(<ResultCard result={makeResult()} onSetStatus={async () => {}} />);

    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Optimize Resume" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    // Old past-tense button wording must be gone.
    expect(screen.queryByRole("button", { name: "Saved" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Applied" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismissed" })).not.toBeInTheDocument();
  });

  it("shows the state pill in past-tense/state form once a status is set, alongside unchanged present-tense buttons", () => {
    render(<ResultCard result={makeResult({ status: "applied" })} onSetStatus={async () => {}} />);

    // The pill: state form.
    expect(screen.getByText("Applied")).toBeInTheDocument();
    // The button: still present-tense, unaffected by the current status
    // (STATUS_ACTIONS always renders all four -- Nicole: "there should be
    // no reason why there is not an option to do anything you want").
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });

  it("calls onSetStatus with the right status when a present-tense action button is clicked", async () => {
    const onSetStatus = vi.fn().mockResolvedValue(undefined);
    render(<ResultCard result={makeResult()} onSetStatus={onSetStatus} />);

    fireEvent.click(screen.getByRole("button", { name: "Optimize Resume" }));

    expect(onSetStatus).toHaveBeenCalledWith("job-1", "resume_optimized");
  });
});
