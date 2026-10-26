// Community detection module -- clusters functions into communities using graph algorithms.
//
// Consumes the function relationship graph built by graph.ts.
// This is one feature that builds on the graph; other features (visualization,
// PR impact analysis, team ownership mapping) can also consume the graph independently.
//
// Architecture:
//   1. graph.ts builds edges (edge resolution, transitive edges, storage)
//   2. This module runs community detection on those edges
//   3. Post-processing: dissolution, rescue, active splitting, stable matching
//   4. Hierarchical detection: L0 function-level → L1 community-level grouping
//   5. Comparison tooling: evaluate algorithm/parameter configurations

import type Database from "better-sqlite3";
import Graph from "graphology";
import {
  buildGraph,
  loadGraphConfig,
  saveGraphConfig,
  type FunctionEdge,
  type GraphConfig,
} from "./graph";
import { getDetector, LabelPropDetector } from "./community-detectors";
import type { FunctionInfo } from "./shared";

// ============ TYPES ============

export interface CommunityEdge {
  sourceCommunity: string;
  targetCommunity: string;
  algorithm: string;
  weight: number;
  edgeCount: number;
}

export interface CommunityAssignment {
  contentHash: string;
  level: number;
  communityId: string;
  algorithm: string;
}

export interface DetectionResult {
  assignments: CommunityAssignment[];
  communityCount: number;
  modularity: number | null;
  nodesInGraph: number;
  edgesInGraph: number;
  dissolvedCount: number;
  effectiveResolution?: number;
}

export interface HierarchicalDetectionResult {
  l0: DetectionResult;
  communityEdges: CommunityEdge[];
  l1Assignments: CommunityAssignment[];
  l1GroupCount: number;
}

export interface ComparisonMetrics {
  label: string;
  algorithm: string;
  resolution: number | null;
  communityCount: number;
  dissolvedCount: number;
  dissolvedPct: number;
  coverage: number;
  minSize: number;
  medianSize: number;
  maxSize: number;
  modularity: number | null;
  nodesInGraph: number;
  edgesInGraph: number;
}

export interface ComparisonConfig {
  label: string;
  algorithm: string;
  resolution: number;
}

// ============ COMMUNITY STORAGE ============

/**
 * Store community assignments in the communities table.
 */
export function storeCommunities(
  db: Database.Database,
  assignments: CommunityAssignment[],
): void {
  // Clear existing assignments for this algorithm + level
  if (assignments.length === 0) return;

  const algorithm = assignments[0].algorithm;
  const level = assignments[0].level;
  db.prepare("DELETE FROM communities WHERE algorithm = ? AND level = ?").run(
    algorithm,
    level,
  );

  const insert = db.prepare(
    "INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const a of assignments) {
      insert.run(a.contentHash, a.level, a.communityId, a.algorithm);
    }
  });

  tx();
}

/**
 * Load community assignments from the database.
 */
export function loadCommunities(
  db: Database.Database,
  algorithm: string,
  level: number,
): CommunityAssignment[] {
  const rows = db
    .prepare(
      "SELECT content_hash, level, community_id, algorithm FROM communities WHERE algorithm = ? AND level = ?",
    )
    .all(algorithm, level) as {
    content_hash: string;
    level: number;
    community_id: string;
    algorithm: string;
  }[];

  return rows.map((r) => ({
    contentHash: r.content_hash,
    level: r.level,
    communityId: r.community_id,
    algorithm: r.algorithm,
  }));
}

// ============ COMMUNITY EDGES ============

/**
 * Aggregate function-level edges into community-level edges.
 * For each pair of distinct L0 communities, sums the weights of all
 * function edges that cross between them.
 */
export function computeCommunityEdges(
  db: Database.Database,
  algorithm: string,
  edges?: FunctionEdge[],
): CommunityEdge[] {
  // Load L0 community assignments (excluding dissolved)
  const assignments = db
    .prepare(
      "SELECT content_hash, community_id FROM communities WHERE level = 0 AND algorithm = ? AND community_id != '__dissolved'",
    )
    .all(algorithm) as { content_hash: string; community_id: string }[];

  const hashToCommunity = new Map<string, string>();
  for (const a of assignments) {
    hashToCommunity.set(a.content_hash, a.community_id);
  }

  // Use provided edges (includes transitive) or load from DB
  const fnEdges: {
    source_hash: string;
    target_hash: string;
    weight: number;
  }[] = edges
    ? edges.map((e) => ({
        source_hash: e.sourceHash,
        target_hash: e.targetHash,
        weight: e.weight,
      }))
    : (db
        .prepare("SELECT source_hash, target_hash, weight FROM function_edges")
        .all() as {
        source_hash: string;
        target_hash: string;
        weight: number;
      }[]);

  // Accumulate cross-community edges
  const edgeMap = new Map<string, { weight: number; count: number }>();
  for (const e of fnEdges) {
    const srcComm = hashToCommunity.get(e.source_hash);
    const tgtComm = hashToCommunity.get(e.target_hash);
    if (!srcComm || !tgtComm || srcComm === tgtComm) continue;

    // Canonical ordering
    const a = srcComm < tgtComm ? srcComm : tgtComm;
    const b = srcComm < tgtComm ? tgtComm : srcComm;
    const key = `${a}|${b}`;
    const existing = edgeMap.get(key) || { weight: 0, count: 0 };
    existing.weight += e.weight;
    existing.count += 1;
    edgeMap.set(key, existing);
  }

  const result: CommunityEdge[] = [];
  for (const [key, data] of edgeMap) {
    const [a, b] = key.split("|");
    result.push({
      sourceCommunity: a,
      targetCommunity: b,
      algorithm,
      weight: data.weight,
      edgeCount: data.count,
    });
  }
  return result;
}

/**
 * Store community edges (full replace per algorithm).
 */
export function storeCommunityEdges(
  db: Database.Database,
  edges: CommunityEdge[],
): void {
  if (edges.length === 0) {
    db.exec("DELETE FROM community_edges");
    return;
  }

  const algorithm = edges[0].algorithm;
  db.prepare("DELETE FROM community_edges WHERE algorithm = ?").run(algorithm);

  const insert = db.prepare(
    "INSERT INTO community_edges (source_community, target_community, algorithm, weight, edge_count) VALUES (?, ?, ?, ?, ?)",
  );

  const tx = db.transaction(() => {
    for (const edge of edges) {
      insert.run(
        edge.sourceCommunity,
        edge.targetCommunity,
        edge.algorithm,
        edge.weight,
        edge.edgeCount,
      );
    }
  });

  tx();
}

/**
 * Load community edges from the database.
 */
export function loadCommunityEdges(
  db: Database.Database,
  algorithm: string,
): CommunityEdge[] {
  const rows = db
    .prepare(
      "SELECT source_community, target_community, algorithm, weight, edge_count FROM community_edges WHERE algorithm = ?",
    )
    .all(algorithm) as {
    source_community: string;
    target_community: string;
    algorithm: string;
    weight: number;
    edge_count: number;
  }[];

  return rows.map((r) => ({
    sourceCommunity: r.source_community,
    targetCommunity: r.target_community,
    algorithm: r.algorithm,
    weight: r.weight,
    edgeCount: r.edge_count,
  }));
}

// ============ COMMUNITY DETECTION ============

/**
 * Rescue dissolved nodes by assigning each to the community with the strongest
 * total edge weight. Mutates assignments in-place. Returns the number rescued.
 *
 * Nodes with zero connections to any non-dissolved community stay dissolved.
 * Rescued nodes update the membership map so subsequent rescues see them as
 * placed (enabling chained rescue where node B is rescued into a community
 * that node A was just rescued into).
 */
export function rescueDissolvedNodes(
  assignments: CommunityAssignment[],
  edges: FunctionEdge[],
  dissolvedMarker: string,
): number {
  const dissolvedHashes: string[] = [];
  for (const a of assignments) {
    if (a.communityId === dissolvedMarker) {
      dissolvedHashes.push(a.contentHash);
    }
  }
  if (dissolvedHashes.length === 0) return 0;

  // Build membership map (hash → community) for non-dissolved nodes
  const hashToComm = new Map<string, string>();
  for (const a of assignments) {
    if (a.communityId !== dissolvedMarker) {
      hashToComm.set(a.contentHash, a.communityId);
    }
  }
  if (hashToComm.size === 0) return 0;

  let rescued = 0;
  for (const hash of dissolvedHashes) {
    // Sum edge weights to each community
    const commWeights = new Map<string, number>();
    for (const edge of edges) {
      const neighbor =
        edge.sourceHash === hash
          ? edge.targetHash
          : edge.targetHash === hash
            ? edge.sourceHash
            : null;
      if (!neighbor) continue;
      const comm = hashToComm.get(neighbor);
      if (comm) {
        commWeights.set(comm, (commWeights.get(comm) || 0) + edge.weight);
      }
    }

    // Find the community with strongest total connection
    let bestComm = "";
    let bestWeight = 0;
    for (const [comm, weight] of commWeights) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestComm = comm;
      }
    }

    if (bestComm) {
      const assignment = assignments.find((a) => a.contentHash === hash);
      if (assignment) {
        assignment.communityId = bestComm;
        hashToComm.set(hash, bestComm); // chained rescue
        rescued++;
      }
    }
  }

  return rescued;
}

/**
 * Run community detection on the given edges using the configured algorithm.
 * Returns assignments ready for storage, plus stats about the detection run.
 *
 * Small communities (< minCommunitySize) are dissolved -- their members are
 * assigned to a special "__dissolved" community. Dissolved nodes are then
 * rescued: each is assigned to the community it's most connected to by total
 * edge weight. Truly isolated nodes (zero connections) stay dissolved.
 */
export function detectCommunities(
  edges: FunctionEdge[],
  config: GraphConfig,
  hashToFilePath?: Map<string, string>,
  rootPath?: string,
  allHashes?: Set<string>,
): DetectionResult {
  const graph = buildGraph(
    edges,
    hashToFilePath,
    rootPath,
    config.directoryDecay,
    allHashes,
  );

  if (graph.order === 0) {
    return {
      assignments: [],
      communityCount: 0,
      modularity: null,
      nodesInGraph: 0,
      edgesInGraph: 0,
      dissolvedCount: 0,
    };
  }

  // Auto-resolution: scale resolution with codebase size for better granularity
  let resolution = config.resolution;
  if (config.autoResolution !== false) {
    const nodeCount = graph.order;
    if (nodeCount < 50) resolution = Math.max(resolution, 1.0);
    else if (nodeCount < 200) resolution = Math.max(resolution, 1.5);
    else resolution = Math.max(resolution, 2.0);
  }

  const detector = getDetector(config.algorithm);
  const raw = detector.detect(graph, { resolution, weightAttribute: "weight" });
  const communities = raw.communities;
  const modularity = raw.modularity;

  // Group nodes by community
  const communityMembers = new Map<number, string[]>();
  for (const [node, communityId] of Object.entries(communities)) {
    const members = communityMembers.get(communityId) || [];
    members.push(node);
    communityMembers.set(communityId, members);
  }

  // Active splitting: re-run at higher resolution on oversized communities
  const splitMembers = new Map<string, string[]>();
  for (const [communityId, members] of communityMembers) {
    if (
      members.length > config.maxCommunitySize &&
      detector.supportsResolution
    ) {
      const memberSet = new Set(members);
      const subEdges = edges.filter(
        (e) => memberSet.has(e.sourceHash) && memberSet.has(e.targetHash),
      );
      if (subEdges.length > 0) {
        const subResult = detectCommunities(subEdges, {
          ...config,
          resolution: resolution * 2,
          autoResolution: false, // prevent recursive auto-scaling
        });
        // Only accept the split if it produced multiple communities without destroying too many
        if (
          subResult.communityCount > 1 &&
          subResult.dissolvedCount <= members.length * 0.5
        ) {
          for (const a of subResult.assignments) {
            a.communityId = `${communityId}_${a.communityId}`;
          }

          // Rescue dissolved split fragments into nearest sub-community
          const dissolvedMarker = `${communityId}___dissolved`;
          rescueDissolvedNodes(
            subResult.assignments,
            subEdges,
            dissolvedMarker,
          );

          splitMembers.set(String(communityId), []);
          for (const a of subResult.assignments) {
            const list = splitMembers.get(a.communityId) || [];
            list.push(a.contentHash);
            splitMembers.set(a.communityId, list);
          }
        }
      }
    }
  }

  // Build final assignments
  const assignments: CommunityAssignment[] = [];
  let dissolvedCount = 0;

  for (const [communityId, members] of communityMembers) {
    // If this community was split, use the split assignments instead
    if (splitMembers.has(String(communityId))) continue;

    const isTooSmall = members.length < config.minCommunitySize;
    const assignedId = isTooSmall ? "__dissolved" : String(communityId);

    if (isTooSmall) dissolvedCount += members.length;

    for (const contentHash of members) {
      assignments.push({
        contentHash,
        level: 0,
        communityId: assignedId,
        algorithm: config.algorithm,
      });
    }
  }

  // Add split community assignments
  for (const [subCommunityId, members] of splitMembers) {
    // Detect dissolved groups from recursive splits (prefixed: "66___dissolved")
    const isDissolvedGroup = subCommunityId.endsWith("___dissolved");
    if (isDissolvedGroup) {
      dissolvedCount += members.length;
    }
    const isTooSmall = members.length < config.minCommunitySize;
    const assignedId =
      isDissolvedGroup || isTooSmall ? "__dissolved" : subCommunityId;
    if (isTooSmall && !isDissolvedGroup) dissolvedCount += members.length;

    for (const contentHash of members) {
      assignments.push({
        contentHash,
        level: 0,
        communityId: assignedId,
        algorithm: config.algorithm,
      });
    }
  }

  // Rescue top-level dissolved nodes into nearest community
  const topRescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
  dissolvedCount -= topRescued;

  // Count actual (non-dissolved) communities
  const realCommunities = new Set(
    assignments
      .filter((a) => a.communityId !== "__dissolved")
      .map((a) => a.communityId),
  );

  return {
    assignments,
    communityCount: realCommunities.size,
    modularity,
    nodesInGraph: graph.order,
    edgesInGraph: graph.size,
    dissolvedCount,
    effectiveResolution: resolution,
  };
}

// ============ STABLE COMMUNITY MATCHING ============

/**
 * Match new community assignments to old ones by Jaccard similarity.
 * Remaps new community IDs to reuse old IDs where membership overlaps significantly.
 * This prevents summary cache misses caused by Louvain's arbitrary ID renumbering.
 *
 * Algorithm: greedy 1:1 matching -- sort all (new, old, Jaccard) triples by score
 * descending, accept matches where J ≥ threshold, each ID used at most once.
 */
export function matchCommunities(
  oldAssignments: CommunityAssignment[],
  newAssignments: CommunityAssignment[],
  threshold = 0.5,
): CommunityAssignment[] {
  if (oldAssignments.length === 0 || newAssignments.length === 0) {
    return newAssignments;
  }

  // Group by communityId → set of content hashes (skip __dissolved)
  const groupByComm = (assignments: CommunityAssignment[]) => {
    const map = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (a.communityId === "__dissolved") continue;
      const set = map.get(a.communityId) || new Set();
      set.add(a.contentHash);
      map.set(a.communityId, set);
    }
    return map;
  };

  const oldGroups = groupByComm(oldAssignments);
  const newGroups = groupByComm(newAssignments);

  if (oldGroups.size === 0 || newGroups.size === 0) {
    return newAssignments;
  }

  // Compute all Jaccard similarities
  const candidates: { newId: string; oldId: string; jaccard: number }[] = [];
  for (const [newId, newMembers] of newGroups) {
    for (const [oldId, oldMembers] of oldGroups) {
      let intersection = 0;
      for (const h of newMembers) {
        if (oldMembers.has(h)) intersection++;
      }
      const union = newMembers.size + oldMembers.size - intersection;
      if (union === 0) continue;
      const jaccard = intersection / union;
      if (jaccard >= threshold) {
        candidates.push({ newId, oldId, jaccard });
      }
    }
  }

  // Greedy 1:1 matching: best scores first
  candidates.sort((a, b) => b.jaccard - a.jaccard);
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const remap = new Map<string, string>(); // newId → oldId

  for (const { newId, oldId } of candidates) {
    if (usedNew.has(newId) || usedOld.has(oldId)) continue;
    remap.set(newId, oldId);
    usedNew.add(newId);
    usedOld.add(oldId);
  }

  if (remap.size === 0) {
    return newAssignments;
  }

  // Apply remapping
  return newAssignments.map((a) => {
    const remappedId = remap.get(a.communityId);
    if (remappedId) {
      return { ...a, communityId: remappedId };
    }
    return a;
  });
}

/**
 * Label Propagation Algorithm (LPA) for community detection.
 * Delegates to LabelPropDetector -- kept as a standalone export for backward compatibility.
 */
export function labelPropagation(
  graph: Graph,
  maxIterations = 100,
): Record<string, number> {
  const detector = new LabelPropDetector(maxIterations);
  const result = detector.detect(graph, {
    resolution: 0,
    weightAttribute: "weight",
  });
  return result.communities;
}

// ============ ORCHESTRATION ============

/**
 * Run community detection on pre-built edges, match with previous run, store results.
 * Call after buildFunctionGraph() to detect communities on the graph.
 */
export function detectAndStoreCommunities(
  db: Database.Database,
  edges: FunctionEdge[],
  functions: FunctionInfo[],
  config?: GraphConfig,
  rootPath?: string,
): DetectionResult {
  const graphConfig = config || loadGraphConfig(db);
  const newHashes = new Set(functions.map((f) => f.contentHash));

  // Build hash→filePath map for directory distance decay
  let hashToFilePath: Map<string, string> | undefined;
  if (rootPath && (graphConfig.directoryDecay ?? 0.1) > 0) {
    hashToFilePath = new Map();
    for (const fn of functions) {
      hashToFilePath.set(fn.contentHash, fn.filePath);
    }
  }

  // Detect communities from all edges including transitive
  const result = detectCommunities(
    edges,
    graphConfig,
    hashToFilePath,
    rootPath,
    newHashes,
  );

  // Stable community matching -- remap new IDs to old IDs by Jaccard similarity
  const oldAssignments = loadCommunities(db, graphConfig.algorithm, 0);
  const remapped = matchCommunities(oldAssignments, result.assignments);
  result.assignments = remapped;

  // Store community assignments
  storeCommunities(db, result.assignments);

  // Compute and store community edges (using full edge set including transitive)
  const communityEdges = computeCommunityEdges(
    db,
    graphConfig.algorithm,
    edges,
  );
  storeCommunityEdges(db, communityEdges);

  // Save config used (for reproducibility)
  saveGraphConfig(db, graphConfig);

  return result;
}

// ============ HIERARCHICAL DETECTION ============

/**
 * Detect hierarchical communities: first L0 (function-level), then L1 (community-level).
 *
 * After L0 detection + community edge computation, builds a meta-graph where:
 *   - Nodes = L0 community IDs (excluding __dissolved)
 *   - Edges = community_edges (weighted by aggregate function edge weight)
 *
 * Runs the configured algorithm on meta-graph to produce L1 group assignments.
 * Stores L1 assignments in the communities table with level=1,
 * where content_hash = L0 community_id.
 */
export function detectHierarchicalCommunities(
  db: Database.Database,
  edges: FunctionEdge[],
  functions: FunctionInfo[],
  config?: GraphConfig,
  rootPath?: string,
): HierarchicalDetectionResult {
  const graphConfig = config || loadGraphConfig(db);

  // Step 1: Run L0 detection (also computes + stores community edges)
  const l0 = detectAndStoreCommunities(db, edges, functions, graphConfig, rootPath);

  // Step 2: Load community edges
  const communityEdges = loadCommunityEdges(db, graphConfig.algorithm);

  // Step 3: Need at least 3 real communities for meaningful grouping
  const realCommunities = new Set(
    l0.assignments
      .filter((a) => a.communityId !== "__dissolved")
      .map((a) => a.communityId),
  );

  if (realCommunities.size < 3 || communityEdges.length < 2) {
    return { l0, communityEdges, l1Assignments: [], l1GroupCount: 0 };
  }

  // Step 4: Build meta-graph from community edges
  const metaEdges: FunctionEdge[] = communityEdges.map((ce) => ({
    sourceHash: ce.sourceCommunity,
    targetHash: ce.targetCommunity,
    edgeType: "call" as const,
    weight: ce.weight,
  }));

  const metaGraph = buildGraph(metaEdges);
  if (metaGraph.order < 3) {
    return { l0, communityEdges, l1Assignments: [], l1GroupCount: 0 };
  }

  // Step 5: Run community detection on meta-graph
  const metaDetector = getDetector(graphConfig.algorithm);
  const metaRaw = metaDetector.detect(metaGraph, {
    resolution: graphConfig.resolution,
    weightAttribute: "weight",
  });
  const metaCommunities = metaRaw.communities;

  // Step 6: Build L1 assignments
  const l1Members = new Map<number, string[]>();
  for (const [communityId, groupId] of Object.entries(metaCommunities)) {
    const members = l1Members.get(groupId) || [];
    members.push(communityId);
    l1Members.set(groupId, members);
  }

  // Dissolve groups with only 1 community (no useful grouping)
  const l1Assignments: CommunityAssignment[] = [];
  let realGroupCount = 0;
  for (const [groupId, members] of l1Members) {
    const isTooSmall = members.length < 2;
    if (!isTooSmall) realGroupCount++;

    for (const communityId of members) {
      l1Assignments.push({
        contentHash: communityId,
        level: 1,
        communityId: isTooSmall ? "__dissolved" : String(groupId),
        algorithm: graphConfig.algorithm,
      });
    }
  }

  // Step 6.5: Stable matching for L1 assignments
  const oldL1Assignments = loadCommunities(db, graphConfig.algorithm, 1);
  const remappedL1 = matchCommunities(oldL1Assignments, l1Assignments);

  // Step 7: Store L1 assignments
  if (remappedL1.length > 0) {
    storeCommunities(db, remappedL1);
  }

  return {
    l0,
    communityEdges,
    l1Assignments: remappedL1,
    l1GroupCount: realGroupCount,
  };
}

// ============ ALGORITHM COMPARISON ============

export const DEFAULT_COMPARISONS: ComparisonConfig[] = [
  { label: "louvain@1.0", algorithm: "louvain", resolution: 1.0 },
  { label: "louvain@1.5", algorithm: "louvain", resolution: 1.5 },
  { label: "louvain@2.0", algorithm: "louvain", resolution: 2.0 },
  { label: "louvain@3.0", algorithm: "louvain", resolution: 3.0 },
  { label: "leiden@1.5", algorithm: "leiden", resolution: 1.5 },
  { label: "leiden@2.0", algorithm: "leiden", resolution: 2.0 },
  { label: "label-propagation", algorithm: "label-propagation", resolution: 0 },
];

/**
 * Compute comparison metrics from a DetectionResult.
 * Pure function -- no DB or side effects.
 */
export function computeComparisonMetrics(
  result: DetectionResult,
  label: string,
  algorithm: string,
  resolution: number | null,
): ComparisonMetrics {
  const totalNodes = result.nodesInGraph;

  // Collect community sizes (excluding dissolved)
  const commSizes = new Map<string, number>();
  for (const a of result.assignments) {
    if (a.communityId === "__dissolved") continue;
    commSizes.set(a.communityId, (commSizes.get(a.communityId) || 0) + 1);
  }

  const sizes = [...commSizes.values()].sort((a, b) => a - b);
  const minSize = sizes.length > 0 ? sizes[0] : 0;
  const maxSize = sizes.length > 0 ? sizes[sizes.length - 1] : 0;
  const medianSize =
    sizes.length > 0
      ? sizes.length % 2 === 1
        ? sizes[Math.floor(sizes.length / 2)]
        : Math.round(
            (sizes[Math.floor(sizes.length / 2) - 1] +
              sizes[Math.floor(sizes.length / 2)]) /
              2,
          )
      : 0;

  const dissolvedPct =
    totalNodes > 0 ? Math.round((result.dissolvedCount / totalNodes) * 100) : 0;
  const coverage =
    totalNodes > 0
      ? Math.round(((totalNodes - result.dissolvedCount) / totalNodes) * 100)
      : 0;

  return {
    label,
    algorithm,
    resolution,
    communityCount: result.communityCount,
    dissolvedCount: result.dissolvedCount,
    dissolvedPct,
    coverage,
    minSize,
    medianSize,
    maxSize,
    modularity: result.modularity,
    nodesInGraph: result.nodesInGraph,
    edgesInGraph: result.edgesInGraph,
  };
}

/**
 * Run community detection at multiple configurations on the same edges.
 * Does NOT write to DB -- pure computation for comparison.
 */
export function runComparison(
  edges: FunctionEdge[],
  baseConfig: GraphConfig,
  configurations: ComparisonConfig[],
  hashToFilePath?: Map<string, string>,
  rootPath?: string,
  allHashes?: Set<string>,
): ComparisonMetrics[] {
  return configurations.map((cfg) => {
    const config: GraphConfig = {
      ...baseConfig,
      algorithm: cfg.algorithm,
      resolution: cfg.resolution,
      autoResolution: false, // explicit resolution for fair comparison
    };
    const result = detectCommunities(
      edges,
      config,
      hashToFilePath,
      rootPath,
      allHashes,
    );
    return computeComparisonMetrics(
      result,
      cfg.label,
      cfg.algorithm,
      cfg.resolution || null,
    );
  });
}
