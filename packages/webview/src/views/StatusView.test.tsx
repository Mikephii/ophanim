import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusView } from "./StatusView";

// Mock navigation
const navMock = {
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "status", params: {} },
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
let mockError: string | undefined = undefined;
const mockMutate = vi.fn();

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: mockData,
    isLoading: mockLoading,
    error: mockError,
    refetch: vi.fn(),
  }),
  useWebviewMutation: () => ({
    mutate: mockMutate,
    isLoading: false,
    error: undefined,
  }),
}));

function makeStatus(overrides?: Record<string, unknown>) {
  return {
    mode: "vscode",
    watchRunning: false,
    watchError: null,
    analyzingFile: null,
    scanProgress: null,
    retryState: null,
    staleFiles: [],
    staleCount: 0,
    recentErrorCount: 0,
    activityLog: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockData = undefined;
  mockLoading = false;
  mockError = undefined;
  mockMutate.mockReset();
});

describe("StatusView", () => {
  it("shows loading skeleton when data is loading", () => {
    mockLoading = true;
    const { container } = render(<StatusView />);
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows error state", () => {
    mockError = "Something went wrong";
    render(<StatusView />);
    expect(screen.getAllByText("Something went wrong").length).toBeGreaterThan(0);
  });

  it("shows browser mode placeholder", () => {
    mockData = makeStatus({ mode: "browser" });
    render(<StatusView />);
    expect(screen.getByText("Status not available in browser mode")).toBeDefined();
  });

  it("shows watch running state", () => {
    mockData = makeStatus({ watchRunning: true });
    render(<StatusView />);
    expect(screen.getByText("Watch mode active")).toBeDefined();
  });

  it("shows not running state", () => {
    mockData = makeStatus({ watchRunning: false });
    render(<StatusView />);
    expect(screen.getByText("Not running")).toBeDefined();
  });

  it("shows stopped state with error message", () => {
    mockData = makeStatus({
      watchRunning: false,
      watchError: { type: "process_crash", message: "Process crashed", severity: "recoverable" },
    });
    render(<StatusView />);
    expect(screen.getByText("Stopped")).toBeDefined();
    expect(screen.getByText("Process crashed")).toBeDefined();
  });

  it("shows Analyze Now button", () => {
    mockData = makeStatus({ watchRunning: false });
    render(<StatusView />);
    expect(screen.getByText("Analyze Now")).toBeDefined();
  });

  it("shows Re-analyze when watch is running", () => {
    mockData = makeStatus({ watchRunning: true });
    render(<StatusView />);
    expect(screen.getByText("Re-analyze")).toBeDefined();
  });

  it("shows Restart when watch has error", () => {
    mockData = makeStatus({
      watchError: { type: "process_crash", message: "Crashed", severity: "recoverable" },
    });
    render(<StatusView />);
    expect(screen.getByText("Restart")).toBeDefined();
  });

  it("shows analyzing state with current file", () => {
    mockData = makeStatus({ watchRunning: true, analyzingFile: "src/auth.ts" });
    render(<StatusView />);
    expect(screen.getByText("Analyzing")).toBeDefined();
    expect(screen.getByText(/auth\.ts/)).toBeDefined();
  });

  it("shows scan progress bar", () => {
    mockData = makeStatus({
      watchRunning: true,
      scanProgress: { current: 5, total: 20 },
    });
    render(<StatusView />);
    expect(screen.getByText("5 / 20")).toBeDefined();
  });

  it("shows retry state", () => {
    mockData = makeStatus({
      watchRunning: true,
      retryState: { attempt: 2, maxAttempts: 3 },
    });
    render(<StatusView />);
    expect(screen.getByText(/Retry 2 \/ 3/)).toBeDefined();
  });

  it("shows pending files when stale", () => {
    mockData = makeStatus({
      staleFiles: ["/src/a.ts", "/src/b.ts"],
      staleCount: 2,
    });
    render(<StatusView />);
    expect(screen.getByText("2 files pending analysis")).toBeDefined();
  });

  it("hides pending files section when no stale files", () => {
    mockData = makeStatus();
    render(<StatusView />);
    expect(screen.queryByText(/pending analysis/)).toBeNull();
  });

  it("shows activity log entries", () => {
    mockData = makeStatus({
      activityLog: [
        { timestamp: Date.now() - 5000, category: "analysis", message: "Analyzed src/a.ts" },
        { timestamp: Date.now() - 1000, category: "error", message: "Something failed" },
      ],
    });
    render(<StatusView />);
    expect(screen.getByText("Analyzed src/a.ts")).toBeDefined();
    expect(screen.getByText("Something failed")).toBeDefined();
  });

  it("shows empty activity log message", () => {
    mockData = makeStatus({ activityLog: [] });
    render(<StatusView />);
    expect(screen.getByText("No recent activity.")).toBeDefined();
  });

  it("shows Output button", () => {
    mockData = makeStatus();
    render(<StatusView />);
    expect(screen.getByText("Output")).toBeDefined();
  });
});
