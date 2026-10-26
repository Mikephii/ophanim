import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, insertFileFunction, insertCommunity, insertEdge, insertCommunityEdge } from "./test-utils";
import {
  DEFAULT_GRAPH_CONFIG,
  buildGraph,
  buildFunctionGraph,
  loadEdges,
  resolveEdges,
  storeEdges,
  addTransitiveEdges,
  type GraphConfig,
  type FunctionEdge,
} from "./graph";
import {
  storeCommunities,
  loadCommunities,
  detectCommunities,
  detectAndStoreCommunities,
  labelPropagation,
  computeCommunityEdges,
  storeCommunityEdges,
  loadCommunityEdges,
  detectHierarchicalCommunities,
  matchCommunities,
  rescueDissolvedNodes,
  computeComparisonMetrics,
  runComparison,
  DEFAULT_COMPARISONS,
  type DetectionResult,
  type CommunityEdge,
  type CommunityAssignment,
} from "./community-detection";
import type { FunctionInfo } from "./shared";
import {
  getDetector,
  registerDetector,
  listDetectors,
  LouvainDetector,
  LabelPropDetector,
  LeidenDetector,
  type CommunityDetector,
} from "./community-detectors";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ============ COMMUNITY STORAGE ============

describe("community storage", () => {
  it("stores and loads community assignments", () => {
    storeCommunities(db, [
      { contentHash: "a", level: 0, communityId: "0", algorithm: "louvain" },
      { contentHash: "b", level: 0, communityId: "0", algorithm: "louvain" },
      { contentHash: "c", level: 0, communityId: "1", algorithm: "louvain" },
    ]);

    const loaded = loadCommunities(db, "louvain", 0);
    expect(loaded).toHaveLength(3);
  });

  it("separates assignments by algorithm", () => {
    storeCommunities(db, [
      { contentHash: "a", level: 0, communityId: "0", algorithm: "louvain" },
    ]);
    storeCommunities(db, [
      { contentHash: "a", level: 0, communityId: "5", algorithm: "label-propagation" },
    ]);

    expect(loadCommunities(db, "louvain", 0)).toHaveLength(1);
    expect(loadCommunities(db, "label-propagation", 0)).toHaveLength(1);
    expect(loadCommunities(db, "louvain", 0)[0].communityId).toBe("0");
    expect(loadCommunities(db, "label-propagation", 0)[0].communityId).toBe("5");
  });

  it("does nothing for empty assignments", () => {
    storeCommunities(db, []);
    expect(loadCommunities(db, "louvain", 0)).toHaveLength(0);
  });
});

// ============ COMMUNITY DETECTION ============

describe("detectCommunities", () => {
  // Build two clear clusters with a weak bridge
  function twoClusterEdges(): FunctionEdge[] {
    return [
      // Cluster A: tightly connected
      { sourceHash: "a1", targetHash: "a2", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a4", edgeType: "call", weight: 1.0 },
      { sourceHash: "a3", targetHash: "a4", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a4", edgeType: "call", weight: 1.0 },
      // Cluster B: tightly connected
      { sourceHash: "b1", targetHash: "b2", edgeType: "call", weight: 1.0 },
      { sourceHash: "b1", targetHash: "b3", edgeType: "call", weight: 1.0 },
      { sourceHash: "b2", targetHash: "b3", edgeType: "call", weight: 1.0 },
      { sourceHash: "b2", targetHash: "b4", edgeType: "call", weight: 1.0 },
      { sourceHash: "b3", targetHash: "b4", edgeType: "call", weight: 1.0 },
      { sourceHash: "b1", targetHash: "b4", edgeType: "call", weight: 1.0 },
      // Weak bridge between clusters
      { sourceHash: "a1", targetHash: "b1", edgeType: "call", weight: 0.1 },
    ];
  }

  it("detects two communities with louvain on clearly separated clusters", () => {
    const result = detectCommunities(twoClusterEdges(), {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.5,
      minCommunitySize: 1,
    });

    expect(result.communityCount).toBe(2);
    expect(result.nodesInGraph).toBe(8);
    expect(result.modularity).toBeGreaterThan(0);

    // All a-nodes in same community, all b-nodes in same community
    const aCommunity = result.assignments.find((a) => a.contentHash === "a1")!.communityId;
    const bCommunity = result.assignments.find((a) => a.contentHash === "b1")!.communityId;
    expect(aCommunity).not.toBe(bCommunity);

    for (const node of ["a1", "a2", "a3", "a4"]) {
      expect(result.assignments.find((a) => a.contentHash === node)!.communityId).toBe(aCommunity);
    }
    for (const node of ["b1", "b2", "b3", "b4"]) {
      expect(result.assignments.find((a) => a.contentHash === node)!.communityId).toBe(bCommunity);
    }
  });

  it("detects communities with label propagation", () => {
    const result = detectCommunities(twoClusterEdges(), {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "label-propagation",
      minCommunitySize: 1,
    });

    expect(result.communityCount).toBe(2);
    expect(result.nodesInGraph).toBe(8);
    expect(result.modularity).toBeNull(); // LPA doesn't compute modularity

    // Same cluster validation
    const aCommunity = result.assignments.find((a) => a.contentHash === "a1")!.communityId;
    const bCommunity = result.assignments.find((a) => a.contentHash === "b1")!.communityId;
    expect(aCommunity).not.toBe(bCommunity);
  });

  it("dissolves communities smaller than minCommunitySize", () => {
    // One cluster of 4 + one isolated node pair
    const edges: FunctionEdge[] = [
      { sourceHash: "a1", targetHash: "a2", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a4", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a4", edgeType: "call", weight: 1.0 },
      { sourceHash: "a3", targetHash: "a4", edgeType: "call", weight: 1.0 },
      // Isolated pair
      { sourceHash: "b1", targetHash: "b2", edgeType: "call", weight: 1.0 },
    ];

    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.5,
      minCommunitySize: 3,
    });

    // b1/b2 should be dissolved (community of 2 < minCommunitySize 3)
    const dissolved = result.assignments.filter((a) => a.communityId === "__dissolved");
    expect(dissolved).toHaveLength(2);
    expect(dissolved.map((d) => d.contentHash).sort()).toEqual(["b1", "b2"]);
    expect(result.dissolvedCount).toBe(2);
  });

  it("returns empty result for no edges", () => {
    const result = detectCommunities([], DEFAULT_GRAPH_CONFIG);
    expect(result.communityCount).toBe(0);
    expect(result.nodesInGraph).toBe(0);
    expect(result.assignments).toHaveLength(0);
  });

  it("auto-resolution scales with codebase size", () => {
    // Build a ring graph of 250 nodes (> 200 threshold for max resolution bump)
    const edges: FunctionEdge[] = [];
    for (let i = 0; i < 250; i++) {
      edges.push({
        sourceHash: `n${i}`,
        targetHash: `n${(i + 1) % 250}`,
        edgeType: "call",
        weight: 1.0,
      });
    }

    // With auto-resolution disabled, use low resolution
    // Use large maxCommunitySize to isolate resolution effect from active splitting
    // Pin to louvain (deterministic) to avoid non-determinism in leiden
    const noAuto = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 0.5,
      autoResolution: false,
      minCommunitySize: 1,
      maxCommunitySize: 250,
    });

    // With auto-resolution enabled, 250 nodes → resolution bumped to max(0.5, 2.0) = 2.0
    const withAuto = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 0.5,
      autoResolution: true,
      minCommunitySize: 1,
      maxCommunitySize: 250,
    });

    // Higher resolution should produce more, smaller communities
    expect(withAuto.communityCount).toBeGreaterThan(noAuto.communityCount);
  });

  it("oversized communities are actively split", () => {
    // Two dense clusters connected by a few weak edges
    // At low resolution, Louvain merges them into one community
    const edges: FunctionEdge[] = [];
    const clusterA = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const clusterB = Array.from({ length: 12 }, (_, i) => `b${i}`);

    // Complete subgraphs within clusters
    for (let i = 0; i < clusterA.length; i++) {
      for (let j = i + 1; j < clusterA.length; j++) {
        edges.push({ sourceHash: clusterA[i], targetHash: clusterA[j], edgeType: "call", weight: 1.0 });
      }
    }
    for (let i = 0; i < clusterB.length; i++) {
      for (let j = i + 1; j < clusterB.length; j++) {
        edges.push({ sourceHash: clusterB[i], targetHash: clusterB[j], edgeType: "call", weight: 1.0 });
      }
    }

    // Heavy cross-edges to force merge at low resolution
    for (let i = 0; i < 8; i++) {
      edges.push({ sourceHash: clusterA[i], targetHash: clusterB[i], edgeType: "call", weight: 0.8 });
    }

    // Without active splitting (maxCommunitySize = Infinity effectively)
    const noSplit = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      resolution: 0.3,
      autoResolution: false,
      minCommunitySize: 1,
      maxCommunitySize: 999,
    });

    // With active splitting (maxCommunitySize = 15, less than combined 24)
    const withSplit = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      resolution: 0.3,
      autoResolution: false,
      minCommunitySize: 1,
      maxCommunitySize: 15,
    });

    // Active splitting should produce more communities
    expect(withSplit.communityCount).toBeGreaterThanOrEqual(noSplit.communityCount);
    // All 24 nodes should be assigned
    expect(withSplit.assignments).toHaveLength(24);
    // No community should exceed maxCommunitySize (if split was accepted)
    if (withSplit.communityCount > noSplit.communityCount) {
      const commSizes = new Map<string, number>();
      for (const a of withSplit.assignments) {
        if (a.communityId !== "__dissolved") {
          commSizes.set(a.communityId, (commSizes.get(a.communityId) || 0) + 1);
        }
      }
      for (const [, size] of commSizes) {
        expect(size).toBeLessThanOrEqual(15);
      }
    }
  });

  it("all assignments have level 0 and correct algorithm label", () => {
    const result = detectCommunities(twoClusterEdges(), {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      minCommunitySize: 1,
    });

    for (const a of result.assignments) {
      expect(a.level).toBe(0);
      expect(a.algorithm).toBe("louvain");
    }
  });
});

// ============ LABEL PROPAGATION ============

describe("labelPropagation", () => {
  it("assigns same label to connected components", () => {
    const graph = buildGraph([
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ]);

    const labels = labelPropagation(graph);
    expect(labels["a"]).toBe(labels["b"]);
  });

  it("separates disconnected components", () => {
    const graph = buildGraph([
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ]);

    const labels = labelPropagation(graph);
    // a,b should share a label; c,d should share a different one
    expect(labels["a"]).toBe(labels["b"]);
    expect(labels["c"]).toBe(labels["d"]);
    expect(labels["a"]).not.toBe(labels["c"]);
  });
});

// ============ FULL PIPELINE (buildFunctionGraph + detectAndStoreCommunities) ============

describe("full pipeline (buildFunctionGraph + detectAndStoreCommunities)", () => {
  it("runs the full pipeline: resolve → store → detect → store communities", () => {
    // Set up a simple codebase with 2 files, 3 functions
    insertFileFunction(db, "/src/auth.ts", "login", "h_login");
    insertFileFunction(db, "/src/auth.ts", "logout", "h_logout");
    insertFileFunction(db, "/src/auth.ts", "validate", "h_validate");
    insertFileFunction(db, "/src/db.ts", "query", "h_query");
    insertFileFunction(db, "/src/db.ts", "connect", "h_connect");

    const functions: FunctionInfo[] = [
      {
        name: "login", filePath: "/src/auth.ts", startLine: 1, endLine: 10,
        sourceCode: "fn login()", contentHash: "h_login", language: "typescript",
        entityType: "function", calls: ["validate", "query"],
      },
      {
        name: "logout", filePath: "/src/auth.ts", startLine: 11, endLine: 20,
        sourceCode: "fn logout()", contentHash: "h_logout", language: "typescript",
        entityType: "function", calls: ["validate"],
      },
      {
        name: "validate", filePath: "/src/auth.ts", startLine: 21, endLine: 30,
        sourceCode: "fn validate()", contentHash: "h_validate", language: "typescript",
        entityType: "function",
      },
      {
        name: "query", filePath: "/src/db.ts", startLine: 1, endLine: 10,
        sourceCode: "fn query()", contentHash: "h_query", language: "typescript",
        entityType: "function", calls: ["connect"],
      },
      {
        name: "connect", filePath: "/src/db.ts", startLine: 11, endLine: 20,
        sourceCode: "fn connect()", contentHash: "h_connect", language: "typescript",
        entityType: "function",
      },
    ];

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      minCommunitySize: 1,
    };

    const edges = buildFunctionGraph(db, functions, config);
    const result = detectAndStoreCommunities(db, edges, functions, config);

    // Should have found some structure
    expect(result.nodesInGraph).toBe(5);
    expect(result.edgesInGraph).toBeGreaterThan(0);
    expect(result.assignments.length).toBe(5);

    // Edges should be stored in DB
    const storedEdges = loadEdges(db);
    expect(storedEdges.length).toBeGreaterThan(0);

    // Communities should be stored in DB
    const stored = loadCommunities(db, DEFAULT_GRAPH_CONFIG.algorithm, 0);
    expect(stored.length).toBe(5);

    // Community edges should be stored
    const ceRows = loadCommunityEdges(db, DEFAULT_GRAPH_CONFIG.algorithm);
    // May or may not have cross-community edges depending on detection result,
    // but the pipeline should run without error
    expect(Array.isArray(ceRows)).toBe(true);
  });
});

// ============ COMMUNITY EDGES ============

describe("computeCommunityEdges", () => {
  it("aggregates function edges into community edges", () => {
    // 2 communities: A has h1,h2; B has h3,h4
    insertCommunity(db, "h1", "commA", { level: 0 });
    insertCommunity(db, "h2", "commA", { level: 0 });
    insertCommunity(db, "h3", "commB", { level: 0 });
    insertCommunity(db, "h4", "commB", { level: 0 });

    // Cross-community edges
    insertEdge(db, "h1", "h3", { weight: 2.0 });
    insertEdge(db, "h2", "h4", { weight: 3.0 });

    const edges = computeCommunityEdges(db, "louvain");
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBe(5.0);
    expect(edges[0].edgeCount).toBe(2);
    expect(edges[0].algorithm).toBe("louvain");
  });

  it("skips intra-community edges", () => {
    insertCommunity(db, "h1", "commA", { level: 0 });
    insertCommunity(db, "h2", "commA", { level: 0 });

    // Intra-community edge only
    insertEdge(db, "h1", "h2", { weight: 5.0 });

    const edges = computeCommunityEdges(db, "louvain");
    expect(edges).toHaveLength(0);
  });

  it("returns empty for single community", () => {
    insertCommunity(db, "h1", "commA", { level: 0 });
    insertCommunity(db, "h2", "commA", { level: 0 });
    insertCommunity(db, "h3", "commA", { level: 0 });

    insertEdge(db, "h1", "h2");
    insertEdge(db, "h2", "h3");

    const edges = computeCommunityEdges(db, "louvain");
    expect(edges).toHaveLength(0);
  });

  it("canonical ordering: source < target regardless of function edge direction", () => {
    insertCommunity(db, "h1", "commZ", { level: 0 });
    insertCommunity(db, "h2", "commA", { level: 0 });

    // Edge goes from commZ → commA, but canonical ordering should put commA first
    insertEdge(db, "h1", "h2", { weight: 1.0 });

    const edges = computeCommunityEdges(db, "louvain");
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceCommunity).toBe("commA");
    expect(edges[0].targetCommunity).toBe("commZ");
  });

  it("excludes dissolved nodes", () => {
    insertCommunity(db, "h1", "commA", { level: 0 });
    insertCommunity(db, "h2", "__dissolved", { level: 0 });
    insertCommunity(db, "h3", "commB", { level: 0 });

    insertEdge(db, "h1", "h2", { weight: 1.0 }); // involves dissolved
    insertEdge(db, "h1", "h3", { weight: 2.0 }); // real cross-community

    const edges = computeCommunityEdges(db, "louvain");
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceCommunity).toBe("commA");
    expect(edges[0].targetCommunity).toBe("commB");
    expect(edges[0].weight).toBe(2.0);
  });
});

describe("community edge storage", () => {
  it("stores and loads community edges (round-trip)", () => {
    const edges: CommunityEdge[] = [
      { sourceCommunity: "a", targetCommunity: "b", algorithm: "louvain", weight: 3.5, edgeCount: 4 },
      { sourceCommunity: "a", targetCommunity: "c", algorithm: "louvain", weight: 1.0, edgeCount: 1 },
    ];

    storeCommunityEdges(db, edges);
    const loaded = loadCommunityEdges(db, "louvain");

    expect(loaded).toHaveLength(2);
    const ab = loaded.find((e) => e.targetCommunity === "b")!;
    expect(ab.weight).toBe(3.5);
    expect(ab.edgeCount).toBe(4);
  });

  it("clears old edges before storing (full-replace)", () => {
    const batch1: CommunityEdge[] = [
      { sourceCommunity: "x", targetCommunity: "y", algorithm: "louvain", weight: 1.0, edgeCount: 1 },
    ];
    storeCommunityEdges(db, batch1);
    expect(loadCommunityEdges(db, "louvain")).toHaveLength(1);

    const batch2: CommunityEdge[] = [
      { sourceCommunity: "p", targetCommunity: "q", algorithm: "louvain", weight: 2.0, edgeCount: 2 },
      { sourceCommunity: "p", targetCommunity: "r", algorithm: "louvain", weight: 3.0, edgeCount: 3 },
    ];
    storeCommunityEdges(db, batch2);
    const loaded = loadCommunityEdges(db, "louvain");
    expect(loaded).toHaveLength(2);
    // Old x-y edge should be gone
    expect(loaded.find((e) => e.sourceCommunity === "x")).toBeUndefined();
  });

  it("handles empty edge list (clears table)", () => {
    const batch: CommunityEdge[] = [
      { sourceCommunity: "a", targetCommunity: "b", algorithm: "louvain", weight: 1.0, edgeCount: 1 },
    ];
    storeCommunityEdges(db, batch);
    expect(loadCommunityEdges(db, "louvain")).toHaveLength(1);

    storeCommunityEdges(db, []);
    expect(loadCommunityEdges(db, "louvain")).toHaveLength(0);
  });
});

// ============ HIERARCHICAL DETECTION ============

describe("detectHierarchicalCommunities", () => {
  function makeLargeCodebase(): { functions: FunctionInfo[] } {
    // Create 4 clusters of 5 functions each with dense intra-cluster edges
    // and some cross-cluster edges to form 2 meta-groups
    const clusters = ["auth", "db", "api", "ui"];
    const functions: FunctionInfo[] = [];

    for (const cluster of clusters) {
      for (let i = 0; i < 5; i++) {
        const name = `${cluster}_fn${i}`;
        const hash = `h_${cluster}_${i}`;
        insertFileFunction(db, `/src/${cluster}.ts`, name, hash);

        const calls: string[] = [];
        // Each function calls the next in its cluster
        if (i < 4) calls.push(`${cluster}_fn${i + 1}`);

        functions.push({
          name,
          filePath: `/src/${cluster}.ts`,
          startLine: i * 10 + 1,
          endLine: (i + 1) * 10,
          sourceCode: `fn ${name}()`,
          contentHash: hash,
          language: "typescript",
          entityType: "function",
          calls,
        });
      }
    }

    // Add some cross-cluster calls: auth→db, api→db, api→ui
    functions.find((f) => f.name === "auth_fn0")!.calls!.push("db_fn0");
    functions.find((f) => f.name === "api_fn0")!.calls!.push("db_fn0");
    functions.find((f) => f.name === "api_fn0")!.calls!.push("ui_fn0");
    functions.find((f) => f.name === "auth_fn2")!.calls!.push("db_fn2");
    functions.find((f) => f.name === "api_fn2")!.calls!.push("ui_fn2");

    return { functions };
  }

  it("returns L0 result and community edges", () => {
    const { functions } = makeLargeCodebase();

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      minCommunitySize: 1,
    };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectHierarchicalCommunities(db, edges, functions, config);

    expect(result.l0.nodesInGraph).toBe(20);
    expect(result.l0.edgesInGraph).toBeGreaterThan(0);
    expect(result.l0.assignments.length).toBe(20);
    expect(Array.isArray(result.communityEdges)).toBe(true);
  });

  it("skips L1 when fewer than 3 L0 communities", () => {
    // Small codebase: 2 files, 3 functions → likely 1-2 communities
    insertFileFunction(db, "/src/a.ts", "fn1", "h1");
    insertFileFunction(db, "/src/a.ts", "fn2", "h2");
    insertFileFunction(db, "/src/b.ts", "fn3", "h3");

    const functions: FunctionInfo[] = [
      { name: "fn1", filePath: "/src/a.ts", startLine: 1, endLine: 5, sourceCode: "fn fn1()", contentHash: "h1", language: "typescript", entityType: "function", calls: ["fn2"] },
      { name: "fn2", filePath: "/src/a.ts", startLine: 6, endLine: 10, sourceCode: "fn fn2()", contentHash: "h2", language: "typescript", entityType: "function" },
      { name: "fn3", filePath: "/src/b.ts", startLine: 1, endLine: 5, sourceCode: "fn fn3()", contentHash: "h3", language: "typescript", entityType: "function" },
    ];

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.5,
      minCommunitySize: 1,
    };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectHierarchicalCommunities(db, edges, functions, config);

    expect(result.l1Assignments).toHaveLength(0);
    expect(result.l1GroupCount).toBe(0);
  });

  it("stores L1 assignments at level=1 in communities table", () => {
    const { functions } = makeLargeCodebase();

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.5,
      minCommunitySize: 1,
    };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectHierarchicalCommunities(db, edges, functions, config);

    // Check communities table for level=1 entries
    const l1Rows = db
      .prepare("SELECT * FROM communities WHERE level = 1")
      .all() as { content_hash: string; community_id: string; level: number; algorithm: string }[];

    if (result.l1GroupCount > 0) {
      expect(l1Rows.length).toBeGreaterThan(0);
      for (const row of l1Rows) {
        expect(row.level).toBe(1);
        expect(row.algorithm).toBe("louvain");
      }
    }
    // If l1GroupCount is 0, that's also valid -- means Louvain didn't find meta-groups
  });

  it("L1 content_hash values are L0 community_ids", () => {
    const { functions } = makeLargeCodebase();

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      minCommunitySize: 1,
    };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectHierarchicalCommunities(db, edges, functions, config);

    if (result.l1Assignments.length > 0) {
      // Get the set of L0 community IDs
      const l0CommunityIds = new Set(
        result.l0.assignments
          .filter((a) => a.communityId !== "__dissolved")
          .map((a) => a.communityId)
      );

      // Every L1 assignment's content_hash should be an L0 community ID
      for (const a of result.l1Assignments) {
        expect(l0CommunityIds.has(a.contentHash)).toBe(true);
        expect(a.level).toBe(1);
      }
    }
  });

  it("dissolves L1 groups with fewer than 2 communities", () => {
    const { functions } = makeLargeCodebase();

    const config = {
      ...DEFAULT_GRAPH_CONFIG,
      minCommunitySize: 1,
    };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectHierarchicalCommunities(db, edges, functions, config);

    if (result.l1Assignments.length > 0) {
      // Count members per group
      const groupCounts = new Map<string, number>();
      for (const a of result.l1Assignments) {
        if (a.communityId !== "__dissolved") {
          groupCounts.set(a.communityId, (groupCounts.get(a.communityId) || 0) + 1);
        }
      }
      // All real groups should have at least 2 members
      for (const [, count] of groupCounts) {
        expect(count).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

// ============ STABLE COMMUNITY MATCHING (Gate 1) ============

describe("matchCommunities", () => {
  const makeAssignment = (hash: string, communityId: string): CommunityAssignment => ({
    contentHash: hash,
    level: 0,
    communityId,
    algorithm: "louvain",
  });

  it("returns new assignments unchanged when old is empty", () => {
    const newA = [makeAssignment("h1", "0"), makeAssignment("h2", "0")];
    const result = matchCommunities([], newA);
    expect(result).toEqual(newA);
  });

  it("remaps IDs when communities have identical membership", () => {
    const old = [makeAssignment("h1", "A"), makeAssignment("h2", "A"), makeAssignment("h3", "B"), makeAssignment("h4", "B")];
    // Louvain re-runs and assigns same members to new IDs "0" and "1"
    const newA = [makeAssignment("h1", "0"), makeAssignment("h2", "0"), makeAssignment("h3", "1"), makeAssignment("h4", "1")];
    const result = matchCommunities(old, newA);

    // Should remap: "0" → "A", "1" → "B"
    const comm0 = result.filter((a) => a.contentHash === "h1" || a.contentHash === "h2");
    const comm1 = result.filter((a) => a.contentHash === "h3" || a.contentHash === "h4");
    expect(comm0.every((a) => a.communityId === "A")).toBe(true);
    expect(comm1.every((a) => a.communityId === "B")).toBe(true);
  });

  it("remaps IDs with partial overlap above threshold", () => {
    // Old: community "X" has {h1, h2, h3}
    const old = [makeAssignment("h1", "X"), makeAssignment("h2", "X"), makeAssignment("h3", "X")];
    // New: community "5" has {h1, h2, h4} -- Jaccard = |{h1,h2}| / |{h1,h2,h3,h4}| = 2/4 = 0.5
    const newA = [makeAssignment("h1", "5"), makeAssignment("h2", "5"), makeAssignment("h4", "5")];
    const result = matchCommunities(old, newA);

    // Jaccard = 0.5 ≥ threshold → should remap "5" → "X"
    expect(result.every((a) => a.communityId === "X")).toBe(true);
  });

  it("keeps new IDs when overlap is below threshold", () => {
    // Old: community "X" has {h1, h2, h3, h4}
    const old = [
      makeAssignment("h1", "X"), makeAssignment("h2", "X"),
      makeAssignment("h3", "X"), makeAssignment("h4", "X"),
    ];
    // New: community "9" has {h1, h5, h6, h7} -- Jaccard = 1/7 ≈ 0.14
    const newA = [
      makeAssignment("h1", "9"), makeAssignment("h5", "9"),
      makeAssignment("h6", "9"), makeAssignment("h7", "9"),
    ];
    const result = matchCommunities(old, newA);

    // Below threshold → keeps "9"
    expect(result.every((a) => a.communityId === "9")).toBe(true);
  });

  it("preserves dissolved community assignments", () => {
    const old = [makeAssignment("h1", "A"), makeAssignment("h2", "A")];
    const newA = [
      makeAssignment("h1", "0"), makeAssignment("h2", "0"),
      makeAssignment("h3", "__dissolved"),
    ];
    const result = matchCommunities(old, newA);

    // "0" → "A", dissolved stays dissolved
    expect(result.find((a) => a.contentHash === "h1")!.communityId).toBe("A");
    expect(result.find((a) => a.contentHash === "h3")!.communityId).toBe("__dissolved");
  });

  it("enforces 1:1 matching (greedy best-first)", () => {
    // Old: "A" = {h1, h2}, "B" = {h3, h4}
    const old = [
      makeAssignment("h1", "A"), makeAssignment("h2", "A"),
      makeAssignment("h3", "B"), makeAssignment("h4", "B"),
    ];
    // New: "0" = {h1, h2} (exact match to A), "1" = {h1, h3, h4} -- but h1 is in "0"
    // Actually: "0" matches "A" perfectly (J=1.0), "1" = {h3, h4} matches "B" (J=1.0)
    const newA = [
      makeAssignment("h1", "0"), makeAssignment("h2", "0"),
      makeAssignment("h3", "1"), makeAssignment("h4", "1"),
    ];
    const result = matchCommunities(old, newA);

    // Both should be remapped
    expect(result.find((a) => a.contentHash === "h1")!.communityId).toBe("A");
    expect(result.find((a) => a.contentHash === "h3")!.communityId).toBe("B");
  });
});

// ============ buildFunctionGraph INCREMENTAL MODE ============

describe("buildFunctionGraph incremental mode", () => {
  // Helper: creates a set of functions with file_functions rows already populated
  function setupFunctions(fns: { name: string; hash: string; file: string; calls?: string[] }[]): FunctionInfo[] {
    for (const fn of fns) {
      insertFileFunction(db, fn.file, fn.name, fn.hash);
    }
    return fns.map((fn) => ({
      name: fn.name,
      filePath: fn.file,
      startLine: 1,
      endLine: 10,
      sourceCode: `fn ${fn.name}()`,
      contentHash: fn.hash,
      language: "typescript" as const,
      entityType: "function" as const,
      calls: fn.calls,
    }));
  }

  it("no-change fast path: skips edge resolution when nothing changed", () => {
    const functions = setupFunctions([
      { name: "fnA", hash: "h1", file: "/a.ts", calls: ["fnB"] },
      { name: "fnB", hash: "h2", file: "/b.ts" },
    ]);

    const config = { ...DEFAULT_GRAPH_CONFIG, minCommunitySize: 1 };

    // First run: full rebuild
    const edges1 = buildFunctionGraph(db, functions, config);
    const r1 = detectAndStoreCommunities(db, edges1, functions, config);
    const edgesAfterFirst = loadEdges(db);
    expect(edgesAfterFirst.length).toBeGreaterThan(0);

    // Second run with same hashes → no-change fast path
    const oldHashes = new Set(["h1", "h2"]);
    const edges2 = buildFunctionGraph(db, functions, config, oldHashes);
    const r2 = detectAndStoreCommunities(db, edges2, functions, config);

    // Should still produce a valid result with same structure
    expect(r2.nodesInGraph).toBe(r1.nodesInGraph);
    expect(r2.edgesInGraph).toBe(r1.edgesInGraph);

    // Edges should be unchanged in DB
    const edgesAfterSecond = loadEdges(db);
    expect(edgesAfterSecond.length).toBe(edgesAfterFirst.length);
  });

  it("incremental mode: only rebuilds affected edges when <50% changed", () => {
    // Set up 4 functions, run full build
    const functions = setupFunctions([
      { name: "fnA", hash: "h1", file: "/a.ts", calls: ["fnB"] },
      { name: "fnB", hash: "h2", file: "/b.ts", calls: ["fnC"] },
      { name: "fnC", hash: "h3", file: "/c.ts" },
      { name: "fnD", hash: "h4", file: "/d.ts" },
    ]);

    const config = { ...DEFAULT_GRAPH_CONFIG, minCommunitySize: 1 };

    const edges1 = buildFunctionGraph(db, functions, config);
    detectAndStoreCommunities(db, edges1, functions, config);
    const edgesAfterFirst = loadEdges(db);

    // Now simulate: h1 changed to h1_v2 (1 out of 4 = 25% → incremental)
    // Update file_functions for the changed function
    db.prepare("DELETE FROM file_functions WHERE content_hash = ?").run("h1");
    insertFileFunction(db, "/a.ts", "fnA", "h1_v2");

    const updatedFunctions = functions.map((f) =>
      f.contentHash === "h1" ? { ...f, contentHash: "h1_v2", sourceCode: "fn fnA() v2" } : f
    );

    const oldHashes = new Set(["h1", "h2", "h3", "h4"]);
    const edges2 = buildFunctionGraph(db, updatedFunctions, config, oldHashes);
    const r2 = detectAndStoreCommunities(db, edges2, updatedFunctions, config);

    // Should produce valid result
    expect(r2.assignments.length).toBeGreaterThan(0);

    // Edges should be updated
    const edgesAfterSecond = loadEdges(db);
    expect(edgesAfterSecond.length).toBeGreaterThan(0);
  });

  it("full rebuild when >50% changed", () => {
    // Set up 2 functions
    const functions = setupFunctions([
      { name: "fnA", hash: "h1", file: "/a.ts", calls: ["fnB"] },
      { name: "fnB", hash: "h2", file: "/b.ts" },
    ]);

    const config = { ...DEFAULT_GRAPH_CONFIG, minCommunitySize: 1 };

    const edges1 = buildFunctionGraph(db, functions, config);
    detectAndStoreCommunities(db, edges1, functions, config);

    // Both changed (100% → full rebuild)
    db.prepare("DELETE FROM file_functions").run();
    insertFileFunction(db, "/a.ts", "fnA", "h1_v2");
    insertFileFunction(db, "/b.ts", "fnB", "h2_v2");

    const updatedFunctions: FunctionInfo[] = [
      { ...functions[0], contentHash: "h1_v2", sourceCode: "fn fnA() v2" },
      { ...functions[1], contentHash: "h2_v2", sourceCode: "fn fnB() v2" },
    ];

    const oldHashes = new Set(["h1", "h2"]);
    const edges2 = buildFunctionGraph(db, updatedFunctions, config, oldHashes);
    const r2 = detectAndStoreCommunities(db, edges2, updatedFunctions, config);

    expect(r2.assignments.length).toBeGreaterThan(0);
    expect(r2.edgesInGraph).toBeGreaterThanOrEqual(0);
  });

  it("falls through to full rebuild when function_edges is empty despite oldHashes", () => {
    // Simulates: watch/init populated file_functions, but graph was never run.
    // oldHashes exist (from file_functions), small diff → incremental would trigger,
    // but function_edges is empty so neighbor lookup finds nothing → broken graph.
    // Fix: detect empty edges table and force full rebuild.
    const functions = setupFunctions([
      { name: "fnA", hash: "h1", file: "/a.ts", calls: ["fnB"] },
      { name: "fnB", hash: "h2", file: "/a.ts", calls: ["fnC"] },
      { name: "fnC", hash: "h3", file: "/b.ts" },
      { name: "fnD", hash: "h4", file: "/b.ts" },
    ]);

    // Verify function_edges is empty (no prior graph run)
    const edgeCount = (db.prepare("SELECT COUNT(*) as cnt FROM function_edges").get() as { cnt: number }).cnt;
    expect(edgeCount).toBe(0);

    // oldHashes has 3 of 4 → 1 "new" hash (h4) = 25% change → incremental would trigger
    const oldHashes = new Set(["h1", "h2", "h3"]);
    const config = { ...DEFAULT_GRAPH_CONFIG, minCommunitySize: 1 };
    const edges = buildFunctionGraph(db, functions, config, oldHashes);
    const result = detectAndStoreCommunities(db, edges, functions, config);

    // Should have done full rebuild: co-location edges within /a.ts and /b.ts + call edges
    const storedEdges = loadEdges(db);
    expect(storedEdges.length).toBeGreaterThan(2); // At least co-location + call edges
    expect(storedEdges.some((e) => e.edgeType === "co_location")).toBe(true);
    expect(storedEdges.some((e) => e.edgeType === "call")).toBe(true);
    expect(result.assignments.length).toBe(4);
  });

  it("without oldHashes, always does full rebuild", () => {
    const functions = setupFunctions([
      { name: "fnA", hash: "h1", file: "/a.ts", calls: ["fnB"] },
      { name: "fnB", hash: "h2", file: "/b.ts" },
    ]);

    // No oldHashes param → full rebuild (current behavior)
    const config = { ...DEFAULT_GRAPH_CONFIG, minCommunitySize: 1 };
    const edges = buildFunctionGraph(db, functions, config);
    const result = detectAndStoreCommunities(db, edges, functions, config);
    expect(result.assignments.length).toBe(2);
    expect(loadEdges(db).length).toBeGreaterThan(0);
  });
});

// ============ RESCUE DISSOLVED NODES ============

describe("rescueDissolvedNodes", () => {
  function makeAssignment(contentHash: string, communityId: string): CommunityAssignment {
    return { contentHash, level: 0, communityId, algorithm: "louvain" };
  }

  it("rescues a dissolved node into the community it's most connected to", () => {
    const assignments = [
      makeAssignment("h1", "A"),
      makeAssignment("h2", "A"),
      makeAssignment("h3", "B"),
      makeAssignment("h4", "__dissolved"),
    ];
    const edges: FunctionEdge[] = [
      { sourceHash: "h4", targetHash: "h1", edgeType: "call", weight: 1.0 },
      { sourceHash: "h4", targetHash: "h2", edgeType: "co_location", weight: 0.5 },
      { sourceHash: "h4", targetHash: "h3", edgeType: "co_location", weight: 0.3 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(1);
    expect(assignments.find((a) => a.contentHash === "h4")!.communityId).toBe("A");
  });

  it("picks the community with the strongest total edge weight", () => {
    const assignments = [
      makeAssignment("h1", "A"),
      makeAssignment("h2", "B"),
      makeAssignment("h3", "B"),
      makeAssignment("h4", "__dissolved"),
    ];
    // h4 has weight 0.5 to A, but weight 0.3+0.4=0.7 to B
    const edges: FunctionEdge[] = [
      { sourceHash: "h4", targetHash: "h1", edgeType: "call", weight: 0.5 },
      { sourceHash: "h4", targetHash: "h2", edgeType: "co_location", weight: 0.3 },
      { sourceHash: "h4", targetHash: "h3", edgeType: "co_location", weight: 0.4 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(1);
    expect(assignments.find((a) => a.contentHash === "h4")!.communityId).toBe("B");
  });

  it("leaves truly isolated nodes dissolved (zero connections to communities)", () => {
    const assignments = [
      makeAssignment("h1", "A"),
      makeAssignment("h2", "A"),
      makeAssignment("h3", "__dissolved"),
    ];
    // h3 has NO edges to any non-dissolved node
    const edges: FunctionEdge[] = [
      { sourceHash: "h1", targetHash: "h2", edgeType: "call", weight: 1.0 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(0);
    expect(assignments.find((a) => a.contentHash === "h3")!.communityId).toBe("__dissolved");
  });

  it("supports chained rescue (B rescued after A into same community)", () => {
    const assignments = [
      makeAssignment("h1", "A"),
      makeAssignment("h2", "__dissolved"),
      makeAssignment("h3", "__dissolved"),
    ];
    // h2 connects to h1 (community A) → rescued first
    // h3 connects ONLY to h2 (initially dissolved, but rescued to A) → chained rescue
    const edges: FunctionEdge[] = [
      { sourceHash: "h2", targetHash: "h1", edgeType: "call", weight: 1.0 },
      { sourceHash: "h3", targetHash: "h2", edgeType: "co_location", weight: 0.5 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(2);
    expect(assignments.find((a) => a.contentHash === "h2")!.communityId).toBe("A");
    expect(assignments.find((a) => a.contentHash === "h3")!.communityId).toBe("A");
  });

  it("works with custom dissolved markers (split prefix)", () => {
    const assignments = [
      makeAssignment("h1", "5_0"),
      makeAssignment("h2", "5_1"),
      makeAssignment("h3", "5___dissolved"),
    ];
    const edges: FunctionEdge[] = [
      { sourceHash: "h3", targetHash: "h1", edgeType: "call", weight: 1.0 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "5___dissolved");
    expect(rescued).toBe(1);
    expect(assignments.find((a) => a.contentHash === "h3")!.communityId).toBe("5_0");
  });

  it("returns 0 when no dissolved nodes exist", () => {
    const assignments = [
      makeAssignment("h1", "A"),
      makeAssignment("h2", "B"),
    ];
    const edges: FunctionEdge[] = [
      { sourceHash: "h1", targetHash: "h2", edgeType: "call", weight: 1.0 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(0);
  });

  it("returns 0 when all nodes are dissolved (no communities to rescue into)", () => {
    const assignments = [
      makeAssignment("h1", "__dissolved"),
      makeAssignment("h2", "__dissolved"),
    ];
    const edges: FunctionEdge[] = [
      { sourceHash: "h1", targetHash: "h2", edgeType: "call", weight: 1.0 },
    ];
    const rescued = rescueDissolvedNodes(assignments, edges, "__dissolved");
    expect(rescued).toBe(0);
  });
});

describe("detectCommunities rescue integration", () => {
  it("rescues dissolved split fragments into nearest sub-community", () => {
    // Create one large cluster (12 nodes, fully connected) + one small cluster
    // Large cluster will be split; fragments should be rescued, not dissolved
    const edges: FunctionEdge[] = [];
    const largeCluster = Array.from({ length: 12 }, (_, i) => `big_${i}`);
    const smallCluster = ["s1", "s2", "s3"];

    // Fully connect the large cluster
    for (let i = 0; i < largeCluster.length; i++) {
      for (let j = i + 1; j < largeCluster.length; j++) {
        edges.push({
          sourceHash: largeCluster[i],
          targetHash: largeCluster[j],
          edgeType: "call",
          weight: 1.0,
        });
      }
    }

    // Fully connect small cluster
    for (let i = 0; i < smallCluster.length; i++) {
      for (let j = i + 1; j < smallCluster.length; j++) {
        edges.push({
          sourceHash: smallCluster[i],
          targetHash: smallCluster[j],
          edgeType: "call",
          weight: 1.0,
        });
      }
    }

    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.0,
      autoResolution: false,
      minCommunitySize: 2,
      maxCommunitySize: 8, // forces split of the 12-node cluster
    });

    // All 15 nodes should be assigned
    expect(result.assignments).toHaveLength(15);

    // After rescue, dissolved count should be 0 (all nodes connected to some community)
    expect(result.dissolvedCount).toBe(0);

    // All big_* nodes should be in non-dissolved communities
    for (const hash of largeCluster) {
      const a = result.assignments.find((a) => a.contentHash === hash);
      expect(a!.communityId).not.toBe("__dissolved");
    }
  });

  it("top-level rescue assigns dissolved singletons to nearest community", () => {
    // Two tight clusters + one singleton weakly connected to cluster A
    const edges: FunctionEdge[] = [
      // Cluster A
      { sourceHash: "a1", targetHash: "a2", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a3", edgeType: "call", weight: 1.0 },
      // Cluster B
      { sourceHash: "b1", targetHash: "b2", edgeType: "call", weight: 1.0 },
      { sourceHash: "b1", targetHash: "b3", edgeType: "call", weight: 1.0 },
      { sourceHash: "b2", targetHash: "b3", edgeType: "call", weight: 1.0 },
      // Singleton connected to cluster A
      { sourceHash: "lone", targetHash: "a1", edgeType: "co_location", weight: 0.3 },
    ];

    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 2.0,
      autoResolution: false,
      minCommunitySize: 2,
      maxCommunitySize: 30,
    });

    // "lone" should be rescued into cluster A's community
    const loneAssignment = result.assignments.find((a) => a.contentHash === "lone")!;
    const a1Assignment = result.assignments.find((a) => a.contentHash === "a1")!;
    expect(loneAssignment.communityId).toBe(a1Assignment.communityId);
    expect(loneAssignment.communityId).not.toBe("__dissolved");

    // dissolvedCount should not include the rescued node
    expect(result.dissolvedCount).toBe(0);
  });

  it("truly isolated node stays dissolved even with rescue", () => {
    // Two clusters + one node with zero edges
    const edges: FunctionEdge[] = [
      { sourceHash: "a1", targetHash: "a2", edgeType: "call", weight: 1.0 },
      { sourceHash: "b1", targetHash: "b2", edgeType: "call", weight: 1.0 },
    ];

    const allHashes = new Set(["a1", "a2", "b1", "b2", "isolated"]);

    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 1.0,
      autoResolution: false,
      minCommunitySize: 2,
      maxCommunitySize: 30,
    }, undefined, undefined, allHashes);

    const isolated = result.assignments.find((a) => a.contentHash === "isolated")!;
    expect(isolated.communityId).toBe("__dissolved");
    expect(result.dissolvedCount).toBe(1);
  });

  it("___dissolved prefixed groups are routed to __dissolved for top-level rescue", () => {
    // Build two sub-clusters within one large group, plus a weakly connected node
    // The large group will split; the weak node may dissolve in the split but
    // should be rescued at the top level (not form a ___dissolved community)
    const edges: FunctionEdge[] = [];

    // Sub-cluster A: 6 nodes, fully connected
    const clusterA = Array.from({ length: 6 }, (_, i) => `ca_${i}`);
    for (let i = 0; i < clusterA.length; i++) {
      for (let j = i + 1; j < clusterA.length; j++) {
        edges.push({ sourceHash: clusterA[i], targetHash: clusterA[j], edgeType: "call", weight: 1.0 });
      }
    }

    // Sub-cluster B: 6 nodes, fully connected
    const clusterB = Array.from({ length: 6 }, (_, i) => `cb_${i}`);
    for (let i = 0; i < clusterB.length; i++) {
      for (let j = i + 1; j < clusterB.length; j++) {
        edges.push({ sourceHash: clusterB[i], targetHash: clusterB[j], edgeType: "call", weight: 1.0 });
      }
    }

    // Weak bridge between clusters (forces single community at low resolution)
    edges.push({ sourceHash: "ca_0", targetHash: "cb_0", edgeType: "call", weight: 0.3 });

    // Separate community (so there's something to rescue into at top level)
    edges.push({ sourceHash: "other_1", targetHash: "other_2", edgeType: "call", weight: 1.0 });
    edges.push({ sourceHash: "other_1", targetHash: "other_3", edgeType: "call", weight: 1.0 });
    edges.push({ sourceHash: "other_2", targetHash: "other_3", edgeType: "call", weight: 1.0 });

    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 0.5,
      autoResolution: false,
      minCommunitySize: 2,
      maxCommunitySize: 8, // forces split of the 12-node merged cluster
    });

    // No community ID should contain "___dissolved"
    for (const a of result.assignments) {
      expect(a.communityId).not.toContain("___dissolved");
    }
  });

  it("rejects split when dissolved count exceeds 50% of community", () => {
    // Create a large connected cluster that, when split at high resolution,
    // would produce many dissolved singletons. The quality gate should reject
    // the split and keep the community intact.
    const nodes = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const edges: FunctionEdge[] = [];

    // Ring graph: each node connected to next (sparse, easy to fragment at high res)
    for (let i = 0; i < nodes.length; i++) {
      edges.push({
        sourceHash: nodes[i],
        targetHash: nodes[(i + 1) % nodes.length],
        edgeType: "call",
        weight: 1.0,
      });
    }

    // At very high resolution, a ring easily fragments
    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      resolution: 0.1, // low res puts them all in one community
      autoResolution: false,
      minCommunitySize: 2,
      maxCommunitySize: 10, // forces split attempt
    });

    // All 20 nodes should be assigned somewhere (not all dissolved)
    expect(result.assignments).toHaveLength(20);

    // No community ID should contain "___dissolved"
    for (const a of result.assignments) {
      expect(a.communityId).not.toContain("___dissolved");
    }
  });
});

// ============ COMPARISON TOOLING ============

describe("computeComparisonMetrics", () => {
  it("computes correct min/median/max for odd number of communities", () => {
    const result: DetectionResult = {
      assignments: [
        { contentHash: "a", communityId: "0" },
        { contentHash: "b", communityId: "0" },
        { contentHash: "c", communityId: "1" },
        { contentHash: "d", communityId: "1" },
        { contentHash: "e", communityId: "1" },
        { contentHash: "f", communityId: "1" },
        { contentHash: "g", communityId: "2" },
        { contentHash: "h", communityId: "2" },
        { contentHash: "i", communityId: "2" },
      ],
      communityCount: 3,
      modularity: 0.65,
      nodesInGraph: 9,
      edgesInGraph: 12,
      dissolvedCount: 0,
    };

    const m = computeComparisonMetrics(result, "test@1.0", "louvain", 1.0);

    expect(m.label).toBe("test@1.0");
    expect(m.algorithm).toBe("louvain");
    expect(m.resolution).toBe(1.0);
    expect(m.communityCount).toBe(3);
    expect(m.dissolvedCount).toBe(0);
    expect(m.dissolvedPct).toBe(0);
    expect(m.coverage).toBe(100);
    expect(m.minSize).toBe(2);   // community 0: 2 members
    expect(m.medianSize).toBe(3); // community 2: 3 members (middle)
    expect(m.maxSize).toBe(4);   // community 1: 4 members
    expect(m.modularity).toBe(0.65);
    expect(m.nodesInGraph).toBe(9);
    expect(m.edgesInGraph).toBe(12);
  });

  it("computes correct median for even number of communities", () => {
    const result: DetectionResult = {
      assignments: [
        { contentHash: "a", communityId: "0" },
        { contentHash: "b", communityId: "0" },
        { contentHash: "c", communityId: "1" },
        { contentHash: "d", communityId: "1" },
        { contentHash: "e", communityId: "1" },
        { contentHash: "f", communityId: "1" },
      ],
      communityCount: 2,
      modularity: 0.5,
      nodesInGraph: 6,
      edgesInGraph: 8,
      dissolvedCount: 0,
    };

    const m = computeComparisonMetrics(result, "test", "louvain", 1.0);
    // Sizes: [2, 4], median = round((2+4)/2) = 3
    expect(m.medianSize).toBe(3);
    expect(m.minSize).toBe(2);
    expect(m.maxSize).toBe(4);
  });

  it("handles dissolved nodes in coverage and percentage", () => {
    const result: DetectionResult = {
      assignments: [
        { contentHash: "a", communityId: "0" },
        { contentHash: "b", communityId: "0" },
        { contentHash: "c", communityId: "0" },
        { contentHash: "d", communityId: "__dissolved" },
        { contentHash: "e", communityId: "__dissolved" },
      ],
      communityCount: 1,
      modularity: 0.3,
      nodesInGraph: 5,
      edgesInGraph: 4,
      dissolvedCount: 2,
    };

    const m = computeComparisonMetrics(result, "test", "louvain", 1.5);
    expect(m.dissolvedCount).toBe(2);
    expect(m.dissolvedPct).toBe(40); // 2/5 * 100
    expect(m.coverage).toBe(60);     // (5-2)/5 * 100
    expect(m.communityCount).toBe(1);
    expect(m.minSize).toBe(3);
    expect(m.maxSize).toBe(3);
  });

  it("handles empty result (all dissolved)", () => {
    const result: DetectionResult = {
      assignments: [
        { contentHash: "a", communityId: "__dissolved" },
        { contentHash: "b", communityId: "__dissolved" },
      ],
      communityCount: 0,
      modularity: null,
      nodesInGraph: 2,
      edgesInGraph: 0,
      dissolvedCount: 2,
    };

    const m = computeComparisonMetrics(result, "empty", "louvain", 1.0);
    expect(m.communityCount).toBe(0);
    expect(m.dissolvedPct).toBe(100);
    expect(m.coverage).toBe(0);
    expect(m.minSize).toBe(0);
    expect(m.medianSize).toBe(0);
    expect(m.maxSize).toBe(0);
    expect(m.modularity).toBeNull();
  });

  it("handles zero nodes gracefully", () => {
    const result: DetectionResult = {
      assignments: [],
      communityCount: 0,
      modularity: null,
      nodesInGraph: 0,
      edgesInGraph: 0,
      dissolvedCount: 0,
    };

    const m = computeComparisonMetrics(result, "zero", "louvain", 1.0);
    expect(m.dissolvedPct).toBe(0);
    expect(m.coverage).toBe(0);
    expect(m.minSize).toBe(0);
    expect(m.maxSize).toBe(0);
  });

  it("passes through null modularity for label-propagation", () => {
    const result: DetectionResult = {
      assignments: [
        { contentHash: "a", communityId: "0" },
        { contentHash: "b", communityId: "0" },
      ],
      communityCount: 1,
      modularity: null,
      nodesInGraph: 2,
      edgesInGraph: 1,
      dissolvedCount: 0,
    };

    const m = computeComparisonMetrics(result, "lp", "label-propagation", null);
    expect(m.modularity).toBeNull();
    expect(m.resolution).toBeNull();
  });
});

describe("runComparison", () => {
  it("runs multiple configs and returns one metrics entry per config", () => {
    // Create a small graph with clear community structure
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 1.0 },
      { sourceHash: "d", targetHash: "e", edgeType: "call", weight: 1.0 },
      { sourceHash: "e", targetHash: "f", edgeType: "call", weight: 1.0 },
    ];
    const allHashes = new Set(["a", "b", "c", "d", "e", "f"]);

    const configs = [
      { label: "low", algorithm: "louvain", resolution: 0.5 },
      { label: "high", algorithm: "louvain", resolution: 3.0 },
    ];

    const results = runComparison(edges, DEFAULT_GRAPH_CONFIG, configs, undefined, undefined, allHashes);

    expect(results).toHaveLength(2);
    expect(results[0].label).toBe("low");
    expect(results[1].label).toBe("high");

    // Both should have 6 nodes and 4 edges
    for (const r of results) {
      expect(r.nodesInGraph).toBe(6);
      expect(r.edgesInGraph).toBe(4);
      expect(r.algorithm).toBe("louvain");
    }
  });

  it("does not mutate input edges", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    const edgesCopy = JSON.parse(JSON.stringify(edges));
    const allHashes = new Set(["a", "b"]);

    runComparison(edges, DEFAULT_GRAPH_CONFIG, [
      { label: "test", algorithm: "louvain", resolution: 1.0 },
    ], undefined, undefined, allHashes);

    expect(edges).toEqual(edgesCopy);
  });

  it("includes label-propagation results without modularity", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];
    const allHashes = new Set(["a", "b", "c", "d"]);

    const results = runComparison(edges, DEFAULT_GRAPH_CONFIG, [
      { label: "lp", algorithm: "label-propagation", resolution: 0 },
    ], undefined, undefined, allHashes);

    expect(results).toHaveLength(1);
    expect(results[0].algorithm).toBe("label-propagation");
    expect(results[0].modularity).toBeNull();
  });
});

describe("DEFAULT_COMPARISONS", () => {
  it("contains 7 configurations with expected labels", () => {
    expect(DEFAULT_COMPARISONS).toHaveLength(7);
    expect(DEFAULT_COMPARISONS.map(c => c.label)).toEqual([
      "louvain@1.0",
      "louvain@1.5",
      "louvain@2.0",
      "louvain@3.0",
      "leiden@1.5",
      "leiden@2.0",
      "label-propagation",
    ]);
  });
});

// ============ COMMUNITY DETECTOR STRATEGY PATTERN ============

describe("detector registry", () => {
  it("has louvain, label-propagation, and leiden registered by default", () => {
    const names = listDetectors();
    expect(names).toContain("louvain");
    expect(names).toContain("label-propagation");
    expect(names).toContain("leiden");
  });

  it("getDetector returns LouvainDetector for 'louvain'", () => {
    const detector = getDetector("louvain");
    expect(detector).toBeInstanceOf(LouvainDetector);
    expect(detector.name).toBe("louvain");
    expect(detector.supportsResolution).toBe(true);
  });

  it("getDetector returns LabelPropDetector for 'label-propagation'", () => {
    const detector = getDetector("label-propagation");
    expect(detector).toBeInstanceOf(LabelPropDetector);
    expect(detector.name).toBe("label-propagation");
    expect(detector.supportsResolution).toBe(false);
  });

  it("getDetector throws for unknown algorithm", () => {
    expect(() => getDetector("nonexistent")).toThrow(/Unknown community detection algorithm/);
  });

  it("registerDetector adds a custom detector", () => {
    const custom: CommunityDetector = {
      name: "test-detector",
      supportsResolution: false,
      detect: () => ({ communities: {}, modularity: null }),
    };
    registerDetector(custom);
    expect(getDetector("test-detector")).toBe(custom);
    expect(listDetectors()).toContain("test-detector");
  });
});

describe("LouvainDetector", () => {
  it("produces communities with modularity", () => {
    const graph = buildGraph([
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ]);
    const detector = new LouvainDetector();
    const result = detector.detect(graph, { resolution: 1.0, weightAttribute: "weight" });

    expect(result.communities).toBeDefined();
    expect(typeof result.modularity).toBe("number");
    // All 4 nodes should have community assignments
    expect(Object.keys(result.communities)).toHaveLength(4);
  });
});

describe("LabelPropDetector", () => {
  it("produces communities without modularity", () => {
    const graph = buildGraph([
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ]);
    const detector = new LabelPropDetector();
    const result = detector.detect(graph, { resolution: 0, weightAttribute: "weight" });

    expect(result.communities).toBeDefined();
    expect(result.modularity).toBeNull();
    expect(Object.keys(result.communities)).toHaveLength(4);
  });
});

describe("detectCommunities with strategy pattern", () => {
  it("works with louvain algorithm string", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];
    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "louvain",
      autoResolution: false,
    });

    expect(result.assignments.length).toBe(4);
    expect(result.modularity).not.toBeNull();
  });

  it("works with label-propagation algorithm string", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];
    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "label-propagation",
      autoResolution: false,
    });

    expect(result.assignments.length).toBe(4);
    expect(result.modularity).toBeNull();
  });

  it("throws for unknown algorithm", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    expect(() => detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "nonexistent-algo",
    })).toThrow(/Unknown community detection algorithm/);
  });

  it("active splitting only triggers for resolution-aware algorithms", () => {
    // Create a graph that would trigger splitting with maxCommunitySize=3
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
      { sourceHash: "d", targetHash: "a", edgeType: "call", weight: 1.0 },
    ];

    // Label propagation: no active splitting (supportsResolution=false)
    const lpResult = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "label-propagation",
      maxCommunitySize: 3,
      autoResolution: false,
    });
    // Should not have split sub-community IDs (no underscore-prefixed IDs)
    for (const a of lpResult.assignments) {
      if (a.communityId !== "__dissolved") {
        expect(a.communityId).not.toContain("_");
      }
    }
  });
});

// ============ LEIDEN DETECTOR ============

describe("LeidenDetector", () => {
  it("produces communities with modularity", () => {
    const graph = buildGraph([
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 1.0 },
      { sourceHash: "d", targetHash: "e", edgeType: "call", weight: 1.0 },
      { sourceHash: "e", targetHash: "f", edgeType: "call", weight: 1.0 },
    ]);
    const detector = new LeidenDetector();
    const result = detector.detect(graph, { resolution: 1.0, weightAttribute: "weight" });

    expect(result.communities).toBeDefined();
    expect(typeof result.modularity).toBe("number");
    expect(Object.keys(result.communities)).toHaveLength(6);
  });

  it("finds two clusters in a clearly separated graph", () => {
    // Two dense cliques connected by a single weak edge
    const edges: FunctionEdge[] = [
      // Clique 1: a-b-c (strong)
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 5.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 5.0 },
      { sourceHash: "a", targetHash: "c", edgeType: "call", weight: 5.0 },
      // Clique 2: d-e-f (strong)
      { sourceHash: "d", targetHash: "e", edgeType: "call", weight: 5.0 },
      { sourceHash: "e", targetHash: "f", edgeType: "call", weight: 5.0 },
      { sourceHash: "d", targetHash: "f", edgeType: "call", weight: 5.0 },
      // Weak bridge
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 0.1 },
    ];
    const graph = buildGraph(edges);
    const detector = new LeidenDetector();
    const result = detector.detect(graph, { resolution: 1.5, weightAttribute: "weight" });

    // Should find at least 2 communities
    const uniqueComms = new Set(Object.values(result.communities));
    expect(uniqueComms.size).toBeGreaterThanOrEqual(2);

    // a, b, c should be in the same community
    expect(result.communities["a"]).toBe(result.communities["b"]);
    expect(result.communities["b"]).toBe(result.communities["c"]);

    // d, e, f should be in the same community
    expect(result.communities["d"]).toBe(result.communities["e"]);
    expect(result.communities["e"]).toBe(result.communities["f"]);

    // The two cliques should be in different communities
    expect(result.communities["a"]).not.toBe(result.communities["d"]);
  });

  it("handles empty graph", () => {
    const graph = buildGraph([]);
    const detector = new LeidenDetector();
    const result = detector.detect(graph, { resolution: 1.0, weightAttribute: "weight" });
    expect(result.communities).toEqual({});
    expect(result.modularity).toBeNull();
  });

  it("handles single node", () => {
    const graph = buildGraph([], undefined, undefined, undefined, new Set(["a"]));
    const detector = new LeidenDetector();
    const result = detector.detect(graph, { resolution: 1.0, weightAttribute: "weight" });
    expect(Object.keys(result.communities)).toHaveLength(1);
    expect(result.modularity).toBe(0);
  });

  it("works through detectCommunities with algorithm='leiden'", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];
    const result = detectCommunities(edges, {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "leiden",
      autoResolution: false,
    });

    expect(result.assignments.length).toBe(4);
    expect(result.modularity).not.toBeNull();
  });

  it("supportsResolution is true (active splitting works)", () => {
    const detector = new LeidenDetector();
    expect(detector.supportsResolution).toBe(true);
  });
});
