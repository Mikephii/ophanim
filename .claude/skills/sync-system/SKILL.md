---
name: sync-system
description: SQLite local ↔ Supabase cloud sync system. Use when working on sync logic, push/pull flows, GC tombstones, account change detection, or any code touching synced_at fields.
---

# Sync System: Local SQLite ↔ Supabase Cloud

## Architecture Overview

Ophan uses a **content-addressed, insert-only sync model**. Local SQLite stores analysis keyed by SHA256 of function source. Supabase mirrors this with RLS scoping. No conflict resolution needed -- same hash = same analysis = safe upsert.

## Two-Table Split

| Table | Scope | Synced | Ephemeral | Lifetime |
|-------|-------|--------|-----------|----------|
| `function_analysis` | Content-addressed (hash → analysis) | Yes (upsert) | No | Persistent until GC |
| `file_functions` | File-addressed (path → hash) | As `function_locations` | Yes | Rebuilt every scan |

**Why split:** `function_analysis` is the durable cache (synced to share across team). `file_functions` is ephemeral -- different branches have different layouts, so it's rebuilt on every scan and full-replaced on sync.

## Local Schema (`.ophan/index.db`)

```sql
-- Persistent analysis cache. Composite PK: one row per hash per analysis type.
CREATE TABLE function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,        -- 'documentation' | 'security'
  analysis JSON NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,      -- Updated each scan; used by GC grace period
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  synced_at INTEGER,                  -- NULL = not yet pushed to cloud
  PRIMARY KEY (content_hash, analysis_type)
);

-- Ephemeral location index. Rebuilt on every scan. Never synced directly.
CREATE TABLE file_functions (
  file_path TEXT NOT NULL,
  function_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  file_mtime INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  start_line INTEGER NOT NULL DEFAULT 0  -- 1-indexed line where function starts in file
);

-- GC tombstone queue. Marks analysis for deletion, propagated to cloud on next sync.
CREATE TABLE function_gc (
  content_hash TEXT NOT NULL,
  analysis_type TEXT,                 -- NULL = delete all types for this hash
  gc_at INTEGER NOT NULL,
  synced_at INTEGER,                  -- NULL = not yet propagated
  PRIMARY KEY (content_hash, analysis_type)
);

-- Sync state tracking
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Current keys: 'last_synced_user_id' (detects account changes)
```

## Supabase Schema

```sql
-- Cloud analysis cache. Scoped by repo + user. RLS enforces user_id = auth.uid().
CREATE TABLE public.function_analysis (
  content_hash TEXT NOT NULL,
  analysis_type TEXT NOT NULL,
  repo_id UUID NOT NULL REFERENCES public.repos(id),
  user_id UUID NOT NULL REFERENCES public.users(id),
  analysis JSONB NOT NULL,
  model_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  security_flag_count INTEGER GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb))
  ) STORED,
  has_security_flags BOOLEAN GENERATED ALWAYS AS (
    jsonb_array_length(COALESCE(analysis->'securityFlags', '[]'::jsonb)) > 0
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, repo_id, analysis_type)
);

-- Cloud location index. Full-replaced on each sync.
CREATE TABLE public.function_locations (
  repo_id UUID NOT NULL,
  user_id UUID NOT NULL,
  file_path TEXT NOT NULL,
  function_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'typescript',
  entity_type TEXT NOT NULL DEFAULT 'function',
  start_line INTEGER NOT NULL DEFAULT 0,  -- 1-indexed, enables file-absolute line numbers in webapp
  PRIMARY KEY (repo_id, file_path, function_name)
);
```

## Push Flow (`syncToSupabase()` in `packages/cli/src/sync.ts`)

### Step 0: Account Change Detection
```
Read sync_meta.last_synced_user_id
If different user → reset all synced_at to NULL + clear function_gc
Store current user_id
```
Prevents data leaking between accounts on shared machines.

### Step 1: Register Repo
Upsert into `repos` table with `onConflict: "user_id,name"`.

### Step 2: Push Unsynced Analysis
```
SELECT ... FROM function_analysis WHERE synced_at IS NULL
→ Batch into chunks of 500
→ Upsert to Supabase (onConflict: "content_hash,repo_id,analysis_type")
→ Mark synced_at = now() locally
```
Insert-only semantics: content-addressed rows are immutable.

### Step 3: Full-Replace Locations
```
DELETE all function_locations for repo_id
INSERT current file_functions as function_locations (batches of 500)
```
Handles file renames/deletions transparently.

### Step 4: Process GC Tombstones
```
SELECT ... FROM function_gc WHERE synced_at IS NULL
→ Delete matching rows from cloud function_analysis + function_locations
→ Mark GC rows as synced, then delete locally (transaction)
```
Type-specific: `analysis_type = 'security'` only deletes security rows.

### Step 5-6: Sync Communities + Summaries
Communities: full-replace (DELETE + INSERT). Summaries: upsert (incremental).

## Pull Flow (`pullFromSupabase()`)

Used **before Claude analysis** to avoid redundant API calls.

```
1. findMissingHashes(dbPath) -- hashes in file_functions but not in function_analysis
2. Batch query Supabase in chunks of 50 (URI length safety)
3. importAnalysis(dbPath, rows) -- INSERT OR IGNORE with synced_at = now()
```

**Defensive defaults:** Missing `schema_version` → 1, missing `language` → "typescript", missing `entity_type` → "function".

## Key Invariants

- **No conflict resolution needed:** Content-addressed = immutable. Same hash = same analysis.
- **synced_at = NULL means "needs push":** After analysis, rows have synced_at = NULL. After push, set to timestamp.
- **Pulled rows arrive pre-synced:** `synced_at = now()` on import prevents re-pushing cloud data.
- **GC is manual only:** `ophan gc --days 30`. Never automatic. Safe for branch switching. Branch-gated: blocks on non-default branch unless `--force`.
- **Account change = full re-sync:** Different user → reset all synced_at → re-push everything.

## Key Files

- `packages/cli/src/sync.ts` -- Push/pull implementation
- `packages/cli/src/sync.test.ts` -- Comprehensive sync tests
- `packages/core/src/index.ts` -- `initDb()`, `gcAnalysis()`, `importAnalysis()`, `findMissingHashes()`
- `packages/core/src/shared.ts` -- `computeHash()`, `FunctionInfo` interface
- `supabase/migrations/` -- Cloud schema migrations
