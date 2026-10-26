import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, insertFileFunction, insertEdge } from "./test-utils";
import {
  DEFAULT_GRAPH_CONFIG,
  computePackage,
  computeDirectoryDistance,
  resolveEdges,
  storeEdges,
  storeEdgesIncremental,
  loadEdges,
  buildGraph,
  loadGraphConfig,
  saveGraphConfig,
  computeCentrality,
  computeChangedHashes,
  addTransitiveEdges,
  storeTransitiveEdges,
  buildFunctionGraph,
  type GraphConfig,
  type FunctionEdge,
  type ModuleResolver,
} from "./graph";
import type { FunctionInfo } from "./shared";

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

// ============ CONFIG PERSISTENCE ============

describe("GraphConfig persistence", () => {
  it("returns defaults when no config is saved", () => {
    const config = loadGraphConfig(db);
    expect(config).toEqual(DEFAULT_GRAPH_CONFIG);
  });

  it("round-trips config through save/load", () => {
    const custom: GraphConfig = {
      ...DEFAULT_GRAPH_CONFIG,
      algorithm: "label-propagation",
      resolution: 1.5,
      minCommunitySize: 5,
    };
    saveGraphConfig(db, custom);
    const loaded = loadGraphConfig(db);
    expect(loaded).toEqual(custom);
  });

  it("merges partial stored config with defaults", () => {
    // Simulate a config that only has some fields
    db.prepare("INSERT INTO graph_config (key, value) VALUES ('config', ?)").run(
      JSON.stringify({ resolution: 2.0 })
    );
    const loaded = loadGraphConfig(db);
    expect(loaded.resolution).toBe(2.0);
    expect(loaded.algorithm).toBe("leiden"); // default
    expect(loaded.edgeWeights).toEqual(DEFAULT_GRAPH_CONFIG.edgeWeights);
  });

  it("returns defaults on corrupt JSON", () => {
    db.prepare("INSERT INTO graph_config (key, value) VALUES ('config', ?)").run(
      "not-json"
    );
    const loaded = loadGraphConfig(db);
    expect(loaded).toEqual(DEFAULT_GRAPH_CONFIG);
  });
});

// ============ EDGE RESOLUTION ============

describe("resolveEdges", () => {
  it("resolves call edges from function names to content hashes", () => {
    // Set up file_functions: two functions where fnA calls fnB
    insertFileFunction(db, "/src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "/src/a.ts", "fnB", "hashB");

    const functions: FunctionInfo[] = [
      {
        name: "fnA",
        filePath: "/src/a.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function fnA() { fnB(); }",
        contentHash: "hashA",
        language: "typescript",
        entityType: "function",
        calls: ["fnB"],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const callEdges = edges.filter((e) => e.edgeType === "call");
    expect(callEdges).toHaveLength(1);
    expect(callEdges[0]).toMatchObject({
      sourceHash: "hashA",
      targetHash: "hashB",
      edgeType: "call",
      weight: DEFAULT_GRAPH_CONFIG.edgeWeights.call,
    });
  });

  it("skips self-calls", () => {
    insertFileFunction(db, "/src/a.ts", "recursive", "hashR");

    const functions: FunctionInfo[] = [
      {
        name: "recursive",
        filePath: "/src/a.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function recursive() { recursive(); }",
        contentHash: "hashR",
        language: "typescript",
        entityType: "function",
        calls: ["recursive"],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const callEdges = edges.filter((e) => e.edgeType === "call");
    expect(callEdges).toHaveLength(0);
  });

  it("creates co-location edges for functions in the same file", () => {
    insertFileFunction(db, "/src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "/src/a.ts", "fnB", "hashB");
    insertFileFunction(db, "/src/b.ts", "fnC", "hashC");

    const functions: FunctionInfo[] = [
      {
        name: "fnA",
        filePath: "/src/a.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function fnA() {}",
        contentHash: "hashA",
        language: "typescript",
        entityType: "function",
      },
      {
        name: "fnB",
        filePath: "/src/a.ts",
        startLine: 6,
        endLine: 10,
        sourceCode: "function fnB() {}",
        contentHash: "hashB",
        language: "typescript",
        entityType: "function",
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const colocEdges = edges.filter((e) => e.edgeType === "co_location");
    expect(colocEdges).toHaveLength(1);
    expect(colocEdges[0].weight).toBe(DEFAULT_GRAPH_CONFIG.edgeWeights.co_location);
  });

  it("avoids duplicate co-location edges (only one direction)", () => {
    insertFileFunction(db, "/src/a.ts", "fn1", "aaa");
    insertFileFunction(db, "/src/a.ts", "fn2", "bbb");

    const functions: FunctionInfo[] = [
      {
        name: "fn1", filePath: "/src/a.ts", startLine: 1, endLine: 5,
        sourceCode: "x", contentHash: "aaa", language: "typescript", entityType: "function",
      },
      {
        name: "fn2", filePath: "/src/a.ts", startLine: 6, endLine: 10,
        sourceCode: "y", contentHash: "bbb", language: "typescript", entityType: "function",
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const colocEdges = edges.filter((e) => e.edgeType === "co_location");
    // Should be exactly 1, not 2
    expect(colocEdges).toHaveLength(1);
  });

  it("skips calls to unknown functions", () => {
    insertFileFunction(db, "/src/a.ts", "fnA", "hashA");

    const functions: FunctionInfo[] = [
      {
        name: "fnA",
        filePath: "/src/a.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function fnA() { unknownFn(); }",
        contentHash: "hashA",
        language: "typescript",
        entityType: "function",
        calls: ["unknownFn"],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    expect(edges.filter((e) => e.edgeType === "call")).toHaveLength(0);
  });

  it("creates import edges for relative imports between files", () => {
    insertFileFunction(db, "/src/auth.ts", "login", "hashLogin");
    insertFileFunction(db, "/src/utils.ts", "validate", "hashValidate");
    insertFileFunction(db, "/src/utils.ts", "sanitize", "hashSanitize");

    const functions: FunctionInfo[] = [
      {
        name: "login",
        filePath: "/src/auth.ts",
        startLine: 1,
        endLine: 10,
        sourceCode: "function login() {}",
        contentHash: "hashLogin",
        language: "typescript",
        entityType: "function",
        imports: [{ module: "./utils", names: ["validate"] }],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges.length).toBeGreaterThanOrEqual(1);
    expect(importEdges[0].weight).toBe(DEFAULT_GRAPH_CONFIG.edgeWeights.import);
    // Should connect to functions in the target file
    const targetHashes = importEdges.map((e) =>
      e.sourceHash === "hashLogin" ? e.targetHash : e.sourceHash
    );
    expect(targetHashes).toContain("hashValidate");
  });

  it("creates both call and import edges for cross-file function usage", () => {
    // Simulates: Header component imports getViewTitle from ../navigation and calls it
    insertFileFunction(db, "/src/components/Header.tsx", "Header", "hashHeader");
    insertFileFunction(db, "/src/navigation.ts", "getViewTitle", "hashGetViewTitle");

    const functions: FunctionInfo[] = [
      {
        name: "Header",
        filePath: "/src/components/Header.tsx",
        startLine: 1,
        endLine: 20,
        sourceCode: "const Header = () => { getViewTitle(route); }",
        contentHash: "hashHeader",
        language: "typescript",
        entityType: "function",
        calls: ["getViewTitle"],
        imports: [{ module: "../navigation", names: ["getViewTitle"] }],
      },
      {
        name: "getViewTitle",
        filePath: "/src/navigation.ts",
        startLine: 1,
        endLine: 10,
        sourceCode: "function getViewTitle() {}",
        contentHash: "hashGetViewTitle",
        language: "typescript",
        entityType: "function",
        exported: true,
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);

    // Should have a call edge: Header → getViewTitle
    const callEdges = edges.filter((e) => e.edgeType === "call");
    expect(callEdges).toHaveLength(1);
    expect(callEdges[0].weight).toBe(DEFAULT_GRAPH_CONFIG.edgeWeights.call);

    // Should have an import edge: Header ↔ getViewTitle
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0].weight).toBe(DEFAULT_GRAPH_CONFIG.edgeWeights.import);
  });

  it("co-location edges connect all pairs in file with distance decay", () => {
    // Create a file with 10 functions at sequential lines
    const functions: FunctionInfo[] = [];
    for (let i = 0; i < 10; i++) {
      const hash = `hash_${String(i).padStart(2, "0")}`;
      insertFileFunction(db, "/src/big.ts", `fn${i}`, hash);
      functions.push({
        name: `fn${i}`,
        filePath: "/src/big.ts",
        startLine: i * 10 + 1,
        endLine: i * 10 + 9,
        sourceCode: `function fn${i}() {}`,
        contentHash: hash,
        language: "typescript",
        entityType: "function",
      });
    }

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const colocEdges = edges.filter((e) => e.edgeType === "co_location");

    // All-pairs: N*(N-1)/2 = 45 edges
    expect(colocEdges.length).toBe(45);

    // Verify weight structure: adjacent = full weight, distance 2 = half, distance N = 1/N
    const fullWeight = DEFAULT_GRAPH_CONFIG.edgeWeights.co_location;
    const adjacentEdges = colocEdges.filter((e) => Math.abs(e.weight - fullWeight) < 0.001);
    expect(adjacentEdges).toHaveLength(9);

    // Distance 2 edges get half weight
    const halfWeight = fullWeight / 2;
    const dist2Edges = colocEdges.filter((e) => Math.abs(e.weight - halfWeight) < 0.001);
    expect(dist2Edges).toHaveLength(8);
  });

  it("import edges target only imported names, not all functions in target file", () => {
    insertFileFunction(db, "/src/auth.ts", "login", "hashLogin");
    insertFileFunction(db, "/src/utils.ts", "validate", "hashValidate");
    insertFileFunction(db, "/src/utils.ts", "sanitize", "hashSanitize");
    insertFileFunction(db, "/src/utils.ts", "format", "hashFormat");

    const functions: FunctionInfo[] = [
      {
        name: "login",
        filePath: "/src/auth.ts",
        startLine: 1,
        endLine: 10,
        sourceCode: "function login() {}",
        contentHash: "hashLogin",
        language: "typescript",
        entityType: "function",
        imports: [{ module: "./utils", names: ["validate"] }],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const importEdges = edges.filter((e) => e.edgeType === "import");

    // Should only have edge to validate, NOT sanitize or format
    expect(importEdges).toHaveLength(1);
    const targetHashes = importEdges.map((e) =>
      e.sourceHash === "hashLogin" ? e.targetHash : e.sourceHash
    );
    expect(targetHashes).toContain("hashValidate");
    expect(targetHashes).not.toContain("hashSanitize");
    expect(targetHashes).not.toContain("hashFormat");
  });

  it("namespace import falls back to fn.calls intersection with target file", () => {
    insertFileFunction(db, "/src/handler.ts", "handleRequest", "hashHandler");
    insertFileFunction(db, "/src/utils.ts", "validate", "hashValidate");
    insertFileFunction(db, "/src/utils.ts", "sanitize", "hashSanitize");
    insertFileFunction(db, "/src/utils.ts", "format", "hashFormat");

    const functions: FunctionInfo[] = [
      {
        name: "handleRequest",
        filePath: "/src/handler.ts",
        startLine: 1,
        endLine: 20,
        sourceCode: "function handleRequest() { validate(); }",
        contentHash: "hashHandler",
        language: "typescript",
        entityType: "function",
        // Namespace import: names contains non-function identifier
        imports: [{ module: "./utils", names: ["utils"] }],
        calls: ["validate"],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const importEdges = edges.filter((e) => e.edgeType === "import");

    // Named import "utils" doesn't match any function → fallback to fn.calls
    // "validate" is called AND exists in target file → edge created
    expect(importEdges).toHaveLength(1);
    const targetHash =
      importEdges[0].sourceHash === "hashHandler"
        ? importEdges[0].targetHash
        : importEdges[0].sourceHash;
    expect(targetHash).toBe("hashValidate");
  });

  it("skips non-relative imports (external packages)", () => {
    insertFileFunction(db, "/src/auth.ts", "login", "hashLogin");

    const functions: FunctionInfo[] = [
      {
        name: "login",
        filePath: "/src/auth.ts",
        startLine: 1,
        endLine: 10,
        sourceCode: "function login() {}",
        contentHash: "hashLogin",
        language: "typescript",
        entityType: "function",
        imports: [
          { module: "express", names: ["Router"] },
          { module: "fs", names: ["readFileSync"] },
        ],
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(0);
  });
});

// ============ CO-LOCATION (SAME-FILE ONLY) ============

describe("resolveEdges co-location is same-file only", () => {
  it("does not create cross-file edges for functions in the same directory", () => {
    insertFileFunction(db, "/src/utils/format.ts", "formatDate", "hashFormat");
    insertFileFunction(db, "/src/utils/validate.ts", "validateEmail", "hashValidate");

    const functions: FunctionInfo[] = [
      {
        name: "formatDate",
        filePath: "/src/utils/format.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function formatDate() {}",
        contentHash: "hashFormat",
        language: "typescript",
        entityType: "function",
      },
      {
        name: "validateEmail",
        filePath: "/src/utils/validate.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function validateEmail() {}",
        contentHash: "hashValidate",
        language: "typescript",
        entityType: "function",
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    // Cross-file: no co-location edges (import/call/jsx_ref handle cross-file)
    expect(edges).toHaveLength(0);
  });

  it("creates same-file co-location edges", () => {
    insertFileFunction(db, "/src/utils/helpers.ts", "fnA", "hashA");
    insertFileFunction(db, "/src/utils/helpers.ts", "fnB", "hashB");

    const functions: FunctionInfo[] = [
      {
        name: "fnA",
        filePath: "/src/utils/helpers.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function fnA() {}",
        contentHash: "hashA",
        language: "typescript",
        entityType: "function",
      },
      {
        name: "fnB",
        filePath: "/src/utils/helpers.ts",
        startLine: 10,
        endLine: 15,
        sourceCode: "function fnB() {}",
        contentHash: "hashB",
        language: "typescript",
        entityType: "function",
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const colocEdges = edges.filter((e) => e.edgeType === "co_location");
    expect(colocEdges).toHaveLength(1);
    expect(colocEdges[0].weight).toBe(
      DEFAULT_GRAPH_CONFIG.edgeWeights.co_location
    );
  });

  it("produces no edges for a single-function file", () => {
    insertFileFunction(db, "/src/lonely/only.ts", "lonely", "hashLonely");

    const functions: FunctionInfo[] = [
      {
        name: "lonely",
        filePath: "/src/lonely/only.ts",
        startLine: 1,
        endLine: 5,
        sourceCode: "function lonely() {}",
        contentHash: "hashLonely",
        language: "typescript",
        entityType: "function",
      },
    ];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    expect(edges).toHaveLength(0);
  });
});

// ============ MODULE RESOLUTION ============

describe("resolveEdges with ModuleResolver", () => {
  it("resolves workspace package imports to actual file paths", () => {
    insertFileFunction(db, "/repo/packages/core/src/schemas.ts", "parseDoc", "hashParseDoc");
    insertFileFunction(db, "/repo/packages/webapp/src/page.ts", "renderPage", "hashRenderPage");

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts", "./schemas": "./src/schemas.ts" },
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "renderPage",
      filePath: "/repo/packages/webapp/src/page.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function renderPage() {}",
      contentHash: "hashRenderPage",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@ophan/core/schemas", names: ["parseDoc"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
  });

  it("resolves workspace package root import via exports '.' entry", () => {
    insertFileFunction(db, "/repo/packages/core/src/index.ts", "analyze", "hashAnalyze");
    insertFileFunction(db, "/repo/packages/cli/src/main.ts", "run", "hashRun");

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts" },
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "run",
      filePath: "/repo/packages/cli/src/main.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function run() {}",
      contentHash: "hashRun",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@ophan/core", names: ["analyze"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
  });

  it("resolves path alias imports (@/ → src/)", () => {
    insertFileFunction(db, "/repo/packages/webapp/src/utils/auth.ts", "login", "hashLogin");
    insertFileFunction(db, "/repo/packages/webapp/src/page.ts", "renderPage", "hashRenderPage");

    const resolver: ModuleResolver = {
      workspacePackages: new Map(),
      pathAliases: new Map([
        ["/repo/packages/webapp", {
          baseUrl: "/repo/packages/webapp",
          paths: { "@/*": ["./src/*"] },
        }],
      ]),
    };

    const functions: FunctionInfo[] = [{
      name: "renderPage",
      filePath: "/repo/packages/webapp/src/page.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function renderPage() {}",
      contentHash: "hashRenderPage",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@/utils/auth", names: ["login"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
  });

  it("still skips true external packages even with resolver", () => {
    insertFileFunction(db, "/src/auth.ts", "login", "hashLogin");

    const resolver: ModuleResolver = {
      workspacePackages: new Map(),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "login",
      filePath: "/src/auth.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function login() {}",
      contentHash: "hashLogin",
      language: "typescript",
      entityType: "function",
      imports: [
        { module: "express", names: ["Router"] },
        { module: "fs", names: ["readFileSync"] },
        { module: "@tabler/icons-react", names: ["IconBrandVscode"] },
      ],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(0);
  });

  it("workspace fallback resolves subpath via src/ convention", () => {
    // Package has no exports map entry for this subpath
    insertFileFunction(db, "/repo/packages/core/src/graph.ts", "buildGraph", "hashBuildGraph");
    insertFileFunction(db, "/repo/packages/cli/src/main.ts", "run", "hashRun");

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts" },  // no "./graph" export
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "run",
      filePath: "/repo/packages/cli/src/main.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function run() {}",
      contentHash: "hashRun",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@ophan/core/graph", names: ["buildGraph"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
  });

  it("without resolver, non-relative imports are still skipped", () => {
    insertFileFunction(db, "/repo/packages/core/src/schemas.ts", "parseDoc", "hashParseDoc");
    insertFileFunction(db, "/repo/packages/webapp/src/page.ts", "renderPage", "hashRenderPage");

    const functions: FunctionInfo[] = [{
      name: "renderPage",
      filePath: "/repo/packages/webapp/src/page.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function renderPage() {}",
      contentHash: "hashRenderPage",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@ophan/core/schemas", names: ["parseDoc"] }],
    }];

    // No resolver passed -- backward compatible behavior
    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(0);
  });

  it("resolves re-exports through barrel files via package-scoped fallback", () => {
    // computeHash is defined in shared.ts, but re-exported from index.ts
    // The barrel file (index.ts) has its OWN functions but not computeHash
    insertFileFunction(db, "/repo/packages/core/src/shared.ts", "computeHash", "hashComputeHash");
    insertFileFunction(db, "/repo/packages/core/src/index.ts", "initDb", "hashInitDb");
    insertFileFunction(db, "/repo/packages/cli/src/main.ts", "runCli", "hashRunCli");

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts" },
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "runCli",
      filePath: "/repo/packages/cli/src/main.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function runCli() {}",
      contentHash: "hashRunCli",
      language: "typescript",
      entityType: "function",
      // Import computeHash from @ophan/core -- it's re-exported via index.ts barrel
      imports: [{ module: "@ophan/core", names: ["computeHash"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
    const targetHash = importEdges[0].sourceHash === "hashRunCli"
      ? importEdges[0].targetHash : importEdges[0].sourceHash;
    expect(targetHash).toBe("hashComputeHash");
  });

  it("barrel file fallback only matches specific imported names, not all package functions", () => {
    insertFileFunction(db, "/repo/packages/core/src/shared.ts", "computeHash", "hashComputeHash");
    insertFileFunction(db, "/repo/packages/core/src/graph.ts", "buildGraph", "hashBuildGraph");
    insertFileFunction(db, "/repo/packages/core/src/index.ts", "initDb", "hashInitDb");
    insertFileFunction(db, "/repo/packages/cli/src/main.ts", "runCli", "hashRunCli");

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts" },
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "runCli",
      filePath: "/repo/packages/cli/src/main.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function runCli() {}",
      contentHash: "hashRunCli",
      language: "typescript",
      entityType: "function",
      // Only imports computeHash, not buildGraph or initDb
      imports: [{ module: "@ophan/core", names: ["computeHash"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");

    // Should only have edge to computeHash
    expect(importEdges).toHaveLength(1);
    const hashes = importEdges.flatMap((e) => [e.sourceHash, e.targetHash]);
    expect(hashes).toContain("hashComputeHash");
    expect(hashes).not.toContain("hashBuildGraph");
    expect(hashes).not.toContain("hashInitDb");
  });

  it("pure barrel file (no own functions) still creates edges via package fallback", () => {
    // Barrel file has NO functions -- only re-exports
    insertFileFunction(db, "/repo/packages/core/src/shared.ts", "computeHash", "hashComputeHash");
    insertFileFunction(db, "/repo/packages/cli/src/main.ts", "runCli", "hashRunCli");
    // NOTE: no insertFileFunction for index.ts -- it's a pure barrel

    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", {
          dir: "/repo/packages/core",
          exports: { ".": "./src/index.ts" },
        }],
      ]),
      pathAliases: new Map(),
    };

    const functions: FunctionInfo[] = [{
      name: "runCli",
      filePath: "/repo/packages/cli/src/main.ts",
      startLine: 1, endLine: 10,
      sourceCode: "function runCli() {}",
      contentHash: "hashRunCli",
      language: "typescript",
      entityType: "function",
      imports: [{ module: "@ophan/core", names: ["computeHash"] }],
    }];

    const edges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, undefined, resolver);
    const importEdges = edges.filter((e) => e.edgeType === "import");
    expect(importEdges).toHaveLength(1);
  });
});

// ============ EDGE STORAGE ============

describe("edge storage", () => {
  it("stores and loads edges", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "co_location", weight: 0.3 },
    ];

    storeEdges(db, edges);
    const loaded = loadEdges(db);

    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({ sourceHash: "a", targetHash: "b", edgeType: "call" });
  });

  it("clears old edges before storing new ones", () => {
    storeEdges(db, [
      { sourceHash: "old", targetHash: "data", edgeType: "call", weight: 1.0 },
    ]);
    storeEdges(db, [
      { sourceHash: "new", targetHash: "data", edgeType: "call", weight: 1.0 },
    ]);

    const loaded = loadEdges(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].sourceHash).toBe("new");
  });
});

// ============ GRAPH CONSTRUCTION ============

describe("buildGraph", () => {
  it("creates undirected graph from edges", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 0.8 },
    ];

    const graph = buildGraph(edges);
    expect(graph.order).toBe(3); // 3 nodes
    expect(graph.size).toBe(2); // 2 edges
  });

  it("merges parallel edges (different types, same pair) by summing weights", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "a", targetHash: "b", edgeType: "co_location", weight: 0.3 },
    ];

    const graph = buildGraph(edges);
    expect(graph.size).toBe(1); // merged into single edge
    // Weight should be summed: 1.0 + 0.3
    const attrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(attrs.weight).toBeCloseTo(1.3);
  });

  it("returns empty graph for no edges", () => {
    const graph = buildGraph([]);
    expect(graph.order).toBe(0);
    expect(graph.size).toBe(0);
  });

  it("includes all hashes as nodes even without edges", () => {
    const allHashes = new Set(["a", "b", "c", "d"]);
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];

    const graph = buildGraph(edges, undefined, undefined, undefined, allHashes);
    // All 4 hashes should be nodes, even though c and d have no edges
    expect(graph.order).toBe(4);
    expect(graph.size).toBe(1); // only 1 edge
    expect(graph.hasNode("c")).toBe(true);
    expect(graph.hasNode("d")).toBe(true);
  });

  it("isolated nodes (no edges) still appear in graph with allHashes", () => {
    const allHashes = new Set(["x", "y", "z"]);
    const graph = buildGraph([], undefined, undefined, undefined, allHashes);
    expect(graph.order).toBe(3);
    expect(graph.size).toBe(0);
  });
});

// ============ CENTRALITY ============

describe("computeCentrality", () => {
  it("returns empty result for empty graph", () => {
    const graph = buildGraph([]);
    const result = computeCentrality(graph);
    expect(result.scores.size).toBe(0);
    expect(result.ranked).toHaveLength(0);
  });

  it("identifies bridge node as highest centrality in barbell graph", () => {
    // Barbell: two clusters connected by a single bridge
    const edges: FunctionEdge[] = [
      // Cluster A
      { sourceHash: "a1", targetHash: "a2", edgeType: "call", weight: 1.0 },
      { sourceHash: "a1", targetHash: "a3", edgeType: "call", weight: 1.0 },
      { sourceHash: "a2", targetHash: "a3", edgeType: "call", weight: 1.0 },
      // Cluster B
      { sourceHash: "b1", targetHash: "b2", edgeType: "call", weight: 1.0 },
      { sourceHash: "b1", targetHash: "b3", edgeType: "call", weight: 1.0 },
      { sourceHash: "b2", targetHash: "b3", edgeType: "call", weight: 1.0 },
      // Bridge: a1 <-> b1
      { sourceHash: "a1", targetHash: "b1", edgeType: "call", weight: 1.0 },
    ];

    const graph = buildGraph(edges);
    const result = computeCentrality(graph);

    // Bridge nodes (a1, b1) should have highest centrality
    expect(result.ranked[0].contentHash).toMatch(/^(a1|b1)$/);
    expect(result.ranked[0].score).toBeGreaterThan(0);

    // Non-bridge nodes should have lower centrality
    const a2Score = result.scores.get("a2")!;
    const bridgeScore = result.scores.get(result.ranked[0].contentHash)!;
    expect(bridgeScore).toBeGreaterThan(a2Score);
  });

  it("returns normalized scores between 0 and 1", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];

    const graph = buildGraph(edges);
    const result = computeCentrality(graph);

    for (const { score } of result.ranked) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("ranked list is sorted descending by score", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "b", targetHash: "c", edgeType: "call", weight: 1.0 },
      { sourceHash: "c", targetHash: "d", edgeType: "call", weight: 1.0 },
    ];

    const graph = buildGraph(edges);
    const result = computeCentrality(graph);

    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
  });
});

// ============ INCREMENTAL EDGE UPDATES ============

describe("computeChangedHashes", () => {
  it("returns empty set when old and new are identical", () => {
    const old = new Set(["h1", "h2", "h3"]);
    const newH = new Set(["h1", "h2", "h3"]);
    expect(computeChangedHashes(old, newH).size).toBe(0);
  });

  it("returns symmetric difference", () => {
    const old = new Set(["h1", "h2", "h3"]);
    const newH = new Set(["h2", "h3", "h4"]);
    const changed = computeChangedHashes(old, newH);
    expect(changed).toEqual(new Set(["h1", "h4"])); // h1 removed, h4 added
  });

  it("handles first run (empty old)", () => {
    const old = new Set<string>();
    const newH = new Set(["h1", "h2"]);
    const changed = computeChangedHashes(old, newH);
    expect(changed).toEqual(new Set(["h1", "h2"]));
  });

  it("handles all functions removed", () => {
    const old = new Set(["h1", "h2"]);
    const newH = new Set<string>();
    const changed = computeChangedHashes(old, newH);
    expect(changed).toEqual(new Set(["h1", "h2"]));
  });
});

describe("storeEdgesIncremental", () => {
  it("deletes edges for affected hashes and inserts new ones", () => {
    // Pre-existing edges: h1→h2, h3→h4
    insertEdge(db, "h1", "h2", { weight: 1.0 });
    insertEdge(db, "h3", "h4", { weight: 1.0 });

    // Incrementally update edges for h1 (delete h1→h2, add h1→h5)
    const affected = new Set(["h1"]);
    const newEdges: FunctionEdge[] = [
      { sourceHash: "h1", targetHash: "h5", edgeType: "call", weight: 2.0 },
    ];
    storeEdgesIncremental(db, affected, newEdges);

    const all = loadEdges(db);
    // h1→h2 should be gone, h3→h4 should remain, h1→h5 should be added
    expect(all.find((e) => e.sourceHash === "h1" && e.targetHash === "h2")).toBeUndefined();
    expect(all.find((e) => e.sourceHash === "h3" && e.targetHash === "h4")).toBeDefined();
    expect(all.find((e) => e.sourceHash === "h1" && e.targetHash === "h5")).toBeDefined();
    expect(all.find((e) => e.sourceHash === "h1" && e.targetHash === "h5")!.weight).toBe(2.0);
  });

  it("also deletes edges where affected hash is the target", () => {
    // Edge: h3→h1 (h1 is the target)
    insertEdge(db, "h3", "h1", { weight: 1.0 });
    insertEdge(db, "h4", "h5", { weight: 1.0 });

    const affected = new Set(["h1"]);
    storeEdgesIncremental(db, affected, []);

    const all = loadEdges(db);
    // h3→h1 should be deleted (h1 is affected, even as target)
    expect(all.find((e) => e.targetHash === "h1")).toBeUndefined();
    // h4→h5 should remain
    expect(all.find((e) => e.sourceHash === "h4")).toBeDefined();
  });
});

describe("resolveEdges with affectedHashes", () => {
  it("only resolves edges for affected functions", () => {
    // 3 functions: fnA calls fnB, fnC calls fnB
    insertFileFunction(db, "/src/a.ts", "fnA", "hA");
    insertFileFunction(db, "/src/b.ts", "fnB", "hB");
    insertFileFunction(db, "/src/c.ts", "fnC", "hC");

    const functions: FunctionInfo[] = [
      {
        name: "fnA", filePath: "/src/a.ts", startLine: 1, endLine: 10,
        sourceCode: "fn fnA()", contentHash: "hA", language: "typescript",
        entityType: "function", calls: ["fnB"],
      },
      {
        name: "fnB", filePath: "/src/b.ts", startLine: 1, endLine: 10,
        sourceCode: "fn fnB()", contentHash: "hB", language: "typescript",
        entityType: "function",
      },
      {
        name: "fnC", filePath: "/src/c.ts", startLine: 1, endLine: 10,
        sourceCode: "fn fnC()", contentHash: "hC", language: "typescript",
        entityType: "function", calls: ["fnB"],
      },
    ];

    // Full resolve: should get edges from both fnA→fnB and fnC→fnB
    const allEdges = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG);
    const callEdges = allEdges.filter((e) => e.edgeType === "call");
    expect(callEdges.length).toBe(2);

    // Incremental: only resolve for fnA
    const partial = resolveEdges(db, functions, DEFAULT_GRAPH_CONFIG, new Set(["hA"]));
    const partialCalls = partial.filter((e) => e.edgeType === "call");
    // Should only have fnA→fnB, not fnC→fnB
    expect(partialCalls.length).toBe(1);
    expect(partialCalls[0].sourceHash).toBe("hA");
    expect(partialCalls[0].targetHash).toBe("hB");
  });
});

// ============ PACKAGE COMPUTATION ============

describe("computePackage", () => {
  it("uses resolver to find package name from workspace packages", () => {
    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", { dir: "/repo/packages/core", exports: {} }],
        ["@ophan/cli", { dir: "/repo/packages/cli", exports: {} }],
      ]),
      pathAliases: new Map(),
    };
    expect(computePackage("/repo/packages/core/src/graph.ts", "/repo", resolver)).toBe("@ophan/core");
    expect(computePackage("/repo/packages/cli/src/index.ts", "/repo", resolver)).toBe("@ophan/cli");
  });

  it("picks longest matching package dir when packages are nested", () => {
    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["root-pkg", { dir: "/repo", exports: {} }],
        ["@ophan/core", { dir: "/repo/packages/core", exports: {} }],
      ]),
      pathAliases: new Map(),
    };
    expect(computePackage("/repo/packages/core/src/graph.ts", "/repo", resolver)).toBe("@ophan/core");
  });

  it("falls back to first directory segment without resolver", () => {
    expect(computePackage("/repo/src/main.ts", "/repo")).toBe("src");
    expect(computePackage("/repo/packages/core/src/graph.ts", "/repo")).toBe("packages");
  });

  it("returns 'root' for files directly in rootPath without resolver", () => {
    expect(computePackage("/repo/index.ts", "/repo")).toBe("root");
  });

  it("falls back to first directory segment when resolver has no matching package", () => {
    const resolver: ModuleResolver = {
      workspacePackages: new Map([
        ["@ophan/core", { dir: "/repo/packages/core", exports: {} }],
      ]),
      pathAliases: new Map(),
    };
    expect(computePackage("/repo/scripts/build.ts", "/repo", resolver)).toBe("scripts");
  });
});

describe("computeDirectoryDistance", () => {
  it("returns 0 for files in the same directory", () => {
    expect(computeDirectoryDistance(
      "/repo/src/components/Button.tsx",
      "/repo/src/components/Input.tsx",
      "/repo"
    )).toBe(0);
  });

  it("returns 2 for files in sibling directories", () => {
    expect(computeDirectoryDistance(
      "/repo/src/components/Button.tsx",
      "/repo/src/utils/format.ts",
      "/repo"
    )).toBe(2);
  });

  it("returns 4 for files in different package subtrees", () => {
    expect(computeDirectoryDistance(
      "/repo/packages/core/src/graph.ts",
      "/repo/packages/webapp/src/App.tsx",
      "/repo"
    )).toBe(4);
  });

  it("returns 1 for parent-child directory relationship", () => {
    expect(computeDirectoryDistance(
      "/repo/src/index.ts",
      "/repo/src/utils/format.ts",
      "/repo"
    )).toBe(1);
  });

  it("returns correct distance for deeply nested files", () => {
    // core/src/parsers/fixtures (4 unique) + cli/src/commands (3 unique) = 7
    // common prefix: packages (1 segment)
    expect(computeDirectoryDistance(
      "/repo/packages/core/src/parsers/fixtures/test.ts",
      "/repo/packages/cli/src/commands/graph.ts",
      "/repo"
    )).toBe(7);
  });

  it("returns depth sum for completely different root subtrees", () => {
    expect(computeDirectoryDistance(
      "/repo/frontend/src/App.tsx",
      "/repo/backend/src/server.ts",
      "/repo"
    )).toBe(4);
  });
});

// ============ DIRECTORY DISTANCE DECAY ============

describe("buildGraph with directoryDecay", () => {
  const rootPath = "/repo";

  it("reduces weight for files in different directories", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    // Distance 2 (sibling dirs): exp(-0.1 * 2) ≈ 0.8187
    const hashToFilePath = new Map([
      ["a", "/repo/src/components/Button.tsx"],
      ["b", "/repo/src/utils/format.ts"],
    ]);

    const graph = buildGraph(edges, hashToFilePath, rootPath, 0.1);
    const edgeAttrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(edgeAttrs.weight).toBeCloseTo(Math.exp(-0.1 * 2));
  });

  it("does not reduce weight for files in the same directory", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    const hashToFilePath = new Map([
      ["a", "/repo/src/components/Button.tsx"],
      ["b", "/repo/src/components/Input.tsx"],
    ]);

    const graph = buildGraph(edges, hashToFilePath, rootPath, 0.1);
    const edgeAttrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(edgeAttrs.weight).toBeCloseTo(1.0);
  });

  it("decay=0 has no effect", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    const hashToFilePath = new Map([
      ["a", "/repo/packages/core/src/graph.ts"],
      ["b", "/repo/packages/webapp/src/App.tsx"],
    ]);

    const graph = buildGraph(edges, hashToFilePath, rootPath, 0);
    const edgeAttrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(edgeAttrs.weight).toBeCloseTo(1.0);
  });

  it("works without hashToFilePath (backward compat)", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];

    const graph = buildGraph(edges);
    const edgeAttrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(edgeAttrs.weight).toBeCloseTo(1.0);
  });

  it("applies decay per-edge before summing parallel edges", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
      { sourceHash: "a", targetHash: "b", edgeType: "co_location", weight: 0.3 },
    ];
    // Distance 4: exp(-0.1 * 4) ≈ 0.6703
    const hashToFilePath = new Map([
      ["a", "/repo/packages/core/src/graph.ts"],
      ["b", "/repo/packages/webapp/src/App.tsx"],
    ]);
    const decay = 0.1;
    const factor = Math.exp(-decay * 4);

    const graph = buildGraph(edges, hashToFilePath, rootPath, decay);
    const edgeAttrs = graph.getEdgeAttributes(graph.edges()[0]);
    expect(edgeAttrs.weight).toBeCloseTo(1.0 * factor + 0.3 * factor);
  });

  it("higher decay gives stronger penalty for same distance", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "a", targetHash: "b", edgeType: "call", weight: 1.0 },
    ];
    const hashToFilePath = new Map([
      ["a", "/repo/packages/core/src/graph.ts"],
      ["b", "/repo/packages/webapp/src/App.tsx"],
    ]);

    const graphLow = buildGraph(edges, hashToFilePath, rootPath, 0.05);
    const graphHigh = buildGraph(edges, hashToFilePath, rootPath, 0.3);
    const weightLow = graphLow.getEdgeAttributes(graphLow.edges()[0]).weight;
    const weightHigh = graphHigh.getEdgeAttributes(graphHigh.edges()[0]).weight;
    expect(weightLow).toBeGreaterThan(weightHigh as number);
  });
});

// ============ TRANSITIVE EDGES ============

describe("addTransitiveEdges", () => {
  const config = DEFAULT_GRAPH_CONFIG;

  it("creates transitive_call edges for 2-hop call chains (A→B→C)", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hB", targetHash: "hC", edgeType: "call", weight: 1.0 },
    ];
    const result = addTransitiveEdges(edges, config);
    const transitive = result.filter((e) => e.edgeType === "transitive_call");
    expect(transitive).toHaveLength(1);
    // Canonical ordering: hA < hC
    expect(transitive[0].sourceHash).toBe("hA");
    expect(transitive[0].targetHash).toBe("hC");
    expect(transitive[0].weight).toBe(config.edgeWeights.transitive_call);
  });

  it("skips self-loops in transitive calls (A→B→A)", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hB", targetHash: "hA", edgeType: "call", weight: 1.0 },
    ];
    const result = addTransitiveEdges(edges, config);
    const transitive = result.filter((e) => e.edgeType === "transitive_call");
    expect(transitive).toHaveLength(0);
  });

  it("stacks with existing direct edges (no dedup)", () => {
    // A→B→C AND A→C directly -- both the direct call and transitive should exist
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hB", targetHash: "hC", edgeType: "call", weight: 1.0 },
      { sourceHash: "hA", targetHash: "hC", edgeType: "call", weight: 1.0 },
    ];
    const result = addTransitiveEdges(edges, config);
    // Original 3 edges + 1 transitive_call A↔C + 1 co_caller B↔C (A calls both B and C)
    const transitive = result.filter((e) => e.edgeType === "transitive_call");
    expect(transitive).toHaveLength(1);
    const coCaller = result.filter((e) => e.edgeType === "co_caller");
    expect(coCaller).toHaveLength(1);
    expect(result.length).toBe(5); // 3 original + 1 transitive + 1 co_caller
  });

  it("creates co_caller edges for functions called by the same caller", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hA", targetHash: "hC", edgeType: "call", weight: 1.0 },
    ];
    const result = addTransitiveEdges(edges, config);
    const coCaller = result.filter((e) => e.edgeType === "co_caller");
    expect(coCaller).toHaveLength(1);
    expect(coCaller[0].sourceHash).toBe("hB");
    expect(coCaller[0].targetHash).toBe("hC");
    expect(coCaller[0].weight).toBe(config.edgeWeights.co_caller);
  });

  it("skips co_caller when a caller has more than 15 callees", () => {
    const edges: FunctionEdge[] = [];
    // Create 16 callees for one caller
    for (let i = 0; i < 16; i++) {
      edges.push({
        sourceHash: "hub",
        targetHash: `target_${String(i).padStart(2, "0")}`,
        edgeType: "call",
        weight: 1.0,
      });
    }
    const result = addTransitiveEdges(edges, config);
    const coCaller = result.filter((e) => e.edgeType === "co_caller");
    expect(coCaller).toHaveLength(0);
  });

  it("creates co_caller edges when caller has exactly 15 callees", () => {
    const edges: FunctionEdge[] = [];
    for (let i = 0; i < 15; i++) {
      edges.push({
        sourceHash: "hub",
        targetHash: `target_${String(i).padStart(2, "0")}`,
        edgeType: "call",
        weight: 1.0,
      });
    }
    const result = addTransitiveEdges(edges, config);
    const coCaller = result.filter((e) => e.edgeType === "co_caller");
    // C(15,2) = 105 co-caller edges
    expect(coCaller).toHaveLength(105);
  });

  it("returns original edges unchanged when no call edges exist", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "co_location", weight: 0.5 },
      { sourceHash: "hC", targetHash: "hD", edgeType: "import", weight: 0.5 },
    ];
    const result = addTransitiveEdges(edges, config);
    expect(result).toEqual(edges);
  });

  it("returns empty array for empty input", () => {
    const result = addTransitiveEdges([], config);
    expect(result).toEqual([]);
  });

  it("preserves all original edges in the output", () => {
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hB", targetHash: "hC", edgeType: "call", weight: 1.0 },
      { sourceHash: "hA", targetHash: "hB", edgeType: "co_location", weight: 0.5 },
    ];
    const result = addTransitiveEdges(edges, config);
    // All 3 originals should be present
    for (const edge of edges) {
      expect(result).toContainEqual(edge);
    }
    // Plus transitive and co-caller
    expect(result.length).toBeGreaterThan(3);
  });

  it("deduplicates within transitive_call edges (multiple paths)", () => {
    // A→B→D and A→C→D -- should create only one transitive A↔D
    const edges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 1.0 },
      { sourceHash: "hA", targetHash: "hC", edgeType: "call", weight: 1.0 },
      { sourceHash: "hB", targetHash: "hD", edgeType: "call", weight: 1.0 },
      { sourceHash: "hC", targetHash: "hD", edgeType: "call", weight: 1.0 },
    ];
    const result = addTransitiveEdges(edges, config);
    const transitiveAD = result.filter(
      (e) => e.edgeType === "transitive_call" &&
        ((e.sourceHash === "hA" && e.targetHash === "hD") ||
         (e.sourceHash === "hD" && e.targetHash === "hA"))
    );
    expect(transitiveAD).toHaveLength(1);
  });
});

// ============ TRANSITIVE EDGE STORAGE ============

describe("storeTransitiveEdges", () => {
  it("stores transitive edges in the database", () => {
    // Pre-populate some direct edges
    storeEdges(db, [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 0.5 },
    ]);

    const transitiveEdges: FunctionEdge[] = [
      { sourceHash: "hA", targetHash: "hC", edgeType: "transitive_call", weight: 0.4 },
      { sourceHash: "hB", targetHash: "hC", edgeType: "co_caller", weight: 0.4 },
    ];
    storeTransitiveEdges(db, transitiveEdges);

    const allEdges = loadEdges(db);
    expect(allEdges).toHaveLength(3); // 1 direct + 2 transitive
    expect(allEdges.filter((e) => e.edgeType === "transitive_call")).toHaveLength(1);
    expect(allEdges.filter((e) => e.edgeType === "co_caller")).toHaveLength(1);
    expect(allEdges.filter((e) => e.edgeType === "call")).toHaveLength(1);
  });

  it("replaces old transitive edges without touching direct edges", () => {
    storeEdges(db, [
      { sourceHash: "hA", targetHash: "hB", edgeType: "call", weight: 0.5 },
      { sourceHash: "hA", targetHash: "hC", edgeType: "import", weight: 0.2 },
    ]);
    // First batch of transitive
    storeTransitiveEdges(db, [
      { sourceHash: "hX", targetHash: "hY", edgeType: "transitive_call", weight: 0.4 },
    ]);
    // Replace with new batch
    storeTransitiveEdges(db, [
      { sourceHash: "hP", targetHash: "hQ", edgeType: "co_caller", weight: 0.4 },
    ]);

    const allEdges = loadEdges(db);
    expect(allEdges).toHaveLength(3); // 2 direct + 1 new transitive
    expect(allEdges.filter((e) => e.edgeType === "co_caller")).toHaveLength(1);
    expect(allEdges.filter((e) => e.edgeType === "transitive_call")).toHaveLength(0);
    // Direct edges untouched
    expect(allEdges.filter((e) => e.edgeType === "call")).toHaveLength(1);
    expect(allEdges.filter((e) => e.edgeType === "import")).toHaveLength(1);
  });
});

describe("buildFunctionGraph on a repo whose graph was never built", () => {
  it("builds edges even though no function changed since init/analyze", () => {
    // init/analyze fill file_functions, so oldHashes equals newHashes on the first `graph` run.
    insertFileFunction(db, "/src/a.ts", "caller", "hashCaller");
    insertFileFunction(db, "/src/a.ts", "callee", "hashCallee");
    const functions: FunctionInfo[] = [
      {
        name: "caller", filePath: "/src/a.ts", startLine: 1, endLine: 3,
        sourceCode: "function caller() { callee(); }", contentHash: "hashCaller",
        language: "typescript", entityType: "function", calls: ["callee"],
      },
      {
        name: "callee", filePath: "/src/a.ts", startLine: 5, endLine: 5,
        sourceCode: "function callee() {}", contentHash: "hashCallee",
        language: "typescript", entityType: "function",
      },
    ];
    const unchanged = new Set(["hashCaller", "hashCallee"]);

    const edges = buildFunctionGraph(db, functions, DEFAULT_GRAPH_CONFIG, unchanged);

    expect(edges.some((e) => e.edgeType === "call")).toBe(true);
    expect(loadEdges(db).length).toBeGreaterThan(0);
  });
});

describe("buildFunctionGraph stores transitive edges in DB", () => {
  it("stores transitive_call and co_caller edges alongside direct edges", () => {
    // Setup: A calls B, B calls C → transitive A↔C; A calls B and C → co-caller B↔C
    insertFileFunction(db, "/src/a.ts", "fnA", "hashA");
    insertFileFunction(db, "/src/a.ts", "fnB", "hashB");
    insertFileFunction(db, "/src/a.ts", "fnC", "hashC");

    const functions: FunctionInfo[] = [
      {
        name: "fnA", filePath: "/src/a.ts", startLine: 1, endLine: 5,
        sourceCode: "function fnA() { fnB(); fnC(); }", contentHash: "hashA",
        language: "typescript", entityType: "function",
        calls: ["fnB", "fnC"],
      },
      {
        name: "fnB", filePath: "/src/a.ts", startLine: 10, endLine: 15,
        sourceCode: "function fnB() { fnC(); }", contentHash: "hashB",
        language: "typescript", entityType: "function",
        calls: ["fnC"],
      },
      {
        name: "fnC", filePath: "/src/a.ts", startLine: 20, endLine: 25,
        sourceCode: "function fnC() {}", contentHash: "hashC",
        language: "typescript", entityType: "function",
      },
    ];

    buildFunctionGraph(db, functions, DEFAULT_GRAPH_CONFIG);

    // Load from DB -- should include transitive edges
    const storedEdges = loadEdges(db);
    const types = new Set(storedEdges.map((e) => e.edgeType));
    expect(types).toContain("call");
    expect(types).toContain("co_location");
    expect(types).toContain("transitive_call");
    expect(types).toContain("co_caller");
  });
});
