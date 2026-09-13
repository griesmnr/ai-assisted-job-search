// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScoreFloorControl } from "./ScoreFloorControl";

afterEach(cleanup);

describe("ScoreFloorControl (ticket ffbf9fb)", () => {
  it("renders the current value as a percentage and as the slider's value", () => {
    render(<ScoreFloorControl value={55} onChange={() => {}} />);

    const slider = screen.getByLabelText("Minimum match score to show");
    expect(slider).toHaveValue("55");
    expect(screen.getByText("55%")).toBeInTheDocument();
  });

  it("keeps the slider within a sensible 0-90 range", () => {
    render(<ScoreFloorControl value={55} onChange={() => {}} />);

    const slider = screen.getByLabelText("Minimum match score to show");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "90");
  });

  describe("debounced propagation (opus review, ticket ffbf9fb should-fix)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("updates the slider's own displayed value immediately, before the debounce settles", () => {
      render(<ScoreFloorControl value={55} onChange={() => {}} />);

      fireEvent.change(screen.getByLabelText("Minimum match score to show"), {
        target: { value: "20" },
      });

      // No timer advance yet -- the visible slider/readout must already
      // reflect the drag, independent of when (or whether) `onChange` fires.
      expect(screen.getByLabelText("Minimum match score to show")).toHaveValue("20");
      expect(screen.getByText("20%")).toBeInTheDocument();
    });

    it("does not call onChange until 250ms after the last change", () => {
      const onChange = vi.fn();
      render(<ScoreFloorControl value={55} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText("Minimum match score to show"), {
        target: { value: "20" },
      });
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(249);
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledWith(20);
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("collapses several rapid changes into a single onChange call, with the FINAL value", () => {
      const onChange = vi.fn();
      render(<ScoreFloorControl value={55} onChange={onChange} />);

      const slider = screen.getByLabelText("Minimum match score to show");
      // Simulates dragging across several step-5 ticks in quick succession.
      fireEvent.change(slider, { target: { value: "50" } });
      vi.advanceTimersByTime(100);
      fireEvent.change(slider, { target: { value: "40" } });
      vi.advanceTimersByTime(100);
      fireEvent.change(slider, { target: { value: "30" } });
      vi.advanceTimersByTime(100);
      fireEvent.change(slider, { target: { value: "20" } });

      // Only 100ms have elapsed since the last change -- not yet settled.
      expect(onChange).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(20);
    });
  });

  describe("unique id per instance (opus review, ticket ffbf9fb BLOCKING)", () => {
    it("gives two simultaneously-mounted instances distinct ids, each correctly labeled", () => {
      // Mirrors App.tsx mounting this component once per tab, both tabs
      // alive in the DOM at once (see App.tsx's `hidden`-not-conditional-
      // rendering comment) -- a real regression test for this exact shape
      // lives in App.scoreFloor.test.tsx (drives an actual completed
      // search so both instances are mounted through the real app, not a
      // synthetic double-render like this one). This test isolates the
      // component-level guarantee: `useId()` never collides across
      // instances, no matter how many are on screen.
      render(
        <>
          <ScoreFloorControl value={55} onChange={() => {}} />
          <ScoreFloorControl value={55} onChange={() => {}} />
        </>,
      );

      const sliders = screen.getAllByLabelText("Minimum match score to show");
      expect(sliders).toHaveLength(2);
      const [first, second] = sliders as [HTMLInputElement, HTMLInputElement];
      expect(first.id).not.toBe(second.id);
      expect(first.id.length).toBeGreaterThan(0);
      expect(second.id.length).toBeGreaterThan(0);

      const firstContainer = first.closest(".score-floor-control");
      const secondContainer = second.closest(".score-floor-control");
      if (firstContainer === null || secondContainer === null) {
        throw new Error("expected each slider to be wrapped in .score-floor-control");
      }
      const firstLabel = within(firstContainer as HTMLElement).getByText(
        "Minimum match score to show",
      );
      const secondLabel = within(secondContainer as HTMLElement).getByText(
        "Minimum match score to show",
      );
      expect((firstLabel as HTMLLabelElement).control).toBe(first);
      expect((secondLabel as HTMLLabelElement).control).toBe(second);
    });
  });
});
