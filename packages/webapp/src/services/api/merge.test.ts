import { describe, it, expect } from "vitest";
import { mergeAnalysisRows, buildAnalysisMap } from "./merge";
import { toFileLine } from "./line-utils";

// ============ mergeAnalysisRows ============
// Note: This returns nested { documentation, security } shape,
// unlike core's mergeAnalysisRows which returns flat shape.

describe("mergeAnalysisRows", () => {
  it("merges doc + sec rows into nested MergedAnalysis", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: {
          description: "Fetches user",
          params: [{ name: "id", type: "string", description: "user id" }],
          returns: { type: "User", description: "the user" },
        },
      },
      {
        analysis_type: "security",
        analysis: {
          dataTags: ["database", "pii"],
          securityFlags: ["sql_injection"],
        },
      },
    ]);

    expect(result.documentation.description).toBe("Fetches user");
    expect(result.documentation.params).toEqual([
      { name: "id", type: "string", description: "user id" },
    ]);
    expect(result.security.dataTags).toEqual(["database", "pii"]);
    expect(result.security.securityFlags).toEqual(["sql_injection"]);
  });

  it("handles missing documentation row — uses EMPTY_DOC defaults", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: { dataTags: ["internal"], securityFlags: [] },
      },
    ]);

    expect(result.documentation.description).toBe("");
    expect(result.documentation.params).toEqual([]);
    expect(result.documentation.returns).toEqual({
      type: "unknown",
      description: "",
    });
  });

  it("handles missing security row — uses EMPTY_SEC defaults", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: {
          description: "Test",
          params: [],
          returns: { type: "void", description: "" },
        },
      },
    ]);

    expect(result.security.dataTags).toEqual([]);
    expect(result.security.securityFlags).toEqual([]);
  });

  it("handles null analysis field — empty object fallback", () => {
    const result = mergeAnalysisRows([
      { analysis_type: "documentation", analysis: null as any },
    ]);

    expect(result.documentation.description).toBe("");
    expect(result.documentation.params).toEqual([]);
  });

  it("handles empty rows array — all defaults", () => {
    const result = mergeAnalysisRows([]);

    expect(result.documentation.description).toBe("");
    expect(result.documentation.params).toEqual([]);
    expect(result.documentation.returns).toEqual({
      type: "unknown",
      description: "",
    });
    expect(result.security.dataTags).toEqual([]);
    expect(result.security.securityFlags).toEqual([]);
    expect(result.security.issues).toEqual([]);
    expect(result.practices.violations).toEqual([]);
  });

  it("merges practices row into MergedAnalysis", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "practices",
        analysis: {
          violations: [{
            flag: "no-eval",
            title: "eval usage",
            description: "eval() detected.",
            explanation: "Use safer alternative.",
            line: 3,
            startText: "eval(",
            endText: ")",
            severity: "error",
          }],
        },
      },
    ]);

    expect(result.practices.violations).toHaveLength(1);
    expect(result.practices.violations[0].flag).toBe("no-eval");
  });

  it("defaults practices to empty when no practices row (backward compat)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: { description: "Test", params: [], returns: { type: "void", description: "" } },
      },
      {
        analysis_type: "security",
        analysis: { dataTags: [], securityFlags: [] },
      },
    ]);

    expect(result.practices.violations).toEqual([]);
  });

  it("merges v2 security rows with issues", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: {
          dataTags: ["database"],
          securityFlags: ["sql_injection"],
          issues: [{
            flag: "sql_injection",
            title: "SQL injection via template literal",
            description: "User input concatenated into query.",
            explanation: "Use parameterized queries.",
            line: 2,
            startText: "const query = `SELECT",
            endText: "${userId}`",
            severity: "error",
          }],
        },
      },
    ]);

    expect(result.security.issues).toHaveLength(1);
    expect(result.security.issues[0].flag).toBe("sql_injection");
    expect(result.security.issues[0].title).toBe("SQL injection via template literal");
    expect(result.security.issues[0].line).toBe(2);
  });

  it("defaults issues to empty for v1 security rows (backward compat)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: {
          dataTags: ["internal"],
          securityFlags: ["xss"],
          // no issues field
        },
      },
    ]);

    expect(result.security.securityFlags).toEqual(["xss"]);
    expect(result.security.issues).toEqual([]);
  });
});

// ============ buildAnalysisMap ============

describe("buildAnalysisMap", () => {
  it("groups rows by content_hash and merges each group", () => {
    const map = buildAnalysisMap([
      {
        content_hash: "hash1",
        analysis_type: "documentation",
        analysis: { description: "Fn 1" },
      },
      {
        content_hash: "hash1",
        analysis_type: "security",
        analysis: { dataTags: ["pii"], securityFlags: [] },
      },
      {
        content_hash: "hash2",
        analysis_type: "documentation",
        analysis: { description: "Fn 2" },
      },
      {
        content_hash: "hash2",
        analysis_type: "security",
        analysis: { dataTags: [], securityFlags: ["xss"] },
      },
    ]);

    expect(map.size).toBe(2);
    expect(map.get("hash1")!.documentation.description).toBe("Fn 1");
    expect(map.get("hash1")!.security.dataTags).toEqual(["pii"]);
    expect(map.get("hash2")!.security.securityFlags).toEqual(["xss"]);
  });

  it("handles single hash with single row — partial merge", () => {
    const map = buildAnalysisMap([
      {
        content_hash: "hash1",
        analysis_type: "security",
        analysis: { securityFlags: ["xss"] },
      },
    ]);

    expect(map.size).toBe(1);
    expect(map.get("hash1")!.documentation.description).toBe("");
    expect(map.get("hash1")!.security.securityFlags).toEqual(["xss"]);
  });

  it("returns empty Map for empty input", () => {
    const map = buildAnalysisMap([]);
    expect(map.size).toBe(0);
  });
});

// ============ toFileLine ============

describe("toFileLine", () => {
  it("computes file-absolute line when start_line is known", () => {
    expect(toFileLine(10, 3)).toBe(12); // 10 + 3 - 1
  });

  it("returns function-relative line when start_line is 0 (unknown)", () => {
    expect(toFileLine(0, 3)).toBe(3);
  });

  it("returns 0 when issue line is 0 (no line info)", () => {
    expect(toFileLine(10, 0)).toBe(0);
  });

  it("handles start_line of 1 (function at top of file)", () => {
    expect(toFileLine(1, 1)).toBe(1);
    expect(toFileLine(1, 5)).toBe(5);
  });
});
