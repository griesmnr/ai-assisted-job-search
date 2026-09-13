// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScoreFloorControl } from "./ScoreFloorControl";

afterEach(cleanup);

describe("ScoreFloorControl (ticket ffbf9fb)", () => {
  it("renders the current value as a percentage and as the slider's value", () => {
    render(<ScoreFloorControl value={55} onChange={() => {}} />);

    const slider = screen.getByLabelText("Minimum match score to show");
    expect(slider).toHaveValue("55");
    expect(screen.getByText("55%")).toBeInTheDocument();
  });

  it("calls onChange with the new numeric value when moved", () => {
    const onChange = vi.fn();
    render(<ScoreFloorControl value={55} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Minimum match score to show"), {
      target: { value: "20" },
    });

    expect(onChange).toHaveBeenCalledWith(20);
  });

  it("keeps the slider within a sensible 0-90 range", () => {
    render(<ScoreFloorControl value={55} onChange={() => {}} />);

    const slider = screen.getByLabelText("Minimum match score to show");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "90");
  });
});
