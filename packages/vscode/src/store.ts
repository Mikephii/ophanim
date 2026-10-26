import type { OphanError } from "./errors";

// ============ ACTIVITY LOG ============

export type ActivityCategory = "analysis" | "scan" | "sync" | "error" | "lifecycle";

export interface ActivityLogEntry {
  timestamp: number;
  category: ActivityCategory;
  message: string;
}

const MAX_LOG_ENTRIES = 50;

// ============ STATE SHAPE ============

export interface ExtensionState {
  watchRunning: boolean;
  watchError: OphanError | null;
  lastCrashTime: number;

  staleFiles: Set<string>;
  analyzedFiles: Set<string>;
  recentErrorCount: number;
  lastErrorTime: number;

  analyzingFile: string | null;
  scanProgress: { current: number; total: number } | null;
  retryState: { attempt: number; maxAttempts: number } | null;

  activityLog: ActivityLogEntry[];
}

// ============ ACTIONS ============

export type ExtensionAction =
  | { type: "WATCH_STARTED" }
  | { type: "WATCH_STOPPED" }
  | { type: "WATCH_CRASHED"; exitCode: number }
  | { type: "WATCH_ERROR"; error: OphanError; file?: string }

  | { type: "ANALYZING"; file: string }
  | { type: "ANALYZED"; file: string }
  | { type: "SCAN_COMPLETE" }
  | { type: "SCAN_PROGRESS"; current: number; total: number; file: string }
  | { type: "RETRY"; attempt: number; maxAttempts: number }

  | { type: "FILE_SAVED"; filePath: string }
  | { type: "DB_CHANGED" }
  | { type: "CLEAR_ERRORS" }

  | { type: "SYNCED"; pushed: number }
  | { type: "SYNC_ERROR"; message: string };

// ============ STATUS BAR STATE (DERIVED) ============

export interface StatusBarState {
  text: string;
  tooltip: string;
}

/** Serializable snapshot of operational state for the webview Status view. */
export interface StatusSnapshot {
  mode: "vscode";
  watchRunning: boolean;
  watchError: { type: string; message: string; severity: string } | null;
  analyzingFile: string | null;
  scanProgress: { current: number; total: number } | null;
  retryState: { attempt: number; maxAttempts: number } | null;
  staleFiles: string[];
  staleCount: number;
  recentErrorCount: number;
  activityLog: ActivityLogEntry[];
}

// ============ STORE ============

const ERROR_RESET_MS = 30_000;

export type ActionListener = (action: ExtensionAction) => void;

export class ExtensionStore {
  private state: ExtensionState;
  private listeners: ActionListener[] = [];
  private errorResetTimer: ReturnType<typeof setTimeout> | null = null;

  // Injected dependencies for status bar derivation (avoid importing vscode in store)
  private hasApiKey: () => boolean;
  private hasDb: () => boolean;

  constructor(deps: { hasApiKey: () => boolean; hasDb: () => boolean }) {
    this.hasApiKey = deps.hasApiKey;
    this.hasDb = deps.hasDb;
    this.state = {
      watchRunning: false,
      watchError: null,
      lastCrashTime: 0,
      staleFiles: new Set(),
      analyzedFiles: new Set(),
      recentErrorCount: 0,
      lastErrorTime: 0,
      analyzingFile: null,
      scanProgress: null,
      retryState: null,
      activityLog: [],
    };
  }

  dispatch(action: ExtensionAction): void {
    this.reduce(action);
    for (const listener of this.listeners) {
      listener(action);
    }
  }

  onAction(listener: ActionListener): { dispose: () => void } {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
      },
    };
  }

  private addLogEntry(category: ActivityCategory, message: string): void {
    this.state.activityLog.push({ timestamp: Date.now(), category, message });
    if (this.state.activityLog.length > MAX_LOG_ENTRIES) {
      this.state.activityLog.shift();
    }
  }

  private reduce(action: ExtensionAction): void {
    switch (action.type) {
      case "WATCH_STARTED":
        this.state.watchRunning = true;
        this.state.watchError = null;
        this.state.analyzingFile = null;
        this.state.scanProgress = null;
        this.state.retryState = null;
        this.addLogEntry("lifecycle", "Watch mode started");
        break;

      case "WATCH_STOPPED":
        this.state.watchRunning = false;
        this.state.analyzingFile = null;
        this.state.scanProgress = null;
        this.state.retryState = null;
        this.addLogEntry("lifecycle", "Watch mode stopped");
        break;

      case "WATCH_CRASHED":
        this.state.watchRunning = false;
        this.state.watchError = {
          type: "process_crash",
          message: "Analysis process stopped unexpectedly",
          severity: "recoverable",
          exitCode: action.exitCode,
          recovery: { label: "Restart", command: "ophan.analyzeNow" },
        };
        this.state.lastCrashTime = Date.now();
        this.state.analyzingFile = null;
        this.addLogEntry("error", `Process crashed (exit code ${action.exitCode})`);
        break;

      case "WATCH_ERROR":
        this.state.recentErrorCount++;
        this.state.lastErrorTime = Date.now();
        this.state.analyzingFile = null;
        if (action.file) {
          this.state.staleFiles.delete(action.file);
        }
        this.scheduleErrorReset();
        this.addLogEntry("error", action.file
          ? `${action.error.message} (${action.file})`
          : action.error.message);
        break;

      case "ANALYZING":
        this.state.analyzingFile = action.file;
        this.addLogEntry("analysis", `Analyzing ${action.file}...`);
        break;

      case "ANALYZED":
        this.state.analyzingFile = null;
        this.state.staleFiles.delete(action.file);   // Clear immediately -- no need to wait for DB_CHANGED
        this.state.analyzedFiles.add(action.file);    // Keep for DB_CHANGED safety net (harmless double-delete)
        this.addLogEntry("analysis", `Analyzed ${action.file}`);
        break;

      case "SCAN_COMPLETE":
        this.state.staleFiles.clear();
        this.state.analyzedFiles.clear();
        this.state.analyzingFile = null;
        this.state.scanProgress = null;
        this.state.retryState = null;
        this.addLogEntry("scan", "Scan complete");
        break;

      case "SCAN_PROGRESS":
        this.state.scanProgress = { current: action.current, total: action.total };
        break;

      case "RETRY":
        this.state.retryState = { attempt: action.attempt, maxAttempts: action.maxAttempts };
        this.addLogEntry("lifecycle", `Retrying (attempt ${action.attempt}/${action.maxAttempts})`);
        break;

      case "FILE_SAVED":
        this.state.staleFiles.add(action.filePath);
        break;

      case "DB_CHANGED":
        // Selective clearing: only clear files we know were analyzed
        for (const file of this.state.analyzedFiles) {
          this.state.staleFiles.delete(file);
        }
        this.state.analyzedFiles.clear();
        break;

      case "CLEAR_ERRORS":
        this.state.recentErrorCount = 0;
        break;

      case "SYNCED":
        this.addLogEntry("sync", `Synced ${action.pushed} entries to cloud`);
        break;

      case "SYNC_ERROR":
        this.addLogEntry("error", `Sync error: ${action.message}`);
        break;
    }
  }

  private scheduleErrorReset(): void {
    if (this.errorResetTimer) clearTimeout(this.errorResetTimer);
    this.errorResetTimer = setTimeout(() => {
      this.errorResetTimer = null;
      this.dispatch({ type: "CLEAR_ERRORS" });
    }, ERROR_RESET_MS);
  }

  // ============ SELECTORS ============

  get watchRunning(): boolean { return this.state.watchRunning; }
  get watchError(): OphanError | null { return this.state.watchError; }
  get staleFiles(): ReadonlySet<string> { return this.state.staleFiles; }
  get staleCount(): number { return this.state.staleFiles.size; }
  get recentErrorCount(): number { return this.state.recentErrorCount; }
  get analyzingFile(): string | null { return this.state.analyzingFile; }
  get lastCrashTime(): number { return this.state.lastCrashTime; }
  get activityLog(): readonly ActivityLogEntry[] { return this.state.activityLog; }

  isFileStale(filePath: string): boolean {
    return this.state.staleFiles.has(filePath);
  }

  /** Returns true if this is the first error in the current burst (for notification gating). */
  get isFirstError(): boolean {
    return this.state.recentErrorCount === 1;
  }

  /** Derived status bar state. Priority order matters. */
  get statusBarState(): StatusBarState {
    // Analyzing a specific file (highest priority for active work)
    if (this.state.analyzingFile) {
      return {
        text: `$(loading~spin) Analyzing ${this.state.analyzingFile}...`,
        tooltip: `Analyzing ${this.state.analyzingFile}`,
      };
    }

    // Scan progress during initial scan
    if (this.state.scanProgress) {
      const { current, total } = this.state.scanProgress;
      return {
        text: `$(loading~spin) Ophan: ${current}/${total} files`,
        tooltip: `Scanning: ${current} of ${total} files`,
      };
    }

    // Retry state during initial scan
    if (this.state.retryState) {
      const { attempt, maxAttempts } = this.state.retryState;
      return {
        text: `$(loading~spin) Ophan: Retry ${attempt}/${maxAttempts}...`,
        tooltip: "Initial scan failed, retrying...",
      };
    }

    // Fatal/persistent error (watch crashed or died)
    if (this.state.watchError) {
      return {
        text: "$(warning) Ophan: Stopped",
        tooltip: `${this.state.watchError.message}. Click to restart.`,
      };
    }

    // Recent transient errors while watch is running
    if (this.state.recentErrorCount > 0 && this.state.watchRunning) {
      const n = this.state.recentErrorCount;
      return {
        text: `$(warning) Ophan: ${n} error${n > 1 ? "s" : ""}`,
        tooltip: `${n} analysis error(s) — check Output for details`,
      };
    }

    // Watch running, no issues
    if (this.state.watchRunning && this.state.staleFiles.size === 0) {
      return {
        text: "$(eye) Ophan",
        tooltip: "Watch mode active — analyzing on save",
      };
    }

    // Stale files pending analysis
    if (this.state.staleFiles.size > 0) {
      const n = this.state.staleFiles.size;
      return {
        text: `$(eye) Ophan: ${n} file${n > 1 ? "s" : ""} pending`,
        tooltip: `${n} file(s) changed — analysis pending`,
      };
    }

    // Setup needed
    if (!this.hasApiKey()) {
      return {
        text: "$(eye) Ophan: Setup needed",
        tooltip: "Set your API key to get started",
      };
    }

    // Ready (no DB yet)
    if (!this.hasDb()) {
      return {
        text: "$(eye) Ophan: Ready",
        tooltip: "Click to analyze this workspace",
      };
    }

    // Default fallback
    return {
      text: "$(eye) Ophan",
      tooltip: "Click to analyze workspace",
    };
  }

  clearStaleFile(filePath: string): void {
    this.state.staleFiles.delete(filePath);
  }

  /** Serializable snapshot of operational state for the webview Status view. */
  getStatusSnapshot(): StatusSnapshot {
    return {
      mode: "vscode",
      watchRunning: this.state.watchRunning,
      watchError: this.state.watchError
        ? {
            type: this.state.watchError.type,
            message: this.state.watchError.message,
            severity: this.state.watchError.severity,
          }
        : null,
      analyzingFile: this.state.analyzingFile,
      scanProgress: this.state.scanProgress,
      retryState: this.state.retryState,
      staleFiles: Array.from(this.state.staleFiles),
      staleCount: this.state.staleFiles.size,
      recentErrorCount: this.state.recentErrorCount,
      activityLog: [...this.state.activityLog],
    };
  }

  clearFileFunctionDataFor(filePath: string): void {
    // For external cache invalidation tracking -- store doesn't own this cache
    // but this method signals that the file's data should be invalidated
  }

  dispose(): void {
    if (this.errorResetTimer) clearTimeout(this.errorResetTimer);
    this.listeners.length = 0;
  }
}
