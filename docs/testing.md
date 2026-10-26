# Testing Guide

## Philosophy

Test **our business logic**, not library behavior.

### DO test
- Merge logic (splitting/combining analysis rows)
- Migration correctness (schema changes, data transformations)
- Sync pipeline invariants (account detection, batching, tombstones, defensive defaults)
- Parser extraction heuristics (which AST nodes we extract, entity type classification)
- GC tombstone creation and orphan detection
- Import deduplication (INSERT OR IGNORE behavior)

### DON'T test
- Zod `.parse()` / `.safeParse()` -- trust the library
- `crypto.createHash()` -- SHA256 works
- better-sqlite3 SQL execution -- trust the driver
- TypeScript compiler AST parsing -- trust `ts.createSourceFile()`
- Supabase SDK methods -- mock the client, test our logic around it
- `p-retry`, `Commander`, or other utility libraries

The boundary is: **if we wrote the logic, test it. If a library does the work, trust it.**

## Running Tests

```bash
# All tests across workspace
pnpm test

# Watch mode (re-runs on file change)
pnpm test:watch

# Single package
cd packages/core && pnpm test
cd packages/cli && pnpm test
cd packages/webapp && pnpm test
cd packages/vscode && pnpm test

# Single file
pnpm vitest run packages/core/src/index.test.ts

# Pattern match
pnpm vitest run --reporter=verbose -t "mergeAnalysisRows"
```

## Test Structure

Tests live next to the code they test:
```
packages/core/src/
  index.ts              # Production code
  index.test.ts         # Tests for index.ts
  graph.ts              # Graph construction, community detection
  graph.test.ts         # Tests for graph module
  summarize.ts          # Hierarchical community summarization
  summarize.test.ts     # Tests for summarize module
  test-utils.ts         # Shared test factories
  parsers/
    typescript.ts
    typescript.test.ts
    python.ts
    python.test.ts
    __fixtures__/        # Small source files for parser tests
      arrow-functions.ts
      class-methods.ts
      no-functions.ts
      simple.py
      class-methods.py

packages/cli/src/
  sync.ts
  sync.test.ts
  test-utils.ts         # Mock Supabase, temp DB helpers

packages/webapp/src/services/api/
  merge.ts
  merge.test.ts

packages/vscode/src/
  types.ts              # Shared interfaces (FunctionData, DbEntry, etc.)
  queries.ts            # DB query functions (extracted for testability)
  queries.test.ts       # sql.js in-memory DB tests
  lens.ts               # CodeLens title builder
  lens.test.ts          # Pure function tests
  extension.ts          # Activation, commands, webview (not unit-tested)
```

## Test Utilities

### Core (`@ophan/core/test-utils`)

| Export | Purpose |
|--------|---------|
| `createTestDb()` | In-memory SQLite with current schema (analysis, file_functions, graph tables, indexes, sync_meta) |
| `createLegacyTestDb()` | In-memory SQLite with pre-analysis-type schema (for migration tests) |
| `insertAnalysisPair(db, hash, opts?)` | Inserts doc + sec rows for a content_hash |
| `insertFileFunction(db, path, name, hash, opts?)` | Inserts a file_functions row |
| `insertCommunity(db, hash, communityId, opts?)` | Inserts a community assignment row |
| `insertEdge(db, sourceHash, targetHash, opts?)` | Inserts a function edge |
| `insertCommunitySummary(db, communityId, opts?)` | Inserts a community summary row |
| `makeDocAnalysisJson(overrides?)` | Returns JSON string for documentation analysis |
| `makeSecAnalysisJson(overrides?)` | Returns JSON string for security analysis |

### CLI (`./test-utils`)

| Export | Purpose |
|--------|---------|
| `createTempDb(setup?)` | Creates temp file on disk with `.ophan/index.db` structure. Returns `{ dbPath, rootPath, cleanup }` |
| `createMockSupabase(responses?)` | Proxy-based mock Supabase client. Records all calls, returns controlled responses |

## Writing New Tests

### 1. Identify the business logic boundary

Ask: "What logic did **we** write?" If the answer is "we call a library function", there's nothing to test. If the answer is "we merge rows, apply defaults, check conditions", that's testable.

### 2. Use factories, not raw SQL

```typescript
// Good -- uses factories
insertAnalysisPair(db, "hash1", { syncedAt: null });
insertFileFunction(db, "src/a.ts", "fn1", "hash1");

// Avoid -- raw SQL in every test
db.prepare("INSERT INTO function_analysis ...").run(...);
```

### 3. Test the edges

For merge functions: both types present, one missing, both missing, null analysis field, unknown type.

For sync: empty input, account change, already-synced rows, mixed new+existing.

### 4. Parser tests use fixture files

Small, focused source files in `__fixtures__/`. Each file tests a specific extraction scenario. If python3 is not available, Python parser tests skip gracefully.

## Critical Areas Requiring Coverage

Ranked by impact if broken:

1. **Analysis merge logic** -- Core + webapp both merge split analysis rows. Incorrect merge = broken UI, wrong security flags shown.
2. **Schema migration** -- Splitting legacy single-row analysis into doc + sec rows. Data loss on migration = re-analyze everything.
3. **Sync pipeline** -- Account change detection, push/pull batching, GC tombstone propagation. Bugs here can push to wrong accounts or lose data.
4. **Parser extraction** -- Entity type classification (method vs function), async detection, name resolution from arrow functions, call-site extraction, import/export detection.
5. **Graph analysis** -- Edge resolution (name → content hash), community detection algorithm correctness, dissolved community handling, config persistence.
6. **Community summarization** -- Input hash caching (deterministic, order-independent, level-prefixed), context building (member lookup, edge filtering, callsTo/calledBy), orchestration (L1 per community, L2 when ≥2, L3, cache invalidation on membership change).
7. **Cross-cutting concern detection** -- Betweenness centrality (bridge node identification, normalized scores), concern classification from dataTags/securityFlags across community boundaries, significance filtering (2+ pairs or high centrality), security-first sorting, input hash determinism, orchestration caching.
8. **Community sync** -- Full replace for communities (DELETE + INSERT), upsert for summaries, graceful handling when graph tables don't exist, JSON parsing for summary column.
9. **CodeLens community title** -- Community membership lookup, title extraction from summary JSON, graceful fallback when tables missing.
9. **GC + import** -- Orphan detection, grace period, tombstone creation, INSERT OR IGNORE deduplication.

## VS Code Extension Testing

The extension (`packages/vscode`) uses sql.js (WebAssembly SQLite) rather than better-sqlite3. Testable logic is extracted into separate modules:

- **`queries.ts`** -- DB query functions take a sql.js `Database` parameter. Tests create in-memory sql.js databases with the same schema as `.ophan/index.db`, insert test data, and verify the merge logic (2 rows per function → unified FunctionData).
- **`lens.ts`** -- Pure function `buildLensTitle` with no dependencies. Tests verify icon selection (security, data tags, stale), description truncation, and tag display.
- **`extension.ts`** -- Activation logic, commands, webview panel, hover provider. These depend on the VS Code API and are not unit-tested. Testing would require the VS Code extension test host (`@vscode/test-electron`), which is significantly more complex to set up and run in CI.

The boundary: extract pure logic into modules, test those. Leave VS Code API interactions (commands, CodeLens registration, webview messaging) untested at the unit level.

## Known Duplication

Core `mergeAnalysisRows` returns a **flat** shape (top-level `description`, `params`, `dataTags`, etc.).

Webapp `mergeAnalysisRows` returns a **nested** shape (`{ documentation: {...}, security: {...} }`).

Both are tested separately. They serve different consumers and intentionally have different shapes.
