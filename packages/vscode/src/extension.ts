// Ophan VS Code Extension -- IDE-specific adapter
//
// Architecture:
//   This extension is the VS Code adapter for Ophan. It reads the local .ophan/index.db
//   and surfaces analysis inline via CodeLens, hover tooltips, and webview panels.
//   Analysis is handled by a background `ophan watch --json` subprocess that watches
//   for file changes, runs analysis via Claude, and optionally syncs to the cloud.
//
//   Uses better-sqlite3 for all database access (reads and writes). Every query hits
//   the on-disk file directly, so results are always fresh -- no stale snapshots.
//   WAL mode allows the CLI and extension to access the same file concurrently.
//
//   Communication with the webview uses VS Code's postMessage protocol. The webview sends
//   messages like "ready", "goToDefinition", "selectFunction" and the extension responds
//   with "showFunction", "showHome", "clear". See useVSCode.ts for the webview side.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { spawn, type ChildProcess } from "child_process";
import { handleWebviewRequest, type DataRequest, type DataResponse, type HandlerContext } from "./webview-handler";
import { openWriteDb, closeWriteDb, getWriteDb, writeIssueEditStates } from "./write-db";
import { classifyWatchError, type OphanError } from "./errors";
import { ExtensionStore } from "./store";
import { buildCliEnv, parseServerUrl, shouldPromptSignIn, shouldSync, signInCommand } from "./server-settings";

let panel: vscode.WebviewPanel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
let dbWatcher: fs.FSWatcher | null = null;
let watchProcess: ChildProcess | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let codeLensProvider: OphanCodeLensProvider | null = null;
let diagnosticCollection: vscode.DiagnosticCollection | null = null;
let securityGutterDecorationType: vscode.TextEditorDecorationType | null = null;

// Centralized state store -- manages stale files, error state, watch lifecycle
let store: ExtensionStore | null = null;
let activeWorkspaceRoot: string | null = null;

// Stored gutter decoration ranges per file URI (for re-applying on editor switch)
const securityGutterRanges = new Map<string, vscode.Range[]>();

// Resolved FunctionData per file URI (shared between CodeLens, Hover, and CodeAction providers)
const fileFunctionDataCache = new Map<string, FunctionData[]>();

// FunctionData lookup by contentHash (used by hover command links to avoid encoding full objects)
const functionDataByHash = new Map<string, FunctionData>();

// Supported file extensions for stale detection
const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py",
]);

// Debounce timers for diagnostic re-resolution during editing (per file URI string)
const editDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearEditDebounceTimer(uriString: string): void {
  const timer = editDebounceTimers.get(uriString);
  if (timer) {
    clearTimeout(timer);
    editDebounceTimers.delete(uriString);
  }
}

function clearAllEditDebounceTimers(): void {
  for (const timer of editDebounceTimers.values()) {
    clearTimeout(timer);
  }
  editDebounceTimers.clear();
}

// ============ TYPES ============

import type { FunctionData, DbEntry } from "./types";
import { queryFileAnalysis, queryAllAnalysis, entryToFunctionData, queryCommunityTitle } from "./queries";
import { buildLensTitle } from "./lens";
import { resolveIssueRange, mapSeverity, buildDiagnosticMessage, findFunctionForLine, reResolveFileDiagnostics, type SymbolPosition, type IssueEditState } from "./diagnostics";

// ============ SETTINGS HELPERS ============

function getConfig() {
  return vscode.workspace.getConfiguration("ophan");
}

function getApiKey(): string {
  return getConfig().get<string>("anthropicApiKey") || process.env.ANTHROPIC_API_KEY || "";
}

function getAutoAnalyze(): boolean {
  return getConfig().get<boolean>("autoAnalyze") ?? true;
}

function getAutoSync(): boolean {
  return getConfig().get<boolean>("autoSync") ?? true;
}

function getServerUrl(): string {
  return parseServerUrl(getConfig().get<string>("serverUrl"));
}

function getShowDiagnostics(): boolean {
  return getConfig().get<boolean>("showDiagnostics") ?? true;
}

function getShowGutterIcons(): boolean {
  return getConfig().get<boolean>("showGutterIcons") ?? true;
}

// ============ SYMBOL HELPERS ============

const symbolCache = new Map<
  string,
  { symbols: vscode.DocumentSymbol[]; version: number }
>();

async function getDocumentSymbols(
  document: vscode.TextDocument
): Promise<vscode.DocumentSymbol[]> {
  const key = document.uri.toString();
  const cached = symbolCache.get(key);
  if (cached && cached.version === document.version) {
    return cached.symbols;
  }

  const symbols =
    (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    )) || [];

  // Only cache non-empty results -- the TS language service may not have loaded yet
  // when the extension activates for already-open files, returning empty symbols.
  // Caching that empty result would permanently break CodeLens/hover for the file.
  if (symbols.length > 0) {
    symbolCache.set(key, { symbols, version: document.version });
  }
  return symbols;
}

function collectFunctionSymbols(
  symbols: vscode.DocumentSymbol[]
): vscode.DocumentSymbol[] {
  const result: vscode.DocumentSymbol[] = [];
  for (const sym of symbols) {
    if (
      sym.kind === vscode.SymbolKind.Function ||
      sym.kind === vscode.SymbolKind.Method
    ) {
      result.push(sym);
    }
    if (sym.children) {
      result.push(...collectFunctionSymbols(sym.children));
    }
  }
  return result;
}

function findFunctionAtPosition(
  symbols: vscode.DocumentSymbol[],
  position: vscode.Position
): vscode.DocumentSymbol | null {
  for (const sym of symbols) {
    if (sym.range.contains(position)) {
      // Check children first for innermost match
      const child = findFunctionAtPosition(sym.children, position);
      if (child) return child;

      if (
        sym.kind === vscode.SymbolKind.Function ||
        sym.kind === vscode.SymbolKind.Method
      ) {
        return sym;
      }
    }
  }
  return null;
}

// ============ DB QUERIES (see queries.ts) ============

// ============ ACTIVATION ============

export async function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) return;
  activeWorkspaceRoot = workspaceRoot;

  const dbPath = path.join(workspaceRoot, ".ophan", "index.db");

  // Always create output channel, status bar, and register commands -- even before DB exists
  outputChannel = vscode.window.createOutputChannel("Ophan");

  codeLensProvider = new OphanCodeLensProvider();
  const languages = ["typescript", "typescriptreact", "javascript", "javascriptreact", "python"];

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(languages, codeLensProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      languages,
      new OphanCodeActionProvider(),
      { providedCodeActionKinds: OphanCodeActionProvider.providedCodeActionKinds },
    )
  );

  diagnosticCollection = vscode.languages.createDiagnosticCollection("ophan");
  context.subscriptions.push(diagnosticCollection);

  securityGutterDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconSize: "contain",
    light: {
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "security-gutter.svg").fsPath,
    },
    dark: {
      gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "security-gutter-dark.svg").fsPath,
    },
  });
  context.subscriptions.push(securityGutterDecorationType);

  // ============ STATUS BAR (always visible) ============
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "ophan.statusBarMenu";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ============ STORE (centralized state) ============
  store = new ExtensionStore({
    hasApiKey: () => !!getApiKey(),
    hasDb: () => !!getWriteDb(),
  });
  context.subscriptions.push({ dispose: () => store?.dispose() });

  // Status bar subscriber -- updates on every state change
  const statusBarSub = store.onAction(() => {
    if (!statusBarItem || !store) return;
    const { text, tooltip } = store.statusBarState;
    statusBarItem.text = text;
    statusBarItem.tooltip = tooltip;
  });
  context.subscriptions.push(statusBarSub);

  // Webview status subscriber -- pushes statusChanged to webview (debounced)
  const statusPushSub = store.onAction(() => {
    if (!panel) return;
    if (statusChangedTimeout) clearTimeout(statusChangedTimeout);
    statusChangedTimeout = setTimeout(() => {
      statusChangedTimeout = null;
      panel?.webview.postMessage({ type: "statusChanged" });
    }, 300);
  });
  context.subscriptions.push(statusPushSub);

  // CodeLens subscriber -- refreshes when analysis state changes
  const codeLensSub = store.onAction((action) => {
    if (
      action.type === "FILE_SAVED" ||
      action.type === "DB_CHANGED" ||
      action.type === "SCAN_COMPLETE" ||
      action.type === "WATCH_ERROR" ||
      action.type === "CLEAR_ERRORS" ||
      action.type === "ANALYZED"
    ) {
      codeLensProvider?.fireChange();
    }
  });
  context.subscriptions.push(codeLensSub);

  // Webview subscriber -- notifies of data changes
  const webviewSub = store.onAction((action) => {
    if (action.type === "DB_CHANGED" || action.type === "SCAN_COMPLETE") {
      panel?.webview.postMessage({ type: "dbReloaded" });
    }
  });
  context.subscriptions.push(webviewSub);

  // File-level state subscriber -- notifies webview of stale/analyzing/analyzed per file
  const fileStateSub = store.onAction((action) => {
    if (!panel) return;
    switch (action.type) {
      case "FILE_SAVED":
        panel.webview.postMessage({ type: "fileStale", filePath: action.filePath });
        break;
      case "ANALYZING":
        // CLI sends relative path -- resolve to absolute for webview consistency
        panel.webview.postMessage({
          type: "fileAnalyzing",
          filePath: path.resolve(workspaceRoot, action.file),
        });
        break;
      case "ANALYZED":
        // Already absolute (resolved in handleWatchEvent)
        panel.webview.postMessage({ type: "fileAnalyzed", filePath: action.file });
        break;
    }
  });
  context.subscriptions.push(fileStateSub);

  // ============ COMMANDS (always registered) ============

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ophan.showFunction",
      (fnOrHash: FunctionData | string) => {
        const fn =
          typeof fnOrHash === "string"
            ? functionDataByHash.get(fnOrHash)
            : fnOrHash;
        if (fn) {
          showFunctionPanel(context, fn);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ophan.openPanel", () => {
      showHomePanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ophan.goToDefinition",
      async (filePath: string, target: number | string) => {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);

        let line: number;
        if (typeof target === "number" && target > 0) {
          line = target;
        } else {
          const symbols = await getDocumentSymbols(doc);
          const fnSymbols = collectFunctionSymbols(symbols);
          const match = fnSymbols.find(
            (s) => s.name === (typeof target === "string" ? target : "")
          );
          line = match ? match.range.start.line + 1 : 1;
        }

        // Open in a column adjacent to the webview, never inside it
        const webviewColumn = panel?.viewColumn;
        let targetColumn: vscode.ViewColumn | undefined;
        if (webviewColumn) {
          const leftColumn = webviewColumn - 1;
          const rightColumn = webviewColumn + 1;
          const visibleColumns = vscode.window.visibleTextEditors.map(
            (e) => e.viewColumn
          );
          if (leftColumn >= 1 && visibleColumns.includes(leftColumn as vscode.ViewColumn)) {
            // Prefer existing editor group to the left
            targetColumn = leftColumn as vscode.ViewColumn;
          } else if (visibleColumns.includes(rightColumn as vscode.ViewColumn)) {
            // Use existing editor group to the right
            targetColumn = rightColumn as vscode.ViewColumn;
          } else {
            // No adjacent editors -- open a new split to the right of the webview
            targetColumn = rightColumn as vscode.ViewColumn;
          }
        }
        const editor = await vscode.window.showTextDocument(doc, {
          viewColumn: targetColumn,
          preserveFocus: false,
        });
        const pos = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ophan.analyzeNow", () => {
      runAnalyzeNow(workspaceRoot);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ophan.signIn", () => {
      const command = signInCommand(getServerUrl());
      if (!command) {
        // Sign-in is only for self-hosted servers: point the user at the setting first.
        vscode.commands.executeCommand("workbench.action.openSettings", "ophan.serverUrl");
        vscode.window.showInformationMessage(
          "Ophan: Set ophan.serverUrl to your self-hosted Ophan server to enable sign-in and sync. Local analysis works without one."
        );
        return;
      }
      const terminal = vscode.window.createTerminal("Ophan");
      terminal.show();
      terminal.sendText(command);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ophan.openStatusView", () => {
      showStatusPanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("ophan.statusBarMenu", () => {
      showStatusBarMenu(context);
    })
  );

  // ============ HOVER PROVIDER ============
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(languages, { provideHover })
  );

  // ============ SAVE DETECTION ============
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const ext = path.extname(doc.uri.fsPath);
      if (SUPPORTED_EXTENSIONS.has(ext)) {
        clearEditDebounceTimer(doc.uri.toString());
        fileFunctionDataCache.delete(doc.uri.toString());
        // Don't clear diagnostics/gutter here -- CodeLens fires immediately below
        // and re-emits them at fresh symbol positions. Clearing first causes a
        // visible flash and was the source of squiggles disappearing permanently
        // when the watch process doesn't update the DB (e.g. no function hash changed).
        store?.dispatch({ type: "FILE_SAVED", filePath: doc.uri.fsPath });
      }
    })
  );

  // ============ CLOSE DETECTION ============
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      clearEditDebounceTimer(doc.uri.toString());
      diagnosticCollection?.delete(doc.uri);
      securityGutterRanges.delete(doc.uri.toString());
      fileFunctionDataCache.delete(doc.uri.toString());
    })
  );

  // ============ EDIT DETECTION (diagnostic re-resolution during typing) ============
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const doc = event.document;
      const ext = path.extname(doc.uri.fsPath);
      if (!SUPPORTED_EXTENSIONS.has(ext)) return;
      if (event.contentChanges.length === 0) return;

      const uriStr = doc.uri.toString();
      const cachedFunctions = fileFunctionDataCache.get(uriStr);
      if (!cachedFunctions || cachedFunctions.length === 0) return;

      // Only act if cached functions have issues worth re-resolving
      const hasIssues = cachedFunctions.some(
        (fn) => fn.issues.length > 0 || (fn.practiceViolations?.length ?? 0) > 0
      );
      if (!hasIssues) return;

      // Phase 1: Immediately clear diagnostics + gutter to avoid wrong positions
      diagnosticCollection?.delete(doc.uri);
      securityGutterRanges.delete(uriStr);
      applyGutterDecorations(doc.uri);

      // Phase 2: Debounce 400ms before re-resolving
      clearEditDebounceTimer(uriStr);
      const timer = setTimeout(async () => {
        editDebounceTimers.delete(uriStr);
        await reResolveDiagnosticsForDocument(doc);
      }, 400);
      editDebounceTimers.set(uriStr, timer);
    })
  );

  // ============ GUTTER DECORATION RE-APPLICATION ============
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) applyGutterDecorations(editor.document.uri);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const editor of vscode.window.visibleTextEditors) {
        applyGutterDecorations(editor.document.uri);
      }
    }),
  );

  // ============ SETTINGS CHANGE LISTENER ============
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ophan.anthropicApiKey")) {
        const apiKey = getApiKey();
        if (apiKey && watchProcess) {
          // API key changed while watch is running -- restart with new key
          // (child process env is frozen at spawn time, so the running CLI
          // still uses the old key)
          stopWatchMode().then(() => {
            startWatchMode(workspaceRoot);
          });
        } else if (apiKey && !watchProcess) {
          // API key was just set -- offer to analyze
          const dbExists = fs.existsSync(dbPath);
          if (!dbExists) {
            vscode.window
              .showInformationMessage(
                "Ophan: API key configured. Analyze this workspace?",
                "Analyze Now"
              )
              .then((choice) => {
                if (choice === "Analyze Now") {
                  runAnalyzeNow(workspaceRoot);
                }
              });
          } else {
            // DB exists but watch not running -- start it
            startWatchMode(workspaceRoot);
          }
        } else if (!apiKey && watchProcess) {
          // API key was removed -- stop watch
          stopWatchMode();
        }
      }
      if (e.affectsConfiguration("ophan.autoAnalyze") || e.affectsConfiguration("ophan.autoSync") || e.affectsConfiguration("ophan.serverUrl")) {
        // Restart watch with new settings
        if (watchProcess) {
          stopWatchMode().then(() => {
            if (getAutoAnalyze() && getApiKey()) {
              startWatchMode(workspaceRoot);
            }
          });
        }
      }
      if (e.affectsConfiguration("ophan.showDiagnostics")) {
        if (!getShowDiagnostics()) {
          diagnosticCollection?.clear();
        } else {
          codeLensProvider?.fireChange();
        }
      }
      if (e.affectsConfiguration("ophan.showGutterIcons")) {
        if (!getShowGutterIcons()) {
          securityGutterRanges.clear();
          for (const editor of vscode.window.visibleTextEditors) {
            applyGutterDecorations(editor.document.uri);
          }
        } else {
          codeLensProvider?.fireChange();
        }
      }
    })
  );

  // ============ INITIALIZE BASED ON STATE ============
  const apiKey = getApiKey();
  const dbExists = fs.existsSync(dbPath);

  if (dbExists) {
    // DB exists -- open it and optionally start watch
    try {
      openWriteDb(dbPath);
    } catch (e) {
      outputChannel?.appendLine(`Failed to open database: ${e}`);
      // Continue activation without DB -- CodeLens and panel degrade gracefully,
      // and the DB will be retried on scan_complete if watch mode starts.
    }
    setupDbWatcher(dbPath, context);

    // Check if DB has analysis or just file index (post-init state)
    const db = getWriteDb();
    const hasAnalysis = db ? (() => {
      try {
        const row = db.prepare("SELECT COUNT(*) as c FROM function_analysis").get() as { c: number };
        return row.c > 0;
      } catch {
        return false;
      }
    })() : false;

    if (apiKey && getAutoAnalyze()) {
      startWatchMode(workspaceRoot);
    } else if (!apiKey && !hasAnalysis) {
      // Post-init state: DB exists but no analysis, no API key
      vscode.window
        .showInformationMessage(
          "Ophan: Project initialized. Set your API key to start analysis.",
          "Open Settings"
        )
        .then((choice) => {
          if (choice === "Open Settings") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "ophan.anthropicApiKey"
            );
          }
        });
    }
    updateStatusBar();

    // Prompt unsigned-in users to enable cloud sync (one-time, dismissible), but only
    // when they have configured their own server: there is no hosted default.
    const credentialsPath = path.join(os.homedir(), ".ophan", "credentials.json");
    const signInDismissed = context.globalState.get<boolean>("ophan.signInDismissed") ?? false;
    if (shouldPromptSignIn({ serverUrl: getServerUrl(), dismissed: signInDismissed, hasCredentials: fs.existsSync(credentialsPath) })) {
      vscode.window
        .showInformationMessage(
          "Ophan: Sign in to your Ophan server to sync analysis across machines and use the web dashboard.",
          "Sign In",
          "Learn More",
          "Don't Show Again"
        )
        .then((choice) => {
          if (choice === "Sign In") {
            vscode.commands.executeCommand("ophan.signIn");
          } else if (choice === "Learn More") {
            vscode.env.openExternal(vscode.Uri.parse("https://github.com/Mikephii/ophanim/blob/main/docs/cloud-sync.md"));
          } else if (choice === "Don't Show Again") {
            context.globalState.update("ophan.signInDismissed", true);
          }
        });
    }
  } else if (!apiKey) {
    // No DB, no API key -- prompt for setup
    statusBarItem.text = "$(eye) Ophan: Setup needed";
    statusBarItem.tooltip = "Set your API key to get started";
    vscode.window
      .showInformationMessage(
        "Welcome to Ophan! Set your Anthropic API key to get started.",
        "Open Settings",
        "Learn More"
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "ophan.anthropicApiKey"
          );
        } else if (choice === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/Mikephii/ophanim/blob/main/docs/getting-started.md"));
        }
      });
  } else {
    // No DB but has API key -- offer to analyze
    statusBarItem.text = "$(eye) Ophan: Ready";
    statusBarItem.tooltip = "Click to analyze this workspace";
    vscode.window
      .showInformationMessage(
        "Ophan: Analyze this workspace?",
        "Analyze Now",
        "Dismiss"
      )
      .then((choice) => {
        if (choice === "Analyze Now") {
          runAnalyzeNow(workspaceRoot);
        }
      });
  }
}

// ============ DATABASE ============

function setupDbWatcher(dbPath: string, context: vscode.ExtensionContext) {
  let dbReloadTimeout: ReturnType<typeof setTimeout> | null = null;
  try {
    dbWatcher = fs.watch(dbPath, () => {
      if (dbReloadTimeout) clearTimeout(dbReloadTimeout);
      dbReloadTimeout = setTimeout(() => {
        onDatabaseChanged();
      }, 500);
    });
    context.subscriptions.push({ dispose: () => dbWatcher?.close() });
  } catch {
    // fs.watch may fail on some platforms -- non-critical
  }
}

/**
 * Called when the DB file changes on disk (CLI wrote new analysis).
 * With better-sqlite3, queries always read from disk -- no snapshot reload needed.
 * We just need to clear stale markers and re-trigger CodeLens + webview.
 */
function onDatabaseChanged() {
  if (!getWriteDb()) return;

  // Clear UI caches -- fresh DB means we need to re-derive everything
  clearAllEditDebounceTimers();
  diagnosticCollection?.clear();
  securityGutterRanges.clear();
  fileFunctionDataCache.clear();

  for (const editor of vscode.window.visibleTextEditors) {
    applyGutterDecorations(editor.document.uri);
  }

  // Dispatch through store -- selectively clears only files that were analyzed
  // (store tracks which files CLI reported via "analyzed" events)
  store?.dispatch({ type: "DB_CHANGED" });
}

// ============ WATCH MODE ============

let watchBuffer = "";

function resolveCliCommand(): { command: string; args: string[] } {
  try {
    // In development workspace, resolve CLI entry point directly.
    // Use tsx to handle TypeScript source dependencies (@ophan/core
    // exports raw .ts via pnpm workspace, which plain node can't load).
    const cliEntry = require.resolve("@ophan/cli/dist/index.js");
    return { command: "npx", args: ["tsx", cliEntry] };
  } catch {
    // In production (packaged extension), use npx to find/install CLI
    return { command: "npx", args: ["@ophan/cli"] };
  }
}

function startWatchMode(workspaceRoot: string) {
  if (watchProcess) return; // Already running

  // Prevent rapid restart loops after crashes
  const CRASH_COOLDOWN_MS = 10_000;
  const lastCrash = store?.lastCrashTime ?? 0;
  if (lastCrash && Date.now() - lastCrash < CRASH_COOLDOWN_MS) {
    outputChannel?.appendLine("Watch process recently crashed — skipping restart. Use 'Analyze Now' to retry.");
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) return;

  const { command, args: cliArgs } = resolveCliCommand();
  const args = [...cliArgs, "watch", "--json", "--path", workspaceRoot];
  const serverUrl = getServerUrl();
  if (shouldSync(getAutoSync(), serverUrl)) args.push("--sync");

  const env = buildCliEnv(process.env, { apiKey, serverUrl });

  outputChannel?.appendLine(`Starting watch mode...`);
  outputChannel?.appendLine(`CLI: ${command} ${args.join(" ")}`);

  const spawnTime = Date.now();

  watchProcess = spawn(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });

  watchBuffer = "";

  watchProcess.stdout?.on("data", (chunk: Buffer) => {
    watchBuffer += chunk.toString();
    // Parse line-delimited JSON
    const lines = watchBuffer.split("\n");
    watchBuffer = lines.pop() || ""; // Keep incomplete line in buffer
    for (const line of lines) {
      if (line.trim()) {
        handleWatchEvent(line.trim(), workspaceRoot);
      }
    }
  });

  watchProcess.stderr?.on("data", (chunk: Buffer) => {
    outputChannel?.appendLine(chunk.toString());
  });

  watchProcess.on("exit", (code) => {
    watchProcess = null;
    if (code !== 0 && code !== null) {
      outputChannel?.appendLine(`Watch process exited with code ${code}`);
      if (Date.now() - spawnTime < 5000) {
        // Quick exit = startup failure (CLI not found, bad args, etc.)
        store?.dispatch({ type: "WATCH_CRASHED", exitCode: code });
        vscode.window
          .showErrorMessage(
            "Ophan: Analysis process failed to start. Check the output for details.",
            "Show Output"
          )
          .then((choice) => {
            if (choice === "Show Output") outputChannel?.show();
          });
      } else {
        // Long-running process died unexpectedly (Bug 4 fix)
        store?.dispatch({ type: "WATCH_CRASHED", exitCode: code });
        if (outputChannel) {
          presentError(store!.watchError!, outputChannel, true);
        }
      }
    } else {
      store?.dispatch({ type: "WATCH_STOPPED" });
    }
  });

  watchProcess.on("error", (err) => {
    outputChannel?.appendLine(`Watch process error: ${err.message}`);
    watchProcess = null;
    store?.dispatch({ type: "WATCH_CRASHED", exitCode: -1 });
    vscode.window
      .showErrorMessage(
        "Ophan: Could not start analysis. Make sure Node.js 18+ is installed.",
        "Show Output"
      )
      .then((choice) => {
        if (choice === "Show Output") outputChannel?.show();
      });
  });

  store?.dispatch({ type: "WATCH_STARTED" });
}

function stopWatchMode(): Promise<void> {
  if (!watchProcess) return Promise.resolve();
  const proc = watchProcess;
  watchProcess = null;
  proc.kill("SIGTERM");
  // Wait for the process to actually exit so the lock file is released
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 3000);
    proc.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Present a classified error to the user via VS Code notifications.
 * Only shows notifications for actionable errors; transient errors are logged only.
 * Uses `isFirstInBurst` to avoid notification spam (show one per error burst).
 */
function presentError(
  error: OphanError,
  channel: vscode.OutputChannel,
  isFirstInBurst: boolean
): void {
  channel.appendLine(`[${error.type}] ${error.message}`);

  switch (error.type) {
    case "api_key_invalid":
      vscode.window
        .showErrorMessage(`Ophan: ${error.message}`, error.recovery.label)
        .then((choice) => {
          if (choice === error.recovery.label) {
            vscode.commands.executeCommand(error.recovery.command, ...(error.recovery.args ?? []));
          }
        });
      break;

    case "rate_limited":
      if (isFirstInBurst) {
        vscode.window.showWarningMessage(
          `Ophan: ${error.message}. Will retry automatically.`,
          error.recovery.label
        ).then((choice) => {
          if (choice === error.recovery.label) channel.show();
        });
      }
      break;

    case "network_error":
    case "timeout":
      if (isFirstInBurst) {
        vscode.window
          .showWarningMessage(`Ophan: ${error.message}`, error.recovery.label)
          .then((choice) => {
            if (choice === error.recovery.label) {
              vscode.commands.executeCommand(error.recovery.command);
            }
          });
      }
      break;

    case "process_crash":
      vscode.window
        .showErrorMessage(
          "Ophan: Analysis process stopped unexpectedly.",
          "Restart",
          "Show Output"
        )
        .then((choice) => {
          if (choice === "Restart") vscode.commands.executeCommand("ophan.analyzeNow");
          if (choice === "Show Output") channel.show();
        });
      break;

    case "db_locked":
    case "analysis_failed":
      break;

    default: {
      const _exhaustive: never = error;
      channel.appendLine(`Unhandled error type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function handleWatchEvent(line: string, workspaceRoot: string) {
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    outputChannel?.appendLine(line);
    return;
  }

  const dbPath = path.join(workspaceRoot, ".ophan", "index.db");

  switch (event.event) {
    case "scan_complete":
      outputChannel?.appendLine(
        `Scan complete: ${event.analyzed} analyzed, ${event.cached} cached` +
        (event.pulled ? ` (${event.pulled} from cloud)` : "") +
        ` across ${event.files} files`
      );
      // Initial scan done -- DB should exist now, open it if first time
      if (!getWriteDb()) {
        try {
          openWriteDb(dbPath);
        } catch (e) {
          outputChannel?.appendLine(`Failed to open database after scan: ${e}`);
          break;
        }
        codeLensProvider?.fireChange();
        // Notify webview that data is now available (DB was just opened)
        panel?.webview.postMessage({ type: "dbReloaded" });
        // Set up DB watcher if not already watching
        if (!dbWatcher) {
          let dbReloadTimeout: ReturnType<typeof setTimeout> | null = null;
          try {
            dbWatcher = fs.watch(dbPath, () => {
              if (dbReloadTimeout) clearTimeout(dbReloadTimeout);
              dbReloadTimeout = setTimeout(() => {
                onDatabaseChanged();
              }, 500);
            });
          } catch {}
        }
      }
      store?.dispatch({ type: "SCAN_COMPLETE" });
      break;

    case "scan_progress":
      store?.dispatch({ type: "SCAN_PROGRESS", current: event.current, total: event.total, file: event.file });
      break;

    case "retry":
      store?.dispatch({ type: "RETRY", attempt: event.attempt, maxAttempts: event.maxAttempts });
      break;

    case "analyzing":
      store?.dispatch({ type: "ANALYZING", file: event.file });
      break;

    case "analyzed":
      outputChannel?.appendLine(
        `Analyzed ${event.file}: ${event.analyzed} new, ${event.cached} cached (${event.duration_ms}ms)`
      );
      store?.dispatch({ type: "ANALYZED", file: path.resolve(workspaceRoot, event.file) });
      break;

    case "synced":
      if (event.pushed > 0) {
        outputChannel?.appendLine(`Synced: ${event.pushed} entries pushed`);
        store?.dispatch({ type: "SYNCED", pushed: event.pushed });
      }
      break;

    case "sync_warning":
      outputChannel?.appendLine(`Sync: ${event.message}`);
      break;

    case "sync_error":
      outputChannel?.appendLine(`Sync error: ${event.message}`);
      store?.dispatch({ type: "SYNC_ERROR", message: event.message });
      break;

    case "error": {
      const absFile = event.file ? path.resolve(workspaceRoot, event.file) : undefined;
      const classified = classifyWatchError(event.message || "", absFile);
      store?.dispatch({ type: "WATCH_ERROR", error: classified, file: absFile });
      if (outputChannel) {
        presentError(classified, outputChannel, store?.isFirstError ?? true);
      }
      break;
    }
  }
}

// ============ STATUS BAR MENU ============

interface StatusBarMenuItem extends vscode.QuickPickItem {
  action?: string;
}

function showStatusBarMenu(context: vscode.ExtensionContext) {
  const items: StatusBarMenuItem[] = [];
  const hasKey = !!getApiKey();
  const hasDb = !!getWriteDb();
  const watchRunning = store?.watchRunning ?? false;
  const watchError = store?.watchError ?? null;
  const staleCount = store?.staleCount ?? 0;
  const errorCount = store?.recentErrorCount ?? 0;

  // ---- Status section ----
  if (!hasKey) {
    items.push({
      label: "$(key) Set API Key",
      description: "Required to enable analysis",
      action: "setupApiKey",
    });
  }

  if (watchRunning) {
    const desc = staleCount > 0
      ? `${staleCount} file${staleCount > 1 ? "s" : ""} pending`
      : errorCount > 0
        ? `${errorCount} error${errorCount > 1 ? "s" : ""}`
        : "Watching for changes";
    items.push({
      label: "$(circle-filled) Active",
      description: desc,
      kind: vscode.QuickPickItemKind.Default,
      action: "status",
    });
  } else if (watchError) {
    items.push({
      label: "$(error) Stopped",
      description: watchError.message,
      action: "status",
    });
  } else if (hasDb) {
    items.push({
      label: "$(circle-outline) Idle",
      description: "Watch mode not running",
      action: "status",
    });
  }

  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  // ---- Actions section ----
  if (watchRunning) {
    items.push({
      label: "$(debug-stop) Stop Watch",
      description: "Stop the analysis process",
      action: "stopWatch",
    });
    items.push({
      label: "$(debug-restart) Restart Watch",
      description: "Restart analysis from scratch",
      action: "restart",
    });
  } else if (hasKey) {
    items.push({
      label: "$(play) Start Analysis",
      description: watchError ? "Restart after error" : "Run watch mode",
      action: "analyze",
    });
  }

  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  // ---- Views section ----
  items.push({
    label: "$(home) Open Dashboard",
    description: "Security overview and function analysis",
    action: "dashboard",
  });
  items.push({
    label: "$(pulse) View Status",
    description: "Activity log and diagnostics",
    action: "status",
  });
  items.push({
    label: "$(output) Show Output Log",
    description: "Raw analysis output",
    action: "output",
  });

  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });

  // ---- Settings section ----
  items.push({
    label: "$(cloud-upload) Sync to Cloud",
    description: "Push analysis to Supabase",
    action: "signIn",
  });
  items.push({
    label: "$(gear) Settings",
    description: "Configure API key, auto-analyze, and more",
    action: "settings",
  });

  const quickPick = vscode.window.createQuickPick<StatusBarMenuItem>();
  quickPick.items = items;
  quickPick.placeholder = "Ophan";
  quickPick.matchOnDescription = true;

  quickPick.onDidAccept(() => {
    const selected = quickPick.selectedItems[0];
    quickPick.dispose();
    if (!selected?.action) return;

    switch (selected.action) {
      case "setupApiKey":
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "ophan.anthropicApiKey"
        );
        break;
      case "analyze":
        if (activeWorkspaceRoot) runAnalyzeNow(activeWorkspaceRoot);
        break;
      case "stopWatch":
        stopWatchMode();
        store?.dispatch({ type: "WATCH_STOPPED" });
        break;
      case "restart":
        if (activeWorkspaceRoot) runAnalyzeNow(activeWorkspaceRoot);
        break;
      case "dashboard":
        showHomePanel(context);
        break;
      case "status":
        showStatusPanel(context);
        break;
      case "output":
        outputChannel?.show(true);
        break;
      case "signIn":
        vscode.commands.executeCommand("ophan.signIn");
        break;
      case "settings":
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "ophan"
        );
        break;
    }
  });

  quickPick.onDidHide(() => quickPick.dispose());
  quickPick.show();
}

// ============ ANALYZE NOW COMMAND ============

async function runAnalyzeNow(workspaceRoot: string) {
  const apiKey = getApiKey();
  if (!apiKey) {
    vscode.window
      .showErrorMessage(
        "Ophan: Set your Anthropic API key to enable analysis.",
        "Open Settings"
      )
      .then((choice) => {
        if (choice === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "ophan.anthropicApiKey"
          );
        }
      });
    return;
  }

  if (watchProcess) {
    // Watch is running -- wait for it to fully stop before restarting
    await stopWatchMode();
  }

  // Explicit user action -- clear crash cooldown and error state
  store?.dispatch({ type: "CLEAR_ERRORS" });

  outputChannel?.show(true);
  startWatchMode(workspaceRoot);
}

// ============ CODELENS PROVIDER ============

class OphanCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  fireChange() {
    this._onDidChangeCodeLenses.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument
  ): Promise<vscode.CodeLens[]> {
    const db = getWriteDb();
    if (!db) return [];

    const filePath = document.uri.fsPath;

    // Get analysis from DB
    const entries = queryFileAnalysis(db, filePath);
    if (entries.length === 0) return [];

    // Build lookup: for each name, store entries in order (handles duplicate names)
    const byName = new Map<string, DbEntry[]>();
    for (const entry of entries) {
      const list = byName.get(entry.functionName) || [];
      list.push(entry);
      byName.set(entry.functionName, list);
    }

    // Get document symbols for line resolution
    const symbols = await getDocumentSymbols(document);
    const fnSymbols = collectFunctionSymbols(symbols);

    const lenses: vscode.CodeLens[] = [];
    const resolvedFunctions: FunctionData[] = [];

    // Track which entries we've used per name (for duplicate disambiguation)
    const nameIndex = new Map<string, number>();

    for (const sym of fnSymbols) {
      const list = byName.get(sym.name);
      if (!list || list.length === 0) continue;

      // Pick next entry for this name
      const idx = nameIndex.get(sym.name) || 0;
      const entry = list[idx % list.length];
      nameIndex.set(sym.name, idx + 1);

      const fn = entryToFunctionData(
        entry,
        filePath,
        sym.range.start.line + 1,
        sym.range.end.line + 1
      );

      // Look up community title (graceful if no graph data)
      const communityTitle = queryCommunityTitle(db, fn.contentHash);
      if (communityTitle) {
        fn.communityTitle = communityTitle;
      }

      resolvedFunctions.push(fn);
      functionDataByHash.set(fn.contentHash, fn);

      const range = new vscode.Range(
        sym.range.start,
        sym.range.start
      );

      const isStale = store?.isFileStale(filePath) ?? false;
      lenses.push(
        new vscode.CodeLens(range, {
          title: buildLensTitle(fn, isStale),
          command: "ophan.showFunction",
          arguments: [fn],
        })
      );
    }

    // Cache resolved functions for Hover and CodeAction providers
    fileFunctionDataCache.set(document.uri.toString(), resolvedFunctions);

    // Resolve issue positions and emit diagnostics + edit state.
    // Always resolve even for stale files -- symbol positions are fresh from the
    // language server. Edit state is always written (even if diagnostics are
    // disabled) so the webview has correct adjustedLine values.
    const showDiag = diagnosticCollection && getShowDiagnostics();
    const diagnostics: vscode.Diagnostic[] = [];
    const codeLensEditStates: IssueEditState[] = [];

    for (const fn of resolvedFunctions) {
      const securityIssues = fn.issues;
      const practiceViolations = fn.practiceViolations || [];
      const getLine = (line0: number) => document.lineAt(line0).text;

      for (let si = 0; si < securityIssues.length; si++) {
        const issue = securityIssues[si];
        if (!issue.title && !issue.flag) continue;

        const resolved = resolveIssueRange(
          issue, fn.startLine, fn.endLine, getLine, document.lineCount,
        );

        // Record edit state for ALL issues (including suppressed ones)
        codeLensEditStates.push({
          contentHash: fn.contentHash,
          issueType: "security",
          issueIndex: si,
          adjustedLine: resolved.startLine,
          potentiallyRemediated: !resolved.anchorFound,
        });

        if (resolved.anchorFound && !issue.lineText) {
          issue.lineText = document.lineAt(resolved.startLine).text.trim();
        }

        if (!resolved.anchorFound || !showDiag) continue;

        const range = new vscode.Range(
          resolved.startLine, resolved.startChar,
          resolved.endLine, resolved.endChar,
        );
        const diag = new vscode.Diagnostic(
          range, buildDiagnosticMessage(issue), mapSeverity(issue.severity),
        );
        diag.source = "Ophan";
        const encodedArgs = encodeURIComponent(JSON.stringify([fn.contentHash]));
        diag.code = {
          value: issue.flag || "view",
          target: vscode.Uri.parse(`command:ophan.showFunction?${encodedArgs}`),
        };
        diagnostics.push(diag);
      }

      for (let pi = 0; pi < practiceViolations.length; pi++) {
        const issue = practiceViolations[pi];
        if (!issue.title && !issue.flag) continue;

        const resolved = resolveIssueRange(
          issue, fn.startLine, fn.endLine, getLine, document.lineCount,
        );

        codeLensEditStates.push({
          contentHash: fn.contentHash,
          issueType: "practice",
          issueIndex: pi,
          adjustedLine: resolved.startLine,
          potentiallyRemediated: !resolved.anchorFound,
        });

        if (resolved.anchorFound && !issue.lineText) {
          issue.lineText = document.lineAt(resolved.startLine).text.trim();
        }

        if (!resolved.anchorFound || !showDiag) continue;

        const range = new vscode.Range(
          resolved.startLine, resolved.startChar,
          resolved.endLine, resolved.endChar,
        );
        const diag = new vscode.Diagnostic(
          range, buildDiagnosticMessage(issue), mapSeverity(issue.severity),
        );
        diag.source = "Ophan";
        const encodedArgs = encodeURIComponent(JSON.stringify([fn.contentHash]));
        diag.code = {
          value: issue.flag || "view",
          target: vscode.Uri.parse(`command:ophan.showFunction?${encodedArgs}`),
        };
        diagnostics.push(diag);
      }
    }

    if (showDiag && diagnosticCollection) {
      // Deduplicate by (line, flag) -- Claude sometimes returns near-duplicate issues
      const seenDiag = new Set<string>();
      const deduped = diagnostics.filter((d) => {
        const flag = typeof d.code === "object" && d.code !== null ? (d.code as { value: string }).value : "";
        const key = `${d.range.start.line}:${flag}`;
        if (seenDiag.has(key)) return false;
        seenDiag.add(key);
        return true;
      });
      diagnosticCollection.set(document.uri, deduped);
    } else if (diagnosticCollection) {
      diagnosticCollection.delete(document.uri);
    }

    // Write edit state so the webview has fresh adjustedLine values.
    // This runs on every CodeLens resolution (including after DB reload).
    if (codeLensEditStates.length > 0) {
      writeIssueEditStates(codeLensEditStates);
      panel?.webview.postMessage({ type: "editStateChanged" });
    }

    // Emit gutter decoration icons -- reuse resolved positions from edit state
    if (securityGutterDecorationType && getShowGutterIcons()) {
      const seenLines = new Set<number>();
      const gutterRanges: vscode.Range[] = [];
      for (const es of codeLensEditStates) {
        if (es.potentiallyRemediated) continue;
        if (!seenLines.has(es.adjustedLine)) {
          seenLines.add(es.adjustedLine);
          gutterRanges.push(new vscode.Range(es.adjustedLine, 0, es.adjustedLine, 0));
        }
      }
      securityGutterRanges.set(document.uri.toString(), gutterRanges);
      applyGutterDecorations(document.uri);
    } else {
      securityGutterRanges.delete(document.uri.toString());
      applyGutterDecorations(document.uri);
    }

    return lenses;
  }
}

// buildLensTitle -- see lens.ts

// ============ CODE ACTION PROVIDER ============

class OphanCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const ophanDiags = context.diagnostics.filter((d) => d.source === "Ophan");
    if (ophanDiags.length === 0) return [];

    const cachedFunctions = fileFunctionDataCache.get(document.uri.toString());
    if (!cachedFunctions) return [];

    const actions: vscode.CodeAction[] = [];
    const seen = new Set<string>();

    for (const diag of ophanDiags) {
      const fn = findFunctionForLine(cachedFunctions, diag.range.start.line);
      if (!fn || seen.has(fn.name)) continue;
      seen.add(fn.name);

      const action = new vscode.CodeAction(
        `View "${fn.name}" in Ophan`,
        vscode.CodeActionKind.QuickFix,
      );
      action.command = {
        title: `View "${fn.name}" in Ophan`,
        command: "ophan.showFunction",
        arguments: [fn],
      };
      action.diagnostics = [diag];
      action.isPreferred = false;
      actions.push(action);
    }

    return actions;
  }
}

// ============ GUTTER DECORATION HELPERS ============

function applyGutterDecorations(uri: vscode.Uri) {
  if (!securityGutterDecorationType) return;
  const uriStr = uri.toString();
  const ranges = securityGutterRanges.get(uriStr) || [];

  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() === uriStr) {
      editor.setDecorations(securityGutterDecorationType, ranges);
    }
  }
}

// ============ DEBOUNCED DIAGNOSTIC RE-RESOLUTION ============

/**
 * Re-resolves diagnostics for a document using cached analysis + fresh symbol positions.
 * Called after the debounce timer fires during editing. Bridges the pure
 * reResolveFileDiagnostics function with VS Code APIs.
 */
async function reResolveDiagnosticsForDocument(
  document: vscode.TextDocument
): Promise<void> {
  const showDiag = getShowDiagnostics();
  const showGutter = getShowGutterIcons();
  if (!showDiag && !showGutter) return;

  const uriStr = document.uri.toString();
  const cachedFunctions = fileFunctionDataCache.get(uriStr);
  if (!cachedFunctions || cachedFunctions.length === 0) return;

  // Invalidate symbol cache to force a fresh request to the language server.
  // Without this, we may reuse stale symbols cached by a concurrent CodeLens call
  // that ran before the TS server processed the edit.
  symbolCache.delete(document.uri.toString());

  const symbols = await getDocumentSymbols(document);
  const fnSymbols = collectFunctionSymbols(symbols);

  const freshSymbols: SymbolPosition[] = fnSymbols.map((sym) => ({
    name: sym.name,
    startLine: sym.range.start.line,
    endLine: sym.range.end.line,
  }));

  const { diagnostics: resolvedDiags, gutterLines, issueEditStates } = reResolveFileDiagnostics(
    cachedFunctions,
    freshSymbols,
    (line0) => document.lineAt(line0).text,
    document.lineCount,
  );

  // Write edit state to index.db for webview consumption
  if (issueEditStates.length > 0) {
    writeIssueEditStates(issueEditStates);
    panel?.webview.postMessage({ type: "editStateChanged" });
  }

  // Emit diagnostics
  if (diagnosticCollection && showDiag) {
    const vscDiagnostics: vscode.Diagnostic[] = resolvedDiags.map((rd) => {
      const range = new vscode.Range(
        rd.range.startLine, rd.range.startChar,
        rd.range.endLine, rd.range.endChar,
      );
      const diag = new vscode.Diagnostic(range, rd.message, rd.severity);
      diag.source = "Ophan";
      const encodedArgs = encodeURIComponent(JSON.stringify([rd.contentHash]));
      diag.code = {
        value: rd.flag || "view",
        target: vscode.Uri.parse(`command:ophan.showFunction?${encodedArgs}`),
      };
      return diag;
    });
    diagnosticCollection.set(document.uri, vscDiagnostics);
  }

  // Emit gutter decorations
  if (securityGutterDecorationType && showGutter) {
    const gutterRanges = gutterLines.map(
      (line0) => new vscode.Range(line0, 0, line0, 0)
    );
    securityGutterRanges.set(uriStr, gutterRanges);
    applyGutterDecorations(document.uri);
  }
}

// ============ STATUS BAR HELPERS ============

/** Sync status bar from store. Called on activation and when store subscribers
 *  haven't been set up yet (e.g., initial state before watch starts). */
function updateStatusBar() {
  if (!statusBarItem || !store) return;
  const { text, tooltip } = store.statusBarState;
  statusBarItem.text = text;
  statusBarItem.tooltip = tooltip;
}

// ============ WEBVIEW PANEL ============

let statusChangedTimeout: ReturnType<typeof setTimeout> | null = null;

function getHandlerContext(): HandlerContext {
  return {
    store: store ?? null,
    onAnalyzeNow: () => { if (activeWorkspaceRoot) runAnalyzeNow(activeWorkspaceRoot); },
    onOpenOutput: () => outputChannel?.show(),
    onOpenFile: async (filePath: string) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    },
  };
}

function showStatusPanel(context: vscode.ExtensionContext) {
  // Ensure panel exists (reuse showHomePanel for creation)
  showHomePanel(context);
  // Then navigate to status view
  panel?.webview.postMessage({ type: "showStatus" });
}

function showHomePanel(context: vscode.ExtensionContext) {
  const db = getWriteDb();
  const functionsByFile = db ? queryAllAnalysis(db) : new Map<string, FunctionData[]>();

  const data = Array.from(functionsByFile.entries()).map(
    ([filePath, functions]) => ({
      filePath,
      functions,
    })
  );

  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    panel.webview.postMessage({ type: "showHome", data });
    panel.title = "Ophan";
  } else {
    panel = vscode.window.createWebviewPanel(
      "ophanFunction",
      "Ophan",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-dist"),
        ],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "ophan.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "ophan-dark.svg"),
    };

    panel.onDidDispose(() => {
      panel = null;
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      // Handle new request/response protocol
      if (message.type === "request" && typeof message.id === "string") {
        const response = await handleWebviewRequest(getWriteDb(), message as DataRequest, getHandlerContext());
        panel?.webview.postMessage(response);
        return;
      }

      switch (message.type) {
        case "ready":
          if (panel) {
            panel.webview.postMessage({ type: "showHome", data });
          }
          break;
        case "selectFunction":
          if (panel) {
            panel.webview.postMessage({
              type: "showFunction",
              data: message.fn,
            });
            panel.title = `Ophan: ${message.fn.name}`;
          }
          break;
        case "goToDefinition":
          vscode.commands.executeCommand(
            "ophan.goToDefinition",
            message.filePath,
            message.line || message.functionName
          );
          break;
        case "backToHome":
          if (panel) {
            const currentDb = getWriteDb();
            const freshMap = currentDb ? queryAllAnalysis(currentDb) : new Map<string, FunctionData[]>();
            const freshData = Array.from(freshMap.entries()).map(
              ([filePath, functions]) => ({ filePath, functions })
            );
            panel.webview.postMessage({ type: "showHome", data: freshData });
            panel.title = "Ophan";
          }
          break;
      }
    });

    panel.webview.html = getWebviewContent(context, panel.webview);
  }
}

async function showFunctionPanel(
  context: vscode.ExtensionContext,
  fn: FunctionData
) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
  } else {
    panel = vscode.window.createWebviewPanel(
      "ophanFunction",
      "Ophan",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-dist"),
        ],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "ophan.svg"),
      dark: vscode.Uri.joinPath(context.extensionUri, "resources", "icons", "ophan-dark.svg"),
    };

    panel.onDidDispose(() => {
      panel = null;
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      // Handle new request/response protocol
      if (message.type === "request" && typeof message.id === "string") {
        const response = await handleWebviewRequest(getWriteDb(), message as DataRequest, getHandlerContext());
        panel?.webview.postMessage(response);
        return;
      }

      switch (message.type) {
        case "ready":
          if (panel) {
            panel.webview.postMessage({ type: "showFunction", data: fn });
          }
          break;
        case "goToDefinition":
          vscode.commands.executeCommand(
            "ophan.goToDefinition",
            message.filePath,
            message.line || message.functionName
          );
          break;
        case "refresh":
          // TODO: Re-analyze current function
          break;
      }
    });

    panel.webview.html = getWebviewContent(context, panel.webview);
  }

  panel.webview.postMessage({ type: "showFunction", data: fn });
  panel.title = `Ophan: ${fn.name}`;
}

function getWebviewContent(
  context: vscode.ExtensionContext,
  webview: vscode.Webview
): string {
  const webviewDistPath = vscode.Uri.joinPath(
    context.extensionUri,
    "webview-dist"
  );

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDistPath, "webview.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(webviewDistPath, "webview.css")
  );

  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data: ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>Ophan</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    // Sync dark/light class with VS Code theme
    (function() {
      function sync() {
        var isDark = document.body.classList.contains('vscode-dark') ||
                     document.body.classList.contains('vscode-high-contrast');
        document.documentElement.classList.toggle('dark', isDark);
      }
      sync();
      new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    })();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// ============ HOVER PROVIDER ============

async function provideHover(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Hover | null> {
  const db = getWriteDb();
  if (!db) return null;

  // Find which function the cursor is inside
  const symbols = await getDocumentSymbols(document);
  const fnSymbol = findFunctionAtPosition(symbols, position);
  if (!fnSymbol) return null;

  // Look up analysis by name
  const entries = queryFileAnalysis(db, document.uri.fsPath);
  const entry = entries.find((e) => e.functionName === fnSymbol.name);
  if (!entry) return null;

  const { analysis } = entry;

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`### ${fnSymbol.name}\n\n`);
  md.appendMarkdown(`${analysis.description}\n\n`);

  if (analysis.params.length) {
    md.appendMarkdown(`**Params:**\n`);
    analysis.params.forEach((p) => {
      md.appendMarkdown(`- \`${p.name}\` (${p.type}): ${p.description}\n`);
    });
    md.appendMarkdown(`\n`);
  }

  if (analysis.returns.type) {
    md.appendMarkdown(
      `**Returns:** ${analysis.returns.type} — ${analysis.returns.description}\n\n`
    );
  }

  if (analysis.dataTags.length) {
    md.appendMarkdown(
      `**Data:** ${analysis.dataTags.map((t) => `\`${t}\``).join(" ")}\n\n`
    );
  }

  if (analysis.securityFlags.length) {
    md.appendMarkdown(
      `⚠️ **Security:** ${analysis.securityFlags.join(", ")}\n\n`
    );
    if (analysis.issues && analysis.issues.length > 0) {
      for (const issue of analysis.issues) {
        const loc = issue.line > 0 ? ` (line ${issue.line})` : "";
        md.appendMarkdown(`- **${issue.title}**${loc}: ${issue.description}\n`);
      }
    }
  }

  if (analysis.practiceViolations && analysis.practiceViolations.length > 0) {
    md.appendMarkdown(
      `\n📋 **Practice Violations:** ${analysis.practiceViolations.length}\n\n`
    );
    for (const v of analysis.practiceViolations) {
      const loc = v.line > 0 ? ` (line ${v.line})` : "";
      md.appendMarkdown(`- **${v.title || v.flag}**${loc}: ${v.description}\n`);
    }
  }

  // Add "View in Ophan" command link
  const cachedFunctions = fileFunctionDataCache.get(document.uri.toString());
  const fnData = cachedFunctions?.find(
    (f) => f.name === fnSymbol.name && f.contentHash === entry.contentHash
  );
  if (fnData) {
    const encodedArgs = encodeURIComponent(JSON.stringify([fnData.contentHash]));
    md.appendMarkdown(`\n---\n[View in Ophan](command:ophan.showFunction?${encodedArgs})`);
    md.isTrusted = true;
  }

  return new vscode.Hover(md, fnSymbol.range);
}

// ============ LIFECYCLE ============

export function deactivate() {
  clearAllEditDebounceTimers();
  closeWriteDb();
  dbWatcher?.close();
  stopWatchMode();
  symbolCache.clear();
  store?.dispose();
  diagnosticCollection?.clear();
  securityGutterRanges.clear();
  fileFunctionDataCache.clear();
  functionDataByHash.clear();
}
