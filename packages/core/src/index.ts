// @ophan/core -- Analysis engine
//
// Architecture:
//   Content-addressed storage: Analysis is keyed by SHA256 of function source code,
//   not by file path or branch. This makes analysis branch-agnostic, merge-friendly,
//   and enables insert-only sync (no conflict resolution).
//
//   Two-table split:
//   - function_analysis: (content_hash, analysis_type) → analysis JSON. Persistent cache,
//     synced to cloud. Each function produces two rows: 'documentation' and 'security'.
//   - file_functions: file_path → content_hash mappings. Ephemeral index, rebuilt on
//     every scan, never synced. Maps the current checkout's files to their analysis entries.
//
//   Analysis types:
//   Analysis is split into independent types ('documentation', 'security') stored as
//   separate rows. This enables independent versioning, selective re-analysis, and
//   extensibility (add new types without re-running existing analysis). See schemas.ts
//   for the Zod schemas and docs/architecture/analysis-types.md for design rationale.
//
//   Language & entity_type columns:
//   Both tables carry `language` and `entity_type` fields to support multi-language
//   analysis (Python, Go, Java) and multi-entity analysis (classes, methods, modules).
//   These are set at parse time from file extension and AST node kind respectively.
//
//   Parser abstraction:
//   Function extraction is handled by language-specific parsers (see ./parsers/).
//   Each parser implements the LanguageParser interface and registers itself by file extension.
//   TypeScript/JavaScript uses the TS compiler API. Python uses Python's own ast module via
//   subprocess. New languages are added by creating a parser file -- the analysis pipeline,
//   hashing, DB storage, and sync all work unchanged.
//
//   No tree-sitter, no custom LSP:
//   Each language uses its own native tooling rather than a universal parser framework.
//   The CLI + SQLite DB is the cross-IDE abstraction -- any IDE plugin just reads .ophan/index.db.

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { glob } from "glob";
import pLimit from "p-limit";
import { callClaude, getModel } from "./claude";
import { getParserForFile, getSupportedExtensions } from "./parsers";

// Re-export from shared so downstream consumers (CLI, etc.) can still import from @ophan/core
export { FunctionInfo, computeHash } from "./shared";
export { getSupportedExtensions } from "./parsers";
export * from "./schemas";
export { loadPracticesFromDb, importPractices, validatePractices, buildPracticesPrompt, MAX_PRACTICES, MAX_RULE_LENGTH, type Practice } from "./practices";
// Graph primitives (foundation layer)
export {
  buildFunctionGraph,
  computePackage,
  computeDirectoryDistance,
  loadGraphConfig,
  saveGraphConfig,
  loadEdges,
  buildGraph,
  computeCentrality,
  computeChangedHashes,
  type GraphConfig,
  type FunctionEdge,
  type CentralityResult,
  type ModuleResolver,
  DEFAULT_GRAPH_CONFIG,
  DEFAULT_EDGE_WEIGHTS,
  resolveEdges,
  storeEdges,
  storeTransitiveEdges,
  buildModuleResolver,
  addTransitiveEdges,
} from "./graph";

// Community detection (graph consumer)
export {
  detectAndStoreCommunities,
  detectHierarchicalCommunities,
  detectCommunities,
  rescueDissolvedNodes,
  matchCommunities,
  labelPropagation,
  storeCommunities,
  loadCommunities,
  computeCommunityEdges,
  storeCommunityEdges,
  loadCommunityEdges,
  computeComparisonMetrics,
  runComparison,
  DEFAULT_COMPARISONS,
  type CommunityEdge,
  type CommunityAssignment,
  type DetectionResult,
  type HierarchicalDetectionResult,
  type ComparisonMetrics,
  type ComparisonConfig,
} from "./community-detection";
export {
  type EdgeResolver,
  type EdgeResolverContext,
  registerEdgeResolver,
  getEdgeResolvers,
  CallEdgeResolver,
  JsxRefEdgeResolver,
  CoLocationEdgeResolver,
  ImportEdgeResolver,
} from "./edge-resolvers";
export {
  type LanguageModuleResolver,
  registerModuleResolver,
  getModuleResolver,
  getModuleResolverForFile,
  JavaScriptModuleResolver,
} from "./module-resolvers";
export {
  getDetector,
  registerDetector,
  listDetectors,
  LouvainDetector,
  LabelPropDetector,
  LeidenDetector,
  type CommunityDetector,
  type RawDetectionResult,
  type DetectorOptions,
} from "./community-detectors";
export {
  summarizeCommunities,
  buildL1Context,
  buildL1RawContext,
  computePackageBreakdown,
  formatPackageBreakdown,
  summarizeL1,
  summarizeL2,
  summarizeL3,
  computeL1InputHash,
  computeL2InputHash,
  computeL3InputHash,
  storeSummary,
  loadSummary,
  loadAllSummaries,
  type SummarizeConfig,
  type SummarizeResult,
  type SummarizeOptions,
  type MemberContext,
  type L1CommunityContext,
  type L2CommunityContext,
  type StoredSummary,
  type CrossCuttingConcern,
  detectCrossCuttingConcerns,
  computeCCInputHash,
  summarizeCC,
  DEFAULT_SUMMARIZE_CONFIG,
} from "./summarize";
import type { FunctionInfo } from "./shared";
import {
  ClaudeAnalysisResponse,
  SCHEMA_VERSIONS,
  type DetailedIssue,
} from "./schemas";
import { loadPracticesFromDb, buildPracticesPrompt, type Practice } from "./practices";
import { runMigrations, bootstrapMigrations, CORE_MIGRATIONS } from "./migrations";

/** Skip files larger than this -- catches minified bundles, generated code, etc. */
const MAX_FILE_SIZE_BYTES = 50 * 1024; // 50 KB

/**
 * Pre-process source code with visible line numbers for the Claude prompt.
 * Claude reads these labels to report issue locations accurately (instead of counting lines).
 * The numbered output is ONLY used in the prompt -- content hashes are computed from
 * the original unnumbered source.
 */
export function numberLines(sourceCode: string): string {
  const lines = sourceCode.split("\n");
  const pad = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(pad)} | ${line}`)
    .join("\n");
}

/**
 * Ensure .ophan/ is in .gitignore. Only acts in git repos.
 * Creates .gitignore if the repo has .git/ but no .gitignore.
 */
export function ensureGitignore(rootPath: string) {
  const gitignorePath = path.join(rootPath, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".ophan")) {
      fs.appendFileSync(gitignorePath, "\n# Ophan analysis cache\n.ophan/\n");
    }
  } else if (fs.existsSync(path.join(rootPath, ".git"))) {
    fs.writeFileSync(gitignorePath, "# Ophan analysis cache\n.ophan/\n");
  }
}

const HARDCODED_IGNORES = [
  "**/node_modules/**", "**/.ophan/**", "**/dist/**",
  "**/__pycache__/**", "**/.venv/**", "**/venv/**", "**/env/**",
  "**/.tox/**", "**/.eggs/**", "**/build/**",
  "**/.output/**", "**/.next/**", "**/.nuxt/**", "**/.turbo/**", "**/.cache/**",
];

/**
 * Discover source files using git (respects .gitignore) with glob fallback.
 * Returns absolute paths filtered to supported extensions.
 */
export async function discoverFiles(rootPath: string): Promise<string[]> {
  const exts = getSupportedExtensions(); // [".ts", ".tsx", ...]
  const extSet = new Set(exts.map((e) => e.toLowerCase()));

  try {
    // git ls-files: tracked + untracked-but-not-ignored. Respects all .gitignore files.
    const output = execSync(
      "git ls-files --cached --others --exclude-standard",
      // stderr ignored: outside a git repo git prints "fatal: not a git repository" and we fall back to glob
      { cwd: rootPath, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
    );
    const files = output
      .split("\n")
      .filter((f) => f.length > 0)
      .filter((f) => extSet.has(path.extname(f).toLowerCase()))
      .map((f) => path.resolve(rootPath, f));

    // Still apply hardcoded ignores as safety net (e.g. checked-in node_modules)
    const ignoreSegments = ["node_modules", ".ophan", "__pycache__", ".venv", "venv", ".tox", ".eggs", ".output", ".next", ".nuxt", ".turbo", ".cache"];
    return files.filter((f) => !ignoreSegments.some((seg) => f.includes(`/${seg}/`) || f.includes(`\\${seg}\\`)));
  } catch {
    // Not a git repo or git not available -- fall back to glob
    const globExts = exts.map((e) => e.slice(1));
    return glob(`**/*.{${globExts.join(",")}}`, {
      cwd: rootPath,
      ignore: HARDCODED_IGNORES,
      absolute: true,
    });
  }
}

export interface AnalyzedFunction extends FunctionInfo {
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  issues: DetailedIssue[];
  practiceViolations: DetailedIssue[];
}

export interface FunctionAnalysis {
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  dataTags: string[];
  securityFlags: string[];
  issues: DetailedIssue[];
  practiceViolations: DetailedIssue[];
}

export interface FileAnalysisEntry {
  functionName: string;
  contentHash: string;
  analysis: FunctionAnalysis;
  language: string;
  entityType: string;
}

// ============ DATABASE ============

export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Fresh DB: create current schema directly, mark all migrations as applied.
  // Existing DB: run any pending migrations to bring schema up to date.
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as { name: string }[];

  if (tables.length === 0) {
    createFreshSchema(db);
    bootstrapMigrations(db, CORE_MIGRATIONS, "core:bootstrap");
  } else {
    runMigrations(db, CORE_MIGRATIONS, "core");
  }

  return db;
}

/**
 * Create the full current schema for a fresh database.
 * Includes all tables, indexes, and the migration tracking table.
 */
function createFreshSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE function_analysis (
      content_hash TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      analysis JSON NOT NULL,
      model_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      synced_at INTEGER,
      PRIMARY KEY (content_hash, analysis_type)
    )
  `);
  db.exec(`
    CREATE TABLE file_functions (
      file_path TEXT NOT NULL,
      function_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_mtime INTEGER NOT NULL,
      language TEXT NOT NULL DEFAULT 'typescript',
      entity_type TEXT NOT NULL DEFAULT 'function',
      start_line INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (file_path, function_name)
    )
  `);
  db.exec(`
    CREATE TABLE function_gc (
      content_hash TEXT NOT NULL,
      analysis_type TEXT,
      gc_at INTEGER NOT NULL,
      synced_at INTEGER,
      PRIMARY KEY (content_hash, analysis_type)
    )
  `);
  db.exec(`
    CREATE TABLE sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE practices (
      practice_id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning'
    )
  `);

  // Graph tables
  db.exec(`
    CREATE TABLE function_edges (
      source_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source_hash, target_hash, edge_type)
    )
  `);
  db.exec(`
    CREATE TABLE communities (
      content_hash TEXT NOT NULL,
      level INTEGER NOT NULL,
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      PRIMARY KEY (content_hash, level, algorithm)
    )
  `);
  db.exec(`
    CREATE TABLE community_summaries (
      community_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      input_hash TEXT NOT NULL,
      summary JSON NOT NULL,
      model_version TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, level, algorithm)
    )
  `);
  db.exec(`
    CREATE TABLE graph_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE community_edges (
      source_community TEXT NOT NULL,
      target_community TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      weight REAL NOT NULL DEFAULT 0,
      edge_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_community, target_community, algorithm)
    )
  `);
  db.exec(`
    CREATE TABLE community_signatures (
      community_id TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'louvain',
      signatures JSON NOT NULL,
      PRIMARY KEY (community_id, algorithm)
    )
  `);

  // Indexes
  db.exec("CREATE INDEX idx_file_functions_path ON file_functions(file_path)");
  db.exec("CREATE INDEX idx_file_functions_hash ON file_functions(content_hash)");
  db.exec("CREATE INDEX idx_fa_hash ON function_analysis(content_hash)");
  db.exec("CREATE INDEX idx_fa_type ON function_analysis(analysis_type)");
  db.exec("CREATE INDEX idx_edges_source ON function_edges(source_hash)");
  db.exec("CREATE INDEX idx_edges_target ON function_edges(target_hash)");
  db.exec("CREATE INDEX idx_communities_id ON communities(community_id)");
  db.exec("CREATE INDEX idx_ce_source ON community_edges(source_community)");
  db.exec("CREATE INDEX idx_ce_target ON community_edges(target_community)");
}

// ============ LLM ANALYSIS ============


export async function analyzeFunctions(
  functions: FunctionInfo[],
  practices?: Practice[]
): Promise<AnalyzedFunction[]> {
  if (functions.length === 0) return [];

  // Use the language from the first function in the batch (batches are always same-file)
  const lang = functions[0].language || "typescript";
  const langLabel = lang.charAt(0).toUpperCase() + lang.slice(1); // "TypeScript", "Python"

  // Language-specific security concerns for the prompt
  const securityExamples: Record<string, string> = {
    typescript: "sql_injection, xss, hardcoded_secret, unsanitized_input, path_traversal, prototype_pollution",
    javascript: "sql_injection, xss, hardcoded_secret, unsanitized_input, path_traversal, prototype_pollution",
    python: "sql_injection, command_injection, hardcoded_secret, unsanitized_input, path_traversal, pickle_deserialization, eval_exec, insecure_subprocess",
  };
  const securityHints = securityExamples[lang] || securityExamples.typescript;

  const prompt = `Analyze these ${langLabel} functions. Return JSON array with one object per function.
Source lines are numbered for reference — when reporting line numbers, read the label at the start of the line, don't count.

Each object must have:
- name: string (function name, must match input)
- description: string (one sentence)
- params: array of { name, type, description }
- returns: { type, description }
- dataTags: array from [user_input, pii, credentials, database, external_api, file_system, config, internal]
- securityFlags: array of flag names found (e.g. [${securityHints}]) or empty
- issues: array of detailed findings (empty if no security concerns), each with:
  - flag: the security concern identifier (must also appear in securityFlags)
  - title: short one-line title
  - description: what's wrong (1-2 sentences)
  - explanation: why it's a problem and how to fix (2-4 sentences)
  - line: the line number shown at the start of the problematic line (read the number, don't count)
  - startText: the first ~30 characters of the problematic code on that line
  - endText: the last ~20 characters of the problematic code on that line
  - severity: "error" | "warning" | "info"
  - confidence: "high" | "medium" | "low"
    high = the vulnerability is clearly exploitable given the visible code
      (e.g., user input directly concatenated into SQL, dangerouslySetInnerHTML with user content)
    medium = the pattern is risky but exploitability depends on how callers
      use this function (e.g., file path parameter without validation)
    low = the pattern matches a known vulnerability signature but is common
      safe practice or requires unusual conditions to exploit
      (e.g., prop spreading in React, Object.assign with internal data)
${practices && practices.length > 0 ? buildPracticesPrompt(practices) : ""}
Functions:
${functions
  .map((fn) => `### ${fn.name}\n\`\`\`${lang}\n${numberLines(fn.sourceCode)}\n\`\`\``)
  .join("\n\n")}

CRITICAL: Return ONLY the raw JSON array. No markdown, no code fences, no \`\`\`json blocks, no explanation. Just the [ ... ] array directly.`;

  // 16k leaves room for the model's thinking as well as the JSON for a whole file's functions.
  const text = await callClaude({
    prompt,
    maxTokens: 16000,
    onRetry: (attempt) => console.log(`  Rate limited, retrying (${attempt}/4)...`),
  });

  try {
    // Strip markdown code fences if model adds them
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const results = JSON.parse(cleaned);
    return functions.map((fn) => {
      const raw = results.find((r: any) => r.name === fn.name) || {};
      // Validate with Zod, using .catch() defaults for graceful degradation
      const validated = ClaudeAnalysisResponse.parse({ name: fn.name, ...raw });
      return {
        ...fn,
        description: validated.description,
        params: validated.params,
        returns: validated.returns,
        dataTags: validated.dataTags,
        securityFlags: validated.securityFlags,
        issues: validated.issues,
        practiceViolations: validated.practiceViolations,
      };
    });
  } catch (e) {
    console.error("Failed to parse LLM response:", text);
    return functions.map((fn) => ({
      ...fn,
      description: "Analysis failed",
      params: [],
      returns: { type: "unknown", description: "" },
      dataTags: [],
      securityFlags: [],
      issues: [],
      practiceViolations: [],
    }));
  }
}

// ============ MAIN ANALYZE ============

export interface AnalyzeFilesOptions {
  pullFn?: (hashes: string[]) => Promise<void>;
  onProgress?: (current: number, total: number, file: string) => void;
  onAnalysisProgress?: (analyzed: number, total: number) => void;
  practices?: Practice[];
}

export interface AnalyzeFilesResult {
  analyzed: number;
  skipped: number;
  pulled: number;
  skippedSize: number;
}

/**
 * Analyze a specific set of files: parse → hash → pull → Claude → store.
 * Used by `analyzeRepository()` for full scans and `ophan watch` for incremental.
 * The caller is responsible for DB lifecycle (open/close).
 */
export async function analyzeFiles(
  db: Database.Database,
  rootPath: string,
  files: string[],
  options: AnalyzeFilesOptions = {}
): Promise<AnalyzeFilesResult> {
  const { pullFn, onProgress, onAnalysisProgress } = options;
  const now = Math.floor(Date.now() / 1000);

  let totalAnalyzed = 0;
  let totalSkippedSize = 0;
  let totalSkipped = 0;
  let totalPulled = 0;

  // Prepared statements
  const getFileMtime = db.prepare(
    "SELECT file_mtime FROM file_functions WHERE file_path = ? LIMIT 1"
  );
  // Check for analysis at current schema versions.
  // If a row exists but with an older schema_version, it's treated as a cache miss
  // so the function gets re-analyzed with the current schema.
  const minSchemaVersion = Math.min(SCHEMA_VERSIONS.documentation, SCHEMA_VERSIONS.security);
  const checkAnalysis = db.prepare(
    `SELECT 1 FROM function_analysis
     WHERE content_hash = ? AND analysis_type = 'documentation'
     AND schema_version >= ?`
  );
  const getFileHashes = db.prepare(
    "SELECT content_hash FROM file_functions WHERE file_path = ?"
  );
  // INSERT OR REPLACE: overwrites stale rows when schema_version bumps trigger re-analysis.
  // Previously INSERT OR IGNORE, but that would keep old-version rows forever.
  const insertDocAnalysis = db.prepare(`
    INSERT OR REPLACE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
    VALUES (?, 'documentation', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSecAnalysis = db.prepare(`
    INSERT OR REPLACE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
    VALUES (?, 'security', ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPracAnalysis = db.prepare(`
    INSERT OR REPLACE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type)
    VALUES (?, 'practices', ?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteFileEntries = db.prepare(
    "DELETE FROM file_functions WHERE file_path = ?"
  );
  const insertFileFunction = db.prepare(`
    INSERT OR REPLACE INTO file_functions
    (file_path, function_name, content_hash, file_mtime, language, entity_type, start_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Phase 1: Scan files, extract functions, identify missing hashes
  interface PendingFile {
    file: string;
    functions: FunctionInfo[];
    needsAnalysis: FunctionInfo[];
    mtime: number;
  }
  const pendingFiles: PendingFile[] = [];
  const allMissingHashes = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relPath = path.relative(rootPath, file);
    onProgress?.(i + 1, files.length, relPath);

    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      totalSkippedSize++;
      continue;
    }

    const currentMtime = Math.floor(stat.mtimeMs);
    const storedRow = getFileMtime.get(file) as
      | { file_mtime: number }
      | undefined;

    if (storedRow && storedRow.file_mtime === currentMtime) {
      // Mtime unchanged -- check if all functions already have analysis.
      // If any lack analysis (e.g. init ran but analyze never did), re-process.
      const fileHashes = getFileHashes.all(file) as { content_hash: string }[];
      const allAnalyzed = fileHashes.length > 0 && fileHashes.every(
        (row) => checkAnalysis.get(row.content_hash, minSchemaVersion)
      );
      if (allAnalyzed) {
        totalSkipped += fileHashes.length;
        continue;
      }
    }

    const parser = getParserForFile(file);
    if (!parser) continue;
    const functions = parser.extractFunctions(file);

    if (functions.length === 0) {
      deleteFileEntries.run(file);
      continue;
    }

    const needsAnalysis: FunctionInfo[] = [];
    for (const fn of functions) {
      if (checkAnalysis.get(fn.contentHash, minSchemaVersion)) {
        totalSkipped++;
      } else {
        needsAnalysis.push(fn);
        allMissingHashes.add(fn.contentHash);
      }
    }

    pendingFiles.push({ file, functions, needsAnalysis, mtime: currentMtime });
  }

  // Phase 2: Pull from cloud to avoid redundant Claude calls
  if (pullFn && allMissingHashes.size > 0) {
    try {
      await pullFn([...allMissingHashes]);
    } catch {
      // Pull is a non-critical optimization -- continue with local analysis
    }
  }

  // Phase 3: Re-check after pull, compute totals, run Claude analysis
  const modelVersion = getModel();

  const phase3Files = pendingFiles.map((pending) => {
    const stillNeeds = pullFn
      ? pending.needsAnalysis.filter((fn) => !checkAnalysis.get(fn.contentHash, minSchemaVersion))
      : pending.needsAnalysis;
    const pulled = pending.needsAnalysis.length - stillNeeds.length;
    totalPulled += pulled;
    totalSkipped += pulled;
    return { ...pending, stillNeeds };
  });

  // Flatten and dedupe all functions needing Claude analysis
  const allStillNeeds: FunctionInfo[] = [];
  const seenHashes = new Set<string>();
  for (const pending of phase3Files) {
    for (const fn of pending.stillNeeds) {
      if (!seenHashes.has(fn.contentHash)) {
        seenHashes.add(fn.contentHash);
        allStillNeeds.push(fn);
      }
    }
  }

  const totalNeedsAnalysis = allStillNeeds.length;

  // Batch into groups of 10, fire with bounded concurrency
  const analysisBatches: FunctionInfo[][] = [];
  for (let i = 0; i < allStillNeeds.length; i += 10) {
    analysisBatches.push(allStillNeeds.slice(i, i + 10));
  }

  const analysisLimit = pLimit(5);
  const { practices } = options;

  await Promise.all(analysisBatches.map((batch) => analysisLimit(async () => {
    const analyzed = await analyzeFunctions(batch, practices);
    for (const fn of analyzed) {
      // Compute lineText for each issue -- trimmed source line at analysis time
      // Used by the extension for modification detection (see docs/architecture/extension-lifecycle.md, Remediation Detection)
      const sourceLines = fn.sourceCode.split("\n");
      for (const issue of fn.issues) {
        if (issue.line > 0 && issue.line <= sourceLines.length) {
          issue.lineText = sourceLines[issue.line - 1].trim();
        }
      }
      for (const pv of fn.practiceViolations) {
        if (pv.line > 0 && pv.line <= sourceLines.length) {
          pv.lineText = sourceLines[pv.line - 1].trim();
        }
      }

      insertDocAnalysis.run(
        fn.contentHash,
        JSON.stringify({
          description: fn.description,
          params: fn.params,
          returns: fn.returns,
        }),
        modelVersion,
        SCHEMA_VERSIONS.documentation,
        now,
        now,
        fn.language,
        fn.entityType
      );
      insertSecAnalysis.run(
        fn.contentHash,
        JSON.stringify({
          dataTags: fn.dataTags,
          securityFlags: fn.securityFlags,
          issues: fn.issues,
        }),
        modelVersion,
        SCHEMA_VERSIONS.security,
        now,
        now,
        fn.language,
        fn.entityType
      );
      if (practices && practices.length > 0) {
        insertPracAnalysis.run(
          fn.contentHash,
          JSON.stringify({
            violations: fn.practiceViolations,
          }),
          modelVersion,
          SCHEMA_VERSIONS.practices,
          now,
          now,
          fn.language,
          fn.entityType
        );
      }
    }
    totalAnalyzed += analyzed.length;
    onAnalysisProgress?.(totalAnalyzed, totalNeedsAnalysis);
  })));

  // Rebuild file_functions for all pending files
  for (const pending of phase3Files) {
    deleteFileEntries.run(pending.file);
    for (const fn of pending.functions) {
      insertFileFunction.run(pending.file, fn.name, fn.contentHash, pending.mtime, fn.language, fn.entityType, fn.startLine);
    }
  }

  return { analyzed: totalAnalyzed, skipped: totalSkipped, skippedSize: totalSkippedSize, pulled: totalPulled };
}

export async function analyzeRepository(
  rootPath: string,
  onProgress?: (current: number, total: number, file: string) => void,
  pullFn?: (hashes: string[]) => Promise<void>,
  onAnalysisProgress?: (analyzed: number, total: number) => void,
) {
  const dbPath = path.join(rootPath, ".ophan", "index.db");
  fs.mkdirSync(path.join(rootPath, ".ophan"), { recursive: true });

  // Auto-add .ophan/ to .gitignore (only in git repos)
  ensureGitignore(rootPath);

  const db = initDb(dbPath);
  const now = Math.floor(Date.now() / 1000);

  const files = await discoverFiles(rootPath);
  const practices = loadPracticesFromDb(db);

  const result = await analyzeFiles(db, rootPath, files, { pullFn, onProgress, onAnalysisProgress, practices });

  // Clean up entries for deleted files
  const fileSet = new Set(files);
  const deleteFileEntries = db.prepare("DELETE FROM file_functions WHERE file_path = ?");
  const storedPaths = db
    .prepare("SELECT DISTINCT file_path FROM file_functions")
    .all() as { file_path: string }[];

  for (const { file_path } of storedPaths) {
    if (!fileSet.has(file_path)) {
      deleteFileEntries.run(file_path);
    }
  }

  // Update last_seen_at for all hashes currently referenced
  db.prepare(
    `UPDATE function_analysis SET last_seen_at = ?
     WHERE content_hash IN (SELECT DISTINCT content_hash FROM file_functions)`
  ).run(now);

  db.close();
  return { files: files.length, ...result };
}

// ============ QUERY ============

/**
 * Merge documentation + security analysis rows for a content_hash into
 * the unified FunctionAnalysis shape that consumers expect.
 */
export function mergeAnalysisRows(
  rows: { analysis_type: string; analysis: string }[]
): FunctionAnalysis {
  let doc: any = {};
  let sec: any = {};
  let prac: any = {};
  for (const row of rows) {
    const parsed = JSON.parse(row.analysis);
    if (row.analysis_type === "documentation") doc = parsed;
    else if (row.analysis_type === "security") sec = parsed;
    else if (row.analysis_type === "practices") prac = parsed;
  }
  return {
    description: doc.description || "",
    params: doc.params || [],
    returns: doc.returns || { type: "unknown", description: "" },
    dataTags: sec.dataTags || [],
    securityFlags: sec.securityFlags || [],
    issues: sec.issues || [],
    practiceViolations: prac.violations || [],
  };
}

export function getAnalysisForFile(
  dbPath: string,
  filePath: string
): FileAnalysisEntry[] {
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .prepare(
      `SELECT ff.function_name, ff.content_hash, fa.analysis_type, fa.analysis, ff.language, ff.entity_type
       FROM file_functions ff
       JOIN function_analysis fa ON ff.content_hash = fa.content_hash
       WHERE ff.file_path = ?`
    )
    .all(filePath) as {
    function_name: string;
    content_hash: string;
    analysis_type: string;
    analysis: string;
    language: string;
    entity_type: string;
  }[];

  db.close();

  // Group by content_hash, merge analysis types
  const grouped = new Map<string, {
    functionName: string;
    contentHash: string;
    language: string;
    entityType: string;
    analysisRows: { analysis_type: string; analysis: string }[];
  }>();

  for (const row of rows) {
    const existing = grouped.get(row.content_hash);
    if (existing) {
      existing.analysisRows.push({ analysis_type: row.analysis_type, analysis: row.analysis });
    } else {
      grouped.set(row.content_hash, {
        functionName: row.function_name,
        contentHash: row.content_hash,
        language: row.language,
        entityType: row.entity_type,
        analysisRows: [{ analysis_type: row.analysis_type, analysis: row.analysis }],
      });
    }
  }

  return [...grouped.values()].map((entry) => ({
    functionName: entry.functionName,
    contentHash: entry.contentHash,
    analysis: mergeAnalysisRows(entry.analysisRows),
    language: entry.language,
    entityType: entry.entityType,
  }));
}

export function getAnalysisByHash(
  dbPath: string,
  hash: string
): FunctionAnalysis | null {
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .prepare("SELECT analysis_type, analysis FROM function_analysis WHERE content_hash = ?")
    .all(hash) as { analysis_type: string; analysis: string }[];

  db.close();

  if (rows.length === 0) return null;
  return mergeAnalysisRows(rows);
}

// ============ GC ============

export function gcAnalysis(
  dbPath: string,
  maxAgeDays: number = 30
): { deleted: number } {
  const db = new Database(dbPath);
  const cutoff =
    Math.floor(Date.now() / 1000) - maxAgeDays * 24 * 60 * 60;
  const now = Math.floor(Date.now() / 1000);

  // Insert tombstones for hashes about to be deleted (for sync to Supabase)
  // One tombstone per (content_hash, analysis_type) pair
  db.prepare(
    `INSERT OR IGNORE INTO function_gc (content_hash, analysis_type, gc_at)
     SELECT content_hash, analysis_type, ?
     FROM function_analysis
     WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM file_functions)
     AND last_seen_at < ?`
  ).run(now, cutoff);

  // Also clean up any previously-synced GC entries
  db.prepare("DELETE FROM function_gc WHERE synced_at IS NOT NULL").run();

  const result = db
    .prepare(
      `DELETE FROM function_analysis
       WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM file_functions)
       AND last_seen_at < ?`
    )
    .run(cutoff);

  db.close();
  return { deleted: result.changes };
}

// ============ REFRESH INDEX ============

export async function refreshFileIndex(
  rootPath: string,
  onProgress?: (current: number, total: number, file: string) => void
) {
  const dbPath = path.join(rootPath, ".ophan", "index.db");
  if (!fs.existsSync(dbPath)) return;

  const db = initDb(dbPath);
  const now = Math.floor(Date.now() / 1000);

  const files = await discoverFiles(rootPath);

  const getFileMtime = db.prepare(
    "SELECT file_mtime FROM file_functions WHERE file_path = ? LIMIT 1"
  );
  const deleteFileEntries = db.prepare(
    "DELETE FROM file_functions WHERE file_path = ?"
  );
  const insertFileFunction = db.prepare(`
    INSERT OR REPLACE INTO file_functions
    (file_path, function_name, content_hash, file_mtime, language, entity_type, start_line)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const fileSet = new Set(files);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relPath = path.relative(rootPath, file);
    onProgress?.(i + 1, files.length, relPath);

    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    const currentMtime = Math.floor(stat.mtimeMs);
    const storedRow = getFileMtime.get(file) as
      | { file_mtime: number }
      | undefined;

    if (storedRow && storedRow.file_mtime === currentMtime) {
      continue;
    }

    const parser = getParserForFile(file);
    if (!parser) continue;
    const functions = parser.extractFunctions(file);
    deleteFileEntries.run(file);
    for (const fn of functions) {
      insertFileFunction.run(file, fn.name, fn.contentHash, currentMtime, fn.language, fn.entityType, fn.startLine);
    }
  }

  // Remove entries for deleted files
  const storedPaths = db
    .prepare("SELECT DISTINCT file_path FROM file_functions")
    .all() as { file_path: string }[];

  for (const { file_path } of storedPaths) {
    if (!fileSet.has(file_path)) {
      deleteFileEntries.run(file_path);
    }
  }

  // Update last_seen_at for current hashes
  db.prepare(
    `UPDATE function_analysis SET last_seen_at = ?
     WHERE content_hash IN (SELECT DISTINCT content_hash FROM file_functions)`
  ).run(now);

  db.close();
}

// ============ PULL SYNC HELPERS ============

/**
 * Find content hashes that are referenced in file_functions but have no
 * analysis in function_analysis. Used by CLI to know what to pull from Supabase
 * before running expensive Claude analysis.
 */
export function findMissingHashes(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT DISTINCT ff.content_hash
     FROM file_functions ff
     LEFT JOIN function_analysis fa ON ff.content_hash = fa.content_hash AND fa.analysis_type = 'documentation'
     WHERE fa.content_hash IS NULL`
  ).all() as { content_hash: string }[];
  db.close();
  return rows.map((r) => r.content_hash);
}

/**
 * Import analysis rows pulled from Supabase into the local SQLite database.
 * Used by CLI pull sync to cache remote analysis locally.
 */
export function importAnalysis(
  dbPath: string,
  rows: {
    content_hash: string;
    analysis_type: string;
    analysis: string;
    model_version: string;
    schema_version: number;
    language: string;
    entity_type: string;
  }[]
): number {
  if (rows.length === 0) return 0;
  const db = new Database(dbPath);
  const now = Math.floor(Date.now() / 1000);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO function_analysis
    (content_hash, analysis_type, analysis, model_version, schema_version, created_at, last_seen_at, language, entity_type, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let imported = 0;
  const runInserts = db.transaction(() => {
    for (const r of rows) {
      const result = insert.run(
        r.content_hash,
        r.analysis_type,
        r.analysis,
        r.model_version,
        r.schema_version,
        now,
        now,
        r.language,
        r.entity_type,
        now // synced_at = now (came from Supabase)
      );
      if (result.changes > 0) imported++;
    }
  });
  runInserts();

  db.close();
  return imported;
}

/**
 * Extract all functions from a repository, returning FunctionInfo arrays
 * with relationship data (calls, imports, exported). Used by the graph
 * analysis pipeline to build the relationship graph.
 *
 * Respects the same file size limits and parser selection as refreshFileIndex.
 */
export async function extractAllFunctions(
  rootPath: string,
  onProgress?: (current: number, total: number, file: string) => void
): Promise<FunctionInfo[]> {
  const files = await discoverFiles(rootPath);
  const allFunctions: FunctionInfo[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const relPath = path.relative(rootPath, file);
    onProgress?.(i + 1, files.length, relPath);

    const stat = fs.statSync(file);
    if (stat.size > MAX_FILE_SIZE_BYTES) continue;

    const parser = getParserForFile(file);
    if (!parser) continue;

    const functions = parser.extractFunctions(file);
    allFunctions.push(...functions);
  }

  return allFunctions;
}

/**
 * Populate file_functions index from pre-extracted FunctionInfo array.
 * Used by the graph pipeline to avoid scanning files twice -- extractAllFunctions()
 * already has all the data needed for the index.
 */
export function populateFileIndex(db: Database.Database, functions: FunctionInfo[]): void {
  const byFile = new Map<string, FunctionInfo[]>();
  for (const fn of functions) {
    const existing = byFile.get(fn.filePath) || [];
    existing.push(fn);
    byFile.set(fn.filePath, existing);
  }

  const deleteFileEntries = db.prepare("DELETE FROM file_functions WHERE file_path = ?");
  const insertFileFunction = db.prepare(
    `INSERT OR REPLACE INTO file_functions (file_path, function_name, content_hash, file_mtime, language, entity_type, start_line)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const [filePath, fns] of byFile) {
      const mtime = Math.floor(fs.statSync(filePath).mtimeMs);
      deleteFileEntries.run(filePath);
      for (const fn of fns) {
        insertFileFunction.run(filePath, fn.name, fn.contentHash, mtime, fn.language, fn.entityType, fn.startLine);
      }
    }
  });

  tx();
}
