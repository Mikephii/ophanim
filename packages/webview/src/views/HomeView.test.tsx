import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HomeView } from "./HomeView";

// Mock the hooks
const mockPush = vi.fn();
const navMock = {
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "home", params: {} },
  canGoBack: false,
  depth: 1,
  stack: [{ view: "home", params: {} }],
};
vi.mock("../navigation", () => ({
  useNavigation: () => navMock,
  useNavigationContext: () => navMock,
}));

let mockStatsData: unknown = undefined;
let mockStatsLoading = false;
let mockIssuesData: unknown = undefined;
let mockIssuesLoading = false;

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: (method: string) => {
    if (method === "getSecurityDashboardStats") {
      return { data: mockStatsData, isLoading: mockStatsLoading, error: undefined, refetch: vi.fn() };
    }
    if (method === "getTopIssues") {
      return { data: mockIssuesData, isLoading: mockIssuesLoading, error: undefined, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, error: undefined, refetch: vi.fn() };
  },
}));

const mockStats = {
  posture: "warning" as const,
  criticalCount: 1,
  errorCount: 3,
  warningCount: 5,
  totalFunctions: 42,
  flagBreakdown: {
    sql_injection: { count: 2, errorCount: 1, warningCount: 1, infoCount: 0 },
    xss: { count: 3, errorCount: 2, warningCount: 1, infoCount: 0 },
  },
};

const mockIssues = [
  {
    content_hash: "hash1",
    function_name: "getUser",
    file_path: "src/db.ts",
    issue: {
      flag: "sql_injection",
      title: "SQL Injection via template literal",
      description: "User input in query.",
      severity: "error",
      confidence: "high",
    },
  },
];

beforeEach(() => {
  mockStatsData = undefined;
  mockStatsLoading = false;
  mockIssuesData = undefined;
  mockIssuesLoading = false;
  mockPush.mockClear();
});

describe("HomeView", () => {
  it("shows loading skeleton when data is loading", () => {
    mockStatsLoading = true;
    mockIssuesLoading = true;

    const { container } = render(<HomeView />);
    // Should render skeleton elements (pulse animation divs)
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when totalFunctions is 0", () => {
    mockStatsData = { ...mockStats, totalFunctions: 0 };
    mockIssuesData = [];

    render(<HomeView />);
    expect(screen.getByText("No security analysis found")).toBeDefined();
    expect(screen.getByText(/ophan watch/)).toBeDefined();
  });

  it("renders security hero with stats", () => {
    mockStatsData = mockStats;
    mockIssuesData = mockIssues;

    render(<HomeView />);
    expect(screen.getByText("Needs Attention")).toBeDefined();
    // Stat values may appear in multiple sections (stat cards + distribution bar + categories)
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1); // criticalCount
    expect(screen.getAllByText("3").length).toBeGreaterThanOrEqual(1); // errorCount
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1); // warningCount
    expect(screen.getByText("42")).toBeDefined(); // totalFunctions (unique)
  });

  it("renders top issues section", () => {
    mockStatsData = mockStats;
    mockIssuesData = mockIssues;

    render(<HomeView />);
    expect(screen.getByText("Top Issues")).toBeDefined();
    expect(
      screen.getByText("SQL Injection via template literal"),
    ).toBeDefined();
  });

  it("renders security categories", () => {
    mockStatsData = mockStats;
    mockIssuesData = mockIssues;

    render(<HomeView />);
    expect(screen.getByText("By Category")).toBeDefined();
    // Flag labels appear in both DistributionBar legend and SecurityCategories
    expect(screen.getAllByText("SQL Injection").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("XSS").length).toBeGreaterThanOrEqual(1);
  });

  it("shows clean state when posture is clean and no issues", () => {
    mockStatsData = {
      ...mockStats,
      posture: "clean",
      criticalCount: 0,
      errorCount: 0,
      warningCount: 0,
      flagBreakdown: {},
    };
    mockIssuesData = [];

    render(<HomeView />);
    expect(screen.getByText("No Issues Found")).toBeDefined();
    expect(screen.getByText("No security issues found")).toBeDefined();
  });
});
