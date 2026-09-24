// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchCriteriaForm } from "./SearchCriteriaForm";

afterEach(() => {
  cleanup();
});

function baseProps() {
  return {
    titleChips: [],
    nearLocations: "",
    expandMetroAreas: false,
    remoteOk: false,
    anyLocationOk: false,
    commitmentIn: [] as ("full-time" | "part-time" | "contract")[],
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

/**
 * Ticket 410e1a2. Nicole's own acceptance bar for this one was visibility --
 * "I want it given that it meets both users' needs AS LONG AS IT CAN BE
 * SEEN" -- so these tests assert the control renders, renders unchecked, and
 * says in its own label what it will actually do, not just that the prop is
 * wired.
 */
describe("SearchCriteriaForm — metro-area expansion checkbox (ticket 410e1a2)", () => {
  it("renders in the location section, unchecked, with a label naming real sibling cities", () => {
    render(<SearchCriteriaForm {...baseProps()} />);

    const checkbox = screen.getByLabelText(/Also include nearby cities in the same metro area/);
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
    // Specific enough that a user can predict the effect before running a
    // search that costs money, and phrased as an addition ("Also include")
    // rather than as something already happening.
    expect(
      screen.getByText(/a Seattle search would also match Bellevue, Kirkland, Redmond/),
    ).toBeInTheDocument();
    // Inside the same block the location input lives in, not stranded
    // elsewhere in the form.
    const locationSection = screen
      .getByLabelText(/Locations you'd commute to/)
      .closest(".search-criteria-location-section");
    expect(locationSection).toContainElement(checkbox);
  });

  it("reports the opt-in up to App.tsx while leaving every other criteria field alone", () => {
    const onChange = vi.fn();
    render(<SearchCriteriaForm {...baseProps()} nearLocations="seattle" onChange={onChange} />);

    fireEvent.click(screen.getByLabelText(/Also include nearby cities in the same metro area/));

    expect(onChange).toHaveBeenCalledWith({
      nearLocations: "seattle",
      expandMetroAreas: true,
      remoteOk: false,
      anyLocationOk: false,
      commitmentIn: [],
    });
  });

  it("renders checked when the caller says it is on", () => {
    render(<SearchCriteriaForm {...baseProps()} expandMetroAreas={true} />);
    expect(
      screen.getByLabelText(/Also include nearby cities in the same metro area/),
    ).toBeChecked();
  });

  it("does NOT count as a location signal — it widens the location box, it is not a substitute for it", () => {
    // Otherwise checking this box with an empty location field would clear
    // the ticket-b9e6251 warning and unlock the estimate for a search with
    // no location restriction at all -- the exact silent-unrestricted-search
    // state that ticket exists to prevent.
    render(<SearchCriteriaForm {...baseProps()} expandMetroAreas={true} />);

    expect(screen.getByLabelText(/Locations you'd commute to/)).toHaveClass(
      "search-criteria-input-invalid",
    );
    expect(screen.getByText(/No location restriction is set/)).toBeInTheDocument();
  });
});
