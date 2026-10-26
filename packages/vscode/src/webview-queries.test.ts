import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  getNavCounts,
  tableExists,
  getSecurityDashboardStats,
  getTopIssues,
  getSecurityIssues,
  dismissIssue,
  undismissIssue,
  getEnrichedFunctions,
  getEnrichedFunction,
  getAvailableLanguages,
  getArchitectureHierarchy,
  getCommunityDetail,
  getGroupDetail,
  getConcernDetail,
  getConcernsIndex,
  getPractices,
  getEditStateMap,
  resolveCurrentHash,
  getGraphData,
} from "./webview-queries";

let db: BetterSqlite3.Database;

function createTestDb(): BetterSqlite3.Database {
  const testDb = new BetterSqlite3(":memory:");
  testDb.exec(`
    CREATE TABLE function_analysis (
      content_hash TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      analysis JSON NOT NULL,
      model_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      synced_at INTEGER,
      PRIMARY KEY (content_hash, analysis_type)
    )
  `);
  testDb.exec(`
    CREATE TABLE file_functions (
      file_path TEXT NOT NULL,
      function_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      start_line INTEGER NOT NULL DEFAULT 0
    )
  `);
  testDb.exec(`
    CREATE TABLE dismissed_issues (
      content_hash TEXT NOT NULL,
      issue_index INTEGER NOT NULL,
      flag TEXT NOT NULL,
      reason TEXT NOT NULL,
      note TEXT,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, issue_index)
    )
  `);
  testDb.exec(`
    CREATE TABLE issue_edit_state (
      content_hash TEXT NOT NULL,
      issue_type TEXT NOT NULL,
      issue_index INTEGER NOT NULL,
      adjusted_line INTEGER NOT NULL,
      potentially_remediated INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (content_hash, issue_type, issue_index)
    )
  `);
  return testDb;
}

function insertFileFunction(
  testDb: BetterSqlite3.Database,
  filePath: string,
  functionName: string,
  hash: string,
) {
  testDb.prepare(
    `INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime)
     VALUES (?, ?, ?, ?)`
  ).run(filePath, functionName, hash, Date.now());
}

function insertSecurityAnalysis(
  testDb: BetterSqlite3.Database,
  hash: string,
  issues: unknown[] = [],
  flags: string[] = [],
) {
  const now = Math.floor(Date.now() / 1000);
  const analysis = JSON.stringify({ dataTags: [], securityFlags: flags, issues });
  testDb.prepare(
    `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
     VALUES (?, 'security', ?, 'claude-3', 2, ?, ?)`
  ).run(hash, analysis, now, now);
}

function insertDocAnalysis(
  testDb: BetterSqlite3.Database,
  hash: string,
  description = "test function",
) {
  const now = Math.floor(Date.now() / 1000);
  const analysis = JSON.stringify({
    description,
    params: [],
    returns: { type: "void", description: "" },
  });
  testDb.prepare(
    `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
     VALUES (?, 'documentation', ?, 'claude-3', 1, ?, ?)`
  ).run(hash, analysis, now, now);
}

function makeIssue(
  flag: string,
  severity: string,
  confidence = "medium",
  overrides: Record<string, unknown> = {},
) {
  return {
    flag,
    title: `${flag} issue`,
    description: "test description",
    explanation: "test explanation",
    line: 1,
    startText: "",
    endText: "",
    severity,
    confidence,
    ...overrides,
  };
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db?.close();
});

describe("tableExists", () => {
  it("returns true for existing table", () => {
    expect(tableExists(db, "function_analysis")).toBe(true);
    expect(tableExists(db, "file_functions")).toBe(true);
  });

  it("returns false for non-existing table", () => {
    expect(tableExists(db, "practices")).toBe(false);
  });
});

describe("getNavCounts", () => {
  it("returns zeros on empty database", () => {
    const counts = getNavCounts(db);
    expect(counts).toEqual({ securityIssues: 0, functions: 0, practices: 0 });
  });

  it("counts distinct functions", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertFileFunction(db, "src/b.ts", "fnB", "hash2");
    // Same hash in different file -- should still count as 1 distinct
    insertFileFunction(db, "src/c.ts", "fnA", "hash1");

    const counts = getNavCounts(db);
    expect(counts.functions).toBe(2);
  });

  it("counts security issues across functions", () => {
    insertSecurityAnalysis(db, "hash1", [
      { flag: "xss", title: "XSS", description: "test", explanation: "", line: 1, startText: "", endText: "", severity: "error" },
      { flag: "sqli", title: "SQL Injection", description: "test", explanation: "", line: 2, startText: "", endText: "", severity: "error" },
    ]);
    insertSecurityAnalysis(db, "hash2", [
      { flag: "xss", title: "Another XSS", description: "test", explanation: "", line: 1, startText: "", endText: "", severity: "warning" },
    ]);

    const counts = getNavCounts(db);
    expect(counts.securityIssues).toBe(3);
  });

  it("counts practices when table exists", () => {
    db.exec(`
      CREATE TABLE practices (
        practice_id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      )
    `);
    db.exec("INSERT INTO practices VALUES ('no-any', 'Avoid using any type', 'warning')");
    db.exec("INSERT INTO practices VALUES ('error-handling', 'Always handle errors', 'error')");

    const counts = getNavCounts(db);
    expect(counts.practices).toBe(2);
  });

  it("returns zero practices when table does not exist", () => {
    const counts = getNavCounts(db);
    expect(counts.practices).toBe(0);
  });

  it("handles malformed security JSON gracefully", () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 2, ?, ?)`
    ).run("bad-hash", "not valid json{", now, now);

    // Should not throw, just skip the malformed row
    const counts = getNavCounts(db);
    expect(counts.securityIssues).toBe(0);
  });
});

// ============ getSecurityDashboardStats ============

describe("getSecurityDashboardStats", () => {
  it("returns clean posture on empty database", () => {
    const stats = getSecurityDashboardStats(db);
    expect(stats.posture).toBe("clean");
    expect(stats.criticalCount).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.warningCount).toBe(0);
    expect(stats.totalFunctions).toBe(0);
    expect(stats.flagBreakdown).toEqual({});
  });

  it("counts severity levels correctly", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "error", "medium"),
      makeIssue("path_traversal", "warning"),
    ]);

    const stats = getSecurityDashboardStats(db);
    expect(stats.criticalCount).toBe(1); // error+high
    expect(stats.errorCount).toBe(2);    // all errors
    expect(stats.warningCount).toBe(1);
  });

  it("sets posture to critical when error+high confidence exists", () => {
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("sqli", "error", "high"),
    ]);
    expect(getSecurityDashboardStats(db).posture).toBe("critical");
  });

  it("sets posture to warning when errors exist but no high confidence", () => {
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("sqli", "error", "medium"),
    ]);
    expect(getSecurityDashboardStats(db).posture).toBe("warning");
  });

  it("sets posture to warning when only warnings exist", () => {
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "warning"),
    ]);
    expect(getSecurityDashboardStats(db).posture).toBe("warning");
  });

  it("builds per-flag breakdown", () => {
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error"),
      makeIssue("xss", "warning"),
      makeIssue("sqli", "error"),
    ]);

    const stats = getSecurityDashboardStats(db);
    expect(stats.flagBreakdown["xss"]).toEqual({
      count: 2,
      errorCount: 1,
      warningCount: 1,
      infoCount: 0,
    });
    expect(stats.flagBreakdown["sqli"]).toEqual({
      count: 1,
      errorCount: 1,
      warningCount: 0,
      infoCount: 0,
    });
  });

  it("counts totalFunctions from file_functions", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertFileFunction(db, "src/b.ts", "fnB", "hash2");

    const stats = getSecurityDashboardStats(db);
    expect(stats.totalFunctions).toBe(2);
  });

  it("handles v1 security rows (flags but no issues)", () => {
    const now = Math.floor(Date.now() / 1000);
    const analysis = JSON.stringify({
      dataTags: [],
      securityFlags: ["xss", "sqli"],
    });
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 1, ?, ?)`
    ).run("hash1", analysis, now, now);

    const stats = getSecurityDashboardStats(db);
    expect(stats.warningCount).toBe(2);
    expect(stats.flagBreakdown["xss"].count).toBe(1);
    expect(stats.flagBreakdown["sqli"].count).toBe(1);
  });

  it("excludes dismissed issues", () => {
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "warning"),
    ]);
    // Dismiss the first issue
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });

    const stats = getSecurityDashboardStats(db);
    expect(stats.errorCount).toBe(0);
    expect(stats.criticalCount).toBe(0);
    expect(stats.warningCount).toBe(1);
  });
});

// ============ getTopIssues ============

describe("getTopIssues", () => {
  it("returns empty array on empty database", () => {
    expect(getTopIssues(db)).toEqual([]);
  });

  it("returns issues sorted by priority score (highest first)", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("info_flag", "info", "low"),
      makeIssue("critical_flag", "error", "high"),
      makeIssue("mid_flag", "warning", "medium"),
    ]);

    const issues = getTopIssues(db);
    expect(issues).toHaveLength(3);
    expect(issues[0].issue.flag).toBe("critical_flag");
    expect(issues[1].issue.flag).toBe("mid_flag");
    expect(issues[2].issue.flag).toBe("info_flag");
  });

  it("limits results to specified count", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("a", "error"),
      makeIssue("b", "error"),
      makeIssue("c", "error"),
    ]);

    const issues = getTopIssues(db, 2);
    expect(issues).toHaveLength(2);
  });

  it("includes function location metadata", () => {
    insertFileFunction(db, "src/auth.ts", "authenticate", "hash1");
    insertSecurityAnalysis(db, "hash1", [makeIssue("sqli", "error")]);

    const issues = getTopIssues(db);
    expect(issues[0].function_name).toBe("authenticate");
    expect(issues[0].file_path).toBe("src/auth.ts");
    expect(issues[0].content_hash).toBe("hash1");
  });

  it("skips issues without matching file_functions location", () => {
    // Security analysis without corresponding file_functions entry
    insertSecurityAnalysis(db, "orphan-hash", [makeIssue("xss", "error")]);

    const issues = getTopIssues(db);
    expect(issues).toHaveLength(0);
  });

  it("excludes dismissed issues", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "warning"),
    ]);
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });

    const issues = getTopIssues(db);
    expect(issues).toHaveLength(1);
    expect(issues[0].issue.flag).toBe("sqli");
  });
});

// ============ getEnrichedFunctions ============

describe("getEnrichedFunctions", () => {
  it("returns empty result on empty database", () => {
    const result = getEnrichedFunctions(db);
    expect(result).toEqual({ items: [], total: 0, page: 1 });
  });

  it("returns functions with merged analysis", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertDocAnalysis(db, "hash1", "Fetches user data");
    insertSecurityAnalysis(db, "hash1", [makeIssue("xss", "warning")]);

    const result = getEnrichedFunctions(db);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].function_name).toBe("fnA");
    expect(result.items[0].analysis.documentation.description).toBe("Fetches user data");
    expect(result.items[0].analysis.security.issues).toHaveLength(1);
  });

  it("deduplicates by content_hash", () => {
    // Same hash in multiple files
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertFileFunction(db, "src/b.ts", "fnA", "hash1");
    insertDocAnalysis(db, "hash1");

    const result = getEnrichedFunctions(db);
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("paginates correctly", () => {
    for (let i = 0; i < 5; i++) {
      insertFileFunction(db, `src/${i}.ts`, `fn${i}`, `hash${i}`);
    }

    const page1 = getEnrichedFunctions(db, { page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);

    const page2 = getEnrichedFunctions(db, { page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(2);

    const page3 = getEnrichedFunctions(db, { page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
  });

  it("filters by search term (function name)", () => {
    insertFileFunction(db, "src/a.ts", "handleAuth", "hash1");
    insertFileFunction(db, "src/b.ts", "fetchData", "hash2");
    insertFileFunction(db, "src/c.ts", "handlePayment", "hash3");

    const result = getEnrichedFunctions(db, { search: "handle" });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("filters by search term (file path)", () => {
    insertFileFunction(db, "src/auth/login.ts", "fnA", "hash1");
    insertFileFunction(db, "src/utils/helpers.ts", "fnB", "hash2");

    const result = getEnrichedFunctions(db, { search: "auth" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].file_path).toBe("src/auth/login.ts");
  });

  it("filters by language", () => {
    db.prepare(
      "INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language) VALUES (?, ?, ?, ?, ?)"
    ).run("src/a.ts", "fnA", "hash1", Date.now(), "typescript");
    db.prepare(
      "INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language) VALUES (?, ?, ?, ?, ?)"
    ).run("src/b.py", "fn_b", "hash2", Date.now(), "python");

    const result = getEnrichedFunctions(db, { language: "python" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].language).toBe("python");
  });

  it("filters securityOnly to functions with issues", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertFileFunction(db, "src/b.ts", "fnB", "hash2");
    insertSecurityAnalysis(db, "hash1", [makeIssue("xss", "error")]);
    insertSecurityAnalysis(db, "hash2", []); // no issues

    const result = getEnrichedFunctions(db, { securityOnly: true });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].content_hash).toBe("hash1");
  });
});

// ============ getEnrichedFunction ============

describe("getEnrichedFunction", () => {
  it("returns null for non-existent hash", () => {
    expect(getEnrichedFunction(db, "nonexistent")).toBeNull();
  });

  it("returns enriched function with merged analysis", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertDocAnalysis(db, "hash1", "Does something");
    insertSecurityAnalysis(db, "hash1", [makeIssue("xss", "warning")]);

    const fn = getEnrichedFunction(db, "hash1");
    expect(fn).not.toBeNull();
    expect(fn!.function_name).toBe("fnA");
    expect(fn!.file_path).toBe("src/a.ts");
    expect(fn!.analysis.documentation.description).toBe("Does something");
    expect(fn!.analysis.security.issues).toHaveLength(1);
  });

  it("returns defaults for missing analysis types", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    // No analysis rows at all

    const fn = getEnrichedFunction(db, "hash1");
    expect(fn).not.toBeNull();
    expect(fn!.analysis.documentation.description).toBe("");
    expect(fn!.analysis.security.issues).toEqual([]);
    expect(fn!.analysis.practices.violations).toEqual([]);
  });

  it("includes editState when db has matching entries", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high", { line: 5 }),
      makeIssue("sqli", "warning", "medium", { line: 10 }),
    ]);

    db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("hash1", "security", 0, 42, 1, Date.now());

    const fn = getEnrichedFunction(db, "hash1");
    expect(fn).not.toBeNull();
    expect(fn!.editState).toBeDefined();
    expect(fn!.editState!["security:0"]).toEqual({
      adjustedLine: 42,
      potentiallyRemediated: true,
    });
    expect(fn!.editState!["security:1"]).toBeUndefined();
  });

  it("returns undefined editState when db has no entries for this hash", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [makeIssue("xss", "error")]);

    db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("other-hash", "security", 0, 10, 0, Date.now());

    const fn = getEnrichedFunction(db, "hash1");
    expect(fn).not.toBeNull();
    expect(fn!.editState).toBeUndefined();
  });

  it("includes practice violation edit state", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'practices', ?, 'claude-3', 1, ?, ?)`
    ).run("hash1", JSON.stringify({ violations: [makeIssue("no-any", "warning")] }), now, now);

    db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("hash1", "practice", 0, 15, 0, Date.now());

    const fn = getEnrichedFunction(db, "hash1");
    expect(fn!.editState).toBeDefined();
    expect(fn!.editState!["practice:0"]).toEqual({
      adjustedLine: 15,
      potentiallyRemediated: false,
    });
  });
});

// ============ resolveCurrentHash ============

describe("resolveCurrentHash", () => {
  it("returns current hash when function exists at file path", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash_new");

    const result = resolveCurrentHash(db, "login", "src/auth.ts");
    expect(result).toEqual({ contentHash: "hash_new" });
  });

  it("returns null when function was deleted (no matching row)", () => {
    // No file_functions rows at all
    const result = resolveCurrentHash(db, "login", "src/auth.ts");
    expect(result).toBeNull();
  });

  it("returns null when function was renamed (old name not found)", () => {
    insertFileFunction(db, "src/auth.ts", "authenticate", "hash_new");

    const result = resolveCurrentHash(db, "login", "src/auth.ts");
    expect(result).toBeNull();
  });

  it("returns null when functionName is empty", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");

    expect(resolveCurrentHash(db, "", "src/auth.ts")).toBeNull();
  });

  it("returns null when filePath is empty", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");

    expect(resolveCurrentHash(db, "login", "")).toBeNull();
  });

  it("matches exact file path (not partial)", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertFileFunction(db, "src/other/auth.ts", "login", "hash2");

    const result = resolveCurrentHash(db, "login", "src/auth.ts");
    expect(result).toEqual({ contentHash: "hash1" });
  });
});

// ============ getAvailableLanguages ============

describe("getAvailableLanguages", () => {
  it("returns empty array on empty database", () => {
    expect(getAvailableLanguages(db)).toEqual([]);
  });

  it("returns distinct languages sorted alphabetically", () => {
    db.prepare(
      "INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language) VALUES (?, ?, ?, ?, ?)"
    ).run("a.py", "fn_a", "h1", Date.now(), "python");
    db.prepare(
      "INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language) VALUES (?, ?, ?, ?, ?)"
    ).run("b.ts", "fnB", "h2", Date.now(), "typescript");
    db.prepare(
      "INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language) VALUES (?, ?, ?, ?, ?)"
    ).run("c.py", "fn_c", "h3", Date.now(), "python");

    const langs = getAvailableLanguages(db);
    expect(langs).toEqual(["python", "typescript"]);
  });
});

// ============ getSecurityIssues ============

describe("getSecurityIssues", () => {
  it("returns empty result on empty database", () => {
    const result = getSecurityIssues(db);
    expect(result).toEqual({ items: [], total: 0, page: 1 });
  });

  it("returns all issues sorted by priority", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("info_flag", "info", "low"),
      makeIssue("critical_flag", "error", "high"),
      makeIssue("mid_flag", "warning", "medium"),
    ]);

    const result = getSecurityIssues(db);
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].issue.flag).toBe("critical_flag");
    expect(result.items[2].issue.flag).toBe("info_flag");
  });

  it("filters by flag", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error"),
      makeIssue("sqli", "error"),
      makeIssue("xss", "warning"),
    ]);

    const result = getSecurityIssues(db, { flag: "xss" });
    expect(result.total).toBe(2);
    expect(result.items.every((i) => i.issue.flag === "xss")).toBe(true);
  });

  it("filters by severity", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error"),
      makeIssue("sqli", "warning"),
      makeIssue("path_traversal", "error"),
    ]);

    const result = getSecurityIssues(db, { severity: "warning" });
    expect(result.total).toBe(1);
    expect(result.items[0].issue.flag).toBe("sqli");
  });

  it("filters by dataTag", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertFileFunction(db, "src/b.ts", "fnB", "hash2");

    // hash1 has user_input tag, hash2 doesn't
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 2, ?, ?)`
    ).run("hash1", JSON.stringify({ dataTags: ["user_input"], securityFlags: ["xss"], issues: [makeIssue("xss", "error")] }), now, now);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 2, ?, ?)`
    ).run("hash2", JSON.stringify({ dataTags: ["database"], securityFlags: ["sqli"], issues: [makeIssue("sqli", "error")] }), now, now);

    const result = getSecurityIssues(db, { dataTag: "user_input" });
    expect(result.total).toBe(1);
    expect(result.items[0].issue.flag).toBe("xss");
  });

  it("paginates correctly", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("a", "error"),
      makeIssue("b", "error"),
      makeIssue("c", "error"),
      makeIssue("d", "warning"),
      makeIssue("e", "warning"),
    ]);

    const page1 = getSecurityIssues(db, { page: 1, pageSize: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = getSecurityIssues(db, { page: 2, pageSize: 2 });
    expect(page2.items).toHaveLength(2);

    const page3 = getSecurityIssues(db, { page: 3, pageSize: 2 });
    expect(page3.items).toHaveLength(1);
  });

  it("excludes dismissed issues by default", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "warning"),
    ]);
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });

    const result = getSecurityIssues(db);
    expect(result.total).toBe(1);
    expect(result.items[0].issue.flag).toBe("sqli");
  });

  it("includes dismissed issues when showDismissed is true", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "warning"),
    ]);
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });

    const result = getSecurityIssues(db, { showDismissed: true });
    expect(result.total).toBe(2);
    const dismissed = result.items.find((i) => i.dismissed);
    expect(dismissed).toBeDefined();
    expect(dismissed!.issue.flag).toBe("xss");
  });

  it("includes function location metadata", () => {
    insertFileFunction(db, "src/auth.ts", "authenticate", "hash1");
    insertSecurityAnalysis(db, "hash1", [makeIssue("sqli", "error")]);

    const result = getSecurityIssues(db);
    expect(result.items[0].function_name).toBe("authenticate");
    expect(result.items[0].file_path).toBe("src/auth.ts");
    expect(result.items[0].content_hash).toBe("hash1");
  });
});

// ============ dismissIssue / undismissIssue ============

describe("dismissIssue", () => {
  it("is a no-op when db is null", () => {
    dismissIssue(null, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });
    // No error thrown
  });

  it("inserts a dismissed issue row into db", () => {
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "accepted_risk",
      note: "reviewed and accepted",
    });

    const row = db.prepare(
      "SELECT * FROM dismissed_issues WHERE content_hash = ? AND issue_index = ?",
    ).get("hash1", 0) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.flag).toBe("xss");
    expect(row.reason).toBe("accepted_risk");
    expect(row.note).toBe("reviewed and accepted");
    expect(row.dismissed_at).toBeGreaterThan(0);
  });

  it("replaces existing dismiss on same content_hash+issue_index", () => {
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "accepted_risk",
      note: "updated",
    });

    const count = db.prepare(
      "SELECT COUNT(*) as c FROM dismissed_issues WHERE content_hash = ? AND issue_index = ?",
    ).get("hash1", 0) as { c: number };
    expect(count.c).toBe(1);

    const row = db.prepare(
      "SELECT reason FROM dismissed_issues WHERE content_hash = ? AND issue_index = ?",
    ).get("hash1", 0) as { reason: string };
    expect(row.reason).toBe("accepted_risk");
  });
});

describe("undismissIssue", () => {
  it("removes a dismissed issue from db", () => {
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });

    undismissIssue(db, { contentHash: "hash1", issueIndex: 0 });

    const count = db.prepare(
      "SELECT COUNT(*) as c FROM dismissed_issues",
    ).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("is a no-op when db is null", () => {
    undismissIssue(null, { contentHash: "hash1", issueIndex: 0 });
  });

  it("only removes the specified issue, not others", () => {
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 0,
      flag: "xss",
      reason: "false_positive",
    });
    dismissIssue(db, {
      contentHash: "hash1",
      issueIndex: 1,
      flag: "sqli",
      reason: "accepted_risk",
    });

    undismissIssue(db, { contentHash: "hash1", issueIndex: 0 });

    const count = db.prepare("SELECT COUNT(*) as c FROM dismissed_issues")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });
});

// ============ Architecture Queries ============

function createArchTables(testDb: BetterSqlite3.Database) {
  testDb.exec(`
    CREATE TABLE community_summaries (
      community_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      input_hash TEXT NOT NULL,
      summary JSON NOT NULL,
      model_version TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, level, algorithm)
    )
  `);
  testDb.exec(`
    CREATE TABLE communities (
      content_hash TEXT NOT NULL,
      level INTEGER NOT NULL,
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      PRIMARY KEY (content_hash, level, algorithm)
    )
  `);
  testDb.exec(`
    CREATE TABLE community_edges (
      source_community TEXT NOT NULL,
      target_community TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      weight REAL,
      edge_count INTEGER
    )
  `);
}

function insertSummary(
  testDb: BetterSqlite3.Database,
  communityId: string,
  level: number,
  summary: Record<string, unknown>,
) {
  testDb.prepare(
    `INSERT INTO community_summaries (community_id, level, algorithm, input_hash, summary, created_at)
     VALUES (?, ?, 'louvain', 'hash', ?, ?)`
  ).run(communityId, level, JSON.stringify(summary), Date.now());
}

function insertMembership(
  testDb: BetterSqlite3.Database,
  contentHash: string,
  level: number,
  communityId: string,
) {
  testDb.prepare(
    `INSERT INTO communities (content_hash, level, community_id, algorithm)
     VALUES (?, ?, ?, 'louvain')`
  ).run(contentHash, level, communityId);
}

function insertEdge(
  testDb: BetterSqlite3.Database,
  source: string,
  target: string,
  weight = 1,
  edgeCount = 1,
) {
  testDb.prepare(
    `INSERT INTO community_edges (source_community, target_community, algorithm, weight, edge_count)
     VALUES (?, ?, 'louvain', ?, ?)`
  ).run(source, target, weight, edgeCount);
}

describe("getArchitectureHierarchy", () => {
  it("returns null when community_summaries table does not exist", () => {
    expect(getArchitectureHierarchy(db)).toBeNull();
  });

  it("returns null when no summaries exist", () => {
    createArchTables(db);
    expect(getArchitectureHierarchy(db)).toBeNull();
  });

  it("returns L3 overview with L1 communities", () => {
    createArchTables(db);
    insertSummary(db, "architecture", 3, {
      title: "Architecture Overview",
      documentation: "High-level doc",
    });
    insertSummary(db, "comm_1", 1, {
      title: "Auth Module",
      documentation: "Auth subsystem",
      meta: { complexity: "medium" },
    });
    insertSummary(db, "comm_2", 1, {
      title: "Data Module",
      documentation: "Data subsystem",
    });

    const result = getArchitectureHierarchy(db);
    expect(result).not.toBeNull();
    expect(result!.l3!.title).toBe("Architecture Overview");
    expect(result!.ungrouped).toHaveLength(2);
    expect(result!.ungrouped[0].title).toBe("Auth Module");
    expect(result!.ungrouped[1].title).toBe("Data Module");
  });

  it("groups L1 communities under L2 groups", () => {
    createArchTables(db);
    insertSummary(db, "architecture", 3, { title: "Overview" });
    insertSummary(db, "group_0", 2, {
      title: "Backend Systems",
      documentation: "Backend group",
    });
    insertSummary(db, "comm_1", 1, { title: "Auth" });
    insertSummary(db, "comm_2", 1, { title: "Data" });
    insertSummary(db, "comm_3", 1, { title: "UI" });

    // Map L1 comm_1 and comm_2 to L2 group_0
    insertMembership(db, "comm_1", 1, "group_0");
    insertMembership(db, "comm_2", 1, "group_0");

    const result = getArchitectureHierarchy(db);
    expect(result!.groups).toHaveLength(1);
    expect(result!.groups[0].title).toBe("Backend Systems");
    expect(result!.groups[0].communities).toHaveLength(2);
    // comm_3 is ungrouped
    expect(result!.ungrouped).toHaveLength(1);
    expect(result!.ungrouped[0].title).toBe("UI");
  });

  it("includes cross-cutting concerns", () => {
    createArchTables(db);
    insertSummary(db, "comm_1", 1, { title: "Auth" });
    insertSummary(db, "concern_sql_injection", 10, {
      title: "SQL Injection Risk",
      concernType: "security",
      tag: "sql_injection",
      documentation: "SQL injection across subsystems",
      severity: "high",
      bridgeFunctions: [],
      affectedCommunities: [{ communityId: "comm_1", communityTitle: "Auth" }],
    });

    const result = getArchitectureHierarchy(db);
    expect(result!.crossCutting).toHaveLength(1);
    expect(result!.crossCutting[0].title).toBe("SQL Injection Risk");
    expect(result!.crossCutting[0].severity).toBe("high");
  });
});

describe("getCommunityDetail", () => {
  it("returns null when tables don't exist", () => {
    expect(getCommunityDetail(db, "comm_1")).toBeNull();
  });

  it("returns null for non-existent community", () => {
    createArchTables(db);
    expect(getCommunityDetail(db, "nonexistent")).toBeNull();
  });

  it("returns summary with members", () => {
    createArchTables(db);
    insertSummary(db, "comm_1", 1, {
      title: "Auth Module",
      documentation: "Handles authentication",
    });

    // Add function members
    insertFileFunction(db, "src/auth.ts", "login", "hash_a");
    insertFileFunction(db, "src/auth.ts", "logout", "hash_b");
    insertDocAnalysis(db, "hash_a", "Login handler");
    insertDocAnalysis(db, "hash_b", "Logout handler");

    // Map functions to community at L0
    insertMembership(db, "hash_a", 0, "comm_1");
    insertMembership(db, "hash_b", 0, "comm_1");

    const result = getCommunityDetail(db, "comm_1");
    expect(result).not.toBeNull();
    expect(result!.summary.title).toBe("Auth Module");
    expect(result!.members).toHaveLength(2);
    expect(result!.members[0].function_name).toBe("login");
    expect(result!.members[0].description).toBe("Login handler");
  });

  it("returns related communities from edges", () => {
    createArchTables(db);
    insertSummary(db, "comm_1", 1, { title: "Auth" });
    insertSummary(db, "comm_2", 1, { title: "Data" });
    insertSummary(db, "comm_3", 1, { title: "Utils" });

    insertEdge(db, "comm_1", "comm_2", 5, 10);
    insertEdge(db, "comm_3", "comm_1", 2, 3);

    const result = getCommunityDetail(db, "comm_1");
    expect(result!.relatedCommunities).toHaveLength(2);
    // Sorted by edgeCount descending
    expect(result!.relatedCommunities[0].communityId).toBe("comm_2");
    expect(result!.relatedCommunities[0].edgeCount).toBe(10);
    expect(result!.relatedCommunities[1].communityId).toBe("comm_3");
  });

  it("returns related cross-cutting concerns", () => {
    createArchTables(db);
    insertSummary(db, "comm_1", 1, { title: "Auth" });
    insertSummary(db, "concern_xss", 10, {
      title: "XSS Risk",
      concernType: "security",
      tag: "xss",
      severity: "medium",
      affectedCommunities: [{ communityId: "comm_1", communityTitle: "Auth" }],
      bridgeFunctions: [],
    });
    insertSummary(db, "concern_unrelated", 10, {
      title: "Unrelated",
      concernType: "security",
      tag: "other",
      severity: "low",
      affectedCommunities: [{ communityId: "comm_2", communityTitle: "Data" }],
      bridgeFunctions: [],
    });

    const result = getCommunityDetail(db, "comm_1");
    expect(result!.relatedConcerns).toHaveLength(1);
    expect(result!.relatedConcerns[0].title).toBe("XSS Risk");
  });
});

describe("getGroupDetail", () => {
  it("returns null when tables don't exist", () => {
    expect(getGroupDetail(db, "group_0")).toBeNull();
  });

  it("returns null for non-existent group", () => {
    createArchTables(db);
    expect(getGroupDetail(db, "nonexistent")).toBeNull();
  });

  it("returns group summary with child communities", () => {
    createArchTables(db);
    insertSummary(db, "group_0", 2, {
      title: "Backend Systems",
      documentation: "Backend overview",
    });
    insertSummary(db, "comm_1", 1, { title: "Auth" });
    insertSummary(db, "comm_2", 1, { title: "Data" });

    // Map L1 to L2 group
    insertMembership(db, "comm_1", 1, "group_0");
    insertMembership(db, "comm_2", 1, "group_0");

    const result = getGroupDetail(db, "group_0");
    expect(result).not.toBeNull();
    expect(result!.summary.title).toBe("Backend Systems");
    expect(result!.communities).toHaveLength(2);
  });
});

describe("getConcernDetail", () => {
  it("returns null when tables don't exist", () => {
    expect(getConcernDetail(db, "concern_xss")).toBeNull();
  });

  it("returns concern with resolved bridge members", () => {
    createArchTables(db);
    insertFileFunction(db, "src/render.ts", "renderHTML", "hash_r");
    insertDocAnalysis(db, "hash_r", "Renders HTML content");

    insertSummary(db, "concern_xss", 10, {
      title: "XSS Risk",
      concernType: "security",
      tag: "xss",
      documentation: "Cross-site scripting risk",
      severity: "high",
      bridgeFunctions: [
        { functionName: "renderHTML", contentHash: "hash_r", communityId: "comm_1", centrality: 0.9 },
      ],
      affectedCommunities: [{ communityId: "comm_1", communityTitle: "Auth" }],
    });

    const result = getConcernDetail(db, "concern_xss");
    expect(result).not.toBeNull();
    expect(result!.title).toBe("XSS Risk");
    expect(result!.bridgeMembers).toHaveLength(1);
    expect(result!.bridgeMembers[0].function_name).toBe("renderHTML");
    expect(result!.bridgeMembers[0].description).toBe("Renders HTML content");
  });
});

describe("getConcernsIndex", () => {
  it("returns empty when tables don't exist", () => {
    expect(getConcernsIndex(db)).toEqual([]);
  });

  it("returns all cross-cutting concerns", () => {
    createArchTables(db);
    insertSummary(db, "concern_xss", 10, {
      title: "XSS Risk",
      concernType: "security",
      tag: "xss",
      severity: "high",
      bridgeFunctions: [],
      affectedCommunities: [],
    });
    insertSummary(db, "concern_sqli", 10, {
      title: "SQL Injection",
      concernType: "security",
      tag: "sql_injection",
      severity: "medium",
      bridgeFunctions: [],
      affectedCommunities: [],
    });

    const result = getConcernsIndex(db);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("SQL Injection");
    expect(result[1].title).toBe("XSS Risk");
  });
});

// ============ getPractices ============

describe("getPractices", () => {
  it("returns empty when practices table does not exist", () => {
    expect(getPractices(db)).toEqual([]);
  });

  it("returns practices from table", () => {
    db.exec(`
      CREATE TABLE practices (
        practice_id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      )
    `);
    db.prepare(
      "INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)"
    ).run("no-any", "Never use `any` type", "error");
    db.prepare(
      "INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)"
    ).run("naming-convention", "Use camelCase for variables", "warning");

    const result = getPractices(db);
    expect(result).toHaveLength(2);
    expect(result[0].practice_id).toBe("naming-convention");
    expect(result[1].practice_id).toBe("no-any");
    expect(result[1].severity).toBe("error");
  });
});

// ============ getEditStateMap ============

describe("getEditStateMap", () => {
  it("returns empty map when db is null", () => {
    const map = getEditStateMap(null);
    expect(map.size).toBe(0);
  });

  it("returns empty map when issue_edit_state table is empty", () => {
    const map = getEditStateMap(db);
    expect(map.size).toBe(0);
  });

  it("returns edit state entries keyed by hash:type:index", () => {
    const insert = db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run("hash1", "security", 0, 42, 1, Date.now());
    insert.run("hash1", "security", 1, 50, 0, Date.now());
    insert.run("hash2", "practice", 0, 10, 1, Date.now());

    const map = getEditStateMap(db);
    expect(map.size).toBe(3);

    const entry1 = map.get("hash1:security:0");
    expect(entry1).toBeDefined();
    expect(entry1!.adjustedLine).toBe(42);
    expect(entry1!.potentiallyRemediated).toBe(true);

    const entry2 = map.get("hash1:security:1");
    expect(entry2).toBeDefined();
    expect(entry2!.adjustedLine).toBe(50);
    expect(entry2!.potentiallyRemediated).toBe(false);

    const entry3 = map.get("hash2:practice:0");
    expect(entry3).toBeDefined();
    expect(entry3!.potentiallyRemediated).toBe(true);
  });
});

// ============ getSecurityIssues with edit state ============

describe("getSecurityIssues with edit state", () => {
  it("includes edit state fields when db has entries", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [
      makeIssue("xss", "error", "high"),
      makeIssue("sqli", "warning"),
    ]);

    // Add edit state for first issue
    db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("hash1", "security", 0, 25, 1, Date.now());

    const result = getSecurityIssues(db);
    expect(result.total).toBe(2);

    // First issue (sorted by score -- xss error is higher priority)
    const xssIssue = result.items.find((i) => i.issue.flag === "xss");
    expect(xssIssue).toBeDefined();
    expect(xssIssue!.adjustedLine).toBe(25);
    expect(xssIssue!.potentiallyRemediated).toBe(true);

    // Second issue has no edit state
    const sqliIssue = result.items.find((i) => i.issue.flag === "sqli");
    expect(sqliIssue).toBeDefined();
    expect(sqliIssue!.adjustedLine).toBeUndefined();
    expect(sqliIssue!.potentiallyRemediated).toBe(false);
  });

  it("defaults potentiallyRemediated to false when no edit state entries", () => {
    insertFileFunction(db, "src/a.ts", "fnA", "hash1");
    insertSecurityAnalysis(db, "hash1", [makeIssue("xss", "error")]);

    const result = getSecurityIssues(db);
    expect(result.items[0].potentiallyRemediated).toBe(false);
    expect(result.items[0].adjustedLine).toBeUndefined();
  });
});

// ── getGraphData ─────────────────────────────────────────────────────

function createGraphTables(testDb: BetterSqlite3.Database) {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS function_edges (
      source_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source_hash, target_hash, edge_type)
    )
  `);
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      content_hash TEXT NOT NULL,
      level INTEGER NOT NULL,
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      PRIMARY KEY (content_hash, level, algorithm)
    )
  `);
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS community_summaries (
      community_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      input_hash TEXT NOT NULL,
      summary JSON NOT NULL,
      model_version TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, level, algorithm)
    )
  `);
}

describe("getGraphData", () => {
  it("returns null when function_edges table does not exist", () => {
    expect(getGraphData(db)).toBeNull();
  });

  it("returns null when no edges exist", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    expect(getGraphData(db)).toBeNull();
  });

  it("returns null when no file_functions exist", () => {
    createGraphTables(db);
    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);
    expect(getGraphData(db)).toBeNull();
  });

  it("returns nodes and edges for a simple graph", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "src/b.ts", "fnB", "hashB");
    insertDocAnalysis(db, "hashA", "Function A description");
    insertDocAnalysis(db, "hashB", "Function B description");

    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);

    const result = getGraphData(db);
    expect(result).not.toBeNull();
    expect(result!.nodes).toHaveLength(2);
    expect(result!.edges).toHaveLength(1);

    const nodeA = result!.nodes.find((n) => n.id === "hashA");
    expect(nodeA).toBeDefined();
    expect(nodeA!.label).toBe("fnA");
    expect(nodeA!.filePath).toBe("src/a.ts");
    expect(nodeA!.description).toBe("Function A description");

    const edge = result!.edges[0];
    expect(edge.source).toBe("hashA");
    expect(edge.target).toBe("hashB");
    expect(edge.edgeType).toBe("call");
    expect(edge.weight).toBe(1.0);
  });

  it("excludes edges where one node lacks file_functions entry", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    // hashB has no file_functions entry (orphaned)

    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);

    // No valid edges with both nodes present
    expect(getGraphData(db)).toBeNull();
  });

  it("includes community assignments for nodes", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "src/b.ts", "fnB", "hashB");

    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);

    // Assign both to community
    db.prepare(
      "INSERT INTO communities (content_hash, level, community_id) VALUES (?, ?, ?)",
    ).run("hashA", 0, "comm_1");
    db.prepare(
      "INSERT INTO communities (content_hash, level, community_id) VALUES (?, ?, ?)",
    ).run("hashB", 0, "comm_1");

    // Add community summary
    db.prepare(
      `INSERT INTO community_summaries (community_id, level, input_hash, summary, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("comm_1", 1, "test_hash", JSON.stringify({ title: "Auth Module" }), Date.now());

    const result = getGraphData(db);
    expect(result).not.toBeNull();

    const nodeA = result!.nodes.find((n) => n.id === "hashA");
    expect(nodeA!.communityId).toBe("comm_1");

    expect(result!.communities).toHaveLength(1);
    expect(result!.communities[0].title).toBe("Auth Module");
    expect(result!.communities[0].memberCount).toBe(2);
  });

  it("includes security flags and issue count", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "src/b.ts", "fnB", "hashB");
    insertSecurityAnalysis(db, "hashA", [makeIssue("xss", "error")], ["xss"]);

    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);

    const result = getGraphData(db);
    expect(result).not.toBeNull();

    const nodeA = result!.nodes.find((n) => n.id === "hashA");
    expect(nodeA!.issueCount).toBe(1);
    expect(nodeA!.securityFlags).toContain("xss");

    const nodeB = result!.nodes.find((n) => n.id === "hashB");
    expect(nodeB!.issueCount).toBe(0);
  });

  it("handles multiple edge types", () => {
    createGraphTables(db);
    insertFileFunction(db, "src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "src/b.ts", "fnB", "hashB");

    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "call", 1.0);
    db.prepare(
      "INSERT INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
    ).run("hashA", "hashB", "co_location", 0.5);

    const result = getGraphData(db);
    expect(result).not.toBeNull();
    expect(result!.edges).toHaveLength(2);

    const callEdge = result!.edges.find((e) => e.edgeType === "call");
    const coLocEdge = result!.edges.find((e) => e.edgeType === "co_location");
    expect(callEdge!.weight).toBe(1.0);
    expect(coLocEdge!.weight).toBe(0.5);
  });
});
