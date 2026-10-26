# Sync Architecture

## Overview

Ophan sync moves analysis data between the local SQLite database (`.ophan/index.db`) and Supabase. Analysis is content-addressed (keyed by SHA256 of function source), making sync insert-only with no conflict resolution.

## Push Sync (`ophan sync`)

Pushes unsynced local analysis to Supabase. Runs explicitly via CLI command.

### Flow

1. **Register repo** -- Upsert into `repos` table (by user_id + name)
2. **Push analysis** -- Select `WHERE synced_at IS NULL`, upsert into Supabase `function_analysis` (conflict on `content_hash, repo_id, analysis_type`)
3. **Sync locations** -- Full replace: delete all `function_locations` for repo, insert current state. Includes `start_line` (1-indexed function start line in file) for file-absolute line number display in the webapp. Absolute file paths from the local DB are converted to repo-relative paths before uploading (the local DB stores absolute paths for file I/O, but cloud paths must be portable across machines)
4. **Process GC** -- Delete Supabase rows for locally-GC'd hashes, clean up tombstones
5. **Sync communities** -- Full replace (gated by docs branch)
6. **Sync community edges** -- Full replace (gated by docs branch)
7. **Sync community summaries** -- Full replace (gated by docs branch)
8. **Record sync commit** -- If architecture synced and repo is a git project, record the current commit hash to `docs_sync_history` and update `repos.last_docs_sync_commit`

### Docs Branch Gate

Architecture data (steps 5-7) is only synced when the CLI detects the current git branch matches the repo's `docs_branch` setting (default `'main'`). This prevents feature branches from overwriting production architecture docs in the cloud.

- **On docs branch**: Architecture data syncs normally (DELETE + INSERT)
- **Not on docs branch**: Architecture sync is skipped entirely. Function analysis and locations still sync.
- **Non-git repos**: The gate is bypassed -- architecture always syncs (there are no branches to conflict)
- **Detached HEAD (CI/CD)**: Returns literal `"HEAD"` -- won't match unless `docs_branch` is set to `"HEAD"`

The `docs_branch` setting is stored in the Supabase `repos` table and configurable from the webapp settings page. It's shared across all team members.

### Sync History

When architecture data syncs successfully from a git repo, the CLI records the current commit hash (`git rev-parse HEAD`) in two places:

- **`docs_sync_history` table** -- Append-only log of every sync event (repo_id, user_id, commit_hash, branch, synced_at). Capped at 50 most recent entries in the webapp UI.
- **`repos` table** -- Quick-access `last_docs_sync_commit` and `last_docs_sync_at` columns updated on each sync. Used by the architecture overview page to show provenance without an extra query.

Non-git repos (where `getGitCommitHash()` returns null) skip history recording entirely. The architecture data still syncs -- there's just no commit hash to track.

The webapp displays this data in two places:
- Architecture overview: "Generated from main · abc123d · 2 days ago"
- Settings page: "View docs sync history" sheet with full history

### Multi-Account Safety

The `sync_meta` table tracks the last synced user ID. If the user switches accounts (`ophan login` as different user), all `synced_at` values are reset to NULL, forcing a full re-sync. This prevents data from one account leaking to another.

## Pull Sync (Automatic)

Pulls existing analysis from Supabase before running Claude. Silent optimization -- never fails the analyze command.

### Flow

During `ophan analyze`:

1. **Scan files** -- Extract functions, compute content hashes, identify which hashes are missing from local `function_analysis`
2. **Check credentials** -- Silently check if user is logged in and repo exists in Supabase
3. **Pull missing** -- Query Supabase for analysis matching missing hashes, import into local SQLite via `importAnalysis()`
4. **Analyze remaining** -- Only call Claude for hashes that are still missing after pull

### Why Phase-Based

The analyze pipeline is structured as three phases:

```
Phase 1: Scan all files → collect all missing hashes
Phase 2: Pull from Supabase (single batch)
Phase 3: Analyze remaining via Claude
```

This is more efficient than per-file pull because:
- Supabase queries batched in chunks of 50 with bounded concurrency (`pLimit(3)`)
- Deduplicates hashes (same function in multiple files = one pull)
- Pull happens before any Claude calls, maximizing cache hits
- Phase 3 fires Claude batches concurrently (`pLimit(5)`) for ~5x speedup

### Silent Failure

Pull is wrapped in try/catch. If the user isn't logged in, the session expired, the repo doesn't exist in Supabase, or the network is down -- pull is silently skipped and analysis proceeds normally with Claude.

## Content Addressing

Analysis is keyed by SHA256 of the function's source code. This provides:

- **Branch agnosticism** -- Same function on any branch = same hash = same analysis
- **Insert-only sync** -- No update conflicts, no merge logic, no timestamps to compare
- **Deduplication** -- Identical functions across repos share the same analysis (within a user's scope)
- **Cache resilience** -- Delete local DB, re-analyze → hashes match, pull from Supabase instead of re-running Claude

## GC Sync

Garbage collection is local-first, sync-aware, and branch-gated:

1. `ophan gc` checks current branch vs default branch (via `git symbolic-ref refs/remotes/origin/HEAD`)
   - On default branch: proceeds normally
   - On feature branch without `--force`: prints warning about cross-branch deletion risk, exits with code 1
   - On feature branch with `--force`: prints warning, proceeds
   - Non-git repo: proceeds normally (no branches to protect)
2. `ophan gc` creates tombstone entries in `function_gc` for hashes being deleted
3. `ophan sync` reads tombstones, deletes matching rows from Supabase
4. After sync, tombstones are cleaned up

With analysis types, each tombstone includes `analysis_type` (or NULL for "delete all types").

**Why branch-gating matters:** `refreshFileIndex()` rebuilds `file_functions` from the current checkout. On a feature branch, functions only present on the default branch become "orphaned" and eligible for GC. If synced, these deletions create tombstones that propagate to the cloud, permanently losing shared analysis.

## Schema

### sync_meta (Local Only)

```sql
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Keys: 'last_synced_user_id'
```

### Sync State Tracking

Each `function_analysis` row has a `synced_at` column:
- `NULL` -- Not yet synced (needs push)
- Timestamp -- Last synced at this time

Rows imported via pull have `synced_at = now()` (they came from Supabase, no need to push back).

## Data Flow Diagram

```
                    ┌──────────────┐
                    │   Supabase   │
                    │  (cloud DB)  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
         push (sync)  pull (analyze)  webapp
              │            │         reads
              ▲            ▼            │
        ┌─────┴────────────┴─────┐     │
        │   .ophan/index.db      │     │
        │   (local SQLite)       │     │
        └─────┬──────────────────┘     │
              │                        │
         CLI analyze                   │
         VS Code ext                   │
         Webview                       │
```
