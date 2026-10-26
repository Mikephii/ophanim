import { describe, it, expect } from "vitest";
import {
  createTestDb,
  insertAnalysisPair,
  insertFileFunction,
  insertCommunity,
  insertEdge,
} from "./test-utils";
import {
  computeL1InputHash,
  computeL2InputHash,
  computeL3InputHash,
  computeCCInputHash,
  computePackageBreakdown,
  formatPackageBreakdown,
  storeSummary,
  loadSummary,
  loadAllSummaries,
  buildL1Context,
  buildL1RawContext,
  summarizeCommunities,
  detectCrossCuttingConcerns,
  cleanupOrphanedSummaries,
  hasCommunityDrifted,
  storeCommunitySignatures,
  loadCommunitySignatures,
  type CrossCuttingConcern,
  type L1CommunityContext,
  type MemberContext,
  type FunctionSignature,
} from "./summarize";
import type { L1Summary, L2Summary, L3Summary, CrossCuttingConcernSummary } from "./schemas";
import type { ModuleResolver } from "./graph";

// ============ INPUT HASH ============

describe("input hash computation", () => {
  it("is deterministic for same inputs", () => {
    const a = computeL1InputHash(["hash_a", "hash_b"]);
    const b = computeL1InputHash(["hash_a", "hash_b"]);
    expect(a).toBe(b);
  });

  it("is order-independent", () => {
    const a = computeL1InputHash(["hash_a", "hash_b"]);
    const b = computeL1InputHash(["hash_b", "hash_a"]);
    expect(a).toBe(b);
  });

  it("changes when members change", () => {
    const a = computeL1InputHash(["hash_a", "hash_b"]);
    const b = computeL1InputHash(["hash_a", "hash_c"]);
    expect(a).not.toBe(b);
  });

  it("L2 hash differs from L1 hash of same inputs", () => {
    const l1 = computeL1InputHash(["hash_a", "hash_b"]);
    const l2 = computeL2InputHash(["hash_a", "hash_b"]);
    expect(l1).not.toBe(l2);
  });

  it("L3 hash differs from L2 hash of same inputs", () => {
    const l2 = computeL2InputHash(["hash_a", "hash_b"]);
    const l3 = computeL3InputHash(["hash_a", "hash_b"]);
    expect(l2).not.toBe(l3);
  });
});

// ============ STORAGE ============

describe("summary storage", () => {
  it("round-trips store and load", () => {
    const db = createTestDb();
    const summary = { title: "Auth", documentation: "# Auth", meta: {} };
    storeSummary(db, "c0", 1, "louvain", "hash_abc", summary, "test-model");

    const loaded = loadSummary(db, "c0", 1, "louvain");
    expect(loaded).not.toBeNull();
    expect(loaded!.communityId).toBe("c0");
    expect(loaded!.level).toBe(1);
    expect(loaded!.inputHash).toBe("hash_abc");
    expect(loaded!.summary).toEqual(summary);
    expect(loaded!.modelVersion).toBe("test-model");
    db.close();
  });

  it("upserts on same primary key", () => {
    const db = createTestDb();
    storeSummary(db, "c0", 1, "louvain", "hash_v1", { title: "v1" }, "model-1");
    storeSummary(db, "c0", 1, "louvain", "hash_v2", { title: "v2" }, "model-2");

    const loaded = loadSummary(db, "c0", 1, "louvain");
    expect((loaded!.summary as { title: string }).title).toBe("v2");
    expect(loaded!.inputHash).toBe("hash_v2");
    db.close();
  });

  it("returns null for missing summary", () => {
    const db = createTestDb();
    const loaded = loadSummary(db, "nonexistent", 1, "louvain");
    expect(loaded).toBeNull();
    db.close();
  });

  it("loadAll returns all summaries for algorithm + level", () => {
    const db = createTestDb();
    storeSummary(db, "c0", 1, "louvain", "h0", { title: "A" }, "m");
    storeSummary(db, "c1", 1, "louvain", "h1", { title: "B" }, "m");
    storeSummary(db, "c2", 1, "label-propagation", "h2", { title: "C" }, "m");
    storeSummary(db, "sys", 2, "louvain", "h3", { title: "D" }, "m");

    const l1Louvain = loadAllSummaries(db, "louvain", 1);
    expect(l1Louvain).toHaveLength(2);

    const l1Lpa = loadAllSummaries(db, "label-propagation", 1);
    expect(l1Lpa).toHaveLength(1);

    const l2Louvain = loadAllSummaries(db, "louvain", 2);
    expect(l2Louvain).toHaveLength(1);
    db.close();
  });
});

// ============ CONTEXT BUILDING ============

describe("buildL1Context", () => {
  function setupCommunity() {
    const db = createTestDb();

    // Create two functions with analysis
    insertFileFunction(db, "src/auth.ts", "login", "hash_login");
    insertFileFunction(db, "src/auth.ts", "logout", "hash_logout");

    insertAnalysisPair(db, "hash_login", {
      doc: { description: "Handles user login" },
      sec: { dataTags: ["credentials"], securityFlags: ["hardcoded_secret"] },
    });
    insertAnalysisPair(db, "hash_logout", {
      doc: { description: "Handles user logout" },
      sec: { dataTags: ["internal"], securityFlags: [] },
    });

    // Assign both to community "auth"
    insertCommunity(db, "hash_login", "auth");
    insertCommunity(db, "hash_logout", "auth");

    // Add an edge between them
    insertEdge(db, "hash_login", "hash_logout");

    return db;
  }

  it("builds context with correct member data", () => {
    const db = setupCommunity();
    const ctx = buildL1Context(db, "auth", "louvain");

    expect(ctx).not.toBeNull();
    expect(ctx!.communityId).toBe("auth");
    expect(ctx!.members).toHaveLength(2);

    const loginMember = ctx!.members.find((m) => m.functionName === "login");
    expect(loginMember).toBeDefined();
    expect(loginMember!.description).toBe("Handles user login");
    expect(loginMember!.dataTags).toEqual(["credentials"]);
    expect(loginMember!.securityFlags).toEqual(["hardcoded_secret"]);
    expect(loginMember!.filePath).toBe("src/auth.ts");
    db.close();
  });

  it("populates callsTo and calledBy from edges", () => {
    const db = setupCommunity();
    const ctx = buildL1Context(db, "auth", "louvain");

    const loginMember = ctx!.members.find((m) => m.functionName === "login");
    const logoutMember = ctx!.members.find((m) => m.functionName === "logout");

    expect(loginMember!.callsTo).toContain("logout");
    expect(logoutMember!.calledBy).toContain("login");
    db.close();
  });

  it("includes internal edges", () => {
    const db = setupCommunity();
    const ctx = buildL1Context(db, "auth", "louvain");

    expect(ctx!.internalEdges).toHaveLength(1);
    expect(ctx!.internalEdges[0]).toEqual({ from: "login", to: "logout", type: "call" });
    db.close();
  });

  it("returns null for empty community", () => {
    const db = createTestDb();
    const ctx = buildL1Context(db, "nonexistent", "louvain");
    expect(ctx).toBeNull();
    db.close();
  });

  it("returns null when no file_functions entries match", () => {
    const db = createTestDb();
    // Community exists but no file_functions rows for the hashes
    insertCommunity(db, "orphan_hash", "orphan_community");

    const ctx = buildL1Context(db, "orphan_community", "louvain");
    expect(ctx).toBeNull();
    db.close();
  });

  it("handles members without analysis gracefully", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/utils.ts", "helper", "hash_helper");
    insertCommunity(db, "hash_helper", "utils");
    // No insertAnalysisPair -- member has no analysis

    const ctx = buildL1Context(db, "utils", "louvain");
    expect(ctx).not.toBeNull();
    expect(ctx!.members[0].description).toBe("");
    expect(ctx!.members[0].dataTags).toEqual([]);
    db.close();
  });

  it("excludes external edges (between community and non-community)", () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertFileFunction(db, "src/c.ts", "fnC", "hash_c");

    insertCommunity(db, "hash_a", "group1");
    insertCommunity(db, "hash_b", "group1");
    // hash_c is NOT in group1

    insertEdge(db, "hash_a", "hash_b"); // internal
    insertEdge(db, "hash_a", "hash_c"); // external -- should be excluded

    const ctx = buildL1Context(db, "group1", "louvain");
    expect(ctx!.internalEdges).toHaveLength(1);
    expect(ctx!.internalEdges[0].from).toBe("fnA");
    expect(ctx!.internalEdges[0].to).toBe("fnB");
    db.close();
  });
});

// ============ CACHE INVALIDATION ============

describe("cache invalidation", () => {
  it("same members = same hash = skip re-summarize", async () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertFileFunction(db, "src/c.ts", "fnC", "hash_c");

    insertAnalysisPair(db, "hash_a", { doc: { description: "fn A" } });
    insertAnalysisPair(db, "hash_b", { doc: { description: "fn B" } });
    insertAnalysisPair(db, "hash_c", { doc: { description: "fn C" } });

    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");
    insertCommunity(db, "hash_c", "c1");

    // We need at least 2 non-dissolved communities for L2
    // but let's just test L1 caching
    let l1CallCount = 0;
    const mockL1 = async (): Promise<L1Summary> => {
      l1CallCount++;
      return { title: "Test", documentation: "# Test", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } };
    };
    const mockL2 = async (): Promise<L2Summary> => {
      return { title: "System", documentation: "# System", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } };
    };
    const mockL3 = async (): Promise<L3Summary> => {
      return { title: "Arch", documentation: "# Arch", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } };
    };

    // First run -- should call L1 for each community
    const result1 = await summarizeCommunities(db, {
      _summarizeL1: mockL1,
      _summarizeL2: mockL2,
      _summarizeL3: mockL3,
    });
    expect(result1.l1Summarized).toBe(2);
    expect(result1.l1Cached).toBe(0);
    expect(l1CallCount).toBe(2);

    // Second run -- same members, should all be cached
    l1CallCount = 0;
    const result2 = await summarizeCommunities(db, {
      _summarizeL1: mockL1,
      _summarizeL2: mockL2,
      _summarizeL3: mockL3,
    });
    expect(result2.l1Summarized).toBe(0);
    expect(result2.l1Cached).toBe(2);
    expect(l1CallCount).toBe(0);

    db.close();
  });

  it("changed members = different hash = re-summarize", async () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");

    insertAnalysisPair(db, "hash_a", { doc: { description: "fn A" } });
    insertAnalysisPair(db, "hash_b", { doc: { description: "fn B" } });

    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");

    let l1CallCount = 0;
    const mockL1 = async (): Promise<L1Summary> => {
      l1CallCount++;
      return { title: "Test", documentation: "# Test", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } };
    };

    // First run
    await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(l1CallCount).toBe(1);

    // Add a new member to the community
    insertFileFunction(db, "src/c.ts", "fnC", "hash_c");
    insertAnalysisPair(db, "hash_c", { doc: { description: "fn C" } });
    insertCommunity(db, "hash_c", "c0");

    // Second run -- membership changed, should re-summarize
    l1CallCount = 0;
    const result2 = await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(result2.l1Summarized).toBe(1);
    expect(l1CallCount).toBe(1);

    db.close();
  });
});

// ============ ORCHESTRATION ============

describe("summarizeCommunities orchestration", () => {
  function setupFullPipeline() {
    const db = createTestDb();

    // 3 communities with 2+ members each
    for (const [community, fns] of Object.entries({
      auth: [["login", "hash_login"], ["logout", "hash_logout"], ["validate", "hash_validate"]],
      db: [["query", "hash_query"], ["connect", "hash_connect"], ["migrate", "hash_migrate"]],
      api: [["handleGet", "hash_get"], ["handlePost", "hash_post"]],
    })) {
      for (const [name, hash] of fns) {
        insertFileFunction(db, `src/${community}.ts`, name, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${name} does stuff` } });
        insertCommunity(db, hash, community);
      }
    }

    // Cross-community edge
    insertEdge(db, "hash_login", "hash_query");

    return db;
  }

  it("generates L1 for each community, L2 from L1s, L3 from L2", async () => {
    const db = setupFullPipeline();
    const calls: string[] = [];

    const result = await summarizeCommunities(db, {
      _summarizeL1: async (ctx) => {
        calls.push(`L1:${ctx.communityId}`);
        return { title: `${ctx.communityId} Title`, documentation: `# ${ctx.communityId}`, meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } };
      },
      _summarizeL2: async (ctx) => {
        calls.push(`L2:${ctx.communityId}`);
        return { title: "System", documentation: "# System", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "medium" as const } };
      },
      _summarizeL3: async () => {
        calls.push("L3");
        return { title: "Architecture", documentation: "# Arch", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "high" as const } };
      },
    });

    expect(result.l1Summarized).toBe(3);
    expect(result.l2Summarized).toBe(1);
    expect(result.l3Summarized).toBe(1);

    // Verify L1 was called for each community
    expect(calls.filter((c) => c.startsWith("L1:"))).toHaveLength(3);
    expect(calls).toContain("L2:system_0");
    expect(calls).toContain("L3");
    db.close();
  });

  it("skips L2/L3 when only one L1 community", async () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/a.ts", "fnB", "hash_b");
    insertAnalysisPair(db, "hash_a", { doc: { description: "A" } });
    insertAnalysisPair(db, "hash_b", { doc: { description: "B" } });
    insertCommunity(db, "hash_a", "only_one");
    insertCommunity(db, "hash_b", "only_one");

    let l2Called = false;
    let l3Called = false;

    const result = await summarizeCommunities(db, {
      _summarizeL1: async () => ({ title: "Only", documentation: "# Only", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }),
      _summarizeL2: async () => { l2Called = true; return { title: "", documentation: "", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }; },
      _summarizeL3: async () => { l3Called = true; return { title: "", documentation: "", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }; },
    });

    expect(result.l1Summarized).toBe(1);
    expect(result.l2Summarized).toBe(0);
    expect(result.l3Summarized).toBe(0);
    expect(l2Called).toBe(false);
    expect(l3Called).toBe(false);
    db.close();
  });

  it("skips unanalyzed communities by default", async () => {
    const db = createTestDb();

    // Community with no analysis (no description)
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/a.ts", "fnB", "hash_b");
    insertCommunity(db, "hash_a", "empty");
    insertCommunity(db, "hash_b", "empty");
    // No insertAnalysisPair -- members have no descriptions

    let l1Called = false;
    const result = await summarizeCommunities(db, {
      _summarizeL1: async () => { l1Called = true; return { title: "", documentation: "", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }; },
    });

    expect(result.l1Summarized).toBe(0);
    expect(l1Called).toBe(false);
    db.close();
  });

  it("ignores __dissolved communities", async () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertAnalysisPair(db, "hash_a", { doc: { description: "dissolved fn" } });
    insertCommunity(db, "hash_a", "__dissolved");

    let l1Called = false;
    await summarizeCommunities(db, {
      _summarizeL1: async () => { l1Called = true; return { title: "", documentation: "", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }; },
    });

    expect(l1Called).toBe(false);
    db.close();
  });

  it("returns zero counts when no communities exist", async () => {
    const db = createTestDb();

    const result = await summarizeCommunities(db, {
      _summarizeL1: async () => ({ title: "", documentation: "", meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const } }),
    });

    expect(result.l1Summarized).toBe(0);
    expect(result.l1Cached).toBe(0);
    expect(result.l2Summarized).toBe(0);
    expect(result.l3Summarized).toBe(0);
    db.close();
  });
});

// ============ CROSS-CUTTING INPUT HASH ============

describe("computeCCInputHash", () => {
  it("is deterministic regardless of bridge function order", () => {
    const concern1: CrossCuttingConcern = {
      tag: "pii",
      concernType: "data_flow",
      bridgeFunctions: [
        { contentHash: "hash_a", functionName: "fnA", communityId: "c0", centrality: 0.5 },
        { contentHash: "hash_b", functionName: "fnB", communityId: "c1", centrality: 0.3 },
      ],
      affectedCommunities: [
        { communityId: "c0", communityTitle: "Auth" },
        { communityId: "c1", communityTitle: "DB" },
      ],
      crossEdgeCount: 2,
    };

    const concern2: CrossCuttingConcern = {
      tag: "pii",
      concernType: "data_flow",
      bridgeFunctions: [
        { contentHash: "hash_b", functionName: "fnB", communityId: "c1", centrality: 0.3 },
        { contentHash: "hash_a", functionName: "fnA", communityId: "c0", centrality: 0.5 },
      ],
      affectedCommunities: [
        { communityId: "c1", communityTitle: "DB" },
        { communityId: "c0", communityTitle: "Auth" },
      ],
      crossEdgeCount: 2,
    };

    expect(computeCCInputHash(concern1)).toBe(computeCCInputHash(concern2));
  });

  it("differs when tag changes", () => {
    const base: CrossCuttingConcern = {
      tag: "pii",
      concernType: "data_flow",
      bridgeFunctions: [{ contentHash: "h1", functionName: "f", communityId: "c0", centrality: 0.1 }],
      affectedCommunities: [{ communityId: "c0", communityTitle: "A" }],
      crossEdgeCount: 1,
    };

    const other = { ...base, tag: "credentials" };
    expect(computeCCInputHash(base)).not.toBe(computeCCInputHash(other));
  });
});

// ============ CROSS-CUTTING CONCERN DETECTION ============

describe("detectCrossCuttingConcerns", () => {
  function setupCrossCommunityConcern() {
    const db = createTestDb();

    // Community "auth" with PII-tagged functions
    insertFileFunction(db, "src/auth.ts", "login", "hash_login");
    insertFileFunction(db, "src/auth.ts", "validate", "hash_validate");
    insertAnalysisPair(db, "hash_login", {
      doc: { description: "Login handler" },
      sec: { dataTags: ["pii", "credentials"], securityFlags: [] },
    });
    insertAnalysisPair(db, "hash_validate", {
      doc: { description: "Validate input" },
      sec: { dataTags: ["pii"], securityFlags: ["unsanitized_input"] },
    });
    insertCommunity(db, "hash_login", "auth");
    insertCommunity(db, "hash_validate", "auth");

    // Community "db" with PII-tagged functions
    insertFileFunction(db, "src/db.ts", "saveUser", "hash_save");
    insertFileFunction(db, "src/db.ts", "query", "hash_query");
    insertAnalysisPair(db, "hash_save", {
      doc: { description: "Save user to DB" },
      sec: { dataTags: ["pii", "database"], securityFlags: ["sql_injection"] },
    });
    insertAnalysisPair(db, "hash_query", {
      doc: { description: "Run query" },
      sec: { dataTags: ["database"], securityFlags: ["sql_injection"] },
    });
    insertCommunity(db, "hash_save", "db");
    insertCommunity(db, "hash_query", "db");

    // Community "api" with some overlap
    insertFileFunction(db, "src/api.ts", "handleRequest", "hash_req");
    insertAnalysisPair(db, "hash_req", {
      doc: { description: "Handle API request" },
      sec: { dataTags: ["user_input"], securityFlags: ["unsanitized_input"] },
    });
    insertCommunity(db, "hash_req", "api");

    // Cross-community edges
    insertEdge(db, "hash_login", "hash_save"); // auth → db (PII flow)
    insertEdge(db, "hash_validate", "hash_query"); // auth → db (another cross edge)
    insertEdge(db, "hash_req", "hash_login"); // api → auth

    return db;
  }

  it("detects PII concern crossing 2+ communities", () => {
    const db = setupCrossCommunityConcern();
    const centralityScores = new Map<string, number>([
      ["hash_login", 0.8], ["hash_validate", 0.3],
      ["hash_save", 0.5], ["hash_query", 0.2],
      ["hash_req", 0.1],
    ]);

    const concerns = detectCrossCuttingConcerns(
      db, "louvain", centralityScores,
      [
        { communityId: "auth", title: "Authentication" },
        { communityId: "db", title: "Database" },
        { communityId: "api", title: "API Layer" },
      ]
    );

    // Should detect "pii" as a cross-cutting concern (auth ↔ db)
    const piiConcern = concerns.find((c) => c.tag === "pii");
    expect(piiConcern).toBeDefined();
    expect(piiConcern!.concernType).toBe("data_flow");
    expect(piiConcern!.affectedCommunities.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("returns empty when no cross-community edges exist", () => {
    const db = createTestDb();

    insertFileFunction(db, "src/a.ts", "fnA", "ha");
    insertFileFunction(db, "src/b.ts", "fnB", "hb");
    insertAnalysisPair(db, "ha", { sec: { dataTags: ["pii"] } });
    insertAnalysisPair(db, "hb", { sec: { dataTags: ["pii"] } });
    insertCommunity(db, "ha", "c0");
    insertCommunity(db, "hb", "c1");
    // No edges between communities

    const concerns = detectCrossCuttingConcerns(
      db, "louvain", new Map(),
      [{ communityId: "c0", title: "A" }, { communityId: "c1", title: "B" }]
    );
    expect(concerns).toHaveLength(0);
    db.close();
  });

  it("sorts security concerns before data flow concerns", () => {
    const db = setupCrossCommunityConcern();
    const centralityScores = new Map<string, number>([
      ["hash_login", 0.8], ["hash_validate", 0.3],
      ["hash_save", 0.5], ["hash_query", 0.2],
      ["hash_req", 0.6],
    ]);

    const concerns = detectCrossCuttingConcerns(
      db, "louvain", centralityScores,
      [
        { communityId: "auth", title: "Authentication" },
        { communityId: "db", title: "Database" },
        { communityId: "api", title: "API Layer" },
      ]
    );

    // Security concerns should come before data flow
    const secIndex = concerns.findIndex((c) => c.concernType === "security");
    const dataIndex = concerns.findIndex((c) => c.concernType === "data_flow");
    if (secIndex !== -1 && dataIndex !== -1) {
      expect(secIndex).toBeLessThan(dataIndex);
    }
    db.close();
  });

  it("returns empty when fewer than 2 communities", () => {
    const db = createTestDb();
    const concerns = detectCrossCuttingConcerns(
      db, "louvain", new Map(),
      [{ communityId: "c0", title: "Only One" }]
    );
    expect(concerns).toHaveLength(0);
    db.close();
  });
});

// ============ CROSS-CUTTING ORCHESTRATION ============

describe("cross-cutting concern orchestration", () => {
  function setupWithCrossConcerns() {
    const db = createTestDb();

    // Three communities with PII tag spanning all three → 2+ community pairs
    // Community "auth"
    insertFileFunction(db, "src/auth.ts", "login", "hash_login");
    insertFileFunction(db, "src/auth.ts", "logout", "hash_logout");
    insertFileFunction(db, "src/auth.ts", "check", "hash_check");

    for (const hash of ["hash_login", "hash_logout", "hash_check"]) {
      insertAnalysisPair(db, hash, {
        doc: { description: `${hash} desc` },
        sec: { dataTags: ["pii"], securityFlags: [] },
      });
      insertCommunity(db, hash, "auth");
    }

    // Community "db"
    insertFileFunction(db, "src/db.ts", "saveUser", "hash_save");
    insertFileFunction(db, "src/db.ts", "query", "hash_query");
    insertFileFunction(db, "src/db.ts", "connect", "hash_connect");

    for (const hash of ["hash_save", "hash_query", "hash_connect"]) {
      insertAnalysisPair(db, hash, {
        doc: { description: `${hash} desc` },
        sec: { dataTags: ["pii", "database"], securityFlags: [] },
      });
      insertCommunity(db, hash, "db");
    }

    // Community "api"
    insertFileFunction(db, "src/api.ts", "handleReq", "hash_req");
    insertFileFunction(db, "src/api.ts", "parseBody", "hash_parse");
    insertFileFunction(db, "src/api.ts", "respond", "hash_respond");

    for (const hash of ["hash_req", "hash_parse", "hash_respond"]) {
      insertAnalysisPair(db, hash, {
        doc: { description: `${hash} desc` },
        sec: { dataTags: ["pii", "user_input"], securityFlags: [] },
      });
      insertCommunity(db, hash, "api");
    }

    // Cross-community edges creating PII concern across 2+ community pairs
    insertEdge(db, "hash_login", "hash_save");  // auth → db
    insertEdge(db, "hash_req", "hash_login");    // api → auth
    insertEdge(db, "hash_check", "hash_query");  // auth → db (second edge)

    return db;
  }

  it("generates and caches cross-cutting concern summaries", async () => {
    const db = setupWithCrossConcerns();
    let ccCalls = 0;

    const mockMeta = { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const };
    const mockL1 = async (ctx: { communityId: string }): Promise<L1Summary> => {
      return { title: `${ctx.communityId} Title`, documentation: `# ${ctx.communityId}`, meta: mockMeta };
    };
    const mockL2 = async (): Promise<L2Summary> => {
      return { title: "System", documentation: "# System", meta: mockMeta };
    };
    const mockL3 = async (): Promise<L3Summary> => {
      return { title: "Arch", documentation: "# Arch", meta: mockMeta };
    };
    const mockCC = async (concern: CrossCuttingConcern): Promise<CrossCuttingConcernSummary> => {
      ccCalls++;
      return {
        title: `CC: ${concern.tag}`,
        concernType: concern.concernType,
        tag: concern.tag,
        documentation: `# Cross-cutting: ${concern.tag}`,
        bridgeFunctions: concern.bridgeFunctions,
        affectedCommunities: concern.affectedCommunities,
        severity: "medium",
      };
    };

    // First run -- should generate CC summaries
    const result1 = await summarizeCommunities(db, {
      _summarizeL1: mockL1,
      _summarizeL2: mockL2,
      _summarizeL3: mockL3,
      _summarizeCC: mockCC,
    });

    expect(result1.ccDetected).toBeGreaterThan(0);
    expect(result1.ccSummarized).toBeGreaterThan(0);
    expect(result1.ccCached).toBe(0);
    const firstCCCalls = ccCalls;

    // Second run -- should use cache (no new CC calls)
    ccCalls = 0;
    const result2 = await summarizeCommunities(db, {
      _summarizeL1: mockL1,
      _summarizeL2: mockL2,
      _summarizeL3: mockL3,
      _summarizeCC: mockCC,
    });

    expect(result2.ccDetected).toBe(result1.ccDetected);
    expect(result2.ccSummarized).toBe(0);
    expect(result2.ccCached).toBe(firstCCCalls);
    expect(ccCalls).toBe(0);

    // Verify summaries are stored as level=10
    const stored = loadAllSummaries(db, "louvain", 10);
    expect(stored.length).toBe(firstCCCalls);
    for (const s of stored) {
      expect(s.communityId).toMatch(/^concern_/);
    }

    db.close();
  });
});

// ============ HIERARCHICAL L2 SUMMARIZATION ============

describe("hierarchical L2 summarization", () => {
  const mockMeta = { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const };

  function setupWithHierarchy() {
    const db = createTestDb();

    // 4 L0 communities: auth, db, api, ui
    const communities = ["auth", "db", "api", "ui"];
    for (const comm of communities) {
      for (let i = 0; i < 3; i++) {
        const hash = `hash_${comm}_${i}`;
        insertFileFunction(db, `src/${comm}.ts`, `${comm}_fn${i}`, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${comm} fn ${i}` } });
        insertCommunity(db, hash, comm);
      }
    }

    // Cross-community edges for CC detection
    insertEdge(db, "hash_auth_0", "hash_db_0");
    insertEdge(db, "hash_api_0", "hash_ui_0");

    // L1 hierarchy: auth+db → group 0, api+ui → group 1
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("auth", "0");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("db", "0");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("api", "1");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("ui", "1");

    return db;
  }

  it("creates per-group L2 summaries when L1 hierarchy exists", async () => {
    const db = setupWithHierarchy();
    let l2Calls = 0;
    const l2CommunityIds: string[] = [];

    const result = await summarizeCommunities(db, {
      _summarizeL1: async (ctx) => ({
        title: `${ctx.communityId} Subsystem`,
        documentation: `# ${ctx.communityId}`,
        meta: mockMeta,
      }),
      _summarizeL2: async (ctx) => {
        l2Calls++;
        l2CommunityIds.push(ctx.communityId);
        return { title: `Group ${ctx.communityId}`, documentation: `# ${ctx.communityId}`, meta: mockMeta };
      },
      _summarizeL3: async () => ({
        title: "Architecture",
        documentation: "# Architecture",
        meta: mockMeta,
      }),
      _summarizeCC: async (concern) => ({
        title: `CC: ${concern.tag}`, concernType: concern.concernType, tag: concern.tag,
        documentation: "", bridgeFunctions: concern.bridgeFunctions,
        affectedCommunities: concern.affectedCommunities, severity: "low",
      }),
    });

    // Should have created 2 L2 summaries (one per group)
    expect(l2Calls).toBe(2);
    expect(l2CommunityIds).toContain("group_0");
    expect(l2CommunityIds).toContain("group_1");
    expect(result.l2Summarized).toBe(2);

    // Verify stored summaries
    const l2Summaries = loadAllSummaries(db, "louvain", 2);
    expect(l2Summaries).toHaveLength(2);
    expect(l2Summaries.map((s) => s.communityId).sort()).toEqual(["group_0", "group_1"]);

    db.close();
  });

  it("falls back to single system_0 when no hierarchy", async () => {
    const db = createTestDb();

    // 2 communities without L1 hierarchy
    for (const comm of ["auth", "db"]) {
      for (let i = 0; i < 3; i++) {
        const hash = `hash_${comm}_${i}`;
        insertFileFunction(db, `src/${comm}.ts`, `${comm}_fn${i}`, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${comm} fn ${i}` } });
        insertCommunity(db, hash, comm);
      }
    }
    insertEdge(db, "hash_auth_0", "hash_db_0");

    const l2CommunityIds: string[] = [];
    const result = await summarizeCommunities(db, {
      _summarizeL1: async (ctx) => ({
        title: `${ctx.communityId} Subsystem`,
        documentation: `# ${ctx.communityId}`,
        meta: mockMeta,
      }),
      _summarizeL2: async (ctx) => {
        l2CommunityIds.push(ctx.communityId);
        return { title: "System", documentation: "# System", meta: mockMeta };
      },
      _summarizeL3: async () => ({
        title: "Architecture",
        documentation: "# Architecture",
        meta: mockMeta,
      }),
    });

    expect(result.l2Summarized).toBe(1);
    expect(l2CommunityIds).toEqual(["system_0"]);

    const l2Summaries = loadAllSummaries(db, "louvain", 2);
    expect(l2Summaries).toHaveLength(1);
    expect(l2Summaries[0].communityId).toBe("system_0");

    db.close();
  });

  it("L3 synthesizes all group L2 summaries", async () => {
    const db = setupWithHierarchy();
    let l3Input: L2Summary[] = [];

    const result = await summarizeCommunities(db, {
      _summarizeL1: async (ctx) => ({
        title: `${ctx.communityId} Subsystem`,
        documentation: `# ${ctx.communityId}`,
        meta: mockMeta,
      }),
      _summarizeL2: async (ctx) => ({
        title: `System ${ctx.communityId}`,
        documentation: `# ${ctx.communityId}`,
        meta: mockMeta,
      }),
      _summarizeL3: async (summaries) => {
        l3Input = summaries;
        return { title: "Architecture", documentation: "# Architecture", meta: mockMeta };
      },
      _summarizeCC: async (concern) => ({
        title: `CC: ${concern.tag}`, concernType: concern.concernType, tag: concern.tag,
        documentation: "", bridgeFunctions: concern.bridgeFunctions,
        affectedCommunities: concern.affectedCommunities, severity: "low",
      }),
    });

    // L3 should receive both L2 group summaries
    expect(l3Input).toHaveLength(2);
    expect(result.l3Summarized).toBe(1);

    db.close();
  });
});

// ============ ORPHAN CLEANUP ============

describe("cleanupOrphanedSummaries", () => {
  it("deletes summaries not in active set", () => {
    const db = createTestDb();
    storeSummary(db, "c0", 1, "louvain", "h0", { title: "Keep" }, "m");
    storeSummary(db, "c1", 1, "louvain", "h1", { title: "Delete" }, "m");
    storeSummary(db, "c2", 1, "louvain", "h2", { title: "Keep" }, "m");

    cleanupOrphanedSummaries(db, "louvain", 1, new Set(["c0", "c2"]));

    const remaining = loadAllSummaries(db, "louvain", 1);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((s) => s.communityId).sort()).toEqual(["c0", "c2"]);
    expect(loadSummary(db, "c1", 1, "louvain")).toBeNull();
    db.close();
  });

  it("deletes all when active set is empty", () => {
    const db = createTestDb();
    storeSummary(db, "c0", 1, "louvain", "h0", { title: "A" }, "m");
    storeSummary(db, "c1", 1, "louvain", "h1", { title: "B" }, "m");

    cleanupOrphanedSummaries(db, "louvain", 1, new Set());

    const remaining = loadAllSummaries(db, "louvain", 1);
    expect(remaining).toHaveLength(0);
    db.close();
  });

  it("only affects specified level and algorithm", () => {
    const db = createTestDb();
    storeSummary(db, "c0", 1, "louvain", "h0", { title: "L1 Louvain" }, "m");
    storeSummary(db, "c0", 2, "louvain", "h1", { title: "L2 Louvain" }, "m");
    storeSummary(db, "c0", 1, "label-propagation", "h2", { title: "L1 LP" }, "m");

    // Cleanup L1 louvain only -- should leave L2 and LP untouched
    cleanupOrphanedSummaries(db, "louvain", 1, new Set());

    expect(loadSummary(db, "c0", 1, "louvain")).toBeNull();
    expect(loadSummary(db, "c0", 2, "louvain")).not.toBeNull();
    expect(loadSummary(db, "c0", 1, "label-propagation")).not.toBeNull();
    db.close();
  });
});

describe("orphan cleanup during orchestration", () => {
  const mockMeta = { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const };

  it("removes stale L1 summaries when communities change", async () => {
    const db = createTestDb();

    // Run 1: communities auth and db
    for (const comm of ["auth", "db"]) {
      for (let i = 0; i < 2; i++) {
        const hash = `hash_${comm}_${i}`;
        insertFileFunction(db, `src/${comm}.ts`, `${comm}_fn${i}`, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${comm} fn ${i}` } });
        insertCommunity(db, hash, comm);
      }
    }
    insertEdge(db, "hash_auth_0", "hash_db_0");

    const mocks = {
      _summarizeL1: async (ctx: { communityId: string }) => ({
        title: `${ctx.communityId} Title`, documentation: `# ${ctx.communityId}`, meta: mockMeta,
      }),
      _summarizeL2: async () => ({ title: "System", documentation: "# System", meta: mockMeta }),
      _summarizeL3: async () => ({ title: "Arch", documentation: "# Arch", meta: mockMeta }),
    };

    await summarizeCommunities(db, mocks);

    // Verify both L1 summaries exist
    expect(loadSummary(db, "auth", 1, "louvain")).not.toBeNull();
    expect(loadSummary(db, "db", 1, "louvain")).not.toBeNull();

    // Run 2: remove "db" community, replace with "api"
    db.prepare("DELETE FROM communities WHERE community_id = 'db' AND level = 0").run();
    for (let i = 0; i < 2; i++) {
      const hash = `hash_api_${i}`;
      insertFileFunction(db, `src/api.ts`, `api_fn${i}`, hash);
      insertAnalysisPair(db, hash, { doc: { description: `api fn ${i}` } });
      insertCommunity(db, hash, "api");
    }
    insertEdge(db, "hash_auth_0", "hash_api_0");

    await summarizeCommunities(db, mocks);

    // "db" L1 should be gone, "auth" and "api" should exist
    expect(loadSummary(db, "auth", 1, "louvain")).not.toBeNull();
    expect(loadSummary(db, "api", 1, "louvain")).not.toBeNull();
    expect(loadSummary(db, "db", 1, "louvain")).toBeNull();

    db.close();
  });

  it("cleans up system_0 when switching to group hierarchy", async () => {
    const db = createTestDb();

    // Setup 4 communities
    for (const comm of ["auth", "db", "api", "ui"]) {
      for (let i = 0; i < 2; i++) {
        const hash = `hash_${comm}_${i}`;
        insertFileFunction(db, `src/${comm}.ts`, `${comm}_fn${i}`, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${comm} fn ${i}` } });
        insertCommunity(db, hash, comm);
      }
    }
    insertEdge(db, "hash_auth_0", "hash_db_0");
    insertEdge(db, "hash_api_0", "hash_ui_0");

    const mocks = {
      _summarizeL1: async (ctx: { communityId: string }) => ({
        title: `${ctx.communityId} Title`, documentation: `# ${ctx.communityId}`, meta: mockMeta,
      }),
      _summarizeL2: async (ctx: { communityId: string }) => ({
        title: `${ctx.communityId} System`, documentation: `# ${ctx.communityId}`, meta: mockMeta,
      }),
      _summarizeL3: async () => ({ title: "Arch", documentation: "# Arch", meta: mockMeta }),
      _summarizeCC: async (concern: CrossCuttingConcern) => ({
        title: `CC: ${concern.tag}`, concernType: concern.concernType as "data_flow" | "security",
        tag: concern.tag, documentation: "", bridgeFunctions: concern.bridgeFunctions,
        affectedCommunities: concern.affectedCommunities, severity: "low" as const,
      }),
    };

    // Run 1: no hierarchy → system_0
    await summarizeCommunities(db, mocks);
    expect(loadSummary(db, "system_0", 2, "louvain")).not.toBeNull();
    expect(loadAllSummaries(db, "louvain", 2)).toHaveLength(1);

    // Run 2: add L1 hierarchy → group_0 + group_1, system_0 should be cleaned up
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("auth", "0");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("db", "0");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("api", "1");
    db.prepare("INSERT INTO communities (content_hash, level, community_id, algorithm) VALUES (?, 1, ?, 'louvain')")
      .run("ui", "1");

    await summarizeCommunities(db, mocks);

    // system_0 should be gone, replaced by group_0 and group_1
    expect(loadSummary(db, "system_0", 2, "louvain")).toBeNull();
    expect(loadSummary(db, "group_0", 2, "louvain")).not.toBeNull();
    expect(loadSummary(db, "group_1", 2, "louvain")).not.toBeNull();
    expect(loadAllSummaries(db, "louvain", 2)).toHaveLength(2);

    db.close();
  });
});

// ============ SIGNATURE DRIFT (Gate 2) ============

describe("hasCommunityDrifted", () => {
  const makeSig = (name: string, paramCount = 1): FunctionSignature => ({ name, paramCount });
  const makeMember = (name: string, paramCount = 1): MemberContext => ({
    contentHash: `hash_${name}`,
    functionName: name,
    filePath: `src/${name}.ts`,
    language: "typescript",
    entityType: "function",
    description: "",
    params: Array.from({ length: paramCount }, (_, i) => ({ name: `p${i}`, type: "string", description: "" })),
    returns: { type: "void", description: "" },
    dataTags: [],
    securityFlags: [],
    callsTo: [],
    calledBy: [],
  });

  it("returns false when members are identical", () => {
    const oldSigs = [makeSig("fnA", 2), makeSig("fnB", 1), makeSig("fnC", 0)];
    const newMembers = [makeMember("fnA", 2), makeMember("fnB", 1), makeMember("fnC", 0)];
    expect(hasCommunityDrifted(oldSigs, newMembers)).toBe(false);
  });

  it("returns true when >20% of members are added or removed", () => {
    // 5 old members, remove 2 = 40% membership change
    const oldSigs = [makeSig("a"), makeSig("b"), makeSig("c"), makeSig("d"), makeSig("e")];
    const newMembers = [makeMember("a"), makeMember("b"), makeMember("c")]; // removed d, e
    expect(hasCommunityDrifted(oldSigs, newMembers)).toBe(true);
  });

  it("returns false when membership change is below threshold", () => {
    // 10 old members, add 1 = 10% change
    const oldSigs = Array.from({ length: 10 }, (_, i) => makeSig(`fn${i}`));
    const newMembers = [
      ...Array.from({ length: 10 }, (_, i) => makeMember(`fn${i}`)),
      makeMember("fnNew"),
    ];
    expect(hasCommunityDrifted(oldSigs, newMembers)).toBe(false);
  });

  it("returns true when >20% of surviving members have param changes", () => {
    // 5 members, 2 have param count changes = 40%
    const oldSigs = [makeSig("a", 1), makeSig("b", 2), makeSig("c", 3), makeSig("d", 1), makeSig("e", 2)];
    const newMembers = [makeMember("a", 1), makeMember("b", 5), makeMember("c", 0), makeMember("d", 1), makeMember("e", 2)];
    // b: 2→5 (changed), c: 3→0 (changed), rest same → 2/5 = 40% > 20%
    expect(hasCommunityDrifted(oldSigs, newMembers)).toBe(true);
  });

  it("returns false when param changes are below threshold", () => {
    // 10 members, 1 has param change = 10%
    const oldSigs = Array.from({ length: 10 }, (_, i) => makeSig(`fn${i}`, 2));
    const newMembers = Array.from({ length: 10 }, (_, i) =>
      makeMember(`fn${i}`, i === 0 ? 3 : 2) // only fn0 changed
    );
    expect(hasCommunityDrifted(oldSigs, newMembers)).toBe(false);
  });

  it("returns true when old signatures are empty", () => {
    expect(hasCommunityDrifted([], [makeMember("a")])).toBe(true);
  });
});

describe("community signature storage", () => {
  it("round-trips signatures through store/load", () => {
    const db = createTestDb();
    const members: MemberContext[] = [
      {
        contentHash: "h1", functionName: "fnA", filePath: "a.ts",
        language: "typescript", entityType: "function", description: "test",
        params: [{ name: "x", type: "string", description: "" }],
        returns: { type: "void", description: "" },
        dataTags: [], securityFlags: [], callsTo: [], calledBy: [],
      },
      {
        contentHash: "h2", functionName: "fnB", filePath: "b.ts",
        language: "typescript", entityType: "function", description: "test",
        params: [{ name: "a", type: "number", description: "" }, { name: "b", type: "number", description: "" }],
        returns: { type: "number", description: "" },
        dataTags: [], securityFlags: [], callsTo: [], calledBy: [],
      },
    ];

    storeCommunitySignatures(db, "c0", "louvain", members);
    const loaded = loadCommunitySignatures(db, "c0", "louvain");

    expect(loaded).toEqual([
      { name: "fnA", paramCount: 1 },
      { name: "fnB", paramCount: 2 },
    ]);
    db.close();
  });

  it("returns null when no signatures exist", () => {
    const db = createTestDb();
    const result = loadCommunitySignatures(db, "nonexistent", "louvain");
    expect(result).toBeNull();
    db.close();
  });
});

describe("signature drift orchestration", () => {
  const mockSummary = (title = "Test"): L1Summary => ({
    title, documentation: `# ${title}`,
    meta: { securityPosture: "", dataClassification: [], boundaries: [], keyFunctions: [], complexity: "low" as const },
  });

  it("drift-skips L1 when hash changes but signatures are stable", async () => {
    const db = createTestDb();

    // Setup: community c0 with 2 members
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertAnalysisPair(db, "hash_a", { doc: { description: "fn A", params: [{ name: "x", type: "string", description: "" }] } });
    insertAnalysisPair(db, "hash_b", { doc: { description: "fn B" } });
    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");

    let l1CallCount = 0;
    const mockL1 = async (): Promise<L1Summary> => { l1CallCount++; return mockSummary(); };

    // Run 1: generates summary + stores signatures
    const result1 = await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(result1.l1Summarized).toBe(1);
    expect(l1CallCount).toBe(1);

    // Simulate code edit: fnA's content hash changes, but same name and params
    db.prepare("DELETE FROM communities WHERE content_hash = 'hash_a'").run();
    db.prepare("DELETE FROM file_functions WHERE content_hash = 'hash_a'").run();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a2");
    insertAnalysisPair(db, "hash_a2", { doc: { description: "fn A updated", params: [{ name: "x", type: "string", description: "" }] } });
    insertCommunity(db, "hash_a2", "c0");

    // Run 2: hash changed but signature stable → drift-skip
    l1CallCount = 0;
    const result2 = await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(result2.l1Summarized).toBe(0);
    expect(result2.l1DriftSkipped).toBe(1);
    expect(l1CallCount).toBe(0);

    db.close();
  });

  it("re-summarizes when signature drift exceeds threshold", async () => {
    const db = createTestDb();

    // Setup: community c0 with 3 members
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertFileFunction(db, "src/c.ts", "fnC", "hash_c");
    insertAnalysisPair(db, "hash_a", { doc: { description: "fn A" } });
    insertAnalysisPair(db, "hash_b", { doc: { description: "fn B" } });
    insertAnalysisPair(db, "hash_c", { doc: { description: "fn C" } });
    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");
    insertCommunity(db, "hash_c", "c0");

    let l1CallCount = 0;
    const mockL1 = async (): Promise<L1Summary> => { l1CallCount++; return mockSummary(); };

    // Run 1
    await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(l1CallCount).toBe(1);

    // Remove 2 of 3 members (67% membership change > 20% threshold)
    db.prepare("DELETE FROM communities WHERE content_hash IN ('hash_b', 'hash_c')").run();

    // Run 2: heavy drift → should re-summarize
    l1CallCount = 0;
    const result2 = await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(result2.l1Summarized).toBe(1);
    expect(result2.l1DriftSkipped).toBe(0);
    expect(l1CallCount).toBe(1);

    db.close();
  });

  it("prevents L2/L3 cascade when L1 is drift-skipped", async () => {
    const db = createTestDb();

    // Setup 2 communities (required for L2)
    for (const [comm, fns] of Object.entries({
      c0: [["fnA", "hash_a"], ["fnB", "hash_b"]],
      c1: [["fnC", "hash_c"], ["fnD", "hash_d"]],
    })) {
      for (const [name, hash] of fns) {
        insertFileFunction(db, `src/${name}.ts`, name, hash);
        insertAnalysisPair(db, hash, { doc: { description: `${name} desc` } });
        insertCommunity(db, hash, comm);
      }
    }

    insertEdge(db, "hash_a", "hash_c"); // cross-community edge for L2

    let l1Count = 0, l2Count = 0, l3Count = 0;
    const mocks = {
      _summarizeL1: async (): Promise<L1Summary> => { l1Count++; return mockSummary(); },
      _summarizeL2: async (): Promise<L2Summary> => { l2Count++; return mockSummary("System"); },
      _summarizeL3: async (): Promise<L3Summary> => { l3Count++; return mockSummary("Arch"); },
    };

    // Run 1: generates everything
    await summarizeCommunities(db, mocks);
    expect(l1Count).toBe(2);
    expect(l2Count).toBe(1);
    expect(l3Count).toBe(1);

    // Simulate minor edit: fnA's hash changes, same name/params
    db.prepare("DELETE FROM communities WHERE content_hash = 'hash_a'").run();
    db.prepare("DELETE FROM file_functions WHERE content_hash = 'hash_a'").run();
    db.prepare("DELETE FROM function_edges WHERE source_hash = 'hash_a' OR target_hash = 'hash_a'").run();
    insertFileFunction(db, "src/fnA.ts", "fnA", "hash_a2");
    insertAnalysisPair(db, "hash_a2", { doc: { description: "fnA updated" } });
    insertCommunity(db, "hash_a2", "c0");
    insertEdge(db, "hash_a2", "hash_c");

    // Run 2: L1 drift-skipped → L2/L3 should also be cached
    l1Count = 0; l2Count = 0; l3Count = 0;
    const result2 = await summarizeCommunities(db, mocks);
    expect(result2.l1DriftSkipped).toBe(1);  // c0 drift-skipped
    expect(result2.l1Cached).toBe(1);        // c1 normal cache hit
    expect(result2.l1Summarized).toBe(0);    // no Claude calls
    expect(l2Count).toBe(0);                 // L2 cached (L1 hashes unchanged)
    expect(l3Count).toBe(0);                 // L3 cached

    db.close();
  });
});

// ============ RAW-SOURCE MODE ============

describe("computeL1InputHash raw-source separation", () => {
  it("raw-source hash differs from normal hash for same inputs", () => {
    const normal = computeL1InputHash(["hash_a", "hash_b"]);
    const raw = computeL1InputHash(["hash_a", "hash_b"], true);
    expect(normal).not.toBe(raw);
  });

  it("raw-source hash is deterministic", () => {
    const a = computeL1InputHash(["hash_a", "hash_b"], true);
    const b = computeL1InputHash(["hash_a", "hash_b"], true);
    expect(a).toBe(b);
  });
});

describe("buildL1RawContext", () => {
  it("uses source code as description", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/auth.ts", "login", "hash_login");
    insertCommunity(db, "hash_login", "auth");

    const sourceMap = new Map([["hash_login", "function login(user: string) { return true; }"]]);
    const ctx = buildL1RawContext(db, "auth", "louvain", sourceMap);

    expect(ctx).not.toBeNull();
    expect(ctx!.members[0].description).toBe("function login(user: string) { return true; }");
    expect(ctx!.members[0].params).toEqual([]);
    expect(ctx!.members[0].functionName).toBe("login");
    db.close();
  });

  it("skips members without source in sourceMap", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");

    const sourceMap = new Map([["hash_a", "function fnA() {}"]]);
    const ctx = buildL1RawContext(db, "c0", "louvain", sourceMap);

    expect(ctx!.members).toHaveLength(1);
    expect(ctx!.members[0].functionName).toBe("fnA");
    db.close();
  });

  it("resolves internal edges", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");
    insertEdge(db, "hash_a", "hash_b", { edgeType: "call" });

    const sourceMap = new Map([
      ["hash_a", "function fnA() { fnB(); }"],
      ["hash_b", "function fnB() {}"],
    ]);
    const ctx = buildL1RawContext(db, "c0", "louvain", sourceMap);

    expect(ctx!.internalEdges).toHaveLength(1);
    expect(ctx!.internalEdges[0]).toEqual({ from: "fnA", to: "fnB", type: "call" });
    expect(ctx!.members.find((m) => m.functionName === "fnA")!.callsTo).toContain("fnB");
    db.close();
  });

  it("loads security tags from analysis if available", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertCommunity(db, "hash_a", "c0");
    insertAnalysisPair(db, "hash_a", { sec: { dataTags: ["pii"], securityFlags: ["sql_injection"] } });

    const sourceMap = new Map([["hash_a", "function fnA() {}"]]);
    const ctx = buildL1RawContext(db, "c0", "louvain", sourceMap);

    expect(ctx!.members[0].dataTags).toEqual(["pii"]);
    expect(ctx!.members[0].securityFlags).toEqual(["sql_injection"]);
    db.close();
  });

  it("produces different input hash than buildL1Context for same community", () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertCommunity(db, "hash_a", "c0");
    insertAnalysisPair(db, "hash_a");

    const normalCtx = buildL1Context(db, "c0", "louvain");
    const rawCtx = buildL1RawContext(db, "c0", "louvain", new Map([["hash_a", "function fnA() {}"]]));

    expect(normalCtx!.inputHash).not.toBe(rawCtx!.inputHash);
    db.close();
  });
});

describe("summarizeCommunities with sourceMap (raw-source mode)", () => {
  it("calls L1 summarizer with source-code descriptions", async () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "src/b.ts", "fnB", "hash_b");
    insertCommunity(db, "hash_a", "c0");
    insertCommunity(db, "hash_b", "c0");

    const sourceMap = new Map([
      ["hash_a", "function fnA() { return 1; }"],
      ["hash_b", "function fnB() { return 2; }"],
    ]);

    let capturedContext: L1CommunityContext | null = null;
    const mockL1 = async (ctx: L1CommunityContext) => {
      capturedContext = ctx;
      return {
        title: "Test Subsystem",
        documentation: "# Test",
        meta: {
          securityPosture: "",
          dataClassification: [] as string[],
          boundaries: [] as string[],
          keyFunctions: ["fnA"],
          complexity: "low" as const,
        },
      };
    };

    const result = await summarizeCommunities(db, {
      sourceMap,
      _summarizeL1: mockL1,
    });

    expect(result.l1Summarized).toBe(1);
    expect(capturedContext).not.toBeNull();
    expect(capturedContext!.members[0].description).toContain("function fnA");
    expect(capturedContext!.members[1].description).toContain("function fnB");
    db.close();
  });

  it("raw-source cache does not collide with analysis-based cache", async () => {
    const db = createTestDb();
    insertFileFunction(db, "src/a.ts", "fnA", "hash_a");
    insertCommunity(db, "hash_a", "c0");
    insertAnalysisPair(db, "hash_a");

    let callCount = 0;
    const mockL1 = async () => {
      callCount++;
      return {
        title: "Test",
        documentation: "# Test",
        meta: {
          securityPosture: "",
          dataClassification: [] as string[],
          boundaries: [] as string[],
          keyFunctions: ["fnA"],
          complexity: "low" as const,
        },
      };
    };

    // Run 1: normal mode
    await summarizeCommunities(db, { _summarizeL1: mockL1 });
    expect(callCount).toBe(1);

    // Run 2: raw-source mode -- should NOT get cache hit (different input hash)
    const sourceMap = new Map([["hash_a", "function fnA() {}"]]);
    await summarizeCommunities(db, { sourceMap, _summarizeL1: mockL1 });
    expect(callCount).toBe(2); // called again, not cached
    db.close();
  });
});

// ============ PACKAGE BREAKDOWN ============

describe("computePackageBreakdown", () => {
  it("counts members per package using resolver", () => {
    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", { dir: "/repo/packages/core", exports: {} }],
        ["@ophan/cli", { dir: "/repo/packages/cli", exports: {} }],
      ]),
      pathAliases: new Map(),
    };
    const members = [
      { filePath: "/repo/packages/core/src/a.ts" },
      { filePath: "/repo/packages/core/src/b.ts" },
      { filePath: "/repo/packages/cli/src/c.ts" },
    ];
    const breakdown = computePackageBreakdown(members, "/repo", resolver);
    expect(breakdown).toEqual({ "@ophan/core": 2, "@ophan/cli": 1 });
  });

  it("falls back to first directory segment without resolver", () => {
    const members = [
      { filePath: "/repo/packages/core/src/a.ts" },
      { filePath: "/repo/src/main.ts" },
    ];
    const breakdown = computePackageBreakdown(members, "/repo");
    expect(breakdown).toEqual({ packages: 1, src: 1 });
  });

  it("returns root for files directly in rootPath", () => {
    const members = [{ filePath: "/repo/index.ts" }];
    const breakdown = computePackageBreakdown(members, "/repo");
    expect(breakdown).toEqual({ root: 1 });
  });

  it("handles empty members", () => {
    const breakdown = computePackageBreakdown([], "/repo");
    expect(breakdown).toEqual({});
  });
});

describe("formatPackageBreakdown", () => {
  it("formats as percentage string sorted by count", () => {
    const result = formatPackageBreakdown({ core: 4, cli: 1 });
    expect(result).toBe("core (80%), cli (20%)");
  });

  it("returns empty string for empty breakdown", () => {
    expect(formatPackageBreakdown({})).toBe("");
  });

  it("formats single package as 100%", () => {
    expect(formatPackageBreakdown({ core: 3 })).toBe("core (100%)");
  });

  it("sorts by count descending", () => {
    const result = formatPackageBreakdown({ cli: 1, core: 3, webapp: 2 });
    expect(result).toBe("core (50%), webapp (33%), cli (17%)");
  });
});

describe("buildL1Context with rootPath", () => {
  it("includes packageInfo when rootPath is provided", () => {
    const db = createTestDb();
    insertFileFunction(db, "/repo/packages/core/src/a.ts", "fnA", "hash_a");
    insertFileFunction(db, "/repo/packages/core/src/b.ts", "fnB", "hash_b");
    insertCommunity(db, "hash_a", "c1", 0);
    insertCommunity(db, "hash_b", "c1", 0);
    insertAnalysisPair(db, "hash_a");
    insertAnalysisPair(db, "hash_b");

    const ctx = buildL1Context(db, "c1", "louvain", "/repo");
    expect(ctx).not.toBeNull();
    // Without a resolver, falls back to first directory segment
    expect(ctx!.packageInfo).toBe("packages (100%)");
    db.close();
  });

  it("omits packageInfo when rootPath is not provided", () => {
    const db = createTestDb();
    insertFileFunction(db, "/repo/packages/core/src/a.ts", "fnA", "hash_a");
    insertCommunity(db, "hash_a", "c1", 0);
    insertAnalysisPair(db, "hash_a");

    const ctx = buildL1Context(db, "c1", "louvain");
    expect(ctx).not.toBeNull();
    expect(ctx!.packageInfo).toBeUndefined();
    db.close();
  });
});
