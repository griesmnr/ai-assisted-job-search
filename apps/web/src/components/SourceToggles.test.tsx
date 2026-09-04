// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceHealth } from "@app/shared";
import { SourceToggles } from "./SourceToggles";

// Vitest's `test.globals` is off in this repo's root vitest.config.ts (every
// test imports `describe`/`it`/etc. explicitly), so @testing-library/react's
// auto-cleanup — which detects a GLOBAL `afterEach` — never fires on its
// own. Without this, each `render()` in this file stacks onto the previous
// test's DOM instead of replacing it, and a query like `getByLabelText`
// that matched one element now matches N and throws. Explicit per-file
// cleanup, same fix ResultsList.test.tsx needs for the same reason.
afterEach(cleanup);

const SOURCES: SourceHealth[] = [
  { id: "usajobs", displayName: "USAJOBS", configured: true },
  { id: "greenhouse", displayName: "Greenhouse", configured: true },
  {
    id: "lever",
    displayName: "Lever",
    configured: false,
    error: "LEVER_COMPANIES is not set",
  },
];

describe("SourceToggles", () => {
  it("renders every configured source, state visible at a glance", () => {
    render(<SourceToggles sources={SOURCES} selected={new Set(["usajobs"])} onToggle={() => {}} />);

    expect(screen.getByLabelText("USAJOBS")).toBeChecked();
    expect(screen.getByLabelText("Greenhouse")).not.toBeChecked();
  });

  it("does not render a source with no adapter (configured: false) at all (ticket d480357)", () => {
    render(<SourceToggles sources={SOURCES} selected={new Set(["usajobs"])} onToggle={() => {}} />);

    // Absent entirely -- not a disabled row, not an error message.
    expect(screen.queryByLabelText("Lever")).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByText(/LEVER_COMPANIES is not set/)).not.toBeInTheDocument();

    // ...and the rest of the list is unaffected: both other, healthy sources
    // still render and remain independently toggleable.
    expect(screen.getByLabelText("USAJOBS")).toBeEnabled();
    expect(screen.getByLabelText("Greenhouse")).toBeEnabled();
  });

  it("toggling a source calls onToggle with that source's id, never the whole list", () => {
    const onToggle = vi.fn();
    render(<SourceToggles sources={SOURCES} selected={new Set()} onToggle={onToggle} />);

    fireEvent.click(screen.getByLabelText("Greenhouse"));

    expect(onToggle).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledWith("greenhouse");
  });
});
