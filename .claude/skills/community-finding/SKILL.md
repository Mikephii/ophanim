---
name: community-finding
description: Community detection (community-detection.ts), hierarchical LLM summarization (L1-L3), cross-cutting concern detection, and input hash caching. This is a novel, non-standard system. Use when working on community-detection.ts, summarize.ts, community summaries, concern detection, or the architecture UI.
---

# Community Finding: Hierarchical Codebase Understanding

## What Communities Represent

Communities are automatically detected clusters of tightly-coupled functions that form coherent subsystems (e.g., "Authentication Flow", "Database Layer"). Community quality depends critically on **edge resolution quality** -- the graph.ts edge resolution determines which functions are connected and how strongly. See the `graph-system` skill for details on edge types, resolution, and graph construction.

**Architecture:** Community detection lives in `community-detection.ts` as a downstream feature that consumes the graph built by `graph.ts`. The two are decoupled: `graph.ts` builds edges and graph primitives; `community-detection.ts` runs clustering algorithms on those edges. Other features can also consume the graph independently.

The system builds understanding at multiple abstraction levels:

```
Individual Functions (parser output)
    ↓ Graph construction + community detection
L0: Base communities (3-30 functions each)
    ↓ Community edge aggregation
Community edges: inter-community connections (weight + count)
    ↓ Meta-graph Louvain
L1 hierarchy: groups of related L0 communities (stored level=1)
    ↓ Claude summarization
L1: Subsystem documentation (title, markdown docs, security metadata)
    ↓ Claude synthesis per group (or single system_0 fallback)
L2: System-level documentation (group_0, group_1, ... or system_0)
    ↓ Claude synthesis from all L2s
L3: Architecture overview
    ↓ Centrality analysis + tag aggregation
Level 10: Cross-cutting concerns (security patterns, data flows spanning subsystems)
```

## Community Detection Pipeline

**File:** `packages/core/src/community-detection.ts`

### Entry Points

```typescript
// Two-step pipeline (used by CLI graph command):
const edges = buildFunctionGraph(db, functions, config, oldHashes, rootPath);  // graph.ts
const hierResult = detectHierarchicalCommunities(db, edges, functions, config, rootPath);  // community-detection.ts

// Individual steps:
detectAndStoreCommunities(db, edges, functions, config?, rootPath?)  // L0 only
detectCommunities(edges, config, hashToFilePath?, rootPath?, allHashes?)  // pure detection, no storage
```

### Detection Algorithms (Strategy Pattern)

Algorithms are pluggable via `CommunityDetector` interface in `community-detectors/`. Post-processing (dissolution, rescue, splitting, matching) is algorithm-agnostic.

| Algorithm | Detector | Resolution | Deterministic | Notes |
|-----------|----------|------------|---------------|-------|
| Leiden | `LeidenDetector` | Yes | Yes | Custom implementation. Refinement phase ensures connected communities. Default. |
| Louvain | `LouvainDetector` | Yes | Yes | `graphology-communities-louvain`. Fast, returns modularity. |
| Label Propagation | `LabelPropDetector` | No | No | Custom. Fastest, finds natural boundaries. |

### Auto-Resolution

When `autoResolution: true` (default), resolution scales with codebase size: `<50 nodes → ≥1.0`, `50-200 → ≥1.5`, `200+ → ≥2.0`.

### Size Constraints + Dissolution Rescue

- Communities < `minCommunitySize` (default 3) → `"__dissolved"`
- **Rescue pass:** Each dissolved node reassigned to community with strongest total edge weight. Chained rescue supported.
- Communities > `maxCommunitySize` (default 18) → actively split at 2x resolution with quality gate (must produce >1 community, ≤50% dissolved)

### Stable Community Matching

`matchCommunities()` remaps new community IDs to old ones via Jaccard similarity (≥0.5). Prevents summary cache misses from arbitrary ID renumbering.

### Hierarchical Detection (`detectHierarchicalCommunities()`)

```
1. detectAndStoreCommunities() → L0 communities + community edges
2. Build meta-graph: nodes = L0 communities, edges = aggregated cross-community weights
3. If < 3 communities or < 2 edges → skip L1
4. Run detection on meta-graph → L1 group assignments
5. Dissolve groups with < 2 communities
6. Store L1 assignments (level=1, content_hash = L0 community_id)
```

### Community Edges

`computeCommunityEdges()` aggregates function edges into community-level connections. Only cross-community edges, canonical ordering, excluding dissolved. Stored in `community_edges` table.

### Comparison Tooling

`runComparison()` runs same edges through multiple algorithm/parameter configs. `DEFAULT_COMPARISONS` has 7 presets. CLI: `pnpm dev graph --compare --path .`

## Hierarchical Summarization Pipeline

**File:** `packages/core/src/summarize.ts`

### L1 Summarization (Subsystem Level)

**Input per community:**
- All member function names, descriptions, params, returns
- Internal call relationships (edges within community)
- Data tags and security flags per member
- Dynamic length guidance based on community size:
  - Small (<=5): 150-250 words
  - Medium (6-10): 300-600 words
  - Large (>10): 500-1000 words

**Claude prompt requests JSON output:**
```typescript
{
  title: string,              // "Authentication Flow"
  documentation: string,      // Rich markdown: ## title, ### sections
  meta: {
    securityPosture: string,  // "High-risk API endpoints handling credentials"
    dataClassification: [],   // ["credentials", "pii"]
    boundaries: [],           // ["database", "external_api"]
    keyFunctions: [],         // Top 2-3 function names
    complexity: "low" | "medium" | "high"
  }
}
```

### L2 Summarization (System Level)

**Input:** All L1 summaries + cross-community edge counts
- Synthesizes how L1 subsystems interact
- Focuses on data flows and boundaries between subsystems
- Same JSON output format

### L3 Summarization (Architecture Overview)

**Input:** All L2 summaries
- Architecture-level overview of entire codebase
- Covers major systems, patterns, cross-cutting concerns
- Single summary for the whole repo

## Input Hash Caching (Critical for Performance)

**Core principle:** Same member set = same hash = skip re-summarization.

### Hash Computation

```typescript
// L1: SHA256 of sorted member content hashes
computeL1InputHash(memberHashes)
  → SHA256(sorted_hashes.join(","))

// L2: SHA256 of sorted L1 input hashes, prefixed
computeL2InputHash(l1InputHashes)
  → SHA256("L2:" + sorted_hashes.join(","))

// L3: SHA256 of sorted L2 input hashes, prefixed
computeL3InputHash(l2InputHashes)
  → SHA256("L3:" + sorted_hashes.join(","))

// Cross-cutting: SHA256 of tag + bridge hashes + community IDs
computeCCInputHash(concern)
  → SHA256("CC:" + tag + sorted_hashes + sorted_communities)
```

### Two-Gate Cache System

L1 summaries go through a two-gate check before calling Claude:

```
Gate 1: Input Hash Match
  existing = loadSummary(db, communityId, level, algorithm)
  if (existing && existing.inputHash === computedInputHash)
    → CACHE HIT: reuse summary

Gate 2: Signature Drift (when Gate 1 misses)
  oldSigs = loadCommunitySignatures(db, communityId, algorithm)
  if (oldSigs && !hasCommunityDrifted(oldSigs, members))
    → DRIFT-SKIP: reuse old summary, keep old inputHash (prevents L2/L3 cascade)
  else
    → CACHE MISS: call Claude, store new summary + new signatures
```

**Stable Community Matching (Gate 1 enabler)**: After detection, `matchCommunities()` in `community-detection.ts` maps new community IDs to old ones via Jaccard similarity (threshold ≥ 0.5). This prevents ID renumbering from breaking cache lookups.

**Signature Drift (Gate 2)**: `hasCommunityDrifted()` compares function signatures `{name, paramCount}` between old and new community members. A community is "drifted" if >20% of members were added/removed or >20% have changed param counts. Bug fixes, refactors, and formatting changes don't trigger re-summarization.

**Cascade Prevention**: When drift-skipping, the OLD inputHash is pushed to L1 results. L2/L3 compute their hashes from L1 inputHashes, so unchanged L1 hashes mean L2/L3 also cache-hit.

### Hierarchical Invalidation

If an L1 community actually drifts → Claude regenerates → new inputHash → L2's input hash changes → L3's input hash changes. Only genuinely changed levels re-summarize.

## Cross-Cutting Concern Detection

**Location:** `summarize.ts` lines 516-686

This is the most novel part of the system. Detects data flows and security patterns that span multiple communities.

### Detection Algorithm

```
1. Scan all cross-community edges (edges between different L0 communities)

2. For each cross-community edge:
   - Load analysis for both endpoints (source + target hash)
   - Collect dataTags and securityFlags from both

3. Aggregate by tag:
   - For each tag seen on cross-community edges:
     - Collect bridge functions (functions on edges with that tag)
     - Collect affected community pairs
     - Count total cross-edges with that tag

4. Compute median betweenness centrality across all functions

5. Filter for significance:
   - SIGNIFICANT if: 2+ community pairs affected
   - OR: at least one bridge function with centrality > median

6. Sort by priority:
   - Security concerns first (type "security")
   - Then by affected community count (descending)
```

### Concern Types

| Type | Source | Example |
|------|--------|---------|
| `security` | `securityFlags` on cross-community edges | "SQL Injection Risk spanning Auth + Database" |
| `data_flow` | `dataTags` on cross-community edges | "PII flows from User Input to Database Layer" |

### Output Per Concern

```typescript
{
  tag: "pii",                              // The data tag or security flag
  concernType: "data_flow",               // "data_flow" | "security"
  bridgeFunctions: [
    {
      functionName: "saveUser",
      contentHash: "hash_xyz",
      communityId: "3",                    // Which community this bridge is in
      centrality: 0.82                     // Betweenness centrality score
    }
  ],
  affectedCommunities: [
    { communityId: "1", communityTitle: "Authentication" },
    { communityId: "3", communityTitle: "Database Layer" }
  ],
  crossEdgeCount: 5
}
```

### Claude Summarization of Concerns

Each significant concern gets a Claude-generated narrative (200-400 words):
- What the concern is and why it matters
- Which subsystems are affected and how they connect
- Bridge functions and their role
- Remediation suggestions for security concerns

Stored with `level=10` in `community_summaries` table.

## L1 Context Building

Each L1 community gets a rich context object for Claude. Two modes:

**Analysis mode (default):** `buildL1Context()` loads descriptions, params, returns from `function_analysis` table. Requires `ophan analyze` to have been run.

**Raw-source mode (`--raw-source`):** `buildL1RawContext()` uses raw function source code from a `sourceMap` (contentHash → sourceCode). `description` field contains the source code, `params`/`returns` are empty. Still loads `dataTags`/`securityFlags` from `function_analysis` if available.

Cache separation: `computeL1InputHash(hashes, rawSource)` prefixes with `"RAW:"` when `rawSource=true`, so input hashes never collide between modes. Switching modes forces re-summarization.

```typescript
interface L1CommunityContext {
  communityId: string;
  algorithm: string;
  members: [{
    contentHash: string;
    functionName: string;
    filePath: string;
    description: string;         // Analysis summary OR raw source code
    params: Param[];             // From analysis (empty in raw-source mode)
    returns: Returns;            // From analysis (empty in raw-source mode)
    dataTags: string[];
    securityFlags: string[];
    callsTo: string[];           // Names of functions this member calls (within community)
    calledBy: string[];          // Names of functions that call this member (within community)
  }];
  inputHash: string;
  internalEdges: [{ from: string; to: string; type: string }];
}
```

## Orchestration (`summarizeCommunities()`)

```
1. L1: For each community with analysed members:
   - Pass 1: Build L1 context + check cache (sync, sequential)
   - Pass 2: Fire all cache misses in parallel via pLimit(5)
   - Store summary in community_summaries (level=1)

2. L2 (Hierarchy-Aware):
   - Check communities table for level=1 hierarchy assignments
   - If 2+ distinct groups exist:
     - Group L1 summaries by their L1 parent group
     - Create per-group L2 summaries (community_id = "group_{groupId}")
     - Each group summarized independently with its own cross-edges
   - Else (no hierarchy or single group):
     - Fallback to single "system_0" L2 summary (backward compat)
   - All variants check input_hash cache

3. L3: If any L2 exists:
   - loadAllSummaries(db, algorithm, 2) → picks up all L2s (group_* or system_0)
   - Check input_hash cache for "architecture"
   - Miss → Claude L3 from all L2s

4. Cleanup: Delete orphaned L2 summaries (e.g., stale system_0 or group_*)

5. Cross-Cutting Concerns:
   - Compute betweenness centrality
   - Detect cross-community edges with shared tags
   - Filter for significance
   - Pass 1: Check cache, collect work
   - Pass 2: Fire cache misses in parallel via pLimit(5)
   - Store with level=10

6. Cleanup: Delete orphaned CC summaries (level=10)
```

### Orphan Cleanup

When communities change between runs (e.g., community IDs change, hierarchy appears/disappears), stale `community_summaries` rows are cleaned up automatically via `cleanupOrphanedSummaries()`. Each level tracks active IDs during the run and deletes rows not in the active set:

- **L1**: After all L1 summaries processed, before early return
- **L2**: After L2 summaries processed (cleans stale `system_0` or `group_*`)
- **L3**: Single row (`architecture`), always replaced -- no orphan risk
- **CC**: After all concern summaries processed

Supabase sync uses **DELETE + INSERT** (not upsert), so remote state always mirrors local.

Progress callbacks report each step for CLI/UI feedback.

## Database Schema

```sql
CREATE TABLE community_summaries (
  community_id TEXT NOT NULL,
  level INTEGER NOT NULL,            -- 1=subsystem, 2=system, 3=architecture, 10=concern
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  input_hash TEXT NOT NULL,          -- Cache invalidation key
  summary JSON NOT NULL,             -- { title, documentation, meta }
  model_version TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, level, algorithm)
);
```

**Supabase version** adds `repo_id`, `user_id` columns for multi-tenant scoping.

## UI Integration

| Page | Data | Component |
|------|------|-----------|
| Architecture overview | L3 + grouped/flat L1 cards + concerns | `routes/dashboard/repos/$repoId/architecture/index.tsx` |
| Community detail | L1 summary + related subsystems + related concerns + member functions + breadcrumbs | `routes/.../architecture/$communityId.tsx` |
| Concern detail | Concern summary + bridges + affected subsystems | `routes/.../architecture/concerns/$concernId.tsx` |
| Community card | Title, excerpt, meta badges | `components/dashboard/community-card.tsx` |
| Concern card | Title, type badge, severity, affected count | `components/dashboard/concern-card.tsx` |

### Architecture Overview: Grouped vs Flat Layout

If `hierarchy.groups.length > 0`, the overview shows communities grouped by their L1 parent:
- Each group gets an `<h3>` heading with the group title (from L2 summary)
- Ungrouped communities (not in any group) shown in "Other" section

If no groups exist, falls back to flat grid of all L1 communities.

### Community Detail: New Sections

- **Breadcrumbs**: `Architecture / [Group Name] / Community Title` (group only if `parentGroup` exists)
- **Related Subsystems**: Linked cards from `community_edges` (sorted by weight descending)
- **Cross-Cutting Concerns**: Concern cards filtered by `affectedCommunities` containing this community

### Server Functions (architecture.ts)

- `getArchitectureHierarchy`: Also fetches L1 hierarchy from `communities` (level=1), builds `L1Group[]` from hierarchy + L2 titles
- `getCommunityDetail`: Also fetches community edges (source + target), concern summaries (level=10), parent group (level=1)

### Types

- `RelatedCommunity`: `{ communityId, title, weight, edgeCount }`
- `L1Group`: `{ groupId, title, l1Communities: CommunitySummary[] }`
- `EnrichedL1Summary` extended with: `relatedCommunities`, `relatedConcerns`, `parentGroup`
- `ArchitectureHierarchy` extended with: `groups: L1Group[]`

## Key Files

- `packages/core/src/community-detection.ts` -- Community detection, matching, hierarchical grouping, comparison tooling
- `packages/core/src/community-detection.test.ts` -- 76 tests for detection, matching, hierarchy, comparison, detectors
- `packages/core/src/community-detectors/` -- Algorithm implementations: `louvain.ts`, `leiden.ts`, `label-prop.ts`, `types.ts`, `index.ts`
- `packages/core/src/summarize.ts` -- All summarization + concern detection + hierarchical L2 logic
- `packages/core/src/summarize.test.ts` -- 68 tests for caching, context building, orchestration, hierarchical L2, orphan cleanup
- `packages/core/src/graph.ts` -- Foundation: edge resolution, graph construction (consumed by community detection)
- `packages/webapp/src/routes/dashboard/repos/$repoId/architecture/` -- UI pages
- `packages/webapp/src/services/api/architecture.ts` -- Server functions for architecture data
- `packages/webapp/src/services/api/types.ts` -- Types including RelatedCommunity, L1Group
- `packages/webapp/src/components/dashboard/community-card.tsx` -- Community display
- `packages/webapp/src/components/dashboard/concern-card.tsx` -- Concern display
- `supabase/migrations/00003_community_summaries.sql` -- Community summaries cloud schema
- `supabase/migrations/00004_community_edges.sql` -- Community edges cloud schema
