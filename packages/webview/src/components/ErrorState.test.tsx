import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorState } from "./ErrorState";

describe("ErrorState", () => {
  it("renders error message", () => {
    render(<ErrorState message="Database unavailable" />);
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("Database unavailable")).toBeDefined();
  });

  it("renders retry button when onRetry provided", () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Timeout" onRetry={onRetry} />);
    const button = screen.getByText("Retry");
    expect(button).toBeDefined();
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not render retry button when onRetry not provided", () => {
    const { container } = render(<ErrorState message="Timeout" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders error icon", () => {
    const { container } = render(<ErrorState message="Error" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
