// Webview data layer -- dual-mode database access
//
// This module provides the data interface for the Ophan webview. It operates in two modes:
//
// 1. VS Code mode: Data arrives via postMessage from the extension (see useVSCode.ts).
//    This module's DB functions are NOT used -- the extension queries its own sql.js instance
//    and sends FunctionData objects directly.
//
// 2. Browser mode: When opened at localhost:5173?repo=/path/to/repo, this module loads the
//    .ophan/index.db via HTTP and queries it directly using sql.js (WebAssembly SQLite).
//    This enables webview development with hot reload without running VS Code.
//
// The FunctionData interface is the canonical shape shared across extension, webview, and
// postMessage protocol. It includes language and entityType fields to support multi-language
// analysis and distinguish between functions, methods, classes, etc.

import initSqlJs, { Database } from "sql.js";

// Types matching core package
export interface DetailedIssue {
  flag: string;
  title: string;
  description: string;
  explanation: string;
  line: number;
  startText: string;
  endText: string;
  severity: "error" | "warning" | "info";
  /** 0-indexed file-absolute line after edit tracking. undefined = no edit tracked. */
  adjustedLine?: number;
  /** true when the code on this line was modified -- re-analysis pending. */
  potentiallyRemediated?: boolean;
}

export interface FunctionData {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  issues: DetailedIssue[];
  practiceViolations: DetailedIssue[];
  language: string;
  entityType: string;
}

let db: Database | null = null;

/** Get the loaded database instance (browser mode only) */
export function getDb(): Database | null {
  return db;
}

// Browser mode: load db directly via sql.js
export async function initBrowserDb(repoPath: string): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: (file) => `https://sql.js.org/dist/${file}`,
  });

  const response = await fetch(
    `/__ophan_db?repo=${encodeURIComponent(repoPath)}`
  );
  if (!response.ok) {
    throw new Error(`Failed to load db: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buffer));
}

// Get all functions from db (merges split documentation + security rows)
export function getAllFunctions(): FunctionData[] {
  if (!db) return [];

  const grouped = new Map<string, { filePath: string; functionName: string; contentHash: string; doc: any; sec: any; prac: any; language: string; entityType: string; startLine: number }>();
  const stmt = db.prepare(
    `SELECT ff.file_path, ff.function_name, ff.content_hash, fa.analysis_type, fa.analysis, ff.language, ff.entity_type, ff.start_line
     FROM file_functions ff
     JOIN function_analysis fa ON ff.content_hash = fa.content_hash
     ORDER BY ff.file_path, ff.function_name`
  );

  while (stmt.step()) {
    const row = stmt.getAsObject();
    const hash = row.content_hash as string;
    const parsed = JSON.parse(row.analysis as string);

    let entry = grouped.get(hash);
    if (!entry) {
      entry = {
        filePath: row.file_path as string,
        functionName: row.function_name as string,
        contentHash: hash,
        doc: {},
        sec: {},
        prac: {},
        language: (row.language as string) || "typescript",
        entityType: (row.entity_type as string) || "function",
        startLine: (row.start_line as number) || 0,
      };
      grouped.set(hash, entry);
    }

    if (row.analysis_type === "documentation") entry.doc = parsed;
    else if (row.analysis_type === "security") entry.sec = parsed;
    else if (row.analysis_type === "practices") entry.prac = parsed;
  }

  stmt.free();

  return [...grouped.values()].map((entry) => ({
    name: entry.functionName,
    filePath: entry.filePath,
    startLine: entry.startLine,
    endLine: 0,
    contentHash: entry.contentHash,
    description: entry.doc.description || "",
    params: entry.doc.params || [],
    returns: entry.doc.returns || { type: "unknown", description: "" },
    dataTags: entry.sec.dataTags || [],
    securityFlags: entry.sec.securityFlags || [],
    issues: entry.sec.issues || [],
    practiceViolations: entry.prac.violations || [],
    language: entry.language,
    entityType: entry.entityType,
  }));
}

// Get functions grouped by file
export function getFunctionsByFile(): Map<string, FunctionData[]> {
  const all = getAllFunctions();
  const byFile = new Map<string, FunctionData[]>();

  for (const fn of all) {
    const existing = byFile.get(fn.filePath) || [];
    existing.push(fn);
    byFile.set(fn.filePath, existing);
  }

  return byFile;
}
