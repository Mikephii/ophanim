import { describe, it, expect } from "vitest";
import { resolveIssueRange, mapSeverity, buildDiagnosticMessage, findFunctionForLine, reResolveFileDiagnostics, deduplicateDiagnostics, type SymbolPosition, type IssueEditState, type ResolvedDiagnostic } from "./diagnostics";
import type { DetailedIssue, FunctionData } from "./types";

function makeIssue(overrides: Partial<DetailedIssue> = {}): DetailedIssue {
  return {
    flag: "sql_injection",
    title: "SQL injection via template literal",
    description: "User input concatenated into query.",
    explanation: "Use parameterized queries.",
    line: 3,
    startText: "const query = `SELECT",
    endText: "${userId}`",
    severity: "error",
    ...overrides,
  };
}

// Helper: builds a getLineText callback from an array of strings
function makeGetLineText(lines: string[]): (line0: number) => string {
  return (line0: number) => lines[line0] ?? "";
}

// ============ resolveIssueRange ============

describe("resolveIssueRange", () => {
  const lines = [
    "function getUser(userId: string) {",   // line 0 (file line 1, fn line 1)
    "  const db = getDb();",                  // line 1 (fn line 2)
    '  const query = `SELECT * FROM users WHERE id = ${userId}`;', // line 2 (fn line 3)
    "  return db.query(query);",              // line 3 (fn line 4)
    "}",                                      // line 4 (fn line 5)
  ];
  const getLineText = makeGetLineText(lines);
  const fnStart = 1; // 1-indexed
  const fnEnd = 5;
  const totalLines = 5;

  it("resolves exact range when both anchors found", () => {
    const issue = makeIssue({
      line: 3,
      startText: "const query = `SELECT",
      endText: "${userId}`",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(2); // 0-indexed
    expect(result.startChar).toBe(2); // after leading spaces
    expect(result.endLine).toBe(2);
    expect(result.endChar).toBe(lines[2].indexOf("${userId}`") + "${userId}`".length);
  });

  it("highlights startText to end of line when endText not found", () => {
    const issue = makeIssue({
      line: 3,
      startText: "const query",
      endText: "NOT_IN_LINE",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(2);
    expect(result.startChar).toBe(lines[2].indexOf("const query"));
    expect(result.endChar).toBe(lines[2].length);
  });

  it("highlights entire line when neither anchor found", () => {
    const issue = makeIssue({
      line: 3,
      startText: "NOT_IN_LINE",
      endText: "ALSO_NOT",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(2);
    expect(result.startChar).toBe(0);
    expect(result.endChar).toBe(lines[2].length);
  });

  it("finds anchor on correct line even when issue.line = 0", () => {
    // issue.line = 0 is invalid, so target falls back to function declaration.
    // But the nearby search finds startText on the actual issue line.
    const issue = makeIssue({ line: 0 });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(2); // found "const query = `SELECT" on line 2 (0-indexed)
    expect(result.startChar).toBe(lines[2].indexOf("const query = `SELECT"));
  });

  it("finds anchor on correct line even when issue.line exceeds range", () => {
    // issue.line = 99 is out of range, target falls back to function declaration.
    // But the nearby search finds startText on the actual issue line.
    const issue = makeIssue({ line: 99 });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(2); // found anchor on line 2 (0-indexed)
    expect(result.startChar).toBe(lines[2].indexOf("const query = `SELECT"));
  });

  it("highlights just startText span when endText is empty", () => {
    const issue = makeIssue({
      line: 3,
      startText: "const query",
      endText: "",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    const expectedStart = lines[2].indexOf("const query");
    expect(result.startChar).toBe(expectedStart);
    expect(result.endChar).toBe(expectedStart + "const query".length);
  });

  it("preserves correct offsets with leading whitespace", () => {
    const issue = makeIssue({
      line: 2,
      startText: "const db",
      endText: "",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startLine).toBe(1);
    expect(result.startChar).toBe(2); // after "  "
    expect(result.endChar).toBe(2 + "const db".length);
  });

  it("handles function starting at line > 1 in file", () => {
    // Function starts at file line 10 (1-indexed)
    const fileLines = [
      ...Array(9).fill("// comment"),
      "function foo() {",              // file line 10 (fn line 1)
      "  const x = dangerous();",      // file line 11 (fn line 2)
      "}",                             // file line 12 (fn line 3)
    ];
    const issue = makeIssue({
      line: 2,
      startText: "const x",
      endText: "",
    });

    const result = resolveIssueRange(issue, 10, 12, makeGetLineText(fileLines), 12);

    expect(result.startLine).toBe(10); // 0-indexed = file line 11
    expect(result.startChar).toBe(2);
  });

  it("highlights full line when startText is empty", () => {
    const issue = makeIssue({
      line: 3,
      startText: "",
      endText: "",
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.startChar).toBe(0);
    expect(result.endChar).toBe(lines[2].length);
  });

  it("finds anchor on nearby line when target line is stale (newline inserted above)", () => {
    // Simulates: user inserted a blank line above a 3-line function.
    // The function was at lines 1-3, now at 2-4 (1-indexed), but symbol positions
    // still report 1-3 (stale). The issue anchor should be found one line below.
    const fileLines = [
      "",                                      // inserted blank line
      "function getUser(userId: string) {",    // fn line 1 (was line 0 before insert)
      '  const query = `SELECT * FROM users WHERE id = ${userId}`;',
      "}",
    ];
    const issue = makeIssue({
      line: 2,
      startText: "const query",
      endText: "${userId}`",
    });

    // Stale positions: function reported at lines 1-3 (1-indexed) but actually at 2-4
    const result = resolveIssueRange(issue, 1, 3, makeGetLineText(fileLines), fileLines.length);

    // Should find "const query" on line 2 (0-indexed), not highlight blank line 1
    expect(result.startLine).toBe(2);
    expect(result.startChar).toBe(fileLines[2].indexOf("const query"));
    expect(result.endChar).toBe(fileLines[2].indexOf("${userId}`") + "${userId}`".length);
  });

  it("finds anchor on line above when target line is stale (line deleted above)", () => {
    // Function was at lines 2-5, a line was deleted above so it's now at 1-4.
    // Stale symbol says fn starts at line 2 (1-indexed).
    const fileLines = [
      "function process(data: string) {",   // fn line 1
      "  eval(data);",                       // fn line 2 -- the issue line
      "  return data;",
      "}",
    ];
    const issue = makeIssue({
      line: 2,
      startText: "eval(",
      endText: ")",
    });

    // Stale: fn reported at 2-5 (1-indexed) but file only has 4 lines.
    // targetLine0 = (2-1) + 2 - 1 = 2. "eval(" is on line 1. Nearby search finds it.
    const result = resolveIssueRange(issue, 2, 5, makeGetLineText(fileLines), fileLines.length);

    expect(result.startLine).toBe(1);
    expect(result.startChar).toBe(fileLines[1].indexOf("eval("));
    expect(result.endChar).toBe(fileLines[1].indexOf(")") + 1);
  });

  it("falls back to full-line on function declaration when anchor not found anywhere", () => {
    const fileLines = [
      "function fn() {",
      "  completelyRewritten();",
      "}",
    ];
    const issue = makeIssue({
      line: 2,
      startText: "originalCode",
      endText: "",
    });

    const result = resolveIssueRange(issue, 1, 3, makeGetLineText(fileLines), fileLines.length);

    // Anchor not found anywhere -- full-line highlight on the computed target line
    expect(result.startLine).toBe(1); // fn line 2 → 0-indexed 1
    expect(result.startChar).toBe(0);
    expect(result.endChar).toBe(fileLines[1].length);
  });
});

// ============ mapSeverity ============

describe("mapSeverity", () => {
  it("maps error to 0 (DiagnosticSeverity.Error)", () => {
    expect(mapSeverity("error")).toBe(0);
  });

  it("maps warning to 1 (DiagnosticSeverity.Warning)", () => {
    expect(mapSeverity("warning")).toBe(1);
  });

  it("maps info to 2 (DiagnosticSeverity.Information)", () => {
    expect(mapSeverity("info")).toBe(2);
  });

  it("defaults unknown severity to 1 (Warning)", () => {
    expect(mapSeverity("unknown")).toBe(1);
  });
});

// ============ buildDiagnosticMessage ============

describe("buildDiagnosticMessage", () => {
  it("returns title + description when both present", () => {
    const msg = buildDiagnosticMessage(makeIssue());
    expect(msg).toBe("SQL injection via template literal: User input concatenated into query.");
  });

  it("returns just title when description is empty", () => {
    const msg = buildDiagnosticMessage(makeIssue({ description: "" }));
    expect(msg).toBe("SQL injection via template literal");
  });

  it("falls back to flag when title is empty", () => {
    const msg = buildDiagnosticMessage(makeIssue({ title: "", description: "" }));
    expect(msg).toBe("sql_injection");
  });

  it("returns title when title present but description empty", () => {
    const msg = buildDiagnosticMessage(makeIssue({ title: "XSS risk", description: "" }));
    expect(msg).toBe("XSS risk");
  });
});

// ============ findFunctionForLine ============

function makeFn(overrides: Partial<FunctionData>): FunctionData {
  return {
    name: "testFn",
    filePath: "/test.ts",
    startLine: 1,
    endLine: 10,
    contentHash: "abc",
    description: "",
    params: [],
    returns: { type: "", description: "" },
    dataTags: [],
    securityFlags: [],
    issues: [],
    practiceViolations: [],
    language: "typescript",
    entityType: "function",
    ...overrides,
  };
}

describe("findFunctionForLine", () => {
  const fnA = makeFn({ name: "fnA", startLine: 1, endLine: 5 });
  const fnB = makeFn({ name: "fnB", startLine: 7, endLine: 15 });
  const fns = [fnA, fnB];

  it("finds function containing a 0-indexed line", () => {
    expect(findFunctionForLine(fns, 0)).toBe(fnA);   // line 0 → fnA (1-indexed lines 1-5)
    expect(findFunctionForLine(fns, 4)).toBe(fnA);   // line 4 → fnA end
    expect(findFunctionForLine(fns, 6)).toBe(fnB);   // line 6 → fnB (1-indexed line 7)
    expect(findFunctionForLine(fns, 14)).toBe(fnB);  // line 14 → fnB end
  });

  it("returns undefined for lines between functions", () => {
    expect(findFunctionForLine(fns, 5)).toBeUndefined(); // gap between fnA and fnB
  });

  it("returns undefined for lines after all functions", () => {
    expect(findFunctionForLine(fns, 20)).toBeUndefined();
  });

  it("returns undefined for empty function list", () => {
    expect(findFunctionForLine([], 0)).toBeUndefined();
  });

  it("skips functions with startLine = 0 (unknown)", () => {
    const noLine = makeFn({ name: "noLine", startLine: 0, endLine: 0 });
    expect(findFunctionForLine([noLine], 0)).toBeUndefined();
  });
});

// ============ reResolveFileDiagnostics ============

describe("reResolveFileDiagnostics", () => {
  it("re-resolves diagnostics with updated symbol positions after lines added above", () => {
    // Function was at lines 1-5, user added 2 lines above → now at lines 3-7
    const fn = makeFn({
      name: "getUser",
      startLine: 1,
      endLine: 5,
      issues: [makeIssue({ line: 3, startText: "const query", endText: "" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "getUser", startLine: 2, endLine: 6 }, // 0-indexed: file lines 3-7
    ];
    const lines = [
      "// added line 1",
      "// added line 2",
      "function getUser(userId: string) {",
      "  const db = getDb();",
      '  const query = `SELECT * FROM users`;',
      "  return db.query(query);",
      "}",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].range.startLine).toBe(4); // 0-indexed line with "const query"
    expect(diagnostics[0].range.startChar).toBe(2); // after "  "
  });

  it("returns empty when no cached functions have issues", () => {
    const fn = makeFn({ name: "clean", issues: [], practiceViolations: [] });
    const symbols: SymbolPosition[] = [{ name: "clean", startLine: 0, endLine: 5 }];

    const { diagnostics, gutterLines } = reResolveFileDiagnostics(
      [fn], symbols, makeGetLineText(["function clean() {}", "}"]), 2
    );

    expect(diagnostics).toEqual([]);
    expect(gutterLines).toEqual([]);
  });

  it("skips functions whose name is no longer in symbols (renamed)", () => {
    const fn = makeFn({
      name: "oldName",
      issues: [makeIssue()],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "newName", startLine: 0, endLine: 5 },
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(["function newName() {}"]), 1
    );

    expect(diagnostics).toEqual([]);
  });

  it("skips when function is deleted (no symbols)", () => {
    const fn = makeFn({
      name: "deleted",
      issues: [makeIssue()],
    });

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], [], makeGetLineText([""]), 1
    );

    expect(diagnostics).toEqual([]);
  });

  it("ignores symbols with no matching cached function (new function)", () => {
    const fn = makeFn({
      name: "existing",
      issues: [makeIssue({ line: 1, startText: "function", endText: "" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "existing", startLine: 0, endLine: 3 },
      { name: "brandNew", startLine: 5, endLine: 8 },
    ];
    const lines = [
      "function existing() {", "  return 1;", "}", "",
      "", "function brandNew() {", "  return 2;", "}", "",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].contentHash).toBe(fn.contentHash);
  });

  it("matches duplicate function names by positional index", () => {
    const fn1 = makeFn({
      name: "process",
      contentHash: "hash1",
      issues: [makeIssue({ line: 2, startText: "first", endText: "" })],
    });
    const fn2 = makeFn({
      name: "process",
      contentHash: "hash2",
      issues: [makeIssue({ line: 2, startText: "second", endText: "" })],
    });

    const freshSymbols: SymbolPosition[] = [
      { name: "process", startLine: 0, endLine: 2 },
      { name: "process", startLine: 4, endLine: 6 },
    ];
    const lines = [
      "function process() {", "  first();", "}",
      "",
      "function process() {", "  second();", "}",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn1, fn2], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].contentHash).toBe("hash1");
    expect(diagnostics[0].range.startLine).toBe(1); // line "  first();"
    expect(diagnostics[1].contentHash).toBe("hash2");
    expect(diagnostics[1].range.startLine).toBe(5); // line "  second();"
  });

  it("skips extra cached entries when fewer symbols exist (function deleted)", () => {
    const fn1 = makeFn({ name: "dup", contentHash: "h1", issues: [makeIssue({ line: 2, startText: "const query", endText: "" })] });
    const fn2 = makeFn({ name: "dup", contentHash: "h2", issues: [makeIssue()] });

    const freshSymbols: SymbolPosition[] = [
      { name: "dup", startLine: 0, endLine: 3 },
    ];
    const lines = [
      "function dup() {",
      '  const query = `SELECT * FROM users WHERE id = ${userId}`;',
      "  return;",
      "}",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn1, fn2], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].contentHash).toBe("h1");
  });

  it("deduplicates gutter lines across issues on the same line", () => {
    const fn = makeFn({
      name: "a",
      issues: [
        makeIssue({ line: 2, startText: "x", endText: "" }),
        makeIssue({ flag: "xss", title: "XSS", line: 2, startText: "x", endText: "" }),
      ],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "a", startLine: 0, endLine: 2 },
    ];
    const lines = ["function a() {", "  x = 1;", "}"];

    const { gutterLines } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(gutterLines).toEqual([1]);
  });

  it("returns gutter lines sorted across multiple functions", () => {
    const fn1 = makeFn({
      name: "b",
      issues: [makeIssue({ line: 1, startText: "function", endText: "" })],
    });
    const fn2 = makeFn({
      name: "a",
      issues: [makeIssue({ line: 1, startText: "function", endText: "" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "a", startLine: 0, endLine: 2 },
      { name: "b", startLine: 4, endLine: 6 },
    ];
    const lines = [
      "function a() {", "  x();", "}",
      "",
      "function b() {", "  y();", "}",
    ];

    const { gutterLines } = reResolveFileDiagnostics(
      [fn1, fn2], freshSymbols, makeGetLineText(lines), lines.length
    );

    // Should be sorted regardless of input order
    for (let i = 1; i < gutterLines.length; i++) {
      expect(gutterLines[i]).toBeGreaterThanOrEqual(gutterLines[i - 1]);
    }
  });

  it("includes practice violations in re-resolution", () => {
    const fn = makeFn({
      name: "fn",
      issues: [],
      practiceViolations: [makeIssue({ flag: "no-eval", title: "Eval usage", line: 2, startText: "eval(", endText: ")" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 3 },
    ];
    const lines = ["function fn() {", "  eval('code');", "  return;", "}"];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].flag).toBe("no-eval");
  });

  it("skips issues with empty title and empty flag", () => {
    const fn = makeFn({
      name: "fn",
      issues: [makeIssue({ title: "", flag: "" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 2 },
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(["function fn() {", "}", ""]), 3
    );

    expect(diagnostics).toEqual([]);
  });

  it("suppresses diagnostic when anchors no longer match after edit (remediation detection)", () => {
    const fn = makeFn({
      name: "fn",
      issues: [makeIssue({
        line: 2,
        startText: "originalCode",
        endText: "originalEnd",
      })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 2 },
    ];
    const lines = ["function fn() {", "  completelyDifferentCode();", "}"];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    // Anchors not found → anchorFound = false → diagnostic suppressed (not emitted)
    expect(diagnostics).toHaveLength(0);
  });

  it("returns empty for empty cached functions", () => {
    const { diagnostics, gutterLines } = reResolveFileDiagnostics(
      [],
      [{ name: "fn", startLine: 0, endLine: 5 }],
      makeGetLineText(["function fn() {}"]),
      1,
    );
    expect(diagnostics).toEqual([]);
    expect(gutterLines).toEqual([]);
  });

  it("populates all fields on ResolvedDiagnostic correctly", () => {
    const fn = makeFn({
      name: "fn",
      contentHash: "deadbeef",
      issues: [makeIssue({ flag: "sql_injection", severity: "error" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 4 },
    ];
    const lines = [
      "function fn(userId: string) {",
      "  const db = getDb();",
      '  const query = `SELECT * FROM users WHERE id = ${userId}`;',
      "  return db.query(query);",
      "}",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0];
    expect(d.source).toBe("Ophan");
    expect(d.flag).toBe("sql_injection");
    expect(d.severity).toBe(0); // error
    expect(d.contentHash).toBe("deadbeef");
    expect(d.message).toContain("SQL injection");
  });
});

// ============ Remediation Detection (lineText + anchorFound) ============

describe("resolveIssueRange — lineText modification detection", () => {
  const lines = [
    "function getUser(userId: string) {",   // line 0
    "  const db = getDb();",                  // line 1
    '  const query = `SELECT * FROM users WHERE id = ${userId}`;', // line 2
    "  return db.query(query);",              // line 3
    "}",                                      // line 4
  ];
  const getLineText = makeGetLineText(lines);
  const fnStart = 1;
  const fnEnd = 5;
  const totalLines = 5;

  it("returns anchorFound: true when lineText matches current line", () => {
    const issue = makeIssue({
      line: 3,
      lineText: 'const query = `SELECT * FROM users WHERE id = ${userId}`;',
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.anchorFound).toBe(true);
    expect(result.startChar).toBeGreaterThan(0); // anchor found, positioned correctly
  });

  it("returns anchorFound: false when lineText differs (code was edited)", () => {
    const issue = makeIssue({
      line: 3,
      startText: "const query",
      endText: "",
      lineText: 'const query = `SELECT * FROM users WHERE id = ${userId}`;',
    });

    // Simulate: user fixed the SQL injection -- line now has parameterized query
    const editedLines = [
      "function getUser(userId: string) {",
      "  const db = getDb();",
      '  const query = "SELECT * FROM users WHERE id = ?";', // FIXED
      "  return db.execute(query, [userId]);",
      "}",
    ];

    const result = resolveIssueRange(
      issue, fnStart, fnEnd, makeGetLineText(editedLines), editedLines.length
    );

    expect(result.anchorFound).toBe(false);
  });

  it("returns anchorFound: true when lineText is empty (old analysis, anchors present)", () => {
    // Old analysis without lineText -- fall back to anchor-only
    const issue = makeIssue({
      line: 3,
      lineText: undefined as unknown as string,
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.anchorFound).toBe(true);
  });

  it("returns anchorFound: false when lineText is empty and anchors missing (old analysis fallback)", () => {
    const issue = makeIssue({
      line: 3,
      startText: "NOT_IN_FILE",
      endText: "",
      lineText: undefined as unknown as string,
    });

    const result = resolveIssueRange(issue, fnStart, fnEnd, getLineText, totalLines);

    expect(result.anchorFound).toBe(false);
  });

  it("detects modification when line is commented out", () => {
    const issue = makeIssue({
      line: 2,
      startText: "eval(",
      endText: ")",
      lineText: "eval(data);",
    });

    const commentedLines = [
      "function process(data: string) {",
      "  // eval(data);",   // commented out -- lineText differs
      "}",
    ];

    const result = resolveIssueRange(
      issue, 1, 3, makeGetLineText(commentedLines), commentedLines.length
    );

    expect(result.anchorFound).toBe(false);
  });

  it("keeps squiggle when only indentation changes (trim normalization)", () => {
    const issue = makeIssue({
      line: 2,
      startText: "eval(",
      endText: ")",
      lineText: "eval(data);",
    });

    const reindentedLines = [
      "function process(data: string) {",
      "      eval(data);",   // extra indentation, but trimmed matches
      "}",
    ];

    const result = resolveIssueRange(
      issue, 1, 3, makeGetLineText(reindentedLines), reindentedLines.length
    );

    expect(result.anchorFound).toBe(true);
  });

  it("detects modification when arguments change but call pattern stays", () => {
    const issue = makeIssue({
      line: 2,
      startText: "eval(",
      endText: ")",
      lineText: "eval(data);",
    });

    const changedLines = [
      "function process(data: string) {",
      "  eval(sanitize(data));",   // both anchors match, but lineText differs
      "}",
    ];

    const result = resolveIssueRange(
      issue, 1, 3, makeGetLineText(changedLines), changedLines.length
    );

    expect(result.anchorFound).toBe(false);
  });

  it("works with line drift + lineText: anchor found on nearby line, lineText matches", () => {
    // User inserted a line above -- issue drifted down by 1.
    // Anchor search finds it on the nearby line. lineText still matches.
    const issue = makeIssue({
      line: 2,
      startText: "eval(",
      endText: ")",
      lineText: "eval(data);",
    });

    const driftedLines = [
      "function process(data: string) {",
      "  // new line inserted above",
      "  eval(data);",   // drifted to line 2 (0-indexed), was line 1
      "}",
    ];

    const result = resolveIssueRange(
      issue, 1, 4, makeGetLineText(driftedLines), driftedLines.length
    );

    expect(result.anchorFound).toBe(true);
    expect(result.startLine).toBe(2); // found on the drifted line
  });
});

describe("resolveIssueRange — lineText backfill enables remediation detection", () => {
  it("backfilled lineText detects modification that anchors miss (rename within line)", () => {
    // Scenario: processFile() has a path traversal issue on line 2.
    // Old analysis has no lineText (predates the feature). Anchors: "fs.readFileSync(".
    // User renames computeHash → computesHash. Anchors still match, but lineText differs.
    const issue = makeIssue({
      flag: "path_traversal",
      title: "Path traversal via unsanitized filePath",
      line: 2,
      startText: "fs.readFileSync(",
      endText: ")",
      lineText: "", // Old analysis -- no lineText
    });

    const originalLines = [
      "export function processFile(filePath: string): string {",
      '  return computeHash(fs.readFileSync(filePath, "utf-8"));',
      "}",
    ];

    // Step 1: Initial resolution -- anchors found, lineText empty → anchorFound: true
    const result1 = resolveIssueRange(
      issue, 1, 3, makeGetLineText(originalLines), originalLines.length
    );
    expect(result1.anchorFound).toBe(true);

    // Step 2: Backfill lineText (simulates what provideCodeLenses does)
    issue.lineText = originalLines[result1.startLine].trim();

    // Step 3: User renames computeHash → computesHash on the issue line
    const editedLines = [
      "export function processFile(filePath: string): string {",
      '  return computesHash(fs.readFileSync(filePath, "utf-8"));',
      "}",
    ];

    // Step 4: Re-resolution detects the modification via lineText
    const result2 = resolveIssueRange(
      issue, 1, 3, makeGetLineText(editedLines), editedLines.length
    );
    expect(result2.anchorFound).toBe(false); // Suppressed -- lineText differs
  });

  it("without backfill, anchors alone miss the modification", () => {
    // Same scenario as above, but WITHOUT backfill -- demonstrates the bug.
    const issue = makeIssue({
      flag: "path_traversal",
      line: 2,
      startText: "fs.readFileSync(",
      endText: ")",
      lineText: "", // No lineText, no backfill
    });

    const editedLines = [
      "export function processFile(filePath: string): string {",
      '  return computesHash(fs.readFileSync(filePath, "utf-8"));',
      "}",
    ];

    const result = resolveIssueRange(
      issue, 1, 3, makeGetLineText(editedLines), editedLines.length
    );

    // Anchors still match (fs.readFileSync is still there) → squiggle persists incorrectly
    expect(result.anchorFound).toBe(true);
  });
});

describe("reResolveFileDiagnostics — remediation suppression", () => {
  it("omits diagnostics when lineText differs (code modified)", () => {
    const fn = makeFn({
      name: "fn",
      issues: [makeIssue({
        line: 2,
        startText: "eval(",
        endText: ")",
        lineText: "eval(data);",
      })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 2 },
    ];
    // User fixed the issue -- line now different
    const lines = ["function fn() {", "  JSON.parse(data);", "}"];

    const { diagnostics, gutterLines } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(0);
    expect(gutterLines).toHaveLength(0);
  });

  it("keeps diagnostics when lineText matches (code unchanged)", () => {
    const fn = makeFn({
      name: "fn",
      issues: [makeIssue({
        line: 2,
        startText: "eval(",
        endText: ")",
        lineText: "eval(data);",
      })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 2 },
    ];
    const lines = ["function fn() {", "  eval(data);", "}"];

    const { diagnostics, gutterLines } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(gutterLines).toHaveLength(1);
  });

  it("omits gutter lines for suppressed diagnostics only", () => {
    const fn = makeFn({
      name: "fn",
      issues: [
        makeIssue({
          line: 2,
          startText: "eval(",
          endText: ")",
          lineText: "eval(data);",
        }),
        makeIssue({
          flag: "xss",
          title: "XSS via innerHTML",
          line: 3,
          startText: "innerHTML",
          endText: "",
          lineText: "el.innerHTML = safe;",
        }),
      ],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 3 },
    ];
    // eval line is modified, innerHTML line is unchanged
    const lines = [
      "function fn() {",
      "  JSON.parse(data);",       // eval line modified → suppressed
      "  el.innerHTML = safe;",     // unchanged → shown
      "}",
    ];

    const { diagnostics, gutterLines } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].flag).toBe("xss");
    expect(gutterLines).toEqual([2]); // only the innerHTML line
  });
});

// ============ issueEditStates in reResolveFileDiagnostics ============

describe("reResolveFileDiagnostics — issueEditStates", () => {
  it("returns edit states for all security issues including suppressed ones", () => {
    const fn = makeFn({
      name: "fn",
      contentHash: "abc123",
      issues: [
        makeIssue({
          line: 2,
          startText: "eval(",
          endText: ")",
          lineText: "eval(data);",
        }),
        makeIssue({
          flag: "xss",
          title: "XSS via innerHTML",
          line: 3,
          startText: "innerHTML",
          endText: "",
          lineText: "el.innerHTML = safe;",
        }),
      ],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 3 },
    ];
    // eval line is modified (remediated), innerHTML line is unchanged
    const lines = [
      "function fn() {",
      "  JSON.parse(data);",       // eval line modified → suppressed
      "  el.innerHTML = safe;",     // unchanged → shown
      "}",
    ];

    const { diagnostics, issueEditStates } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    // Only one diagnostic emitted (the non-suppressed one)
    expect(diagnostics).toHaveLength(1);

    // But edit states for ALL issues
    expect(issueEditStates).toHaveLength(2);

    // First issue -- remediated
    expect(issueEditStates[0].contentHash).toBe("abc123");
    expect(issueEditStates[0].issueType).toBe("security");
    expect(issueEditStates[0].issueIndex).toBe(0);
    expect(issueEditStates[0].potentiallyRemediated).toBe(true);

    // Second issue -- not remediated, positioned correctly
    expect(issueEditStates[1].issueIndex).toBe(1);
    expect(issueEditStates[1].adjustedLine).toBe(2);
    expect(issueEditStates[1].potentiallyRemediated).toBe(false);
  });

  it("returns edit states for practice violations with separate indexing", () => {
    const fn = makeFn({
      name: "fn",
      contentHash: "def456",
      issues: [makeIssue({ line: 2, startText: "eval(", endText: ")" })],
      practiceViolations: [
        makeIssue({ flag: "no-any", title: "Avoid any", line: 3, startText: "any", endText: "" }),
      ],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 3 },
    ];
    const lines = [
      "function fn() {",
      '  eval("code");',
      "  const x: any = 1;",
      "}",
    ];

    const { issueEditStates } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(issueEditStates).toHaveLength(2);

    // Security issue -- index 0, type "security"
    expect(issueEditStates[0].issueType).toBe("security");
    expect(issueEditStates[0].issueIndex).toBe(0);
    expect(issueEditStates[0].adjustedLine).toBe(1);

    // Practice violation -- index 0, type "practice" (separate counter)
    expect(issueEditStates[1].issueType).toBe("practice");
    expect(issueEditStates[1].issueIndex).toBe(0);
    expect(issueEditStates[1].adjustedLine).toBe(2);
  });

  it("returns empty edit states when no cached functions have issues", () => {
    const fn = makeFn({ name: "clean", issues: [], practiceViolations: [] });
    const symbols: SymbolPosition[] = [{ name: "clean", startLine: 0, endLine: 5 }];

    const { issueEditStates } = reResolveFileDiagnostics(
      [fn], symbols, makeGetLineText(["function clean() {}", "}"]), 2
    );

    expect(issueEditStates).toEqual([]);
  });

  it("records adjusted line after line shift", () => {
    // Function was at lines 1-5, user added 2 lines above → now at lines 3-7
    const fn = makeFn({
      name: "getUser",
      contentHash: "shifted",
      startLine: 1,
      endLine: 5,
      issues: [makeIssue({ line: 3, startText: "const query", endText: "" })],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "getUser", startLine: 2, endLine: 6 }, // 0-indexed: file lines 3-7
    ];
    const lines = [
      "// added line 1",
      "// added line 2",
      "function getUser(userId: string) {",
      "  const db = getDb();",
      '  const query = `SELECT * FROM users`;',
      "  return db.query(query);",
      "}",
    ];

    const { issueEditStates } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    expect(issueEditStates).toHaveLength(1);
    expect(issueEditStates[0].adjustedLine).toBe(4); // 0-indexed line with "const query"
    expect(issueEditStates[0].potentiallyRemediated).toBe(false);
  });
});

// ============ deduplicateDiagnostics ============

function makeResolvedDiag(overrides: Partial<ResolvedDiagnostic> = {}): ResolvedDiagnostic {
  return {
    range: { startLine: 5, startChar: 0, endLine: 5, endChar: 20, anchorFound: true },
    message: "SQL injection",
    severity: 0,
    source: "Ophan",
    flag: "sql_injection",
    contentHash: "abc",
    anchorFound: true,
    ...overrides,
  };
}

describe("deduplicateDiagnostics", () => {
  it("removes duplicates with same (line, flag)", () => {
    const diags = [
      makeResolvedDiag({ message: "SQL Injection Risk" }),
      makeResolvedDiag({ message: "Potential SQL Injection" }),
    ];

    const result = deduplicateDiagnostics(diags);

    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("SQL Injection Risk"); // keeps first
  });

  it("preserves different flags on the same line", () => {
    const diags = [
      makeResolvedDiag({ flag: "sql_injection" }),
      makeResolvedDiag({ flag: "xss" }),
    ];

    const result = deduplicateDiagnostics(diags);

    expect(result).toHaveLength(2);
  });

  it("preserves same flag on different lines", () => {
    const diags = [
      makeResolvedDiag({ range: { startLine: 5, startChar: 0, endLine: 5, endChar: 20, anchorFound: true } }),
      makeResolvedDiag({ range: { startLine: 10, startChar: 0, endLine: 10, endChar: 20, anchorFound: true } }),
    ];

    const result = deduplicateDiagnostics(diags);

    expect(result).toHaveLength(2);
  });

  it("returns empty for empty input", () => {
    expect(deduplicateDiagnostics([])).toEqual([]);
  });

  it("returns single diagnostic unchanged", () => {
    const diags = [makeResolvedDiag()];
    expect(deduplicateDiagnostics(diags)).toHaveLength(1);
  });
});

describe("reResolveFileDiagnostics — deduplication", () => {
  it("deduplicates diagnostics with same (line, flag) from Claude duplicates", () => {
    const fn = makeFn({
      name: "fn",
      issues: [
        makeIssue({ flag: "sql_injection", title: "SQL Injection Risk", line: 2, startText: "const query", endText: "" }),
        makeIssue({ flag: "sql_injection", title: "Potential SQL Injection", line: 2, startText: "const query", endText: "" }),
      ],
    });
    const freshSymbols: SymbolPosition[] = [
      { name: "fn", startLine: 0, endLine: 4 },
    ];
    const lines = [
      "function fn(userId: string) {",
      '  const query = `SELECT * FROM users WHERE id = ${userId}`;',
      "  return db.query(query);",
      "}",
      "",
    ];

    const { diagnostics } = reResolveFileDiagnostics(
      [fn], freshSymbols, makeGetLineText(lines), lines.length
    );

    // Should keep only 1, not 2
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("SQL Injection Risk"); // keeps first
  });
});
