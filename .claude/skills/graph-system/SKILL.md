---
name: graph-system
description: Codebase connectedness graph -- edge resolution, graph construction, centrality analysis. Foundation layer that downstream features consume. Use when working on graph.ts, edge types, weights, buildFunctionGraph, or the graphology library.
---

# Graph System: Codebase Connectedness

## Overview

Foundation layer that builds an undirected weighted graph of function relationships from parser-extracted data. Uses `graphology` for graph construction and algorithms. Content-addressed nodes (SHA256 hashes) make the graph branch-agnostic and syncable.

**Architecture:** `graph.ts` is the foundation layer. It produces graph primitives (edges, graphology graph, centrality scores) that downstream features consume independently:
- Community detection (`community-detection.ts`) -- clustering, matching, hierarchical grouping
- Summarization (`summarize.ts`) -- LLM-powered subsystem documentation
- Visualization, PR impact analysis, team ownership (future)

`graph.ts` must never import or depend on downstream features. The CLI orchestrates features as independent steps: `buildFunctionGraph()` → `detectHierarchicalCommunities()` → `summarizeCommunities()`.

## Nodes and Edges

**Nodes:** Content hash strings (SHA256 of function source code). Each unique function = one node.

**Edge Types** (7 types with configurable weights -- 5 direct + 2 derived):

```typescript
interface FunctionEdge {
  sourceHash: string;
  targetHash: string;
  edgeType: "call" | "type_ref" | "import" | "co_location" | "jsx_ref" | "transitive_call" | "co_caller";
  weight: number;
}
```

| Type | Default Weight | Signal | Source |
|------|---------------|--------|--------|
| `call` | 0.5 | Direct function calls (`fnA()` calls `fnB()`) | Parser |
| `type_ref` | 0.5 | Type references (infrastructure ready, not yet extracted) | Parser |
| `import` | 0.2 | Relative file imports (`./utils`, `../auth`) | Parser |
| `co_location` | 0.7 | Functions in same file, weight decaying by distance (1/offset) | Parser |
| `jsx_ref` | 0.2 | JSX component references (`<Button />`, `<Card />`) | Parser |
| `transitive_call` | 0.4 | 2-hop call chains: A→B→C creates A↔C | Derived |
| `co_caller` | 0.4 | Shared caller: A calls B and C creates B↔C | Derived |

## Graph Configuration

```typescript
interface GraphConfig {
  algorithm: string;            // "leiden" (default), "louvain", "label-propagation", or any registered detector
  edgeWeights: { call, type_ref, import, co_location, jsx_ref, transitive_call, co_caller };
  resolution: number;           // Higher = more, smaller communities. Default: 3.0
  minCommunitySize: number;     // Default: 3. Smaller clusters → "__dissolved"
  maxCommunitySize: number;     // Default: 18. Oversized clusters actively split
  autoResolution?: boolean;     // Default: true. Scales resolution with codebase size
  directoryDecay?: number;     // Default: 0.7. Exponential decay for directory distance between files
}
```

Stored in `graph_config` table (key='config', value=JSON). Loaded with `loadGraphConfig(db)`, saved with `saveGraphConfig(db, config)`.

## Edge Resolution (Strategy Pattern)

Edge resolution uses the **Edge Resolver Strategy Pattern** -- each edge type is handled by its own class implementing the `EdgeResolver` interface. The orchestrator (`resolveEdges()` in `graph.ts`) builds a shared `EdgeResolverContext` once, then delegates to all registered resolvers.

**Files:** `packages/core/src/edge-resolvers/`

```typescript
interface EdgeResolver {
  readonly edgeTypes: readonly string[];
  resolve(ctx: EdgeResolverContext): FunctionEdge[];
}

// Registry API
registerEdgeResolver(resolver)   // Add a new edge resolver
getEdgeResolvers()               // Get all registered resolvers
```

### EdgeResolverContext (shared lookup maps)

Built once per `resolveEdges()` call via `buildEdgeResolverContext()`. All resolvers receive the same context:

```typescript
interface EdgeResolverContext {
  nameToHashes: Map<string, Set<string>>;       // function_name → content hashes
  fileToHashes: Map<string, Set<string>>;       // file_path → content hashes
  fileNameToHash: Map<string, string>;          // "file::name" → content hash
  pkgNameToHashes: Map<string, Map<string, Set<string>>>;  // barrel fallback
  fileToSortedFns: Map<string, FunctionInfo[]>; // file → sorted functions
  functions: FunctionInfo[];
  config: GraphConfig;
  affectedHashes?: Set<string>;                 // incremental mode filter
  resolver?: ModuleResolver;                    // workspace resolver
}
```

### Built-in Edge Resolvers

#### 1. CallEdgeResolver (`edge-resolvers/call.ts`)
- Looks up each `fn.calls[]` name in `nameToHashes`
- Creates edge from caller hash to callee hash
- Skips self-calls
- Handles name collisions (same name in multiple files → edges to all)

#### 2. JsxRefEdgeResolver (`edge-resolvers/jsx-ref.ts`)
- Looks up each `fn.jsxRefs[]` name in `nameToHashes`
- Same resolution logic as call edges but with `jsx_ref` weight (0.2)
- **JSX references are separate from calls:** `<AlertDialog>` is UI composition (weak domain signal), not the same as calling `validateEmail()` (strong domain signal). Without this separation, functions using shared UI components get pulled into the UI component's community.

#### 3. CoLocationEdgeResolver (`edge-resolvers/co-location.ts`)

**Same-file co-location only:**
- Connects **all pairs** of functions within the same file
- Functions sorted by `startLine` within each file
- Weight decays inversely with distance: `base_weight / offset`
  - Adjacent (distance 1): full weight (0.7)
  - Distance 2: half weight (0.35)
  - Distance N: `0.7 / N`
- Result: `N*(N-1)/2` edges per file (most files are small, so this is manageable)
- Deduplicated via canonical hash ordering Set

**No cross-file directory edges:** Directory co-location was removed because it produced O(n²) noise edges per directory (e.g., `components/ui/` with 150 functions generated 11,000+ edges between unrelated UI components). Cross-file relationships are better captured by import, call, and jsx_ref edges. Single-function files with zero edges are handled by community detection's dissolution rescue.

#### 4. ImportEdgeResolver (`edge-resolvers/import.ts`)
- Delegates module resolution to the **Module Resolver Registry** (`getModuleResolverForFile()`)
- **Targeted:** Creates edges only to functions whose names appear in `imp.names`
- **Barrel file fallback:** When a workspace package import resolves to a barrel file (index.ts with re-exports), falls back to `pkgNameToHashes` -- a pre-built map of all function names within the package scope
- **Namespace fallback:** If no named import matched (e.g., `import * as utils`), falls back to intersection of `fn.calls` with functions in the target file
- **Type import filtering:** The TypeScript parser skips `import type { X }` declarations and `import { type X }` specifiers, so only runtime imports produce names for edge matching
- Deduplicated via canonical hash ordering Set (handles bidirectional imports)

### Adding a New Edge Resolver

1. Create `edge-resolvers/my-edge.ts` implementing `EdgeResolver`
2. Register in `edge-resolvers/index.ts`: `registerEdgeResolver(new MyEdgeResolver())`
3. The orchestrator automatically picks it up -- no changes to `graph.ts`

### 5. Type Reference Edges
Infrastructure ready but not yet extracted by parsers. When implemented, add a `TypeRefEdgeResolver`.

## Transitive Edges (`addTransitiveEdges()`)

Derived from direct call edges and **stored in the DB** via `storeTransitiveEdges()`. Computed by `buildFunctionGraph()` after direct edge resolution and stored alongside direct edges. On the no-change fast path, loaded from DB without recomputation. On incremental/full rebuilds, old transitive edges are deleted and recomputed from current call edges.

### Transitive Call (A→B→C → A↔C)
- Builds directed call adjacency from `call` edges
- For each 2-hop chain A→B→C, creates edge A↔C with weight `transitive_call` (0.4)
- Skips self-loops (A→B→A)
- Deduplicates within transitive_call edges only (not against direct edges -- stacking is intentional)

### Co-Caller (A→B, A→C → B↔C)
- For each function A that calls B and C, creates edge B↔C with weight `co_caller` (0.4)
- **Cap at 15 callees per caller** to prevent hub functions from generating O(n²) edges
- Deduplicates within co_caller edges only

Stacking with direct edges is intentional: if A calls C directly (0.5) AND A→B→C produces a transitive edge (0.4), both contribute to the merged graph weight (0.9). Being related in multiple ways increases connection strength.

## Module Resolution (Strategy Pattern)

Module resolution uses the **Language Module Resolver Strategy Pattern** -- each language ecosystem has its own resolver implementing the `LanguageModuleResolver` interface. The `ImportEdgeResolver` uses the registry to find the right resolver for each file.

**Files:** `packages/core/src/module-resolvers/`

```typescript
interface LanguageModuleResolver {
  readonly language: string;
  readonly extensions: readonly string[];
  resolveModuleToFile(importModule, importerFilePath, fileToHashes, workspaceResolver?): string | undefined;
}

// Registry API
registerModuleResolver(resolver)           // Add a new language resolver
getModuleResolver(language)                // Look up by language name
getModuleResolverForFile(filePath)         // Look up by file extension
```

### Built-in: JavaScriptModuleResolver (`module-resolvers/javascript.ts`)

Handles `.ts`, `.tsx`, `.js`, `.jsx` files. Three resolution paths:

1. **Relative imports** (`./`, `../`): resolve relative to importing file
2. **Workspace packages** (`@ophan/core/schemas`): match package name, resolve via `exports` field or fallback to `src/` convention
3. **Path aliases** (`@/components/ui/button`): read tsconfig.json `compilerOptions.paths` for the importer's package, substitute and resolve

- External packages (`express`, `fs`, `@tabler/icons-react`) produce no edges -- they don't match any workspace package or alias
- Path resolution probes extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`
- Also tries index files: `./foo` → `./foo/index.ts`

### Adding a New Language Resolver

1. Create `module-resolvers/my-lang.ts` implementing `LanguageModuleResolver`
2. Register in `module-resolvers/index.ts`: `registerModuleResolver(new MyLangResolver())`
3. The `ImportEdgeResolver` automatically uses it for matching file extensions

### Workspace Module Resolution (`ModuleResolver`)

Built once per graph run via `buildModuleResolver(rootPath, functions)` (stays in `graph.ts`):

```typescript
interface ModuleResolver {
  workspacePackages: Map<string, { dir: string; exports: Record<string, string> }>;
  pathAliases: Map<string, { baseUrl: string; paths: Record<string, string[]> }>;
}
```

### Package Discovery (`discoverPackageDirs()`)
Technology-agnostic: walks UP from analyzed file directories looking for marker files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `setup.py`, `pom.xml`). No assumptions about directory naming -- works on any monorepo layout or single-package project.

- For each discovered directory with a marker file, reads `package.json` for `name` + `exports` and `tsconfig.json` for path aliases
- Degrades gracefully: no marker files → empty resolver → only relative imports produce edges

## Directory Distance Decay

Instead of binary same/different-package penalty, uses continuous directory distance:

```typescript
computeDirectoryDistance(fileA, fileB, rootPath) → number of unique directory segments
// exp(-directoryDecay * distance) applied to edge weights in buildGraph()
```

- Same directory → 0 distance → no penalty
- Sibling directories → distance 2 → small penalty
- Different package subtrees → distance 4+ → larger penalty
- Technology-agnostic: works on ANY codebase with zero configuration

## Graph Building (`buildGraph()`)

Uses `graphology` (undirected graph):

```typescript
buildGraph(edges, hashToFilePath?, rootPath?, directoryDecay?, allHashes?)
```

- **`allHashes`:** When provided (a `Set<string>` of ALL extracted function hashes), every hash is added as a node -- even functions with zero edges. Without this, only functions appearing in edges become nodes. The `analyzeGraph()` pipeline passes all hashes through, ensuring 100% of functions are visible.
- **Directory decay:** Edge weights are multiplied by `exp(-directoryDecay * distance)` based on directory distance between the two files.
- **Edge merging:** Different edge types between the same pair are summed: e.g., `call (1.0) + co_location (0.3) = merged weight 1.3`
- **Pre-computed segments:** Directory segments for each node are cached once, avoiding repeated path operations per-edge.

## Community Detection

Community detection is decoupled into `community-detection.ts` -- a downstream feature that consumes the graph. See the `community-finding` skill for full details on detection algorithms, dissolution/rescue, active splitting, hierarchical detection, and comparison tooling.

The algorithm registry (`community-detectors/`) and `GraphConfig` (algorithm, resolution, min/max sizes) remain shared. `graph.ts` stores the config but does not import from `community-detection.ts`.

## Centrality Analysis (`computeCentrality()`)

Uses **betweenness centrality** from `graphology-metrics`:
```typescript
betweennessCentrality(graph, { getEdgeWeight: "weight", normalized: true })
```
- Identifies "bridge" functions that many shortest paths pass through
- Scores normalized 0-1
- Used for cross-cutting concern detection (high centrality = connects communities)

## Database Schema

```sql
CREATE TABLE function_edges (
  source_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_hash, target_hash, edge_type)
);

CREATE TABLE communities (
  content_hash TEXT NOT NULL,
  level INTEGER NOT NULL,        -- 0=base detection, 1=hierarchical groups
  community_id TEXT NOT NULL,    -- "0", "1", ... or "__dissolved"
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  PRIMARY KEY (content_hash, level, algorithm)
);

CREATE TABLE community_edges (
  source_community TEXT NOT NULL,
  target_community TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  weight REAL NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_community, target_community, algorithm)
);

CREATE TABLE graph_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL             -- JSON serialized GraphConfig
);
```

## Graph Building Pipeline (`buildFunctionGraph()`)

`buildFunctionGraph()` is the main entry point for building the function relationship graph. It handles edge resolution (full or incremental), storage, and transitive edge derivation. Returns all edges (stored + transitive) ready for downstream consumers.

```typescript
function buildFunctionGraph(
  db: Database.Database,
  functions: FunctionInfo[],
  config?: GraphConfig,
  oldHashes?: Set<string>,
  rootPath?: string,
): FunctionEdge[]
```

### Three Modes

```
1. No oldHashes provided → Full rebuild (first run)
2. oldHashes provided, changedHashes.size === 0 → No-change fast path (load existing edges)
3. oldHashes provided, changedHashes.size / total <= 0.5 AND function_edges non-empty → Incremental mode
4. oldHashes provided, changedHashes.size / total > 0.5 OR function_edges empty → Full rebuild
```

**Invariant:** Incremental mode requires existing edges in `function_edges` to find neighbors via `findEdgeNeighbors()`. Without prior edges, the affected set is too small (just the changed hashes with no neighbors) and produces a near-empty graph. This happens when `file_functions` was populated by `watch`/`init` but `graph` has never been run -- the code checks `COUNT(*) FROM function_edges > 0` before entering incremental mode.

### Full Rebuild

```
1. loadGraphConfig(db)                      → Load config or defaults
2. resolveEdges(db, fns, config)            → Name→hash edge resolution (direct edges)
3. storeEdges(db, directEdges)              → DELETE all + INSERT direct edges
4. addTransitiveEdges(directEdges, config)  → Derive transitive_call + co_caller edges
5. storeTransitiveEdges(db, transitiveOnly) → Store transitive edges alongside direct
```

### Incremental Mode (< 50% changed)

```
1. computeChangedHashes(old, new)           → Symmetric difference
2. findEdgeNeighbors(db, changedHashes)     → Find all hashes connected to changed ones
3. affectedHashes = changedHashes ∪ neighbors (filtered to still-existing hashes)
4. resolveEdges(db, fns, config, affectedHashes) → Only resolve edges for affected functions
5. storeEdgesIncremental(db, affected, newEdges) → Delete affected edges, insert new
6. loadEdges(db), filter out old transitive → Get current direct edges
7. addTransitiveEdges + storeTransitiveEdges → Recompute and store transitive
```

### CLI Integration (Two-Step Pipeline)

```typescript
// packages/cli/src/index.ts -- graph command
const oldHashes = new Set(
  db.prepare("SELECT DISTINCT content_hash FROM file_functions").all()
    .map((r: any) => r.content_hash as string)
);
populateFileIndex(db, functions);

// Step 1: Build the graph (edges)
const edges = buildFunctionGraph(db, functions, config, oldHashes, rootPath);

// Step 2: Detect communities on the graph (separate feature)
const hierResult = detectHierarchicalCommunities(db, edges, functions, config, rootPath);
```

The snapshot must happen BEFORE `populateFileIndex()` which overwrites `file_functions`.

### Key Functions

- `buildFunctionGraph(db, functions, config?, oldHashes?, rootPath?)` -- Main entry point, returns `FunctionEdge[]`
- `computeChangedHashes(old, new)` -- Symmetric difference of two hash sets
- `findEdgeNeighbors(db, hashes)` -- Queries `function_edges` for connected hashes (internal, not exported)
- `storeEdgesIncremental(db, affectedHashes, newEdges)` -- Deletes edges per affected hash, inserts new

## Dependencies

- `graphology` -- Graph data structure
- `graphology-metrics` -- Betweenness centrality

## Key Files

- `packages/core/src/graph.ts` -- Foundation: edge resolution, graph construction, centrality, `buildFunctionGraph()` pipeline
- `packages/core/src/community-detection.ts` -- Downstream feature: community detection, matching, hierarchical grouping, comparison
- `packages/core/src/edge-resolvers/` -- Edge resolver strategy pattern: `types.ts`, `call.ts`, `jsx-ref.ts`, `co-location.ts`, `import.ts`, `index.ts`
- `packages/core/src/module-resolvers/` -- Language-specific module resolution: `types.ts`, `javascript.ts`, `index.ts`
- `packages/core/src/community-detectors/` -- Community detection algorithms: `types.ts`, `louvain.ts`, `label-prop.ts`, `leiden.ts`, `index.ts`
- `packages/core/src/graph.test.ts` -- 73 tests for graph primitives (edge resolution, storage, building, centrality, transitive edges)
- `packages/core/src/community-detection.test.ts` -- 76 tests for community detection (clustering, matching, hierarchical, comparison, detectors)
- `packages/core/src/edge-resolvers/edge-resolvers.test.ts` -- Unit tests for edge resolvers + registry
- `packages/core/src/module-resolvers/module-resolvers.test.ts` -- Unit tests for module resolvers + registry
- `packages/core/src/parsers/typescript.ts` -- Call extraction including JSX components
- `packages/core/src/shared.ts` -- FunctionInfo with `calls[]`, `imports[]`, `exported`
