---
name: vscode-extension
description: VS Code extension patterns -- CodeLens, webview communication, stale detection, single-engine better-sqlite3 DB, migration system, query extraction, webview panel (navigation, views, DataBridge, request/response protocol). Use when working on the extension, CodeLens provider, webview panels, the postMessage protocol, write-db, migrations, or webview views.
---

# VS Code Extension Patterns

## Architecture

The extension (`packages/vscode/`) uses `.ophan/index.db` and provides CodeLens annotations, hover tooltips, diagnostics, and a webview panel with full security dashboard, function browser, architecture docs, and more.

**Single SQLite engine -- better-sqlite3 (native Node.js) for ALL reads and writes:**
- Every query hits the on-disk `.ophan/index.db` directly -- results are always fresh
- WAL mode enables concurrent CLI + extension access
- No separate `local-state.db` -- all data consolidated into `index.db`

**IMPORTANT: sql.js must NEVER be used in the extension host.** sql.js loads the entire DB into memory as a snapshot that goes stale immediately. This caused persistent bugs -- stale `start_line` values, edit state not propagating, timing races on DB reload. sql.js is only used in the webview browser dev mode (`packages/webview`) where native modules aren't available, but it should NEVER be used in the extension host.

## Code Organization (Testability Split)

```
packages/vscode/src/
  extension.ts          # Activation, commands, webview, diagnostics, VS Code API (NOT unit-tested)
  store.ts              # Centralized ExtensionStore -- state, actions, reducer, selectors, StatusSnapshot (testable)
  store.test.ts         # 47 tests for reducer, selectors, stale clearing, error count, activity log, getStatusSnapshot
  errors.ts             # OphanError discriminated union, classifyWatchError() (pure, no vscode dep)
  errors.test.ts        # 18 tests for error classification
  queries.ts            # Pure DB query functions (better-sqlite3 Database param -- testable)
  queries.test.ts       # In-memory better-sqlite3 tests
  webview-handler.ts    # Request/response dispatcher for webview queries
  webview-handler.test.ts
  webview-queries.ts    # Pure query functions for webview data requests (single better-sqlite3 db)
  webview-queries.test.ts  # 78 tests covering all query functions
  write-db.ts           # better-sqlite3 lifecycle: open/close, state writes
  write-db.test.ts      # 14 tests for write-db lifecycle and state operations
  migrations.ts         # Migration runner + EXTENSION_MIGRATIONS list (self-contained, no @ophan/core dep)
  migrations.test.ts    # 7 tests for migration runner
  lens.ts               # Pure function: buildLensTitle (no dependencies -- testable)
  lens.test.ts
  diagnostics.ts        # Pure functions: resolveIssueRange, mapSeverity, etc.
  diagnostics.test.ts
  types.ts              # Shared interfaces (FunctionData, DbEntry, DetailedIssue, etc.)
```

**Boundary:** Extract pure logic into `queries.ts`, `lens.ts`, `diagnostics.ts`, `webview-queries.ts`, `store.ts`, `errors.ts`. Leave VS Code API interactions in `extension.ts` (tested manually, not unit-tested). `errors.ts` must NEVER import `vscode` -- it's a pure module so tests can run without the extension host.

## Webview Panel System

The webview (`packages/webview/`) is a React app that runs inside a VS Code panel. It operates in two modes:

### Architecture Overview
```
packages/webview/src/
  App.tsx                 # Root component, mode detection, bridge setup
  main.tsx                # Entry point, theme sync
  navigation.ts           # Stack-based navigation (useNavigation hook)
  use-webview-query.ts    # Data fetching hook (useWebviewQuery, useWebviewMutation)
  data-bridge.ts          # DataBridge interface, VSCodeBridge, BrowserBridge, context
  browser-queries.ts      # Browser-mode query implementations
  data.ts                 # sql.js database loading (browser mode only)
  views/                  # View components (HomeView, FunctionsView, etc.)
  components/             # Shared UI components
    Header.tsx            # Top bar with back, title, menu
    NavSheet.tsx          # Bottom sheet navigation (vaul)
    ViewRouter.tsx        # Route → View mapping
    UpdatedToast.tsx      # "Updated" toast on dbReloaded
    EmptyState.tsx        # Shared empty state component
    ErrorState.tsx        # Shared error state with retry
    dashboard/            # Domain-specific components
    ui/                   # shadcn/Radix primitives
  utils/                  # Pure utility functions
```

### Two Modes
1. **VS Code mode**: Data arrives via postMessage from the extension host. `VSCodeBridge` sends `DataRequest` messages, receives `DataResponse`.
2. **Browser mode** (`pnpm dev` at localhost:5173?repo=/path): Loads `.ophan/index.db` via HTTP, queries sql.js directly via `BrowserBridge`. Browser mode uses sql.js because native modules aren't available -- it loads a stale snapshot and does NOT receive live updates. This is acceptable for UI development only.

### DataBridge Abstraction (`data-bridge.ts`)
```typescript
interface DataBridge {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  onPush(handler: (event: PushEvent) => void): () => void;
}

// VS Code mode: sends postMessage, waits for response with matching id
class VSCodeBridge implements DataBridge { ... }

// Browser mode: delegates to browserQueryHandler
class BrowserBridge implements DataBridge { ... }
```

### Navigation Stack (`navigation.ts`)
```typescript
type ViewType = 'home' | 'status' | 'security-issues' | 'functions' | 'function-detail'
  | 'architecture' | 'community-detail' | 'group-detail' | 'concern-detail'
  | 'concerns-index' | 'security-learn-index' | 'security-learn' | 'graph' | 'settings';

// App.tsx creates the stateful instance with persistence:
const nav = useNavigation(getState, setState);

// App.tsx wraps content in NavigationProvider so all views share it:
<NavigationProvider value={nav}>
  <ViewRouter route={nav.current} />
</NavigationProvider>

// Views consume the shared instance via context (NOT useNavigation()):
const nav = useNavigationContext();  // reads from NavigationProvider
nav.push({ view: 'function-detail', params: { contentHash: 'abc' } });
nav.pop();  // Back
nav.reset({ view: 'home', params: {} });
```

**Critical:** Views must use `useNavigationContext()`, not `useNavigation()`. Each call to `useNavigation()` creates an independent state -- only `App.tsx` should call it. This follows the same context pattern as `DataBridgeProvider`/`useDataBridge()`.

### Views
| View | Component | Data Method |
|------|-----------|-------------|
| Status | `StatusView` | `getStatus` (store snapshot, not DB). Refetches on `statusChanged` push event. Actions: `analyzeNow`, `openOutput`, `openFile`. |
| Home (Security Dashboard) | `HomeView` | `getSecurityDashboardStats`, `getTopIssues` |
| Security Issues | `SecurityIssuesView` | `getSecurityIssues` |
| Functions | `FunctionsView` | `getEnrichedFunctions`, `getAvailableLanguages` |
| Function Detail | `FunctionDetailView` | `getEnrichedFunction` (primary), `resolveCurrentHash` (fallback when hash orphaned after re-analysis; auto-navigates via `nav.replace()`). Uses `useFileAnalysisState` hook to show stale/analyzing banner. |
| Architecture | `ArchitectureView` | `getArchitectureHierarchy` |
| Community Detail | `CommunityView` | `getCommunityDetail` |
| Group Detail | `GroupView` | `getGroupDetail` |
| Concern Detail | `ConcernView` | `getConcernDetail` |
| Concerns Index | `ConcernsIndexView` | `getConcernsIndex` |
| Security Learn Index | `SecurityLearnIndexView` | (bundled data) |
| Security Learn | `SecurityLearnView` | (bundled data) |
| Graph Explorer | `GraphView` | `getGraphData` -- Cytoscape.js force-directed graph. Nodes = functions (colored by community, red for issues). Edges styled by type (solid/dashed/dotted). Controls: edge type filters, community coloring toggle, re-layout, fit. Click node for detail panel. |
| Settings/Practices | `SettingsView` | `getPractices` |

### Panel Hash Auto-Resolution

When a user edits a function while its detail panel is open, re-analysis creates a new content hash. The panel's nav params still hold the old hash, so `getEnrichedFunction(oldHash)` returns null. The fallback mechanism:

1. All `function-detail` nav pushes include `filePath` alongside `contentHash` and `name`
2. `FunctionDetailView` detects when the primary query returns null (hash orphaned)
3. Fires `resolveCurrentHash(functionName, filePath)` to look up the current hash in `file_functions`
4. If found and different, `nav.replace()` swaps to the new hash seamlessly

**Infinite loop guard:** `nav.replace()` changes `contentHash` in params → primary query re-runs with new hash → `data` is non-null → `shouldResolve` becomes false → fallback query disabled.

**Edit type behavior:**
- Body/signature edits: function name unchanged → auto-resolves to new hash
- Renames: old name not in `file_functions` → returns null → "Function not found" (correct -- different entity)
- Deletion: function removed entirely → returns null → "Function not found"

### Stale/Analyzing Banner in Panel

When a file is saved, the extension forwards file-level state events to the webview panel via push events (`fileStale`, `fileAnalyzing`, `fileAnalyzed`). The `useFileAnalysisState(filePath)` hook in `use-file-analysis-state.ts` subscribes to these events and returns `"fresh" | "stale" | "analyzing"`.

**State transitions:**
- `FILE_SAVED` → `fileStale` → hook returns `"stale"` → "Edited -- pending re-analysis" banner
- `ANALYZING` → `fileAnalyzing` → hook returns `"analyzing"` → "Re-analyzing..." banner with spinner
- `ANALYZED` → `fileAnalyzed` → hook returns `"fresh"` → banner disappears
- `dbReloaded` → always resets to `"fresh"` (safety valve per "false negatives over false positives")

**Path format:** All file paths in push events are absolute (matching `nav.current.params.filePath`). The `ANALYZING` action's relative path is resolved via `path.resolve(workspaceRoot, action.file)` in the extension subscriber.

**Browser dev mode:** No push events fire in browser mode, so the hook stays `"fresh"` (correct -- no watch process, no file editing events).

## Webview Communication Protocol

### Request/Response Protocol (New)
```typescript
// Webview → Extension
interface DataRequest {
  type: "request";
  id: string;          // crypto.randomUUID()
  method: string;      // e.g. "getSecurityDashboardStats"
  params?: Record<string, unknown>;
}

// Extension → Webview
interface DataResponse {
  type: "response";
  id: string;          // matches request id
  data?: unknown;
  error?: string;
}
```

**Flow:** `useWebviewQuery` hook → bridge.request() → postMessage → extension `webview-handler.ts` → `webview-queries.ts` → DataResponse back.

### Push Events (Extension → Webview, unsolicited)
| Event | Purpose |
|-------|---------|
| `dbReloaded` | Database updated, views should refetch |
| `editStateChanged` | Issue edit states updated (user edited code), views should refetch |
| `statusChanged` | Extension state changed (debounced 300ms), Status view should refetch |
| `showStatus` | Navigate webview to Status view (status bar click) |
| `showFunction` | CodeLens click, push function detail |
| `showHome` | Open panel to home view |
| `clear` | Clear the panel |
| `analysisProgress` | Live analysis progress updates |
| `fileStale` | File saved, analysis pending (carries `filePath`) |
| `fileAnalyzing` | File being re-analyzed (carries `filePath`) |
| `fileAnalyzed` | File analysis complete (carries `filePath`) |

### Legacy Protocol (still active for CodeLens)
| Direction | Message | Purpose |
|-----------|---------|---------|
| Ext → Web | `showFunction` | Display function from CodeLens click |
| Web → Ext | `ready` | Webview loaded |
| Web → Ext | `goToDefinition` | Navigate to function in editor |
| Web → Ext | `refresh` | Re-read DB |

## Extension Host Query System

### Handler (`webview-handler.ts`)
Dispatches `DataRequest` to appropriate query function:
```typescript
async function handleWebviewRequest(
  db: BetterDatabase.Database | null,  // better-sqlite3 -- all reads and writes
  message: DataRequest,
  context?: HandlerContext,  // store, actions for non-DB routes
): Promise<DataResponse>

interface HandlerContext {
  store: ExtensionStore | null;  // For getStatus
  onAnalyzeNow?: () => void;    // For analyzeNow action
  onOpenOutput?: () => void;    // For openOutput action
  onOpenFile?: (filePath: string) => Promise<void>;  // For openFile action
}
```
Non-DB routes (`getStatus`, `analyzeNow`, `openOutput`, `openFile`) are routed before the `if (!db)` guard.

### Query Functions (`webview-queries.ts`)
All functions take a single `db: BetterDatabase.Database` parameter for both analysis reads and state reads/writes:

```typescript
getStatus(context.store)                → StatusSnapshot (mode, watchRunning, watchError, staleFiles, activityLog, etc.)
analyzeNow(context)                    → null (fires context.onAnalyzeNow side effect)
openOutput(context)                    → null (fires context.onOpenOutput side effect)
openFile(context, { filePath })        → null (fires context.onOpenFile side effect)
getSecurityDashboardStats(db)           → { posture, criticalCount, errorCount, warningCount, totalFunctions, flagBreakdown }
getTopIssues(db, limit?)                → { content_hash, function_name, file_path, issue, score }[]
getSecurityIssues(db, params?)          → { items, total, page } (items include adjustedLine?, potentiallyRemediated)
getEnrichedFunctions(db, params?)       → { items, total, page }
getEnrichedFunction(db, hash)           → EnrichedFunction | null (includes editState map)
resolveCurrentHash(db, name, filePath)  → { contentHash } | null (stale hash fallback)
getAvailableLanguages(db)               → string[]
getNavCounts(db)                        → { securityIssues, functions, practices }
getPractices(db)                        → { practice_id, rule, severity }[]
getArchitectureHierarchy(db)            → { l3, groups, ungrouped, crossCutting } | null
getCommunityDetail(db, id)              → { summary, members, relatedCommunities, relatedConcerns } | null
getGroupDetail(db, id)                  → { summary, communities } | null
getConcernDetail(db, id)                → { title, bridgeMembers, affectedCommunities, ... } | null
getConcernsIndex(db)                    → CrossCuttingConcern[]
dismissIssue(db, params)               → void (writes to index.db)
undismissIssue(db, params)             → void (writes to index.db)
getEditStateMap(db?)                    → Map<"hash:type:index", { adjustedLine, potentiallyRemediated }>
```

### Priority Scoring
```
score = severityScore(severity) * 3 + confidenceScore(confidence)
critical: score >= 10 (error + high confidence)
```

### Single-Engine Architecture (better-sqlite3 only)

The extension uses better-sqlite3 for ALL database operations on `.ophan/index.db`:

```
.ophan/
  index.db          ← Single file. CLI writes analysis, extension reads/writes state.
                       WAL mode enables concurrent access.
```

All queries hit the on-disk file directly -- results are always fresh. No stale in-memory snapshots. The `getWriteDb()` function provides the shared database handle throughout the extension.

**Why not sql.js?** sql.js loads the entire DB into memory as a snapshot. When the CLI writes new analysis (updated `start_line`, new `function_analysis` rows), the sql.js snapshot doesn't see the changes until manually reloaded. This caused persistent bugs:
- Webview showed stale `start_line` values (edit state line offsets didn't propagate)
- DB reloads had timing races
- Required `checkpointWal()` + full-file re-read to get fresh data

### Multi-Electron Native Binary Loading

The extension ships in VS Code, Cursor, Google Antigravity, and Windsurf -- each with a different Electron version and ABI. A `.node` binary compiled for one ABI crashes in another with `NODE_MODULE_VERSION` mismatch. We support all Electron versions VS Code shipped with since July 2024 (Electron 30+).

**Bundling strategy:** better-sqlite3's JavaScript is bundled by esbuild (NOT external). Only the native `.node` binary is loaded at runtime via the `nativeBinding` option. This eliminates the pnpm symlink problem where `vsce package` couldn't include `node_modules/better-sqlite3/` from the pnpm store. The `bindings` package (better-sqlite3's native file resolver) is also bundled but never called -- we always provide an explicit path.

**Runtime loader (`native-loader.ts`):**
- **Dev mode (first priority):** Checks `node_modules/better-sqlite3/build/Release/better_sqlite3.node` -- uses the freshly compiled binary matching the current Node.js/Electron ABI
- **Production VSIX:** No `node_modules/` exists → falls back to `native/` directory
- Detects `process.versions.modules` (ABI) and `process.versions.electron`
- Selects `native/electron-{ABI}/better_sqlite3.node` or `native/node/` for Remote SSH/WSL
- Throws user-friendly error if ABI not bundled (instead of cryptic crash)

**`write-db.ts` integration:**
```typescript
const nativeBinding = resolveNativeBinding();
writeDb = new BetterSqlite3(dbPath, nativeBinding ? { nativeBinding } : undefined);
```

**esbuild config (`esbuild.mjs`):**
```javascript
external: ["vscode"],  // better-sqlite3 is bundled, NOT external
```

**VSIX structure (per platform):**
```
native/
  electron-123/better_sqlite3.node   # VS Code 1.92-1.94, Windsurf
  electron-128/better_sqlite3.node   # VS Code 1.95-1.97
  electron-132/better_sqlite3.node   # VS Code 1.98-1.100, Cursor
  electron-133/better_sqlite3.node   # VS Code 1.101-1.102
  electron-136/better_sqlite3.node   # VS Code 1.103-1.106, Google Antigravity
  electron-140/better_sqlite3.node   # VS Code 1.107+
  node/better_sqlite3.node           # Node.js (Remote SSH/WSL)
```

**Dev tooling:**
- `pnpm build:native` -- builds binaries for all Electron targets locally
- `pnpm verify:vsix <file>` -- inspects VSIX for correct native binaries
- `pnpm detect-abi` -- prints current runtime ABI info

**CI:** `@electron/rebuild` compiles from source for each Electron version. Atomic publishing ensures all platforms succeed before any are published. See `docs/release-lifecycle/native-binary-bundling.md`.

**State tables (created by extension migration `ext_001_state_tables`):**
```sql
CREATE TABLE dismissed_issues (
  content_hash TEXT NOT NULL,
  issue_index INTEGER NOT NULL,
  flag TEXT NOT NULL,
  reason TEXT NOT NULL,      -- 'false_positive' | 'accepted_risk' | 'wont_fix'
  note TEXT,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, issue_index)
);

CREATE TABLE issue_edit_state (
  content_hash TEXT NOT NULL,
  issue_type TEXT NOT NULL,         -- 'security' | 'practice'
  issue_index INTEGER NOT NULL,
  adjusted_line INTEGER NOT NULL,   -- 0-indexed file-absolute line
  potentially_remediated INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (content_hash, issue_type, issue_index)
);
```

**Migration system:** `_ophan_migrations` table shared between CLI (core's `initDb()`) and extension (`migrations.ts`). Each maintains independent migration lists. Extension runner is self-contained (~30 lines, no `@ophan/core` import).

**Lifecycle:**
| Event | Action |
|-------|--------|
| Extension activates | `openWriteDb(dbPath)` -- WAL + migrations |
| CLI writes analysis | `onDatabaseChanged()` -- clears caches, fires CodeLens change |
| CodeLens resolves | `writeIssueEditStates()` (fresh positions from language server) |
| User dismisses issue | `dismissIssue()` (writes to disk immediately) |
| User edits code | `writeIssueEditStates()` (transactional, via debounced re-resolution) |
| Panel close/reopen | DB handle survives (global) |
| Extension deactivates | `closeWriteDb()` |

**Key modules:** `write-db.ts` (lifecycle, state writes, local-state.db consolidation), `migrations.ts` (runner + migration list)

## CodeLens Provider

### Title Building (`lens.ts`)
```typescript
buildLensTitle(fn: FunctionData, isStale: boolean): string
```
Format: `{icons} {description} [{community}]`

Icon rules (uses VS Code Codicon syntax):
- `$(warning)` -- has security flags
- `$(lock)` -- has "pii" or "credentials" data tag
- `$(globe)` -- has "external_api" data tag
- `$(database)` -- has "database" data tag
- `Ophan:` -- default (no flags/tags, text prefix only)

Stale indicator: `$(sync~spin)` when file modified since last analysis (overrides all other icons).

## Diagnostics, Gutter Icons & Quick Actions

### Diagnostic Squiggly Lines
Created via `vscode.DiagnosticCollection`. Uses `resolveIssueRange()` from `diagnostics.ts` to convert function-relative `DetailedIssue.line` to file-absolute ranges. Diagnostic code is a clickable link (`diag.code = { value, target }`) that opens the function in the Ophan panel.

### Debounced Re-Resolution During Editing
VS Code diagnostics are static -- they don't adjust when the document is edited. When lines shift, squiggly lines point at wrong code. The extension handles this with a three-phase approach:

1. **Clear immediately** -- `onDidChangeTextDocument` fires on first edit → diagnostics and gutter icons cleared instantly (no wrong positions)
2. **Debounce 400ms** -- Per-file timer resets on each keystroke
3. **Re-resolve** -- `reResolveDiagnosticsForDocument()` queries fresh document symbols, matches to cached `FunctionData[]` by name (positional disambiguation for duplicates), then calls `reResolveFileDiagnostics()` (pure function) to re-run `resolveIssueRange()` with updated function bounds + current document text

**Timer lifecycle:** Cleared on save, close, DB reload, and deactivate.

**Pure function:** `reResolveFileDiagnostics(cachedFunctions, freshSymbols, getLineText, lineCount)` in `diagnostics.ts` -- no VS Code imports, fully testable. Takes `SymbolPosition[]` (name + 0-indexed start/end) and returns `ResolvedDiagnostic[]` + `gutterLines[]`.

See `docs/architecture/extension-lifecycle.md` for how diagnostics are anchored.

### Diagnostic Deduplication
Claude occasionally returns near-duplicate issues in the same analysis response (same flag, same line, slightly different wording). Both the CodeLens diagnostic path and the `reResolveFileDiagnostics()` pure function deduplicate diagnostics by `(resolvedLine, flag)` -- keeping only the first occurrence. The `deduplicateDiagnostics()` function in `diagnostics.ts` is the pure implementation used by `reResolveFileDiagnostics`; the CodeLens path in `extension.ts` uses an inline `Set<string>` keyed by `${line}:${flag}`.

### Custom Gutter Shield Icons
Uses `TextEditorDecorationType` with `gutterIconPath` pointing to 16x16 SVGs in `resources/icons/`.

### Hover Command Links
Appends `[View in Ophan](command:ophan.showFunction?CONTENT_HASH)` markdown link. Only the `contentHash` string is encoded (not the full FunctionData object) to avoid oversized payloads breaking VS Code's markdown link parser. The `ophan.showFunction` command handler accepts both `FunctionData` (from CodeLens/CodeAction) and `string` contentHash (from hover), using `functionDataByHash` map for the latter.

### Issue Remediation Detection

When a user edits the actual code an issue points to (e.g. fixes `eval(data)` → `JSON.parse(data)`), the system suppresses the squiggle rather than showing a misleading highlight on the fixed code. This follows the "false negatives over false positives" paradigm.

**Mechanism:** At analysis time, the trimmed source line text is stored as `lineText` on each `DetailedIssue`. At resolution time, `resolveIssueRange()` compares the stored `lineText` with the current document line. If they differ, `anchorFound` is set to `false` and the diagnostic/gutter icon is not emitted.

**Key fields:**
- `DetailedIssue.lineText` -- trimmed source line at analysis time (`.catch("")` for backwards compat)
- `ResolvedRange.anchorFound` -- `false` when issue's code was modified or anchors not found
- `ResolvedDiagnostic.anchorFound` -- propagated through `reResolveFileDiagnostics()`

**Suppression points (extension.ts):**
1. CodeLens provider diagnostic emission: `if (!resolved.anchorFound) continue;`
2. Gutter icon emission: `if (!resolved.anchorFound) continue;`
3. `reResolveFileDiagnostics()`: filters out diagnostics with `anchorFound === false`

**Self-healing:** Watch process re-analyzes within 10-15s. Fresh analysis produces new `lineText`. If the issue was truly fixed, no squiggle returns. If it persists, the squiggle returns with correct anchors.

**Backwards compat:** Old analysis rows without `lineText` (empty string via `.catch("")`) fall back to anchor-only detection.

**Edit state persistence:** Edit state (`issue_edit_state` table) is written in two places:
1. **CodeLens resolution** (`provideCodeLenses`): Writes `IssueEditState[]` for ALL resolved issues using fresh language server positions. Runs on every CodeLens refresh, including after DB reload.
2. **Debounced edit re-resolution** (`reResolveDiagnosticsForDocument`): Writes edit state 400ms after each keystroke during editing.

Both paths send `editStateChanged` push events. The webview's `useWebviewQuery` hook auto-refetches on this event. Both `getSecurityIssues()` and `getEnrichedFunction()` merge edit state from the same database -- all queries hit disk directly so results include the latest state. `FunctionDetail.tsx` renders adjusted line numbers and "Potentially fixed" badges (green border, dimmed opacity) for remediated issues.

**Edit state is NOT cleared on DB reload.** Entries are keyed by `(content_hash, issue_type, issue_index)` -- stale entries for old content hashes are harmless (won't be looked up). CodeLens resolution writes fresh entries after every DB reload.


See `docs/architecture/extension-lifecycle.md` (Remediation Detection).

### CodeAction Quick Fix
`OphanCodeActionProvider` offers "View {fn} in Ophan" when cursor is on a diagnostic.

## VS Code Theme Integration

The webview syncs with VS Code's active theme:
1. `main.tsx` detects `vscode-dark`/`vscode-light`/`vscode-high-contrast` body classes
2. Toggles `dark` class on `<html>` for Tailwind
3. CSS variables in `index.css` map VS Code vars to Tailwind design tokens:
   - `--background` → `var(--vscode-editor-background)`
   - `--foreground` → `var(--vscode-editor-foreground)`
   - `--primary` → `var(--vscode-button-background)`
   - etc.

## Centralized State Management (`store.ts`)

The extension uses a lightweight `ExtensionStore` class to manage all runtime state. This replaced ~15 scattered module-level variables that caused stuck-state bugs (see `research/vscode-extension-ux-review.md`).

### Architecture

```typescript
// Actions are dispatched from event handlers
store.dispatch({ type: "WATCH_STARTED" });
store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
store.dispatch({ type: "WATCH_ERROR", error: classifiedError, file: "/src/a.ts" });

// Subscribers react to state changes
store.onAction((action) => {
  const { text, tooltip } = store.statusBarState;  // Derived selector
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
});
```

### State Shape (`ExtensionState`)

| Field | Type | Purpose |
|-------|------|---------|
| `watchRunning` | `boolean` | Watch process alive |
| `watchError` | `OphanError \| null` | Fatal error (crash, API key invalid) |
| `lastCrashTime` | `number` | Timestamp of last process crash |
| `staleFiles` | `Set<string>` | Files saved but not yet re-analyzed |
| `analyzedFiles` | `Set<string>` | Files CLI reported as analyzed since last DB change |
| `recentErrorCount` | `number` | Transient errors in current burst (auto-resets after 30s) |
| `analyzingFile` | `string \| null` | Currently analyzing file (for status bar spinner) |
| `scanProgress` | `{ current, total } \| null` | Initial scan progress |
| `retryState` | `{ attempt, maxAttempts } \| null` | Initial scan retry state |
| `activityLog` | `ActivityLogEntry[]` | Circular buffer (max 50) of recent events for debugging |

### Activity Log

The store maintains a bounded activity log (`ActivityLogEntry[]`) of recent events for debugging via the Status view. Each entry has `{ timestamp, category, message }`. The `getStatusSnapshot()` method serializes the full store state (Sets → arrays, OphanError → flat {type, message, severity}) for the webview.

**Categories:** `analysis`, `scan`, `sync`, `error`, `lifecycle`

**Logged actions:** `WATCH_STARTED`, `WATCH_STOPPED`, `WATCH_CRASHED`, `WATCH_ERROR`, `ANALYZING`, `ANALYZED`, `SCAN_COMPLETE`, `RETRY`, `SYNCED`, `SYNC_ERROR`

**Skipped (too noisy):** `FILE_SAVED`, `DB_CHANGED`, `SCAN_PROGRESS`, `CLEAR_ERRORS`

### Action Types (`ExtensionAction`)

Watch lifecycle: `WATCH_STARTED`, `WATCH_STOPPED`, `WATCH_CRASHED`
Analysis events: `ANALYZING`, `ANALYZED`, `SCAN_COMPLETE`, `SCAN_PROGRESS`, `RETRY`
Errors: `WATCH_ERROR` (carries `OphanError` + optional `file`)
User actions: `FILE_SAVED`, `DB_CHANGED`, `CLEAR_ERRORS`
Sync events: `SYNCED` (carries `pushed` count), `SYNC_ERROR` (carries `message`)

### Key Behaviors

- **Immediate stale clearing on ANALYZED**: When the CLI reports a file as analyzed, `ANALYZED` immediately removes the file from `staleFiles`. This is critical for cache-hit scenarios where the DB doesn't change (no new hashes) -- if we only cleared staleFiles on `DB_CHANGED`, the file would stay "pending" forever since `fs.watch` never fires. The `analyzedFiles` set and `DB_CHANGED` clearing remain as a harmless safety net (double-delete on Set is a no-op).
- **ANALYZED triggers CodeLens refresh**: The CodeLens subscriber fires on `ANALYZED` (in addition to `DB_CHANGED`, `FILE_SAVED`, etc.) so the spinner clears immediately when analysis completes, even for pure cache hits.
- **`SCAN_COMPLETE` clears everything**: Full reset of staleFiles, analyzedFiles, analyzing state.
- **Error auto-reset**: `recentErrorCount` resets to 0 after 30s of no new errors via `scheduleErrorReset()`.
- **Status bar derivation**: `statusBarState` getter derives display from state with priority ordering: analyzing > scan progress > retry > watch error > recent errors > watch running > stale files > setup needed > ready > default.

### Dependency Injection

Store constructor takes `{ hasApiKey: () => boolean, hasDb: () => boolean }` to avoid importing `vscode` in the store module. Extension passes: `{ hasApiKey: () => !!getApiKey(), hasDb: () => !!getWriteDb() }`.

## Status Bar → Status View

Clicking the Ophan status bar item opens the webview panel navigated to the **Status** view (command: `ophan.openStatusView`). This replaced the previous QuickPick menu.

**Flow:** Status bar click → `showStatusPanel()` → ensures panel exists via `showHomePanel()` → sends `{ type: "showStatus" }` push event → webview `App.tsx` handles `showStatus` → `nav.reset({ view: "status", params: {} })` → `StatusView` renders.

**Status View sections:**
1. **Watch Status** -- running/stopped/error indicator, Analyze Now + Output buttons
2. **Analysis Progress** (conditional) -- current file, scan progress bar, retry state
3. **Pending Files** (conditional) -- clickable list of stale files (opens in editor via `openFile` action)
4. **Activity Log** -- newest-first list with category-colored dots and relative timestamps

**Data flow:** `useWebviewQuery("getStatus", undefined, { refetchOn: ["statusChanged"] })` fetches `StatusSnapshot` from the extension store (not DB). The `statusChanged` push event fires on any store action (debounced 300ms).

**Browser mode:** Returns `{ mode: "browser", ... }` → shows `EmptyState` placeholder.

The Status view is also accessible from the webview nav menu (first item, `IconActivity` icon).

## Typed Error Classification (`errors.ts`)

All watch process errors flow through a typed classification system. `errors.ts` is a **pure module** (no `vscode` import) so it's fully testable.

### Error Types (`OphanError` discriminated union)

| Type | Severity | Trigger Patterns | Recovery Action |
|------|----------|-----------------|----------------|
| `api_key_invalid` | fatal | `api_key`, `authentication`, `401` | Open Settings |
| `rate_limited` | transient | `429`, `rate limit` | View Output |
| `network_error` | recoverable | `ECONNREFUSED`, `ENOTFOUND`, `fetch failed` | Retry |
| `timeout` | recoverable | `ETIMEDOUT`, `timeout` | Retry |
| `process_crash` | recoverable | Watch process non-zero exit | Restart |
| `db_locked` | transient | `SQLITE_BUSY`, `locked` | Retry |
| `analysis_failed` | recoverable | Fallback for unknown errors | Show Output |

### Flow

```
CLI emits "error" event
  → classifyWatchError(message, file) → OphanError     // Pure, in errors.ts
  → store.dispatch({ type: "WATCH_ERROR", error })      // State update
  → presentError(error, store, outputChannel)            // VS Code UI, in extension.ts
```

`presentError()` lives in `extension.ts` (not `errors.ts`) because it uses the `vscode` API. It shows appropriate notifications based on error type and uses `store.isFirstError` to gate popups (only first error in a burst gets a notification).

## Testing

- **Extension queries:** 258 tests in 10 test files (better-sqlite3 in-memory databases, store/error unit tests)
- **Webview components:** 228 tests in 19 test files (jsdom + React Testing Library)
- Mock patterns: `useWebviewQuery` mocked to return `{ data, isLoading, error }`, navigation mocked via `vi.mock` (must export both `useNavigation` and `useNavigationContext`)

## Key Files

- `packages/vscode/src/extension.ts` -- Main activation, commands, webview, gutter decorations, `presentError()`
- `packages/vscode/src/store.ts` -- ExtensionStore (state, actions, reducer, selectors, StatusSnapshot)
- `packages/vscode/src/errors.ts` -- OphanError type, classifyWatchError() (pure, no vscode dep)
- `packages/vscode/src/native-loader.ts` -- Multi-Electron binary resolver (ABI detection)
- `packages/vscode/src/queries.ts` -- CodeLens DB query functions (better-sqlite3)
- `packages/vscode/src/webview-handler.ts` -- Request/response dispatcher (single db param)
- `packages/vscode/src/webview-queries.ts` -- All webview query implementations (92 tests, incl. graph data)
- `packages/vscode/src/write-db.ts` -- better-sqlite3 lifecycle, state writes, nativeBinding integration
- `packages/vscode/src/migrations.ts` -- Migration runner + extension migrations
- `packages/vscode/src/lens.ts` -- CodeLens title builder
- `packages/vscode/src/diagnostics.ts` -- Issue range resolution, severity mapping
- `packages/vscode/src/types.ts` -- Shared interfaces
- `packages/vscode/scripts/build-native.sh` -- Build multi-Electron native binaries locally
- `packages/vscode/scripts/verify-vsix.sh` -- Inspect VSIX for correct native binaries
- `packages/vscode/scripts/detect-abi.sh` -- Print runtime ABI info for an editor
- `packages/webview/src/App.tsx` -- Root component, mode detection
- `packages/webview/src/navigation.ts` -- Stack-based navigation
- `packages/webview/src/data-bridge.ts` -- DataBridge abstraction
- `packages/webview/src/use-webview-query.ts` -- Data fetching hook
- `packages/webview/src/use-file-analysis-state.ts` -- File analysis state hook (fresh/stale/analyzing)
- `packages/webview/src/browser-queries.ts` -- Browser-mode query handler
- `packages/webview/src/views/StatusView.tsx` -- Status view (operational info, activity log)
- `packages/webview/src/views/GraphView.tsx` -- Interactive graph visualizer (Cytoscape.js, community coloring, edge filtering)
- `packages/webview/src/components/ViewRouter.tsx` -- Route → view mapping
