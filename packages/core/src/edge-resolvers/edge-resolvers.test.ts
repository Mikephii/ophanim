import { describe, it, expect } from "vitest";
import { CallEdgeResolver } from "./call";
import { JsxRefEdgeResolver } from "./jsx-ref";
import { CoLocationEdgeResolver } from "./co-location";
import { ImportEdgeResolver } from "./import";
import { getEdgeResolvers, registerEdgeResolver } from "./index";
import type { EdgeResolverContext } from "./types";
import type { FunctionInfo } from "../shared";
import { DEFAULT_GRAPH_CONFIG } from "../graph";

/** Helper to build a minimal EdgeResolverContext for testing. */
function buildCtx(
  functions: FunctionInfo[],
  overrides: Partial<EdgeResolverContext> = {},
): EdgeResolverContext {
  const nameToHashes = new Map<string, Set<string>>();
  const fileToHashes = new Map<string, Set<string>>();
  const fileNameToHash = new Map<string, string>();
  const fileToSortedFns = new Map<string, FunctionInfo[]>();

  for (const fn of functions) {
    // nameToHashes
    const names = nameToHashes.get(fn.name) || new Set();
    names.add(fn.contentHash);
    nameToHashes.set(fn.name, names);

    // fileToHashes
    const hashes = fileToHashes.get(fn.filePath) || new Set();
    hashes.add(fn.contentHash);
    fileToHashes.set(fn.filePath, hashes);

    // fileNameToHash
    fileNameToHash.set(`${fn.filePath}::${fn.name}`, fn.contentHash);

    // fileToSortedFns
    const sorted = fileToSortedFns.get(fn.filePath) || [];
    sorted.push(fn);
    fileToSortedFns.set(fn.filePath, sorted);
  }

  for (const fns of fileToSortedFns.values()) {
    fns.sort((a, b) => a.startLine - b.startLine);
  }

  return {
    nameToHashes,
    fileToHashes,
    fileNameToHash,
    pkgNameToHashes: new Map(),
    fileToSortedFns,
    functions,
    config: DEFAULT_GRAPH_CONFIG,
    ...overrides,
  };
}

function makeFn(
  name: string,
  hash: string,
  filePath: string,
  opts: Partial<FunctionInfo> = {},
): FunctionInfo {
  return {
    name,
    contentHash: hash,
    filePath,
    startLine: opts.startLine ?? 1,
    sourceCode: opts.sourceCode ?? `function ${name}() {}`,
    language: opts.language ?? "typescript",
    entityType: opts.entityType ?? "function",
    calls: opts.calls,
    imports: opts.imports,
    exported: opts.exported,
    jsxRefs: opts.jsxRefs,
  };
}

// ============ CallEdgeResolver ============

describe("CallEdgeResolver", () => {
  const resolver = new CallEdgeResolver();

  it("creates call edges from fn.calls to matching names", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", { startLine: 1, calls: ["fnB"] });
    const fnB = makeFn("fnB", "hashB", "/src/b.ts", { startLine: 1 });
    const ctx = buildCtx([fnA, fnB]);
    const edges = resolver.resolve(ctx);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceHash: "hashA",
      targetHash: "hashB",
      edgeType: "call",
      weight: DEFAULT_GRAPH_CONFIG.edgeWeights.call,
    });
  });

  it("skips self-calls", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", { calls: ["fnA"] });
    const ctx = buildCtx([fnA]);
    const edges = resolver.resolve(ctx);
    expect(edges).toHaveLength(0);
  });

  it("creates edges to all matching hashes for ambiguous names", () => {
    const caller = makeFn("caller", "hashCaller", "/src/a.ts", { calls: ["helper"] });
    const helper1 = makeFn("helper", "hashH1", "/src/b.ts", { startLine: 1 });
    const helper2 = makeFn("helper", "hashH2", "/src/c.ts", { startLine: 1 });
    const ctx = buildCtx([caller, helper1, helper2]);
    const edges = resolver.resolve(ctx);

    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.targetHash).sort();
    expect(targets).toEqual(["hashH1", "hashH2"]);
  });

  it("skips functions without calls", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts");
    const fnB = makeFn("fnB", "hashB", "/src/b.ts");
    const ctx = buildCtx([fnA, fnB]);
    const edges = resolver.resolve(ctx);
    expect(edges).toHaveLength(0);
  });

  it("respects affectedHashes filter", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", { calls: ["fnB"] });
    const fnB = makeFn("fnB", "hashB", "/src/b.ts", { calls: ["fnA"] });
    const ctx = buildCtx([fnA, fnB], { affectedHashes: new Set(["hashA"]) });
    const edges = resolver.resolve(ctx);

    // Only fnA is in affectedHashes, so only its calls are resolved
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceHash).toBe("hashA");
  });
});

// ============ JsxRefEdgeResolver ============

describe("JsxRefEdgeResolver", () => {
  const resolver = new JsxRefEdgeResolver();

  it("creates jsx_ref edges from fn.jsxRefs", () => {
    const page = makeFn("Page", "hashPage", "/src/page.tsx", {
      jsxRefs: ["Button"],
    });
    const button = makeFn("Button", "hashBtn", "/src/button.tsx");
    const ctx = buildCtx([page, button]);
    const edges = resolver.resolve(ctx);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeType: "jsx_ref",
      weight: DEFAULT_GRAPH_CONFIG.edgeWeights.jsx_ref,
    });
  });

  it("skips self-references", () => {
    const comp = makeFn("Comp", "hashComp", "/src/comp.tsx", {
      jsxRefs: ["Comp"],
    });
    const ctx = buildCtx([comp]);
    expect(resolver.resolve(ctx)).toHaveLength(0);
  });
});

// ============ CoLocationEdgeResolver ============

describe("CoLocationEdgeResolver", () => {
  const resolver = new CoLocationEdgeResolver();

  it("creates same-file co-location edges with weight decay", () => {
    const fnA = makeFn("fnA", "hashA", "/src/utils.ts", { startLine: 1 });
    const fnB = makeFn("fnB", "hashB", "/src/utils.ts", { startLine: 10 });
    const fnC = makeFn("fnC", "hashC", "/src/utils.ts", { startLine: 20 });
    const ctx = buildCtx([fnA, fnB, fnC]);
    const edges = resolver.resolve(ctx);

    // 3 pairs: A-B (offset=1), A-C (offset=2), B-C (offset=1)
    const sameFileEdges = edges.filter(
      (e) => e.weight === DEFAULT_GRAPH_CONFIG.edgeWeights.co_location ||
        e.weight === DEFAULT_GRAPH_CONFIG.edgeWeights.co_location / 2,
    );
    expect(sameFileEdges.length).toBeGreaterThanOrEqual(3);

    // Adjacent functions get full weight
    const adjacent = edges.find(
      (e) =>
        (e.sourceHash === "hashA" && e.targetHash === "hashB") ||
        (e.sourceHash === "hashB" && e.targetHash === "hashA"),
    );
    expect(adjacent).toBeDefined();
    expect(adjacent!.weight).toBe(DEFAULT_GRAPH_CONFIG.edgeWeights.co_location);
  });

  it("does not create cross-file directory edges", () => {
    const fnA = makeFn("fnA", "hashA", "/src/dir/a.ts", { startLine: 1 });
    const fnB = makeFn("fnB", "hashB", "/src/dir/b.ts", { startLine: 1 });
    const ctx = buildCtx([fnA, fnB]);
    const edges = resolver.resolve(ctx);

    // Cross-file relationships are captured by import/call/jsx_ref edges, not co-location
    expect(edges).toHaveLength(0);
  });

  it("deduplicates edges within same file", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", { startLine: 1 });
    const fnB = makeFn("fnB", "hashB", "/src/a.ts", { startLine: 10 });
    const ctx = buildCtx([fnA, fnB]);
    const edges = resolver.resolve(ctx);

    const pairKeys = edges.map((e) => {
      const a = e.sourceHash < e.targetHash ? e.sourceHash : e.targetHash;
      const b = e.sourceHash < e.targetHash ? e.targetHash : e.sourceHash;
      return `${a}|${b}`;
    });
    const unique = new Set(pairKeys);
    expect(unique.size).toBe(pairKeys.length);
  });
});

// ============ ImportEdgeResolver ============

describe("ImportEdgeResolver", () => {
  const resolver = new ImportEdgeResolver();

  it("creates import edges for direct file resolution", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", {
      startLine: 1,
      imports: [{ module: "./b", names: ["fnB"] }],
    });
    const fnB = makeFn("fnB", "hashB", "/src/b.ts", { startLine: 1 });

    const fileToHashes = new Map<string, Set<string>>();
    fileToHashes.set("/src/b.ts", new Set(["hashB"]));

    const ctx = buildCtx([fnA, fnB], { fileToHashes });
    const edges = resolver.resolve(ctx);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      edgeType: "import",
      weight: DEFAULT_GRAPH_CONFIG.edgeWeights.import,
    });
  });

  it("deduplicates import edges (undirected)", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", {
      startLine: 1,
      imports: [{ module: "./b", names: ["fnB"] }],
    });
    const fnB = makeFn("fnB", "hashB", "/src/b.ts", {
      startLine: 1,
      imports: [{ module: "./a", names: ["fnA"] }],
    });

    const fileToHashes = new Map<string, Set<string>>();
    fileToHashes.set("/src/a.ts", new Set(["hashA"]));
    fileToHashes.set("/src/b.ts", new Set(["hashB"]));

    const ctx = buildCtx([fnA, fnB], { fileToHashes });
    const edges = resolver.resolve(ctx);

    // Both import each other, but edge should be deduplicated to 1
    expect(edges).toHaveLength(1);
  });

  it("uses namespace fallback when named import not found directly", () => {
    const fnA = makeFn("fnA", "hashA", "/src/a.ts", {
      startLine: 1,
      calls: ["helperB"],
      imports: [{ module: "./b", names: ["*"] }],
    });
    const helperB = makeFn("helperB", "hashH", "/src/b.ts", { startLine: 1 });

    const fileToHashes = new Map<string, Set<string>>();
    fileToHashes.set("/src/b.ts", new Set(["hashH"]));

    const fileNameToHash = new Map<string, string>();
    fileNameToHash.set("/src/a.ts::fnA", "hashA");
    fileNameToHash.set("/src/b.ts::helperB", "hashH");

    const ctx = buildCtx([fnA, helperB], { fileToHashes, fileNameToHash });
    const edges = resolver.resolve(ctx);

    expect(edges).toHaveLength(1);
    expect(edges[0].edgeType).toBe("import");
  });
});

// ============ Registry ============

describe("Edge resolver registry", () => {
  it("returns built-in resolvers", () => {
    const resolvers = getEdgeResolvers();
    expect(resolvers.length).toBeGreaterThanOrEqual(4);

    const types = resolvers.flatMap((r) => [...r.edgeTypes]);
    expect(types).toContain("call");
    expect(types).toContain("jsx_ref");
    expect(types).toContain("co_location");
    expect(types).toContain("import");
  });

  it("allows registering custom resolvers", () => {
    const before = getEdgeResolvers().length;
    registerEdgeResolver({
      edgeTypes: ["custom_test"],
      resolve: () => [],
    });
    expect(getEdgeResolvers().length).toBe(before + 1);
  });
});
