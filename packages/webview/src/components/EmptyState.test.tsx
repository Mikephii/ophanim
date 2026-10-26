import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title", () => {
    render(<EmptyState title="No data found" />);
    expect(screen.getByText("No data found")).toBeDefined();
  });

  it("renders description when provided", () => {
    render(
      <EmptyState title="Empty" description="Run analysis to see results." />,
    );
    expect(screen.getByText("Run analysis to see results.")).toBeDefined();
  });

  it("renders icon when provided", () => {
    render(
      <EmptyState
        title="Empty"
        icon={<span data-testid="test-icon">icon</span>}
      />,
    );
    expect(screen.getByTestId("test-icon")).toBeDefined();
  });

  it("renders action button when provided", () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="No results"
        action={{ label: "Clear filters", onClick }}
      />,
    );
    const button = screen.getByText("Clear filters");
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not render description when not provided", () => {
    const { container } = render(<EmptyState title="Empty" />);
    const paragraphs = container.querySelectorAll("p");
    // Only the title paragraph
    expect(paragraphs.length).toBe(1);
  });

  it("does not render action button when not provided", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector("button")).toBeNull();
  });
});
