import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecurityLearnIndexView } from "./SecurityLearnIndexView";
import { SecurityLearnView } from "./SecurityLearnView";

// Mock navigation
const mockPush = vi.fn();
let mockRouteParams: Record<string, string> = {};

const makeNavMock = () => ({
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "security-learn-index", params: mockRouteParams },
  canGoBack: true,
  depth: 2,
  stack: [],
});
vi.mock("../navigation", () => ({
  useNavigation: () => makeNavMock(),
  useNavigationContext: () => makeNavMock(),
}));

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: undefined,
    isLoading: false,
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
  mockRouteParams = {};
  mockPush.mockClear();
});

describe("SecurityLearnIndexView", () => {
  it("renders all known vulnerability types", () => {
    render(<SecurityLearnIndexView />);
    expect(screen.getByText("SQL Injection")).toBeDefined();
    expect(screen.getByText("XSS")).toBeDefined();
    expect(screen.getByText("Hardcoded Secret")).toBeDefined();
    expect(screen.getByText("Command Injection")).toBeDefined();
    expect(screen.getByText("Prototype Pollution")).toBeDefined();
  });

  it("shows tier badges", () => {
    render(<SecurityLearnIndexView />);
    expect(screen.getAllByText("Critical").length).toBeGreaterThan(0);
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Medium").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Low").length).toBeGreaterThan(0);
  });

  it("navigates to detail on click", () => {
    render(<SecurityLearnIndexView />);
    const sqlBtn = screen.getByText("SQL Injection").closest("button")!;
    fireEvent.click(sqlBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "security-learn",
      params: { flag: "sql_injection" },
    });
  });
});

describe("SecurityLearnView", () => {
  it("shows not found for unknown flag", () => {
    mockRouteParams = { flag: "nonexistent" };
    render(<SecurityLearnView />);
    expect(screen.getByText("Vulnerability type not found")).toBeDefined();
  });

  it("renders all sections for a known flag", () => {
    mockRouteParams = { flag: "sql_injection" };
    render(<SecurityLearnView />);
    expect(screen.getByText("What is it?")).toBeDefined();
    expect(screen.getByText("How it works")).toBeDefined();
    expect(screen.getByText("Vulnerable Code")).toBeDefined();
    expect(screen.getByText("Safe Code")).toBeDefined();
    expect(screen.getByText("Framework Notes")).toBeDefined();
    expect(screen.getByText("References")).toBeDefined();
  });

  it("shows CWE and OWASP badges", () => {
    mockRouteParams = { flag: "sql_injection" };
    render(<SecurityLearnView />);
    // CWE-89 appears in both badge and reference link
    expect(screen.getAllByText("CWE-89").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("A03:2021")).toBeDefined();
  });

  it("shows reference links", () => {
    mockRouteParams = { flag: "sql_injection" };
    render(<SecurityLearnView />);
    expect(screen.getByText("OWASP SQL Injection")).toBeDefined();
  });
});
