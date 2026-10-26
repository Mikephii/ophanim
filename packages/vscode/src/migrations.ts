// Migration runner for the VS Code extension.
//
// Self-contained -- does not import from @ophan/core to avoid pulling in
// Anthropic SDK, parsers, etc. The runner is ~30 lines; duplicating it
// is cheaper than adding a cross-package dependency.
//
// Both the CLI (via core's initDb) and the extension share the
// _ophan_migrations table format but maintain independent migration lists.

import type Database from "better-sqlite3";

export interface Migration {
  id: string;
  up: (db: Database.Database) => void;
}

/**
 * Run pending migrations in order. Each migration runs in a transaction --
 * if it fails, the transaction rolls back and the migration is NOT recorded.
 * Returns the list of newly applied migration IDs.
 */
export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
  appliedBy: string,
): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _ophan_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      applied_by TEXT NOT NULL
    )
  `);

  const applied = new Set(
    (
      db.prepare("SELECT migration_id FROM _ophan_migrations").all() as {
        migration_id: string;
      }[]
    ).map((r) => r.migration_id),
  );

  const ran: string[] = [];
  const insert = db.prepare(
    "INSERT INTO _ophan_migrations (migration_id, applied_at, applied_by) VALUES (?, ?, ?)",
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      insert.run(m.id, Date.now(), appliedBy);
    })();
    ran.push(m.id);
  }

  return ran;
}

/** Extension-specific migrations. Run on the shared index.db via better-sqlite3. */
export const EXTENSION_MIGRATIONS: Migration[] = [
  {
    id: "ext_001_state_tables",
    up: (db) => {
      db.exec(`
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS issue_edit_state (
          content_hash TEXT NOT NULL,
          issue_type TEXT NOT NULL,
          issue_index INTEGER NOT NULL,
          adjusted_line INTEGER NOT NULL,
          potentially_remediated INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (content_hash, issue_type, issue_index)
        )
      `);
    },
  },
];
