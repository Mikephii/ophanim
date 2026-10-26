import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  runMigrations,
  bootstrapMigrations,
  CORE_MIGRATIONS,
  type Migration,
} from "./migrations";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
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

  it("records applied_by and applied_at", () => {
    runMigrations(db, [{ id: "m1", up: () => {} }], "core:1.0");

    const row = db
      .prepare("SELECT * FROM _ophan_migrations WHERE migration_id = ?")
      .get("m1") as { migration_id: string; applied_at: number; applied_by: string };
    expect(row.migration_id).toBe("m1");
    expect(row.applied_by).toBe("core:1.0");
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

    const rows = db.prepare("SELECT * FROM _ophan_migrations").all();
    expect(rows).toHaveLength(0);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'")
      .all();
    expect(tables).toHaveLength(0);
  });
});

describe("bootstrapMigrations", () => {
  it("records all migrations as applied without running them", () => {
    const log: string[] = [];
    const migrations: Migration[] = [
      { id: "m1", up: () => log.push("m1") },
      { id: "m2", up: () => log.push("m2") },
    ];

    bootstrapMigrations(db, migrations, "core:bootstrap");
    expect(log).toEqual([]); // up() NOT called

    const rows = db
      .prepare("SELECT migration_id FROM _ophan_migrations ORDER BY migration_id")
      .all() as { migration_id: string }[];
    expect(rows.map((r) => r.migration_id)).toEqual(["m1", "m2"]);
  });

  it("skips already-bootstrapped migrations (INSERT OR IGNORE)", () => {
    const migrations: Migration[] = [{ id: "m1", up: () => {} }];
    bootstrapMigrations(db, migrations, "first");
    bootstrapMigrations(db, migrations, "second");

    const rows = db.prepare("SELECT * FROM _ophan_migrations").all();
    expect(rows).toHaveLength(1);
  });

  it("prevents subsequent runMigrations from re-running bootstrapped migrations", () => {
    const log: string[] = [];
    const migrations: Migration[] = [
      { id: "m1", up: () => log.push("m1") },
      { id: "m2", up: () => log.push("m2") },
    ];

    bootstrapMigrations(db, migrations, "core:bootstrap");
    const ran = runMigrations(db, migrations, "core");
    expect(ran).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe("CORE_MIGRATIONS idempotency", () => {
  it("all migrations run without error on a fresh empty DB", () => {
    const ran = runMigrations(db, CORE_MIGRATIONS, "test");
    expect(ran.length).toBe(CORE_MIGRATIONS.length);

    // Verify key tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("function_analysis");
    expect(tableNames).toContain("file_functions");
    expect(tableNames).toContain("function_gc");
    expect(tableNames).toContain("sync_meta");
    expect(tableNames).toContain("practices");
    expect(tableNames).toContain("function_edges");
    expect(tableNames).toContain("communities");
    expect(tableNames).toContain("community_summaries");
    expect(tableNames).toContain("community_edges");
    expect(tableNames).toContain("community_signatures");
    expect(tableNames).toContain("graph_config");
  });

  it("all migrations are no-ops when run twice", () => {
    runMigrations(db, CORE_MIGRATIONS, "test");

    // Clear migration records and re-run -- should be safe (idempotent)
    db.exec("DELETE FROM _ophan_migrations");
    expect(() => runMigrations(db, CORE_MIGRATIONS, "test")).not.toThrow();
  });
});
