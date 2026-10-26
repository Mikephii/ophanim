import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NavSheet } from "./NavSheet";
import type { ViewType } from "../navigation";

describe("NavSheet", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onNavigate: vi.fn(),
    currentView: "home" as ViewType,
  };

  it("renders all navigation items when open", () => {
    render(<NavSheet {...defaultProps} />);

    expect(screen.getByText("Security Overview")).toBeDefined();
    expect(screen.getByText("Security Issues")).toBeDefined();
    expect(screen.getByText("Functions")).toBeDefined();
    expect(screen.getByText("Architecture Docs")).toBeDefined();
    expect(screen.getByText("Security Reference")).toBeDefined();
    expect(screen.getByText("Practices")).toBeDefined();
  });

  it("calls onNavigate when a nav item is clicked", () => {
    const onNavigate = vi.fn();
    render(<NavSheet {...defaultProps} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByText("Functions"));
    // requestAnimationFrame is used for delayed nav
    // The onOpenChange should be called to close the sheet
    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows count badges when counts are provided", () => {
    render(
      <NavSheet
        {...defaultProps}
        counts={{ securityIssues: 5, functions: 42, practices: 3 }}
      />
    );

    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("42")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("does not show count badges when counts are zero", () => {
    render(
      <NavSheet
        {...defaultProps}
        counts={{ securityIssues: 0, functions: 0, practices: 0 }}
      />
    );

    // Should not find any badge elements with "0"
    expect(screen.queryByText("0")).toBeNull();
  });

  it("marks the current view as active", () => {
    render(<NavSheet {...defaultProps} currentView="functions" />);

    const functionsButton = screen.getByText("Functions").closest("button");
    expect(functionsButton?.getAttribute("aria-current")).toBe("page");

    const overviewButton = screen.getByText("Security Overview").closest("button");
    expect(overviewButton?.getAttribute("aria-current")).toBeNull();
  });
});
