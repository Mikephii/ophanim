import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FunctionDetailView } from "./FunctionDetailView";
import type { FunctionData } from "../data";

// Mock navigation
const mockPush = vi.fn();
const navMock = {
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "function-detail", params: { contentHash: "abc123" } },
  canGoBack: true,
  depth: 2,
  stack: [
    { view: "home", params: {} },
    { view: "function-detail", params: { contentHash: "abc123" } },
  ],
};
vi.mock("../navigation", () => ({
  useNavigation: () => navMock,
  useNavigationContext: () => navMock,
}));

// Mock VS Code API
vi.mock("../useVSCode", () => ({
  getVSCode: () => null,
}));

// Control mock query data
let mockQueryData: unknown = undefined;
let mockQueryLoading = false;
let mockQueryError: string | undefined = undefined;

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: mockQueryData,
    isLoading: mockQueryLoading,
    error: mockQueryError,
    refetch: vi.fn(),
  }),
}));

// Control mock analysis state
let mockAnalysisState: "fresh" | "stale" | "analyzing" = "fresh";

vi.mock("../use-file-analysis-state", () => ({
  useFileAnalysisState: () => mockAnalysisState,
}));

const mockEnrichedFunction = {
  file_path: "src/auth/login.ts",
  function_name: "authenticateUser",
  content_hash: "abc123",
  language: "typescript",
  entity_type: "function",
  start_line: 10,
  analysis: {
    documentation: {
      description: "Authenticates a user with email and password",
      params: [
        { name: "email", type: "string", description: "User email" },
        { name: "password", type: "string", description: "User password" },
      ],
      returns: { type: "Promise<User>", description: "Authenticated user object" },
    },
    security: {
      dataTags: ["user_input", "credentials"],
      securityFlags: ["sql_injection"],
      issues: [
        {
          flag: "sql_injection",
          title: "SQL injection via template literal",
          description: "User input concatenated directly into SQL query.",
          explanation: "Use parameterized queries instead.",
          line: 5,
          startText: "db.query(`SELECT",
          endText: "`)",
          severity: "error",
          confidence: "high",
        },
      ],
    },
    practices: {
      violations: [
        {
          flag: "no-direct-db",
          title: "Direct database access",
          description: "Use the repository pattern for DB access.",
          explanation: "",
          line: 5,
          startText: "db.query",
          endText: "",
          severity: "warning",
        },
      ],
    },
  },
};

const mockLegacyData: FunctionData = {
  name: "legacyFunc",
  filePath: "src/legacy.ts",
  startLine: 1,
  endLine: 10,
  contentHash: "legacy123",
  description: "A legacy function",
  params: [],
  returns: { type: "void", description: "" },
  dataTags: [],
  securityFlags: [],
  issues: [],
  practiceViolations: [],
  language: "typescript",
  entityType: "function",
};

beforeEach(() => {
  mockQueryData = undefined;
  mockQueryLoading = false;
  mockQueryError = undefined;
  mockAnalysisState = "fresh";
  mockPush.mockClear();
});

describe("FunctionDetailView", () => {
  it("shows loading skeleton when data is loading", () => {
    mockQueryLoading = true;

    const { container } = render(<FunctionDetailView />);
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows error state on query error", () => {
    mockQueryError = "Database unavailable";

    render(<FunctionDetailView />);
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("Database unavailable")).toBeDefined();
    expect(screen.getByText("Retry")).toBeDefined();
  });

  it("shows empty state when no data and not loading", () => {
    render(<FunctionDetailView />);
    expect(screen.getByText("Function not found")).toBeDefined();
  });

  it("renders function detail from query data", () => {
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView />);
    expect(screen.getByText("authenticateUser")).toBeDefined();
    expect(
      screen.getByText("Authenticates a user with email and password"),
    ).toBeDefined();
    expect(screen.getByText("email")).toBeDefined();
    expect(screen.getByText("password")).toBeDefined();
  });

  it("renders security issues with severity badges", () => {
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView />);
    expect(screen.getByText("Security Concerns")).toBeDefined();
    expect(
      screen.getByText("SQL injection via template literal"),
    ).toBeDefined();
  });

  it("renders practice violations", () => {
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView />);
    expect(screen.getByText("Practice Violations")).toBeDefined();
    expect(screen.getByText("Direct database access")).toBeDefined();
  });

  it("renders go-to-line buttons for issues with line numbers", () => {
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView />);
    // startLine=10 + issueLine=5 - 1 = 14
    const goToLineButtons = screen.getAllByTitle(/Go to line/);
    expect(goToLineButtons.length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("L14").length).toBeGreaterThanOrEqual(1);
  });

  it("prefers query data over legacy when both are available", () => {
    // Query data is preferred because it includes edit state
    mockQueryData = mockEnrichedFunction;
    navMock.current = { view: "function-detail", params: { contentHash: "legacy123" } };

    render(<FunctionDetailView legacyData={mockLegacyData} />);
    // Query data wins even when legacy hash matches nav param
    expect(screen.getByText("authenticateUser")).toBeDefined();
    expect(screen.queryByText("legacyFunc")).toBeNull();

    // Restore nav mock
    navMock.current = { view: "function-detail", params: { contentHash: "abc123" } };
  });

  it("falls back to legacy data when query has not returned", () => {
    // No query data yet -- legacy is shown as instant fallback
    mockQueryData = undefined;
    navMock.current = { view: "function-detail", params: { contentHash: "legacy123" } };

    render(<FunctionDetailView legacyData={mockLegacyData} />);
    expect(screen.getByText("legacyFunc")).toBeDefined();
    expect(screen.getByText("A legacy function")).toBeDefined();

    // Restore nav mock
    navMock.current = { view: "function-detail", params: { contentHash: "abc123" } };
  });

  it("ignores legacy data when contentHash does not match nav param", () => {
    // Nav points to abc123, legacy data has legacy123 -- should use query data
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView legacyData={mockLegacyData} />);
    expect(screen.getByText("authenticateUser")).toBeDefined();
    expect(screen.queryByText("legacyFunc")).toBeNull();
  });

  it("moves remediated security issues to Pending Re-analysis section", () => {
    mockQueryData = {
      ...mockEnrichedFunction,
      editState: {
        "security:0": { adjustedLine: 14, potentiallyRemediated: true },
      },
    };

    render(<FunctionDetailView />);
    // Should NOT appear in Security Concerns
    expect(screen.queryByText("Security Concerns")).toBeNull();
    // Should appear in Pending Re-analysis
    expect(screen.getByText("Pending Re-analysis")).toBeDefined();
    expect(screen.getByText("SQL injection via template literal")).toBeDefined();
    // Byline text
    expect(
      screen.getByText(/These issues were recently edited/),
    ).toBeDefined();
    // Description should still be shown
    expect(
      screen.getByText("User input concatenated directly into SQL query."),
    ).toBeDefined();
  });

  it("moves remediated practice violations to Pending Re-analysis section", () => {
    mockQueryData = {
      ...mockEnrichedFunction,
      editState: {
        "practice:0": { adjustedLine: 14, potentiallyRemediated: true },
      },
    };

    render(<FunctionDetailView />);
    // Practice violation should not be in its own card
    expect(screen.queryByText("Practice Violations")).toBeNull();
    // Should appear in Pending Re-analysis with "practice" label
    expect(screen.getByText("Pending Re-analysis")).toBeDefined();
    expect(screen.getByText("Direct database access")).toBeDefined();
    expect(screen.getByText("practice")).toBeDefined();
  });

  it("does not render Pending Re-analysis when no issues are remediated", () => {
    mockQueryData = mockEnrichedFunction;

    render(<FunctionDetailView />);
    expect(screen.queryByText("Pending Re-analysis")).toBeNull();
    // Active issues should still be in their sections
    expect(screen.getByText("Security Concerns")).toBeDefined();
    expect(screen.getByText("Practice Violations")).toBeDefined();
  });

  it("shows stale banner when file has been edited", () => {
    mockQueryData = mockEnrichedFunction;
    mockAnalysisState = "stale";

    render(<FunctionDetailView />);
    expect(screen.getByText("Edited — pending re-analysis")).toBeDefined();
    expect(screen.queryByText("Re-analyzing...")).toBeNull();
  });

  it("shows analyzing banner during re-analysis", () => {
    mockQueryData = mockEnrichedFunction;
    mockAnalysisState = "analyzing";

    render(<FunctionDetailView />);
    expect(screen.getByText("Re-analyzing...")).toBeDefined();
    expect(screen.queryByText("Edited — pending re-analysis")).toBeNull();
  });

  it("shows no banner when analysis state is fresh", () => {
    mockQueryData = mockEnrichedFunction;
    mockAnalysisState = "fresh";

    render(<FunctionDetailView />);
    expect(screen.queryByText("Edited — pending re-analysis")).toBeNull();
    expect(screen.queryByText("Re-analyzing...")).toBeNull();
  });
});
