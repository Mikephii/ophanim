import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import BetterSqlite3 from "better-sqlite3";
import {
  openWriteDb,
  getWriteDb,
  closeWriteDb,
  writeIssueEditStates,
  clearEditState,
} from "./write-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  // Close any lingering handle from a previous test
  closeWriteDb();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-write-db-test-"));
  dbPath = path.join(tmpDir, "index.db");

  // Create a minimal DB so openWriteDb has something to open
  const seed = new BetterSqlite3(dbPath);
  seed.exec(`
    CREATE TABLE function_analysis (
      content_hash TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      PRIMARY KEY (content_hash, analysis_type)
    )
  `);
  seed.close();
});

afterEach(() => {
  closeWriteDb();
  // Clean up temp files
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe("openWriteDb / getWriteDb / closeWriteDb", () => {
  it("opens a writable handle and returns it", () => {
    const db = openWriteDb(dbPath);
    expect(db).toBeDefined();
    expect(getWriteDb()).toBe(db);
  });

  it("returns existing handle on double-open", () => {
    const db1 = openWriteDb(dbPath);
    const db2 = openWriteDb(dbPath);
    expect(db1).toBe(db2);
  });

  it("sets WAL journal mode", () => {
    openWriteDb(dbPath);
    const mode = getWriteDb()!.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });

  it("runs extension migrations (creates state tables)", () => {
    openWriteDb(dbPath);
    const db = getWriteDb()!;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('dismissed_issues', 'issue_edit_state') ORDER BY name")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["dismissed_issues", "issue_edit_state"]);
  });

  it("closeWriteDb sets handle to null", () => {
    openWriteDb(dbPath);
    expect(getWriteDb()).not.toBeNull();
    closeWriteDb();
    expect(getWriteDb()).toBeNull();
  });
});

describe("writeIssueEditStates", () => {
  it("writes edit state entries to the database", () => {
    openWriteDb(dbPath);

    writeIssueEditStates([
      {
        contentHash: "hash1",
        issueType: "security",
        issueIndex: 0,
        adjustedLine: 42,
        potentiallyRemediated: true,
      },
      {
        contentHash: "hash1",
        issueType: "security",
        issueIndex: 1,
        adjustedLine: 50,
        potentiallyRemediated: false,
      },
    ]);

    const db = getWriteDb()!;
    const rows = db.prepare("SELECT * FROM issue_edit_state ORDER BY issue_index").all() as {
      content_hash: string;
      issue_type: string;
      issue_index: number;
      adjusted_line: number;
      potentially_remediated: number;
    }[];

    expect(rows).toHaveLength(2);
    expect(rows[0].adjusted_line).toBe(42);
    expect(rows[0].potentially_remediated).toBe(1);
    expect(rows[1].adjusted_line).toBe(50);
    expect(rows[1].potentially_remediated).toBe(0);
  });

  it("replaces existing entries for the same content_hash", () => {
    openWriteDb(dbPath);

    writeIssueEditStates([
      { contentHash: "hash1", issueType: "security", issueIndex: 0, adjustedLine: 10, potentiallyRemediated: false },
    ]);
    writeIssueEditStates([
      { contentHash: "hash1", issueType: "security", issueIndex: 0, adjustedLine: 20, potentiallyRemediated: true },
    ]);

    const db = getWriteDb()!;
    const rows = db.prepare("SELECT * FROM issue_edit_state").all() as {
      adjusted_line: number;
      potentially_remediated: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].adjusted_line).toBe(20);
    expect(rows[0].potentially_remediated).toBe(1);
  });

  it("is a no-op when writeDb is null", () => {
    // Don't open -- writeDb is null
    expect(() =>
      writeIssueEditStates([
        { contentHash: "hash1", issueType: "security", issueIndex: 0, adjustedLine: 10, potentiallyRemediated: false },
      ]),
    ).not.toThrow();
  });

  it("is a no-op when states array is empty", () => {
    openWriteDb(dbPath);
    expect(() => writeIssueEditStates([])).not.toThrow();
  });
});

describe("clearEditState", () => {
  it("deletes all edit state entries", () => {
    openWriteDb(dbPath);
    writeIssueEditStates([
      { contentHash: "hash1", issueType: "security", issueIndex: 0, adjustedLine: 10, potentiallyRemediated: false },
      { contentHash: "hash2", issueType: "practice", issueIndex: 0, adjustedLine: 5, potentiallyRemediated: true },
    ]);

    clearEditState();

    const db = getWriteDb()!;
    const count = db.prepare("SELECT COUNT(*) as c FROM issue_edit_state").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("does not throw when writeDb is null", () => {
    expect(() => clearEditState()).not.toThrow();
  });
});

describe("migrateLocalStateDb", () => {
  it("consolidates dismissed_issues from local-state.db into index.db", () => {
    // Create a local-state.db with dismissed_issues
    const localStatePath = path.join(tmpDir, "local-state.db");
    const oldDb = new BetterSqlite3(localStatePath);
    oldDb.exec(`
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
    oldDb.prepare(
      "INSERT INTO dismissed_issues (content_hash, issue_index, flag, reason, note, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hash1", 0, "xss", "false_positive", "test note", 1000);
    oldDb.prepare(
      "INSERT INTO dismissed_issues (content_hash, issue_index, flag, reason, note, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hash2", 1, "sqli", "accepted_risk", null, 2000);
    oldDb.close();

    // openWriteDb triggers consolidation
    openWriteDb(dbPath);

    const db = getWriteDb()!;
    const rows = db
      .prepare("SELECT * FROM dismissed_issues ORDER BY content_hash")
      .all() as { content_hash: string; issue_index: number; flag: string; reason: string; note: string | null }[];

    expect(rows).toHaveLength(2);
    expect(rows[0].content_hash).toBe("hash1");
    expect(rows[0].flag).toBe("xss");
    expect(rows[0].note).toBe("test note");
    expect(rows[1].content_hash).toBe("hash2");
    expect(rows[1].note).toBeNull();

    // local-state.db should be deleted
    expect(fs.existsSync(localStatePath)).toBe(false);
  });

  it("does nothing when local-state.db does not exist", () => {
    // Just open -- no local-state.db present
    openWriteDb(dbPath);

    const db = getWriteDb()!;
    const rows = db.prepare("SELECT * FROM dismissed_issues").all();
    expect(rows).toHaveLength(0);
  });

  it("does not duplicate rows on INSERT OR IGNORE", () => {
    // Pre-insert a row in index.db
    const seedDb = new BetterSqlite3(dbPath);
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS dismissed_issues (
        content_hash TEXT NOT NULL,
        issue_index INTEGER NOT NULL,
        flag TEXT NOT NULL,
        reason TEXT NOT NULL,
        note TEXT,
        dismissed_at INTEGER NOT NULL,
        PRIMARY KEY (content_hash, issue_index)
      )
    `);
    seedDb.prepare(
      "INSERT INTO dismissed_issues (content_hash, issue_index, flag, reason, note, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hash1", 0, "xss", "false_positive", null, 500);
    seedDb.close();

    // Create local-state.db with same key but different data
    const localStatePath = path.join(tmpDir, "local-state.db");
    const oldDb = new BetterSqlite3(localStatePath);
    oldDb.exec(`
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
    oldDb.prepare(
      "INSERT INTO dismissed_issues (content_hash, issue_index, flag, reason, note, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("hash1", 0, "xss", "accepted_risk", "newer", 1000);
    oldDb.close();

    openWriteDb(dbPath);

    const db = getWriteDb()!;
    const rows = db.prepare("SELECT * FROM dismissed_issues").all() as { reason: string }[];
    expect(rows).toHaveLength(1);
    // INSERT OR IGNORE keeps the existing row
    expect(rows[0].reason).toBe("false_positive");
  });
});
