import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import {
  initDb,
  analyzeFiles,
  analyzeRepository,
  getSupportedExtensions,
  loadPracticesFromDb,
} from "@ophan/core";
import type Database from "better-sqlite3";

export interface WatchOptions {
  rootPath: string;
  pullFn?: (hashes: string[]) => Promise<void>;
  syncFn?: () => Promise<{ pushed: number; locations: number; gcProcessed: number; communities: number; summaries: number }>;
  json?: boolean;
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.constructor.name;
  if (typeof err === "string") return err || "Empty error string";
  // Handle non-Error objects (e.g. Supabase/Anthropic SDK errors with circular refs)
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) return obj.message;
    if (typeof obj.error === "string" && obj.error) return obj.error;
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch { /* circular — fall through */ }
    // Last resort for objects: try toString, check it's not the useless default
    const str = String(err);
    if (str !== "[object Object]") return str;
    return "Unknown error (non-serializable object)";
  }
  if (err === undefined) return "Unknown error (undefined)";
  if (err === null) return "Unknown error (null)";
  return String(err);
}

/**
 * Check if a file is ignored by git (respects all .gitignore files, global gitignore,
 * and .git/info/exclude). Returns false if not in a git repo or git is unavailable.
 */
export function isGitIgnored(filePath: string, cwd: string): boolean {
  try {
    execSync(`git check-ignore -q "${filePath}"`, {
      cwd,
      stdio: "pipe",
    });
    return true; // exit code 0 = ignored
  } catch {
    return false; // exit code 1 = not ignored, or git not available
  }
}

/** Wraps a promise with a timeout. Rejects with a timeout error if not resolved within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Analysis timeout after ${ms / 1000}s for ${label}`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

export async function startWatch(options: WatchOptions) {
  const { rootPath, pullFn, syncFn, json } = options;
  const dbPath = path.join(rootPath, ".ophan", "index.db");
  const lockPath = path.join(rootPath, ".ophan", "watch.lock");

  // Check for existing watcher -- kill it so only one instance runs at a time
  if (fs.existsSync(lockPath)) {
    try {
      const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim());
      process.kill(pid, 0); // Check if process is alive (signal 0 = no-op)
      // Kill the existing watcher and take over
      if (json) emit({ event: "replacing_watcher", oldPid: pid });
      else console.log(`  Stopping previous watcher (PID ${pid})...`);
      try { process.kill(pid, "SIGTERM"); } catch { /* already dying */ }
      // Brief wait for process to exit and release resources
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch {
      // Process is dead -- stale lock file, continue
    }
  }

  // Write lock file
  fs.mkdirSync(path.join(rootPath, ".ophan"), { recursive: true });
  fs.writeFileSync(lockPath, String(process.pid));

  const removeLock = () => {
    try { fs.unlinkSync(lockPath); } catch {}
  };
  process.on("exit", removeLock);

  // Phase 1: Initial full scan (reuses analyzeRepository which opens/closes its own DB)
  if (!json) console.log("🔮 Ophan watching...\n");
  if (!json) console.log("  Running initial scan...");

  const INITIAL_SCAN_RETRIES = 2;
  const PROGRESS_THROTTLE_MS = 500;
  let scanSucceeded = false;

  for (let attempt = 0; attempt <= INITIAL_SCAN_RETRIES; attempt++) {
    try {
      let lastProgressEmit = 0;
      const scanResult = await analyzeRepository(rootPath, (current, total, file) => {
        if (json) {
          const now = Date.now();
          if (now - lastProgressEmit > PROGRESS_THROTTLE_MS || current === total) {
            emit({ event: "scan_progress", current, total, file });
            lastProgressEmit = now;
          }
        } else if (process.stdout.isTTY) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(`  [${current}/${total}] ${file}`);
        }
      }, pullFn);

      if (json) {
        emit({
          event: "scan_complete",
          files: scanResult.files,
          analyzed: scanResult.analyzed,
          cached: scanResult.skipped,
          pulled: scanResult.pulled,
        });
      } else {
        console.log(
          `\n  Initial scan: ${scanResult.analyzed} analyzed, ${scanResult.skipped} cached` +
          (scanResult.pulled ? ` (${scanResult.pulled} from cloud)` : "") +
          ` across ${scanResult.files} files`
        );
      }

      // Sync after initial scan if anything was analyzed
      if (syncFn && scanResult.analyzed > 0) {
        await runSync(syncFn, json);
      }

      scanSucceeded = true;
      break;
    } catch (err: unknown) {
      const msg = formatError(err);
      if (attempt < INITIAL_SCAN_RETRIES) {
        const delay = (attempt + 1) * 3000;
        if (json) {
          emit({ event: "retry", attempt: attempt + 1, maxAttempts: INITIAL_SCAN_RETRIES + 1, message: msg, delayMs: delay });
        } else {
          console.error(`\n  ❌ Initial scan failed: ${msg}. Retrying in ${delay / 1000}s...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        if (json) {
          emit({ event: "error", message: `Initial scan failed after ${INITIAL_SCAN_RETRIES + 1} attempts: ${msg}` });
        } else {
          console.error(`\n  ❌ Initial scan failed after ${INITIAL_SCAN_RETRIES + 1} attempts: ${msg}`);
        }
      }
    }
  }

  if (!scanSucceeded) {
    // Continue to file watching -- incremental analysis can still work.
    // Individual file changes will trigger re-analysis.
    if (json) emit({ event: "error", message: "Continuing in watch-only mode. File changes will trigger analysis." });
  }

  // Phase 2: Open DB for incremental watching
  const db = initDb(dbPath);
  const practices = loadPracticesFromDb(db);
  const extSet = new Set(getSupportedExtensions().map((e) => e.toLowerCase()));
  const DEBOUNCE_MS = 5_000;
  const SYNC_DEBOUNCE_MS = 10_000;

  // Per-file debounce timers
  const timers = new Map<string, NodeJS.Timeout>();

  // Sync debounce -- batch rapid analyses into one sync
  let syncTimer: NodeJS.Timeout | null = null;
  let pendingSync = false;

  function scheduleSyncAfterAnalysis() {
    if (!syncFn) return;
    pendingSync = true;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      syncTimer = null;
      if (pendingSync) {
        pendingSync = false;
        await runSync(syncFn, json);
      }
    }, SYNC_DEBOUNCE_MS);
  }

  // FIFO analysis queue with circuit breaker
  let analyzing = false;
  const queue: string[] = [];
  const MAX_CONSECUTIVE_ERRORS = 3;
  const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
  const ANALYSIS_TIMEOUT_MS = 120_000;
  let consecutiveErrors = 0;
  let circuitBrokenUntil = 0;

  async function processQueue() {
    if (analyzing || queue.length === 0) return;

    // Circuit breaker: stop processing if too many consecutive errors
    if (Date.now() < circuitBrokenUntil) return;

    analyzing = true;

    while (queue.length > 0) {
      const file = queue.shift()!;
      const relPath = path.relative(rootPath, file);

      if (json) emit({ event: "analyzing", file: relPath });
      else console.log(`  Analyzing ${relPath}...`);

      const start = Date.now();
      try {
        const result = await withTimeout(
          analyzeFiles(db, rootPath, [file], { pullFn, practices }),
          ANALYSIS_TIMEOUT_MS,
          relPath
        );
        consecutiveErrors = 0; // Reset on success
        const duration = Date.now() - start;

        if (json) {
          emit({
            event: "analyzed",
            file: relPath,
            analyzed: result.analyzed,
            cached: result.skipped,
            pulled: result.pulled,
            duration_ms: duration,
          });
        } else if (result.analyzed > 0 || result.skipped > 0) {
          console.log(
            `  ✅ ${relPath}: ${result.analyzed} analyzed, ${result.skipped} cached (${duration}ms)`
          );
        }

        // Schedule sync after analysis
        if (result.analyzed > 0) {
          scheduleSyncAfterAnalysis();
        }
      } catch (err: unknown) {
        consecutiveErrors++;
        const msg = formatError(err);
        if (json) {
          emit({ event: "error", file: relPath, message: msg });
        } else {
          console.error(`  ❌ ${relPath}: ${msg}`);
        }

        // Circuit breaker: pause after repeated failures
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          circuitBrokenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
          const remaining = queue.length;
          if (json) {
            emit({
              event: "error",
              message: `${MAX_CONSECUTIVE_ERRORS} consecutive failures — pausing analysis for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s. ${remaining} file(s) queued for retry.`,
            });
          } else {
            console.error(`  ⏸ ${MAX_CONSECUTIVE_ERRORS} consecutive failures — pausing for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`);
          }
          break; // Leave remaining files in queue for retry after cooldown
        }
      }
    }

    analyzing = false;
  }

  // Fast-path segments that are always ignored (avoids git subprocess for common cases)
  const ALWAYS_IGNORE = ["node_modules", ".ophan"];

  // Cache of directory prefixes known to be gitignored -- avoids repeated git check-ignore calls
  // for files in the same ignored directory (e.g. .output/public/assets/a.js, .output/public/assets/b.js)
  const ignoredDirCache = new Set<string>();

  function onFileChange(filename: string) {
    const ext = path.extname(filename).toLowerCase();
    if (!extSet.has(ext)) return;

    const absPath = path.isAbsolute(filename)
      ? filename
      : path.resolve(rootPath, filename);

    // Fast-path: skip universally-ignored directories without shelling out to git
    if (ALWAYS_IGNORE.some((seg) => absPath.includes(`/${seg}/`) || absPath.includes(`\\${seg}\\`))) return;

    // Check directory-level cache before calling git
    const dir = path.dirname(absPath);
    for (const cached of ignoredDirCache) {
      if (dir.startsWith(cached)) return;
    }

    // Ask git whether this file is ignored (respects all .gitignore files + global)
    if (isGitIgnored(absPath, rootPath)) {
      // Cache the directory so sibling files skip the git call
      ignoredDirCache.add(dir);
      return;
    }

    // Skip if file was deleted
    if (!fs.existsSync(absPath)) return;

    // Reset per-file debounce
    const existing = timers.get(absPath);
    if (existing) clearTimeout(existing);

    timers.set(
      absPath,
      setTimeout(() => {
        timers.delete(absPath);
        if (!queue.includes(absPath)) {
          queue.push(absPath);
        }
        processQueue().catch((err: unknown) => {
          const msg = formatError(err);
          if (json) emit({ event: "error", message: msg });
          else console.error(`  ❌ Analysis error: ${msg}`);
        });
      }, DEBOUNCE_MS)
    );
  }

  // Start recursive file watcher (macOS + Windows native, Linux may need chokidar)
  const watcher = fs.watch(rootPath, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    onFileChange(filename);
  });

  watcher.on("error", (err) => {
    if (json) emit({ event: "error", message: `Watcher error: ${err.message}` });
    else console.error(`  Watcher error: ${err.message}`);
  });

  if (!json) console.log("\n  Watching for changes... (Ctrl+C to stop)\n");

  // Graceful shutdown
  function shutdown() {
    if (!json) console.log("\n  Shutting down...");
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (syncTimer) clearTimeout(syncTimer);
    db.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runSync(
  syncFn: () => Promise<{ pushed: number; locations: number; gcProcessed: number; communities: number; summaries: number }>,
  json?: boolean
) {
  try {
    const result = await syncFn();
    if (json) {
      emit({ event: "synced", pushed: result.pushed, locations: result.locations });
    } else if (result.pushed > 0) {
      console.log(`  ☁️  Synced: ${result.pushed} entries pushed`);
    }
  } catch (err: any) {
    if (json) {
      emit({ event: "sync_error", message: err.message });
    } else {
      console.error(`  ☁️  Sync failed: ${err.message}`);
    }
  }
}
