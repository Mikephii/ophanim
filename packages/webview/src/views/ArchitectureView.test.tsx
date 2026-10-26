import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArchitectureView } from "./ArchitectureView";

// Mock navigation
const mockPush = vi.fn();

const navMock = {
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "architecture", params: {} },
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

const mockHierarchy = {
  l3: {
    community_id: "architecture",
    level: 3,
    title: "Architecture Overview",
    documentation: "This is the **architecture** documentation.",
    meta: {},
  },
  groups: [
    {
      groupId: "group_0",
      title: "Backend Systems",
      documentation: "Backend group overview",
      communities: [
        {
          community_id: "comm_1",
          level: 1,
          title: "Auth Module",
          documentation: "Authentication subsystem",
          meta: { complexity: "medium", keyFunctions: ["login", "logout"] },
        },
        {
          community_id: "comm_2",
          level: 1,
          title: "Data Layer",
          documentation: "Database access",
          meta: { complexity: "high" },
        },
      ],
    },
  ],
  ungrouped: [
    {
      community_id: "comm_3",
      level: 1,
      title: "Utilities",
      documentation: "Shared utility functions",
      meta: {},
    },
  ],
  crossCutting: [
    {
      community_id: "concern_xss",
      title: "XSS Risk",
      concernType: "security",
      tag: "xss",
      documentation: "Cross-site scripting pattern",
      severity: "high",
      bridgeFunctions: [{ contentHash: "h1" }, { contentHash: "h2" }],
      affectedCommunities: [
        { communityId: "comm_1", communityTitle: "Auth Module" },
      ],
    },
  ],
};

beforeEach(() => {
  mockData = undefined;
  mockLoading = false;
  mockPush.mockClear();
});

describe("ArchitectureView", () => {
  it("shows loading skeleton when loading", () => {
    mockLoading = true;

    const { container } = render(<ArchitectureView />);
    const skeletons = container.querySelectorAll("[data-slot='skeleton']");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no data", () => {
    render(<ArchitectureView />);
    expect(screen.getByText("No architecture analysis found")).toBeDefined();
  });

  it("renders L3 documentation as markdown", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    // Markdown renders "architecture" as text (bold tags stripped)
    expect(screen.getByText(/architecture/)).toBeDefined();
  });

  it("renders groups with nested communities", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    expect(screen.getByText("Backend Systems")).toBeDefined();
    expect(screen.getByText("Auth Module")).toBeDefined();
    expect(screen.getByText("Data Layer")).toBeDefined();
  });

  it("renders ungrouped communities", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    expect(screen.getByText("Utilities")).toBeDefined();
  });

  it("renders cross-cutting concerns", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    expect(screen.getByText("XSS Risk")).toBeDefined();
    expect(screen.getByText("1 subsystem")).toBeDefined();
    expect(screen.getByText("2 bridge fns")).toBeDefined();
  });

  it("navigates to community detail on card click", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    const authButton = screen.getByText("Auth Module");
    fireEvent.click(authButton.closest("button")!);
    expect(mockPush).toHaveBeenCalledWith({
      view: "community-detail",
      params: { communityId: "comm_1" },
    });
  });

  it("navigates to group detail on group title click", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    const groupButton = screen.getByText("Backend Systems");
    fireEvent.click(groupButton.closest("button")!);
    expect(mockPush).toHaveBeenCalledWith({
      view: "group-detail",
      params: { groupId: "group_0" },
    });
  });

  it("navigates to concern detail on concern card click", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    const xssButton = screen.getByText("XSS Risk");
    fireEvent.click(xssButton.closest("button")!);
    expect(mockPush).toHaveBeenCalledWith({
      view: "concern-detail",
      params: { concernId: "concern_xss" },
    });
  });

  it("shows complexity and severity badges", () => {
    mockData = mockHierarchy;

    render(<ArchitectureView />);
    expect(screen.getByText("medium")).toBeDefined();
    // "high" appears in both complexity badge (Data Layer) and severity badge (XSS Risk)
    expect(screen.getAllByText("high").length).toBeGreaterThanOrEqual(2);
  });
});
