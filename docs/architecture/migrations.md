# Migration & Schema Evolution Strategy

## Overview

Ophan stores analysis in per-repo `.ophan/index.db` SQLite databases on user machines. As features evolve, we need to handle breaking changes without data loss. This document covers the migration system, schema versioning, and strategies for every category of change.

## System Architecture

### Migration Runner

`packages/core/src/migrations.ts` provides the core migration runner. The VS Code extension has its own independent runner at `packages/vscode/src/migrations.ts`. Both share the `_ophan_migrations` tracking table but maintain separate migration lists -- core prefixes with `core_`, extension with `ext_`.

```typescript
export interface Migration {
  id: string;
  up: (db: Database.Database) => void;
}

export function runMigrations(db, migrations, appliedBy): string[]
export function bootstrapMigrations(db, migrations, appliedBy): void
```

**Key behaviors:**
- Each migration runs in its own transaction -- if it fails, the transaction rolls back and the migration is NOT recorded
- `runMigrations()` skips already-applied migrations (checked via `_ophan_migrations` table)
- `bootstrapMigrations()` records all migrations as applied without running them (for fresh DBs)
- Returns list of newly applied migration IDs for logging/diagnostics

### DB Initialization Flow

```
initDb(dbPath)
  ├── Fresh DB (no tables) → createFreshSchema() + bootstrapMigrations()
  └── Existing DB → runMigrations(db, CORE_MIGRATIONS)
```

Fresh databases get the latest schema directly via `createFreshSchema()` (efficient). Then `bootstrapMigrations()` records all migrations as applied so they won't re-run. Existing databases run only pending migrations incrementally.

### Schema Version System

Each `function_analysis` row has a `schema_version` column. `SCHEMA_VERSIONS` in `schemas.ts` tracks the current version per analysis type:

```typescript
export const SCHEMA_VERSIONS: Record<AnalysisType, number> = {
  documentation: 1,
  security: 2,       // v2: added DetailedIssue[] issues
  practices: 1,
};
```

When `analyzeFiles()` checks if a function needs analysis, it verifies the existing row's `schema_version >= current`. Old-version rows are treated as cache misses -- the function is re-analyzed with the current schema and `INSERT OR REPLACE` overwrites the stale row.

This is **incremental**: only functions that appear in the current scan AND have stale `schema_version` get re-analyzed. Functions not in the scan keep their old rows until GC.

## Categories of Changes

| Category | Example | Strategy | Requires Migration? | Requires Re-analysis? |
|----------|---------|----------|---------------------|----------------------|
| New field in analysis JSON | Add `lineText` to `DetailedIssue` | Bump `SCHEMA_VERSIONS`, add `.catch()` default in Zod | No | Yes (incremental) |
| New table | Add `practices` | Core migration: `CREATE TABLE IF NOT EXISTS` | Yes | No |
| New column on existing table | Add `start_line` to `file_functions` | Core migration: `ALTER TABLE ADD COLUMN` | Yes | No |
| Restructure analysis format | Split monolithic → typed rows | Core migration: data transform in transaction. Set `synced_at = NULL` for re-sync | Yes | No (data transformed in-place) |
| New analysis_type | Add `'dataflow'` | Add to `SCHEMA_VERSIONS` + `AnalysisType`. Add insert in `analyzeFiles()` | No | Yes (new type analyzed on next scan) |
| Remove a field from analysis JSON | Remove `securityFlags` | Keep in Zod schema with `.catch([])`. Remove from Claude prompt. Old rows keep the field, new rows don't have it | No | No |

## Decision Tree

```
Is this a change to analysis JSON shape?
  YES → Bump SCHEMA_VERSIONS for affected type
      → Add .catch() default in Zod schema for new fields
      → Old rows re-analyzed incrementally on next scan
      → No migration needed (re-analysis handles it)
  NO → Is this a new table?
      YES → Add CREATE TABLE IF NOT EXISTS migration
          → Update createFreshSchema() to include the new table
      NO → Is this a new column on existing table?
          YES → Add ALTER TABLE ADD COLUMN migration (with try-catch)
              → Update createFreshSchema() to include the new column
          NO → Is this a table restructure?
              YES → Write data-transform migration with transaction
                  → Set synced_at = NULL on affected rows to trigger re-sync
                  → Use CREATE TABLE v2 → INSERT → DROP → RENAME pattern
              NO → Is this a new analysis_type?
                  YES → Add to AnalysisType enum + SCHEMA_VERSIONS
                      → Add Zod schema + TypedAnalysis variant
                      → Add insert statement in analyzeFiles()
                      → No migration needed -- new type appears on next scan
```

## Writing Migrations

### Rules

1. **Migrations are immutable** -- once shipped, never modify. Fix forward with a new migration.
2. **Migrations are idempotent** -- safe to run twice. Use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with try-catch, PRAGMA checks.
3. **Each runs in a transaction** -- rolls back on failure, not recorded as applied.
4. **Never rename tables or columns** -- add new, deprecate old. Renaming breaks concurrent readers (VS Code extension may have the DB open).
5. **Prefix IDs** -- Core: `core_NNN_description`, Extension: `ext_NNN_description`.

### Migration Template

```typescript
{
  id: "core_007_my_new_table",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS my_new_table (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  },
}
```

### ADD COLUMN Template

```typescript
{
  id: "core_008_add_my_column",
  up: (db) => {
    const cols = db
      .prepare("PRAGMA table_info(my_table)")
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === "my_column")) {
      try {
        db.exec("ALTER TABLE my_table ADD COLUMN my_column TEXT DEFAULT ''");
      } catch (_) {}
    }
  },
}
```

### After Adding a Migration

1. Add the migration to `CORE_MIGRATIONS` array in `migrations.ts`
2. Update `createFreshSchema()` in `index.ts` to include the new schema element
3. Add a test verifying idempotency in `migrations.test.ts`
4. Run `pnpm test` in `packages/core` to verify

## Sync Compatibility

When pulling from cloud, pulled rows may have older `schema_version`. The existing `importAnalysis()` uses `INSERT OR IGNORE` -- if a local row already has a newer `schema_version`, the old cloud row won't overwrite it. This is correct.

Even after pull, `analyzeFiles()` will still flag stale rows for re-analysis. The flow:
1. Cloud row with `schema_version=1` arrives via sync
2. `INSERT OR IGNORE` stores it (or skips if local has newer version)
3. Next `analyzeFiles()` scan detects `schema_version < current` → re-analyzes
4. New analysis stored with `INSERT OR REPLACE`, current `schema_version`
5. Next sync push uploads the fresh row

## Zod `.catch()` Defaults

When adding new fields to analysis JSON, always add a `.catch()` default:

```typescript
// In schemas.ts
export const DetailedIssue = z.object({
  // ... existing fields ...
  lineText: z.string().catch(""),      // NEW: defaults to "" for old rows
  confidence: z.enum([...]).catch("medium"), // NEW: defaults to "medium"
});
```

This ensures old rows (without the field) parse successfully. Combined with schema version bumping, old rows will eventually be re-analyzed with the new field populated by Claude.

## Version History

| Version | Type | Change | Strategy Used |
|---------|------|--------|--------------|
| `security: 1` | Initial | `{ dataTags, securityFlags }` | -- |
| `security: 2` | Field addition | Added `issues: DetailedIssue[]` with line-level findings | Schema version bump + `.catch([])` |
| `practices: 1` | New type | `{ violations: DetailedIssue[] }` | New analysis_type |

## Current Migration List

| ID | Description |
|----|-------------|
| `core_001_fresh_schema` | Base tables: `function_analysis`, `file_functions`, `function_gc`, `sync_meta` |
| `core_002_analysis_types` | Monolithic → typed analysis split (`migrateToAnalysisTypes`) |
| `core_003_file_functions_columns` | Add `language`, `entity_type`, `start_line` to `file_functions` |
| `core_004_gc_analysis_type` | Add `analysis_type` to `function_gc`, rebuild PK |
| `core_005_graph_tables` | Graph tables: `function_edges`, `communities`, `community_summaries`, `graph_config`, `community_edges`, `community_signatures` |
| `core_006_practices_table` | `practices` table for team-defined coding rules |

## Key Files

- `packages/core/src/migrations.ts` -- Migration runner + `CORE_MIGRATIONS` list
- `packages/core/src/migrations.test.ts` -- Migration runner tests + idempotency tests
- `packages/core/src/index.ts` -- `initDb()`, `createFreshSchema()`, `analyzeFiles()` with schema-version check
- `packages/core/src/schemas.ts` -- `SCHEMA_VERSIONS`, Zod schemas with `.catch()` defaults
- `packages/vscode/src/migrations.ts` -- Extension migration runner (independent from core)
