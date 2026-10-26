---
name: content-addressing
description: Content-addressed storage model -- SHA256 hashing, branch-agnostic analysis, incremental scanning, mtime checks, cache hit/miss flow, GC grace periods. Use when working on hashing, caching, incremental analysis, or understanding why analysis is branch-agnostic.
---

# Content-Addressed Storage Model

## Core Principle

Analysis is keyed by **SHA256 of function source code**, not file path or branch. Same function source = same hash = same analysis, regardless of branch, filename, or repository.

```typescript
// packages/core/src/shared.ts
export function computeHash(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}
// Returns 64-character hex string (256 bits)
```

## Benefits

1. **Branch-agnostic:** Same function on `main` and `feature-branch` = same hash = same analysis. No re-analysis when switching branches.
2. **Merge-friendly:** Git merges don't create sync conflicts. Hashes are deterministic.
3. **Insert-only sync:** Supabase rows are effectively immutable. Upsert is always safe.
4. **Deduplication:** Two functions with identical source in different files share one analysis entry.
5. **Team sharing:** New team members pull existing analysis by hash instead of re-running Claude.

## Two-Table Architecture

| Table | Key | Purpose | Synced |
|-------|-----|---------|--------|
| `function_analysis` | `(content_hash, analysis_type)` | Durable analysis cache | Yes (upsert) |
| `file_functions` | `(file_path, function_name)` | Maps current files → hashes | No (rebuilt) |

**Why separate:** `file_functions` is ephemeral -- different branches have different file layouts. It's rebuilt on every scan. `function_analysis` is the persistent, content-addressed cache that can be synced and shared.

## Incremental Scanning Pipeline

```
Phase 1: File Check
  For each source file:
    1. Stat file → get current mtime
    2. Compare with stored file_mtime in file_functions
    3. If mtime unchanged → skip file entirely
    4. If mtime changed → re-parse file

Phase 2: Hash Check
  For each extracted function:
    1. Compute contentHash = SHA256(sourceCode)
    2. Check function_analysis for this hash
    3. If hash exists → CACHE HIT (skip analysis, count as "cached")
    4. If hash missing → add to needsAnalysis queue

Phase 3: Cloud Pull (if authenticated)
  1. Collect all missing hashes
  2. Query Supabase for these hashes (batch of 50)
  3. Import found rows into local DB
  4. Mark imported rows as synced (won't re-push)

Phase 4: Claude Analysis
  1. Re-check: filter out hashes that were pulled in Phase 3
  2. Batch remaining to Claude (10 functions per request)
  3. Store doc + sec rows keyed by content_hash
  4. Mark synced_at = NULL (needs push on next sync)

Phase 5: Update file_functions
  1. Delete old entries for changed files
  2. Insert new (file_path, function_name, content_hash) mappings
  3. Update file_mtime to current value
```

## Cache Hit vs Cache Miss

```
File unchanged (same mtime)?
  → YES: Skip entire file. Don't even parse it.
  → NO: Parse file, extract functions.

Function hash already in function_analysis?
  → YES: Cache hit. Skip analysis. Update last_seen_at.
  → NO: Cache miss. Check cloud → analyze with Claude → store.
```

**last_seen_at:** Updated on every scan that finds a hash. Used by GC to determine how long since a function was last seen in the codebase.

## Garbage Collection

**Manual only:** `npx @ophan/cli gc --days 30`

```
1. Branch check: detect current branch vs default branch
   - On default branch → proceed
   - On feature branch without --force → error + exit(1)
   - On feature branch with --force → warning + proceed
   - Non-git repo → proceed (no branches to protect)
2. Scan codebase → populate file_functions with current hashes
3. Find orphans: hashes in function_analysis but NOT in file_functions
4. Apply grace period: only delete if last_seen_at < (now - maxAgeDays)
5. Create GC tombstones (for sync propagation)
6. Delete from local function_analysis
```

**Branch-aware safety:** The `refreshFileIndex()` step rebuilds `file_functions` from the current checkout. On a feature branch, hashes for functions that only exist on the default branch become "orphaned" and can be GC'd. With Supabase sync, these deletions create tombstones that propagate to the cloud. The branch gate prevents accidental cross-branch deletion. Default branch detection uses `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `"main"`.

**Branch-switching safety (grace period):** Even on the default branch, the 30-day grace period protects: user deletes function on feature branch → hash becomes orphan → user switches back to main → hash is back in file_functions → not orphaned anymore → not deleted.

**GC tombstones:** Before deleting locally, insert into `function_gc` table. On next sync, tombstones propagate to Supabase (delete cloud rows too), then tombstones are cleaned up.

## Content Hash Properties

- **Deterministic:** Same source code always produces same hash
- **Immutable analysis:** Content-addressed rows never need updating (new source = new hash)
- **No conflicts:** Two users analyzing same function independently produce same hash → upsert is idempotent
- **Space cost:** Old hashes accumulate (renamed functions leave orphans) → managed by GC
- **Format changes:** If we change how source is extracted (e.g., include decorators), ALL hashes change → requires re-analysis

## Key Files

- `packages/core/src/shared.ts` -- `computeHash()`, `FunctionInfo` interface
- `packages/core/src/index.ts` -- `analyzeFiles()` (incremental pipeline), `gcAnalysis()`
- `packages/cli/src/watch.ts` -- File watcher with mtime-based change detection
- `packages/cli/src/sync.ts` -- Content-addressed sync (push/pull by hash)
