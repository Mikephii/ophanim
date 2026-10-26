import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { analyzeFiles, initDb } from "./index";
import { getParserForFile } from "./parsers";
import { SCHEMA_VERSIONS } from "./schemas";
import { insertAnalysisPair, insertFileFunction } from "./test-utils";

describe("analyzeFiles", () => {
  let tmpDir: string;
  let rootPath: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ophan-af-test-"));
    rootPath = tmpDir;
    fs.mkdirSync(path.join(rootPath, ".ophan"), { recursive: true });
    dbPath = path.join(rootPath, ".ophan", "index.db");
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a .ts file and return its absolute path. */
  function writeFile(name: string, content: string): string {
    const filePath = path.join(rootPath, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  /** Parse a file and pre-cache all its hashes so analyzeFunctions is never called. */
  function precacheFile(filePath: string) {
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);
    for (const fn of fns) {
      insertAnalysisPair(db, fn.contentHash, {
        language: fn.language,
        entityType: fn.entityType,
      });
    }
    return fns;
  }

  // ---- mtime skipping ----

  it("skips files whose mtime has not changed and analysis exists", async () => {
    const filePath = writeFile("unchanged.ts", "export function hello() { return 'hi'; }");
    const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
    const fns = precacheFile(filePath);

    // Simulate a previous scan by inserting file_functions with the current mtime
    for (const fn of fns) {
      insertFileFunction(db, filePath, fn.name, fn.contentHash, { mtime });
    }

    const result = await analyzeFiles(db, rootPath, [filePath]);

    // Mtime matched AND all functions have analysis -- counted as skipped
    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(fns.length);
    expect(result.skippedSize).toBe(0);
  });

  it("re-processes file when mtime matches but analysis is missing", async () => {
    const filePath = writeFile("no-analysis.ts", "export function foo() { return 1; }");
    const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);

    // Simulate init: file_functions populated with current mtime, but NO analysis
    insertFileFunction(db, filePath, "stale_name", "stale_hash", { mtime });

    // Pre-cache the real function's analysis so Claude isn't called
    precacheFile(filePath);

    const result = await analyzeFiles(db, rootPath, [filePath]);

    // The mtime matched, but "stale_hash" had no analysis → file was re-processed.
    // After re-parse, the real function is found and its analysis is already cached.
    expect(result.skipped).toBe(fns.length);
    expect(result.analyzed).toBe(0);

    // Verify file_functions was rebuilt with the real function (not the stale entry)
    const rows = db
      .prepare("SELECT function_name FROM file_functions WHERE file_path = ?")
      .all(filePath) as { function_name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].function_name).toBe("foo");
  });

  it("re-processes files when mtime changes", async () => {
    const filePath = writeFile("changed.ts", "export function greet() { return 'hello'; }");
    const fns = precacheFile(filePath);

    // Insert file_functions with OLD mtime (mismatch)
    for (const fn of fns) {
      insertFileFunction(db, filePath, fn.name, fn.contentHash, { mtime: 0 });
    }

    const result = await analyzeFiles(db, rootPath, [filePath]);

    // File was re-parsed. All hashes are cached, so skipped (not analyzed).
    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(fns.length);
  });

  // ---- hash caching ----

  it("counts already-cached hashes as skipped", async () => {
    const filePath = writeFile(
      "cached.ts",
      "export function a() {}\nexport function b() {}"
    );
    precacheFile(filePath);

    const result = await analyzeFiles(db, rootPath, [filePath]);

    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(2);
  });

  // ---- file_functions rebuild ----

  it("rebuilds file_functions for processed files", async () => {
    const filePath = writeFile("rebuild.ts", "export function foo() { return 1; }");
    const fns = precacheFile(filePath);

    // Insert stale file_functions entry
    insertFileFunction(db, filePath, "old_fn", "old_hash", { mtime: 0 });

    await analyzeFiles(db, rootPath, [filePath]);

    // Old entry should be replaced
    const rows = db
      .prepare("SELECT function_name, content_hash FROM file_functions WHERE file_path = ?")
      .all(filePath) as { function_name: string; content_hash: string }[];

    expect(rows).toHaveLength(fns.length);
    expect(rows[0].function_name).toBe("foo");
    expect(rows[0].content_hash).toBe(fns[0].contentHash);
  });

  it("deletes file_functions when parser extracts no functions", async () => {
    // A file with only imports / no functions
    const filePath = writeFile("empty.ts", "const x = 42;\nconst y = 'hello';");

    // Pre-populate a stale entry
    insertFileFunction(db, filePath, "stale_fn", "stale_hash", { mtime: 0 });

    await analyzeFiles(db, rootPath, [filePath]);

    const rows = db
      .prepare("SELECT * FROM file_functions WHERE file_path = ?")
      .all(filePath);

    expect(rows).toHaveLength(0);
  });

  it("stores correct mtime in rebuilt file_functions", async () => {
    const filePath = writeFile("mtime.ts", "export function bar() {}");
    precacheFile(filePath);
    const expectedMtime = Math.floor(fs.statSync(filePath).mtimeMs);

    await analyzeFiles(db, rootPath, [filePath]);

    const row = db
      .prepare("SELECT file_mtime FROM file_functions WHERE file_path = ? LIMIT 1")
      .get(filePath) as { file_mtime: number };

    expect(row.file_mtime).toBe(expectedMtime);
  });

  // ---- pullFn integration ----

  it("calls pullFn with missing hashes", async () => {
    const filePath = writeFile("pull.ts", "export function needsPull() { return true; }");
    // Do NOT precache -- so the hash is "missing"
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);
    const expectedHash = fns[0].contentHash;

    // pullFn will "pull" the analysis (simulate by inserting into DB)
    const pullFn = vi.fn(async (hashes: string[]) => {
      for (const hash of hashes) {
        insertAnalysisPair(db, hash);
      }
    });

    const result = await analyzeFiles(db, rootPath, [filePath], { pullFn });

    expect(pullFn).toHaveBeenCalledOnce();
    expect(pullFn).toHaveBeenCalledWith([expectedHash]);
    // Hash was resolved via pull, not Claude
    expect(result.pulled).toBe(fns.length);
    expect(result.analyzed).toBe(0);
  });

  it("continues analysis when pullFn throws", async () => {
    const filePath = writeFile("pull-fail.ts", "export function failing() { return true; }");
    // Do NOT precache -- hash is missing, pullFn will be called
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);

    // pullFn writes analysis (simulating partial pull) then throws
    const pullFn = vi.fn(async (hashes: string[]) => {
      for (const hash of hashes) {
        insertAnalysisPair(db, hash);
      }
      throw new Error("Supabase network error");
    });

    // Should not throw -- pullFn failure is non-fatal
    const result = await analyzeFiles(db, rootPath, [filePath], { pullFn });

    expect(pullFn).toHaveBeenCalledOnce();
    // Pull wrote analysis before throwing, so Phase 3 re-check finds it
    expect(result.pulled).toBe(fns.length);
    expect(result.analyzed).toBe(0);
  });

  it("does not call pullFn when all hashes are cached", async () => {
    const filePath = writeFile("allcached.ts", "export function cached() {}");
    precacheFile(filePath);

    const pullFn = vi.fn();

    await analyzeFiles(db, rootPath, [filePath], { pullFn });

    expect(pullFn).not.toHaveBeenCalled();
  });

  // ---- oversize file handling ----

  it("skips files larger than 50KB", async () => {
    const filePath = writeFile("big.ts", "export function big() {}\n" + "// ".repeat(20000));

    const result = await analyzeFiles(db, rootPath, [filePath]);

    expect(result.skippedSize).toBe(1);
    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  // ---- edge cases ----

  it("handles empty file list", async () => {
    const result = await analyzeFiles(db, rootPath, []);

    expect(result.analyzed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.skippedSize).toBe(0);
    expect(result.pulled).toBe(0);
  });

  it("reports progress via onProgress callback", async () => {
    const file1 = writeFile("a.ts", "export function a() {}");
    const file2 = writeFile("b.ts", "export function b() {}");
    precacheFile(file1);
    precacheFile(file2);

    const progress: [number, number, string][] = [];

    await analyzeFiles(db, rootPath, [file1, file2], {
      onProgress: (current, total, file) => {
        progress.push([current, total, file]);
      },
    });

    expect(progress).toHaveLength(2);
    expect(progress[0]).toEqual([1, 2, "a.ts"]);
    expect(progress[1]).toEqual([2, 2, "b.ts"]);
  });

  it("reports analysis progress via onAnalysisProgress callback", async () => {
    const file1 = writeFile("ap1.ts", "export function x() {}");
    const file2 = writeFile("ap2.ts", "export function y() {}");
    // Do NOT precache -- these will be "missing" and need analysis

    // pullFn resolves them (simulates Claude analysis completing)
    const pullFn = vi.fn(async (hashes: string[]) => {
      for (const hash of hashes) {
        insertAnalysisPair(db, hash);
      }
    });

    const analysisProgress: [number, number][] = [];

    await analyzeFiles(db, rootPath, [file1, file2], {
      pullFn,
      onAnalysisProgress: (analyzed, total) => {
        analysisProgress.push([analyzed, total]);
      },
    });

    // All hashes resolved via pull, so no Claude analysis needed → no onAnalysisProgress calls
    expect(analysisProgress).toHaveLength(0);
  });

  it("handles multiple files with mixed cache states", async () => {
    const cachedFile = writeFile("cached.ts", "export function cached() { return 1; }");
    const newFile = writeFile("new.ts", "export function needsWork() { return 2; }");
    precacheFile(cachedFile);
    // newFile is NOT precached

    // pullFn simulates cloud pull
    const pullFn = vi.fn(async (hashes: string[]) => {
      for (const hash of hashes) {
        insertAnalysisPair(db, hash);
      }
    });

    const result = await analyzeFiles(db, rootPath, [cachedFile, newFile], { pullFn });

    // cachedFile: 1 function cached in Phase 1
    // newFile: 1 function pulled from cloud in Phase 3 (pulled also counts as skipped)
    expect(result.skipped).toBe(2);
    expect(result.pulled).toBe(1);
    expect(result.analyzed).toBe(0);
  });

  // ---- schema-version-aware re-analysis ----

  it("treats rows with old schema_version as cache misses", async () => {
    const filePath = writeFile("stale-schema.ts", "export function stale() { return 1; }");
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);
    const hash = fns[0].contentHash;

    // Insert analysis with schema_version=0 (older than any current version)
    insertAnalysisPair(db, hash, { schemaVersion: { doc: 0, sec: 0 } });

    // pullFn simulates re-analysis by inserting fresh rows
    const pullFn = vi.fn(async (hashes: string[]) => {
      for (const h of hashes) {
        insertAnalysisPair(db, h, {
          schemaVersion: {
            doc: SCHEMA_VERSIONS.documentation,
            sec: SCHEMA_VERSIONS.security,
          },
        });
      }
    });

    const result = await analyzeFiles(db, rootPath, [filePath], { pullFn });

    // The stale row should be treated as a miss, so pullFn is called
    expect(pullFn).toHaveBeenCalledWith([hash]);
    expect(result.pulled).toBe(1);
  });

  it("skips rows with current schema_version", async () => {
    const filePath = writeFile("fresh-schema.ts", "export function fresh() { return 2; }");
    const parser = getParserForFile(filePath)!;
    const fns = parser.extractFunctions(filePath);

    // Insert analysis with current schema versions
    insertAnalysisPair(db, fns[0].contentHash, {
      schemaVersion: {
        doc: SCHEMA_VERSIONS.documentation,
        sec: SCHEMA_VERSIONS.security,
      },
    });

    const pullFn = vi.fn();
    const result = await analyzeFiles(db, rootPath, [filePath], { pullFn });

    expect(pullFn).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.analyzed).toBe(0);
  });
});
