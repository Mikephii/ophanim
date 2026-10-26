// Graph module -- builds a function relationship graph from parser-extracted data.
//
// This module is the foundation layer. It produces graph primitives (nodes, edges,
// centrality scores) that downstream features consume independently:
//   - Community detection (community-detection.ts)
//   - Summarization (summarize.ts)
//   - Visualization, PR impact analysis, team ownership (future)
//
// Architecture:
//   1. Parsers extract call sites, imports, exports → FunctionInfo with relationship fields
//   2. This module resolves names to content hashes → function_edges table
//   3. graphology builds in-memory graph from edges
//   4. Centrality analysis identifies bridge functions

import type Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import Graph from "graphology";
import betweennessCentrality from "graphology-metrics/centrality/betweenness";
import type { EdgeResolverContext } from "./edge-resolvers";
import { getEdgeResolvers } from "./edge-resolvers";
import type { FunctionInfo } from "./shared";

// ============ CONFIGURATION ============

export interface GraphConfig {
  /** Which community detection algorithm to use (extensible via registerDetector()) */
  algorithm: string;

  /** Relative edge weights by type (higher = stronger signal for community detection) */
  edgeWeights: {
    call: number;
    type_ref: number;
    import: number;
    co_location: number;
    jsx_ref: number;
    transitive_call: number;
    co_caller: number;
  };

  /** Louvain/Leiden resolution parameter. Higher = more, smaller communities */
  resolution: number;

  /** Minimum functions in a community (smaller clusters are dissolved) */
  minCommunitySize: number;

  /** Maximum functions in a community (larger clusters may indicate poor resolution) */
  maxCommunitySize: number;

  /** When true, resolution scales up automatically with codebase size */
  autoResolution?: boolean;

  /** Exponential decay factor for directory distance between files.
   *  Applied as exp(-directoryDecay * distance) to cross-directory edges.
   *  0 = no penalty, higher = stronger penalty for distant files.
   *  Default: 0.1 */
  directoryDecay?: number;
}

/**
 * Default edge weights for graph construction.
 *
 * These control how strongly each relationship type pulls functions into the
 * same community. All weights are relative -- what matters is the ratio between
 * them, not the absolute values. Weights from different edge types between the
 * same function pair are summed in the merged graph.
 *
 * Edit these to tune community detection. After changing, re-run:
 *   pnpm dev graph --compare --path .
 * to see the effect across all algorithms.
 */
export const DEFAULT_EDGE_WEIGHTS: GraphConfig["edgeWeights"] = {
  /**
   * Direct function calls: `fnA()` calls `fnB()`.
   * Strongest signal -- actual runtime dependency.
   * ↑ increase: call relationships dominate clustering
   * ↓ decrease: proximity and imports become relatively more important
   */
  call: 0.5,

  /**
   * Type references: function A uses a type defined near function B.
   * NOT YET EXTRACTED by parsers -- no type_ref edges are currently produced.
   * Reserved for future use.
   */
  type_ref: 0.5,

  /**
   * Import statements: `import { validate } from "./auth"` creates an edge.
   * Includes barrel file fallback (workspace package re-exports).
   * ↑ increase: module boundaries become stronger clustering signal
   * ↓ decrease: imports matter less relative to calls and proximity
   */
  import: 0.2,

  /**
   * File/directory proximity. Two sub-types:
   *   Same-file: all pairs connected, weight decays as 1/offset (adjacent=full, distance N=1/N)
   *   Same-directory (cross-file): half the same-file weight (hardcoded 0.5x multiplier)
   *
   * This is the main knob for "respect file boundaries". Higher values keep
   * same-file functions together even when they have cross-file call edges.
   *
   * ↑ increase: files/directories cluster together more strongly
   * ↓ decrease: only call/import relationships drive clustering
   * 0: disable proximity entirely (pure topology)
   */
  co_location: 0.7,

  /**
   * JSX component references: `<Button />`, `<Card />`.
   * Separated from calls because UI composition is a weaker domain signal
   * than functional dependency. Without this separation, functions using
   * shared UI components get pulled into the UI component's community.
   *
   * ↑ increase: components rendering the same UI primitives cluster together
   * ↓ decrease: JSX composition becomes noise
   */
  jsx_ref: 0.2,

  /**
   * 2-hop call chains: A→B→C creates A↔C edge.
   * Derived in-memory (not stored in DB). Stacks with direct edges.
   * ↑ increase: transitive relationships pull functions together more
   * ↓ decrease: only direct connections drive clustering
   */
  transitive_call: 0.4,

  /**
   * Shared caller: if A calls both B and C, creates B↔C edge.
   * Derived in-memory (not stored in DB). Callers with >15 callees are skipped.
   * Weakest signal -- correlation (same caller) is suggestive but indirect.
   * ↑ increase: functions used by the same caller cluster together more
   * ↓ decrease: only direct relationships matter
   */
  co_caller: 0.4,
};

export const DEFAULT_GRAPH_CONFIG: GraphConfig = {
  algorithm: "leiden",
  edgeWeights: { ...DEFAULT_EDGE_WEIGHTS },
  resolution: 3.0,
  minCommunitySize: 3,
  maxCommunitySize: 18,
  autoResolution: true,
  directoryDecay: 0.7,
};

/**
 * Compute directory-level distance between two files relative to rootPath.
 * Distance = number of unique directory segments when traversing from one file's
 * directory to the other via their common ancestor.
 *
 * Examples (relative to root):
 *   src/components/Button.tsx vs src/components/Input.tsx → 0 (same dir)
 *   src/components/Button.tsx vs src/utils/format.ts → 2 (sibling dirs)
 *   packages/core/src/graph.ts vs packages/webapp/src/App.tsx → 4
 */
export function computeDirectoryDistance(
  filePathA: string,
  filePathB: string,
  rootPath: string,
): number {
  const segsA = path
    .relative(rootPath, path.dirname(filePathA))
    .split(path.sep)
    .filter(Boolean);
  const segsB = path
    .relative(rootPath, path.dirname(filePathB))
    .split(path.sep)
    .filter(Boolean);

  let common = 0;
  while (
    common < segsA.length &&
    common < segsB.length &&
    segsA[common] === segsB[common]
  ) {
    common++;
  }

  return segsA.length - common + (segsB.length - common);
}

/**
 * Extract a human-readable package label for a file.
 * Uses the ModuleResolver to find the containing workspace package if available.
 * Falls back to the first directory segment relative to root.
 */
export function computePackage(
  filePath: string,
  rootPath: string,
  resolver?: ModuleResolver,
): string {
  if (resolver) {
    let bestMatch = "";
    let bestName = "root";
    for (const [name, pkg] of resolver.workspacePackages) {
      if (
        filePath.startsWith(pkg.dir + path.sep) &&
        pkg.dir.length > bestMatch.length
      ) {
        bestMatch = pkg.dir;
        bestName = name;
      }
    }
    if (bestMatch) return bestName;
  }
  const rel = path.relative(rootPath, filePath).replace(/\\/g, "/");
  const parts = rel.split("/");
  return parts.length > 1 ? parts[0] : "root";
}

// ============ MODULE RESOLUTION ============

export interface ModuleResolver {
  /** Map workspace package names (e.g. "@ophan/core") to their directory + exports */
  workspacePackages: Map<
    string,
    { dir: string; exports: Record<string, string> }
  >;
  /** Map package directory to its tsconfig path aliases */
  pathAliases: Map<
    string,
    { baseUrl: string; paths: Record<string, string[]> }
  >;
}

/** Marker files that indicate a package/project root directory */
const PACKAGE_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "setup.py",
  "pom.xml",
];

/**
 * Discover package directories by walking UP from analyzed file directories
 * and looking for marker files (package.json, pyproject.toml, go.mod, etc.).
 *
 * Technology-agnostic: works on any codebase regardless of directory naming.
 * The checked set ensures each directory is only inspected once.
 */
function discoverPackageDirs(
  rootPath: string,
  functions: FunctionInfo[],
): string[] {
  const fileDirs = new Set(functions.map((f) => path.dirname(f.filePath)));
  const packageDirs = new Set<string>();
  const checked = new Set<string>();

  for (const dir of fileDirs) {
    let current = dir;
    while (current.startsWith(rootPath) && current !== path.dirname(current)) {
      if (checked.has(current)) break;
      checked.add(current);
      for (const marker of PACKAGE_MARKERS) {
        try {
          fs.statSync(path.join(current, marker));
          packageDirs.add(current);
          break;
        } catch {
          /* no marker here */
        }
      }
      current = path.dirname(current);
    }
  }

  // Always include root if it has a marker file
  if (!checked.has(rootPath)) {
    for (const marker of PACKAGE_MARKERS) {
      try {
        fs.statSync(path.join(rootPath, marker));
        packageDirs.add(rootPath);
        break;
      } catch {
        /* no marker */
      }
    }
  }

  return [...packageDirs];
}

/**
 * Build a ModuleResolver by discovering packages via marker files.
 * Walks up from analyzed file directories to find package.json, pyproject.toml, etc.
 * Reads package.json (for name + exports) and tsconfig.json (for path aliases).
 * Runs once per graph command invocation -- not per-edge.
 */
export function buildModuleResolver(
  rootPath: string,
  functions?: FunctionInfo[],
): ModuleResolver {
  const workspacePackages = new Map<
    string,
    { dir: string; exports: Record<string, string> }
  >();
  const pathAliases = new Map<
    string,
    { baseUrl: string; paths: Record<string, string[]> }
  >();

  const packageDirs = functions
    ? discoverPackageDirs(rootPath, functions)
    : [rootPath]; // fallback: just root

  for (const dir of packageDirs) {
    // Read package.json for name + exports
    try {
      const pkgJson = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf-8"),
      );
      const name = pkgJson.name as string | undefined;
      if (name) {
        const exports: Record<string, string> = {};
        if (pkgJson.exports && typeof pkgJson.exports === "object") {
          for (const [key, value] of Object.entries(pkgJson.exports)) {
            if (typeof value === "string") exports[key] = value;
          }
        }
        if (!exports["."] && pkgJson.main) {
          exports["."] = pkgJson.main;
        }
        workspacePackages.set(name, { dir, exports });
      }
    } catch {
      /* skip dirs without valid package.json */
    }

    // Read tsconfig.json for paths
    try {
      const tsconfig = JSON.parse(
        fs.readFileSync(path.join(dir, "tsconfig.json"), "utf-8"),
      );
      const compilerOptions = tsconfig.compilerOptions;
      if (compilerOptions?.paths) {
        const baseUrl = compilerOptions.baseUrl
          ? path.resolve(dir, compilerOptions.baseUrl)
          : dir;
        pathAliases.set(dir, { baseUrl, paths: compilerOptions.paths });
      }
    } catch {
      /* skip dirs without tsconfig or paths */
    }
  }

  return { workspacePackages, pathAliases };
}

// ============ EDGE TYPES ============

export interface FunctionEdge {
  sourceHash: string;
  targetHash: string;
  edgeType:
    | "call"
    | "type_ref"
    | "import"
    | "co_location"
    | "jsx_ref"
    | "transitive_call"
    | "co_caller";
  weight: number;
}


// ============ CONFIG PERSISTENCE ============

export function loadGraphConfig(db: Database.Database): GraphConfig {
  const row = db
    .prepare("SELECT value FROM graph_config WHERE key = 'config'")
    .get() as { value: string } | undefined;

  if (!row) return { ...DEFAULT_GRAPH_CONFIG };

  try {
    const stored = JSON.parse(row.value);
    return {
      ...DEFAULT_GRAPH_CONFIG,
      ...stored,
      edgeWeights: {
        ...DEFAULT_GRAPH_CONFIG.edgeWeights,
        ...(stored.edgeWeights || {}),
      },
    };
  } catch {
    return { ...DEFAULT_GRAPH_CONFIG };
  }
}

export function saveGraphConfig(
  db: Database.Database,
  config: GraphConfig,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO graph_config (key, value) VALUES ('config', ?)",
  ).run(JSON.stringify(config));
}

// ============ EDGE RESOLUTION ============

/**
 * Given extracted functions with call-site data, resolve name-based calls to
 * content hash edges. Uses the file_functions index for name→hash lookup.
 *
 * Returns edges ready to insert into function_edges table.
 */
/**
 * Build shared lookup context for edge resolvers.
 * Queries file_functions once and constructs all lookup maps that resolvers need.
 * Called once per resolveEdges() invocation.
 */
export function buildEdgeResolverContext(
  db: Database.Database,
  functions: FunctionInfo[],
  config: GraphConfig,
  affectedHashes?: Set<string>,
  resolver?: ModuleResolver,
): EdgeResolverContext {
  // Query all file_functions rows once
  const allDbRows = db
    .prepare(
      "SELECT file_path, function_name, content_hash FROM file_functions",
    )
    .all() as {
    file_path: string;
    function_name: string;
    content_hash: string;
  }[];

  // Build name→hash lookup
  const nameToHashes = new Map<string, Set<string>>();
  for (const row of allDbRows) {
    const existing = nameToHashes.get(row.function_name) || new Set();
    existing.add(row.content_hash);
    nameToHashes.set(row.function_name, existing);
  }

  // Build file→hashes for import target resolution
  const fileToHashes = new Map<string, Set<string>>();
  for (const row of allDbRows) {
    const existing = fileToHashes.get(row.file_path) || new Set();
    existing.add(row.content_hash);
    fileToHashes.set(row.file_path, existing);
  }

  // Build (file::name) → hash for targeted import edges
  const fileNameToHash = new Map<string, string>();
  for (const row of allDbRows) {
    fileNameToHash.set(
      `${row.file_path}::${row.function_name}`,
      row.content_hash,
    );
  }

  // Build package-scoped name→hashes for fallback import resolution.
  // When imports resolve through barrel files (index.ts with re-exports),
  // the imported name isn't defined in the barrel -- it's in another file.
  // This map lets us find the function by name within the package scope.
  const pkgNameToHashes = new Map<string, Map<string, Set<string>>>();
  if (resolver) {
    for (const [pkgName, pkg] of resolver.workspacePackages) {
      const nameMap = new Map<string, Set<string>>();
      for (const row of allDbRows) {
        if (row.file_path.startsWith(pkg.dir + path.sep)) {
          const existing = nameMap.get(row.function_name) || new Set();
          existing.add(row.content_hash);
          nameMap.set(row.function_name, existing);
        }
      }
      if (nameMap.size > 0) {
        pkgNameToHashes.set(pkgName, nameMap);
      }
    }
  }

  // Build file → sorted functions map for proximity-based co-location edges
  const fileToSortedFns = new Map<string, FunctionInfo[]>();
  for (const fn of functions) {
    const list = fileToSortedFns.get(fn.filePath) || [];
    list.push(fn);
    fileToSortedFns.set(fn.filePath, list);
  }
  for (const fns of fileToSortedFns.values()) {
    fns.sort((a, b) => a.startLine - b.startLine);
  }

  return {
    nameToHashes,
    fileToHashes,
    fileNameToHash,
    pkgNameToHashes,
    fileToSortedFns,
    functions,
    config,
    affectedHashes,
    resolver,
  };
}

export function resolveEdges(
  db: Database.Database,
  functions: FunctionInfo[],
  config: GraphConfig,
  affectedHashes?: Set<string>,
  resolver?: ModuleResolver,
): FunctionEdge[] {
  const ctx = buildEdgeResolverContext(db, functions, config, affectedHashes, resolver);
  const edges: FunctionEdge[] = [];
  for (const edgeResolver of getEdgeResolvers()) {
    edges.push(...edgeResolver.resolve(ctx));
  }
  return edges;
}

// ============ TRANSITIVE EDGES ============

/** Maximum callees per caller for co-caller edge generation.
 *  Hub functions with many callees would create O(n^2) edges -- cap to prevent explosion. */
const CO_CALLER_CAP = 15;

/**
 * Derive transitive edges from the call graph to increase connectivity.
 * Pure function -- no DB access.
 *
 * Two derived edge types:
 * 1. **transitive_call** (A→B→C creates A↔C): 2-hop call chain connectivity.
 * 2. **co_caller** (A→B, A→C creates B↔C): Functions called by the same caller.
 *
 * Edges are NOT deduped against direct edges -- being related in multiple ways
 * (e.g., direct call + transitive chain) intentionally increases connection strength.
 * buildGraph() merges parallel edges by summing weights.
 */
export function addTransitiveEdges(
  edges: FunctionEdge[],
  config: GraphConfig,
): FunctionEdge[] {
  // Build directed call adjacency: caller → Set<callee>
  // Only 'call' edges preserve direction (sourceHash=caller, targetHash=callee)
  const callsTo = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.edgeType === "call") {
      let targets = callsTo.get(edge.sourceHash);
      if (!targets) {
        targets = new Set();
        callsTo.set(edge.sourceHash, targets);
      }
      targets.add(edge.targetHash);
    }
  }

  if (callsTo.size === 0) return edges;

  const newEdges: FunctionEdge[] = [];

  // 1. Transitive call: A→B→C creates A↔C
  const transitiveAdded = new Set<string>();
  for (const [caller, callees] of callsTo) {
    for (const callee of callees) {
      const indirectCallees = callsTo.get(callee);
      if (!indirectCallees) continue;
      for (const indirect of indirectCallees) {
        if (indirect === caller) continue; // skip self-loops
        const a = caller < indirect ? caller : indirect;
        const b = caller < indirect ? indirect : caller;
        const key = `${a}|${b}`;
        if (!transitiveAdded.has(key)) {
          transitiveAdded.add(key);
          newEdges.push({
            sourceHash: a,
            targetHash: b,
            edgeType: "transitive_call",
            weight: config.edgeWeights.transitive_call,
          });
        }
      }
    }
  }

  // 2. Co-caller: A→B, A→C creates B↔C (capped to prevent hub explosion)
  const coCallerAdded = new Set<string>();
  for (const [, callees] of callsTo) {
    if (callees.size < 2 || callees.size > CO_CALLER_CAP) continue;
    const calleeList = [...callees];
    for (let i = 0; i < calleeList.length; i++) {
      for (let j = i + 1; j < calleeList.length; j++) {
        const a = calleeList[i] < calleeList[j] ? calleeList[i] : calleeList[j];
        const b = calleeList[i] < calleeList[j] ? calleeList[j] : calleeList[i];
        const key = `${a}|${b}`;
        if (!coCallerAdded.has(key)) {
          coCallerAdded.add(key);
          newEdges.push({
            sourceHash: a,
            targetHash: b,
            edgeType: "co_caller",
            weight: config.edgeWeights.co_caller,
          });
        }
      }
    }
  }

  return [...edges, ...newEdges];
}

/**
 * Store resolved edges in the function_edges table.
 * Clears existing edges first (they're rebuilt from source each scan).
 */
export function storeEdges(db: Database.Database, edges: FunctionEdge[]): void {
  db.exec("DELETE FROM function_edges");

  const insert = db.prepare(
    "INSERT OR REPLACE INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const edge of edges) {
      insert.run(edge.sourceHash, edge.targetHash, edge.edgeType, edge.weight);
    }
  });

  tx();
}

/**
 * Incremental edge storage: delete edges for affected hashes, then insert new edges.
 * Used when only a subset of functions changed -- keeps unaffected edges in place.
 */
export function storeEdgesIncremental(
  db: Database.Database,
  affectedHashes: Set<string>,
  newEdges: FunctionEdge[],
): void {
  const hashes = [...affectedHashes];

  // Delete in chunks to stay within SQLite variable limits
  const deleteStmt = db.prepare(
    "DELETE FROM function_edges WHERE source_hash = ? OR target_hash = ?",
  );
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const hash of hashes) {
      deleteStmt.run(hash, hash);
    }
    for (const edge of newEdges) {
      insertStmt.run(
        edge.sourceHash,
        edge.targetHash,
        edge.edgeType,
        edge.weight,
      );
    }
  });

  tx();
}

/**
 * Replace all transitive edges (transitive_call, co_caller) in the database.
 * Direct edges are untouched. Used after recomputing transitive edges from
 * the current call graph.
 */
export function storeTransitiveEdges(
  db: Database.Database,
  transitiveEdges: FunctionEdge[],
): void {
  const deleteStmt = db.prepare(
    "DELETE FROM function_edges WHERE edge_type IN ('transitive_call', 'co_caller')",
  );
  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO function_edges (source_hash, target_hash, edge_type, weight) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    deleteStmt.run();
    for (const edge of transitiveEdges) {
      insertStmt.run(edge.sourceHash, edge.targetHash, edge.edgeType, edge.weight);
    }
  });

  tx();
}

/**
 * Load all edges from the database.
 */
export function loadEdges(db: Database.Database): FunctionEdge[] {
  const rows = db
    .prepare(
      "SELECT source_hash, target_hash, edge_type, weight FROM function_edges",
    )
    .all() as {
    source_hash: string;
    target_hash: string;
    edge_type: string;
    weight: number;
  }[];

  return rows.map((r) => ({
    sourceHash: r.source_hash,
    targetHash: r.target_hash,
    edgeType: r.edge_type as FunctionEdge["edgeType"],
    weight: r.weight,
  }));
}

// ============ GRAPH CONSTRUCTION ============

/**
 * Build a graphology graph from function edges.
 * Creates an undirected weighted graph -- multiple edges between the same
 * pair (different edge types) are merged by summing weights.
 */
export function buildGraph(
  edges: FunctionEdge[],
  hashToFilePath?: Map<string, string>,
  rootPath?: string,
  directoryDecay?: number,
  allHashes?: Set<string>,
): Graph {
  const graph = new Graph({ type: "undirected" });

  // Add ALL function hashes as nodes (every extracted function is a node)
  if (allHashes) {
    for (const hash of allHashes) {
      graph.addNode(hash);
    }
  }
  // Also add any nodes from edges not already present
  for (const edge of edges) {
    if (!graph.hasNode(edge.sourceHash)) graph.addNode(edge.sourceHash);
    if (!graph.hasNode(edge.targetHash)) graph.addNode(edge.targetHash);
  }

  // Pre-compute directory segments for each node (avoids repeated path operations per-edge)
  const dirSegCache = new Map<string, string[]>();
  const applyDecay =
    hashToFilePath &&
    rootPath &&
    directoryDecay !== undefined &&
    directoryDecay > 0;
  if (applyDecay) {
    for (const [hash, fp] of hashToFilePath!) {
      dirSegCache.set(
        hash,
        path
          .relative(rootPath!, path.dirname(fp))
          .split(path.sep)
          .filter(Boolean),
      );
    }
  }

  // Merge parallel edges (same pair, different types) by summing weights
  const mergedWeights = new Map<string, number>();
  for (const edge of edges) {
    const a =
      edge.sourceHash < edge.targetHash ? edge.sourceHash : edge.targetHash;
    const b =
      edge.sourceHash < edge.targetHash ? edge.targetHash : edge.sourceHash;
    const key = `${a}|${b}`;
    let weight = edge.weight;
    if (applyDecay) {
      const segsA = dirSegCache.get(a);
      const segsB = dirSegCache.get(b);
      if (segsA && segsB) {
        let common = 0;
        while (
          common < segsA.length &&
          common < segsB.length &&
          segsA[common] === segsB[common]
        ) {
          common++;
        }
        const dist = segsA.length - common + (segsB.length - common);
        if (dist > 0) {
          weight *= Math.exp(-directoryDecay! * dist);
        }
      }
    }
    mergedWeights.set(key, (mergedWeights.get(key) || 0) + weight);
  }

  for (const [key, weight] of mergedWeights) {
    const [a, b] = key.split("|");
    graph.addEdge(a, b, { weight });
  }

  return graph;
}

// ============ CENTRALITY ============

export interface CentralityResult {
  /** Map of content_hash → betweenness centrality score (0–1, normalized) */
  scores: Map<string, number>;
  /** Functions ranked by centrality descending -- top bridge functions first */
  ranked: { contentHash: string; score: number }[];
}

/**
 * Compute betweenness centrality for all nodes in the graph.
 * High-centrality nodes are "bridge" functions that many shortest paths
 * pass through -- coupling points between communities.
 */
export function computeCentrality(graph: Graph): CentralityResult {
  if (graph.order === 0) {
    return { scores: new Map(), ranked: [] };
  }

  const raw = betweennessCentrality(graph, {
    getEdgeWeight: "weight",
    normalized: true,
  });

  const scores = new Map<string, number>();
  const ranked: CentralityResult["ranked"] = [];
  for (const [node, score] of Object.entries(raw)) {
    scores.set(node, score);
    ranked.push({ contentHash: node, score });
  }
  ranked.sort((a, b) => b.score - a.score);

  return { scores, ranked };
}

// ============ INCREMENTAL HELPERS ============

/**
 * Compute the set of content hashes that changed between old and new function sets.
 * Returns the symmetric difference: hashes that appeared or disappeared.
 */
export function computeChangedHashes(
  oldHashes: Set<string>,
  newHashes: Set<string>,
): Set<string> {
  const changed = new Set<string>();
  for (const h of newHashes) {
    if (!oldHashes.has(h)) changed.add(h);
  }
  for (const h of oldHashes) {
    if (!newHashes.has(h)) changed.add(h);
  }
  return changed;
}

/**
 * Find edge neighbors of a set of hashes -- any hash connected to them via function_edges.
 */
function findEdgeNeighbors(
  db: Database.Database,
  hashes: Set<string>,
): Set<string> {
  const neighbors = new Set<string>();
  const stmt = db.prepare(
    "SELECT source_hash, target_hash FROM function_edges WHERE source_hash = ? OR target_hash = ?",
  );
  for (const hash of hashes) {
    const rows = stmt.all(hash, hash) as {
      source_hash: string;
      target_hash: string;
    }[];
    for (const row of rows) {
      neighbors.add(row.source_hash);
      neighbors.add(row.target_hash);
    }
  }
  return neighbors;
}

// ============ GRAPH BUILDING PIPELINE ============

/**
 * Build the function relationship graph: resolve edges, handle incremental updates,
 * add transitive edges. Returns all edges (stored + transitive) ready for consumers.
 *
 * This is the graph-building half of the pipeline. Downstream features (community
 * detection, visualization, etc.) consume the returned edges independently.
 *
 * When `oldHashes` is provided, uses incremental edge resolution: only recomputes edges
 * for changed functions + their neighbors, keeping the rest of the graph stable.
 */
export function buildFunctionGraph(
  db: Database.Database,
  functions: FunctionInfo[],
  config?: GraphConfig,
  oldHashes?: Set<string>,
  rootPath?: string,
): FunctionEdge[] {
  const graphConfig = config || loadGraphConfig(db);
  const newHashes = new Set(functions.map((f) => f.contentHash));

  // Build module resolver using marker file discovery for workspace + alias import resolution
  const resolver = rootPath
    ? buildModuleResolver(rootPath, functions)
    : undefined;

  // Determine incremental vs full rebuild
  const changedHashes = oldHashes
    ? computeChangedHashes(oldHashes, newHashes)
    : null;
  // Incremental mode requires existing edges to find neighbors -- without prior edges,
  // the affected set is too small and produces a near-empty graph. This happens when
  // file_functions was populated by watch/init but graph has never been run.
  const hasExistingEdges =
    changedHashes !== null &&
    changedHashes.size > 0 &&
    changedHashes.size / Math.max(newHashes.size, 1) <= 0.5
      ? (
          db
            .prepare("SELECT COUNT(*) as cnt FROM function_edges")
            .get() as { cnt: number }
        ).cnt > 0
      : false;
  const useIncremental =
    changedHashes !== null &&
    changedHashes.size > 0 &&
    changedHashes.size / Math.max(newHashes.size, 1) <= 0.5 &&
    hasExistingEdges;

  if (changedHashes !== null && changedHashes.size === 0) {
    // No-change fast path: edges in DB already include transitive from last run.
    // Only valid once a graph has been built: `init`, `analyze` and watch fill file_functions
    // too, so "nothing changed" can also mean "graph never run", and then there are no edges.
    const stored = loadEdges(db);
    if (stored.length > 0) return stored;
  }

  let directEdges: FunctionEdge[];

  if (useIncremental) {
    // Incremental mode: only resolve edges for changed functions + their neighbors
    const neighbors = findEdgeNeighbors(db, changedHashes!);
    const affectedHashes = new Set([...changedHashes!, ...neighbors]);
    // Filter to only hashes that still exist (exclude removed hashes)
    for (const h of affectedHashes) {
      if (!newHashes.has(h)) affectedHashes.delete(h);
    }
    const newEdges = resolveEdges(
      db,
      functions,
      graphConfig,
      affectedHashes,
      resolver,
    );
    storeEdgesIncremental(db, affectedHashes, newEdges);
    // Load all direct edges from DB (excludes stale transitive from incremental deletes)
    const allStored = loadEdges(db);
    directEdges = allStored.filter(
      (e) => e.edgeType !== "transitive_call" && e.edgeType !== "co_caller",
    );
  } else {
    // Full rebuild (first run or >50% changed)
    directEdges = resolveEdges(db, functions, graphConfig, undefined, resolver);
    storeEdges(db, directEdges);
  }

  // Compute transitive edges from current call graph and store them
  const allEdges = addTransitiveEdges(directEdges, graphConfig);
  const transitiveEdges = allEdges.filter(
    (e) => e.edgeType === "transitive_call" || e.edgeType === "co_caller",
  );
  storeTransitiveEdges(db, transitiveEdges);

  return allEdges;
}
