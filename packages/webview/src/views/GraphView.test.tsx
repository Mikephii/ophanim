import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GraphView } from "./GraphView";

// Mock navigation
const navMock = {
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "graph", params: {} },
  canGoBack: true,
  depth: 2,
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
const mockRefetch = vi.fn();

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: () => ({
    data: mockData,
    isLoading: mockLoading,
    error: mockError,
    refetch: mockRefetch,
  }),
  useWebviewMutation: () => ({
    mutate: vi.fn(),
    isLoading: false,
    error: undefined,
  }),
}));

// Mock cytoscape -- it requires DOM APIs not available in jsdom
const mockCyInstance = {
  on: vi.fn(),
  destroy: vi.fn(),
  layout: vi.fn().mockReturnValue({ run: vi.fn() }),
  fit: vi.fn(),
};

vi.mock("cytoscape", () => ({
  default: vi.fn(() => mockCyInstance),
}));

const mockGraphData = {
  nodes: [
    {
      id: "hashA",
      label: "fnA",
      filePath: "src/a.ts",
      communityId: "comm_1",
      description: "Function A",
      securityFlags: [],
      issueCount: 0,
    },
    {
      id: "hashB",
      label: "fnB",
      filePath: "src/b.ts",
      communityId: "comm_1",
      description: "Function B",
      securityFlags: ["xss"],
      issueCount: 1,
    },
  ],
  edges: [
    { source: "hashA", target: "hashB", edgeType: "call", weight: 1.0 },
    { source: "hashA", target: "hashB", edgeType: "co_location", weight: 0.5 },
  ],
  communities: [
    { communityId: "comm_1", title: "Auth Module", memberCount: 2 },
  ],
};

beforeEach(() => {
  mockData = undefined;
  mockLoading = false;
  mockError = undefined;
  mockRefetch.mockClear();
  mockCyInstance.on.mockClear();
  mockCyInstance.destroy.mockClear();
  mockCyInstance.layout.mockClear();
  mockCyInstance.fit.mockClear();
});

describe("GraphView", () => {
  it("renders loading skeleton when loading", () => {
    mockLoading = true;
    render(<GraphView />);
    // Should not show the empty state
    expect(screen.queryByText("No graph data available")).toBeNull();
  });

  it("renders error state", () => {
    mockError = "Database not loaded";
    render(<GraphView />);
    expect(screen.getByText(/Database not loaded/)).toBeDefined();
  });

  it("renders empty state when no data", () => {
    mockData = undefined;
    render(<GraphView />);
    expect(screen.getByText("No graph data available")).toBeDefined();
  });

  it("renders controls and graph container with data", () => {
    mockData = mockGraphData;
    render(<GraphView />);

    // Edge type filter buttons
    expect(screen.getByRole("button", { name: /^Call( \(\d+\))?$/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Import( \(\d+\))?$/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Co-location( \(\d+\))?$/ })).toBeDefined();

    // Action buttons
    expect(screen.getByText("Color by community")).toBeDefined();
    expect(screen.getByText("Re-layout")).toBeDefined();
    expect(screen.getByText("Fit")).toBeDefined();

    // Stats
    expect(screen.getByText(/2 nodes/)).toBeDefined();
  });

  it("renders community legend when colored by community", () => {
    mockData = mockGraphData;
    render(<GraphView />);

    expect(screen.getByText("Communities")).toBeDefined();
    expect(screen.getByText(/Auth Module/)).toBeDefined();
  });

  it("toggles edge type visibility", () => {
    mockData = mockGraphData;
    render(<GraphView />);

    const callButton = screen.getByRole("button", { name: /^Call( \(\d+\))?$/ });
    // Initially active (has primary style)
    expect(callButton.className).toContain("text-primary");

    // Toggle off
    fireEvent.click(callButton);
    expect(callButton.className).toContain("text-muted-foreground");

    // Toggle back on
    fireEvent.click(callButton);
    expect(callButton.className).toContain("text-primary");
  });

  it("toggles community coloring", () => {
    mockData = mockGraphData;
    render(<GraphView />);

    const colorButton = screen.getByText("Color by community");
    expect(colorButton.className).toContain("text-primary");

    fireEvent.click(colorButton);
    expect(colorButton.className).toContain("text-muted-foreground");
  });

  it("updates edge count when filtering edge types", () => {
    mockData = mockGraphData;
    render(<GraphView />);

    // All edges visible: 2
    expect(screen.getByText(/2 edges/)).toBeDefined();

    // Toggle off co_location
    fireEvent.click(screen.getByRole("button", { name: /^Co-location( \(\d+\))?$/ }));

    // Now 1 edge (only call)
    expect(screen.getByText(/1 edges/)).toBeDefined();
  });
});
