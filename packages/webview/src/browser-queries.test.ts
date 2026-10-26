import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FunctionData } from "./data";

// Mock getAllFunctions from data module
const mockGetAllFunctions = vi.fn<() => FunctionData[]>(() => []);
vi.mock("./data", () => ({
  getAllFunctions: () => mockGetAllFunctions(),
  getDb: () => null,
}));

// Import after mock setup
const { browserQueryHandler } = await import("./browser-queries");

function makeFn(overrides: Partial<FunctionData> = {}): FunctionData {
  return {
    name: "testFn",
    filePath: "src/test.ts",
    startLine: 1,
    endLine: 10,
    contentHash: "hash1",
    description: "A test function",
    params: [],
    returns: { type: "void", description: "" },
    dataTags: [],
    securityFlags: [],
    issues: [],
    practiceViolations: [],
    language: "typescript",
    entityType: "function",
    ...overrides,
  };
}

function makeIssue(
  flag: string,
  severity: string,
  _confidence = "medium",
): FunctionData["issues"][0] {
  return {
    flag,
    title: `${flag} issue`,
    description: "test description",
    explanation: "test explanation",
    line: 1,
    startText: "",
    endText: "",
    severity: severity as "error" | "warning" | "info",
  };
}

beforeEach(() => {
  mockGetAllFunctions.mockReturnValue([]);
});

// ── Router ──────────────────────────────────────────────────────

describe("browserQueryHandler routing", () => {
  it("throws on unknown method", async () => {
    await expect(browserQueryHandler("nonExistent")).rejects.toThrow(
      "Unknown method: nonExistent",
    );
  });

  it("routes to getSecurityDashboardStats", async () => {
    const result = await browserQueryHandler("getSecurityDashboardStats");
    expect(result).toHaveProperty("posture");
  });

  it("routes to getNavCounts", async () => {
    const result = await browserQueryHandler("getNavCounts");
    expect(result).toHaveProperty("functions");
    expect(result).toHaveProperty("securityIssues");
  });

  it("returns null for architecture detail queries", async () => {
    expect(await browserQueryHandler("getCommunityDetail")).toBeNull();
    expect(await browserQueryHandler("getGroupDetail")).toBeNull();
    expect(await browserQueryHandler("getConcernDetail")).toBeNull();
    expect(await browserQueryHandler("getConcernsIndex")).toBeNull();
  });

  it("returns null for dismiss/undismiss", async () => {
    expect(await browserQueryHandler("dismissIssue")).toBeNull();
    expect(await browserQueryHandler("undismissIssue")).toBeNull();
  });
});

// ── getSecurityDashboardStats ───────────────────────────────────

describe("getSecurityDashboardStats (browser)", () => {
  it("returns clean posture with no functions", async () => {
    const result = (await browserQueryHandler(
      "getSecurityDashboardStats",
    )) as any;
    expect(result.posture).toBe("clean");
    expect(result.criticalCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.totalFunctions).toBe(0);
  });

  it("counts severity levels correctly", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        contentHash: "h1",
        issues: [
          makeIssue("xss", "error", "high"),
          makeIssue("sqli", "error", "medium"),
          makeIssue("path_traversal", "warning"),
        ],
      }),
    ]);

    const result = (await browserQueryHandler(
      "getSecurityDashboardStats",
    )) as any;
    // error+high → score 3*3+3=12 >= 10 → critical
    // error+medium → score 3*3+2=11 >= 10 → also critical
    expect(result.criticalCount).toBe(2);
    expect(result.warningCount).toBe(1);
  });

  it("sets posture to critical when high-confidence error exists", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ issues: [makeIssue("sqli", "error", "high")] }),
    ]);
    const result = (await browserQueryHandler(
      "getSecurityDashboardStats",
    )) as any;
    expect(result.posture).toBe("critical");
  });

  it("sets posture to warning when only warnings exist", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ issues: [makeIssue("xss", "warning")] }),
    ]);
    const result = (await browserQueryHandler(
      "getSecurityDashboardStats",
    )) as any;
    expect(result.posture).toBe("warning");
  });

  it("builds per-flag breakdown", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("xss", "error"),
          makeIssue("xss", "warning"),
          makeIssue("sqli", "info"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler(
      "getSecurityDashboardStats",
    )) as any;
    expect(result.flagBreakdown["xss"].count).toBe(2);
    expect(result.flagBreakdown["xss"].errorCount).toBe(1);
    expect(result.flagBreakdown["xss"].warningCount).toBe(1);
    expect(result.flagBreakdown["sqli"].infoCount).toBe(1);
  });
});

// ── getTopIssues ────────────────────────────────────────────────

describe("getTopIssues (browser)", () => {
  it("returns empty array with no functions", async () => {
    const result = await browserQueryHandler("getTopIssues");
    expect(result).toEqual([]);
  });

  it("sorts by priority score descending", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("low_flag", "info", "low"),
          makeIssue("high_flag", "error", "high"),
          makeIssue("mid_flag", "warning", "medium"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler("getTopIssues")) as any[];
    expect(result[0].issue.flag).toBe("high_flag");
    expect(result[result.length - 1].issue.flag).toBe("low_flag");
  });

  it("limits results to specified count", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("a", "error"),
          makeIssue("b", "error"),
          makeIssue("c", "error"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler("getTopIssues", {
      limit: 2,
    })) as any[];
    expect(result).toHaveLength(2);
  });

  it("defaults to 8 results", async () => {
    const issues = Array.from({ length: 12 }, (_, i) =>
      makeIssue(`flag_${i}`, "warning"),
    );
    mockGetAllFunctions.mockReturnValue([makeFn({ issues })]);
    const result = (await browserQueryHandler("getTopIssues")) as any[];
    expect(result).toHaveLength(8);
  });

  it("includes function metadata", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        name: "authenticate",
        filePath: "src/auth.ts",
        contentHash: "abc",
        issues: [makeIssue("sqli", "error")],
      }),
    ]);
    const result = (await browserQueryHandler("getTopIssues")) as any[];
    expect(result[0].function_name).toBe("authenticate");
    expect(result[0].file_path).toBe("src/auth.ts");
    expect(result[0].content_hash).toBe("abc");
  });
});

// ── getSecurityIssues ───────────────────────────────────────────

describe("getSecurityIssues (browser)", () => {
  it("returns empty result with no functions", async () => {
    const result = (await browserQueryHandler("getSecurityIssues")) as any;
    expect(result).toEqual({ items: [], total: 0, page: 1 });
  });

  it("filters by flag", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("xss", "error"),
          makeIssue("sqli", "error"),
          makeIssue("xss", "warning"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler("getSecurityIssues", {
      flag: "xss",
    })) as any;
    expect(result.total).toBe(2);
    expect(result.items.every((i: any) => i.issue.flag === "xss")).toBe(true);
  });

  it("filters by severity", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("xss", "error"),
          makeIssue("sqli", "warning"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler("getSecurityIssues", {
      severity: "warning",
    })) as any;
    expect(result.total).toBe(1);
    expect(result.items[0].issue.flag).toBe("sqli");
  });

  it("paginates correctly", async () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue(`flag_${i}`, "error"),
    );
    mockGetAllFunctions.mockReturnValue([makeFn({ issues })]);

    const page1 = (await browserQueryHandler("getSecurityIssues", {
      page: 1,
      pageSize: 2,
    })) as any;
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = (await browserQueryHandler("getSecurityIssues", {
      page: 2,
      pageSize: 2,
    })) as any;
    expect(page2.items).toHaveLength(2);

    const page3 = (await browserQueryHandler("getSecurityIssues", {
      page: 3,
      pageSize: 2,
    })) as any;
    expect(page3.items).toHaveLength(1);
  });

  it("sorts by score descending", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        issues: [
          makeIssue("low", "info"),
          makeIssue("high", "error", "high"),
        ],
      }),
    ]);
    const result = (await browserQueryHandler("getSecurityIssues")) as any;
    expect(result.items[0].issue.flag).toBe("high");
    expect(result.items[1].issue.flag).toBe("low");
  });
});

// ── getEnrichedFunctions ────────────────────────────────────────

describe("getEnrichedFunctions (browser)", () => {
  it("returns empty result with no functions", async () => {
    const result = (await browserQueryHandler(
      "getEnrichedFunctions",
    )) as any;
    expect(result).toEqual({ items: [], total: 0, page: 1 });
  });

  it("returns enriched function format", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        name: "handleAuth",
        filePath: "src/auth.ts",
        contentHash: "abc",
        description: "Authenticates user",
        language: "typescript",
        entityType: "function",
        issues: [makeIssue("xss", "error")],
      }),
    ]);
    const result = (await browserQueryHandler(
      "getEnrichedFunctions",
    )) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].function_name).toBe("handleAuth");
    expect(result.items[0].file_path).toBe("src/auth.ts");
    expect(result.items[0].content_hash).toBe("abc");
    expect(result.items[0].analysis.documentation.description).toBe(
      "Authenticates user",
    );
    expect(result.items[0].analysis.security.issues).toHaveLength(1);
  });

  it("filters by search (function name)", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ name: "handleAuth", contentHash: "h1" }),
      makeFn({ name: "fetchData", contentHash: "h2" }),
      makeFn({ name: "handlePayment", contentHash: "h3" }),
    ]);
    const result = (await browserQueryHandler("getEnrichedFunctions", {
      search: "handle",
    })) as any;
    expect(result.total).toBe(2);
  });

  it("filters by search (file path)", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ filePath: "src/auth/login.ts", contentHash: "h1" }),
      makeFn({ filePath: "src/utils/helpers.ts", contentHash: "h2" }),
    ]);
    const result = (await browserQueryHandler("getEnrichedFunctions", {
      search: "auth",
    })) as any;
    expect(result.total).toBe(1);
    expect(result.items[0].file_path).toBe("src/auth/login.ts");
  });

  it("filters by language", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ language: "typescript", contentHash: "h1" }),
      makeFn({ language: "python", contentHash: "h2" }),
    ]);
    const result = (await browserQueryHandler("getEnrichedFunctions", {
      language: "python",
    })) as any;
    expect(result.total).toBe(1);
    expect(result.items[0].language).toBe("python");
  });

  it("filters securityOnly", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ contentHash: "h1", issues: [makeIssue("xss", "error")] }),
      makeFn({ contentHash: "h2", issues: [] }),
    ]);
    const result = (await browserQueryHandler("getEnrichedFunctions", {
      securityOnly: true,
    })) as any;
    expect(result.total).toBe(1);
    expect(result.items[0].content_hash).toBe("h1");
  });

  it("paginates correctly", async () => {
    const fns = Array.from({ length: 5 }, (_, i) =>
      makeFn({ name: `fn${i}`, contentHash: `h${i}` }),
    );
    mockGetAllFunctions.mockReturnValue(fns);

    const page1 = (await browserQueryHandler("getEnrichedFunctions", {
      page: 1,
      pageSize: 2,
    })) as any;
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page3 = (await browserQueryHandler("getEnrichedFunctions", {
      page: 3,
      pageSize: 2,
    })) as any;
    expect(page3.items).toHaveLength(1);
  });
});

// ── getEnrichedFunction ─────────────────────────────────────────

describe("getEnrichedFunction (browser)", () => {
  it("returns null for non-existent hash", async () => {
    const result = await browserQueryHandler("getEnrichedFunction", {
      contentHash: "nonexistent",
    });
    expect(result).toBeNull();
  });

  it("returns enriched data for matching hash", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        contentHash: "abc",
        name: "myFn",
        description: "Does stuff",
      }),
    ]);
    const result = (await browserQueryHandler("getEnrichedFunction", {
      contentHash: "abc",
    })) as any;
    expect(result).not.toBeNull();
    expect(result.function_name).toBe("myFn");
    expect(result.analysis.documentation.description).toBe("Does stuff");
  });
});

// ── getAvailableLanguages ───────────────────────────────────────

describe("getAvailableLanguages (browser)", () => {
  it("returns empty array with no functions", async () => {
    const result = await browserQueryHandler("getAvailableLanguages");
    expect(result).toEqual([]);
  });

  it("returns distinct languages sorted", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({ language: "python", contentHash: "h1" }),
      makeFn({ language: "typescript", contentHash: "h2" }),
      makeFn({ language: "python", contentHash: "h3" }),
    ]);
    const result = await browserQueryHandler("getAvailableLanguages");
    expect(result).toEqual(["python", "typescript"]);
  });
});

// ── getNavCounts ────────────────────────────────────────────────

describe("getNavCounts (browser)", () => {
  it("returns zeros with no functions", async () => {
    const result = (await browserQueryHandler("getNavCounts")) as any;
    expect(result).toEqual({ securityIssues: 0, functions: 0, practices: 0 });
  });

  it("counts functions and issues", async () => {
    mockGetAllFunctions.mockReturnValue([
      makeFn({
        contentHash: "h1",
        issues: [makeIssue("xss", "error"), makeIssue("sqli", "warning")],
      }),
      makeFn({ contentHash: "h2", issues: [makeIssue("path", "info")] }),
      makeFn({ contentHash: "h3", issues: [] }),
    ]);
    const result = (await browserQueryHandler("getNavCounts")) as any;
    expect(result.functions).toBe(3);
    expect(result.securityIssues).toBe(3);
    expect(result.practices).toBe(0);
  });
});

// ── getPractices / getArchitectureHierarchy ─────────────────────

describe("getPractices (browser)", () => {
  it("returns empty when no db is registered", async () => {
    const result = await browserQueryHandler("getPractices");
    expect(result).toEqual([]);
  });
});

describe("getArchitectureHierarchy (browser)", () => {
  it("returns null when no db is registered", async () => {
    const result = await browserQueryHandler("getArchitectureHierarchy");
    expect(result).toBeNull();
  });
});
