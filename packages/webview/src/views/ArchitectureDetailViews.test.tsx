import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommunityView } from "./CommunityView";
import { GroupView } from "./GroupView";
import { ConcernView } from "./ConcernView";
import { ConcernsIndexView } from "./ConcernsIndexView";

// Mock navigation
const mockPush = vi.fn();
let mockRouteParams: Record<string, string> = {};

const makeNavMock = () => ({
  push: mockPush,
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
  current: { view: "community-detail", params: mockRouteParams },
  canGoBack: true,
  depth: 2,
  stack: [],
});
vi.mock("../navigation", () => ({
  useNavigation: () => makeNavMock(),
  useNavigationContext: () => makeNavMock(),
}));

// Query mock
let mockQueryData: Record<string, unknown> = {};
let mockLoading = false;

vi.mock("../use-webview-query", () => ({
  useWebviewQuery: (method: string) => ({
    data: mockQueryData[method],
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
  mockQueryData = {};
  mockLoading = false;
  mockRouteParams = {};
  mockPush.mockClear();
});

// ── CommunityView ──────────────────────────────────────────────

describe("CommunityView", () => {
  const communityDetail = {
    summary: {
      community_id: "comm_1",
      title: "Auth Module",
      documentation: "Handles **authentication**.",
      meta: { complexity: "medium" },
    },
    members: [
      {
        content_hash: "hash_a",
        function_name: "login",
        file_path: "src/auth.ts",
        description: "Login handler",
      },
      {
        content_hash: "hash_b",
        function_name: "logout",
        file_path: "src/auth.ts",
        description: "Logout handler",
      },
    ],
    relatedCommunities: [
      { communityId: "comm_2", title: "Data Layer", weight: 5, edgeCount: 10 },
    ],
    relatedConcerns: [
      {
        community_id: "concern_xss",
        title: "XSS Risk",
        concernType: "security",
        severity: "high",
        bridgeFunctions: [],
        affectedCommunities: [{ communityId: "comm_1", communityTitle: "Auth" }],
      },
    ],
  };

  it("shows empty state when no data", () => {
    mockRouteParams = { communityId: "comm_1" };
    render(<CommunityView />);
    expect(screen.getByText("Community not found")).toBeDefined();
  });

  it("renders member functions", () => {
    mockRouteParams = { communityId: "comm_1" };
    mockQueryData = { getCommunityDetail: communityDetail };

    render(<CommunityView />);
    expect(screen.getByText("login")).toBeDefined();
    expect(screen.getByText("logout")).toBeDefined();
  });

  it("navigates to function on member click", () => {
    mockRouteParams = { communityId: "comm_1" };
    mockQueryData = { getCommunityDetail: communityDetail };

    render(<CommunityView />);
    const loginBtn = screen.getByText("login").closest("button")!;
    fireEvent.click(loginBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "function-detail",
      params: { contentHash: "hash_a", filePath: "src/auth.ts" },
    });
  });

  it("renders related communities", () => {
    mockRouteParams = { communityId: "comm_1" };
    mockQueryData = { getCommunityDetail: communityDetail };

    render(<CommunityView />);
    expect(screen.getByText("Data Layer")).toBeDefined();
  });

  it("navigates to related community on click", () => {
    mockRouteParams = { communityId: "comm_1" };
    mockQueryData = { getCommunityDetail: communityDetail };

    render(<CommunityView />);
    const dataBtn = screen.getByText("Data Layer").closest("button")!;
    fireEvent.click(dataBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "community-detail",
      params: { communityId: "comm_2" },
    });
  });

  it("renders related concerns", () => {
    mockRouteParams = { communityId: "comm_1" };
    mockQueryData = { getCommunityDetail: communityDetail };

    render(<CommunityView />);
    expect(screen.getByText("XSS Risk")).toBeDefined();
  });
});

// ── GroupView ──────────────────────────────────────────────────

describe("GroupView", () => {
  const groupDetail = {
    summary: {
      community_id: "group_0",
      title: "Backend Systems",
      documentation: "Backend group documentation.",
      meta: {},
    },
    communities: [
      {
        community_id: "comm_1",
        title: "Auth",
        documentation: "Auth subsystem",
        meta: {},
      },
      {
        community_id: "comm_2",
        title: "Data",
        documentation: "Data layer",
        meta: { complexity: "high" },
      },
    ],
  };

  it("shows empty state when no data", () => {
    mockRouteParams = { groupId: "group_0" };
    render(<GroupView />);
    expect(screen.getByText("Group not found")).toBeDefined();
  });

  it("renders child communities", () => {
    mockRouteParams = { groupId: "group_0" };
    mockQueryData = { getGroupDetail: groupDetail };

    render(<GroupView />);
    expect(screen.getByText("Auth")).toBeDefined();
    expect(screen.getByText("Data")).toBeDefined();
  });

  it("navigates to community on click", () => {
    mockRouteParams = { groupId: "group_0" };
    mockQueryData = { getGroupDetail: groupDetail };

    render(<GroupView />);
    const authBtn = screen.getByText("Auth").closest("button")!;
    fireEvent.click(authBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "community-detail",
      params: { communityId: "comm_1" },
    });
  });
});

// ── ConcernView ───────────────────────────────────────────────

describe("ConcernView", () => {
  const concernDetail = {
    community_id: "concern_xss",
    title: "XSS Risk",
    concernType: "security",
    tag: "xss",
    documentation: "Cross-site scripting risk across subsystems.",
    severity: "high",
    bridgeFunctions: [
      { functionName: "renderHTML", contentHash: "hash_r", communityId: "comm_1", centrality: 0.9 },
    ],
    affectedCommunities: [
      { communityId: "comm_1", communityTitle: "Auth Module" },
    ],
    bridgeMembers: [
      {
        content_hash: "hash_r",
        function_name: "renderHTML",
        file_path: "src/render.ts",
        description: "Renders HTML content",
      },
    ],
  };

  it("shows empty state when no data", () => {
    mockRouteParams = { concernId: "concern_xss" };
    render(<ConcernView />);
    expect(screen.getByText("Concern not found")).toBeDefined();
  });

  it("renders bridge functions", () => {
    mockRouteParams = { concernId: "concern_xss" };
    mockQueryData = { getConcernDetail: concernDetail };

    render(<ConcernView />);
    expect(screen.getByText("renderHTML")).toBeDefined();
  });

  it("navigates to function on bridge click", () => {
    mockRouteParams = { concernId: "concern_xss" };
    mockQueryData = { getConcernDetail: concernDetail };

    render(<ConcernView />);
    const fnBtn = screen.getByText("renderHTML").closest("button")!;
    fireEvent.click(fnBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "function-detail",
      params: { contentHash: "hash_r", filePath: "src/render.ts" },
    });
  });

  it("renders affected communities", () => {
    mockRouteParams = { concernId: "concern_xss" };
    mockQueryData = { getConcernDetail: concernDetail };

    render(<ConcernView />);
    expect(screen.getByText("Auth Module")).toBeDefined();
  });

  it("navigates to community on affected click", () => {
    mockRouteParams = { concernId: "concern_xss" };
    mockQueryData = { getConcernDetail: concernDetail };

    render(<ConcernView />);
    const commBtn = screen.getByText("Auth Module").closest("button")!;
    fireEvent.click(commBtn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "community-detail",
      params: { communityId: "comm_1" },
    });
  });

  it("shows severity badge", () => {
    mockRouteParams = { concernId: "concern_xss" };
    mockQueryData = { getConcernDetail: concernDetail };

    render(<ConcernView />);
    expect(screen.getAllByText("high").length).toBeGreaterThanOrEqual(1);
  });
});

// ── ConcernsIndexView ────────────────────────────────────────

describe("ConcernsIndexView", () => {
  it("shows empty state when no concerns", () => {
    mockQueryData = { getConcernsIndex: [] };
    render(<ConcernsIndexView />);
    expect(screen.getByText("No cross-cutting concerns detected")).toBeDefined();
  });

  it("renders concern cards", () => {
    mockQueryData = {
      getConcernsIndex: [
        {
          community_id: "concern_xss",
          title: "XSS Risk",
          concernType: "security",
          severity: "high",
          bridgeFunctions: [{}],
          affectedCommunities: [{ communityId: "c1", communityTitle: "Auth" }],
        },
        {
          community_id: "concern_sqli",
          title: "SQL Injection",
          concernType: "security",
          severity: "medium",
          bridgeFunctions: [],
          affectedCommunities: [],
        },
      ],
    };

    render(<ConcernsIndexView />);
    expect(screen.getByText("XSS Risk")).toBeDefined();
    expect(screen.getByText("SQL Injection")).toBeDefined();
  });

  it("navigates to concern on click", () => {
    mockQueryData = {
      getConcernsIndex: [
        {
          community_id: "concern_xss",
          title: "XSS Risk",
          concernType: "security",
          severity: "high",
          bridgeFunctions: [],
          affectedCommunities: [],
        },
      ],
    };

    render(<ConcernsIndexView />);
    const btn = screen.getByText("XSS Risk").closest("button")!;
    fireEvent.click(btn);
    expect(mockPush).toHaveBeenCalledWith({
      view: "concern-detail",
      params: { concernId: "concern_xss" },
    });
  });
});
