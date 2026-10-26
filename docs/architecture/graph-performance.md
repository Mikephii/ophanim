# Graph Performance: Incremental Updates & Caching

Internal architecture doc covering the performance optimization systems that minimize redundant computation during graph analysis and community summarization.

## Problem

Without optimizations, every `ophan graph` run rebuilds all edges from scratch, re-detects communities (getting new arbitrary IDs from Louvain), and re-summarizes every community via Claude. A 1-function edit triggers the same work as a full codebase scan.

## Solution: Three Optimization Layers

```
Layer 1: Incremental Edge Resolution (graph.ts)
   Only recompute edges for changed functions + their neighbors.

Layer 2: Stable Community Matching (graph.ts)
   Remap Louvain's arbitrary new IDs to match old IDs, preserving cache keys.

Layer 3: Two-Gate Summary Cache (summarize.ts)
   Gate 1: Input hash match. Gate 2: Signature drift check.
```

## Layer 1: Incremental Edge Resolution

### How It Works

The CLI snapshots content hashes from `file_functions` before `populateFileIndex()` overwrites the table:

```typescript
// CLI graph command
const oldHashes = new Set(
  db.prepare("SELECT DISTINCT content_hash FROM file_functions").all()
    .map((r: any) => r.content_hash as string)
);
populateFileIndex(db, functions);
detectHierarchicalCommunities(db, functions, config, oldHashes);
```

`analyzeGraph()` computes the symmetric difference (`computeChangedHashes`) and chooses a mode:

| Condition | Mode | What Happens |
|-----------|------|--------------|
| No `oldHashes` param | Full rebuild | DELETE all edges, resolve all, INSERT all |
| `changedHashes.size === 0` | No-change fast path | Load existing edges, skip resolution entirely |
| `changedHashes.size / total <= 0.5` | Incremental | Resolve only affected edges, keep the rest |
| `changedHashes.size / total > 0.5` | Full rebuild | Too much changed, rebuild everything |

### Incremental Mode Detail

1. **Compute affected set**: `changedHashes` (symmetric difference) + all their edge neighbors from `function_edges`. Neighbors must be included because their edges reference changed hashes.
2. **Filter**: Remove hashes no longer in the codebase (deleted functions).
3. **Resolve**: `resolveEdges(db, functions, config, affectedHashes)` -- builds all 4 lookup tables from full data but only iterates affected functions in the main loop.
4. **Store**: `storeEdgesIncremental(db, affectedHashes, newEdges)` -- deletes edges per affected hash, inserts new edges. Single transaction.
5. **Load**: `loadEdges(db)` -- load the complete edge set (old unaffected + new resolved) for community detection.

### Key Functions

- `computeChangedHashes(old, new)` -- Symmetric difference of two `Set<string>`
- `findEdgeNeighbors(db, hashes)` -- Queries `function_edges` for connected hashes (internal, not exported)
- `storeEdgesIncremental(db, affected, edges)` -- Targeted delete + insert in one transaction
- `resolveEdges(db, fns, config, affectedHashes?)` -- When `affectedHashes` provided, skips functions not in the set

## Layer 2: Stable Community Matching

### Problem

Louvain assigns arbitrary integer IDs to communities. Same codebase on two runs might produce `{0, 1, 2}` then `{0, 2, 1}`. Community summaries are keyed by community ID, so ID renumbering invalidates the entire cache.

### Solution: `matchCommunities()`

After Louvain runs, `matchCommunities()` compares new assignments against old (loaded from DB) using Jaccard similarity on member sets:

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

Algorithm:
1. Group old and new assignments by `communityId` → `Set<contentHash>`
2. Compute Jaccard for all (new, old) pairs
3. Filter pairs with Jaccard >= 0.5
4. Sort by Jaccard descending
5. Greedy 1:1 matching: each old/new ID used at most once
6. Remap matched new IDs to old IDs

Applied at both L0 (function-level) and L1 (group-level) community detection.

## Layer 3: Two-Gate Summary Cache

### Gate 1: Input Hash Match

```
existing = loadSummary(db, communityId, level, algorithm)
if (existing && existing.inputHash === computedInputHash)
  → CACHE HIT: reuse summary
```

`inputHash` is SHA256 of sorted member content hashes. With stable community matching, same members = same hash = cache hit.

### Gate 2: Signature Drift Check

When Gate 1 misses (hash changed), checks if the change is "significant":

```
oldSigs = loadCommunitySignatures(db, communityId, algorithm)
if (oldSigs && !hasCommunityDrifted(oldSigs, members))
  → DRIFT-SKIP: reuse old summary, push OLD inputHash (prevents L2/L3 cascade)
else
  → CACHE MISS: call Claude, store new summary + new signatures
```

**Function signature** = `{name: string, paramCount: number}`. Community has "drifted" if:
- More than 20% of members were added or removed (by name)
- More than 20% of surviving members have different param counts

This means bug fixes, refactors, formatting changes, and docstring edits don't trigger re-summarization.

### Cascade Prevention

When drift-skipping, the OLD `inputHash` (not the newly computed one) is pushed into `l1Results`. L2 computes its hash from L1 inputHashes, so unchanged L1 hashes → L2 cache hit → L3 cache hit. Only genuine structural changes cascade upward.

### `community_signatures` Table

```sql
CREATE TABLE community_signatures (
  community_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  signatures JSON NOT NULL,       -- [{name, paramCount}, ...]
  PRIMARY KEY (community_id, algorithm)
);
```

Signatures are stored only when Claude generates a new summary (not on drift-skip).

## Performance Impact

| Scenario | Before | After |
|----------|--------|-------|
| No code changes | Full edge rebuild + full summarization | Skip everything (no-change fast path) |
| 1 function edited | Full edge rebuild + all summaries | ~2% edges rebuilt, 0-1 summaries regenerated |
| Bug fix (no signature change) | Full rebuild + all summaries | Incremental edges, drift-skipped summaries |
| New file added | Full rebuild + all summaries | Incremental edges + only affected summaries |
| Major refactor (>50% changed) | Full rebuild | Full rebuild (intentional fallback) |

## Test Coverage

- `graph.test.ts`: 81+ tests including `computeChangedHashes` (4), `storeEdgesIncremental` (2), `resolveEdges` with `affectedHashes` (1), `analyzeGraph` incremental mode (4), `matchCommunities` (6), `ModuleResolver` (6)
- `summarize.test.ts`: 49 tests including `hasCommunityDrifted` (6), signature storage (2), orchestration drift-skip (3)
