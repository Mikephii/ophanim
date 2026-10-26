import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { handleWebviewRequest, type DataRequest } from "./webview-handler";

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

function makeRequest(method: string, params?: Record<string, unknown>): DataRequest {
  return { type: "request", id: "test-id-1", method, params };
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db?.close();
});

describe("handleWebviewRequest", () => {
  it("returns error when db is null", async () => {
    const response = await handleWebviewRequest(null, makeRequest("getTopIssues"));
    expect(response.type).toBe("response");
    expect(response.id).toBe("test-id-1");
    expect(response.error).toBe("Database not loaded");
    expect(response.data).toBeUndefined();
  });

  it("returns error for unknown method", async () => {
    const response = await handleWebviewRequest(db, makeRequest("nonExistentMethod"));
    expect(response.error).toBe("Unknown method: nonExistentMethod");
  });

  it("returns empty stats for getSecurityDashboardStats on empty db", async () => {
    const response = await handleWebviewRequest(db, makeRequest("getSecurityDashboardStats"));
    expect(response.error).toBeUndefined();
    expect(response.data).toEqual({
      posture: "clean",
      criticalCount: 0,
      errorCount: 0,
      warningCount: 0,
      totalFunctions: 0,
      flagBreakdown: {},
    });
  });

  it("returns empty array for getTopIssues on empty db", async () => {
    const response = await handleWebviewRequest(db, makeRequest("getTopIssues"));
    expect(response.data).toEqual([]);
  });

  it("returns empty result for getEnrichedFunctions on empty db", async () => {
    const response = await handleWebviewRequest(db, makeRequest("getEnrichedFunctions"));
    expect(response.data).toEqual({ items: [], total: 0, page: 1 });
  });

  it("returns real data for getNavCounts on empty db", async () => {
    const response = await handleWebviewRequest(db, makeRequest("getNavCounts"));
    expect(response.data).toEqual({ securityIssues: 0, functions: 0, practices: 0 });
  });

  it("preserves the request id in the response", async () => {
    const request = { type: "request" as const, id: "unique-id-42", method: "getTopIssues" };
    const response = await handleWebviewRequest(db, request);
    expect(response.id).toBe("unique-id-42");
  });

  it("passes edit state from unified db to getEnrichedFunction", async () => {
    const now = Math.floor(Date.now() / 1000);

    // Add state tables to the same db
    db.exec(`
      CREATE TABLE dismissed_issues (content_hash TEXT, issue_index INTEGER, flag TEXT, reason TEXT, note TEXT, dismissed_at INTEGER, PRIMARY KEY(content_hash, issue_index));
      CREATE TABLE issue_edit_state (content_hash TEXT, issue_type TEXT, issue_index INTEGER, adjusted_line INTEGER, potentially_remediated INTEGER DEFAULT 0, updated_at INTEGER, PRIMARY KEY(content_hash, issue_type, issue_index));
    `);

    db.prepare(
      `INSERT INTO file_functions (file_path, function_name, content_hash, file_mtime)
       VALUES (?, ?, ?, ?)`,
    ).run("src/a.ts", "fnA", "hash1", Date.now());

    db.prepare(
      `INSERT INTO function_analysis (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at)
       VALUES (?, 'security', ?, 'claude-3', 2, ?, ?)`,
    ).run(
      "hash1",
      JSON.stringify({
        dataTags: [],
        securityFlags: [],
        issues: [{ flag: "xss", title: "XSS", description: "test", explanation: "", line: 1, startText: "", endText: "", severity: "error" }],
      }),
      now,
      now,
    );

    db.prepare(
      "INSERT INTO issue_edit_state VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hash1", "security", 0, 25, 1, Date.now());

    const response = await handleWebviewRequest(
      db,
      makeRequest("getEnrichedFunction", { contentHash: "hash1" }),
    );

    expect(response.error).toBeUndefined();
    const data = response.data as { editState?: Record<string, { adjustedLine: number; potentiallyRemediated: boolean }> };
    expect(data.editState).toBeDefined();
    expect(data.editState!["security:0"]).toEqual({
      adjustedLine: 25,
      potentiallyRemediated: true,
    });
  });
});
