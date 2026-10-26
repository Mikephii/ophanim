import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExtensionStore, type ExtensionAction } from "./store";
import type { OphanError } from "./errors";

function makeStore(overrides?: { hasApiKey?: boolean; hasDb?: boolean }): ExtensionStore {
  return new ExtensionStore({
    hasApiKey: () => overrides?.hasApiKey ?? true,
    hasDb: () => overrides?.hasDb ?? true,
  });
}

function makeError(type: OphanError["type"] = "analysis_failed"): OphanError {
  return {
    type: "analysis_failed",
    message: "test error",
    severity: "recoverable",
    recovery: { label: "Retry", command: "ophan.analyzeNow" },
  };
}

describe("ExtensionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("stale file tracking", () => {
    it("adds file to stale set on FILE_SAVED", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      expect(store.isFileStale("/src/a.ts")).toBe(true);
      expect(store.staleCount).toBe(1);
    });

    it("clears stale file on WATCH_ERROR with file", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "WATCH_ERROR", error: makeError(), file: "/src/a.ts" });
      expect(store.isFileStale("/src/a.ts")).toBe(false);
      expect(store.staleCount).toBe(0);
    });

    it("selective clearing on DB_CHANGED: only clears analyzed files", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/b.ts" });
      // CLI reports file A as analyzed
      store.dispatch({ type: "ANALYZED", file: "/src/a.ts" });
      // DB changes
      store.dispatch({ type: "DB_CHANGED" });
      // A should be cleared, B should still be stale
      expect(store.isFileStale("/src/a.ts")).toBe(false);
      expect(store.isFileStale("/src/b.ts")).toBe(true);
      expect(store.staleCount).toBe(1);
    });

    it("clears all stale files on SCAN_COMPLETE", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/b.ts" });
      store.dispatch({ type: "SCAN_COMPLETE" });
      expect(store.staleCount).toBe(0);
    });

    it("DB_CHANGED with no analyzed files clears nothing", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "DB_CHANGED" });
      expect(store.isFileStale("/src/a.ts")).toBe(true);
    });

    it("ANALYZED immediately clears file from staleFiles (cache-hit path)", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      expect(store.isFileStale("/src/a.ts")).toBe(true);
      // CLI reports analyzed (all cache hits -- DB won't change)
      store.dispatch({ type: "ANALYZED", file: "/src/a.ts" });
      // Should be cleared immediately, not waiting for DB_CHANGED
      expect(store.isFileStale("/src/a.ts")).toBe(false);
      expect(store.staleCount).toBe(0);
    });

    it("cache-hit scenario: status bar returns to idle after ANALYZED", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      expect(store.statusBarState.text).toContain("1 file pending");
      store.dispatch({ type: "ANALYZED", file: "/src/a.ts" });
      // Should show idle (no pending), not stuck at "1 file pending"
      expect(store.statusBarState.text).toBe("$(eye) Ophan");
      expect(store.statusBarState.tooltip).toContain("Watch mode active");
    });

    it("DB_CHANGED after ANALYZED is a harmless no-op (double-delete)", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "ANALYZED", file: "/src/a.ts" });
      expect(store.isFileStale("/src/a.ts")).toBe(false);
      // DB_CHANGED fires later -- should not crash or re-add the file
      store.dispatch({ type: "DB_CHANGED" });
      expect(store.isFileStale("/src/a.ts")).toBe(false);
      expect(store.staleCount).toBe(0);
    });
  });

  describe("watch lifecycle", () => {
    it("tracks watch running state", () => {
      const store = makeStore();
      expect(store.watchRunning).toBe(false);
      store.dispatch({ type: "WATCH_STARTED" });
      expect(store.watchRunning).toBe(true);
      store.dispatch({ type: "WATCH_STOPPED" });
      expect(store.watchRunning).toBe(false);
    });

    it("sets error on WATCH_CRASHED", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "WATCH_CRASHED", exitCode: 1 });
      expect(store.watchRunning).toBe(false);
      expect(store.watchError).not.toBeNull();
      expect(store.watchError!.type).toBe("process_crash");
      expect(store.lastCrashTime).toBeGreaterThan(0);
    });

    it("clears error on WATCH_STARTED", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_CRASHED", exitCode: 1 });
      expect(store.watchError).not.toBeNull();
      store.dispatch({ type: "WATCH_STARTED" });
      expect(store.watchError).toBeNull();
    });

    it("clears analyzing file on WATCH_STOPPED", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "ANALYZING", file: "src/a.ts" });
      expect(store.analyzingFile).toBe("src/a.ts");
      store.dispatch({ type: "WATCH_STOPPED" });
      expect(store.analyzingFile).toBeNull();
    });
  });

  describe("error tracking", () => {
    it("increments error count on WATCH_ERROR", () => {
      const store = makeStore();
      expect(store.recentErrorCount).toBe(0);
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.recentErrorCount).toBe(1);
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.recentErrorCount).toBe(2);
    });

    it("isFirstError is true only for first error", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.isFirstError).toBe(true);
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.isFirstError).toBe(false);
    });

    it("auto-resets error count after 30s", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.recentErrorCount).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(store.recentErrorCount).toBe(0);
    });

    it("resets timer on each new error", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      vi.advanceTimersByTime(20_000);
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      vi.advanceTimersByTime(20_000);
      // Only 20s since last error, should still have count
      expect(store.recentErrorCount).toBe(2);
      vi.advanceTimersByTime(10_000);
      // Now 30s since last error
      expect(store.recentErrorCount).toBe(0);
    });

    it("clears error count on CLEAR_ERRORS", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      store.dispatch({ type: "CLEAR_ERRORS" });
      expect(store.recentErrorCount).toBe(0);
    });
  });

  describe("statusBarState selector", () => {
    it("shows analyzing file when actively analyzing", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "ANALYZING", file: "src/foo.ts" });
      const state = store.statusBarState;
      expect(state.text).toContain("$(loading~spin)");
      expect(state.text).toContain("src/foo.ts");
    });

    it("shows scan progress during initial scan", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "SCAN_PROGRESS", current: 42, total: 200, file: "src/x.ts" });
      const state = store.statusBarState;
      expect(state.text).toContain("42/200");
    });

    it("shows retry state", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "RETRY", attempt: 2, maxAttempts: 3 });
      const state = store.statusBarState;
      expect(state.text).toContain("Retry 2/3");
    });

    it("shows stopped on watch crash", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_CRASHED", exitCode: 1 });
      const state = store.statusBarState;
      expect(state.text).toContain("$(warning)");
      expect(state.text).toContain("Stopped");
    });

    it("shows error count when watch has errors", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      const state = store.statusBarState;
      expect(state.text).toContain("3 errors");
      expect(state.text).toContain("$(warning)");
    });

    it("shows normal state when watch running with no issues", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      const state = store.statusBarState;
      expect(state.text).toBe("$(eye) Ophan");
      expect(state.tooltip).toContain("Watch mode active");
    });

    it("shows pending files count", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/b.ts" });
      const state = store.statusBarState;
      expect(state.text).toContain("2 files pending");
    });

    it("shows singular for 1 pending file", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      const state = store.statusBarState;
      expect(state.text).toContain("1 file pending");
    });

    it("shows setup needed when no API key", () => {
      const store = makeStore({ hasApiKey: false });
      const state = store.statusBarState;
      expect(state.text).toContain("Setup needed");
    });

    it("shows ready when no DB", () => {
      const store = makeStore({ hasDb: false });
      const state = store.statusBarState;
      expect(state.text).toContain("Ready");
    });

    it("shows default fallback", () => {
      const store = makeStore();
      const state = store.statusBarState;
      expect(state.text).toBe("$(eye) Ophan");
      expect(state.tooltip).toContain("Click to analyze");
    });
  });

  describe("action listeners", () => {
    it("notifies listeners on dispatch", () => {
      const store = makeStore();
      const actions: ExtensionAction[] = [];
      store.onAction((a) => actions.push(a));
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/a.ts" });
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe("WATCH_STARTED");
      expect(actions[1].type).toBe("FILE_SAVED");
    });

    it("dispose removes listener", () => {
      const store = makeStore();
      const actions: ExtensionAction[] = [];
      const sub = store.onAction((a) => actions.push(a));
      store.dispatch({ type: "WATCH_STARTED" });
      expect(actions).toHaveLength(1);
      sub.dispose();
      store.dispatch({ type: "WATCH_STOPPED" });
      expect(actions).toHaveLength(1); // No new action received
    });
  });

  describe("analyzing state", () => {
    it("tracks currently analyzing file", () => {
      const store = makeStore();
      expect(store.analyzingFile).toBeNull();
      store.dispatch({ type: "ANALYZING", file: "src/a.ts" });
      expect(store.analyzingFile).toBe("src/a.ts");
      store.dispatch({ type: "ANALYZED", file: "/abs/src/a.ts" });
      expect(store.analyzingFile).toBeNull();
    });

    it("clears analyzing on error", () => {
      const store = makeStore();
      store.dispatch({ type: "ANALYZING", file: "src/a.ts" });
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.analyzingFile).toBeNull();
    });
  });

  describe("activity log", () => {
    it("logs WATCH_STARTED as lifecycle event", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("lifecycle");
      expect(store.activityLog[0].message).toContain("started");
    });

    it("logs WATCH_STOPPED as lifecycle event", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STOPPED" });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("lifecycle");
      expect(store.activityLog[0].message).toContain("stopped");
    });

    it("logs WATCH_CRASHED as error event with exit code", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_CRASHED", exitCode: 1 });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("error");
      expect(store.activityLog[0].message).toContain("crashed");
      expect(store.activityLog[0].message).toContain("1");
    });

    it("logs WATCH_ERROR with file context", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError(), file: "/src/a.ts" });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("error");
      expect(store.activityLog[0].message).toContain("/src/a.ts");
    });

    it("logs WATCH_ERROR without file", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_ERROR", error: makeError() });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("error");
      expect(store.activityLog[0].message).toBe("test error");
    });

    it("logs ANALYZING and ANALYZED as analysis events", () => {
      const store = makeStore();
      store.dispatch({ type: "ANALYZING", file: "src/a.ts" });
      store.dispatch({ type: "ANALYZED", file: "/abs/src/a.ts" });
      expect(store.activityLog).toHaveLength(2);
      expect(store.activityLog[0].category).toBe("analysis");
      expect(store.activityLog[0].message).toContain("src/a.ts");
      expect(store.activityLog[1].category).toBe("analysis");
      expect(store.activityLog[1].message).toContain("/abs/src/a.ts");
    });

    it("logs SCAN_COMPLETE as scan event", () => {
      const store = makeStore();
      store.dispatch({ type: "SCAN_COMPLETE" });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("scan");
    });

    it("logs RETRY as lifecycle event with attempt info", () => {
      const store = makeStore();
      store.dispatch({ type: "RETRY", attempt: 2, maxAttempts: 3 });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("lifecycle");
      expect(store.activityLog[0].message).toContain("2/3");
    });

    it("logs SYNCED as sync event", () => {
      const store = makeStore();
      store.dispatch({ type: "SYNCED", pushed: 5 });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("sync");
      expect(store.activityLog[0].message).toContain("5");
    });

    it("logs SYNC_ERROR as error event", () => {
      const store = makeStore();
      store.dispatch({ type: "SYNC_ERROR", message: "auth failed" });
      expect(store.activityLog).toHaveLength(1);
      expect(store.activityLog[0].category).toBe("error");
      expect(store.activityLog[0].message).toContain("auth failed");
    });

    it("does not log FILE_SAVED, DB_CHANGED, SCAN_PROGRESS, or CLEAR_ERRORS", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/a.ts" });
      store.dispatch({ type: "DB_CHANGED" });
      store.dispatch({ type: "SCAN_PROGRESS", current: 1, total: 10, file: "x.ts" });
      store.dispatch({ type: "CLEAR_ERRORS" });
      expect(store.activityLog).toHaveLength(0);
    });

    it("enforces circular buffer limit of 50", () => {
      const store = makeStore();
      for (let i = 0; i < 60; i++) {
        store.dispatch({ type: "ANALYZING", file: `file${i}.ts` });
      }
      expect(store.activityLog).toHaveLength(50);
      // First entry should be file10 (0-9 evicted)
      expect(store.activityLog[0].message).toContain("file10.ts");
    });

    it("includes timestamps on all entries", () => {
      const store = makeStore();
      vi.setSystemTime(new Date("2026-01-15T10:30:00Z"));
      store.dispatch({ type: "WATCH_STARTED" });
      expect(store.activityLog[0].timestamp).toBe(new Date("2026-01-15T10:30:00Z").getTime());
    });
  });

  describe("getStatusSnapshot", () => {
    it("returns serializable snapshot of current state", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });
      store.dispatch({ type: "ANALYZING", file: "src/b.ts" });

      const snapshot = store.getStatusSnapshot();
      expect(snapshot.mode).toBe("vscode");
      expect(snapshot.watchRunning).toBe(true);
      expect(snapshot.analyzingFile).toBe("src/b.ts");
      expect(snapshot.staleFiles).toEqual(["/src/a.ts"]);
      expect(snapshot.staleCount).toBe(1);
      expect(snapshot.watchError).toBeNull();
      // Verify it is JSON-serializable (no Sets, no complex objects)
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    });

    it("serializes watchError without recovery actions", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_CRASHED", exitCode: 1 });

      const snapshot = store.getStatusSnapshot();
      expect(snapshot.watchError).toEqual({
        type: "process_crash",
        message: "Analysis process stopped unexpectedly",
        severity: "recoverable",
      });
      // Should NOT include recovery, exitCode, or other OphanError-specific fields
      expect(snapshot.watchError).not.toHaveProperty("recovery");
      expect(snapshot.watchError).not.toHaveProperty("exitCode");
    });

    it("includes activity log", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "ANALYZED", file: "/src/a.ts" });

      const snapshot = store.getStatusSnapshot();
      expect(snapshot.activityLog).toHaveLength(2);
      expect(snapshot.activityLog[0].category).toBe("lifecycle");
      expect(snapshot.activityLog[1].category).toBe("analysis");
    });

    it("includes scan progress and retry state", () => {
      const store = makeStore();
      store.dispatch({ type: "WATCH_STARTED" });
      store.dispatch({ type: "SCAN_PROGRESS", current: 5, total: 20, file: "f.ts" });
      store.dispatch({ type: "RETRY", attempt: 2, maxAttempts: 3 });

      const snapshot = store.getStatusSnapshot();
      expect(snapshot.scanProgress).toEqual({ current: 5, total: 20 });
      expect(snapshot.retryState).toEqual({ attempt: 2, maxAttempts: 3 });
    });

    it("returns a defensive copy (mutations don't affect store)", () => {
      const store = makeStore();
      store.dispatch({ type: "FILE_SAVED", filePath: "/src/a.ts" });

      const snapshot = store.getStatusSnapshot();
      snapshot.staleFiles.push("/src/fake.ts");
      snapshot.activityLog.push({ timestamp: 0, category: "error", message: "fake" });

      // Store should be unaffected
      expect(store.staleCount).toBe(1);
      expect(store.activityLog).toHaveLength(0); // FILE_SAVED doesn't log
    });
  });
});
