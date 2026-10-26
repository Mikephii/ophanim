import { describe, it, expect } from "vitest";
import {
  severityScore,
  confidenceScore,
  priorityScore,
  priorityLabel,
  flagTier,
  flattenIssues,
} from "./security-utils";
import type { EnrichedFunction } from "./types";

// ============ severityScore ============

describe("severityScore", () => {
  it("scores error=3, warning=2, info=1", () => {
    expect(severityScore("error")).toBe(3);
    expect(severityScore("warning")).toBe(2);
    expect(severityScore("info")).toBe(1);
  });

  it("defaults unknown severity to 1", () => {
    expect(severityScore("unknown")).toBe(1);
  });
});

// ============ confidenceScore ============

describe("confidenceScore", () => {
  it("scores high=3, medium=2, low=1", () => {
    expect(confidenceScore("high")).toBe(3);
    expect(confidenceScore("medium")).toBe(2);
    expect(confidenceScore("low")).toBe(1);
  });

  it("defaults unknown confidence to 1", () => {
    expect(confidenceScore("unknown")).toBe(1);
  });
});

// ============ priorityScore ============

describe("priorityScore", () => {
  it("returns max 12 for error+high", () => {
    expect(priorityScore("error", "high")).toBe(12);
  });

  it("returns min 4 for info+low", () => {
    expect(priorityScore("info", "low")).toBe(4);
  });

  it("returns intermediate scores", () => {
    expect(priorityScore("warning", "medium")).toBe(8);
    expect(priorityScore("error", "low")).toBe(10);
  });
});

// ============ priorityLabel ============

describe("priorityLabel", () => {
  it("maps score ranges to P0-P3", () => {
    expect(priorityLabel(12)).toBe("P0");
    expect(priorityLabel(9)).toBe("P1");
    expect(priorityLabel(11)).toBe("P1");
    expect(priorityLabel(6)).toBe("P2");
    expect(priorityLabel(8)).toBe("P2");
    expect(priorityLabel(5)).toBe("P3");
    expect(priorityLabel(4)).toBe("P3");
  });
});

// ============ flagTier ============

describe("flagTier", () => {
  it("returns tier from SECURITY_FLAG_META for known flags", () => {
    // sql_injection is tier 1 in the meta
    expect(flagTier("sql_injection")).toBe(1);
  });

  it("defaults to tier 3 for unknown flags", () => {
    expect(flagTier("totally_unknown_flag")).toBe(3);
  });
});

// ============ flattenIssues ============

function makeEnrichedFn(overrides: Partial<EnrichedFunction> = {}): EnrichedFunction {
  return {
    file_path: "src/test.ts",
    function_name: "testFn",
    content_hash: "hash1",
    language: "typescript",
    entity_type: "function",
    start_line: 1,
    analysis: {
      documentation: { description: "", params: [], returns: { type: "void", description: "" } },
      security: { dataTags: [], securityFlags: [], issues: [] },
      practices: { violations: [] },
    },
    ...overrides,
  };
}

function makeIssue(
  flag: string,
  severity: "error" | "warning" | "info",
  confidence: "high" | "medium" | "low" = "medium",
) {
  return {
    flag,
    title: `${flag} issue`,
    description: "test",
    explanation: "",
    line: 1,
    startText: "",
    endText: "",
    severity,
    confidence,
    lineText: "",
  };
}

describe("flattenIssues", () => {
  it("flattens issues from multiple functions", () => {
    const fns = [
      makeEnrichedFn({
        content_hash: "h1",
        analysis: {
          documentation: { description: "", params: [], returns: { type: "void", description: "" } },
          security: {
            dataTags: [],
            securityFlags: [],
            issues: [makeIssue("xss", "error"), makeIssue("sqli", "warning")],
          },
          practices: { violations: [] },
        },
      }),
      makeEnrichedFn({
        content_hash: "h2",
        analysis: {
          documentation: { description: "", params: [], returns: { type: "void", description: "" } },
          security: {
            dataTags: [],
            securityFlags: [],
            issues: [makeIssue("path_traversal", "info")],
          },
          practices: { violations: [] },
        },
      }),
    ];

    const flat = flattenIssues(fns);
    expect(flat).toHaveLength(3);
  });

  it("sorts by priority score (highest first)", () => {
    const fns = [
      makeEnrichedFn({
        analysis: {
          documentation: { description: "", params: [], returns: { type: "void", description: "" } },
          security: {
            dataTags: [],
            securityFlags: [],
            issues: [
              makeIssue("info_flag", "info", "low"),
              makeIssue("critical_flag", "error", "high"),
              makeIssue("mid_flag", "warning", "medium"),
            ],
          },
          practices: { violations: [] },
        },
      }),
    ];

    const flat = flattenIssues(fns);
    expect(flat[0].issue.flag).toBe("critical_flag");
    expect(flat[1].issue.flag).toBe("mid_flag");
    expect(flat[2].issue.flag).toBe("info_flag");
  });

  it("filters by flag when flagFilter is provided", () => {
    const fns = [
      makeEnrichedFn({
        analysis: {
          documentation: { description: "", params: [], returns: { type: "void", description: "" } },
          security: {
            dataTags: [],
            securityFlags: [],
            issues: [makeIssue("xss", "error"), makeIssue("sqli", "warning")],
          },
          practices: { violations: [] },
        },
      }),
    ];

    const flat = flattenIssues(fns, "xss");
    expect(flat).toHaveLength(1);
    expect(flat[0].issue.flag).toBe("xss");
  });

  it("returns empty array for functions with no issues", () => {
    const fns = [makeEnrichedFn()];
    expect(flattenIssues(fns)).toEqual([]);
  });

  it("returns empty array for empty functions array", () => {
    expect(flattenIssues([])).toEqual([]);
  });

  it("preserves issueIndex for each flattened issue", () => {
    const fns = [
      makeEnrichedFn({
        analysis: {
          documentation: { description: "", params: [], returns: { type: "void", description: "" } },
          security: {
            dataTags: [],
            securityFlags: [],
            issues: [
              makeIssue("a", "error", "high"),
              makeIssue("b", "error", "high"),
            ],
          },
          practices: { violations: [] },
        },
      }),
    ];

    const flat = flattenIssues(fns);
    expect(flat[0].issueIndex).toBe(0);
    expect(flat[1].issueIndex).toBe(1);
  });
});
