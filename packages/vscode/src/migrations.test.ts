import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { runMigrations, EXTENSION_MIGRATIONS, type Migration } from "./migrations";

let db: BetterSqlite3.Database;

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
});

afterEach(() => {
  db?.close();
});

describe("runMigrations", () => {
  it("creates _ophan_migrations table if missing", () => {
    runMigrations(db, [], "test");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_ophan_migrations'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
  });

  it("applies pending migrations in order", () => {
    const log: string[] = [];
    const migrations: Migration[] = [
      { id: "m1", up: () => log.push("m1") },
      { id: "m2", up: () => log.push("m2") },
    ];

    const ran = runMigrations(db, migrations, "test");
    expect(ran).toEqual(["m1", "m2"]);
    expect(log).toEqual(["m1", "m2"]);
  });

  it("skips already-applied migrations", () => {
    const log: string[] = [];
    const migrations: Migration[] = [
      { id: "m1", up: () => log.push("m1") },
      { id: "m2", up: () => log.push("m2") },
    ];

    runMigrations(db, migrations, "test");
    log.length = 0;

    // Re-run -- should skip both
    const ran = runMigrations(db, migrations, "test");
    expect(ran).toEqual([]);
    expect(log).toEqual([]);
  });

  it("only runs new migrations when list grows", () => {
    const log: string[] = [];
    runMigrations(db, [{ id: "m1", up: () => log.push("m1") }], "test");
    log.length = 0;

    const ran = runMigrations(
      db,
      [
        { id: "m1", up: () => log.push("m1") },
        { id: "m2", up: () => log.push("m2") },
      ],
      "test",
    );
    expect(ran).toEqual(["m2"]);
    expect(log).toEqual(["m2"]);
  });

  it("records applied_by and applied_at in migration table", () => {
    runMigrations(db, [{ id: "m1", up: () => {} }], "test-runner:1.0");

    const row = db
      .prepare("SELECT * FROM _ophan_migrations WHERE migration_id = ?")
      .get("m1") as { migration_id: string; applied_at: number; applied_by: string };
    expect(row.migration_id).toBe("m1");
    expect(row.applied_by).toBe("test-runner:1.0");
    expect(row.applied_at).toBeGreaterThan(0);
  });

  it("rolls back failed migrations without recording them", () => {
    const migrations: Migration[] = [
      {
        id: "m_fail",
        up: (db) => {
          db.exec("CREATE TABLE test_table (id TEXT)");
          throw new Error("intentional failure");
        },
      },
    ];

    expect(() => runMigrations(db, migrations, "test")).toThrow("intentional failure");

    // Migration should NOT be recorded
    const rows = db
      .prepare("SELECT * FROM _ophan_migrations")
      .all();
    expect(rows).toHaveLength(0);

    // Table created inside the transaction should be rolled back
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(0);
  });
});

describe("EXTENSION_MIGRATIONS", () => {
  it("ext_001_state_tables creates dismissed_issues and issue_edit_state", () => {
    const ran = runMigrations(db, EXTENSION_MIGRATIONS, "test");
    expect(ran).toContain("ext_001_state_tables");

    // Verify tables exist by inserting a row
    db.prepare(
      "INSERT INTO dismissed_issues (content_hash, issue_index, flag, reason, dismissed_at) VALUES (?, ?, ?, ?, ?)",
    ).run("hash1", 0, "xss", "false_positive", Date.now());

    db.prepare(
      `INSERT INTO issue_edit_state (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("hash1", "security", 0, 10, 1, Date.now());

    const dismissed = db.prepare("SELECT * FROM dismissed_issues").all();
    expect(dismissed).toHaveLength(1);

    const editState = db.prepare("SELECT * FROM issue_edit_state").all();
    expect(editState).toHaveLength(1);
  });
});
