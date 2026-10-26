// Migration runner for @ophan/core.
//
// Mirrors the extension's migration runner (packages/vscode/src/migrations.ts).
// Both share the _ophan_migrations table format but maintain independent
// migration lists -- core prefixes with "core_", extension with "ext_".
//
// Each migration is idempotent (uses IF NOT EXISTS, try-catch for ADD COLUMN)
// and runs in a transaction.

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

/**
 * Record all migrations as applied WITHOUT running them.
 * Used when creating a fresh DB with createFreshSchema() -- the schema
 * is already at the latest state, so migrations don't need to run.
 */
export function bootstrapMigrations(
  db: Database.Database,
  migrations: Migration[],
  appliedBy: string,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _ophan_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      applied_by TEXT NOT NULL
    )
  `);

  const insert = db.prepare(
    "INSERT OR IGNORE INTO _ophan_migrations (migration_id, applied_at, applied_by) VALUES (?, ?, ?)",
  );
  const now = Date.now();
  for (const m of migrations) {
    insert.run(m.id, now, appliedBy);
  }
}

// ============ CORE MIGRATIONS ============
//
// These run on existing databases to bring them up to the current schema.
// For fresh databases, createFreshSchema() creates the latest schema directly
// and bootstrapMigrations() records all of these as applied.
//
// RULES:
// 1. Migrations are immutable -- once shipped, never modify. Fix forward.
// 2. Migrations are idempotent -- safe to run twice (IF NOT EXISTS, try-catch).
// 3. Each runs in a transaction -- rolls back on failure.
// 4. Never rename tables or columns -- add new, deprecate old.

export const CORE_MIGRATIONS: Migration[] = [
  {
    id: "core_001_fresh_schema",
    up: (db) => {
      // Base tables -- CREATE IF NOT EXISTS is a no-op on existing DBs
      db.exec(`
        CREATE TABLE IF NOT EXISTS function_analysis (
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_functions (
          file_path TEXT NOT NULL,
          function_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          file_mtime INTEGER NOT NULL,
          language TEXT NOT NULL DEFAULT 'typescript',
          entity_type TEXT NOT NULL DEFAULT 'function',
          start_line INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (file_path, function_name)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS function_gc (
          content_hash TEXT NOT NULL,
          analysis_type TEXT,
          gc_at INTEGER NOT NULL,
          synced_at INTEGER,
          PRIMARY KEY (content_hash, analysis_type)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  },

  {
    id: "core_002_analysis_types",
    up: (db) => {
      // Detect if we need the monolithic→typed migration by checking for analysis_type column
      const columns = db
        .prepare("PRAGMA table_info(function_analysis)")
        .all() as { name: string }[];
      if (columns.length > 0 && !columns.some((c) => c.name === "analysis_type")) {
        // Import the migration function -- it handles the full transform
        // This is the only migration that needs the complex table replacement logic
        migrateToAnalysisTypes(db);
      }
    },
  },

  {
    id: "core_003_file_functions_columns",
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(file_functions)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "language")) {
        try { db.exec("ALTER TABLE file_functions ADD COLUMN language TEXT NOT NULL DEFAULT 'typescript'"); } catch (_) {}
        try { db.exec("ALTER TABLE file_functions ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'function'"); } catch (_) {}
      }
      if (!cols.some((c) => c.name === "start_line")) {
        try { db.exec("ALTER TABLE file_functions ADD COLUMN start_line INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
      }
    },
  },

  {
    id: "core_004_gc_analysis_type",
    up: (db) => {
      const cols = db
        .prepare("PRAGMA table_info(function_gc)")
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === "analysis_type")) {
        try { db.exec("ALTER TABLE function_gc ADD COLUMN analysis_type TEXT"); } catch (_) {}
        // Rebuild PK by recreating table
        db.exec(`
          CREATE TABLE IF NOT EXISTS function_gc_v2 (
            content_hash TEXT NOT NULL,
            analysis_type TEXT,
            gc_at INTEGER NOT NULL,
            synced_at INTEGER,
            PRIMARY KEY (content_hash, analysis_type)
          )
        `);
        db.exec("INSERT OR IGNORE INTO function_gc_v2 SELECT content_hash, NULL, gc_at, synced_at FROM function_gc");
        db.exec("DROP TABLE function_gc");
        db.exec("ALTER TABLE function_gc_v2 RENAME TO function_gc");
      }
    },
  },

  {
    id: "core_005_graph_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS function_edges (
          source_hash TEXT NOT NULL,
          target_hash TEXT NOT NULL,
          edge_type TEXT NOT NULL,
          weight REAL NOT NULL DEFAULT 1.0,
          PRIMARY KEY (source_hash, target_hash, edge_type)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS communities (
          content_hash TEXT NOT NULL,
          level INTEGER NOT NULL,
          community_id TEXT NOT NULL,
          algorithm TEXT NOT NULL DEFAULT 'louvain',
          PRIMARY KEY (content_hash, level, algorithm)
        )
      `);
      db.exec(`
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
      db.exec(`
        CREATE TABLE IF NOT EXISTS graph_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS community_edges (
          source_community TEXT NOT NULL,
          target_community TEXT NOT NULL,
          algorithm TEXT NOT NULL DEFAULT 'louvain',
          weight REAL NOT NULL DEFAULT 0,
          edge_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (source_community, target_community, algorithm)
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS community_signatures (
          community_id TEXT NOT NULL,
          algorithm TEXT NOT NULL DEFAULT 'louvain',
          signatures JSON NOT NULL,
          PRIMARY KEY (community_id, algorithm)
        )
      `);
    },
  },

  {
    id: "core_006_practices_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS practices (
          practice_id TEXT PRIMARY KEY,
          rule TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'warning'
        )
      `);
    },
  },
];

// ============ LEGACY MIGRATION HELPER ============

/**
 * Migrate from single-blob function_analysis to split analysis types.
 * Called from core_002_analysis_types migration on databases that predate
 * the analysis_type column. Exported for testing.
 */
export function migrateToAnalysisTypes(db: Database.Database) {
  db.exec(`
    CREATE TABLE function_analysis_v2 (
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

  // Split documentation fields
  db.exec(`
    INSERT OR IGNORE INTO function_analysis_v2
      (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    SELECT
      content_hash,
      'documentation',
      json_object(
        'description', json_extract(analysis, '$.description'),
        'params', json_extract(analysis, '$.params'),
        'returns', json_extract(analysis, '$.returns')
      ),
      model_version,
      1,
      created_at,
      last_seen_at,
      COALESCE(language, 'typescript'),
      COALESCE(entity_type, 'function'),
      NULL
    FROM function_analysis
  `);

  // Split security fields
  db.exec(`
    INSERT OR IGNORE INTO function_analysis_v2
      (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    SELECT
      content_hash,
      'security',
      json_object(
        'dataTags', json_extract(analysis, '$.dataTags'),
        'securityFlags', json_extract(analysis, '$.securityFlags')
      ),
      model_version,
      1,
      created_at,
      last_seen_at,
      COALESCE(language, 'typescript'),
      COALESCE(entity_type, 'function'),
      NULL
    FROM function_analysis
  `);

  db.exec("DROP TABLE function_analysis");
  db.exec("ALTER TABLE function_analysis_v2 RENAME TO function_analysis");
}
