# Graph Hyperparameters Reference

All tunable parameters for Ophan's function graph construction and community detection. Covers configurable options (CLI flags + `GraphConfig`), hardcoded constants, and practical tuning guidance.

> **For a comprehensive narrative guide** to community detection -- including algorithm comparison, edge type rationale, what good results look like, and a step-by-step tuning workflow -- see [community-detection-guide.md](./community-detection-guide.md).

## Current Baseline

```
pnpm dev graph --path .
# Results will vary as hyperparameters are tuned. Run to see current state.
```

---

## Edge Weights

Control how strongly each relationship type pulls functions into the same community. Stored in `GraphConfig.edgeWeights`. Not exposed via CLI -- edit `DEFAULT_EDGE_WEIGHTS` in `packages/core/src/graph.ts`.

### `call` (default: 0.5)

**What it does:** Weight assigned to edges where function A directly calls function B (e.g., `validate()`, `initDb()`). Does NOT include JSX component references (those are `jsx_ref`).

**Formula:** Direct weight. No decay applied at this level (directory decay applied later in `buildGraph()`).

**Increase →** Call relationships dominate clustering. Functions that call each other are pulled together more strongly relative to co-location and imports.

**Decrease →** Call relationships matter less. Proximity and imports become relatively more important.

**Guidance:** 0.5 is deliberately lower than co_location (0.7). At 1.0, orchestration functions that call into many modules would drag everything into one giant community. At 0.5, call edges are still meaningful but don't overwhelm file proximity. Increase if you want runtime dependencies to dominate over file structure.

### `type_ref` (default: 0.5)

**What it does:** Weight for type reference edges (function A references type defined near function B).

**Status:** Infrastructure ready but **not yet extracted** by parsers. No type_ref edges are currently produced. Reserved for future use.

### `import` (default: 0.2)

**What it does:** Weight assigned to edges created from `import` statements. When function A's file imports function B by name (e.g., `import { validate } from "./auth"`), an import edge is created.

**Formula:** Direct weight. Includes barrel file fallback -- workspace package imports resolve through re-exports.

**Increase →** Import relationships pull functions together more. Good if your codebase has strong module boundaries with explicit imports.

**Decrease →** Import relationships matter less relative to calls and proximity.

**Guidance:** Current codebase produces few import edges (3-5 typically). Increasing this has limited effect until import resolution improves. The barrel file fallback helps but many imports are type-only (filtered out) or to external packages (no edges).

### `co_location` (default: 0.7)

**What it does:** Base weight for proximity-based edges. Two sub-types:

**Same-file co-location:**
- Connects all pairs of functions within the same file
- Weight: `co_location / offset` where offset = position distance (sorted by startLine)
- Adjacent functions (offset=1): 0.7
- Distance 2: 0.35
- Distance N: 0.7/N

**Directory co-location (cross-file):**
- Connects functions in the same directory but different files
- Weight: `co_location * 0.5 / offset` = 0.35 base
- Functions sorted by filePath + startLine
- Same-file pairs skipped (handled above)

**Increase →** Proximity dominates. Files and directories always cluster together regardless of call/import relationships. Can lead to "everything in `src/` is one community" if too high.

**Decrease →** Only strong call/import relationships matter. Single-function files with no calls become isolated and dissolve. Set to 0 to disable proximity entirely.

**Guidance:** 0.7 is the strongest single edge weight -- stronger than direct calls (0.5). This means file structure is the primary clustering signal. Functions in the same file stay together unless there's overwhelming evidence from other edges to split them. This respects the developer's intent when organizing code into files. The 0.5 multiplier for cross-file directory edges is hardcoded.

### `jsx_ref` (default: 0.2)

**What it does:** Weight for JSX component reference edges. When function A renders `<Button />`, a `jsx_ref` edge is created to `Button`.

**Formula:** Direct weight, same name-to-hash resolution as call edges.

**Why separate from calls:** Using `<AlertDialog>` in JSX is UI composition -- a weak domain signal. Calling `validateEmail()` is a strong functional dependency. Without this separation, functions using shared UI components get pulled into the UI component's community (e.g., any function using AlertDialog ends up in the "dialog community" instead of with its same-file siblings).

**Increase →** JSX composition becomes a stronger clustering signal. Components that render the same UI primitives cluster together.

**Decrease →** JSX composition becomes noise. Components cluster by file/directory/call relationships only.

**Guidance:** 0.2 is the weakest signal alongside imports. JSX composition is UI plumbing -- it matters slightly but shouldn't override file structure or call relationships. Set to 0 if you want to completely ignore UI component relationships.

### `transitive_call` (default: 0.4)

**What it does:** Derived edge type for 2-hop call chains. If function A calls B, and B calls C, a `transitive_call` edge is created between A and C.

**Computed in:** `addTransitiveEdges()` -- called in `analyzeGraph()` after direct edge resolution. NOT stored in DB -- recomputed each run.

**Stacking:** Does NOT deduplicate against direct edges. If A also calls C directly, both the `call` (0.5) and `transitive_call` (0.4) edges exist -- their weights stack in the merged graph (0.9 total).

**Increase →** Transitive relationships pull functions together more strongly. Longer call chains create stronger connectivity.

**Decrease →** Transitive relationships matter less. Only direct connections drive clustering.

**Guidance:** 0.4 is nearly as strong as a direct call (0.5), reflecting that 2-hop call chains are strong evidence of relatedness. Combined with co_caller (also 0.4), derived edges collectively form a powerful signal that augments direct connections.

### `co_caller` (default: 0.4)

**What it does:** Derived edge type for shared-caller relationships. If function A calls both B and C, a `co_caller` edge is created between B and C (they serve the same caller).

**Computed in:** `addTransitiveEdges()` -- same lifecycle as `transitive_call`.

**Cap:** Callers with more than 15 callees are skipped to prevent O(n²) edge explosion from hub functions.

**Stacking:** Same as transitive_call -- does not deduplicate against direct edges.

**Increase →** Functions used by the same caller cluster together more strongly.

**Decrease →** Only direct relationships matter.

**Guidance:** 0.4 matches transitive_call -- co-caller is treated as equally suggestive. Functions called by the same orchestrator often participate in the same workflow. The 15-callee cap prevents hub functions from creating too many of these edges.

---

## Community Detection

### `algorithm` (default: `"leiden"`)

**CLI:** `-a, --algorithm <algorithm>`

**Options** (extensible via `registerDetector()`):
- `"louvain"` -- Deterministic, fast, returns modularity score. Resolution parameter tunes granularity. Recommended default.
- `"leiden"` -- Custom implementation (no npm package exists) of Leiden algorithm (Traag, van Eck & Waltman, 2019). Three phases: local moving, refinement (guarantees connected communities), aggregation. Resolution parameter supported. Key advantage: communities are guaranteed to be internally connected (no disconnected subgroups within a community). Non-deterministic due to randomized processing order.
- `"label-propagation"` -- Non-deterministic (results vary between runs), fastest, no resolution parameter. Finds natural boundaries automatically.

Algorithms are pluggable via the `CommunityDetector` strategy pattern (`packages/core/src/community-detectors/`). `GraphConfig.algorithm` is typed as `string`, so adding new algorithms requires no type changes.

**Guidance:** Leiden is the default -- its refinement phase guarantees internally connected communities, which produces cleaner results than Louvain on codebases where orchestration functions create thin bridges between otherwise separate clusters. Use Louvain if you want deterministic results (same input = same output every time). Use `--compare` to compare algorithms on your codebase. Label propagation is useful as a sanity check -- if multiple algorithms find similar communities, the structure is strong.

### `resolution` (default: 3.0)

**CLI:** `-r, --resolution <number>`

**What it does:** Resolution parameter for Louvain and Leiden algorithms. Controls the trade-off between community size and count. Higher resolution demands stronger evidence before putting two functions in the same community.

**Increase →** More communities, each smaller. Functions need stronger connections to stay together.

**Decrease →** Fewer communities, each larger. Weaker connections are enough to merge clusters.

**Scale:**
- 0.5 -- Very coarse. Entire packages may merge into single communities
- 1.0 -- Standard. Moderate granularity
- 1.5 -- Good for medium codebases (50-200 functions) with moderate directory decay
- 2.0 -- Finer granularity. Good for larger codebases (200+)
- 3.0 -- Default. Produces focused, file-boundary-respecting communities when combined with high directory decay (0.7). The high resolution is balanced by strong co-location edges that keep related functions together.
- 5.0+ -- Very fine. May fragment natural clusters

**Auto-resolution** (when `autoResolution: true`): Applies `Math.max(resolution, threshold)` based on codebase size:
- < 50 nodes → threshold 1.0
- 50-199 nodes → threshold 1.5
- 200+ nodes → threshold 2.0

This means setting resolution=1.0 on a 200-node codebase effectively uses 2.0. Set `autoResolution: false` to disable. At the default resolution of 3.0, auto-resolution never kicks in (3.0 exceeds all thresholds).

**Guidance:** Start with default 3.0. If communities are too large (>20 functions, unfocused), increase further. If too fragmented (many size-2 or size-3 communities, high dissolved count), decrease to 2.0 or 1.5. Resolution interacts strongly with directory decay -- high decay (0.7) already weakens cross-directory edges, so high resolution is needed to also split within-directory clusters.

### `minCommunitySize` (default: 3)

**CLI:** `--min-size <number>`

**What it does:** Communities with fewer members than this are initially "dissolved" -- their functions are assigned to the special `__dissolved` marker. After dissolution, a **rescue pass** reassigns each dissolved node to the community with the strongest total edge weight. Nodes with zero connections to any non-dissolved community stay dissolved. Rescued nodes update the membership map so subsequent rescues can chain (B rescued after A into the same community).

**Increase →** More initial dissolution, but rescue recovers most connected nodes. Only truly isolated nodes remain dissolved.

**Decrease →** Less initial dissolution. Even weakly-connected pairs form communities. More coverage but noisier.

**Guidance:** 3 means every community has at least a trio of functions -- enough to represent a meaningful cluster. Pairs (size 2) were often noise: two functions that happened to be adjacent but didn't really form a concept. Set to 2 if you want maximum coverage (accepts pairs). Set to 4+ if you want only strong clusters, but be aware this increases dissolved count.

### `maxCommunitySize` (default: 18)

**CLI:** `--max-size <number>`

**What it does:** Communities exceeding this size are recursively split:
1. Extract subgraph for the oversized community
2. Re-run the current algorithm at **2x the current resolution**
3. Only accept if it produces > 1 sub-community
4. **Quality gate:** Split is rejected if `dissolvedCount > 50%` of original members (keeps oversized community intact rather than destroying it)
5. **Rescue dissolved split fragments:** Singletons from the recursive split are assigned to the nearest sub-community by total edge weight
6. Sub-community IDs: `"3_0"`, `"3_1"` (parent_sub)
7. Sub-communities below minCommunitySize are dissolved (then rescued at top level)

**Increase →** Allow larger communities. Less forced splitting. Good if your codebase has naturally large modules.

**Decrease →** Force finer granularity. Even well-connected clusters get split if too big.

**Guidance:** 18 allows moderately large files to stay as one community while still forcing splits on genuinely oversized clusters. If summaries are too broad ("this community handles everything"), decrease to 12-15. If natural clusters are being artificially split with high dissolution, increase to 25-30. The quality gate protects against destructive splits -- if splitting would dissolve >50% of members, the oversized community is kept intact.

---

## Spatial Decay

### `directoryDecay` (default: 0.7)

**CLI:** `--directory-decay <number>`

**What it does:** Applied in `buildGraph()` as `weight *= exp(-decay * distance)` to ALL edge weights. Penalizes edges between functions in distant directories.

**Distance calculation:** `computeDirectoryDistance(fileA, fileB, rootPath)` counts unique directory segments when traversing from one file's directory to the other via their common ancestor.

**Examples at decay=0.7:**
| Directory distance | Multiplier | Example |
|---|---|---|
| 0 (same dir) | 1.000 | `src/utils/a.ts` ↔ `src/utils/b.ts` |
| 2 (sibling dirs) | 0.247 | `src/components/` ↔ `src/utils/` |
| 4 | 0.061 | `packages/core/src/` ↔ `packages/webapp/src/` |
| 7 | 0.007 | Deep cross-package (essentially zero) |
| 10 | 0.001 | Very distant directories (negligible) |

**Increase →** Stronger penalty for cross-directory edges. Packages cluster more independently. At 0.9+, even sibling directories are nearly isolated.

**Decrease →** Weaker penalty. Cross-directory relationships are preserved. Good if your directory structure doesn't reflect logical boundaries.

**Set to 0 →** No directory penalty at all. Pure graph topology determines communities.

**Guidance:** 0.7 is aggressive -- cross-package edges (distance 4+) are essentially background noise. This is the main reason packages don't merge into each other. It also prevents orchestration functions (like `runAnalyze()` in `cli/src/index.ts` calling into `core/src/graph.ts`) from dragging distant functions into the wrong community. Decrease to 0.3-0.5 if related functions across directories aren't clustering. Set to 0.1 for a very gentle penalty where even distant connections are preserved. If your codebase is a flat `src/` directory, set to 0.

---

## Hardcoded Constants

These are not configurable without code changes. Listed for reference.

| Constant | Value | Location | Purpose |
|---|---|---|---|
| Dir co-location multiplier | 0.5 | `resolveEdges()` | Cross-file same-directory edges = half the weight of same-file edges |
| Co-location offset decay | `1/offset` | `resolveEdges()` | Adjacent functions get full weight, distance N gets 1/N weight |
| Active split resolution | 2x | `detectCommunities()` | Oversized communities re-run the current algorithm at double resolution |
| Split quality threshold | 50% | `detectCommunities()` | Reject split if dissolved nodes exceed 50% of community |
| Jaccard matching threshold | 0.5 | `matchCommunities()` | Min overlap to consider communities "the same" across runs (stable IDs) |
| Incremental mode threshold | 50% | `analyzeGraph()` | If >50% of hashes changed, full rebuild instead of incremental |
| Label propagation max iters | 100 | `labelPropagation()` | Convergence limit for label propagation algorithm |
| L1 group min size | 2 | `detectHierarchicalCommunities()` | Hierarchical groups with <2 communities dissolved |
| Auto-resolution thresholds | [50, 200] | `detectCommunities()` | Node count breakpoints for auto-scaling resolution |
| Auto-resolution targets | [1.0, 1.5, 2.0] | `detectCommunities()` | Resolution floors at each node threshold |
| Co-caller cap | 15 | `addTransitiveEdges()` | Callers with >15 callees skip co_caller edge generation |

---

## Tuning Recipes

### Too many dissolved functions?

The main cause is isolated nodes (zero edges). Check edge count vs node count -- if most nodes have no edges, the issue is edge generation, not parameters.

1. Ensure directory co-location is working (functions in multi-file directories should get edges)
2. Lower `minCommunitySize` to 2 (pairs form communities)
3. Increase `co_location` weight to strengthen proximity signal
4. Decrease `directoryDecay` (0.7 → 0.3) to preserve more cross-directory edges
5. Decrease `resolution` (3.0 → 2.0 or 1.5) to allow larger, more inclusive communities

### Communities too large or unfocused?

1. Increase `resolution` (3.0 → 4.0 or 5.0)
2. Decrease `maxCommunitySize` (18 → 12)
3. Increase `directoryDecay` (0.7 → 0.9) to further penalize cross-package edges
4. Decrease `co_location` weight to reduce proximity influence

### Communities too small or fragmented?

1. Decrease `resolution` (3.0 → 2.0 or 1.5)
2. Increase `maxCommunitySize` (18 → 30)
3. Decrease `directoryDecay` (0.7 → 0.3) to allow cross-directory clustering

### Cross-package functions incorrectly merging?

1. Increase `directoryDecay` (0.7 → 0.9)
2. Increase `resolution`

### Related functions in different directories not clustering?

1. Decrease `directoryDecay` (0.7 → 0.3 or 0)
2. Increase `call` and `import` weights relative to `co_location`

---

## Comparison Tool

Use `--compare` to run the same graph through multiple algorithm/parameter configurations and compare metrics side by side:

```bash
pnpm dev graph --compare --path .
```

Outputs a table with community count, dissolved count/%, coverage, min/median/max size, and modularity for each configuration. Default configurations compare Louvain at resolutions 1.0, 1.5, 2.0, 3.0, label propagation, and Leiden at resolutions 1.5 and 2.0.

Useful for:
- Deciding which resolution to use for a given codebase
- Verifying that tuning one parameter doesn't degrade another metric
- Comparing Louvain vs label propagation on the same graph

JSON output is available via `--compare --json` for programmatic analysis.

---

## Key Files

- `packages/core/src/graph.ts` -- All graph logic, config interface, defaults, edge resolution, community detection, comparison tooling
- `packages/core/src/community-detectors/` -- Strategy pattern: `types.ts` (interface), `louvain.ts`, `label-prop.ts`, `leiden.ts`, `index.ts` (registry)
- `packages/cli/src/index.ts` -- CLI flags that expose parameters
- `packages/core/src/graph.test.ts` -- Tests for all graph behavior
