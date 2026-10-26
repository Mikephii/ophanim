import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { queryFileAnalysis, queryAllAnalysis, entryToFunctionData } from "./queries";

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
  return testDb;
}

function insertAnalysisPair(
  testDb: BetterSqlite3.Database,
  hash: string,
  opts: {
    doc?: Record<string, unknown>;
    sec?: Record<string, unknown>;
    language?: string;
    entityType?: string;
  } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  const doc = JSON.stringify(opts.doc ?? { description: "Test fn", params: [], returns: { type: "void", description: "" } });
  const sec = JSON.stringify(opts.sec ?? { dataTags: [], securityFlags: [], issues: [] });
  const lang = opts.language ?? "typescript";
  const entity = opts.entityType ?? "function";

  testDb.prepare(
    `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
     VALUES (?, 'documentation', ?, 'claude-3', 1, ?, ?, ?, ?)`
  ).run(hash, doc, now, now, lang, entity);
  testDb.prepare(
    `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
     VALUES (?, 'security', ?, 'claude-3', 1, ?, ?, ?, ?)`
  ).run(hash, sec, now, now, lang, entity);
}

function insertFileFunction(
  testDb: BetterSqlite3.Database,
  filePath: string,
  functionName: string,
  hash: string,
  opts: { language?: string; entityType?: string; startLine?: number } = {}
) {
  testDb.prepare(
    `INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime, language, entity_type, start_line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(filePath, functionName, hash, Date.now(), opts.language ?? "typescript", opts.entityType ?? "function", opts.startLine ?? 0);
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db?.close();
});

// ============ queryFileAnalysis ============

describe("queryFileAnalysis", () => {
  it("returns empty array when no data matches", () => {
    const result = queryFileAnalysis(db, "src/nonexistent.ts");
    expect(result).toEqual([]);
  });

  it("merges documentation + security rows into single entry", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertAnalysisPair(db, "hash1", {
      doc: { description: "Logs user in", params: [{ name: "email", type: "string", description: "User email" }], returns: { type: "boolean", description: "Success" } },
      sec: { dataTags: ["credentials", "pii"], securityFlags: ["hardcoded_secret"] },
    });

    const result = queryFileAnalysis(db, "src/auth.ts");

    expect(result).toHaveLength(1);
    expect(result[0].functionName).toBe("login");
    expect(result[0].contentHash).toBe("hash1");
    expect(result[0].analysis.description).toBe("Logs user in");
    expect(result[0].analysis.params).toHaveLength(1);
    expect(result[0].analysis.params[0].name).toBe("email");
    expect(result[0].analysis.returns.type).toBe("boolean");
    expect(result[0].analysis.dataTags).toEqual(["credentials", "pii"]);
    expect(result[0].analysis.securityFlags).toEqual(["hardcoded_secret"]);
  });

  it("handles missing documentation row gracefully", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    // Only insert security row
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 1, ?, ?)`
    ).run("hash1", JSON.stringify({ dataTags: ["database"], securityFlags: [] }), now, now);

    const result = queryFileAnalysis(db, "src/a.ts");

    expect(result).toHaveLength(1);
    expect(result[0].analysis.description).toBe("");
    expect(result[0].analysis.params).toEqual([]);
    expect(result[0].analysis.dataTags).toEqual(["database"]);
  });

  it("handles missing security row gracefully", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    // Only insert documentation row
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'documentation', ?, 'claude-3', 1, ?, ?)`
    ).run("hash1", JSON.stringify({ description: "Test", params: [], returns: { type: "void", description: "" } }), now, now);

    const result = queryFileAnalysis(db, "src/a.ts");

    expect(result).toHaveLength(1);
    expect(result[0].analysis.description).toBe("Test");
    expect(result[0].analysis.dataTags).toEqual([]);
    expect(result[0].analysis.securityFlags).toEqual([]);
  });

  it("only returns entries for the specified file", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    insertFileFunction(db, "src/b.ts", "fn2", "hash2");
    insertAnalysisPair(db, "hash1");
    insertAnalysisPair(db, "hash2");

    const resultA = queryFileAnalysis(db, "src/a.ts");
    const resultB = queryFileAnalysis(db, "src/b.ts");

    expect(resultA).toHaveLength(1);
    expect(resultA[0].functionName).toBe("fn1");
    expect(resultB).toHaveLength(1);
    expect(resultB[0].functionName).toBe("fn2");
  });

  it("returns multiple functions for the same file", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    insertFileFunction(db, "src/a.ts", "fn2", "hash2");
    insertAnalysisPair(db, "hash1");
    insertAnalysisPair(db, "hash2");

    const result = queryFileAnalysis(db, "src/a.ts");
    expect(result).toHaveLength(2);
  });

  it("uses default language and entityType for null columns", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    // Insert analysis with empty language/entity_type via raw SQL
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
       VALUES (?, 'documentation', ?, 'claude-3', 1, ?, ?, '', '')`
    ).run("hash1", JSON.stringify({ description: "Test" }), now, now);

    const result = queryFileAnalysis(db, "src/a.ts");
    expect(result).toHaveLength(1);
    // Empty string falls back via || operator
    expect(result[0].language).toBe("typescript");
    expect(result[0].entityType).toBe("function");
  });

  it("preserves python language from file_functions", () => {
    insertFileFunction(db, "src/main.py", "run", "hash1", { language: "python" });
    insertAnalysisPair(db, "hash1", { language: "python" });

    const result = queryFileAnalysis(db, "src/main.py");
    expect(result[0].language).toBe("python");
  });
});

// ============ queryAllAnalysis ============

describe("queryAllAnalysis", () => {
  it("returns empty map when no data", () => {
    const result = queryAllAnalysis(db);
    expect(result.size).toBe(0);
  });

  it("groups functions by file path", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    insertFileFunction(db, "src/a.ts", "fn2", "hash2");
    insertFileFunction(db, "src/b.ts", "fn3", "hash3");
    insertAnalysisPair(db, "hash1");
    insertAnalysisPair(db, "hash2");
    insertAnalysisPair(db, "hash3");

    const result = queryAllAnalysis(db);

    expect(result.size).toBe(2);
    expect(result.get("src/a.ts")).toHaveLength(2);
    expect(result.get("src/b.ts")).toHaveLength(1);
  });

  it("merges documentation + security into FunctionData", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertAnalysisPair(db, "hash1", {
      doc: { description: "Login handler", params: [], returns: { type: "void", description: "" } },
      sec: { dataTags: ["credentials"], securityFlags: ["sql_injection"] },
    });

    const result = queryAllAnalysis(db);
    const fns = result.get("src/auth.ts")!;

    expect(fns).toHaveLength(1);
    expect(fns[0].name).toBe("login");
    expect(fns[0].description).toBe("Login handler");
    expect(fns[0].dataTags).toEqual(["credentials"]);
    expect(fns[0].securityFlags).toEqual(["sql_injection"]);
    expect(fns[0].startLine).toBe(0); // Not resolved at query time
    expect(fns[0].endLine).toBe(0);
  });
});

// ============ entryToFunctionData ============

describe("entryToFunctionData", () => {
  it("maps DbEntry to FunctionData with position", () => {
    const entry = {
      functionName: "handleRequest",
      contentHash: "abc123",
      analysis: {
        description: "Handles HTTP request",
        params: [{ name: "req", type: "Request", description: "The request" }],
        returns: { type: "Response", description: "HTTP response" },
        dataTags: ["user_input"],
        securityFlags: ["xss"],
        issues: [],
        practiceViolations: [],
      },
      language: "typescript",
      entityType: "function",
    };

    const result = entryToFunctionData(entry, "src/server.ts", 10, 25);

    expect(result.name).toBe("handleRequest");
    expect(result.filePath).toBe("src/server.ts");
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(25);
    expect(result.contentHash).toBe("abc123");
    expect(result.description).toBe("Handles HTTP request");
    expect(result.params).toHaveLength(1);
    expect(result.returns.type).toBe("Response");
    expect(result.dataTags).toEqual(["user_input"]);
    expect(result.securityFlags).toEqual(["xss"]);
    expect(result.issues).toEqual([]);
    expect(result.language).toBe("typescript");
    expect(result.entityType).toBe("function");
  });
});

// ============ issues pass-through ============

describe("queryFileAnalysis issues", () => {
  it("passes through issues from v2 security rows", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertAnalysisPair(db, "hash1", {
      sec: {
        dataTags: ["credentials"],
        securityFlags: ["hardcoded_secret"],
        issues: [{
          flag: "hardcoded_secret",
          title: "API key in source",
          description: "Hardcoded credential found.",
          explanation: "Use environment variables.",
          line: 3,
          startText: "const key = \"sk-",
          endText: "abc123\"",
          severity: "error",
        }],
      },
    });

    const result = queryFileAnalysis(db, "src/auth.ts");
    expect(result[0].analysis.issues).toHaveLength(1);
    expect(result[0].analysis.issues[0].flag).toBe("hardcoded_secret");
    expect(result[0].analysis.issues[0].line).toBe(3);
  });

  it("defaults issues to empty for v1 security rows", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    insertAnalysisPair(db, "hash1", {
      sec: { dataTags: [], securityFlags: ["xss"] },
    });

    const result = queryFileAnalysis(db, "src/a.ts");
    expect(result[0].analysis.issues).toEqual([]);
  });
});

// ============ practice violations pass-through ============

function insertPracticesRow(
  testDb: BetterSqlite3.Database,
  hash: string,
  prac: Record<string, unknown>
) {
  const now = Math.floor(Date.now() / 1000);
  testDb.prepare(
    `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
     VALUES (?, 'practices', ?, 'claude-3', 1, ?, ?, 'typescript', 'function')`
  ).run(hash, JSON.stringify(prac), now, now);
}

describe("queryFileAnalysis practice violations", () => {
  it("passes through violations from practices row", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertAnalysisPair(db, "hash1");
    insertPracticesRow(db, "hash1", {
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
    });

    const result = queryFileAnalysis(db, "src/auth.ts");
    expect(result[0].analysis.practiceViolations).toHaveLength(1);
    expect(result[0].analysis.practiceViolations[0].flag).toBe("no-eval");
  });

  it("defaults practiceViolations to empty when no practices row", () => {
    insertFileFunction(db, "src/a.ts", "fn1", "hash1");
    insertAnalysisPair(db, "hash1");

    const result = queryFileAnalysis(db, "src/a.ts");
    expect(result[0].analysis.practiceViolations).toEqual([]);
  });
});

describe("queryAllAnalysis practice violations", () => {
  it("includes practiceViolations in FunctionData", () => {
    insertFileFunction(db, "src/auth.ts", "login", "hash1");
    insertAnalysisPair(db, "hash1");
    insertPracticesRow(db, "hash1", {
      violations: [{
        flag: "use-const",
        title: "let instead of const",
        description: "Variable never reassigned.",
        explanation: "Use const.",
        line: 2,
        startText: "let x =",
        endText: "= 1",
        severity: "info",
      }],
    });

    const result = queryAllAnalysis(db);
    const fns = result.get("src/auth.ts")!;
    expect(fns[0].practiceViolations).toHaveLength(1);
    expect(fns[0].practiceViolations[0].flag).toBe("use-const");
  });
});
