---
name: testing
description: Testing standards, patterns, utilities, and vitest configuration. Use when writing tests, creating test fixtures, or understanding the test philosophy. Always reference when adding tests for new features.
---

# Testing Standards & Practices

## Philosophy

**Test our business logic, not library behavior.**

### DO Test
- Merge logic (splitting/combining analysis rows)
- Migration correctness (schema changes, data transformations)
- Sync pipeline invariants (account detection, batching, tombstones, defensive defaults)
- Parser extraction heuristics (which AST nodes we extract, entity type classification)
- GC tombstone creation and orphan detection
- Graph edge resolution (name→hash mapping, co-location, imports)
- Community detection correctness (algorithm output, size constraints)
- Input hash caching (deterministic, order-independent)
- Pure function behavior (CodeLens title building, analysis merging)

### DON'T Test
- `z.parse()` / `z.safeParse()` -- trust Zod
- `crypto.createHash()` -- SHA256 works
- `better-sqlite3` SQL execution -- trust the driver
- TypeScript compiler AST parsing -- trust `ts.createSourceFile()`
- Supabase SDK methods -- mock the client, test our logic around it
- `graphology` graph operations -- trust the library
- `Commander`, `p-retry`, or other utility libraries

**Boundary rule:** If we wrote the logic, test it. If a library does the work, trust it.

## Test Structure

Tests live **next to the code they test** with `.test.ts` suffix:

```
packages/core/src/
  index.test.ts            # DB operations, GC, migration
  graph.test.ts            # Edge resolution, detection, centrality
  summarize.test.ts        # Hierarchical summarization, caching
  parsers/
    typescript.test.ts     # TS/JS parser extraction
    python.test.ts         # Python parser extraction
    __fixtures__/          # Small source files for parser tests

packages/cli/src/
  sync.test.ts             # Push/pull sync pipeline

packages/webapp/src/services/api/
  merge.test.ts            # Analysis row merging

packages/vscode/src/
  queries.test.ts          # DB query functions (sql.js)
  lens.test.ts             # CodeLens title builder
```

## Vitest Configuration

### Workspace (`vitest.workspace.ts`)
```typescript
export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/cli/vitest.config.ts',
  'packages/webapp/vitest.config.ts',
  'packages/vscode/vitest.config.ts',
])
```

### Per-Package
- **Core/CLI:** `environment: 'node'`, `globals: true`
- **Webapp:** `environment: 'jsdom'`, uses `vite-tsconfig-paths` plugin
- **VS Code:** `environment: 'node'`

### Running Tests
```bash
pnpm test                    # All packages
pnpm test:watch              # Watch mode
cd packages/core && pnpm test    # Single package
```

## Core Test Utilities (`packages/core/src/test-utils.ts`)

### Database Factories

```typescript
createTestDb()          // In-memory SQLite with current schema (all tables + indexes)
createLegacyTestDb()    // In-memory SQLite with pre-analysis-type schema (migration tests)
```

### Data Insertion Helpers

```typescript
insertAnalysisPair(db, contentHash, options?)
// Inserts matched documentation + security rows
// Options: { language, entityType, syncedAt, lastSeenAt, createdAt, doc, sec }

insertFileFunction(db, filePath, functionName, contentHash, options?)
// Inserts file_functions row. Options: { mtime, language, entityType }

insertCommunity(db, contentHash, communityId, options?)
// Options: { level, algorithm }

insertEdge(db, sourceHash, targetHash, options?)
// Options: { edgeType, weight }

insertCommunitySummary(db, communityId, options?)
// Options: { level, algorithm, inputHash, summary, modelVersion }
```

### JSON Builders

```typescript
makeDocAnalysisJson(overrides?)
// Default: { description: "Test function description", params: [...], returns: {...} }

makeSecAnalysisJson(overrides?)
// Default: { dataTags: ["internal"], securityFlags: [] }
```

## CLI Test Utilities (`packages/cli/src/test-utils.ts`)

### Temp Database

```typescript
createTempDb(setup?)
// Creates real file-based .ophan/index.db in temp directory
// Returns: { rootPath, dbPath, cleanup }
// Use when testing functions that read from file system
```

### Mock Supabase

```typescript
createMockSupabase(responses?)
// Proxy-based mock that records all calls
// Returns: { client, calls }
// Chainable: .from('table').select().eq(...).then(...)
```

## Practical Test Patterns

### Pattern 1: Database Logic (Core)
```typescript
it("merges documentation + security rows", () => {
  const result = mergeAnalysisRows([
    { analysis_type: "documentation", analysis: JSON.stringify({ description: "Test" }) },
    { analysis_type: "security", analysis: JSON.stringify({ dataTags: ["pii"] }) },
  ]);
  expect(result.description).toBe("Test");
  expect(result.dataTags).toEqual(["pii"]);
});
```

### Pattern 2: Temp DB with Cleanup (CLI)
```typescript
const cleanups: (() => void)[] = [];
const tracked = <T extends { cleanup: () => void }>(t: T) => {
  cleanups.push(t.cleanup);
  return t;
};
afterEach(() => { cleanups.forEach(fn => fn()); cleanups.length = 0; });

it("pushes unsynced rows", async () => {
  const { rootPath } = tracked(createTempDb((db) => {
    insertAnalysisPair(db, "hash1", { syncedAt: null });
  }));
  const mock = createMockSupabase({ "repos.upsert": { data: { id: "repo-1" } } });
  const result = await syncToSupabase(rootPath, mock.client, USER_ID);
  expect(result.pushed).toBe(2); // doc + sec rows
});
```

### Pattern 3: Pure Function (VS Code)
```typescript
function makeFn(overrides = {}): FunctionData {
  return { name: "test", description: "A function", securityFlags: [], dataTags: [], ...overrides };
}

it("shows warning for security flags", () => {
  const title = buildLensTitle(makeFn({ securityFlags: ["sql_injection"] }), false);
  expect(title).toContain("\u26a0\ufe0f");
});
```

### Pattern 4: sql.js Database (VS Code)
```typescript
let db: Database;
beforeEach(async () => {
  if (!SQL) SQL = await initSqlJs();
  db = createTestDb();
});
afterEach(() => db?.close());

it("queries file analysis", () => {
  insertFileFunction(db, "src/auth.ts", "login", "hash1");
  insertAnalysisPair(db, "hash1");
  const result = queryFileAnalysis(db, "src/auth.ts");
  expect(result).toHaveLength(1);
});
```

### Pattern 5: Graph Analysis
```typescript
it("resolves call edges", () => {
  insertFileFunction(db, "/src/a.ts", "fnA", "hashA");
  insertFileFunction(db, "/src/a.ts", "fnB", "hashB");
  const fns = [{ name: "fnA", contentHash: "hashA", calls: ["fnB"], ... }];
  const edges = resolveEdges(db, fns, DEFAULT_GRAPH_CONFIG);
  expect(edges.filter(e => e.edgeType === "call")).toHaveLength(1);
});
```

### Pattern 6: Migration
```typescript
it("splits legacy row into doc + sec", () => {
  const db = createLegacyTestDb();
  db.prepare("INSERT INTO function_analysis ...").run("hash1", JSON.stringify({
    description: "Test", params: [], returns: { type: "void" },
    dataTags: ["internal"], securityFlags: ["xss"],
  }));
  migrateToAnalysisTypes(db);
  const rows = db.prepare("SELECT analysis_type FROM function_analysis").all();
  expect(rows.map(r => r.analysis_type).sort()).toEqual(["documentation", "security"]);
});
```

## Critical Test Areas (by Impact)

1. **Analysis merge** -- incorrect merge = broken UI, wrong security flags
2. **Schema migration** -- data loss = re-analyze everything
3. **Sync pipeline** -- bugs can push to wrong accounts or lose data
4. **Parser extraction** -- wrong entity types, missed functions, wrong calls
5. **Graph edge resolution** -- wrong edges = wrong communities
6. **Community summarization** -- cache misses = wasted Claude API calls
7. **Cross-cutting concerns** -- wrong bridge detection = misleading architecture view
8. **GC + import** -- orphan detection, grace period correctness

## Key Files

- `docs/testing.md` -- Detailed testing philosophy
- `packages/core/src/test-utils.ts` -- Core test utilities
- `packages/cli/src/test-utils.ts` -- CLI test utilities (temp DB, mock Supabase)
- `vitest.workspace.ts` -- Workspace configuration
