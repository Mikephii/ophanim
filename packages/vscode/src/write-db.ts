// Database module for the VS Code extension.
//
// Uses better-sqlite3 (native Node.js addon) for ALL reads and writes to
// .ophan/index.db. Every query hits the on-disk file directly, so results are
// always fresh -- no stale in-memory snapshots.
//
// History: The extension previously used a dual-engine approach (sql.js WASM for
// reads + better-sqlite3 for writes). sql.js loads the entire DB into memory as
// a snapshot that goes stale immediately. This caused persistent bugs -- the
// webview showed stale start_line values, edit state didn't propagate, and DB
// reloads had timing races. Consolidating on better-sqlite3 eliminated all of
// these issues. sql.js is still used in the webview browser dev mode
// (packages/webview) where native modules aren't available, but it should NEVER
// be used in the extension host.

import BetterSqlite3 from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { runMigrations, EXTENSION_MIGRATIONS } from "./migrations";
import { resolveNativeBinding } from "./native-loader";
import type { IssueEditState } from "./diagnostics";

let writeDb: BetterSqlite3.Database | null = null;

/**
 * Open a better-sqlite3 write handle on index.db.
 * Sets WAL mode for concurrent access, runs extension migrations,
 * and consolidates any existing local-state.db.
 */
export function openWriteDb(dbPath: string): BetterSqlite3.Database {
  if (writeDb) return writeDb;

  const nativeBinding = resolveNativeBinding();
  writeDb = new BetterSqlite3(dbPath, nativeBinding ? { nativeBinding } : undefined);
  writeDb.pragma("journal_mode = WAL");
  writeDb.pragma("busy_timeout = 5000");

  // Run extension-specific migrations (creates state tables if missing)
  const version = "extension:0.0.2";
  runMigrations(writeDb, EXTENSION_MIGRATIONS, version);

  // One-time consolidation: migrate data from local-state.db if it exists
  const ophanDir = path.dirname(dbPath);
  migrateLocalStateDb(writeDb, ophanDir);

  return writeDb;
}

/** Get the current write handle (null if not opened). */
export function getWriteDb(): BetterSqlite3.Database | null {
  return writeDb;
}

/** Close the write handle. Called on extension deactivate. */
export function closeWriteDb(): void {
  try {
    writeDb?.close();
  } catch {
    // May already be closed
  }
  writeDb = null;
}

// ============ STATE WRITE OPERATIONS ============

/** Write resolved issue edit states for webview consumption. */
export function writeIssueEditStates(
  states: IssueEditState[],
): void {
  if (!writeDb || states.length === 0) return;

  const hashes = new Set(states.map((s) => s.contentHash));

  try {
    const deleteStmt = writeDb.prepare(
      "DELETE FROM issue_edit_state WHERE content_hash = ?",
    );
    const insertStmt = writeDb.prepare(
      `INSERT OR REPLACE INTO issue_edit_state
       (content_hash, issue_type, issue_index, adjusted_line, potentially_remediated, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const now = Date.now();
    writeDb.transaction(() => {
      for (const hash of hashes) {
        deleteStmt.run(hash);
      }
      for (const s of states) {
        insertStmt.run(
          s.contentHash,
          s.issueType,
          s.issueIndex,
          s.adjustedLine,
          s.potentiallyRemediated ? 1 : 0,
          now,
        );
      }
    })();
  } catch {
    // Non-critical -- edit state is ephemeral
  }
}

/** Clear all edit state after re-analysis (positions are stale). */
export function clearEditState(): void {
  if (!writeDb) return;
  try {
    writeDb.prepare("DELETE FROM issue_edit_state").run();
  } catch {
    // Table may not exist yet
  }
}

// ============ LOCAL-STATE.DB CONSOLIDATION ============

/**
 * One-time migration: copy dismissed_issues from the old local-state.db
 * into index.db, then delete the file. issue_edit_state is ephemeral
 * and doesn't need migration.
 */
function migrateLocalStateDb(
  db: BetterSqlite3.Database,
  ophanDir: string,
): void {
  const localStatePath = path.join(ophanDir, "local-state.db");
  if (!fs.existsSync(localStatePath)) return;

  try {
    const nativeBinding = resolveNativeBinding();
    const oldDb = new BetterSqlite3(localStatePath, {
      readonly: true,
      ...(nativeBinding ? { nativeBinding } : {}),
    });

    // Check if dismissed_issues table exists in old DB
    const tables = oldDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='dismissed_issues'",
      )
      .all() as { name: string }[];

    if (tables.length > 0) {
      const rows = oldDb
        .prepare("SELECT * FROM dismissed_issues")
        .all() as {
        content_hash: string;
        issue_index: number;
        flag: string;
        reason: string;
        note: string | null;
        dismissed_at: number;
      }[];

      if (rows.length > 0) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO dismissed_issues
           (content_hash, issue_index, flag, reason, note, dismissed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        db.transaction(() => {
          for (const r of rows) {
            insert.run(
              r.content_hash,
              r.issue_index,
              r.flag,
              r.reason,
              r.note,
              r.dismissed_at,
            );
          }
        })();
      }
    }

    oldDb.close();
    fs.unlinkSync(localStatePath);
  } catch {
    // Migration failure is non-critical -- old state is ephemeral.
    // The file will be retried on next activation.
  }
}
