# Auto-Documentation: System-Level Analysis via Graph Algorithms

## End Goal

Automatically discover and document "systems" -- groups of functions that work together across files and modules. Instead of just per-function docs, users see emergent architecture documentation: "these 8 functions form the authentication subsystem", "this cluster handles PII data flow from input to database", etc.

The approach: build a multi-relation graph of function relationships, run community detection to discover natural clusters, then use hierarchical LLM summarization to generate documentation at each level.

## Architecture Overview

```
Source Code
  ↓ (existing: parse functions, extract source)
FunctionInfo[] + NEW: call sites, imports, exports
  ↓ (existing: content hash, Claude analysis)
function_analysis (per-function docs + security)
  ↓ NEW
function_edges (call, type_ref, import, co_location)
  ↓ NEW
Graph Construction (graphology in-memory)
  ↓ NEW (configurable algorithm)
Community Detection → communities table
  ↓ NEW
Hierarchical Summarization (Claude L1→L2→L3)
  ↓ NEW
community_summaries table
  ↓ NEW
UI: System views in extension + webapp
```

## Configuration

All graph parameters are tunable. Expect iterative tuning to find values that produce good results for different codebases.

### Algorithm Selection
- **Louvain** -- fast, built into graphology, good default
- **Leiden** -- more accurate communities, fixes Louvain's poorly-connected issue
- **Label Propagation** -- fastest, non-deterministic, useful for comparison
- **Infomap** -- information-theoretic, good for detecting flow-based communities

### Tunable Parameters
- **Edge weights** -- relative weight per edge type (call=1.0, type_ref=0.7, import=0.5, co_location=0.3)
- **Resolution** -- Louvain/Leiden resolution parameter. Higher = more, smaller communities. Lower = fewer, larger.
- **Minimum community size** -- filter out clusters below threshold (default: 3 functions)
- **Maximum community size** -- split communities above threshold (default: 30 functions)
- **Hierarchy depth** -- how many levels of summarization (L1, L2, L3, or auto based on codebase size)
- **Call resolution strategy** -- 'name_match' (fast, some false positives) or 'type_checked' (slow, accurate)

Config stored in `.ophan/config.json` (local, gitignored) with sensible defaults.

## Phases

### Phase 1: Graph Foundation ← CURRENT
**Status: Complete**

Parser call-site extraction, graph storage, community detection with configurable algorithms. No LLM summaries yet -- just discover and display clusters.

Deliverables:
- [x] Extend `FunctionInfo` with optional relationship fields (`calls`, `imports`, `exported`)
- [x] TypeScript parser: extract call expressions, imports, exports
- [x] Python parser: extract call expressions, imports
- [x] New DB tables: `function_edges`, `communities`, `community_summaries`, `graph_config`
- [x] Graph construction from edges (graphology, merges parallel edges by weight)
- [x] Louvain community detection (via graphology-communities-louvain, with resolution parameter)
- [x] Label propagation community detection (custom implementation)
- [x] Config system: `GraphConfig` persisted in `graph_config` table, `DEFAULT_GRAPH_CONFIG`
- [x] Size constraints: `minCommunitySize` dissolves small clusters, `maxCommunitySize` flagged in output
- [x] CLI `ophan graph` command with `--algorithm`, `--resolution`, `--min-size`, `--max-size`, `--json` flags
- [x] `extractAllFunctions()` core utility for graph pipeline
- [x] `analyzeGraph()` orchestration: resolve edges → store → detect → store communities
- [x] `populateFileIndex()` -- graph command populates `file_functions` from extracted functions before edge resolution
- [x] Import edge resolution -- relative imports (`./utils`, `../auth`) resolved to file paths, creating targeted import edges (weight 0.5)
- [x] Call extraction refinement -- only direct function calls extracted (not method calls like `db.prepare()`, `arr.map()`)
- [x] Co-location proximity window -- adjacent functions within a sliding window of 2 positions instead of ALL-pairs (reduces N*(N-1)/2 edges to 2*(N-1))
- [x] Named import targeting -- import edges only to specifically imported functions, with namespace fallback via fn.calls intersection
- [x] Auto-resolution -- resolution scales with codebase size (1.0/1.5/2.0 for <50/50-200/200+ nodes)
- [x] Active community splitting -- oversized communities (>maxCommunitySize) recursively split via Louvain at 2x resolution
- [x] Import edge deduplication -- Set-based dedup replaces ordering guard to handle unidirectional imports correctly
- [x] 36 graph tests (config persistence, edge resolution, proximity window, named imports, namespace fallback, auto-resolution, active splitting, storage, graph construction, community detection, centrality, full pipeline)

### Phase 2: Hierarchical Summarization
**Status: Complete**

LLM-generated narrative documentation at each community level. Produces rich markdown docs + structured metadata for each level.

Deliverables:
- [x] `community_summaries` table with `input_hash` cache invalidation
- [x] Zod schemas: `L1Summary`, `L2Summary`, `L3Summary`, `SummaryMeta` (all with `.catch()` defaults)
- [x] L1 prompt: subsystem docs from function analyses + internal call relationships. Dynamic length guidance (150-1000 words based on community size)
- [x] L2 prompt: system docs from L1 summaries + cross-community edges
- [x] L3 prompt: architecture overview from L2 summaries
- [x] Content-hash-based incremental invalidation (only re-summarize changed communities)
- [x] `summarizeCommunities()` orchestration with dependency injection for testing
- [x] CLI `ophan graph --summarize` flag with progress output and JSON mode support
- [x] 23 summarize tests (input hash, storage, context building, cache invalidation, orchestration)
- [x] Test helpers: `insertCommunity()`, `insertEdge()` in core test-utils
- [x] Raw-source mode (`--raw-source`): sends raw function source code to Claude instead of analysis metadata
- [x] `buildL1RawContext()` -- builds L1 context from sourceMap (contentHash → sourceCode)
- [x] `buildL1RawPrompt()` -- formats source code in fenced code blocks
- [x] Cache separation via `computeL1InputHash(hashes, rawSource)` -- "RAW:" prefix prevents collisions
- [x] 9 raw-source tests (hash separation, context building, edge resolution, orchestration, cache non-collision)

Output format per level:
- `title`: short descriptive name (2-5 words)
- `documentation`: rich markdown (## title, ### sections, code references, data flow, security notes)
- `meta`: structured data (`securityPosture`, `dataClassification`, `boundaries`, `keyFunctions`, `complexity`)

### Phase 3: UI Surfaces
**Status: Complete**

Show system documentation in extension, webapp, and sync community data to Supabase.

Deliverables:
- [x] Supabase migration: `community_summaries` + `communities` tables with RLS policies
- [x] CLI sync extension: push communities (full replace) + summaries (upsert) during `ophan sync`
- [x] Webapp: architecture overview route with L3 summary + L1 community cards grid
- [x] Webapp: community detail page with full markdown docs + member functions table
- [x] Webapp: markdown renderer, meta badges, community card components
- [x] Webapp: architecture nav item in repo sidebar
- [x] VS Code: community title in CodeLens (e.g., `{Auth System}`)
- [x] VS Code: graceful fallback when no graph data exists (older DBs)
- [x] Tests: 4 CLI sync tests (communities, summaries, missing tables, empty data) + 2 lens tests
- [ ] VS Code: webview panel for system/cluster documentation
- [ ] Webapp: data flow visualization (which systems handle PII, credentials, etc.)
- [ ] Config UI: sliders for graph parameters, algorithm comparison view

Supabase schema:
- `community_summaries` -- PK `(community_id, level, algorithm, repo_id)`, stores summary JSONB (title, documentation, meta)
- `communities` -- PK `(content_hash, level, algorithm, repo_id)`, maps function hashes to community membership

Sync patterns:
- Communities: full replace (DELETE all for repo_id → INSERT current rows), like `function_locations`
- Summaries: full replace (DELETE all for repo_id → INSERT current rows), like communities

Webapp routes:
- `/dashboard/repos/$repoId/architecture` -- Layout route (sidebar + Outlet) wrapping all architecture child routes
- `/dashboard/repos/$repoId/architecture/` -- L3 overview + quick nav links to groups and concerns
- `/dashboard/repos/$repoId/architecture/groups/$groupId` -- L2 group overview + child subsystem links
- `/dashboard/repos/$repoId/architecture/$communityId` -- L1 detail with markdown docs + member functions
- `/dashboard/repos/$repoId/architecture/concerns/$concernId` -- concern detail with bridge functions

### Phase 4: Cross-Cutting Concerns
**Status: Complete**

Detect and document data flows and security patterns that span multiple communities. Uses betweenness centrality to identify bridge functions and heuristic classification from existing per-function `dataTags`/`securityFlags`.

Deliverables:
- [x] Betweenness centrality via `graphology-metrics/centrality/betweenness` -- `computeCentrality()` in graph.ts
- [x] Heuristic concern detection from cross-community edges + dataTags/securityFlags -- `detectCrossCuttingConcerns()` in summarize.ts
- [x] Significance filter: 2+ community pairs OR above-median-centrality bridge function
- [x] Claude-generated narrative documentation for each concern -- `summarizeCC()` in summarize.ts
- [x] Content-addressed caching via `computeCCInputHash()` -- reuses `community_summaries` table with `level=10`
- [x] `CrossCuttingConcernSummary` Zod schema with `.catch()` defaults
- [x] CLI: cross-cutting concern output in both human-readable and JSON modes
- [x] Webapp: `CrossCuttingConcern` type, architecture API fetches level=10, `getConcernDetail()` server function
- [x] Webapp: concern-card component on architecture overview page
- [x] Webapp: concern detail page with bridge functions table + affected subsystems
- [x] 11 new tests: centrality (4), detection (4), input hash (2), orchestration (1)
- [ ] Frequent subgraph mining for recurring patterns (deferred -- complex, lower value)
- [ ] VS Code concern display (deferred)

Storage: Cross-cutting concerns stored in `community_summaries` with `level=10` and `community_id="concern_{tag}"`. No new tables -- existing sync picks up level=10 rows automatically.

Centrality: Computed in memory during summarization (fast, not persisted). Scores flow into concern documentation which IS persisted.

Webapp routes:
- Architecture overview: concerns section below subsystems grid
- `/dashboard/repos/$repoId/architecture/concerns/$concernId` -- concern detail with bridge functions + affected subsystems

### Phase 5: Community Edges + Hierarchical Nesting
**Status: Complete**

Inter-community relationships and hierarchical grouping. Community edges aggregate function-level edges into community-level connections. Hierarchical detection runs Louvain on the meta-graph to discover groups of related communities. Per-group L2 summarization replaces single `system_0` with multiple `group_*` summaries.

Deliverables:
- [x] `community_edges` table (local SQLite + Supabase migration 00004)
- [x] `computeCommunityEdges()` -- aggregates cross-community function edges with canonical ordering
- [x] `storeCommunityEdges()` / `loadCommunityEdges()` -- full-replace storage pattern
- [x] Pipeline integration -- `analyzeGraph()` Step 5 computes + stores community edges
- [x] `detectHierarchicalCommunities()` -- meta-graph Louvain for L1 grouping
- [x] L1 assignments stored in `communities` table at `level=1` (content_hash = L0 community_id)
- [x] Dissolves L1 groups with < 2 communities → `__dissolved`
- [x] Per-group L2 summarization -- `summarizeCommunities()` creates `group_*` L2 summaries when hierarchy exists
- [x] Fallback to single `system_0` when no hierarchy (backward compat)
- [x] L3 automatically synthesizes all L2 groups via `loadAllSummaries(db, algorithm, 2)`
- [x] CLI: `detectHierarchicalCommunities` replaces `analyzeGraph` in graph command, shows groups + cross-edges
- [x] CLI sync: community_edges synced with DELETE + INSERT pattern
- [x] Webapp: types updated (`RelatedCommunity`, `L1Group`, enriched `EnrichedL1Summary`)
- [x] Webapp: architecture overview with grouped L1 display (or flat layout as fallback)
- [x] Webapp: community detail with related subsystems, cross-cutting concerns, breadcrumbs
- [x] 16 new tests: community edges (5 compute + 3 storage), hierarchical detection (5), hierarchical L2 (3)
- [x] Orphan cleanup: `cleanupOrphanedSummaries()` deletes stale summaries when communities change between runs
- [x] Orphan cleanup tracks active IDs at each level (L1, L2, CC) and deletes rows not in active set
- [x] Summaries sync switched from upsert to DELETE + INSERT to match cleanup behavior
- [x] 5 orphan cleanup tests: direct cleanup (3), orchestration integration (2)

Community edges schema:
```sql
CREATE TABLE community_edges (
  source_community TEXT NOT NULL,
  target_community TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'louvain',
  weight REAL NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_community, target_community, algorithm)
);
```

Hierarchical detection flow:
```
1. analyzeGraph() → L0 result + community edges
2. loadCommunityEdges() → build meta-graph
3. Louvain on meta-graph → L1 group assignments
4. Dissolve singleton groups → store in communities (level=1)
5. summarizeCommunities() → per-group L2 summaries
6. L3 synthesizes all L2 groups
```

### Phase 7: Package-Aware Community Detection
**Status: Complete**

Cross-package edge penalty and post-detection package labeling. Communities respect monorepo package boundaries while still allowing cross-package clusters when coupling is strong. L2/L3 prompts enhanced for standalone parent page quality.

Deliverables:
- [x] `computeDirectoryDistance()` -- technology-agnostic distance metric between any two files
- [x] `directoryDecay` in `GraphConfig` (default: 0.1) -- exponential decay applied to cross-directory edges
- [x] `buildGraph()` uses pre-computed directory segments for distance-based weight decay
- [x] `discoverPackageDirs()` -- marker-file-based package discovery (package.json, pyproject.toml, go.mod, etc.)
- [x] `buildModuleResolver()` -- uses marker file discovery instead of hardcoded directory scanning
- [x] `rootPath` parameter threaded through `analyzeGraph()` → `detectHierarchicalCommunities()` → `summarizeCommunities()`
- [x] `computePackageBreakdown()` and `formatPackageBreakdown()` -- post-detection package labeling
- [x] `L1CommunityContext.packageInfo` -- package distribution included in L1 and L2 prompt context
- [x] CLI `--directory-decay` flag on `graph` command
- [x] L2 prompts enhanced for standalone parent page content (overview, subsystem connections, key patterns)
- [x] L3 prompt enhanced for architecture landing page content (overview, major systems, getting started)
- [x] Webapp `L1Group.overview` field includes full L2 documentation per group
- [x] Webapp architecture page shows collapsible L2 overview per group
- [x] 9 new tests: computePackage (4), buildGraph penalty (5), package breakdown (8), L1 context packageInfo (2)

Design rationale: See `docs/architecture/package-aware-communities.md` for research on 6 approaches evaluated, with Approach 1 (Cross-Package Edge Penalty) + Approach 5 (Post-Detection Package Labeling) selected.

### Phase 8: Docs-Style Architecture UI
**Status: Complete**

Replace the grid-card architecture overview with a docs-style sidebar + content-pane layout. Users navigate the architecture like technical documentation -- sidebar tree for hierarchy, content pane for rich markdown, table of contents for long pages.

Deliverables:
- [x] Architecture layout route (`route.tsx`) -- wraps all child routes with `SidebarProvider` + `ArchDocsSidebar` + `<Outlet />`
- [x] `ArchDocsSidebar` component -- tree navigation using shadcn `Sidebar` primitives (`SidebarMenu`, `SidebarMenuSub`)
- [x] Sidebar shows: Overview (L3), L2 groups with nested L1 communities, Cross-Cutting Concerns section
- [x] Active item highlighting via `useMatchRoute()` -- groups auto-expand when child is active
- [x] L2 group overview page (`groups/$groupId.tsx`) -- full L2 markdown documentation + child subsystem links
- [x] Architecture index reworked -- L3 content pane with quick-nav cards to groups and concerns
- [x] Community detail reworked -- breadcrumbs with links to parent group, TOC sidebar
- [x] Concern detail reworked -- breadcrumbs, TOC sidebar, removed standalone layout wrappers
- [x] `MarkdownRenderer` enhanced -- `remark-gfm` (tables, task lists), `rehype-highlight` (code syntax highlighting), heading IDs for anchor links
- [x] `DocsToc` component -- extracts h2/h3 headings from markdown, renders sticky "On this page" right-rail nav, IntersectionObserver for active heading tracking
- [x] `highlight.js` CSS theme (`github-dark-dimmed`) for code block styling
- [x] TanStack Router auto-generates correct nested route tree (architecture layout → child routes)
- [x] Mobile: sidebar collapses to Sheet via shadcn `Sidebar` built-in mobile support

Component architecture:
```
ArchitectureLayout (route.tsx)
  ├── ArchDocsSidebar (left sidebar, uses hierarchy from React Query cache)
  └── <Outlet /> → child route content
        ├── ArchitectureOverviewPage (index.tsx)    -- L3 docs + quick nav
        ├── GroupDetailPage (groups/$groupId.tsx)    -- L2 docs + subsystem grid
        ├── CommunityDetailPage ($communityId.tsx)   -- L1 docs + functions table
        └── ConcernDetailPage (concerns/$concernId)  -- concern docs + bridge functions
```

Data flow: Layout route fetches `architectureQueries.hierarchy(repoId)` once. All child routes use the same React Query key = cache hit, no refetch. Community detail and concern detail routes fetch their own detail data.

Dependencies added: `remark-gfm`, `rehype-highlight`, `highlight.js` (for CSS themes).

### Phase 6: Git Co-Change Analysis
**Status: Not greenlit -- future exploration**

Use git history to add temporal co-change edges to the graph.

Deliverables:
- [ ] Parse `git log` to correlate commit hunks with function spans
- [ ] Add co-change edge type with recency-weighted scoring
- [ ] Historical analysis mode (how did systems evolve over time?)

## Key Design Decisions

1. **Edges are content-addressed** -- edges are between content hashes (`hash_A → hash_B`), making them just as immutable and syncable as function analysis. Same source code = same hash = same edges everywhere.
2. **Local edge index is ephemeral** -- which edges exist in the current checkout is rebuilt on scan (like `file_functions`). But the edge data itself is synced to cloud.
3. **Community summaries are persistent** -- cached and invalidated by `input_hash` (sorted hash of member content_hashes). Synced to cloud.
4. **Multiple algorithms** -- user selects which algorithm to run, can compare results. Config stored locally.
5. **Progressive abstraction** -- L1 summaries replace raw function analyses at L2, keeping context windows manageable.
6. **Existing pipeline untouched** -- graph analysis runs AFTER function analysis. Function-level analysis continues to work independently.
7. **Dual-mode L1 context** -- L1 summarization supports two modes: analysis-based (condensed descriptions, params, returns from `function_analysis`) and raw-source (full function source code from extraction). Cache is separated via input hash prefix ("RAW:"). L2/L3 always consume L1 summaries regardless of mode. Raw-source mode does not require `ophan analyze` to have been run.
