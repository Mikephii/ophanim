import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  mergeAnalysisRows,
  gcAnalysis,
  importAnalysis,
  findMissingHashes,
  ensureGitignore,
  numberLines,
} from "./index";
import { migrateToAnalysisTypes } from "./migrations";
import { SecurityAnalysis } from "./schemas";
import {
  createTestDb,
  createLegacyTestDb,
  insertAnalysisPair,
  insertFileFunction,
  makeDocAnalysisJson,
  makeSecAnalysisJson,
  makePracAnalysisJson,
  insertPracticesRow,
} from "./test-utils";

// ============ mergeAnalysisRows ============

describe("mergeAnalysisRows", () => {
  it("merges documentation + security rows into unified shape", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Fetches user",
          params: [{ name: "id", type: "string", description: "user id" }],
          returns: { type: "User", description: "the user" },
        }),
      },
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: ["database", "pii"],
          securityFlags: ["sql_injection"],
        }),
      },
    ]);

    expect(result.description).toBe("Fetches user");
    expect(result.params).toEqual([
      { name: "id", type: "string", description: "user id" },
    ]);
    expect(result.returns).toEqual({ type: "User", description: "the user" });
    expect(result.dataTags).toEqual(["database", "pii"]);
    expect(result.securityFlags).toEqual(["sql_injection"]);
  });

  it("handles documentation-only (missing security row)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Test",
          params: [],
          returns: { type: "void", description: "" },
        }),
      },
    ]);

    expect(result.description).toBe("Test");
    expect(result.dataTags).toEqual([]);
    expect(result.securityFlags).toEqual([]);
  });

  it("handles security-only (missing documentation row)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: ["internal"],
          securityFlags: [],
        }),
      },
    ]);

    expect(result.description).toBe("");
    expect(result.params).toEqual([]);
    expect(result.returns).toEqual({ type: "unknown", description: "" });
    expect(result.dataTags).toEqual(["internal"]);
  });

  it("handles empty rows array", () => {
    const result = mergeAnalysisRows([]);

    expect(result.description).toBe("");
    expect(result.params).toEqual([]);
    expect(result.returns).toEqual({ type: "unknown", description: "" });
    expect(result.dataTags).toEqual([]);
    expect(result.securityFlags).toEqual([]);
  });

  it("ignores unknown analysis_type", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "future_type",
        analysis: JSON.stringify({ foo: "bar" }),
      },
    ]);

    expect(result.description).toBe("");
    expect(result.securityFlags).toEqual([]);
  });

  it("last row wins when duplicate analysis_type", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "First",
          params: [],
          returns: { type: "void", description: "" },
        }),
      },
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Second",
          params: [],
          returns: { type: "string", description: "overwritten" },
        }),
      },
    ]);

    expect(result.description).toBe("Second");
    expect(result.returns.type).toBe("string");
  });

  it("extracts issues from v2 security rows", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Test",
          params: [],
          returns: { type: "void", description: "" },
        }),
      },
      {
        analysis_type: "security",
        analysis: JSON.stringify({
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
        }),
      },
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].flag).toBe("sql_injection");
    expect(result.issues[0].title).toBe("SQL injection via template literal");
    expect(result.issues[0].line).toBe(2);
    expect(result.issues[0].severity).toBe("error");
  });

  it("defaults issues to empty array for v1 rows (backward compat)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: ["internal"],
          securityFlags: ["xss"],
        }),
      },
    ]);

    expect(result.securityFlags).toEqual(["xss"]);
    expect(result.issues).toEqual([]);
  });

  it("handles empty issues array", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: [],
          securityFlags: [],
          issues: [],
        }),
      },
    ]);

    expect(result.issues).toEqual([]);
  });

  it("merges practices row into practiceViolations", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Test",
          params: [],
          returns: { type: "void", description: "" },
        }),
      },
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: [],
          securityFlags: [],
          issues: [],
        }),
      },
      {
        analysis_type: "practices",
        analysis: JSON.stringify({
          violations: [{
            flag: "no-eval",
            title: "eval() usage",
            description: "Found eval() call.",
            explanation: "Replace with safer alternative.",
            line: 5,
            startText: "eval(",
            endText: ")",
            severity: "error",
          }],
        }),
      },
    ]);

    expect(result.practiceViolations).toHaveLength(1);
    expect(result.practiceViolations[0].flag).toBe("no-eval");
    expect(result.practiceViolations[0].line).toBe(5);
  });

  it("defaults practiceViolations to empty when no practices row (backward compat)", () => {
    const result = mergeAnalysisRows([
      {
        analysis_type: "documentation",
        analysis: JSON.stringify({
          description: "Test",
          params: [],
          returns: { type: "void", description: "" },
        }),
      },
      {
        analysis_type: "security",
        analysis: JSON.stringify({
          dataTags: [],
          securityFlags: [],
        }),
      },
    ]);

    expect(result.practiceViolations).toEqual([]);
  });

  it("defaults practiceViolations to empty for empty rows", () => {
    const result = mergeAnalysisRows([]);
    expect(result.practiceViolations).toEqual([]);
  });
});

// ============ numberLines ============

describe("numberLines", () => {
  it("numbers each line starting at 1", () => {
    const result = numberLines("line a\nline b\nline c");
    expect(result).toBe("1 | line a\n2 | line b\n3 | line c");
  });

  it("pads line numbers for alignment", () => {
    const input = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = numberLines(input);
    expect(result).toContain(" 1 | line 1");
    expect(result).toContain("12 | line 12");
  });

  it("handles single-line source", () => {
    expect(numberLines("const x = 1;")).toBe("1 | const x = 1;");
  });

  it("handles empty string", () => {
    expect(numberLines("")).toBe("1 | ");
  });
});

// ============ SecurityAnalysis Zod schema ============

describe("SecurityAnalysis Zod schema", () => {
  it("parses v2 data with issues", () => {
    const data = {
      dataTags: ["database"],
      securityFlags: ["sql_injection"],
      issues: [{
        flag: "sql_injection",
        title: "SQL injection",
        description: "Bad.",
        explanation: "Fix it.",
        line: 2,
        startText: "SELECT",
        endText: ")",
        severity: "error",
      }],
    };
    const result = SecurityAnalysis.parse(data);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].severity).toBe("error");
  });

  it("parses v1 data (no issues field) with catch default", () => {
    const data = {
      dataTags: ["internal"],
      securityFlags: [],
    };
    const result = SecurityAnalysis.parse(data);
    expect(result.issues).toEqual([]);
  });

  it("handles malformed issues array with catch", () => {
    const data = {
      dataTags: [],
      securityFlags: [],
      issues: "not an array",
    };
    const result = SecurityAnalysis.parse(data);
    expect(result.issues).toEqual([]);
  });

  it("handles malformed issue objects with catch defaults", () => {
    const data = {
      dataTags: [],
      securityFlags: ["xss"],
      issues: [{
        flag: "xss",
        // missing all other fields
      }],
    };
    const result = SecurityAnalysis.parse(data);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].flag).toBe("xss");
    expect(result.issues[0].title).toBe("");
    expect(result.issues[0].line).toBe(0);
    expect(result.issues[0].severity).toBe("warning");
  });
});

// ============ migrateToAnalysisTypes ============

describe("migrateToAnalysisTypes", () => {
  it("splits single legacy row into documentation + security rows", () => {
    const db = createLegacyTestDb();
    db.prepare(
      `INSERT INTO function_analysis
       (content_hash, analysis, model_version, created_at, last_seen_at, language, entity_type, synced_at)
       VALUES (?, ?, 'claude-3', 1000, 2000, 'typescript', 'function', 5000)`
    ).run(
      "abc123",
      JSON.stringify({
        description: "Test fn",
        params: [{ name: "x", type: "number", description: "input" }],
        returns: { type: "number", description: "output" },
        dataTags: ["internal"],
        securityFlags: ["xss"],
      })
    );

    migrateToAnalysisTypes(db);

    const rows = db
      .prepare(
        "SELECT content_hash, analysis_type, analysis, synced_at FROM function_analysis ORDER BY analysis_type"
      )
      .all() as any[];

    expect(rows).toHaveLength(2);

    const docRow = rows.find((r: any) => r.analysis_type === "documentation");
    const secRow = rows.find((r: any) => r.analysis_type === "security");

    expect(docRow).toBeDefined();
    expect(secRow).toBeDefined();

    const doc = JSON.parse(docRow.analysis);
    expect(doc.description).toBe("Test fn");
    expect(doc.params).toEqual([
      { name: "x", type: "number", description: "input" },
    ]);

    const sec = JSON.parse(secRow.analysis);
    expect(sec.dataTags).toEqual(["internal"]);
    expect(sec.securityFlags).toEqual(["xss"]);

    // synced_at should be NULL (forced re-sync)
    expect(docRow.synced_at).toBeNull();
    expect(secRow.synced_at).toBeNull();

    db.close();
  });

  it("handles NULL language/entity_type with COALESCE defaults", () => {
    const db = createLegacyTestDb();
    db.prepare(
      `INSERT INTO function_analysis
       (content_hash, analysis, model_version, created_at, last_seen_at, language, entity_type)
       VALUES (?, ?, 'claude-3', 1000, 2000, NULL, NULL)`
    ).run("hash1", JSON.stringify({ description: "Test" }));

    migrateToAnalysisTypes(db);

    const rows = db
      .prepare(
        "SELECT language, entity_type FROM function_analysis WHERE content_hash = 'hash1'"
      )
      .all() as any[];

    for (const row of rows) {
      expect(row.language).toBe("typescript");
      expect(row.entity_type).toBe("function");
    }

    db.close();
  });

  it("splits multiple legacy rows", () => {
    const db = createLegacyTestDb();
    for (let i = 1; i <= 3; i++) {
      db.prepare(
        `INSERT INTO function_analysis
         (content_hash, analysis, model_version, created_at, last_seen_at)
         VALUES (?, ?, 'claude-3', 1000, 2000)`
      ).run(`hash${i}`, JSON.stringify({ description: `Fn ${i}` }));
    }

    migrateToAnalysisTypes(db);

    const count = db
      .prepare("SELECT COUNT(*) as c FROM function_analysis")
      .get() as any;
    expect(count.c).toBe(6); // 3 hashes x 2 types

    db.close();
  });

  it("new table has correct composite PK (content_hash, analysis_type)", () => {
    const db = createLegacyTestDb();
    db.prepare(
      `INSERT INTO function_analysis
       (content_hash, analysis, model_version, created_at, last_seen_at)
       VALUES (?, ?, 'claude-3', 1000, 2000)`
    ).run("hash1", JSON.stringify({}));

    migrateToAnalysisTypes(db);

    // Inserting duplicate (same hash + type) should fail
    expect(() =>
      db
        .prepare(
          `INSERT INTO function_analysis
           (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
           VALUES ('hash1', 'documentation', '{}', 'test', 1, 1000, 2000, 'typescript', 'function')`
        )
        .run()
    ).toThrow();

    db.close();
  });
});

// ============ gcAnalysis ============

describe("gcAnalysis", () => {
  let tmpDir: string;
  let dbPath: string;

  function setupDb(
    setup: (db: Database.Database) => void
  ): void {
    const db = new Database(dbPath);
    // Create schema
    const memDb = createTestDb();
    const tables = memDb
      .prepare("SELECT sql FROM sqlite_master WHERE type='table'")
      .all() as any[];
    for (const t of tables) {
      db.exec(t.sql + ";");
    }
    const indexes = memDb
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
      .all() as any[];
    for (const idx of indexes) {
      db.exec(idx.sql + ";");
    }
    memDb.close();
    setup(db);
    db.close();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-gc-test-"));
    dbPath = path.join(tmpDir, "index.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes orphaned analysis older than grace period", () => {
    const ninetyDaysAgo =
      Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;

    setupDb((db) => {
      insertAnalysisPair(db, "orphan1", { lastSeenAt: ninetyDaysAgo });
      // No file_functions entry → orphaned
    });

    const result = gcAnalysis(dbPath, 30);
    expect(result.deleted).toBe(2); // doc + sec rows

    const db = new Database(dbPath, { readonly: true });
    const remaining = db
      .prepare("SELECT COUNT(*) as c FROM function_analysis")
      .get() as any;
    expect(remaining.c).toBe(0);
    db.close();
  });

  it("preserves analysis still referenced by file_functions", () => {
    const ninetyDaysAgo =
      Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;

    setupDb((db) => {
      insertAnalysisPair(db, "active1", { lastSeenAt: ninetyDaysAgo });
      insertFileFunction(db, "/src/foo.ts", "foo", "active1");
    });

    const result = gcAnalysis(dbPath, 30);
    expect(result.deleted).toBe(0);
  });

  it("preserves orphaned analysis within grace period", () => {
    const fiveDaysAgo =
      Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;

    setupDb((db) => {
      insertAnalysisPair(db, "recent_orphan", { lastSeenAt: fiveDaysAgo });
    });

    const result = gcAnalysis(dbPath, 30);
    expect(result.deleted).toBe(0);
  });

  it("creates tombstones in function_gc before deleting", () => {
    const ninetyDaysAgo =
      Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;

    setupDb((db) => {
      insertAnalysisPair(db, "doomed", { lastSeenAt: ninetyDaysAgo });
    });

    gcAnalysis(dbPath, 30);

    const db = new Database(dbPath, { readonly: true });
    const tombstones = db
      .prepare(
        "SELECT content_hash, analysis_type FROM function_gc ORDER BY analysis_type"
      )
      .all() as any[];
    expect(tombstones).toHaveLength(2);
    expect(tombstones.map((t: any) => t.analysis_type).sort()).toEqual([
      "documentation",
      "security",
    ]);
    db.close();
  });

  it("handles empty database", () => {
    setupDb(() => {});
    const result = gcAnalysis(dbPath, 30);
    expect(result.deleted).toBe(0);
  });
});

// ============ importAnalysis ============

describe("importAnalysis", () => {
  let tmpDir: string;
  let dbPath: string;

  function setupDb(
    setup?: (db: Database.Database) => void
  ): void {
    const db = new Database(dbPath);
    const memDb = createTestDb();
    const tables = memDb
      .prepare("SELECT sql FROM sqlite_master WHERE type='table'")
      .all() as any[];
    for (const t of tables) {
      db.exec(t.sql + ";");
    }
    memDb.close();
    if (setup) setup(db);
    db.close();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-import-test-"));
    dbPath = path.join(tmpDir, "index.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports new analysis rows", () => {
    setupDb();
    const count = importAnalysis(dbPath, [
      {
        content_hash: "abc",
        analysis_type: "documentation",
        analysis: makeDocAnalysisJson(),
        model_version: "test",
        schema_version: 1,
        language: "typescript",
        entity_type: "function",
      },
    ]);

    expect(count).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT * FROM function_analysis WHERE content_hash = 'abc'"
      )
      .get() as any;
    expect(row).toBeDefined();
    expect(row.analysis_type).toBe("documentation");
    db.close();
  });

  it("skips existing rows (INSERT OR IGNORE)", () => {
    setupDb((db) => {
      insertAnalysisPair(db, "exists");
    });

    const count = importAnalysis(dbPath, [
      {
        content_hash: "exists",
        analysis_type: "documentation",
        analysis: makeDocAnalysisJson({ description: "SHOULD NOT OVERWRITE" }),
        model_version: "test",
        schema_version: 1,
        language: "typescript",
        entity_type: "function",
      },
    ]);

    expect(count).toBe(0);

    // Verify original data unchanged
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT analysis FROM function_analysis WHERE content_hash = 'exists' AND analysis_type = 'documentation'"
      )
      .get() as any;
    const parsed = JSON.parse(row.analysis);
    expect(parsed.description).toBe("Test function description");
    db.close();
  });

  it("sets synced_at on imported rows", () => {
    setupDb();
    importAnalysis(dbPath, [
      {
        content_hash: "new1",
        analysis_type: "security",
        analysis: makeSecAnalysisJson(),
        model_version: "test",
        schema_version: 1,
        language: "typescript",
        entity_type: "function",
      },
    ]);

    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        "SELECT synced_at FROM function_analysis WHERE content_hash = 'new1'"
      )
      .get() as any;
    expect(row.synced_at).not.toBeNull();
    db.close();
  });

  it("returns 0 for empty rows array", () => {
    setupDb();
    expect(importAnalysis(dbPath, [])).toBe(0);
  });

  it("handles mixed new and existing rows", () => {
    setupDb((db) => {
      insertAnalysisPair(db, "exists");
    });

    const count = importAnalysis(dbPath, [
      {
        content_hash: "exists",
        analysis_type: "documentation",
        analysis: makeDocAnalysisJson(),
        model_version: "test",
        schema_version: 1,
        language: "typescript",
        entity_type: "function",
      },
      {
        content_hash: "new1",
        analysis_type: "documentation",
        analysis: makeDocAnalysisJson(),
        model_version: "test",
        schema_version: 1,
        language: "typescript",
        entity_type: "function",
      },
      {
        content_hash: "new2",
        analysis_type: "security",
        analysis: makeSecAnalysisJson(),
        model_version: "test",
        schema_version: 1,
        language: "python",
        entity_type: "method",
      },
    ]);

    expect(count).toBe(2);
  });
});

// ============ findMissingHashes ============

describe("findMissingHashes", () => {
  let tmpDir: string;
  let dbPath: string;

  function setupDb(
    setup: (db: Database.Database) => void
  ): void {
    const db = new Database(dbPath);
    const memDb = createTestDb();
    const tables = memDb
      .prepare("SELECT sql FROM sqlite_master WHERE type='table'")
      .all() as any[];
    for (const t of tables) {
      db.exec(t.sql + ";");
    }
    memDb.close();
    setup(db);
    db.close();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-missing-test-"));
    dbPath = path.join(tmpDir, "index.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns hashes in file_functions but not in function_analysis", () => {
    setupDb((db) => {
      insertFileFunction(db, "/src/foo.ts", "foo", "hash1");
      insertFileFunction(db, "/src/bar.ts", "bar", "hash2");
      // Only hash1 has analysis
      insertAnalysisPair(db, "hash1");
    });

    const missing = findMissingHashes(dbPath);
    expect(missing).toEqual(["hash2"]);
  });

  it("returns empty when all hashes are analyzed", () => {
    setupDb((db) => {
      insertFileFunction(db, "/src/foo.ts", "foo", "hash1");
      insertAnalysisPair(db, "hash1");
    });

    const missing = findMissingHashes(dbPath);
    expect(missing).toEqual([]);
  });

  it("deduplicates — same hash in multiple files returned once", () => {
    setupDb((db) => {
      insertFileFunction(db, "/src/a.ts", "fn", "shared_hash");
      insertFileFunction(db, "/src/b.ts", "fn", "shared_hash");
    });

    const missing = findMissingHashes(dbPath);
    expect(missing).toEqual(["shared_hash"]);
  });
});

// ============ ensureGitignore ============

describe("ensureGitignore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-gitignore-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends .ophan/ to existing .gitignore", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n");

    ensureGitignore(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".ophan/");
    expect(content).toContain("node_modules/");
  });

  it("does not duplicate if .ophan already in .gitignore", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    fs.writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n.ophan/\n");

    ensureGitignore(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    const matches = content.match(/\.ophan/g);
    expect(matches).toHaveLength(1);
  });

  it("creates .gitignore in a git repo with no .gitignore", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));

    ensureGitignore(tmpDir);

    const content = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toContain(".ophan/");
  });

  it("does nothing in a non-git directory", () => {
    ensureGitignore(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, ".gitignore"))).toBe(false);
  });
});
