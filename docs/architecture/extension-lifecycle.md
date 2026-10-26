# Extension Lifecycle

## Activation

The extension activates on `onStartupFinished` and follows a state-based initialization:

```
activate()
  ├── Always: create output channel, status bar, register all commands
  ├── Check DB existence + API key + analysis state
  │     ├── DB exists + API key → openWriteDb() → startWatchMode()
  │     ├── DB exists + analysis + no API key → openWriteDb() (read-only mode)
  │     ├── DB exists + no analysis + no API key → toast "Set API key" (post-init state)
  │     ├── No DB + API key → toast "Analyze?" → user clicks → startWatchMode()
  │     └── No DB, no API key → toast "Set API key" → [Open Settings]
  └── Listen for settings changes
```

Commands are registered before the DB check so "Analyze Now" works even on first run (before `.ophan/index.db` exists).

## Watch Mode

The extension spawns `ophan watch --json [--sync]` as a long-running subprocess:

```typescript
spawn("npx", ["@ophan/cli", "watch", "--json", "--path", workspaceRoot, "--sync"], {
  env: { ...process.env, ANTHROPIC_API_KEY: apiKeyFromSettings },
  stdio: ["ignore", "pipe", "pipe"],
  shell: true,
})
```

### Subprocess Lifecycle

- **Start**: after activation (DB exists + key + autoAnalyze) or after "Analyze Now"
- **Stop**: on deactivate, or before restart
- **Restart**: on "Analyze Now" (kills + restarts for full rescan), on settings change
- **Exit handling**: Non-zero exit dispatches `WATCH_CRASHED` action → sets `watchError` state → status bar shows `$(warning) Ophan: Stopped`. Quick exits (<5s) additionally show an error modal. Late exits (>5s, e.g. process dies after hours) show a warning notification with "Analyze Now" button
- **Spawn failure**: if `npx` is unavailable (ENOENT), shows error modal prompting Node.js installation

### JSON Event Stream

Watch subprocess writes line-delimited JSON to stdout:

| Event | Fields | Extension Action |
|-------|--------|-----------------|
| `scan_complete` | files, analyzed, cached, pulled | Open DB if first run, dispatch `SCAN_COMPLETE` |
| `scan_progress` | current, total, file | Dispatch `SCAN_PROGRESS` → status bar shows `42/200 files` |
| `analyzing` | file | Dispatch `ANALYZING` → status bar spinner |
| `analyzed` | file, analyzed, cached, pulled, duration_ms | Dispatch `ANALYZED` → tracked for selective stale clearing |
| `retry` | attempt, maxAttempts, message, delayMs | Dispatch `RETRY` → status bar shows `Retry 2/3...` |
| `synced` | pushed, locations | Log to output, dispatch `SYNCED` (if pushed > 0) |
| `sync_warning` | message | Log to output |
| `sync_error` | message | Log to output, dispatch `SYNC_ERROR` |
| `error` | file?, message | Classify via `classifyWatchError()` → dispatch `WATCH_ERROR` → `presentError()` |

### Buffer Parsing

stdout arrives in chunks, not complete lines. The extension buffers partial data:

```typescript
watchBuffer += chunk.toString();
const lines = watchBuffer.split("\n");
watchBuffer = lines.pop() || ""; // Keep incomplete line
```

## DB Lifecycle

The extension uses better-sqlite3 (native Node.js) for ALL reads and writes on `.ophan/index.db`. Every query hits the on-disk file directly -- results are always fresh, no stale in-memory snapshots.

### Single-Engine Architecture

1. **Initial open**: `openWriteDb(dbPath)` opens a better-sqlite3 handle, sets WAL mode + `busy_timeout = 5000`, runs extension migrations, consolidates any legacy `local-state.db`
2. **All reads**: CodeLens queries, webview queries, and state reads all use the same `getWriteDb()` handle
3. **All writes**: `dismissIssue()`, `undismissIssue()`, `writeIssueEditStates()` write directly to disk
4. **On CLI writes**: `fs.watch()` on the DB file, debounced 500ms → `onDatabaseChanged()` clears caches and fires CodeLens refresh
5. **Close**: `closeWriteDb()` on extension deactivate

### Why Not sql.js?

The extension previously used a dual-engine approach: sql.js (WASM) for reads + better-sqlite3 for writes. sql.js loads the entire DB into memory as a snapshot that goes stale immediately when the CLI writes new analysis. This caused persistent bugs:

- **Stale `start_line` values**: Webview showed original function positions, not updated ones after editing
- **Edit state not propagating**: State written by better-sqlite3 wasn't visible to sql.js reads
- **Timing races**: DB reloads required `checkpointWal()` + full-file re-read, with race conditions between writes and reads

Consolidating on better-sqlite3 eliminated all of these issues. sql.js is still used in the webview browser dev mode (`packages/webview`) where native modules aren't available, but it should NEVER be used in the extension host.

### `onDatabaseChanged()` Handler

Called when the DB file watcher fires (CLI wrote new analysis). Uses **selective stale clearing** -- only files the CLI reported as analyzed (via `"analyzed"` events tracked in `store.analyzedFiles`) are cleared from the stale set. Files saved but not yet analyzed retain their stale markers.

```typescript
function onDatabaseChanged() {
  if (!getWriteDb()) return;
  store.dispatch({ type: "DB_CHANGED" });  // Selective clearing via analyzedFiles
  clearAllEditDebounceTimers();
  diagnosticCollection?.clear();
  securityGutterRanges.clear();
  fileFunctionDataCache.clear();
  for (const editor of vscode.window.visibleTextEditors) {
    applyGutterDecorations(editor.document.uri);
  }
  codeLensProvider?.fireChange();
  panel?.webview.postMessage({ type: "dbReloaded" });
}
```

No snapshot reload needed -- the next CodeLens/query resolution will read fresh data from disk automatically.

### Error Handling Flow

All errors from the watch process flow through a typed classification system:

```
CLI emits { event: "error", message, file? }
  → classifyWatchError(message, file)    // Pure function in errors.ts → OphanError
  → store.dispatch({ type: "WATCH_ERROR", error, file })
  → presentError(error, store, outputChannel)  // Shows appropriate VS Code notification
```

Error types: `api_key_invalid` (fatal → Open Settings), `rate_limited` (transient → View Output), `network_error` / `timeout` (recoverable → Retry), `process_crash` (recoverable → Restart), `db_locked` (transient → log only), `analysis_failed` (recoverable → Show Output).

Notification gating: Only the first error in a burst gets a popup (`store.isFirstError`). Subsequent errors increment the status bar counter. After 30s of quiet, the error count auto-resets.

### Migration System
- `_ophan_migrations` table shared between CLI (core's `initDb()`) and extension (`migrations.ts`)
- Each maintains independent migration lists (extension: `EXTENSION_MIGRATIONS`, core: inline in `initDb()`)
- Extension runner is self-contained (~30 lines, doesn't import from `@ophan/core`)
- Migrations run in transactions -- failed migration rolls back without being recorded

**Key modules**: `write-db.ts` (lifecycle, state writes, consolidation), `migrations.ts` (runner + migration list)

### Edit State Flow

Edit state (`issue_edit_state` table) bridges the gap between the language server's live positions and the DB's analysis-time positions. It is written in two places:

**Path 1: CodeLens resolution (every refresh)**
1. `provideCodeLenses()` resolves issue positions using fresh language server symbols
2. `writeIssueEditStates()` writes `IssueEditState[]` for ALL issues (including suppressed ones)
3. `editStateChanged` push event sent to webview → auto-refetch

**Path 2: Debounced edit re-resolution (during editing)**
1. `onDidChangeTextDocument` fires → diagnostics cleared immediately
2. 400ms debounce expires → `reResolveDiagnosticsForDocument()` runs
3. `reResolveFileDiagnostics()` returns `issueEditStates[]` for ALL issues
4. `writeIssueEditStates()` writes to `index.db` via better-sqlite3 (transactional)
5. `editStateChanged` push event sent to webview → auto-refetch

**Edit state is NOT cleared on DB reload.** Entries are keyed by `(content_hash, issue_type, issue_index)` -- stale entries for old content hashes are harmless (won't be looked up). CodeLens resolution writes fresh entries after every DB reload.

## API Key Flow

Priority order:
1. VS Code setting: `ophan.anthropicApiKey`
2. System environment: `ANTHROPIC_API_KEY`

The key is passed to the watch subprocess via environment variable, so the CLI's existing `dotenv/config` picks it up transparently.

**Hot reload:** When the user changes `ophan.anthropicApiKey` in settings while watch is running, the extension automatically stops and restarts the watch process with the new key. If the key is removed, the watch is stopped. This is necessary because child process environment is frozen at spawn time -- changing the setting alone doesn't propagate to the running CLI.

## Settings

| Setting | Default | Effect |
|---------|---------|--------|
| `ophan.anthropicApiKey` | `""` | Required for analysis. Changing it restarts watch. |
| `ophan.autoAnalyze` | `true` | Enables watch mode. Disabling stops the watch subprocess. |
| `ophan.autoSync` | `true` | Adds `--sync` flag to watch. Disabling restarts watch without sync. |
| `ophan.showDiagnostics` | `true` | Enables squiggly underlines + Problems panel entries. Disabling clears all diagnostics. |
| `ophan.showGutterIcons` | `true` | Shows custom shield icons in the editor gutter next to security/practice findings. |

Settings changes are detected via `onDidChangeConfiguration` and trigger watch restart as needed.

## Stale Detection

1. User saves a supported file (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`)
2. `store.dispatch({ type: "FILE_SAVED", filePath })` → file added to `staleFiles` set
3. CodeLens shows `$(sync~spin)` icon for that file's functions
4. Watch subprocess detects the change (5s debounce) and re-analyzes
5. CLI emits `"analyzed"` event → `store.dispatch({ type: "ANALYZED", file })` → tracked in `analyzedFiles`
6. CLI writes updated analysis to `.ophan/index.db`
7. DB watcher fires → `store.dispatch({ type: "DB_CHANGED" })` → **selectively** clears only analyzed files from `staleFiles`

**Webview panel stale/analyzing banner:** The extension also forwards file-level state events to the webview panel via push events (`fileStale`, `fileAnalyzing`, `fileAnalyzed`). The webview's `useFileAnalysisState(filePath)` hook subscribes to these events and renders a contextual banner in `FunctionDetailView`:
- **Stale:** "Edited -- pending re-analysis" with clock icon
- **Analyzing:** "Re-analyzing..." with spinner
- **Fresh:** No banner (default, also reset by `dbReloaded` as safety valve)

The `ANALYZING` action's relative file path (from CLI) is resolved to absolute via `path.resolve(workspaceRoot, action.file)` before sending to the webview, ensuring path matching with `nav.current.params.filePath`.

**Selective clearing:** Unlike the previous blanket `staleFiles.clear()`, `DB_CHANGED` now only removes files that the CLI confirmed as analyzed. If user saves files A and B but only A completes analysis before the DB change, B retains its stale marker. `SCAN_COMPLETE` (full scan) still clears all stale files.

**Error clearing:** When analysis fails for a specific file (`WATCH_ERROR` with `file`), the stale marker is also cleared. This follows the "false negatives over false positives" principle -- briefly showing a non-stale CodeLens is better than a permanent spinning icon.

With watch mode active, the stale→analyzed cycle is automatic and typically takes 5-15 seconds depending on function count and API latency.

## Commands

| Command | Behavior |
|---------|----------|
| `ophan.openStatusView` | Opens webview panel to Status view (status bar click target) |
| `ophan.analyzeNow` | Stops watch, restarts watch (full rescan). Shows output channel. |
| `ophan.openPanel` | Opens webview panel with all functions overview |
| `ophan.showFunction` | Opens webview panel with specific function detail |
| `ophan.goToDefinition` | Navigates editor to function source |
| `ophan.signIn` | Opens terminal, runs `npx @ophan/cli login` |

### Status Bar → Status View

Clicking the status bar item opens the webview panel navigated to the **Status** view (`ophan.openStatusView`). The Status view shows:

- **Watch Status** -- running/stopped/error indicator with Analyze Now + Output buttons
- **Analysis Progress** (conditional) -- current file, scan progress bar, retry state
- **Pending Files** (conditional) -- clickable list of stale files (opens in editor)
- **Activity Log** -- newest-first list from the store's activity log buffer (last 50 entries)

The Status view is also accessible from the webview navigation menu. Data comes from `store.getStatusSnapshot()` via the `getStatus` query (no DB needed), auto-refreshed on `statusChanged` push events (debounced 300ms).

## Installation Paths

All common installation orderings are handled:

| Path | What Happens |
|------|-------------|
| **Extension first (no CLI)** | Extension spawns `npx @ophan/cli watch --json` on demand -- CLI is downloaded by npx automatically. If npx/Node.js unavailable, error modal shown. |
| **`init` first → extension (no API key)** | DB exists with file_functions but no analysis. Extension loads DB, detects empty function_analysis, prompts "Set API key to start analysis". |
| **`init` + `watch` first → extension (no API key)** | DB has analysis. Extension loads it read-only -- CodeLens shows existing analysis without an API key. |
| **`init` + `watch` first → extension (with API key)** | Extension starts its own watch. CLI's lock file (`.ophan/watch.lock`) prevents conflicts if CLI watch is still running. |
| **Extension with API key, no prior init** | Extension offers "Analyze this workspace?" -- watch subprocess handles DB creation and full analysis. |
| **DB deleted while running** | fs.watch fires, onDatabaseChanged catches read errors silently, retries on next DB write. |

## Diagnostics

Security findings from `DetailedIssue` data are surfaced through VS Code's native Diagnostics API:

- **Squiggly underlines** in the editor (red for error, yellow for warning, blue for info)
- **Problems panel** entries (filterable by source "Ophan")
- **Gutter icons** -- custom amber shield SVGs at `resources/icons/security-gutter.svg` (light) and `security-gutter-dark.svg` (dark), 16x16, applied via `createTextEditorDecorationType` with `gutterIconSize: "contain"`
- **Quick Fix actions** -- `OphanCodeActionProvider` offers "View in Ophan" on diagnostics with `source === "Ophan"`, opening the webview panel for the containing function
- **Hover links** -- the hover provider appends a `[View in Ophan](command:ophan.showFunction?...)` markdown link (requires `md.isTrusted = true`)

### Shared FunctionData Cache

`fileFunctionDataCache` (`Map<string, FunctionData[]>`) stores resolved function data per file URI. Populated in `provideCodeLenses()`, consumed by the hover provider and `OphanCodeActionProvider`. Cleared on file save, close, DB reload, and deactivate.

### Lifecycle

1. `DiagnosticCollection` created in `activate()`, registered in `context.subscriptions`
2. `OphanCodeActionProvider` registered alongside CodeLens provider in `activate()`
3. Diagnostics emitted from `provideCodeLenses()` -- piggybacks on the same DB query + symbol resolution
4. Cleared on file save (stale detection) and DB reload (full refresh)
5. Cleared on document close to avoid phantom Problems panel entries
6. Gated by `ophan.showDiagnostics` setting (default: `true`)

### Location Resolution (`diagnostics.ts`)

`resolveIssueRange()` maps `DetailedIssue.line` (1-indexed within function) + `startText`/`endText` anchor snippets to a precise `vscode.Range`:

1. Compute file line: `functionStartLine + issue.line - 2` (1-indexed → 0-indexed)
2. Find `startText` on that line via `indexOf()` → character start
3. If not found, search nearby lines within the function (handles line drift from stale symbol positions)
4. Find `endText` after `startText` → character end
5. Returns `anchorFound: boolean` -- `false` when the issue's code was modified or removed

### Remediation Detection

When a user edits the actual code an issue points to (e.g. fixes `eval(data)` → `JSON.parse(data)`), the system detects this and suppresses the squiggle rather than showing a misleading highlight on the fixed code.

**Mechanism**: At analysis time, the trimmed source line text is stored as `lineText` on each `DetailedIssue`. At resolution time, `resolveIssueRange()` compares the stored `lineText` with the current document line. If they differ, `anchorFound` is set to `false` and the diagnostic/gutter icon is not emitted.

**Self-healing**: The watch process re-analyzes within 10-15 seconds. Fresh analysis produces new `lineText` matching the current code. If the issue was truly fixed, no squiggle returns. If it persists (e.g. user only renamed a variable), the squiggle returns at the correct position with fresh anchors.

**Backwards compatibility**: Old analysis rows without `lineText` (empty string via `.catch("")`) fall back to anchor-only detection -- `anchorFound` based on whether `startText` was found in the function.

## Module Structure

Extension code is split into testable modules:

| File | Exports | Tested? |
|------|---------|---------|
| `types.ts` | `FunctionAnalysis`, `FunctionData`, `DbEntry` interfaces | N/A (types only) |
| `errors.ts` | `OphanError`, `classifyWatchError()`, `ErrorRecoveryAction` | Yes -- 18 tests (pure, no vscode dep) |
| `store.ts` | `ExtensionStore`, `ExtensionState`, `ExtensionAction`, `StatusBarState`, `StatusSnapshot`, `ActivityLogEntry` | Yes -- 47 tests (pure, no vscode dep) |
| `queries.ts` | `queryFileAnalysis(db, path)`, `queryAllAnalysis(db)`, `entryToFunctionData(...)` | Yes -- better-sqlite3 in-memory DB |
| `lens.ts` | `buildLensTitle(fn, isStale)` | Yes -- pure function |
| `diagnostics.ts` | `resolveIssueRange(...)`, `mapSeverity(...)`, `buildDiagnosticMessage(...)`, `findFunctionForLine(...)` | Yes -- pure functions |
| `webview-queries.ts` | All webview data query functions incl. `getGraphData()` (single better-sqlite3 db) | Yes -- 92 tests |
| `webview-handler.ts` | `handleWebviewRequest(db, message, context?)` request dispatcher | Yes -- 8 tests |
| `write-db.ts` | `openWriteDb()`, `closeWriteDb()`, `getWriteDb()`, `writeIssueEditStates()`, `clearEditState()` | Yes -- 14 tests |
| `migrations.ts` | `runMigrations()`, `EXTENSION_MIGRATIONS` | Yes -- 7 tests |
| `extension.ts` | `activate()`, `deactivate()`, CodeLens provider, hover, CodeAction provider, diagnostics, webview, `presentError()` | No -- requires VS Code extension host |
