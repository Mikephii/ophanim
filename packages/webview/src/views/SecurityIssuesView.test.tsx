import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SecurityIssuesView } from "./SecurityIssuesView";

// Mock navigation
const mockPush = vi.fn();
let mockRouteParams: Record<string, string> = {};

const makeNavMock = () => ({
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "security-issues", params: mockRouteParams },
  canGoBack: true,
  depth: 2,
  stack: [],
});
vi.mock("../navigation", () => ({
  useNavigation: () => makeNavMock(),
  useNavigationContext: () => makeNavMock(),
}));

// Query/mutation mocks
let mockIssuesData: unknown = undefined;
let mockIssuesLoading = false;
const mockRefetch = vi.fn();
const mockMutate = vi.fn();

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: mockIssuesData,
    isLoading: mockIssuesLoading,
    error: undefined,
    refetch: mockRefetch,
  }),
  useWebviewMutation: () => ({
    mutate: mockMutate,
    isLoading: false,
    error: undefined,
  }),
}));

const mockIssues = {
  items: [
    {
      content_hash: "hash1",
      function_name: "getUser",
      file_path: "src/db.ts",
      language: "typescript",
      entity_type: "function",
      start_line: 10,
      issue: {
        flag: "sql_injection",
        title: "SQL Injection via template literal",
        description: "User input in query.",
        severity: "error",
        confidence: "high",
      },
      issueIndex: 0,
      score: 12,
      dismissed: false,
    },
    {
      content_hash: "hash2",
      function_name: "renderHTML",
      file_path: "src/view.ts",
      language: "typescript",
      entity_type: "function",
      start_line: 5,
      issue: {
        flag: "xss",
        title: "XSS via innerHTML",
        description: "Unsanitized user input.",
        severity: "warning",
        confidence: "medium",
      },
      issueIndex: 0,
      score: 8,
      dismissed: false,
    },
  ],
  total: 2,
  page: 1,
};

beforeEach(() => {
  mockIssuesData = undefined;
  mockIssuesLoading = false;
  mockRouteParams = {};
  mockPush.mockClear();
  mockRefetch.mockClear();
  mockMutate.mockClear();
});

describe("SecurityIssuesView", () => {
  it("shows loading skeleton when data is loading", () => {
    mockIssuesLoading = true;

    const { container } = render(<SecurityIssuesView />);
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no issues", () => {
    mockIssuesData = { items: [], total: 0, page: 1 };

    render(<SecurityIssuesView />);
    expect(screen.getByText("No security issues found")).toBeDefined();
  });

  it("renders issue cards", () => {
    mockIssuesData = mockIssues;

    render(<SecurityIssuesView />);
    expect(screen.getByText("SQL Injection via template literal")).toBeDefined();
    expect(screen.getByText("XSS via innerHTML")).toBeDefined();
  });

  it("shows issue count", () => {
    mockIssuesData = mockIssues;

    render(<SecurityIssuesView />);
    expect(screen.getByText("2 issues")).toBeDefined();
  });

  it("navigates to function detail on card click", () => {
    mockIssuesData = mockIssues;

    render(<SecurityIssuesView />);
    // Click the first issue card's button
    const buttons = screen.getAllByRole("button");
    const issueButton = buttons.find(
      (b) => b.textContent?.includes("SQL Injection via template literal"),
    );
    expect(issueButton).toBeDefined();
    fireEvent.click(issueButton!);
    expect(mockPush).toHaveBeenCalledWith({
      view: "function-detail",
      params: { contentHash: "hash1", filePath: "src/db.ts" },
    });
  });

  it("shows dismiss button for non-dismissed issues", () => {
    mockIssuesData = mockIssues;

    render(<SecurityIssuesView />);
    const dismissButtons = screen.getAllByText("Dismiss");
    expect(dismissButtons.length).toBe(2);
  });

  it("shows restore button for dismissed issues", () => {
    mockIssuesData = {
      ...mockIssues,
      items: [{ ...mockIssues.items[0], dismissed: true }],
      total: 1,
    };

    render(<SecurityIssuesView />);
    expect(screen.getByText("Restore")).toBeDefined();
  });

  it("opens filter sheet when Filter button is clicked", () => {
    mockIssuesData = mockIssues;

    render(<SecurityIssuesView />);
    const filterButton = screen.getByText("Filter");
    fireEvent.click(filterButton);
    // Filter sheet should now be visible
    expect(screen.getByText("Vulnerability type")).toBeDefined();
    expect(screen.getByText("Severity")).toBeDefined();
  });

  it("shows active filter chip from route params", () => {
    mockRouteParams = { flag: "sql_injection" };
    mockIssuesData = {
      items: [mockIssues.items[0]],
      total: 1,
      page: 1,
    };

    render(<SecurityIssuesView />);
    expect(screen.getByText("SQL Injection")).toBeDefined();
  });

  it("shows pagination when more pages available", () => {
    mockIssuesData = {
      items: mockIssues.items,
      total: 40, // More than PAGE_SIZE
      page: 1,
    };

    render(<SecurityIssuesView />);
    expect(screen.getAllByText("Next").length).toBeGreaterThan(0);
  });

  it("shows empty state with clear filter when filters active and no results", () => {
    mockRouteParams = { flag: "prototype_pollution" };
    mockIssuesData = { items: [], total: 0, page: 1 };

    render(<SecurityIssuesView />);
    expect(screen.getByText("No matching issues")).toBeDefined();
    expect(screen.getByText("Clear filters")).toBeDefined();
  });
});
