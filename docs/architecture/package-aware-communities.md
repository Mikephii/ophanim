# Package-Aware Community Detection

## Implementation Status

**Directory Distance Decay:** Implemented. Continuous exponential decay `exp(-directoryDecay * distance)` applied to edge weights in `buildGraph()`. CLI flag: `--directory-decay`. Default: 0.7. Technology-agnostic -- works on any codebase regardless of directory structure.

**Marker File Discovery:** Implemented. `discoverPackageDirs()` walks up from analyzed file directories looking for marker files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `setup.py`, `pom.xml`). No hardcoded directory naming assumptions.

**Post-Detection Package Labeling:** Implemented. `computePackageBreakdown()` computes per-community package distribution using resolver or directory segment fallback. `formatPackageBreakdown()` renders human-readable string. Included in `L1CommunityContext.packageInfo`.

## Design Principles

1. **Directory distance is the universal signal** -- works on ANY codebase with zero configuration, no marker files needed
2. **Marker file discovery is an enhancement** -- when available (package.json, go.mod, etc.), improves import resolution and package labeling
3. **Graceful degradation** -- no marker files? Relative imports still produce edges, directory distance still provides clustering signal

## How It Works

### Directory Distance

`computeDirectoryDistance(fileA, fileB, rootPath)` computes the number of unique directory segments when traversing from one file's directory to the other via their common ancestor.

Examples (relative to `/repo`):
- `src/components/Button.tsx` vs `src/components/Input.tsx` → distance 0 (same dir, no penalty)
- `src/components/Button.tsx` vs `src/utils/format.ts` → distance 2 (sibling dirs)
- `packages/core/src/graph.ts` vs `packages/webapp/src/App.tsx` → distance 4

In `buildGraph()`, edge weights are scaled by `exp(-directoryDecay * distance)`:
- Distance 0 → factor 1.0 (no penalty)
- Distance 1 → factor 0.50 (at decay=0.7)
- Distance 2 → factor 0.25
- Distance 3 → factor 0.12
- Distance 4 → factor 0.06

This is strictly better than the previous binary cross-package penalty because:
- No need to define what a "package" is
- Captures the intuition that nearby files are more related
- Continuous rather than binary -- nuance instead of blunt cutoff
- Works on single-package projects, flat layouts, non-JS projects

### Performance: Pre-computed Segment Cache

Directory segments are pre-computed once per unique node hash in `buildGraph()`, avoiding redundant `path.relative()` + `split()` calls per edge. Total: O(N) setup + O(E × D) lookups where D ≈ 5 (average path depth).

### Package Discovery

`discoverPackageDirs()` walks UP from each analyzed file's directory toward the root, looking for marker files. This naturally discovers packages regardless of directory naming (`packages/`, `apps/`, `libs/`, or any other convention).

Used by `buildModuleResolver()` to discover workspace packages for non-relative import resolution and by `computePackage()` for human-readable labels.

## All Functions as Nodes

Every extracted function becomes a graph node via the `allHashes` parameter in `buildGraph()`. Previously, only functions appearing in at least one edge were nodes -- isolated functions (no edges) were invisible. Now `analyzeGraph()` passes all function content hashes, ensuring 100% of functions appear in the graph. Isolated functions are assigned to communities by Louvain (typically dissolved since they form size-1 clusters).

## Directory Co-Location Edges

Functions in single-function files have zero same-file co-location edges. To prevent mass dissolution, `resolveEdges()` creates **cross-file directory co-location edges** connecting functions in the same directory but different files.

- Weight: `co_location * 0.5 / offset` = 0.35 base (half the same-file base weight)
- Functions sorted by `filePath + startLine` for stable offset calculation
- Same-file pairs are skipped (already handled by same-file co-location)
- Only activates when a directory has functions from 2+ files
- Deduplication shares the same `colocAdded` set as same-file edges (within `CoLocationEdgeResolver`)

This is the key signal for codebases with many small files. Without it, single-function files form isolated nodes that get assigned to trivial communities which then get dissolved.

## JSX Component References (Separate Edge Type)

JSX component usage (`<Button />`, `<AlertDialog />`) creates `jsx_ref` edges with weight 0.2, not `call` edges with weight 0.5. This separation prevents UI composition from dominating community detection.

**Problem it solves:** Without this, a function using 8 AlertDialog sub-components would have 4.0 total call weight pulling it toward the AlertDialog community, while same-file co-location was only 0.7. The function would leave its logical home and cluster with its UI dependencies.

**How it works:** The TypeScript parser splits `extractCallExpressions()` output into:
- `calls[]` -- direct function calls (`validate()`, `initDb()`) → `call` edges at weight 0.5
- `jsxRefs[]` -- JSX component references (`<Button />`) → `jsx_ref` edges at weight 0.2

PascalCase-only detection (same as before) ensures HTML elements (`<div>`, `<span>`) are excluded.

## Barrel File Import Resolution

Workspace package imports (e.g., `import { computeHash } from "@ophan/core"`) often resolve to barrel files (`index.ts`) that only re-export functions defined in other files. Direct `fileNameToHash` lookup for the resolved target file fails because the function isn't defined there.

**Fix:** `buildEdgeResolverContext()` builds a `pkgNameToHashes` map -- for each workspace package, all `(functionName → contentHash)` pairs from files within that package. When direct lookup fails, the `ImportEdgeResolver`'s package-scoped fallback searches this map. This handles:
- Re-exports: `export { computeHash } from "./shared"` in index.ts
- Pure barrel files: index.ts with no own functions (only re-exports)
- Mixed barrel files: index.ts with both own functions and re-exports

## Type Import Filtering

The TypeScript parser's `extractImports()` skips:
- `import type { X } from "..."` -- entire type-only declarations
- `import { type X, Y } from "..."` -- individual type-only specifiers

Only runtime imports appear in `ImportRef.names`, preventing false edge matches on type-only symbols that could never correspond to extracted functions.

## Transitive Edges (Derived)

`addTransitiveEdges()` derives additional edges from the call graph to increase connectivity and reduce dissolution. These edges are computed in-memory after direct edge resolution and are NOT stored in the DB.

### Transitive Call (A→B→C → A↔C)
If function A calls B and B calls C, a `transitive_call` edge (weight 0.4) connects A and C. This extends call chain connectivity by one hop.

### Co-Caller (A→B, A→C → B↔C)
If function A calls both B and C, a `co_caller` edge (weight 0.4) connects B and C. Functions called by the same caller are likely related -- they serve the same feature area.

**Cap:** Callers with >15 callees are skipped to prevent O(n²) edge explosion.

**Stacking:** Transitive edges are NOT deduped against direct edges. Being related in multiple ways (e.g., direct call + transitive chain) increases connection strength. `buildGraph()` merges parallel edges by summing weights.

## Dissolution Rescue

After community detection and active splitting, dissolved nodes (singletons from small communities or split fragments) are rescued via `rescueDissolvedNodes()`:

1. For each dissolved node, sum edge weights to each non-dissolved community
2. Assign the node to the community with the strongest total weight
3. Nodes with zero connections to any community stay dissolved
4. Chained rescue: rescued nodes update the membership map, so subsequent nodes can rescue into the same community

**Split quality gate:** Before accepting a split, checks that `dissolvedCount <= 50%` of the original community. Rejects splits that destroy too many members -- keeping the oversized community intact is better than fragmenting it.

**Split fragment rescue:** Applied after active splitting, before building the final assignment map. Prevents cascade dissolution where high-resolution recursive splits (2x, 4x, ...) fragment connected nodes into singletons.

**`___dissolved` routing:** After rescue, any remaining dissolved groups from splits (with prefixed IDs like `66___dissolved`) are forced to `__dissolved` for top-level rescue. Without this, they'd become fake "communities."

**Top-level rescue:** Applied after all assignments are built. Rescues singletons from the main Louvain pass that have connections to existing communities.

**Why this matters:** Without rescue, active splitting at high resolution (e.g., 4.0) frequently produces singletons from functions with few internal calls (e.g., `pullFromSupabase` in sync.ts has zero calls to other sync functions but strong co-location edges). These singletons fall below `minCommunitySize` and are permanently lost. With rescue, they're absorbed into the sub-community they're most connected to.

## Previous Approach (Superseded)

The original implementation used a binary `crossPackagePenalty` with hardcoded `packages/<name>/` regex. This was fragile:
- Only worked on monorepos with a `packages/` directory
- Binary same/different was too coarse
- `buildModuleResolver()` hardcoded `path.join(rootPath, "packages")` for workspace scanning

## Key Files

- `packages/core/src/graph.ts` -- `computeDirectoryDistance()`, `discoverPackageDirs()`, `buildModuleResolver()`, `computePackage()`, `buildGraph()` with directory decay, `rescueDissolvedNodes()`, `runComparison()`, `computeComparisonMetrics()`
- `packages/core/src/edge-resolvers/` -- Edge resolver strategy: `call.ts`, `jsx-ref.ts`, `co-location.ts`, `import.ts`, `index.ts` (registry)
- `packages/core/src/module-resolvers/` -- Language-specific module resolution: `javascript.ts`, `index.ts` (registry)
- `packages/core/src/community-detectors/` -- Algorithm strategy: `louvain.ts`, `label-prop.ts`, `leiden.ts`, `index.ts` (registry)
- `packages/core/src/summarize.ts` -- `computePackageBreakdown()`, `formatPackageBreakdown()`
- `packages/core/src/graph.test.ts` -- Tests for directory distance, decay, package labeling, detectors, and comparison
