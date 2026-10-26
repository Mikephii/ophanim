import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsView } from "./SettingsView";

// Mock navigation
const navMock = {
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "settings", params: {} },
  canGoBack: true,
  depth: 1,
  stack: [],
};
vi.mock("../navigation", () => ({
  useNavigation: () => navMock,
  useNavigationContext: () => navMock,
}));

// Query mock
let mockData: unknown = undefined;
let mockLoading = false;

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: mockData,
    isLoading: mockLoading,
    error: undefined,
    refetch: vi.fn(),
  }),
  useWebviewMutation: () => ({
    mutate: vi.fn(),
    isLoading: false,
    error: undefined,
  }),
}));

beforeEach(() => {
  mockData = undefined;
  mockLoading = false;
});

describe("SettingsView", () => {
  it("shows loading skeleton", () => {
    mockLoading = true;

    const { container } = render(<SettingsView />);
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no practices", () => {
    mockData = [];
    render(<SettingsView />);
    expect(screen.getByText("No practices configured")).toBeDefined();
  });

  it("renders practice cards", () => {
    mockData = [
      { practice_id: "no-any", rule: "Never use `any` type", severity: "error" },
      { practice_id: "naming-convention", rule: "Use camelCase", severity: "warning" },
    ];

    render(<SettingsView />);
    expect(screen.getByText("no-any")).toBeDefined();
    expect(screen.getByText("Never use `any` type")).toBeDefined();
    expect(screen.getByText("naming-convention")).toBeDefined();
    expect(screen.getByText("Use camelCase")).toBeDefined();
  });

  it("shows severity badges", () => {
    mockData = [
      { practice_id: "no-any", rule: "Never use any", severity: "error" },
    ];

    render(<SettingsView />);
    expect(screen.getByText("error")).toBeDefined();
  });

  it("shows practice count", () => {
    mockData = [
      { practice_id: "a", rule: "Rule A", severity: "warning" },
      { practice_id: "b", rule: "Rule B", severity: "error" },
    ];

    render(<SettingsView />);
    expect(screen.getByText(/2 practices configured/)).toBeDefined();
  });
});
