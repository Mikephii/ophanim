import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { loadPracticesFromDb, importPractices, validatePractices, buildPracticesPrompt, MAX_PRACTICES, MAX_RULE_LENGTH } from "./practices";
import type { Practice } from "./practices";

// ============ loadPracticesFromDb ============

describe("loadPracticesFromDb", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE practices (
        practice_id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty array when table is empty", () => {
    expect(loadPracticesFromDb(db)).toEqual([]);
  });

  it("loads practices from DB", () => {
    db.prepare("INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)").run("no-eval", "Never use eval()", "error");
    db.prepare("INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)").run("use-const", "Prefer const over let", "info");

    const result = loadPracticesFromDb(db);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("no-eval");
    expect(result[0].severity).toBe("error");
    expect(result[1].id).toBe("use-const");
    expect(result[1].severity).toBe("info");
  });

  it("returns empty array when table does not exist", () => {
    const emptyDb = new Database(":memory:");
    expect(loadPracticesFromDb(emptyDb)).toEqual([]);
    emptyDb.close();
  });
});

// ============ importPractices ============

describe("importPractices", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE practices (
        practice_id TEXT PRIMARY KEY,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      )
    `);
  });

  afterEach(() => {
    db.close();
  });

  it("imports practices into empty table", () => {
    const practices: Practice[] = [
      { id: "no-eval", rule: "Never use eval()", severity: "error" },
    ];
    importPractices(db, practices);

    const rows = db.prepare("SELECT * FROM practices").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].practice_id).toBe("no-eval");
  });

  it("replaces existing practices", () => {
    db.prepare("INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)").run("old-rule", "Old rule", "warning");

    importPractices(db, [
      { id: "new-rule", rule: "New rule", severity: "error" },
    ]);

    const rows = db.prepare("SELECT * FROM practices").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].practice_id).toBe("new-rule");
  });

  it("clears table when given empty array", () => {
    db.prepare("INSERT INTO practices (practice_id, rule, severity) VALUES (?, ?, ?)").run("old-rule", "Old rule", "warning");

    importPractices(db, []);

    const rows = db.prepare("SELECT * FROM practices").all();
    expect(rows).toHaveLength(0);
  });

  it("validates practices during import", () => {
    expect(() => importPractices(db, [
      { id: "CamelCase", rule: "test", severity: "error" },
    ])).toThrow("kebab-case");
  });

  it("round-trips through loadPracticesFromDb", () => {
    const practices: Practice[] = [
      { id: "no-eval", rule: "Never use eval()", severity: "error" },
      { id: "use-const", rule: "Prefer const", severity: "info" },
    ];
    importPractices(db, practices);
    const loaded = loadPracticesFromDb(db);
    expect(loaded).toEqual(practices);
  });
});

// ============ validatePractices ============

describe("validatePractices", () => {
  it("returns empty array for non-array input", () => {
    expect(validatePractices("not array" as any)).toEqual([]);
  });

  it("validates well-formed practices", () => {
    const practices: Practice[] = [
      { id: "no-eval", rule: "Never use eval()", severity: "error" },
    ];
    expect(validatePractices(practices)).toEqual(practices);
  });

  it("caps at MAX_PRACTICES", () => {
    const practices = Array.from({ length: MAX_PRACTICES + 5 }, (_, i) => ({
      id: `rule-${i}`,
      rule: `Rule ${i}`,
      severity: "warning" as const,
    }));

    const result = validatePractices(practices);
    expect(result).toHaveLength(MAX_PRACTICES);
  });

  it("truncates long rules to MAX_RULE_LENGTH", () => {
    const practices: Practice[] = [
      { id: "long-rule", rule: "x".repeat(MAX_RULE_LENGTH + 50), severity: "info" },
    ];

    const result = validatePractices(practices);
    expect(result[0].rule).toHaveLength(MAX_RULE_LENGTH);
  });

  it("throws on non-kebab-case id", () => {
    const practices: Practice[] = [
      { id: "CamelCase", rule: "test", severity: "error" },
    ];
    expect(() => validatePractices(practices)).toThrow("kebab-case");
  });

  it("throws on empty id", () => {
    const practices: Practice[] = [
      { id: "", rule: "test", severity: "error" },
    ];
    expect(() => validatePractices(practices)).toThrow("invalid id");
  });

  it("throws on invalid severity", () => {
    const practices = [
      { id: "test", rule: "test", severity: "critical" },
    ] as Practice[];
    expect(() => validatePractices(practices)).toThrow("invalid severity");
  });

  it("defaults severity to warning when undefined", () => {
    const practices = [
      { id: "test", rule: "test rule" },
    ] as unknown as Practice[];

    const result = validatePractices(practices);
    expect(result[0].severity).toBe("warning");
  });
});

// ============ buildPracticesPrompt ============

describe("buildPracticesPrompt", () => {
  it("returns empty string for empty practices", () => {
    expect(buildPracticesPrompt([])).toBe("");
  });

  it("builds prompt with practice rules", () => {
    const practices: Practice[] = [
      { id: "no-eval", rule: "Never use eval()", severity: "error" },
      { id: "use-const", rule: "Prefer const", severity: "info" },
    ];

    const result = buildPracticesPrompt(practices);
    expect(result).toContain("coding practices");
    expect(result).toContain("no-eval [error]: Never use eval()");
    expect(result).toContain("use-const [info]: Prefer const");
    expect(result).toContain("practiceViolations");
  });

  it("includes all required fields in instructions", () => {
    const result = buildPracticesPrompt([
      { id: "test", rule: "Test rule", severity: "warning" },
    ]);

    expect(result).toContain("flag");
    expect(result).toContain("title");
    expect(result).toContain("description");
    expect(result).toContain("explanation");
    expect(result).toContain("line");
    expect(result).toContain("startText");
    expect(result).toContain("endText");
    expect(result).toContain("severity");
  });
});
