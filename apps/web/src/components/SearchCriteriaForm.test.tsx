// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SearchCriteriaForm } from "./SearchCriteriaForm";

afterEach(() => {
  cleanup();
});

function baseProps() {
  return {
    titleChips: [],
    nearLocations: "",
    remoteOk: false,
    anyLocationOk: false,
    commitmentIn: [] as ("full-time" | "part-time" | "contract")[],
    showFederalTitleSuggestions: false,
    onTitleChipsChange: () => {},
    onChange: () => {},
  };
}

/**
 * Ticket 371713d: Nicole, live -- "I really want to force the issue because
 * I don't read text on sites" -- the existing `.search-criteria-location-
 * warning` text (kept, for a11y) isn't enough on its own. These tests prove
 * the RED visual highlight independently of that text, on both the
 * location input and the "Any location" checkbox, reactive to the exact
 * same `hasLocationSignal` condition.
 */
describe("SearchCriteriaForm — red highlight on missing location signal (ticket 371713d)", () => {
  it("highlights the location input and the 'Any location' checkbox row when no location signal is set", () => {
    render(<SearchCriteriaForm {...baseProps()} />);

    const locationInput = screen.getByLabelText(/Locations you'd commute to/);
    expect(locationInput).toHaveClass("search-criteria-input-invalid");
    expect(locationInput).toHaveAttribute("aria-invalid", "true");

    const anyLocationCheckbox = screen.getByLabelText(/Any location/);
    expect(anyLocationCheckbox.closest("label")).toHaveClass("search-criteria-checkbox-invalid");
    expect(anyLocationCheckbox).toHaveAttribute("aria-invalid", "true");
  });

  it("clears the highlight immediately once nearLocations carries a real phrase", () => {
    render(<SearchCriteriaForm {...baseProps()} nearLocations="seattle" />);

    const locationInput = screen.getByLabelText(/Locations you'd commute to/);
    expect(locationInput).not.toHaveClass("search-criteria-input-invalid");
    expect(locationInput).toHaveAttribute("aria-invalid", "false");

    const anyLocationCheckbox = screen.getByLabelText(/Any location/);
    expect(anyLocationCheckbox.closest("label")).not.toHaveClass(
      "search-criteria-checkbox-invalid",
    );
  });

  it("a lone comma does NOT clear the highlight (matches the same splitPhrases check the warning text uses)", () => {
    render(<SearchCriteriaForm {...baseProps()} nearLocations="," />);

    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveClass(
      "search-criteria-input-invalid",
    );
  });

  it("clears the highlight immediately once 'Any location' is checked", () => {
    render(<SearchCriteriaForm {...baseProps()} anyLocationOk={true} />);

    expect(screen.getByLabelText(/Locations you'd commute to/)).not.toHaveClass(
      "search-criteria-input-invalid",
    );
    expect(screen.getByLabelText(/Any location/).closest("label")).not.toHaveClass(
      "search-criteria-checkbox-invalid",
    );
  });

  it("clears the highlight once 'Also show fully remote roles' is checked", () => {
    render(<SearchCriteriaForm {...baseProps()} remoteOk={true} />);

    expect(screen.getByLabelText(/Locations you'd commute to/)).not.toHaveClass(
      "search-criteria-input-invalid",
    );
  });

  it("still renders the existing text warning alongside the highlight (kept for accessibility, not depended on)", () => {
    render(<SearchCriteriaForm {...baseProps()} />);

    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();
  });
});
